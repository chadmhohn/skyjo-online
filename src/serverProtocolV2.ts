import {
  MAX_RECENT_COMMAND_RECEIPTS,
  MULTIPLAYER_PROTOCOL_VERSION,
  parseClientCommand,
  reduceAuthoritativeGameCommand,
  type CommandReceipt,
  type GameCommand
} from './protocolV2.js';
import type { RandomSource } from './runtime.js';
import type { RealtimeClientMessage, RealtimeSocket } from './serverRealtime';
import type { GameState, RoomChatMessage, RoomPlayer } from './types';

export interface ProtocolV2AccountUser {
  displayName: string;
  id: string;
}

export interface ProtocolV2Socket extends RealtimeSocket {
  accountUser?: ProtocolV2AccountUser;
}

export interface ProtocolV2Room {
  chatMessages: RoomChatMessage[];
  clients: Set<RealtimeSocket>;
  code: string;
  completedGameId: string | null;
  gameSessionId: string | null;
  hostId: string;
  players: RoomPlayer[];
  readyForNextRoundPlayerIds: string[];
  recentCommandIds: CommandReceipt[];
  revision: number;
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
  normalizedReadyIds: (room: ProtocolV2Room) => string[];
  notifyAwayPlayersAfterMove: (room: ProtocolV2Room, player: RoomPlayer, state: GameState) => unknown;
  now: () => number;
  persistRoomsSoon: () => unknown;
  random: RandomSource;
  randomUuid: () => string;
  recordCompletedGame: (input: ProtocolV2CompletedGameInput) => { id: string };
  reportCompletedGameError: (error: unknown) => unknown;
  roomPlayer: (socket: ProtocolV2Socket) => ProtocolV2RoomPlayer | null;
  rooms: Map<string, ProtocolV2Room>;
  sendJson: (socket: ProtocolV2Socket, payload: unknown) => unknown;
  sendRoomSnapshot: (
    socket: ProtocolV2Socket,
    room: ProtocolV2Room,
    options?: { type?: 'snapshot' | 'resync'; commandId?: string; reason?: string }
  ) => unknown;
  setPlayerReadyForNextRound: (room: ProtocolV2Room, playerId: string, ready: boolean) => unknown;
  syncPlayerPresence: (room: ProtocolV2Room, player: RoomPlayer) => unknown;
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

  function commitReceipt(room: ProtocolV2Room, receipt: CommandReceipt): void {
    room.recentCommandIds = [...room.recentCommandIds, receipt].slice(-MAX_RECENT_COMMAND_RECEIPTS);
  }

  return (ws: ProtocolV2Socket, message: RealtimeClientMessage): void => {
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
      const validKeys = isCreate
        ? hasExactKeys(message, ['type', 'protocolVersion', 'name'])
        : hasExactKeys(
            message,
            typeof message.playerId === 'string'
              ? ['type', 'protocolVersion', 'code', 'name', 'playerId']
              : ['type', 'protocolVersion', 'code', 'name']
          );
      if (!validKeys) {
        commandError(sendJson, ws, 'Invalid room request.');
        return;
      }

      const accountUser = ws.accountUser as ProtocolV2AccountUser;
      if (isCreate) {
        const code = makeRoomCodeForSocket(ws);
        if (!code) return;
        const playerId = randomUuid();
        const room = createWaitingRoom({
          code,
          hostPlayer: { id: playerId, userId: accountUser.id, name: accountUser.displayName },
          ws
        });
        rooms.set(code, room);
        ws.roomCode = code;
        ws.playerId = playerId;
        persistRoomsSoon();
        sendRoomSnapshot(ws, room);
        return;
      }

      const code = String(message.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        commandError(sendJson, ws, 'Room not found.', undefined, 'room-not-found');
        return;
      }
      const requestedPlayerId = typeof message.playerId === 'string' ? message.playerId : '';
      let player = requestedPlayerId ? room.players.find((item) => item.id === requestedPlayerId) : null;
      if (player?.userId && player.userId !== accountUser.id) {
        commandError(sendJson, ws, 'That saved room seat belongs to another account.', undefined, 'seat-forbidden');
        return;
      }
      if (!player) player = room.players.find((item) => item.userId === accountUser.id) || null;
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
      const publicConnectionChanged = !player.connected;
      const publicNameChanged = player.name !== accountUser.displayName;
      player.userId = player.userId || accountUser.id;
      player.name = accountUser.displayName;
      player.joinedAt = Number.isFinite(player.joinedAt) ? player.joinedAt : timestamp;
      player.lastSeenAt = timestamp;
      player.controller = player.controller || 'human';
      room.readyForNextRoundPlayerIds = normalizedReadyIds(room);
      ws.visible = true;
      ws.roomCode = code;
      ws.playerId = player.id;
      room.clients.add(ws);
      syncPlayerPresence(room, player);
      if (createdPlayer) {
        room.revision += 1;
      }
      if (createdPlayer || publicConnectionChanged || publicNameChanged) {
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
      if (reduction.state.phase === 'game-over' && !room.completedGameId) {
        try {
          const playerAccounts = Object.fromEntries(
            room.players.map((roomPlayerValue) => [roomPlayerValue.id, roomPlayerValue.userId || null])
          );
          const game = recordCompletedGame({
            mode: 'multi',
            state: reduction.state,
            roomCode: room.code,
            createdByUserId: player.userId || null,
            playerAccounts,
            sourceKey: `multi:${room.gameSessionId || room.code}`
          });
          room.completedGameId = game.id;
        } catch (error) {
          reportCompletedGameError(error);
          commandError(sendJson, ws, 'Could not save the completed game history.', command.commandId, 'history-save-failed');
          return;
        }
      }
      room.state = reduction.state;
      room.readyForNextRoundPlayerIds =
        reduction.state.phase === 'round-over' || reduction.state.phase === 'game-over'
          ? []
          : normalizedReadyIds(room);
      room.status = reduction.state.phase === 'game-over' ? 'finished' : 'playing';
      room.revision = nextRevision;
      room.updatedAt = timestamp;
      player.lastSeenAt = timestamp;
      commitReceipt(room, receipt);
      persistRoomsSoon();
      broadcastRoom(room);
      acknowledge(ws, receipt);
      notifyAwayPlayersAfterMove(room, player, reduction.state);
      return;
    }

    if (command.action.type === 'send-chat-message') {
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
      if (!player.host) {
        commandError(sendJson, ws, 'Only the host can start the game.', command.commandId, 'host-required');
        return;
      }
      if (room.status === 'waiting') {
        if (room.players.length < 2) {
          commandError(sendJson, ws, 'Need at least two players.', command.commandId, 'players-required');
          return;
        }
        room.state = createInitialRoomState(room.players, random);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = randomUuid();
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
      } else {
        commandError(sendJson, ws, 'The current game is not ready for a new round.', command.commandId, 'invalid-phase');
        return;
      }
    } else if (command.action.type === 'reset-room') {
      if (!player.host) {
        commandError(sendJson, ws, 'Only the host can reset the room.', command.commandId, 'host-required');
        return;
      }
      const oldRoom = room;
      const newCode = makeRoomCodeForSocket(ws);
      if (!newCode) return;
      const newRoom = createWaitingRoom({ code: newCode, hostPlayer: player, ws });
      newRoom.revision = nextRevision;
      commitReceipt(newRoom, receipt);
      for (const client of oldRoom.clients) {
        if (client === ws) continue;
        sendJson(client as ProtocolV2Socket, {
          type: 'error',
          protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
          code: 'room-reset',
          message: 'The host reset this room. Ask for the new room link to rejoin.'
        });
        client.roomCode = null;
        client.playerId = null;
      }
      rooms.delete(oldRoom.code);
      rooms.set(newCode, newRoom);
      ws.roomCode = newCode;
      ws.playerId = player.id;
      persistRoomsSoon();
      sendRoomSnapshot(ws, newRoom);
      acknowledge(ws, receipt);
      return;
    } else {
      commandError(sendJson, ws, 'Invalid command action.', command.commandId);
      return;
    }

    room.revision = nextRevision;
    room.updatedAt = timestamp;
    player.lastSeenAt = timestamp;
    commitReceipt(room, receipt);
    persistRoomsSoon();
    broadcastRoom(room);
    acknowledge(ws, receipt);
  };
}
