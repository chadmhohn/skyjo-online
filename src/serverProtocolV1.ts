import type { GameState, RoomChatMessage, RoomPlayer } from './types';
import type { RealtimeClientMessage, RealtimeSocket } from './serverRealtime';

export interface ProtocolV1AccountUser {
  displayName: string;
  id: string;
}

export interface ProtocolV1Socket extends RealtimeSocket {
  accountUser?: ProtocolV1AccountUser;
}

export interface ProtocolV1Room {
  chatMessages: RoomChatMessage[];
  clients: Set<RealtimeSocket>;
  code: string;
  completedGameId: string | null;
  gameSessionId: string | null;
  hostId: string;
  players: RoomPlayer[];
  readyForNextRoundPlayerIds: string[];
  state: GameState | null;
  status: 'waiting' | 'playing' | 'finished';
  updatedAt: number;
}

export interface ProtocolV1RoomPlayer {
  player: RoomPlayer;
  room: ProtocolV1Room;
}

export interface ProtocolV1ValidationResult {
  message?: string;
  ok: boolean;
}

export interface ProtocolV1CompletedGameInput {
  createdByUserId: string | null;
  mode: 'multi';
  playerAccounts: Record<string, string | null>;
  roomCode: string;
  sourceKey: string;
  state: GameState;
}

export interface ProtocolV1HandlerOptions {
  allPlayersReadyForNextRound: (room: ProtocolV1Room) => boolean;
  appendRoomChatMessage: (room: ProtocolV1Room, player: RoomPlayer, text: string) => unknown;
  broadcastRoom: (room: ProtocolV1Room) => unknown;
  cleanChatText: (value: unknown) => string;
  createInitialRoomState: (players: RoomPlayer[]) => GameState;
  createNextRoundRoomState: (state: GameState) => GameState;
  createWaitingRoom: (input: {
    code: string;
    hostPlayer: Pick<RoomPlayer, 'id' | 'name' | 'userId'>;
    ws: ProtocolV1Socket;
  }) => ProtocolV1Room;
  makeRoomCodeForSocket: (socket: ProtocolV1Socket) => string | null;
  normalizedReadyIds: (room: ProtocolV1Room) => string[];
  notifyAwayPlayersAfterMove: (room: ProtocolV1Room, player: RoomPlayer, state: GameState) => unknown;
  now: () => number;
  persistRoomsSoon: () => unknown;
  publicRoom: (room: ProtocolV1Room) => unknown;
  randomUuid: () => string;
  recordCompletedGame: (input: ProtocolV1CompletedGameInput) => { id: string };
  roomPlayer: (socket: ProtocolV1Socket) => ProtocolV1RoomPlayer | null;
  rooms: Map<string, ProtocolV1Room>;
  sendJson: (socket: ProtocolV1Socket, payload: unknown) => unknown;
  setPlayerReadyForNextRound: (room: ProtocolV1Room, playerId: string, ready: boolean) => unknown;
  syncPlayerPresence: (room: ProtocolV1Room, player: RoomPlayer) => unknown;
  validateMultiplayerStateUpdate: (
    currentState: GameState,
    proposedState: GameState,
    playerId: string
  ) => ProtocolV1ValidationResult;
  reportCompletedGameError: (error: unknown) => unknown;
}

interface ProtocolV1Message extends RealtimeClientMessage {
  code?: unknown;
  playerId?: unknown;
  ready?: unknown;
  state?: GameState;
  text?: unknown;
  type?: unknown;
}

export function createProtocolV1MessageHandler(options: ProtocolV1HandlerOptions) {
  const {
    allPlayersReadyForNextRound,
    appendRoomChatMessage,
    broadcastRoom,
    cleanChatText,
    createInitialRoomState,
    createNextRoundRoomState,
    createWaitingRoom,
    makeRoomCodeForSocket,
    normalizedReadyIds,
    notifyAwayPlayersAfterMove,
    now,
    persistRoomsSoon,
    publicRoom,
    randomUuid,
    recordCompletedGame,
    roomPlayer,
    rooms,
    sendJson,
    setPlayerReadyForNextRound,
    syncPlayerPresence,
    validateMultiplayerStateUpdate,
    reportCompletedGameError
  } = options;

  return (ws: ProtocolV1Socket, message: ProtocolV1Message): void => {
    if (message.type === 'create-room') {
      const accountUser = ws.accountUser as ProtocolV1AccountUser;
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
      sendJson(ws, { type: 'joined', playerId, room: publicRoom(room) });
      broadcastRoom(room);
      return;
    }

    if (message.type === 'join-room') {
      const code = String(message.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendJson(ws, { type: 'error', message: 'Room not found.' });
        return;
      }
      const accountUser = ws.accountUser as ProtocolV1AccountUser;
      const requestedPlayerId = typeof message.playerId === 'string' ? message.playerId : '';
      let player = requestedPlayerId ? room.players.find((item) => item.id === requestedPlayerId) : null;
      if (player?.userId && player.userId !== accountUser.id) {
        sendJson(ws, { type: 'error', message: 'That saved room seat belongs to another account.' });
        return;
      }
      if (!player) player = room.players.find((item) => item.userId === accountUser.id) || null;
      if (room.status !== 'waiting' && !player) {
        sendJson(ws, { type: 'error', message: 'That game has already started.' });
        return;
      }
      const previousPlayer = player
        ? { connected: player.connected, name: player.name, userId: player.userId }
        : null;
      let createdPlayer = false;
      if (!player) {
        if (room.players.length >= 8) {
          sendJson(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        player = {
          id: randomUuid(),
          userId: accountUser.id,
          name: accountUser.displayName,
          connected: true,
          host: false
        };
        room.players.push(player);
        createdPlayer = true;
      }
      const previousReadyIds = [...room.readyForNextRoundPlayerIds];
      player.userId = player.userId || accountUser.id;
      player.name = accountUser.displayName;
      room.readyForNextRoundPlayerIds = normalizedReadyIds(room);
      ws.visible = true;
      ws.roomCode = code;
      ws.playerId = player.id;
      room.clients.add(ws);
      syncPlayerPresence(room, player);
      const publicRoomChanged =
        createdPlayer ||
        !previousPlayer ||
        previousPlayer.connected !== player.connected ||
        previousPlayer.name !== player.name ||
        previousPlayer.userId !== player.userId ||
        previousReadyIds.length !== room.readyForNextRoundPlayerIds.length ||
        previousReadyIds.join('\u0000') !== room.readyForNextRoundPlayerIds.join('\u0000');
      if (publicRoomChanged) {
        room.updatedAt = now();
        persistRoomsSoon();
      }
      sendJson(ws, { type: 'joined', playerId: player.id, room: publicRoom(room) });
      if (publicRoomChanged) broadcastRoom(room);
      return;
    }

    const context = roomPlayer(ws);
    if (!context) {
      sendJson(ws, { type: 'error', message: 'Join or create a room first.' });
      return;
    }
    const { room, player } = context;

    if (message.type === 'send-chat-message') {
      const text = cleanChatText(message.text);
      if (!text) {
        sendJson(ws, { type: 'error', message: 'Enter a message before sending.' });
        return;
      }
      appendRoomChatMessage(room, player, text);
      room.updatedAt = now();
      persistRoomsSoon();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'set-next-round-ready') {
      if (room.state?.phase !== 'round-over' && room.state?.phase !== 'game-over') {
        sendJson(ws, { type: 'error', message: 'The round is not ready for confirmation.' });
        return;
      }
      setPlayerReadyForNextRound(room, player.id, message.ready !== false);
      room.updatedAt = now();
      persistRoomsSoon();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'start-game') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can start the game.' });
        return;
      }
      if (room.status === 'waiting') {
        if (room.players.length < 2) {
          sendJson(ws, { type: 'error', message: 'Need at least two players.' });
          return;
        }
        room.state = createInitialRoomState(room.players);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = randomUuid();
        room.updatedAt = now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.state?.phase === 'round-over') {
        if (!allPlayersReadyForNextRound(room)) {
          sendJson(ws, {
            type: 'error',
            message: 'Everyone must confirm they are ready before the next round starts.'
          });
          return;
        }
        room.state = createNextRoundRoomState(room.state);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.updatedAt = now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.state?.phase === 'game-over' || room.status === 'finished') {
        if (room.state && !allPlayersReadyForNextRound(room)) {
          sendJson(ws, {
            type: 'error',
            message: 'Everyone must confirm they are ready before the game restarts.'
          });
          return;
        }
        room.state = createInitialRoomState(room.players);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = randomUuid();
        room.updatedAt = now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.players.length < 2) {
        sendJson(ws, { type: 'error', message: 'Need at least two players.' });
        return;
      }
      sendJson(ws, { type: 'error', message: 'The current game is not ready for a new round.' });
      return;
    }

    if (message.type === 'update-state') {
      if (!message.state || room.status !== 'playing') {
        sendJson(ws, { type: 'error', message: 'No active game.' });
        return;
      }
      const activePlayerId = room.state?.players?.[room.state.currentPlayerIndex]?.id;
      if (activePlayerId && activePlayerId !== player.id) {
        sendJson(ws, { type: 'error', message: 'It is not your turn.' });
        return;
      }
      const validation = validateMultiplayerStateUpdate(room.state as GameState, message.state, player.id);
      if (!validation.ok) {
        sendJson(ws, { type: 'error', message: validation.message || 'That move is not legal.' });
        return;
      }
      if (message.state.phase === 'game-over' && !room.completedGameId) {
        try {
          const playerAccounts = Object.fromEntries(
            room.players.map((roomPlayer) => [roomPlayer.id, roomPlayer.userId || null])
          );
          const game = recordCompletedGame({
            mode: 'multi',
            state: message.state,
            roomCode: room.code,
            createdByUserId: player.userId || null,
            playerAccounts,
            sourceKey: `multi:${room.gameSessionId || room.code}`
          });
          room.completedGameId = game.id;
        } catch (error) {
          reportCompletedGameError(error);
          sendJson(ws, { type: 'error', message: 'Could not save the completed game history.' });
          return;
        }
      }
      room.state = message.state;
      room.readyForNextRoundPlayerIds =
        message.state.phase === 'round-over' || message.state.phase === 'game-over' ? [] : normalizedReadyIds(room);
      room.status = message.state.phase === 'game-over' ? 'finished' : 'playing';
      room.updatedAt = now();
      persistRoomsSoon();
      broadcastRoom(room);
      notifyAwayPlayersAfterMove(room, player, message.state);
      return;
    }

    if (message.type === 'reset-room') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can reset the room.' });
        return;
      }
      const oldRoom = room;
      const newCode = makeRoomCodeForSocket(ws);
      if (!newCode) return;
      const newRoom = createWaitingRoom({ code: newCode, hostPlayer: player, ws });
      for (const client of oldRoom.clients) {
        if (client === ws) continue;
        sendJson(client as ProtocolV1Socket, {
          type: 'room-reset',
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
      sendJson(ws, { type: 'joined', playerId: player.id, room: publicRoom(newRoom) });
    }
  };
}
