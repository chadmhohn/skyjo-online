export type RoomConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export type RoomConnectionFrame = Record<string, unknown>;

export type RoomConnectionSession =
  | { action: 'create-room'; name: string }
  | { action: 'join-room'; code: string; name: string; playerId?: string };

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
  if (frame.type !== 'joined' || typeof frame.playerId !== 'string') return null;
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

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isCardSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    Number.isFinite(value.value) &&
    typeof value.faceUp === 'boolean' &&
    typeof value.removed === 'boolean';
}

function isGamePlayerSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.kind === 'human' || value.kind === 'ai') &&
    Array.isArray(value.grid) &&
    value.grid.length === 12 &&
    value.grid.every(isCardSnapshot) &&
    Number.isFinite(value.totalScore) &&
    Number.isFinite(value.roundScore);
}

function isRoundHistorySnapshot(value: unknown): boolean {
  return isRecord(value) &&
    Number.isSafeInteger(value.round) &&
    typeof value.closerId === 'string' &&
    Array.isArray(value.scores) &&
    value.scores.every((score) =>
      isRecord(score) &&
      typeof score.playerId === 'string' &&
      typeof score.name === 'string' &&
      Number.isFinite(score.roundScore) &&
      Number.isFinite(score.totalScore)
    );
}

function isGameStateSnapshot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.players) ||
    value.players.length === 0 ||
    value.players.length > 8
  ) return false;
  if (!value.players.every(isGamePlayerSnapshot)) return false;
  if (!Number.isSafeInteger(value.currentPlayerIndex) || Number(value.currentPlayerIndex) < 0 || Number(value.currentPlayerIndex) >= value.players.length) {
    return false;
  }
  if (!['opening-reveal', 'choose-source', 'choose-replacement', 'round-over', 'game-over'].includes(String(value.phase))) {
    return false;
  }
  if (value.selectedSource !== null && value.selectedSource !== 'draw' && value.selectedSource !== 'discard') return false;
  if (!Array.isArray(value.drawPile) || !value.drawPile.every(isCardSnapshot)) return false;
  if (!Array.isArray(value.discardPile) || !value.discardPile.every(isCardSnapshot)) return false;
  if (value.drawnCard !== null && !isCardSnapshot(value.drawnCard)) return false;
  if (!Number.isSafeInteger(value.round) || Number(value.round) < 1) return false;
  if (!Array.isArray(value.log) || !value.log.every((item) => typeof item === 'string')) return false;
  if (!isStringOrNull(value.winnerId) || !isStringOrNull(value.nextStarterId) || !isStringOrNull(value.roundCloserId)) return false;
  if (!Array.isArray(value.finalTurnPlayerIds) || !value.finalTurnPlayerIds.every((id) => typeof id === 'string')) return false;
  if (!isRecord(value.openingRevealCounts) || !Object.values(value.openingRevealCounts).every(Number.isFinite)) return false;
  return Array.isArray(value.roundHistory) && value.roundHistory.every(isRoundHistorySnapshot);
}

function isRoomPlayerSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.connected === 'boolean' &&
    typeof value.host === 'boolean' &&
    (value.userId === undefined || typeof value.userId === 'string');
}

function isChatMessageSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.playerId === 'string' &&
    typeof value.playerName === 'string' &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(new Date(value.createdAt).getTime());
}

export function isMultiplayerRoomSnapshot(
  value: unknown,
  expectedCode: string | null = null
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const room = value;
  if (typeof room.code !== 'string' || !room.code) return false;
  if (expectedCode && room.code !== expectedCode) return false;
  if (typeof room.hostId !== 'string' || !room.hostId) return false;
  if (!Array.isArray(room.players) || room.players.length < 1 || room.players.length > 8 || !room.players.every(isRoomPlayerSnapshot)) {
    return false;
  }
  if (!['waiting', 'playing', 'finished'].includes(String(room.status)) || !Number.isFinite(room.updatedAt)) return false;
  if (!Array.isArray(room.chatMessages) || !room.chatMessages.every(isChatMessageSnapshot)) return false;
  if (!Array.isArray(room.readyForNextRoundPlayerIds) || !room.readyForNextRoundPlayerIds.every((id) => typeof id === 'string')) {
    return false;
  }
  if (room.completedGameId !== undefined && !isStringOrNull(room.completedGameId)) return false;
  return room.state === null || isGameStateSnapshot(room.state);
}

function isAuthoritativeSnapshot(
  frame: RoomConnectionFrame,
  currentSession: RoomConnectionSession | null,
  joinedOnCurrentSocket: boolean
): boolean {
  const expectedCode = currentSession?.action === 'join-room' ? currentSession.code : null;
  if (frame.type === 'joined') {
    return typeof frame.playerId === 'string' && Boolean(frame.playerId) && isMultiplayerRoomSnapshot(frame.room, expectedCode);
  }
  if (frame.type === 'room') {
    return joinedOnCurrentSocket && currentSession?.action === 'join-room' && isMultiplayerRoomSnapshot(frame.room, expectedCode);
  }
  return false;
}

function sessionWireFrame(currentSession: RoomConnectionSession): RoomConnectionFrame {
  if (currentSession.action === 'create-room') {
    return { type: 'create-room', name: currentSession.name };
  }
  return {
    type: 'join-room',
    code: currentSession.code,
    name: currentSession.name,
    ...(currentSession.playerId ? { playerId: currentSession.playerId } : {})
  };
}

function sessionKey(value: RoomConnectionSession | null): string {
  if (!value) return '';
  return value.action === 'create-room'
    ? `create-room\u0000${value.name}`
    : `join-room\u0000${value.code}\u0000${value.name}\u0000${value.playerId || ''}`;
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
  let lastResumeAt = Number.NEGATIVE_INFINITY;
  let online = dependencies.isOnline();
  let reconnectTimer: unknown = null;
  let reconnectTimerToken = 0;
  let session: RoomConnectionSession | null = null;
  let state: RoomConnectionState = 'idle';
  let syncTimer: unknown = null;
  let syncTimerToken = 0;

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
    let joinedOnCurrentSocket = false;
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

      if (
        (frame.type === 'joined' || frame.type === 'room') &&
        !isAuthoritativeSnapshot(frame, session, joinedOnCurrentSocket)
      ) {
        handleMalformedServerFrame(socket);
        return;
      }

      const recoveredSession = joinSessionFromFrame(frame, session);
      if (recoveredSession) {
        session = recoveredSession;
        joinedOnCurrentSocket = true;
      }
      if (frame.type === 'joined' || frame.type === 'room') {
        clearSyncTimer();
        attempt = 0;
        transition('connected');
        if (frame.type === 'joined' && !desiredVisible) send({ type: 'set-presence', visible: false });
      } else if (frame.type === 'error' && state !== 'connected') {
        clearSyncTimer();
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
    session = null;
    attempt = 0;
    retireCurrentSocket(1000, 'Room session ended');
    if (!disposed) transition('idle');
  }

  function send(frame: RoomConnectionFrame): boolean {
    const socket = currentSocket;
    if (disposed || state !== 'connected' || !socket || socket.readyState !== socketOpen) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
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
      if (timestamp - lastResumeAt < resumeCoalesceMs) return;
      lastResumeAt = timestamp;
      send({ type: 'set-presence', visible: true });
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
    send({ type: 'set-presence', visible: false });
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
