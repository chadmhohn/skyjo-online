import { vi } from 'vitest';
import {
  createProtocolV1MessageHandler,
  type ProtocolV1HandlerOptions,
  type ProtocolV1Room,
  type ProtocolV1Socket
} from '../../../src/serverProtocolV1';
import type { GameState, Player, RoomPlayer, TurnPhase } from '../../../src/types';

class FakeSocket implements ProtocolV1Socket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  accountUser = { id: 'user-1', displayName: 'Ada' };
  playerId: string | null = null;
  roomCode: string | null = null;
  visible = true;
  on(): void {}
  send(): void {}
}

function roomPlayer(id: string, overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    id,
    userId: `user-${id}`,
    name: id,
    connected: true,
    host: false,
    ...overrides
  };
}

function gamePlayer(id: string): Player {
  return { id, name: id, kind: 'human', grid: [], totalScore: 0, roundScore: 0 };
}

function gameState(phase: TurnPhase = 'choose-source', activeId = 'seat-1'): GameState {
  return {
    players: [gamePlayer(activeId), gamePlayer('seat-2')],
    drawPile: [],
    discardPile: [],
    currentPlayerIndex: 0,
    phase,
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: {},
    roundHistory: []
  };
}

function makeRoom(overrides: Partial<ProtocolV1Room> = {}): ProtocolV1Room {
  return {
    chatMessages: [],
    clients: new Set(),
    code: 'ABCDE',
    completedGameId: null,
    gameSessionId: null,
    hostId: 'seat-1',
    players: [roomPlayer('seat-1', { userId: 'user-1', name: 'Ada', host: true }), roomPlayer('seat-2')],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: 1,
    ...overrides
  };
}

function createHarness() {
  const rooms = new Map<string, ProtocolV1Room>();
  const sent: Array<{ socket: ProtocolV1Socket; payload: unknown }> = [];
  let uuid = 0;
  const options: ProtocolV1HandlerOptions = {
    allPlayersReadyForNextRound: vi.fn(() => true),
    appendRoomChatMessage: vi.fn(),
    broadcastRoom: vi.fn(),
    cleanChatText: vi.fn((value) => String(value || '').trim()),
    createInitialRoomState: vi.fn(() => gameState('opening-reveal')),
    createNextRoundRoomState: vi.fn(() => ({ ...gameState('opening-reveal'), round: 2 })),
    createWaitingRoom: vi.fn(({ code, hostPlayer, ws }) =>
      makeRoom({
        code,
        hostId: hostPlayer.id,
        players: [{ ...hostPlayer, connected: true, host: true }],
        clients: new Set([ws])
      })
    ),
    makeRoomCodeForSocket: vi.fn(() => 'NEWCD'),
    normalizedReadyIds: vi.fn(() => ['seat-1']),
    notifyAwayPlayersAfterMove: vi.fn(),
    now: vi.fn(() => 4242),
    persistRoomsSoon: vi.fn(),
    publicRoom: vi.fn((room) => ({ code: room.code })),
    randomUuid: vi.fn(() => `uuid-${++uuid}`),
    recordCompletedGame: vi.fn(() => ({ id: 'game-1' })),
    roomPlayer: vi.fn((socket) => {
      const room = socket.roomCode ? rooms.get(socket.roomCode) : null;
      const player = room?.players.find((candidate) => candidate.id === socket.playerId);
      return room && player ? { room, player } : null;
    }),
    rooms,
    sendJson: vi.fn((socket, payload) => {
      sent.push({ socket, payload });
    }),
    setPlayerReadyForNextRound: vi.fn(),
    syncPlayerPresence: vi.fn(),
    validateMultiplayerStateUpdate: vi.fn(() => ({ ok: true })),
    reportCompletedGameError: vi.fn()
  };
  return { handler: createProtocolV1MessageHandler(options), options, rooms, sent };
}

function attach(harness: ReturnType<typeof createHarness>, room: ProtocolV1Room, socket = new FakeSocket(), playerId = 'seat-1') {
  harness.rooms.set(room.code, room);
  socket.roomCode = room.code;
  socket.playerId = playerId;
  room.clients.add(socket);
  return socket;
}

function lastPayload(harness: ReturnType<typeof createHarness>) {
  return harness.sent.at(-1)?.payload;
}

describe('protocol-v1 command handler', () => {
  it('creates a waiting room and fails closed when secure code allocation fails', () => {
    const harness = createHarness();
    const socket = new FakeSocket();

    harness.handler(socket, { type: 'create-room' });
    expect(socket.roomCode).toBe('NEWCD');
    expect(socket.playerId).toBe('uuid-1');
    expect(harness.rooms.get('NEWCD')?.players[0]).toMatchObject({ id: 'uuid-1', userId: 'user-1', name: 'Ada' });
    expect(lastPayload(harness)).toEqual({ type: 'joined', playerId: 'uuid-1', room: { code: 'NEWCD' } });
    expect(harness.options.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(harness.options.broadcastRoom).toHaveBeenCalledOnce();

    vi.mocked(harness.options.makeRoomCodeForSocket).mockReturnValueOnce(null);
    const rejected = new FakeSocket();
    harness.handler(rejected, { type: 'create-room' });
    expect(rejected.roomCode).toBeNull();
  });

  it('rejects missing, occupied, started, and full room joins', () => {
    const harness = createHarness();
    const socket = new FakeSocket();

    harness.handler(socket, { type: 'join-room', code: 'missing' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Room not found.' });

    const occupied = makeRoom({ players: [roomPlayer('saved', { userId: 'other-user' })] });
    harness.rooms.set(occupied.code, occupied);
    harness.handler(socket, { type: 'join-room', code: 'abcde', playerId: 'saved' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'That saved room seat belongs to another account.' });

    socket.accountUser = { id: 'new-user', displayName: 'New Player' };
    const started = makeRoom({ code: 'START', status: 'playing', state: gameState() });
    harness.rooms.set(started.code, started);
    harness.handler(socket, { type: 'join-room', code: 'start' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'That game has already started.' });

    const full = makeRoom({ code: 'FULLX', players: Array.from({ length: 8 }, (_, index) => roomPlayer(`p-${index}`)) });
    harness.rooms.set(full.code, full);
    harness.handler(socket, { type: 'join-room', code: 'fullx' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Room is full.' });
  });

  it('reclaims requested or account-owned seats and creates a new waiting seat', () => {
    const harness = createHarness();
    const existing = makeRoom({ players: [roomPlayer('saved', { userId: undefined, name: 'Old' })] });
    harness.rooms.set(existing.code, existing);
    const requested = new FakeSocket();
    requested.visible = false;
    harness.handler(requested, { type: 'join-room', code: ' abcde ', playerId: 'saved' });
    expect(existing.players[0]).toMatchObject({ userId: 'user-1', name: 'Ada' });
    expect(requested).toMatchObject({ roomCode: 'ABCDE', playerId: 'saved', visible: true });
    expect(existing.updatedAt).toBe(4242);

    const owned = makeRoom({ code: 'OWNED', players: [roomPlayer('owned-seat', { userId: 'user-1' })] });
    harness.rooms.set(owned.code, owned);
    const accountSocket = new FakeSocket();
    harness.handler(accountSocket, { type: 'join-room', code: 'owned', playerId: 42 });
    expect(accountSocket.playerId).toBe('owned-seat');

    const open = makeRoom({ code: 'OPENX', players: [] });
    harness.rooms.set(open.code, open);
    const newcomer = new FakeSocket();
    harness.handler(newcomer, { type: 'join-room', code: 'openx' });
    expect(open.players[0]).toMatchObject({ id: 'uuid-1', userId: 'user-1', connected: true, host: false });
    expect(harness.options.normalizedReadyIds).toHaveBeenCalled();
    expect(harness.options.syncPlayerPresence).toHaveBeenCalled();
  });

  it('rejects pre-join commands and handles empty and accepted chat messages', () => {
    const harness = createHarness();
    const socket = new FakeSocket();
    harness.handler(socket, { type: 'unknown' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Join or create a room first.' });

    const room = makeRoom();
    attach(harness, room, socket);
    harness.handler(socket, { type: 'send-chat-message', text: '   ' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Enter a message before sending.' });

    harness.handler(socket, { type: 'send-chat-message', text: ' hello ' });
    expect(harness.options.appendRoomChatMessage).toHaveBeenCalledWith(room, room.players[0], 'hello');
    expect(room.updatedAt).toBe(4242);

    const before = harness.sent.length;
    harness.handler(socket, { type: 'unknown' });
    expect(harness.sent).toHaveLength(before);
  });

  it('gates and records next-round readiness', () => {
    const harness = createHarness();
    const room = makeRoom({ status: 'playing', state: gameState('choose-source') });
    const socket = attach(harness, room);

    harness.handler(socket, { type: 'set-next-round-ready' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'The round is not ready for confirmation.' });

    room.state = gameState('round-over');
    harness.handler(socket, { type: 'set-next-round-ready', ready: false });
    expect(harness.options.setPlayerReadyForNextRound).toHaveBeenLastCalledWith(room, 'seat-1', false);
    room.state = gameState('game-over');
    harness.handler(socket, { type: 'set-next-round-ready' });
    expect(harness.options.setPlayerReadyForNextRound).toHaveBeenLastCalledWith(room, 'seat-1', true);
  });

  it('enforces host and player-count requirements before a waiting game starts', () => {
    const harness = createHarness();
    const nonHostRoom = makeRoom();
    nonHostRoom.players[0].host = false;
    const nonHost = attach(harness, nonHostRoom);
    harness.handler(nonHost, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Only the host can start the game.' });

    const onePlayer = makeRoom({ code: 'ONEPL', players: [roomPlayer('seat-1', { userId: 'user-1', host: true })] });
    const host = attach(harness, onePlayer);
    harness.handler(host, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Need at least two players.' });

    onePlayer.players.push(roomPlayer('seat-2'));
    harness.handler(host, { type: 'start-game' });
    expect(onePlayer).toMatchObject({ status: 'playing', completedGameId: null, gameSessionId: 'uuid-1', updatedAt: 4242 });
    expect(onePlayer.state?.phase).toBe('opening-reveal');
  });

  it('gates and starts next rounds and game restarts', () => {
    const harness = createHarness();
    const room = makeRoom({ status: 'playing', state: gameState('round-over') });
    const socket = attach(harness, room);
    vi.mocked(harness.options.allPlayersReadyForNextRound).mockReturnValueOnce(false);
    harness.handler(socket, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({
      type: 'error',
      message: 'Everyone must confirm they are ready before the next round starts.'
    });

    harness.handler(socket, { type: 'start-game' });
    expect(harness.options.createNextRoundRoomState).toHaveBeenCalled();
    expect(room.state?.round).toBe(2);

    room.state = gameState('game-over');
    room.status = 'finished';
    vi.mocked(harness.options.allPlayersReadyForNextRound).mockReturnValueOnce(false);
    harness.handler(socket, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({
      type: 'error',
      message: 'Everyone must confirm they are ready before the game restarts.'
    });
    harness.handler(socket, { type: 'start-game' });
    expect(room.status).toBe('playing');

    room.state = null;
    room.status = 'finished';
    harness.handler(socket, { type: 'start-game' });
    expect(harness.options.createInitialRoomState).toHaveBeenCalledTimes(2);
  });

  it('reports invalid active-game start requests', () => {
    const harness = createHarness();
    const onePlayer = makeRoom({
      status: 'playing',
      state: gameState('choose-source'),
      players: [roomPlayer('seat-1', { userId: 'user-1', host: true })]
    });
    const socket = attach(harness, onePlayer);
    harness.handler(socket, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Need at least two players.' });

    onePlayer.players.push(roomPlayer('seat-2'));
    harness.handler(socket, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'The current game is not ready for a new round.' });
  });

  it('rejects missing, inactive-player, and invalid state updates', () => {
    const harness = createHarness();
    const room = makeRoom({ status: 'playing', state: gameState('choose-source') });
    const socket = attach(harness, room);

    harness.handler(socket, { type: 'update-state' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'No active game.' });

    room.status = 'waiting';
    harness.handler(socket, { type: 'update-state', state: gameState() });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'No active game.' });
    room.status = 'playing';

    room.state = gameState('choose-source', 'other-seat');
    harness.handler(socket, { type: 'update-state', state: gameState() });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'It is not your turn.' });

    room.state = gameState();
    vi.mocked(harness.options.validateMultiplayerStateUpdate).mockReturnValueOnce({ ok: false, message: 'Specific failure.' });
    harness.handler(socket, { type: 'update-state', state: gameState() });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Specific failure.' });
    vi.mocked(harness.options.validateMultiplayerStateUpdate).mockReturnValueOnce({ ok: false });
    harness.handler(socket, { type: 'update-state', state: gameState() });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'That move is not legal.' });
  });

  it('applies legal playing and round-over updates exactly once', () => {
    const harness = createHarness();
    const room = makeRoom({ status: 'playing', state: gameState(), readyForNextRoundPlayerIds: ['seat-2'] });
    const socket = attach(harness, room);
    const playing = gameState('choose-source');
    harness.handler(socket, { type: 'update-state', state: playing });
    expect(room.state).toBe(playing);
    expect(room.readyForNextRoundPlayerIds).toEqual(['seat-1']);
    expect(room.status).toBe('playing');
    expect(harness.options.notifyAwayPlayersAfterMove).toHaveBeenCalledWith(room, room.players[0], playing);

    const roundOver = gameState('round-over');
    harness.handler(socket, { type: 'update-state', state: roundOver });
    expect(room.readyForNextRoundPlayerIds).toEqual([]);
  });

  it('records game-over history once and reports persistence failures without applying state', () => {
    const harness = createHarness();
    const room = makeRoom({ status: 'playing', state: gameState(), gameSessionId: 'session-1' });
    const socket = attach(harness, room);
    const gameOver = gameState('game-over');
    harness.handler(socket, { type: 'update-state', state: gameOver });
    expect(room).toMatchObject({ completedGameId: 'game-1', status: 'finished', state: gameOver });
    expect(harness.options.recordCompletedGame).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'multi', sourceKey: 'multi:session-1', createdByUserId: 'user-1' })
    );
    harness.handler(socket, { type: 'update-state', state: gameOver });
    expect(harness.options.recordCompletedGame).toHaveBeenCalledOnce();

    const failedHarness = createHarness();
    const failedRoom = makeRoom({ status: 'playing', state: gameState(), gameSessionId: null });
    const failedSocket = attach(failedHarness, failedRoom);
    vi.mocked(failedHarness.options.recordCompletedGame).mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    failedHarness.handler(failedSocket, { type: 'update-state', state: gameOver });
    expect(failedHarness.options.reportCompletedGameError).toHaveBeenCalled();
    expect(lastPayload(failedHarness)).toEqual({ type: 'error', message: 'Could not save the completed game history.' });
    expect(failedRoom.state?.phase).toBe('choose-source');
  });

  it('restricts resets and moves every sibling socket to the new waiting room boundary', () => {
    const harness = createHarness();
    const room = makeRoom();
    const socket = attach(harness, room);
    room.players[0].host = false;
    harness.handler(socket, { type: 'reset-room' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Only the host can reset the room.' });

    room.players[0].host = true;
    vi.mocked(harness.options.makeRoomCodeForSocket).mockReturnValueOnce(null);
    harness.handler(socket, { type: 'reset-room' });
    expect(harness.rooms.has('ABCDE')).toBe(true);

    const sibling = new FakeSocket();
    sibling.roomCode = room.code;
    sibling.playerId = 'seat-2';
    room.clients.add(sibling);
    harness.handler(socket, { type: 'reset-room' });
    expect(harness.rooms.has('ABCDE')).toBe(false);
    expect(harness.rooms.has('NEWCD')).toBe(true);
    expect(socket.roomCode).toBe('NEWCD');
    expect(sibling.roomCode).toBeNull();
    expect(sibling.playerId).toBeNull();
    expect(harness.sent.some(({ socket: target, payload }) => target === sibling && (payload as { type: string }).type === 'room-reset')).toBe(true);
    expect(lastPayload(harness)).toEqual({ type: 'joined', playerId: 'seat-1', room: { code: 'NEWCD' } });
  });
});
