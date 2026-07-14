import {
  EXPLICIT_PRESENCE_VERSION,
  MAX_RECENT_COMMAND_RECEIPTS,
  MULTIPLAYER_PROTOCOL_VERSION,
  SHARED_SNAPSHOT_ENVELOPE_VERSION,
  parseClientCommand,
  reduceAuthoritativeAiAction,
  reduceAuthoritativeGameCommand,
  type CommandReceipt,
  type GameCommand
} from './protocolV2.js';
import {
  canTakeOverWithAi,
  connectedWaitingPlayerIds,
  DEFAULT_ROOM_LIFECYCLE_POLICY,
  hostFlags,
  oldestConnectedHuman,
  removePlayerReferences,
  shouldAutoReady,
  shouldRunAiAction,
  type RoomLifecyclePolicy
} from './serverRoomLifecycle.js';
import type { RandomSource } from './runtime.js';
import { detachRealtimeSocket, type RealtimeClientMessage, type RealtimeSocket } from './serverRealtime.js';
import type { GameState, RoomChatMessage, RoomPlayer } from './types';

export interface ProtocolV2AccountUser {
  displayName: string;
  id: string;
}

export interface ProtocolV2Socket extends RealtimeSocket {
  accountUser?: ProtocolV2AccountUser;
  automated?: boolean;
}

export const MAX_RESET_ALIASES = 8;
export const RESET_ALIAS_TTL_MS = 30 * 60 * 1_000;

export interface ProtocolV2ResetAlias {
  commandId: string;
  expiresAt: number;
  fromCode: string;
  playerId: string;
}

export interface ProtocolV2ResetAliasIndexEntry {
  alias: ProtocolV2ResetAlias;
  targetCode: string;
}

export type ProtocolV2ResetAliasIndex = Map<string, ProtocolV2ResetAliasIndexEntry[]>;

export function retainCommandReceiptsForResetAliases(
  receipts: readonly CommandReceipt[],
  aliases: readonly Pick<ProtocolV2ResetAlias, 'commandId'>[]
): CommandReceipt[] {
  const pinnedCommandIds = new Set(aliases.map((alias) => alias.commandId));
  const maximumUnpinnedReceipts = Math.max(0, MAX_RECENT_COMMAND_RECEIPTS - pinnedCommandIds.size);
  const retained: CommandReceipt[] = [];
  let unpinnedCount = 0;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    const pinned = pinnedCommandIds.has(receipt.commandId);
    if (!pinned && unpinnedCount >= maximumUnpinnedReceipts) continue;
    retained.push(receipt);
    if (!pinned) unpinnedCount += 1;
  }
  return retained.reverse();
}

export interface ProtocolV2Room {
  chatMessages: RoomChatMessage[];
  clients: Set<RealtimeSocket>;
  code: string;
  completedGameId: string | null;
  finishedByAi?: boolean;
  gameSessionId: string | null;
  hostId: string;
  players: RoomPlayer[];
  readyForNextRoundPlayerIds: string[];
  recentCommandIds: CommandReceipt[];
  resetAliases: ProtocolV2ResetAlias[];
  revision: number;
  roomInstanceId: string;
  roomVersion: 2;
  state: GameState | null;
  status: 'waiting' | 'playing' | 'finished';
  updatedAt: number;
}

export interface ProtocolV2RoomPlayer {
  player: RoomPlayer;
  room: ProtocolV2Room;
}

export interface ProtocolV2CompletedGameInput {
  createdByUserId: string | null;
  mode: 'multi';
  playerAccounts: Record<string, string | null>;
  roomCode: string;
  sourceKey: string;
  state: GameState;
  finishedByAi: boolean;
}

export interface ProtocolV2RecordedGame {
  finishedByAi?: boolean;
  id: string;
  recovered: boolean;
  state: GameState;
}

export interface ProtocolV2HandlerOptions {
  allPlayersReadyForNextRound: (room: ProtocolV2Room) => boolean;
  appendRoomChatMessage: (room: ProtocolV2Room, player: RoomPlayer, text: string) => unknown;
  broadcastRoom: (room: ProtocolV2Room) => unknown;
  cleanChatText: (value: unknown) => string;
  createInitialRoomState: (players: RoomPlayer[], random: RandomSource) => GameState;
  createNextRoundRoomState: (state: GameState, random: RandomSource) => GameState;
  createWaitingRoom: (input: {
    code: string;
    hostPlayer: Pick<RoomPlayer, 'id' | 'name' | 'userId'>;
    ws: ProtocolV2Socket;
  }) => ProtocolV2Room;
  digestAction: (canonicalAction: string) => string;
  makeRoomCodeForSocket: (socket: ProtocolV2Socket) => string | null;
  lifecyclePolicy?: RoomLifecyclePolicy;
  normalizedReadyIds: (room: ProtocolV2Room) => string[];
  notifyAwayPlayersAfterMove: (room: ProtocolV2Room, player: RoomPlayer, state: GameState) => unknown;
  now: () => number;
  persistRoomsSoon: () => unknown;
  random: RandomSource;
  randomUuid: () => string;
  recordCompletedGame: (input: ProtocolV2CompletedGameInput) => ProtocolV2RecordedGame;
  reportCompletedGameError: (error: unknown) => unknown;
  roomPlayer: (socket: ProtocolV2Socket) => ProtocolV2RoomPlayer | null;
  rooms: Map<string, ProtocolV2Room>;
  resetAliasIndex?: ProtocolV2ResetAliasIndex;
  sendJson: (socket: ProtocolV2Socket, payload: unknown) => unknown;
  sendRoomSnapshot: (
    socket: ProtocolV2Socket,
    room: ProtocolV2Room,
    options?: { type?: 'snapshot' | 'resync'; commandId?: string; reason?: string }
  ) => unknown;
  setPlayerReadyForNextRound: (room: ProtocolV2Room, playerId: string, ready: boolean) => unknown;
  syncPlayerPresence: (room: ProtocolV2Room, player: RoomPlayer, now?: number) => unknown;
}

export interface AutomatedActionFence {
  commandId: string;
  expectedRevision: number;
  playerId: string;
  roomCode: string;
}

export interface ProtocolV2MessageHandler {
  (socket: ProtocolV2Socket, message: RealtimeClientMessage): void;
  executeAutomatedAction(fence: AutomatedActionFence): boolean;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function commandError(
  sendJson: ProtocolV2HandlerOptions['sendJson'],
  ws: ProtocolV2Socket,
  message: string,
  commandId?: string,
  code = 'invalid-command'
): void {
  sendJson(ws, {
    type: 'error',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    code,
    message,
    ...(commandId ? { commandId } : {})
  });
}

function isGameplayAction(action: GameCommand): boolean {
  return [
    'reveal-opening-card',
    'choose-discard',
    'cancel-discard',
    'draw-blind',
    'replace-card',
    'discard-and-reveal'
  ].includes(action.type);
}

export function rebuildResetAliasIndex(
  index: ProtocolV2ResetAliasIndex,
  rooms: Map<string, ProtocolV2Room>
): ProtocolV2ResetAliasIndex {
  index.clear();
  for (const room of rooms.values()) {
    for (const alias of room.resetAliases) {
      const entries = index.get(alias.fromCode) || [];
      entries.push({ alias, targetCode: room.code });
      index.set(alias.fromCode, entries);
    }
  }
  return index;
}

export function createResetAliasIndex(rooms: Map<string, ProtocolV2Room>): ProtocolV2ResetAliasIndex {
  return rebuildResetAliasIndex(new Map(), rooms);
}

export function isResetAliasCodeReserved(
  index: ProtocolV2ResetAliasIndex,
  code: string,
  timestamp: number
): boolean {
  return (index.get(code) || []).some(({ alias }) => alias.expiresAt > timestamp);
}

export function createProtocolV2MessageHandler(options: ProtocolV2HandlerOptions) {
  const {
    allPlayersReadyForNextRound,
    appendRoomChatMessage,
    broadcastRoom,
    cleanChatText,
    createInitialRoomState,
    createNextRoundRoomState,
    createWaitingRoom,
    digestAction,
    makeRoomCodeForSocket,
    lifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY,
    normalizedReadyIds,
    notifyAwayPlayersAfterMove,
    now,
    persistRoomsSoon,
    random,
    randomUuid,
    recordCompletedGame,
    reportCompletedGameError,
    roomPlayer,
    rooms,
    resetAliasIndex = createResetAliasIndex(rooms),
    sendJson,
    sendRoomSnapshot,
    setPlayerReadyForNextRound,
    syncPlayerPresence
  } = options;

  function sendUpgradeRequired(ws: ProtocolV2Socket, commandId?: string): void {
    sendJson(ws, {
      type: 'upgrade-required',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      message: 'Refresh Skyjo to use multiplayer protocol 2.',
      ...(commandId ? { commandId } : {})
    });
  }

  function acknowledge(ws: ProtocolV2Socket, receipt: CommandReceipt): void {
    sendJson(ws, {
      type: 'ack',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      commandId: receipt.commandId,
      revision: receipt.revision
    });
  }

  function commitReceipt(room: ProtocolV2Room, receipt: CommandReceipt, timestamp: number): void {
    const liveAliases = room.resetAliases.filter((alias) => alias.expiresAt > timestamp);
    const aliasesPruned = liveAliases.length !== room.resetAliases.length;
    room.resetAliases = liveAliases;
    room.recentCommandIds = retainCommandReceiptsForResetAliases(
      [...room.recentCommandIds, receipt],
      liveAliases
    );
    if (aliasesPruned) rebuildResetAliasIndex(resetAliasIndex, rooms);
  }

  function detachSeatSockets(
    room: ProtocolV2Room,
    playerId: string,
    options: { except?: ProtocolV2Socket; notify?: boolean } = {}
  ): void {
    for (const client of [...room.clients]) {
      if (client.playerId !== playerId || client === options.except) continue;
      if (options.notify !== false) {
        commandError(
          sendJson,
          client as ProtocolV2Socket,
          'This room seat was removed.',
          undefined,
          'seat-removed'
        );
      }
      detachRealtimeSocket(room, client);
    }
  }

  function applyRemovedPlayerReferences(room: ProtocolV2Room, playerId: string): void {
    const next = removePlayerReferences(room, playerId);
    room.players = next.players;
    room.chatMessages = next.chatMessages;
    room.readyForNextRoundPlayerIds = next.readyForNextRoundPlayerIds;
    room.recentCommandIds = next.recentCommandIds;
    room.resetAliases = next.resetAliases;
    rebuildResetAliasIndex(resetAliasIndex, rooms);
  }

  function commitGameplayState(input: {
    automated: boolean;
    commandId: string;
    nextState: GameState;
    player: RoomPlayer;
    receipt: CommandReceipt;
    room: ProtocolV2Room;
    timestamp: number;
    ws?: ProtocolV2Socket;
  }): boolean {
    const { automated, commandId, player, receipt, room, timestamp, ws } = input;
    let committedState = input.nextState;
    let recoveredCompletion = false;
    const finishedByAi = committedState.phase === 'game-over' &&
      room.players.some((roomPlayerValue) => roomPlayerValue.controller === 'ai');
    if (committedState.phase === 'game-over' && !room.completedGameId) {
      const gameSessionId = room.gameSessionId;
      if (!gameSessionId) {
        reportCompletedGameError(new Error(`Room ${room.code} is missing a game session id.`));
        if (ws) commandError(sendJson, ws, 'Could not save the completed game history.', commandId, 'history-save-failed');
        return false;
      }
      try {
        const playerAccounts = Object.fromEntries(
          room.players.map((roomPlayerValue) => [roomPlayerValue.id, roomPlayerValue.userId || null])
        );
        const game = recordCompletedGame({
          mode: 'multi',
          state: committedState,
          roomCode: room.code,
          createdByUserId: player.userId || null,
          playerAccounts,
          sourceKey: `multi:${gameSessionId}`,
          finishedByAi
        });
        const committedPlayerIds = game.state.players.map((committedPlayer) => committedPlayer.id);
        const roomPlayerIds = room.players.map((roomPlayerValue) => roomPlayerValue.id);
        if (
          game.state.phase !== 'game-over' ||
          committedPlayerIds.length !== roomPlayerIds.length ||
          committedPlayerIds.some((playerId, index) => playerId !== roomPlayerIds[index])
        ) {
          throw new Error('Completed game journal state does not match the room roster.');
        }
        recoveredCompletion = game.recovered;
        committedState = game.state;
        room.completedGameId = game.id;
        if (game.recovered && typeof game.finishedByAi === 'boolean' && game.finishedByAi !== finishedByAi) {
          throw new Error('Completed game journal AI attribution does not match the room controller state.');
        }
      } catch (error) {
        reportCompletedGameError(error);
        if (ws) commandError(sendJson, ws, 'Could not save the completed game history.', commandId, 'history-save-failed');
        return false;
      }
    }

    room.state = committedState;
    room.readyForNextRoundPlayerIds =
      committedState.phase === 'round-over' || committedState.phase === 'game-over'
        ? room.players.filter((roomPlayerValue) => roomPlayerValue.controller === 'ai').map((roomPlayerValue) => roomPlayerValue.id)
        : normalizedReadyIds(room);
    room.status = committedState.phase === 'game-over' ? 'finished' : 'playing';
    room.finishedByAi = committedState.phase === 'game-over' ? finishedByAi : false;
    room.revision = receipt.revision;
    room.updatedAt = timestamp;
    if (!automated) player.lastSeenAt = timestamp;
    if (!recoveredCompletion) commitReceipt(room, receipt, timestamp);
    persistRoomsSoon();
    broadcastRoom(room);
    if (recoveredCompletion && ws) {
      sendRoomSnapshot(ws, room, {
        type: 'resync',
        commandId,
        reason: 'completion-recovered'
      });
    } else if (ws) {
      acknowledge(ws, receipt);
    }
    if (!recoveredCompletion) notifyAwayPlayersAfterMove(room, player, committedState);
    return true;
  }

  function handleMessage(ws: ProtocolV2Socket, message: RealtimeClientMessage): void {
    if (message.type === 'update-state') {
      sendUpgradeRequired(ws);
      return;
    }

    if (message.type === 'create-room' || message.type === 'join-room') {
      if (message.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
        sendUpgradeRequired(ws);
        return;
      }
      const isCreate = message.type === 'create-room';
      const hasPlayerId = typeof message.playerId === 'string';
      const hasRecoveryCommandId = typeof message.recoveryCommandId === 'string';
      const hasPresenceVersion = Object.prototype.hasOwnProperty.call(message, 'presenceVersion');
      const hasSnapshotEnvelopeVersion = Object.prototype.hasOwnProperty.call(message, 'snapshotEnvelopeVersion');
      const validEnvelopeKeys = isCreate
        ? hasExactKeys(message, [
            'type',
            'protocolVersion',
            'name',
            ...(hasSnapshotEnvelopeVersion ? ['snapshotEnvelopeVersion'] : [])
          ])
        : hasExactKeys(
            message,
            hasPlayerId
              ? [
                  'type',
                  'protocolVersion',
                  'code',
                  'name',
                  'playerId',
                  ...(hasPresenceVersion ? ['presenceVersion'] : []),
                  ...(hasSnapshotEnvelopeVersion ? ['snapshotEnvelopeVersion'] : []),
                  ...(hasRecoveryCommandId ? ['recoveryCommandId'] : [])
                ]
              : [
                  'type',
                  'protocolVersion',
                  'code',
                  'name',
                  ...(hasPresenceVersion ? ['presenceVersion'] : []),
                  ...(hasSnapshotEnvelopeVersion ? ['snapshotEnvelopeVersion'] : [])
                ]
            );
      const validKeys = validEnvelopeKeys &&
        (!hasRecoveryCommandId || hasPlayerId) &&
        (!hasPresenceVersion || message.presenceVersion === EXPLICIT_PRESENCE_VERSION) &&
        (!hasSnapshotEnvelopeVersion ||
          message.snapshotEnvelopeVersion === SHARED_SNAPSHOT_ENVELOPE_VERSION);
      if (!validKeys) {
        commandError(sendJson, ws, 'Invalid room request.');
        return;
      }
      if (ws.admittedRoomCode) {
        commandError(sendJson, ws, 'This connection already belongs to a room.', undefined, 'already-in-room');
        return;
      }

      const accountUser = ws.accountUser as ProtocolV2AccountUser;
      if (isCreate) {
        const code = makeRoomCodeForSocket(ws);
        if (!code) {
          commandError(
            sendJson,
            ws,
            'A room code could not be created. Try again.',
            undefined,
            'room-code-unavailable'
          );
          return;
        }
        const playerId = randomUuid();
        const room = createWaitingRoom({
          code,
          hostPlayer: { id: playerId, userId: accountUser.id, name: accountUser.displayName },
          ws
        });
        rooms.set(code, room);
        ws.roomCode = code;
        ws.playerId = playerId;
        ws.admittedRoomCode = code;
        ws.snapshotEnvelopeVersion = hasSnapshotEnvelopeVersion
          ? SHARED_SNAPSHOT_ENVELOPE_VERSION
          : null;
        persistRoomsSoon();
        sendRoomSnapshot(ws, room);
        return;
      }

      const code = String(message.code || '').trim().toUpperCase();
      const requestedPlayerId = typeof message.playerId === 'string' ? message.playerId : '';
      const recoveryCommandId = typeof message.recoveryCommandId === 'string' ? message.recoveryCommandId : '';
      let room = recoveryCommandId ? null : rooms.get(code) || null;
      let resetRecoveryReceipt: CommandReceipt | null = null;
      const aliasEntries = resetAliasIndex.get(code) || [];
      if (recoveryCommandId || (!room && aliasEntries.length > 0)) {
        const resetDigest = digestAction(JSON.stringify({ type: 'reset-room' }));
        const matches = aliasEntries.flatMap(({ alias, targetCode }) => {
          if (
            alias.expiresAt <= now() ||
            alias.commandId !== recoveryCommandId ||
            alias.playerId !== requestedPlayerId
          ) return [];
          const target = rooms.get(targetCode);
          const targetPlayer = target?.players.find((item) => item.id === alias.playerId);
          const targetReceipt = target?.recentCommandIds.find((item) => item.commandId === alias.commandId);
          if (
            !target ||
            !targetPlayer ||
            targetPlayer.userId !== accountUser.id ||
            !targetReceipt ||
            targetReceipt.playerId !== alias.playerId ||
            targetReceipt.actionDigest !== resetDigest ||
            !Number.isSafeInteger(targetReceipt.expectedRevision) ||
            !Number.isSafeInteger(targetReceipt.revision) ||
            targetReceipt.revision !== targetReceipt.expectedRevision + 1 ||
            targetReceipt.revision > target.revision
          ) return [];
          return [{ room: target, receipt: targetReceipt }];
        });
        if (matches.length === 1) {
          room = matches[0].room;
          resetRecoveryReceipt = matches[0].receipt;
        } else {
          commandError(sendJson, ws, 'That saved room is no longer available.', undefined, 'stale-room');
          return;
        }
      }
      if (!room) {
        commandError(
          sendJson,
          ws,
          requestedPlayerId || recoveryCommandId ? 'That saved room is no longer available.' : 'Room not found.',
          undefined,
          requestedPlayerId || recoveryCommandId ? 'stale-room' : 'room-not-found'
        );
        return;
      }
      let player = requestedPlayerId ? room.players.find((item) => item.id === requestedPlayerId) : null;
      if (player?.userId && player.userId !== accountUser.id) {
        commandError(sendJson, ws, 'That saved room seat belongs to another account.', undefined, 'seat-forbidden');
        return;
      }
      if (!player) player = room.players.find((item) => item.userId === accountUser.id) || null;
      if (requestedPlayerId && !player) {
        commandError(sendJson, ws, 'That saved room seat is no longer available.', undefined, 'stale-seat');
        return;
      }
      if (room.status !== 'waiting' && !player) {
        commandError(sendJson, ws, 'That game has already started.', undefined, 'game-started');
        return;
      }
      const timestamp = now();
      let createdPlayer = false;
      if (!player) {
        if (room.players.length >= 8) {
          commandError(sendJson, ws, 'Room is full.', undefined, 'room-full');
          return;
        }
        if (room.revision >= Number.MAX_SAFE_INTEGER) {
          commandError(sendJson, ws, 'The room revision limit was reached.', undefined, 'revision-exhausted');
          return;
        }
        player = {
          id: randomUuid(),
          userId: accountUser.id,
          name: accountUser.displayName,
          connected: true,
          host: false,
          joinedAt: timestamp,
          lastSeenAt: timestamp,
          controller: 'human'
        };
        room.players.push(player);
        createdPlayer = true;
      }
      const wasPubliclyConnected = player.connected;
      const publicNameChanged = player.name !== accountUser.displayName;
      player.userId = player.userId || accountUser.id;
      player.name = accountUser.displayName;
      player.joinedAt = Number.isFinite(player.joinedAt) ? player.joinedAt : timestamp;
      player.lastSeenAt = timestamp;
      player.controller = player.controller || 'human';
      room.readyForNextRoundPlayerIds = normalizedReadyIds(room);
      ws.roomCode = room.code;
      ws.playerId = player.id;
      ws.admittedRoomCode = room.code;
      ws.snapshotEnvelopeVersion = hasSnapshotEnvelopeVersion
        ? SHARED_SNAPSHOT_ENVELOPE_VERSION
        : null;
      room.clients.add(ws);
      syncPlayerPresence(room, player, timestamp);
      const publicConnectionChanged = player.connected !== wasPubliclyConnected;
      if (createdPlayer) {
        room.revision += 1;
      }
      if (resetRecoveryReceipt) {
        room.updatedAt = timestamp;
        persistRoomsSoon();
        sendRoomSnapshot(ws, room, {
          type: 'resync',
          commandId: resetRecoveryReceipt.commandId,
          reason: 'room-reset'
        });
        acknowledge(ws, resetRecoveryReceipt);
        if (publicConnectionChanged || publicNameChanged) broadcastRoom(room);
      } else if (createdPlayer || publicConnectionChanged || publicNameChanged) {
        room.updatedAt = timestamp;
        persistRoomsSoon();
        broadcastRoom(room);
      } else {
        persistRoomsSoon();
        sendRoomSnapshot(ws, room);
      }
      return;
    }

    const parsed = parseClientCommand(message);
    if (!parsed.ok) {
      if (parsed.kind === 'upgrade-required') sendUpgradeRequired(ws, parsed.commandId);
      else commandError(sendJson, ws, parsed.message, parsed.commandId);
      return;
    }

    const context = roomPlayer(ws);
    if (!context) {
      commandError(sendJson, ws, 'Join or create a room first.', parsed.command.commandId, 'room-required');
      return;
    }
    const { room, player } = context;
    const command = parsed.command;
    const actionDigest = digestAction(parsed.canonicalAction);
    const priorReceipt = room.recentCommandIds.find((receipt) => receipt.commandId === command.commandId);
    if (priorReceipt) {
      const exactReplay =
        priorReceipt.playerId === player.id &&
        priorReceipt.expectedRevision === command.expectedRevision &&
        priorReceipt.actionDigest === actionDigest;
      if (!exactReplay) {
        commandError(sendJson, ws, 'That command id was already used for a different command.', command.commandId, 'command-id-conflict');
        return;
      }
      sendRoomSnapshot(ws, room);
      acknowledge(ws, priorReceipt);
      return;
    }
    if (player.controller === 'ai') {
      commandError(sendJson, ws, 'AI control is still completing an action for this seat.', command.commandId, 'ai-controls-seat');
      return;
    }
    if (!player.connected) {
      commandError(sendJson, ws, 'Return to the active room before sending an action.', command.commandId, 'player-away');
      return;
    }

    if (command.expectedRevision !== room.revision) {
      sendRoomSnapshot(ws, room, {
        type: 'resync',
        commandId: command.commandId,
        reason: command.expectedRevision < room.revision ? 'stale-revision' : 'future-revision'
      });
      return;
    }

    if (room.revision >= Number.MAX_SAFE_INTEGER) {
      commandError(sendJson, ws, 'The room revision limit was reached.', command.commandId, 'revision-exhausted');
      return;
    }
    const timestamp = now();
    const nextRevision = room.revision + 1;
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      playerId: player.id,
      expectedRevision: command.expectedRevision,
      revision: nextRevision,
      actionDigest
    };

    if (isGameplayAction(command.action)) {
      if (room.status !== 'playing') {
        commandError(sendJson, ws, 'No active game.', command.commandId, 'no-active-game');
        return;
      }
      const reduction = reduceAuthoritativeGameCommand(room.state, player.id, command.action, random);
      if (!reduction.ok) {
        commandError(sendJson, ws, reduction.message, command.commandId, 'illegal-move');
        return;
      }
      commitGameplayState({
        automated: false,
        commandId: command.commandId,
        nextState: reduction.state,
        player,
        receipt,
        room,
        timestamp,
        ws
      });
      return;
    }

    if (command.action.type === 'leave-room') {
      if (room.status !== 'waiting') {
        commandError(sendJson, ws, 'Active game seats remain reserved for reconnecting players.', command.commandId, 'active-seat-reserved');
        return;
      }
      const replacementHost = player.id === room.hostId
        ? oldestConnectedHuman(room.players, player.id)
        : null;
      if (player.id === room.hostId && room.players.length > 1 && !replacementHost) {
        commandError(sendJson, ws, 'The host cannot leave until another player is connected.', command.commandId, 'host-transfer-unavailable');
        return;
      }
      detachSeatSockets(room, player.id, { except: ws });
      detachRealtimeSocket(room, ws);
      applyRemovedPlayerReferences(room, player.id);
      room.revision = nextRevision;
      room.updatedAt = timestamp;
      if (room.players.length === 0) {
        rooms.delete(room.code);
        rebuildResetAliasIndex(resetAliasIndex, rooms);
      } else if (replacementHost) {
        room.hostId = replacementHost.id;
        room.players = hostFlags(room.players, replacementHost.id);
      }
      persistRoomsSoon();
      if (room.players.length > 0) broadcastRoom(room);
      sendJson(ws, {
        type: 'ack',
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        commandId: command.commandId,
        revision: nextRevision,
        result: 'room-left'
      });
      return;
    }

    if (command.action.type === 'remove-player') {
      if (room.status !== 'waiting') {
        commandError(sendJson, ws, 'Players can only be removed before the game starts.', command.commandId, 'waiting-room-required');
        return;
      }
      if (player.id !== room.hostId) {
        commandError(sendJson, ws, 'Only the host can remove a player.', command.commandId, 'host-required');
        return;
      }
      const targetPlayerId = command.action.playerId;
      const target = room.players.find((candidate) => candidate.id === targetPlayerId);
      if (!target || target.id === room.hostId) {
        commandError(sendJson, ws, 'Choose a non-host room player.', command.commandId, 'invalid-player');
        return;
      }
      detachSeatSockets(room, target.id);
      applyRemovedPlayerReferences(room, target.id);
    } else if (command.action.type === 'takeover-player-with-ai') {
      if (room.status === 'waiting') {
        commandError(sendJson, ws, 'AI takeover is only available after the game starts.', command.commandId, 'active-game-required');
        return;
      }
      if (player.id !== room.hostId) {
        commandError(sendJson, ws, 'Only the host can hand a seat to AI.', command.commandId, 'host-required');
        return;
      }
      const targetPlayerId = command.action.playerId;
      const target = room.players.find((candidate) => candidate.id === targetPlayerId);
      if (!target || !canTakeOverWithAi(room, target, timestamp, lifecyclePolicy)) {
        commandError(sendJson, ws, 'That seat is not eligible for AI takeover yet.', command.commandId, 'takeover-unavailable');
        return;
      }
      target.controller = 'ai';
      if (room.state?.phase === 'round-over' || room.state?.phase === 'game-over') {
        setPlayerReadyForNextRound(room, target.id, true);
      }
    } else if (command.action.type === 'send-chat-message') {
      const text = cleanChatText(command.action.text);
      if (!text) {
        commandError(sendJson, ws, 'Enter a message before sending.', command.commandId, 'empty-chat');
        return;
      }
      appendRoomChatMessage(room, player, text);
    } else if (command.action.type === 'set-next-round-ready') {
      if (room.state?.phase !== 'round-over' && room.state?.phase !== 'game-over') {
        commandError(sendJson, ws, 'The round is not ready for confirmation.', command.commandId, 'not-scoring');
        return;
      }
      const wasReady = normalizedReadyIds(room).includes(player.id);
      if (wasReady === command.action.ready) {
        commandError(sendJson, ws, 'That readiness is already set.', command.commandId, 'unchanged-command');
        return;
      }
      setPlayerReadyForNextRound(room, player.id, command.action.ready);
    } else if (command.action.type === 'start-game') {
      if (player.id !== room.hostId) {
        commandError(sendJson, ws, 'Only the host can start the game.', command.commandId, 'host-required');
        return;
      }
      if (room.status === 'waiting') {
        const connectedPlayerIds = new Set(connectedWaitingPlayerIds(room));
        if (connectedPlayerIds.size < 2) {
          commandError(sendJson, ws, 'Need at least two connected players.', command.commandId, 'players-required');
          return;
        }
        for (const disconnectedPlayer of room.players.filter((candidate) => !connectedPlayerIds.has(candidate.id))) {
          detachSeatSockets(room, disconnectedPlayer.id);
          applyRemovedPlayerReferences(room, disconnectedPlayer.id);
        }
        room.players = hostFlags(room.players, room.hostId);
        room.state = createInitialRoomState(room.players, random);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = randomUuid();
        room.finishedByAi = false;
      } else if (room.state?.phase === 'round-over') {
        if (!allPlayersReadyForNextRound(room)) {
          commandError(sendJson, ws, 'Everyone must confirm they are ready before the next round starts.', command.commandId, 'players-not-ready');
          return;
        }
        room.state = createNextRoundRoomState(room.state, random);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
      } else if (room.state?.phase === 'game-over' || room.status === 'finished') {
        if (room.state && !allPlayersReadyForNextRound(room)) {
          commandError(sendJson, ws, 'Everyone must confirm they are ready before the game restarts.', command.commandId, 'players-not-ready');
          return;
        }
        room.state = createInitialRoomState(room.players, random);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = randomUuid();
        room.finishedByAi = false;
      } else {
        commandError(sendJson, ws, 'The current game is not ready for a new round.', command.commandId, 'invalid-phase');
        return;
      }
    } else if (command.action.type === 'reset-room') {
      if (player.id !== room.hostId) {
        commandError(sendJson, ws, 'Only the host can reset the room.', command.commandId, 'host-required');
        return;
      }
      const oldRoom = room;
      const newCode = makeRoomCodeForSocket(ws);
      if (!newCode) {
        commandError(
          sendJson,
          ws,
          'A room code could not be created. Try again.',
          command.commandId,
          'room-code-unavailable'
        );
        return;
      }
      const newRoom = createWaitingRoom({ code: newCode, hostPlayer: player, ws });
      newRoom.revision = nextRevision;
      const inheritedAliases = oldRoom.resetAliases
        .filter((alias) => alias.expiresAt > timestamp)
        .slice(-(MAX_RESET_ALIASES - 1));
      const inheritedCommandIds = new Set(inheritedAliases.map((alias) => alias.commandId));
      newRoom.recentCommandIds = oldRoom.recentCommandIds.filter((prior) =>
        inheritedCommandIds.has(prior.commandId)
      );
      newRoom.resetAliases = [
        ...inheritedAliases,
        {
          fromCode: oldRoom.code,
          commandId: command.commandId,
          playerId: player.id,
          expiresAt: timestamp + RESET_ALIAS_TTL_MS
        }
      ];
      commitReceipt(newRoom, receipt, timestamp);
      for (const client of [...oldRoom.clients]) {
        if (client === ws) continue;
        sendJson(client as ProtocolV2Socket, {
          type: 'error',
          protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
          code: 'room-reset',
          message: 'The host reset this room. Ask for the new room link to rejoin.'
        });
        detachRealtimeSocket(oldRoom, client);
      }
      rooms.delete(oldRoom.code);
      rooms.set(newCode, newRoom);
      rebuildResetAliasIndex(resetAliasIndex, rooms);
      ws.roomCode = newCode;
      ws.playerId = player.id;
      ws.admittedRoomCode = newCode;
      persistRoomsSoon();
      sendRoomSnapshot(ws, newRoom, {
        type: 'resync',
        commandId: command.commandId,
        reason: 'room-reset'
      });
      acknowledge(ws, receipt);
      return;
    } else {
      commandError(sendJson, ws, 'Invalid command action.', command.commandId);
      return;
    }

    room.revision = nextRevision;
    room.updatedAt = timestamp;
    player.lastSeenAt = timestamp;
    commitReceipt(room, receipt, timestamp);
    persistRoomsSoon();
    broadcastRoom(room);
    acknowledge(ws, receipt);
  }

  function executeAutomatedAction(fence: AutomatedActionFence): boolean {
    const room = rooms.get(fence.roomCode);
    if (!room || room.revision !== fence.expectedRevision || room.revision >= Number.MAX_SAFE_INTEGER) return false;
    const player = room.players.find((candidate) => candidate.id === fence.playerId);
    if (!player || player.controller !== 'ai') return false;
    const timestamp = now();
    const receipt: CommandReceipt = {
      commandId: fence.commandId,
      playerId: player.id,
      expectedRevision: fence.expectedRevision,
      revision: fence.expectedRevision + 1,
      actionDigest: digestAction(JSON.stringify({ type: 'server-ai-action' }))
    };

    if (shouldAutoReady(room, player)) {
      for (const aiPlayer of room.players.filter((candidate) => candidate.controller === 'ai')) {
        setPlayerReadyForNextRound(room, aiPlayer.id, true);
      }
      room.revision = receipt.revision;
      room.updatedAt = timestamp;
      commitReceipt(room, receipt, timestamp);
      persistRoomsSoon();
      broadcastRoom(room);
      return true;
    }
    if (!shouldRunAiAction(room, player)) return false;
    const reduction = reduceAuthoritativeAiAction(room.state, player.id, random);
    if (!reduction.ok) return false;
    return commitGameplayState({
      automated: true,
      commandId: fence.commandId,
      nextState: reduction.state,
      player,
      receipt,
      room,
      timestamp
    });
  }

  return Object.assign(handleMessage, { executeAutomatedAction }) satisfies ProtocolV2MessageHandler;
}
