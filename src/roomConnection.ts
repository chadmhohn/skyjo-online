import {
  EXPLICIT_PRESENCE_VERSION,
  MULTIPLAYER_PROTOCOL_VERSION,
  PUBLIC_SNAPSHOT_LIMITS,
  parseClientCommand,
  type PublicGameStateSnapshot,
  type PublicPlayerSnapshot,
  type PublicCardSnapshot,
  type PublicRoomSnapshot
} from './protocolV2';

export type RoomConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export type RoomConnectionFrame = Record<string, unknown>;

export type RoomConnectionSession =
  | { action: 'create-room'; name: string }
  | {
      action: 'join-room';
      code: string;
      name: string;
      playerId?: string;
      recoveryCommandId?: string;
      recoveryExpectedRevision?: number;
    };

export type SavedRoomConnectionSession = Extract<RoomConnectionSession, { action: 'join-room' }> & {
  playerId: string;
};

type RoomSocketEvent = 'open' | 'message' | 'error' | 'close';

export interface RoomConnectionSocket {
  readonly readyState: number;
  addEventListener(event: RoomSocketEvent, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
  send(payload: string): void;
}

export interface RoomConnectionStateDetail {
  retryInMs: number | null;
}

interface RoomConnectionDependencies {
  cancelTimer: (handle: unknown) => void;
  cancelSyncTimer: (handle: unknown) => void;
  clock: () => number;
  createSocket: (url: string) => RoomConnectionSocket;
  isOnline: () => boolean;
  random: () => number;
  scheduleTimer: (callback: () => void, delayMs: number) => unknown;
  scheduleSyncTimer: (callback: () => void, delayMs: number) => unknown;
}

export interface RoomConnectionOptions extends Partial<RoomConnectionDependencies> {
  onError?: (message: string) => void;
  onFrame: (frame: RoomConnectionFrame) => void;
  onPendingCommandChange?: (pending: boolean) => void;
  onStateChange: (state: RoomConnectionState, detail: RoomConnectionStateDetail) => void;
  url: string;
}

export interface RoomConnectionController {
  connect(session: RoomConnectionSession): void;
  disconnect(): void;
  getState(): RoomConnectionState;
  recover(session: SavedRoomConnectionSession): void;
  resume(): void;
  send(frame: RoomConnectionFrame): boolean;
  setOnline(online: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export const RECONNECT_BASE_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
export const ROOM_SYNC_TIMEOUT_MS = 8_000;

const socketConnecting = 0;
const socketOpen = 1;
const resumeCoalesceMs = 250;
const commandIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface PendingCommandState {
  frame: RoomConnectionFrame;
  commandId: string;
  expectedRevision: number;
  acknowledgedRevision: number | null;
  sentGeneration: number;
}

type ResetRecoveryExpectation = {
  commandId: string;
  expectedRevision: number;
};

function resetRecoveryExpectation(
  value: RoomConnectionSession | null
): ResetRecoveryExpectation | null {
  if (
    value?.action !== 'join-room' ||
    !value.playerId ||
    typeof value.recoveryCommandId !== 'string' ||
    !commandIdPattern.test(value.recoveryCommandId) ||
    !Number.isSafeInteger(value.recoveryExpectedRevision) ||
    Number(value.recoveryExpectedRevision) < 0 ||
    Number(value.recoveryExpectedRevision) >= Number.MAX_SAFE_INTEGER
  ) return null;
  return {
    commandId: value.recoveryCommandId,
    expectedRevision: Number(value.recoveryExpectedRevision)
  };
}

function defaultOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = RECONNECT_BASE_DELAYS_MS[Math.min(normalizedAttempt, RECONNECT_BASE_DELAYS_MS.length - 1)];
  return Math.round(base * (0.8 + 0.4 * normalizeRandom(random())));
}

export function parseRoomConnectionFrame(raw: unknown): RoomConnectionFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RoomConnectionFrame;
}

function joinSessionFromFrame(
  frame: RoomConnectionFrame,
  previous: RoomConnectionSession | null
): Extract<RoomConnectionSession, { action: 'join-room' }> | null {
  if ((frame.type !== 'snapshot' && frame.type !== 'resync') || typeof frame.playerId !== 'string') return null;
  const room = frame.room;
  if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
  const code = (room as { code?: unknown }).code;
  if (typeof code !== 'string' || !code) return null;
  return {
    action: 'join-room',
    code,
    name: previous?.name || 'Player',
    playerId: frame.playerId
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value: unknown, maximumLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximumLength;
}

function isPublicIdentifier(value: unknown): value is string {
  return isBoundedString(value, PUBLIC_SNAPSHOT_LIMITS.identifierLength);
}

function isPublicIdentifierOrNull(value: unknown): boolean {
  return value === null || isPublicIdentifier(value);
}

function isCardSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'value', 'faceUp', 'removed'])) return false;
  if (!/^(?:grid-\d+-\d+|discard-top|drawn-card)$/.test(String(value.id))) return false;
  if (typeof value.faceUp !== 'boolean' || typeof value.removed !== 'boolean') return false;
  return value.faceUp
    ? Number.isInteger(value.value) && Number(value.value) >= -2 && Number(value.value) <= 12
    : value.value === null;
}

function isGamePlayerSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ['id', 'name', 'kind', 'grid', 'totalScore', 'roundScore']) &&
    isPublicIdentifier(value.id) &&
    isBoundedString(value.name, PUBLIC_SNAPSHOT_LIMITS.nameLength) &&
    (value.kind === 'human' || value.kind === 'ai') &&
    Array.isArray(value.grid) &&
    value.grid.length === 12 &&
    value.grid.every(isCardSnapshot) &&
    Number.isFinite(value.totalScore) &&
    Number.isFinite(value.roundScore);
}

function isRoundHistorySnapshot(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ['round', 'closerId', 'scores']) &&
    Number.isSafeInteger(value.round) &&
    isPublicIdentifier(value.closerId) &&
    Array.isArray(value.scores) && value.scores.length > 0 && value.scores.length <= PUBLIC_SNAPSHOT_LIMITS.players &&
    value.scores.every((score) =>
      isRecord(score) &&
      hasExactKeys(score, ['playerId', 'name', 'roundScore', 'totalScore']) &&
      isPublicIdentifier(score.playerId) &&
      isBoundedString(score.name, PUBLIC_SNAPSHOT_LIMITS.nameLength) &&
      Number.isFinite(score.roundScore) &&
      Number.isFinite(score.totalScore)
    );
}

function isGameStateSnapshot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.players) ||
    value.players.length === 0 ||
    value.players.length > PUBLIC_SNAPSHOT_LIMITS.players
  ) return false;
  if (!hasExactKeys(value, [
    'players',
    'drawPileCount',
    'discardPile',
    'currentPlayerIndex',
    'phase',
    'selectedSource',
    'hasDrawnCard',
    'drawnCard',
    'round',
    'log',
    'winnerId',
    'nextStarterId',
    'roundCloserId',
    'finalTurnPlayerIds',
    'openingRevealCounts',
    'roundHistory'
  ])) return false;
  if (!value.players.every(isGamePlayerSnapshot)) return false;
  const publicPlayers = value.players as unknown as PublicPlayerSnapshot[];
  if (!publicPlayers.every((player, playerIndex) =>
    player.grid.every((card, cardIndex) => card.id === `grid-${playerIndex}-${cardIndex}`)
  )) return false;
  const gamePlayerIds = value.players.map((player) => (player as Record<string, unknown>).id);
  if (new Set(gamePlayerIds).size !== gamePlayerIds.length) return false;
  if (!Number.isSafeInteger(value.currentPlayerIndex) || Number(value.currentPlayerIndex) < 0 || Number(value.currentPlayerIndex) >= value.players.length) {
    return false;
  }
  if (!['opening-reveal', 'choose-source', 'choose-replacement', 'round-over', 'game-over'].includes(String(value.phase))) {
    return false;
  }
  if (value.selectedSource !== null && value.selectedSource !== 'draw' && value.selectedSource !== 'discard') return false;
  if (!Number.isSafeInteger(value.drawPileCount) || Number(value.drawPileCount) < 0 || Number(value.drawPileCount) > PUBLIC_SNAPSHOT_LIMITS.cards) return false;
  if (!isRecord(value.discardPile) || !hasExactKeys(value.discardPile, ['count', 'top'])) return false;
  if (!Number.isSafeInteger(value.discardPile.count) || Number(value.discardPile.count) < 0 || Number(value.discardPile.count) > PUBLIC_SNAPSHOT_LIMITS.cards) return false;
  if (Number(value.discardPile.count) === 0 ? value.discardPile.top !== null : !isCardSnapshot(value.discardPile.top)) return false;
  if (value.discardPile.top !== null && (value.discardPile.top as PublicCardSnapshot).id !== 'discard-top') return false;
  if (typeof value.hasDrawnCard !== 'boolean') return false;
  if (value.drawnCard !== null && !isCardSnapshot(value.drawnCard)) return false;
  if (value.drawnCard !== null && value.hasDrawnCard !== true) return false;
  if (value.drawnCard !== null && (value.drawnCard as PublicCardSnapshot).id !== 'drawn-card') return false;
  if (value.hasDrawnCard !== (value.phase === 'choose-replacement' && value.selectedSource === 'draw')) return false;
  if (!Number.isSafeInteger(value.round) || Number(value.round) < 1) return false;
  if (!Array.isArray(value.log) || value.log.length > PUBLIC_SNAPSHOT_LIMITS.logEntries || !value.log.every((item) => isBoundedString(item, PUBLIC_SNAPSHOT_LIMITS.logEntryLength, true))) return false;
  if (!isPublicIdentifierOrNull(value.winnerId) || !isPublicIdentifierOrNull(value.nextStarterId) || !isPublicIdentifierOrNull(value.roundCloserId)) return false;
  if (!Array.isArray(value.finalTurnPlayerIds) || value.finalTurnPlayerIds.length > PUBLIC_SNAPSHOT_LIMITS.players || !value.finalTurnPlayerIds.every(isPublicIdentifier)) return false;
  if (!isRecord(value.openingRevealCounts) || Object.keys(value.openingRevealCounts).length > PUBLIC_SNAPSHOT_LIMITS.players || !Object.keys(value.openingRevealCounts).every(isPublicIdentifier) || !Object.values(value.openingRevealCounts).every(Number.isFinite)) return false;
  return Array.isArray(value.roundHistory) && value.roundHistory.length <= PUBLIC_SNAPSHOT_LIMITS.historyEntries && value.roundHistory.every(isRoundHistorySnapshot);
}

function isRoomPlayerSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = ['id', 'name', 'connected', 'host', 'controller', 'disconnectedAt', 'aiTakeoverAt'];
  if ('joinedAt' in value) keys.push('joinedAt');
  if ('lastSeenAt' in value) keys.push('lastSeenAt');
  return hasExactKeys(value, keys) &&
    isPublicIdentifier(value.id) &&
    isBoundedString(value.name, PUBLIC_SNAPSHOT_LIMITS.nameLength) &&
    typeof value.connected === 'boolean' &&
    typeof value.host === 'boolean' &&
    (value.joinedAt === undefined || (Number.isFinite(value.joinedAt) && Number(value.joinedAt) >= 0)) &&
    (value.lastSeenAt === undefined || (Number.isFinite(value.lastSeenAt) && Number(value.lastSeenAt) >= 0)) &&
    (value.controller === 'human' || value.controller === 'ai') &&
    (value.disconnectedAt === null || (Number.isFinite(value.disconnectedAt) && Number(value.disconnectedAt) >= 0)) &&
    (value.aiTakeoverAt === null || (Number.isFinite(value.aiTakeoverAt) && Number(value.aiTakeoverAt) >= 0)) &&
    (value.connected ? value.disconnectedAt === null : value.disconnectedAt !== null) &&
    (value.aiTakeoverAt === null || (!value.connected && value.controller === 'human' && Number(value.aiTakeoverAt) >= Number(value.disconnectedAt)));
}

function isChatMessageSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ['id', 'playerId', 'playerName', 'text', 'createdAt']) &&
    isPublicIdentifier(value.id) &&
    isPublicIdentifier(value.playerId) &&
    isBoundedString(value.playerName, PUBLIC_SNAPSHOT_LIMITS.nameLength) &&
    isBoundedString(value.text, PUBLIC_SNAPSHOT_LIMITS.chatMessageLength) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(new Date(value.createdAt).getTime());
}

export function isMultiplayerRoomSnapshot(
  value: unknown,
  expectedCode: string | null = null
): value is PublicRoomSnapshot {
  if (!isRecord(value)) return false;
  const room = value;
  if (!hasExactKeys(room, [
    'code',
    'hostId',
    'players',
    'chatMessages',
    'readyForNextRoundPlayerIds',
    'state',
    'status',
    'updatedAt',
    'completedGameId',
    'finishedByAi',
    'hostTransferAt',
    'revision',
    'serverNow'
  ])) return false;
  if (typeof room.code !== 'string' || room.code.length !== PUBLIC_SNAPSHOT_LIMITS.roomCodeLength || !/^[A-Z0-9]+$/.test(room.code)) return false;
  if (expectedCode && room.code !== expectedCode) return false;
  if (!isPublicIdentifier(room.hostId)) return false;
  if (!Array.isArray(room.players) || room.players.length < 1 || room.players.length > PUBLIC_SNAPSHOT_LIMITS.players || !room.players.every(isRoomPlayerSnapshot)) {
    return false;
  }
  const roomPlayerIds = room.players.map((player) => (player as Record<string, unknown>).id);
  if (new Set(roomPlayerIds).size !== roomPlayerIds.length || !roomPlayerIds.includes(room.hostId)) return false;
  const publicPlayers = room.players as Array<Record<string, unknown>>;
  if (publicPlayers.filter((player) => player.host === true).length !== 1 ||
      publicPlayers.find((player) => player.host === true)?.id !== room.hostId) return false;
  if (!['waiting', 'playing', 'finished'].includes(String(room.status)) || !Number.isFinite(room.updatedAt)) return false;
  if (typeof room.finishedByAi !== 'boolean' || !Number.isFinite(room.serverNow) || Number(room.serverNow) < 0) return false;
  if (room.hostTransferAt !== null && (!Number.isFinite(room.hostTransferAt) || Number(room.hostTransferAt) < 0)) return false;
  if (!Array.isArray(room.chatMessages) || room.chatMessages.length > PUBLIC_SNAPSHOT_LIMITS.chatMessages || !room.chatMessages.every(isChatMessageSnapshot)) return false;
  if (!room.chatMessages.every((message) => roomPlayerIds.includes((message as Record<string, unknown>).playerId))) return false;
  if (!Array.isArray(room.readyForNextRoundPlayerIds) || room.readyForNextRoundPlayerIds.length > PUBLIC_SNAPSHOT_LIMITS.players || !room.readyForNextRoundPlayerIds.every((id) => isPublicIdentifier(id) && roomPlayerIds.includes(id))) {
    return false;
  }
  if (!isPublicIdentifierOrNull(room.completedGameId)) return false;
  if (!Number.isSafeInteger(room.revision) || Number(room.revision) < 0) return false;
  if (room.state === null) return true;
  if (!isGameStateSnapshot(room.state)) return false;
  const statePlayerIds = (room.state as unknown as PublicGameStateSnapshot).players.map((player) => player.id);
  return statePlayerIds.length === roomPlayerIds.length && statePlayerIds.every((id) => roomPlayerIds.includes(id));
}

function isAuthoritativeSnapshot(
  frame: RoomConnectionFrame,
  currentSession: RoomConnectionSession | null,
  synchronizedOnCurrentSocket: boolean,
  pendingCommand: PendingCommandState | null
): boolean {
  if (frame.type !== 'snapshot' && frame.type !== 'resync') return false;
  if (frame.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) return false;
  if (!isPublicIdentifier(frame.playerId)) return false;
  if (!Number.isSafeInteger(frame.revision) || Number(frame.revision) < 0) return false;
  const establishedPlayerId = currentSession?.action === 'join-room' ? currentSession.playerId : undefined;
  const recoveryExpectation = resetRecoveryExpectation(currentSession);
  const pendingAction = isRecord(pendingCommand?.frame.action) ? pendingCommand.frame.action : null;
  const correlatedResetFrame =
    frame.type === 'resync' &&
    frame.reason === 'room-reset' &&
    typeof frame.commandId === 'string';
  const pendingResetTransition =
    correlatedResetFrame &&
    pendingCommand !== null &&
    pendingAction?.type === 'reset-room' &&
    frame.commandId === pendingCommand.commandId &&
    Number(frame.revision) === pendingCommand.expectedRevision + 1 &&
    Boolean(establishedPlayerId) &&
    frame.playerId === establishedPlayerId;
  const recoveryResetTransition =
    correlatedResetFrame &&
    !synchronizedOnCurrentSocket &&
    currentSession?.action === 'join-room' &&
    Boolean(currentSession.playerId) &&
    frame.playerId === currentSession.playerId &&
    recoveryExpectation !== null &&
    frame.commandId === recoveryExpectation.commandId &&
    Number(frame.revision) >= recoveryExpectation.expectedRevision + 1;
  const resetTransition = pendingResetTransition || recoveryResetTransition;
  const expectedCode = currentSession?.action === 'join-room' && !resetTransition ? currentSession.code : null;
  if (!isMultiplayerRoomSnapshot(frame.room, expectedCode)) return false;
  if (
    resetTransition &&
    currentSession?.action === 'join-room' &&
    frame.room.code === currentSession.code
  ) return false;
  if (!frame.room.players.some((player) => player.id === frame.playerId)) return false;
  if (establishedPlayerId && frame.playerId !== establishedPlayerId) return false;
  if (frame.revision !== frame.room.revision) return false;
  if (frame.room.state) {
    const activePlayerId = frame.room.state.players[frame.room.state.currentPlayerIndex]?.id;
    const viewerIsDrawer = frame.room.state.selectedSource === 'draw' && frame.room.state.hasDrawnCard && activePlayerId === frame.playerId;
    if (Boolean(frame.room.state.drawnCard) !== viewerIsDrawer) return false;
  }
  if (frame.type === 'snapshot') {
    return hasExactKeys(frame, ['type', 'protocolVersion', 'playerId', 'revision', 'room']);
  }
  const keys = ['type', 'protocolVersion', 'playerId', 'revision', 'room', 'reason'];
  if ('commandId' in frame) keys.push('commandId');
  return (synchronizedOnCurrentSocket || currentSession?.action === 'join-room') &&
    hasExactKeys(frame, keys) &&
    typeof frame.reason === 'string' &&
    (frame.commandId === undefined || typeof frame.commandId === 'string');
}

function isAuxiliaryServerFrame(
  frame: RoomConnectionFrame,
  pendingCommand: PendingCommandState | null
): boolean {
  if (frame.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) return false;
  if (frame.type === 'ack') {
    const pendingAction = isRecord(pendingCommand?.frame.action) ? pendingCommand.frame.action : null;
    const terminalLeave = frame.result === 'room-left';
    return hasExactKeys(
      frame,
      terminalLeave
        ? ['type', 'protocolVersion', 'commandId', 'revision', 'result']
        : ['type', 'protocolVersion', 'commandId', 'revision']
    ) &&
      typeof frame.commandId === 'string' &&
      Number.isSafeInteger(frame.revision) &&
      Number(frame.revision) >= 0 &&
      (!terminalLeave || (
        pendingCommand !== null &&
        pendingAction?.type === 'leave-room' &&
        frame.commandId === pendingCommand.commandId &&
        Number(frame.revision) === pendingCommand.expectedRevision + 1
      ));
  }
  if (frame.type === 'upgrade-required') {
    const keys = ['type', 'protocolVersion', 'message'];
    if ('commandId' in frame) keys.push('commandId');
    return hasExactKeys(frame, keys) &&
      typeof frame.message === 'string' &&
      (frame.commandId === undefined || typeof frame.commandId === 'string');
  }
  if (frame.type === 'error') {
    const keys = ['type', 'protocolVersion', 'code', 'message'];
    if ('commandId' in frame) keys.push('commandId');
    return hasExactKeys(frame, keys) &&
      typeof frame.code === 'string' &&
      typeof frame.message === 'string' &&
      (frame.commandId === undefined || typeof frame.commandId === 'string');
  }
  return false;
}

function sessionWireFrame(currentSession: RoomConnectionSession): RoomConnectionFrame {
  if (currentSession.action === 'create-room') {
    return { type: 'create-room', protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, name: currentSession.name };
  }
  const recoveryExpectation = resetRecoveryExpectation(currentSession);
  return {
    type: 'join-room',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    presenceVersion: EXPLICIT_PRESENCE_VERSION,
    code: currentSession.code,
    name: currentSession.name,
    ...(currentSession.playerId ? { playerId: currentSession.playerId } : {}),
    ...(recoveryExpectation
      ? { recoveryCommandId: recoveryExpectation.commandId }
      : {})
  };
}

function sessionKey(value: RoomConnectionSession | null): string {
  if (!value) return '';
  const recoveryExpectation = resetRecoveryExpectation(value);
  return value.action === 'create-room'
    ? `create-room\u0000${value.name}`
    : `join-room\u0000${value.code}\u0000${value.name}\u0000${value.playerId || ''}\u0000${recoveryExpectation?.commandId || ''}\u0000${recoveryExpectation?.expectedRevision ?? ''}`;
}

export function createRoomConnection(options: RoomConnectionOptions): RoomConnectionController {
  const defaultCancelTimer = (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  const defaultScheduleTimer = (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs);
  const dependencies: RoomConnectionDependencies = {
    cancelTimer: options.cancelTimer ?? defaultCancelTimer,
    cancelSyncTimer: options.cancelSyncTimer ?? options.cancelTimer ?? defaultCancelTimer,
    clock: options.clock ?? Date.now,
    createSocket:
      options.createSocket ??
      ((url) => new WebSocket(url) as unknown as RoomConnectionSocket),
    isOnline: options.isOnline ?? defaultOnline,
    random: options.random ?? Math.random,
    scheduleTimer: options.scheduleTimer ?? defaultScheduleTimer,
    scheduleSyncTimer: options.scheduleSyncTimer ?? options.scheduleTimer ?? defaultScheduleTimer
  };

  let attempt = 0;
  let currentSocket: RoomConnectionSocket | null = null;
  let disposed = false;
  let desiredVisible = true;
  let generation = 0;
  let lastPresenceVisible: boolean | null = null;
  let presenceSentGeneration = -1;
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  let online = dependencies.isOnline();
  let pendingCommand: PendingCommandState | null = null;
  let lastSnapshotRevision = -1;
  let reconnectTimer: unknown = null;
  let reconnectTimerToken = 0;
  let session: RoomConnectionSession | null = null;
  let state: RoomConnectionState = 'idle';
  let syncTimer: unknown = null;
  let syncTimerToken = 0;

  function setPendingCommand(nextPending: PendingCommandState | null): void {
    const changed = Boolean(pendingCommand) !== Boolean(nextPending);
    pendingCommand = nextPending;
    if (changed) options.onPendingCommandChange?.(Boolean(nextPending));
  }

  function bindResetRecovery(pending: PendingCommandState): RoomConnectionSession | null {
    const action = isRecord(pending.frame.action) ? pending.frame.action : null;
    if (action?.type !== 'reset-room' || session?.action !== 'join-room' || !session.playerId) return null;
    const previousSession = session;
    session = {
      ...session,
      recoveryCommandId: pending.commandId,
      recoveryExpectedRevision: pending.expectedRevision
    };
    return previousSession;
  }

  function clearResetRecovery(commandId: unknown): void {
    if (
      session?.action !== 'join-room' ||
      typeof commandId !== 'string' ||
      session.recoveryCommandId !== commandId
    ) return;
    session = {
      action: 'join-room',
      code: session.code,
      name: session.name,
      ...(session.playerId ? { playerId: session.playerId } : {})
    };
  }

  function completePendingIfConverged(): void {
    const pending = pendingCommand;
    if (
      pending?.acknowledgedRevision !== null &&
      pending?.acknowledgedRevision !== undefined &&
      lastSnapshotRevision >= pending.acknowledgedRevision
    ) {
      setPendingCommand(null);
    }
  }

  function replayPendingCommand(socket: RoomConnectionSocket, socketGeneration: number): void {
    const pending = pendingCommand;
    if (!pending || pending.sentGeneration === socketGeneration || pending.acknowledgedRevision !== null) return;
    const previousSession = bindResetRecovery(pending);
    try {
      socket.send(JSON.stringify(pending.frame));
      pending.sentGeneration = socketGeneration;
    } catch {
      if (previousSession) session = previousSession;
      // The pending command remains ambiguous and will retry after transport recovery.
    }
  }

  function transition(nextState: RoomConnectionState, retryInMs: number | null = null): void {
    state = nextState;
    options.onStateChange(nextState, { retryInMs });
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    dependencies.cancelTimer(reconnectTimer);
    reconnectTimer = null;
    reconnectTimerToken += 1;
  }

  function clearSyncTimer(): void {
    if (syncTimer === null) return;
    dependencies.cancelSyncTimer(syncTimer);
    syncTimer = null;
    syncTimerToken += 1;
  }

  function retireCurrentSocket(code = 1000, reason = 'Connection replaced'): void {
    clearSyncTimer();
    const socket = currentSocket;
    if (!socket) return;
    currentSocket = null;
    generation += 1;
    try {
      socket.close(code, reason);
    } catch {
      // The generation guard already detached this socket.
    }
  }

  function recoverableSession(): Extract<RoomConnectionSession, { action: 'join-room' }> | null {
    return session?.action === 'join-room' && session.code && session.playerId ? session : null;
  }

  function scheduleReconnect(): void {
    const scheduledSession = recoverableSession();
    if (disposed || reconnectTimer !== null || currentSocket || !scheduledSession) return;
    if (!online || !dependencies.isOnline()) {
      online = false;
      transition('offline');
      return;
    }
    const delayMs = reconnectDelayMs(attempt, dependencies.random);
    const scheduledGeneration = generation;
    const scheduledSessionKey = sessionKey(scheduledSession);
    const timerToken = ++reconnectTimerToken;
    attempt = Math.min(attempt + 1, RECONNECT_BASE_DELAYS_MS.length - 1);
    transition('reconnecting', delayMs);
    reconnectTimer = dependencies.scheduleTimer(() => {
      if (timerToken !== reconnectTimerToken) return;
      reconnectTimer = null;
      const currentRecoverableSession = recoverableSession();
      if (
        disposed ||
        currentSocket ||
        generation !== scheduledGeneration ||
        !currentRecoverableSession ||
        sessionKey(currentRecoverableSession) !== scheduledSessionKey
      ) return;
      openSocket(currentRecoverableSession, true);
    }, delayMs);
  }

  function handleMalformedServerFrame(socket: RoomConnectionSocket): void {
    options.onError?.('The room server sent an invalid response. Reconnecting.');
    if (currentSocket === socket) {
      clearSyncTimer();
      currentSocket = null;
      generation += 1;
    }
    try {
      socket.close(1002, 'Invalid server response');
    } catch {
      // The generation guard already detached the invalid transport.
    }
    if (recoverableSession()) scheduleReconnect();
    else transition('error');
  }

  function armSyncTimeout(
    socket: RoomConnectionSocket,
    socketGeneration: number,
    nextSession: RoomConnectionSession
  ): void {
    clearSyncTimer();
    const timerToken = ++syncTimerToken;
    syncTimer = dependencies.scheduleSyncTimer(() => {
      if (timerToken !== syncTimerToken) return;
      syncTimer = null;
      if (disposed || currentSocket !== socket || generation !== socketGeneration) return;
      currentSocket = null;
      generation += 1;
      try {
        socket.close(4001, 'Room synchronization timed out');
      } catch {
        // The generation guard already detached the timed-out transport.
      }
      if (nextSession.action === 'join-room' && nextSession.playerId && recoverableSession()) {
        options.onError?.('Room synchronization timed out. Reconnecting.');
        scheduleReconnect();
        return;
      }
      session = null;
      transition('error');
      options.onError?.(
        nextSession.action === 'create-room'
          ? 'Room synchronization timed out. Try creating the room again.'
          : 'Room synchronization timed out. Try joining the room again.'
      );
    }, ROOM_SYNC_TIMEOUT_MS);
  }

  function openSocket(nextSession: RoomConnectionSession, recovering: boolean): void {
    if (disposed) return;
    if (!online || !dependencies.isOnline()) {
      online = false;
      transition('offline');
      return;
    }

    clearReconnectTimer();
    const socketGeneration = ++generation;
    let socket: RoomConnectionSocket;
    try {
      socket = dependencies.createSocket(options.url);
    } catch {
      options.onError?.('Could not open the room connection.');
      if (recovering) scheduleReconnect();
      else transition('error');
      return;
    }
    currentSocket = socket;
    transition(recovering ? 'reconnecting' : 'connecting');
    let synchronizedOnCurrentSocket = false;
    let transportFailureReported = false;

    const isCurrent = () => !disposed && currentSocket === socket && generation === socketGeneration;

    socket.addEventListener('open', () => {
      if (!isCurrent()) return;
      try {
        socket.send(JSON.stringify(sessionWireFrame(nextSession)));
      } catch {
        try {
          socket.close(1011, 'Join send failed');
        } catch {
          // The close listener will recover when the transport reports closure.
        }
      }
    });

    socket.addEventListener('message', (event) => {
      if (!isCurrent()) return;
      const raw = event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event;
      const frame = parseRoomConnectionFrame(raw);
      if (!frame) {
        handleMalformedServerFrame(socket);
        return;
      }

      const snapshotFrame = frame.type === 'snapshot' || frame.type === 'resync';
      const pendingAction = isRecord(pendingCommand?.frame.action) ? pendingCommand.frame.action : null;
      const resetTransitionFrame =
        frame.type === 'resync' &&
        frame.reason === 'room-reset' &&
        pendingCommand !== null &&
        pendingAction?.type === 'reset-room' &&
        frame.commandId === pendingCommand.commandId;
      if (
        (snapshotFrame && !isAuthoritativeSnapshot(frame, session, synchronizedOnCurrentSocket, pendingCommand)) ||
        (!snapshotFrame && !isAuxiliaryServerFrame(frame, pendingCommand))
      ) {
        handleMalformedServerFrame(socket);
        return;
      }
      if (resetTransitionFrame && pendingCommand) {
        pendingCommand.acknowledgedRevision = pendingCommand.expectedRevision + 1;
        pendingCommand.sentGeneration = socketGeneration;
      }

      const recoveredSession = joinSessionFromFrame(frame, session);
      if (recoveredSession) {
        session = recoveredSession;
        synchronizedOnCurrentSocket = true;
      }
      if (snapshotFrame) {
        clearSyncTimer();
        attempt = 0;
        lastSnapshotRevision = Number(frame.revision);
        if (
          pendingCommand &&
          pendingCommand.acknowledgedRevision !== null &&
          lastSnapshotRevision < pendingCommand.acknowledgedRevision
        ) {
          pendingCommand.acknowledgedRevision = null;
          pendingCommand.sentGeneration = -1;
        }
        transition('connected');
        if (
          frame.type === 'resync' &&
          pendingCommand &&
          frame.commandId === pendingCommand.commandId &&
          !resetTransitionFrame
        ) {
          clearResetRecovery(frame.commandId);
          setPendingCommand(null);
          options.onError?.('The room changed before that action was accepted. Review the synchronized table and try again.');
        } else {
          completePendingIfConverged();
        }
      } else if (
        frame.type === 'ack' &&
        frame.result === 'room-left' &&
        pendingCommand &&
        frame.commandId === pendingCommand.commandId
      ) {
        clearReconnectTimer();
        clearSyncTimer();
        setPendingCommand(null);
        lastSnapshotRevision = -1;
        session = null;
        currentSocket = null;
        generation += 1;
        try {
          socket.close(1000, 'Room left');
        } catch {
          // The terminal acknowledgement already retired this socket generation.
        }
        transition('idle');
      } else if (frame.type === 'ack' && pendingCommand && frame.commandId === pendingCommand.commandId) {
        const expectedAppliedRevision = pendingCommand.expectedRevision + 1;
        if (frame.revision !== expectedAppliedRevision) {
          handleMalformedServerFrame(socket);
          return;
        }
        pendingCommand.acknowledgedRevision = Number(frame.revision);
        completePendingIfConverged();
      } else if (frame.type === 'upgrade-required') {
        setPendingCommand(null);
        clearSyncTimer();
        session = null;
        currentSocket = null;
        generation += 1;
        try {
          socket.close(1002, 'Protocol upgrade required');
        } catch {
          // The generation guard already detached this socket.
        }
        transition('error');
      } else if (frame.type === 'error' && pendingCommand && frame.commandId === pendingCommand.commandId) {
        clearResetRecovery(frame.commandId);
        setPendingCommand(null);
      }

      if (frame.type === 'error' && frame.code === 'seat-removed') {
        clearReconnectTimer();
        clearSyncTimer();
        setPendingCommand(null);
        lastSnapshotRevision = -1;
        session = null;
        currentSocket = null;
        generation += 1;
        try {
          socket.close(1000, 'Room seat removed');
        } catch {
          // The terminal server result already retired this socket generation.
        }
        transition('idle');
      }

      if (frame.type === 'error' && frame.code !== 'seat-removed' && state !== 'connected') {
        clearSyncTimer();
        setPendingCommand(null);
        session = null;
        currentSocket = null;
        generation += 1;
        try {
          socket.close(1000, 'Pending room request rejected');
        } catch {
          // The generation guard already detached the rejected socket.
        }
        transition('error');
      }
      options.onFrame(frame);
      if (snapshotFrame && currentSocket === socket) {
        if (presenceSentGeneration !== socketGeneration) {
          if (send({ type: 'set-presence', visible: desiredVisible })) {
            presenceSentGeneration = socketGeneration;
            lastPresenceVisible = desiredVisible;
            if (desiredVisible) lastResumeAt = dependencies.clock();
          }
        }
        replayPendingCommand(socket, socketGeneration);
      }
    });

    socket.addEventListener('error', () => {
      if (!isCurrent()) return;
      transportFailureReported = true;
      options.onError?.('The room connection was interrupted.');
      try {
        socket.close(1011, 'Transport error');
      } catch {
        // Browsers normally follow an error event with close.
      }
    });

    socket.addEventListener('close', () => {
      if (!isCurrent()) return;
      clearSyncTimer();
      currentSocket = null;
      if (!online || !dependencies.isOnline()) {
        online = false;
        transition('offline');
        return;
      }
      if (recoverableSession()) {
        scheduleReconnect();
        return;
      }
      transition('error');
      if (!transportFailureReported) options.onError?.('Room connection closed. Rejoin to continue.');
    });
    armSyncTimeout(socket, socketGeneration, nextSession);
  }

  function connect(nextSession: RoomConnectionSession): void {
    if (disposed) return;
    setPendingCommand(null);
    lastSnapshotRevision = -1;
    clearReconnectTimer();
    retireCurrentSocket();
    attempt = 0;
    online = dependencies.isOnline();
    session = nextSession;
    if (!online) {
      transition('offline');
      return;
    }
    openSocket(nextSession, false);
  }

  function recover(nextSession: SavedRoomConnectionSession): void {
    if (disposed) return;
    if (sessionKey(session) !== sessionKey(nextSession)) {
      clearReconnectTimer();
      if (currentSocket) retireCurrentSocket();
      generation += 1;
    }
    session = nextSession;
    online = dependencies.isOnline();
    if (currentSocket || reconnectTimer !== null) return;
    attempt = 0;
    scheduleReconnect();
  }

  function disconnect(): void {
    clearReconnectTimer();
    setPendingCommand(null);
    lastSnapshotRevision = -1;
    session = null;
    attempt = 0;
    retireCurrentSocket(1000, 'Room session ended');
    if (!disposed) transition('idle');
  }

  function send(frame: RoomConnectionFrame): boolean {
    const socket = currentSocket;
    if (disposed || state !== 'connected' || !socket || socket.readyState !== socketOpen) return false;
    const parsedCommand = frame.type === 'command' ? parseClientCommand(frame) : null;
    if (frame.type === 'command' && (!parsedCommand || !parsedCommand.ok || pendingCommand)) return false;
    let previousSession: RoomConnectionSession | null = null;
    try {
      if (parsedCommand?.ok) {
        const nextPending = {
          frame: parsedCommand.command as unknown as RoomConnectionFrame,
          commandId: parsedCommand.command.commandId,
          expectedRevision: parsedCommand.command.expectedRevision,
          acknowledgedRevision: null,
          sentGeneration: generation
        } satisfies PendingCommandState;
        setPendingCommand(nextPending);
        previousSession = bindResetRecovery(nextPending);
      }
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      if (parsedCommand?.ok) {
        if (previousSession) session = previousSession;
        setPendingCommand(null);
      }
      return false;
    }
  }

  function resume(): void {
    if (disposed || !recoverableSession()) return;
    desiredVisible = true;
    online = dependencies.isOnline();
    if (!online) {
      setOnline(false);
      return;
    }
    const socket = currentSocket;
    if (socket?.readyState === socketOpen) {
      const timestamp = dependencies.clock();
      if (
        presenceSentGeneration === generation &&
        lastPresenceVisible === true &&
        timestamp - lastResumeAt < resumeCoalesceMs
      ) return;
      if (send({ type: 'set-presence', visible: true })) {
        presenceSentGeneration = generation;
        lastPresenceVisible = true;
        lastResumeAt = timestamp;
      }
      return;
    }
    if (socket?.readyState === socketConnecting) return;
    if (socket) retireCurrentSocket();
    scheduleReconnect();
  }

  function setVisible(visible: boolean): void {
    desiredVisible = visible;
    if (disposed || !recoverableSession()) return;
    if (visible) {
      resume();
      return;
    }
    if (send({ type: 'set-presence', visible: false })) {
      presenceSentGeneration = generation;
      lastPresenceVisible = false;
    }
  }

  function setOnline(nextOnline: boolean): void {
    if (disposed) return;
    const wasOnline = online;
    online = nextOnline;
    if (!nextOnline) {
      clearReconnectTimer();
      retireCurrentSocket(4000, 'Browser offline');
      transition('offline');
      return;
    }
    if (wasOnline) return;
    if (!recoverableSession()) {
      transition('idle');
      return;
    }
    attempt = 0;
    scheduleReconnect();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearReconnectTimer();
    clearSyncTimer();
    setPendingCommand(null);
    session = null;
    retireCurrentSocket(1000, 'Page closed');
  }

  return {
    connect,
    disconnect,
    dispose,
    getState: () => state,
    recover,
    resume,
    send,
    setOnline,
    setVisible
  };
}
