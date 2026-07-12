import {
  createProtocolV1MessageHandler,
  type ProtocolV1HandlerOptions,
  type ProtocolV1Room,
  type ProtocolV1RoomPlayer,
  type ProtocolV1Socket
} from '../../../src/serverProtocolV1';
import type { GameState, RoomPlayer } from '../../../src/types';

class FakeSocket implements ProtocolV1Socket {
  readonly OPEN = 1;
  readyState = 1;
  accountUser = { id: 'account-1', displayName: 'Alice' };
  playerId: string | null = null;
  roomCode: string | null = null;
  visible = true;
  readonly wire: string[] = [];

  on(): void {}

  send(payload: string): void {
    this.wire.push(payload);
  }
}

function roomPlayer(
  id: string,
  { host = id === 'p1', userId = `account-${id === 'p1' ? '1' : '2'}`, name = id === 'p1' ? 'Alice' : 'Bob' } = {}
): RoomPlayer {
  return { id, userId, name, connected: true, host };
}

function makeState(phase: GameState['phase'], activeId = 'p1'): GameState {
  const ids = activeId === 'p2' ? ['p1', 'p2'] : [activeId, 'p2'];
  return {
    players: ids.map((id, index) => ({
      id,
      kind: 'human' as const,
      name: id === 'p1' ? 'Alice' : 'Bob',
      grid: [],
      totalScore: index,
      roundScore: 0
    })),
    drawPile: [],
    discardPile: [],
    currentPlayerIndex: activeId === 'p2' ? 1 : 0,
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
    code: 'ABCDE',
    hostId: 'p1',
    players: [roomPlayer('p1'), roomPlayer('p2')],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: 0,
    completedGameId: null,
    gameSessionId: null,
    clients: new Set(),
    ...overrides
  };
}

function createHarness(room = makeRoom(), player = room.players[0]) {
  const socket = new FakeSocket();
  room.clients.add(socket);
  socket.roomCode = room.code;
  socket.playerId = player.id;
  const rooms = new Map([[room.code, room]]);
  let context: ProtocolV1RoomPlayer | null = { room, player };
  let nextCode: string | null = 'FGHIJ';
  let uuidIndex = 0;

  const sendJson = vi.fn();
  const persistRoomsSoon = vi.fn();
  const broadcastRoom = vi.fn();
  const publicRoom = vi.fn((value: ProtocolV1Room) => ({ code: value.code }));
  const normalizedReadyIds = vi.fn(() => ['p1']);
  const syncPlayerPresence = vi.fn();
  const cleanChatText = vi.fn((value: unknown) => String(value ?? '').trim());
  const appendRoomChatMessage = vi.fn();
  const setPlayerReadyForNextRound = vi.fn();
  const allPlayersReadyForNextRound = vi.fn(() => true);
  const initialState = makeState('opening-reveal');
  const nextRoundState = { ...makeState('opening-reveal'), round: 2 };
  const createInitialRoomState = vi.fn(() => initialState);
  const createNextRoundRoomState = vi.fn(() => nextRoundState);
  const validateMultiplayerStateUpdate = vi.fn((): { ok: boolean; message?: string } => ({ ok: true }));
  const recordCompletedGame = vi.fn(() => ({ id: 'game-1' }));
  const notifyAwayPlayersAfterMove = vi.fn();
  const reportCompletedGameError = vi.fn();
  const makeRoomCodeForSocket = vi.fn(() => nextCode);
  const randomUuid = vi.fn(() => `uuid-${++uuidIndex}`);
  const createWaitingRoom = vi.fn(
    ({ code, hostPlayer, ws }: Parameters<ProtocolV1HandlerOptions['createWaitingRoom']>[0]) =>
      makeRoom({
        code,
        hostId: hostPlayer.id,
        players: [{ ...hostPlayer, connected: true, host: true }],
        clients: new Set([ws])
      })
  );

  const options: ProtocolV1HandlerOptions = {
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
    now: () => 12_345,
    persistRoomsSoon,
    publicRoom,
    randomUuid,
    recordCompletedGame,
    roomPlayer: () => context,
    rooms,
    sendJson,
    setPlayerReadyForNextRound,
    syncPlayerPresence,
    validateMultiplayerStateUpdate,
    reportCompletedGameError
  };
  const handle = createProtocolV1MessageHandler(options);

  return {
    ...options,
    socket,
    room,
    rooms,
    player,
    handle,
    sendJson,
    persistRoomsSoon,
    broadcastRoom,
    publicRoom,
    normalizedReadyIds,
    syncPlayerPresence,
    cleanChatText,
    appendRoomChatMessage,
    setPlayerReadyForNextRound,
    allPlayersReadyForNextRound,
    createInitialRoomState,
    createNextRoundRoomState,
    validateMultiplayerStateUpdate,
    recordCompletedGame,
    notifyAwayPlayersAfterMove,
    reportCompletedGameError,
    makeRoomCodeForSocket,
    randomUuid,
    createWaitingRoom,
    setContext(value: ProtocolV1RoomPlayer | null) {
      context = value;
    },
    setNextCode(value: string | null) {
      nextCode = value;
    }
  };
}

function lastPayload(harness: ReturnType<typeof createHarness>): unknown {
  return harness.sendJson.mock.calls.at(-1)?.[1];
}

describe('protocol-v1 room command seam', () => {
  it('creates a room with the authenticated account and assigned secure identifiers', () => {
    const harness = createHarness();
    harness.socket.roomCode = null;
    harness.socket.playerId = null;

    harness.handle(harness.socket, { type: 'create-room' });

    const created = harness.rooms.get('FGHIJ');
    expect(created?.players[0]).toMatchObject({ id: 'uuid-1', userId: 'account-1', name: 'Alice', host: true });
    expect(harness.socket).toMatchObject({ roomCode: 'FGHIJ', playerId: 'uuid-1' });
    expect(harness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(lastPayload(harness)).toEqual({ type: 'joined', playerId: 'uuid-1', room: { code: 'FGHIJ' } });
    expect(harness.broadcastRoom).toHaveBeenCalledWith(created);
  });

  it('leaves room state unchanged when secure code allocation fails for create', () => {
    const harness = createHarness();
    harness.setNextCode(null);
    harness.handle(harness.socket, { type: 'create-room' });
    expect(harness.randomUuid).not.toHaveBeenCalled();
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
  });

  it('rejects unknown rooms, wrong-account saved seats, started-room entrants, and full rooms', () => {
    const missing = createHarness();
    missing.handle(missing.socket, { type: 'join-room', code: 'none' });
    expect(lastPayload(missing)).toEqual({ type: 'error', message: 'Room not found.' });

    const stolenRoom = makeRoom();
    const stolen = createHarness(stolenRoom);
    stolen.socket.accountUser = { id: 'intruder', displayName: 'Mallory' };
    stolen.handle(stolen.socket, { type: 'join-room', code: 'abcde', playerId: 'p1' });
    expect(lastPayload(stolen)).toEqual({ type: 'error', message: 'That saved room seat belongs to another account.' });

    const startedRoom = makeRoom({ status: 'playing', state: makeState('choose-source') });
    const started = createHarness(startedRoom);
    started.socket.accountUser = { id: 'new-account', displayName: 'New' };
    started.handle(started.socket, { type: 'join-room', code: 'ABCDE' });
    expect(lastPayload(started)).toEqual({ type: 'error', message: 'That game has already started.' });

    const fullRoom = makeRoom({
      players: Array.from({ length: 8 }, (_, index) => roomPlayer(`p${index + 1}`, { userId: `a${index}` }))
    });
    const full = createHarness(fullRoom);
    full.socket.accountUser = { id: 'new-account', displayName: 'New' };
    full.handle(full.socket, { type: 'join-room', code: 'ABCDE' });
    expect(lastPayload(full)).toEqual({ type: 'error', message: 'Room is full.' });
  });

  it('rejoins an account-owned seat and restores a legacy seat without a user id', () => {
    const room = makeRoom();
    room.players[0].userId = undefined;
    const harness = createHarness(room);

    harness.handle(harness.socket, { type: 'join-room', code: ' abcde ', playerId: 'p1' });

    expect(room.players).toHaveLength(2);
    expect(room.players[0]).toMatchObject({ userId: 'account-1', name: 'Alice' });
    expect(harness.socket.visible).toBe(true);
    expect(harness.syncPlayerPresence).toHaveBeenCalledWith(room, room.players[0]);
    expect(room.updatedAt).toBe(12_345);
    expect(lastPayload(harness)).toEqual({ type: 'joined', playerId: 'p1', room: { code: 'ABCDE' } });
  });

  it('finds a seat by account when no saved id is supplied and creates a new waiting-room seat', () => {
    const existing = createHarness();
    existing.handle(existing.socket, { type: 'join-room', code: 'ABCDE', playerId: 42 });
    expect(existing.randomUuid).not.toHaveBeenCalled();
    expect(existing.socket.playerId).toBe('p1');

    const room = makeRoom();
    const joined = createHarness(room);
    joined.socket.accountUser = { id: 'account-3', displayName: 'Cara' };
    joined.handle(joined.socket, { type: 'join-room', code: 'ABCDE' });
    expect(room.players.at(-1)).toEqual({
      id: 'uuid-1', userId: 'account-3', name: 'Cara', connected: true, host: false
    });
    expect(joined.socket.playerId).toBe('uuid-1');
    expect(joined.normalizedReadyIds).toHaveBeenCalledWith(room);
  });

  it('requires a room context and treats unknown joined commands as a no-op', () => {
    const prejoin = createHarness();
    prejoin.setContext(null);
    prejoin.handle(prejoin.socket, { type: 'mystery' });
    expect(lastPayload(prejoin)).toEqual({ type: 'error', message: 'Join or create a room first.' });

    const joined = createHarness();
    joined.handle(joined.socket, { type: 'mystery', custom: true });
    expect(joined.sendJson).not.toHaveBeenCalled();
    expect(joined.persistRoomsSoon).not.toHaveBeenCalled();
    expect(joined.room.updatedAt).toBe(0);
  });

  it('rejects empty chat and persists cleaned chat', () => {
    const harness = createHarness();
    harness.handle(harness.socket, { type: 'send-chat-message', text: '   ' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Enter a message before sending.' });
    expect(harness.appendRoomChatMessage).not.toHaveBeenCalled();

    harness.sendJson.mockClear();
    harness.handle(harness.socket, { type: 'send-chat-message', text: ' hello ' });
    expect(harness.appendRoomChatMessage).toHaveBeenCalledWith(harness.room, harness.player, 'hello');
    expect(harness.room.updatedAt).toBe(12_345);
    expect(harness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(harness.broadcastRoom).toHaveBeenCalledWith(harness.room);
  });

  it('accepts readiness only after a round and preserves explicit false', () => {
    const harness = createHarness();
    harness.handle(harness.socket, { type: 'set-next-round-ready' });
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'The round is not ready for confirmation.' });

    harness.room.state = makeState('round-over');
    harness.handle(harness.socket, { type: 'set-next-round-ready', ready: false });
    harness.handle(harness.socket, { type: 'set-next-round-ready' });
    expect(harness.setPlayerReadyForNextRound.mock.calls.map((call) => call[2])).toEqual([false, true]);
    expect(harness.persistRoomsSoon).toHaveBeenCalledTimes(2);

    harness.room.state = makeState('game-over');
    harness.handle(harness.socket, { type: 'set-next-round-ready' });
    expect(harness.setPlayerReadyForNextRound).toHaveBeenLastCalledWith(harness.room, 'p1', true);
  });

  it('enforces host and player-count requirements before starting a waiting game', () => {
    const nonHostRoom = makeRoom();
    const nonHost = createHarness(nonHostRoom, nonHostRoom.players[1]);
    nonHost.handle(nonHost.socket, { type: 'start-game' });
    expect(lastPayload(nonHost)).toEqual({ type: 'error', message: 'Only the host can start the game.' });

    const aloneRoom = makeRoom({ players: [roomPlayer('p1')] });
    const alone = createHarness(aloneRoom, aloneRoom.players[0]);
    alone.handle(alone.socket, { type: 'start-game' });
    expect(lastPayload(alone)).toEqual({ type: 'error', message: 'Need at least two players.' });

    const started = createHarness();
    started.room.completedGameId = 'old-game';
    started.handle(started.socket, { type: 'start-game' });
    expect(started.room).toMatchObject({
      state: makeState('opening-reveal'),
      status: 'playing',
      completedGameId: null,
      gameSessionId: 'uuid-1',
      updatedAt: 12_345
    });
    expect(started.createInitialRoomState).toHaveBeenCalledWith(started.room.players);
  });

  it('requires unanimous readiness and advances a completed round', () => {
    const room = makeRoom({ status: 'playing', state: makeState('round-over') });
    const harness = createHarness(room);
    harness.allPlayersReadyForNextRound.mockReturnValueOnce(false).mockReturnValueOnce(true);
    harness.handle(harness.socket, { type: 'start-game' });
    expect(lastPayload(harness)).toEqual({
      type: 'error', message: 'Everyone must confirm they are ready before the next round starts.'
    });

    harness.sendJson.mockClear();
    harness.handle(harness.socket, { type: 'start-game' });
    expect(room.state).toEqual({ ...makeState('opening-reveal'), round: 2 });
    expect(room.readyForNextRoundPlayerIds).toEqual([]);
    expect(harness.createNextRoundRoomState).toHaveBeenCalledOnce();
    expect(harness.broadcastRoom).toHaveBeenCalledWith(room);
  });

  it('requires readiness before restart and restarts game-over or state-less finished rooms', () => {
    const overRoom = makeRoom({ status: 'finished', state: makeState('game-over'), completedGameId: 'game-old' });
    const over = createHarness(overRoom);
    over.allPlayersReadyForNextRound.mockReturnValueOnce(false).mockReturnValueOnce(true);
    over.handle(over.socket, { type: 'start-game' });
    expect(lastPayload(over)).toEqual({
      type: 'error', message: 'Everyone must confirm they are ready before the game restarts.'
    });
    over.handle(over.socket, { type: 'start-game' });
    expect(overRoom).toMatchObject({ status: 'playing', completedGameId: null, gameSessionId: 'uuid-1' });

    const stateLessRoom = makeRoom({ status: 'finished', state: null });
    const stateLess = createHarness(stateLessRoom);
    stateLess.handle(stateLess.socket, { type: 'start-game' });
    expect(stateLess.allPlayersReadyForNextRound).not.toHaveBeenCalled();
    expect(stateLessRoom.status).toBe('playing');
  });

  it('returns stable start errors for active rooms that cannot transition', () => {
    const singleRoom = makeRoom({ players: [roomPlayer('p1')], status: 'playing', state: makeState('choose-source') });
    const single = createHarness(singleRoom, singleRoom.players[0]);
    single.handle(single.socket, { type: 'start-game' });
    expect(lastPayload(single)).toEqual({ type: 'error', message: 'Need at least two players.' });

    const active = createHarness(makeRoom({ status: 'playing', state: makeState('choose-source') }));
    active.handle(active.socket, { type: 'start-game' });
    expect(lastPayload(active)).toEqual({ type: 'error', message: 'The current game is not ready for a new round.' });
  });

  it('rejects missing/inactive, out-of-turn, and invalid state updates', () => {
    const noState = createHarness(makeRoom({ status: 'playing', state: makeState('choose-source') }));
    noState.handle(noState.socket, { type: 'update-state' });
    expect(lastPayload(noState)).toEqual({ type: 'error', message: 'No active game.' });

    const inactive = createHarness(makeRoom({ status: 'waiting', state: makeState('choose-source') }));
    inactive.handle(inactive.socket, { type: 'update-state', state: makeState('choose-source') });
    expect(lastPayload(inactive)).toEqual({ type: 'error', message: 'No active game.' });

    const wrongTurn = createHarness(makeRoom({ status: 'playing', state: makeState('choose-source', 'p2') }));
    wrongTurn.handle(wrongTurn.socket, { type: 'update-state', state: makeState('choose-source', 'p2') });
    expect(lastPayload(wrongTurn)).toEqual({ type: 'error', message: 'It is not your turn.' });

    const invalid = createHarness(makeRoom({ status: 'playing', state: makeState('choose-source') }));
    invalid.validateMultiplayerStateUpdate.mockReturnValueOnce({ ok: false, message: 'Specific rejection.' });
    invalid.handle(invalid.socket, { type: 'update-state', state: makeState('choose-replacement') });
    expect(lastPayload(invalid)).toEqual({ type: 'error', message: 'Specific rejection.' });
    invalid.validateMultiplayerStateUpdate.mockReturnValueOnce({ ok: false });
    invalid.handle(invalid.socket, { type: 'update-state', state: makeState('choose-replacement') });
    expect(lastPayload(invalid)).toEqual({ type: 'error', message: 'That move is not legal.' });
  });

  it('applies legal active and round-over states with status, readiness, persistence, and push hooks', () => {
    const room = makeRoom({ status: 'playing', state: makeState('choose-source'), readyForNextRoundPlayerIds: ['p1'] });
    const harness = createHarness(room);
    const activeState = makeState('choose-replacement');
    harness.handle(harness.socket, { type: 'update-state', state: activeState });
    expect(room.state).toBe(activeState);
    expect(room.status).toBe('playing');
    expect(room.readyForNextRoundPlayerIds).toEqual(['p1']);
    expect(harness.normalizedReadyIds).toHaveBeenCalledWith(room);
    expect(harness.notifyAwayPlayersAfterMove).toHaveBeenCalledWith(room, harness.player, activeState);

    const roundOver = makeState('round-over');
    harness.handle(harness.socket, { type: 'update-state', state: roundOver });
    expect(room.readyForNextRoundPlayerIds).toEqual([]);
    expect(room.status).toBe('playing');
    expect(harness.persistRoomsSoon).toHaveBeenCalledTimes(2);
  });

  it('records a completed multiplayer game once and exposes finished status', () => {
    const room = makeRoom({ status: 'playing', state: makeState('choose-source'), gameSessionId: 'session-9' });
    room.players[1].userId = undefined;
    const harness = createHarness(room);
    const completed = makeState('game-over');
    harness.handle(harness.socket, { type: 'update-state', state: completed });

    expect(harness.recordCompletedGame).toHaveBeenCalledWith({
      mode: 'multi',
      state: completed,
      roomCode: 'ABCDE',
      createdByUserId: 'account-1',
      playerAccounts: { p1: 'account-1', p2: null },
      sourceKey: 'multi:session-9'
    });
    expect(room.completedGameId).toBe('game-1');
    expect(room.status).toBe('finished');
    expect(room.readyForNextRoundPlayerIds).toEqual([]);

    harness.handle(harness.socket, { type: 'update-state', state: completed });
    expect(harness.recordCompletedGame).toHaveBeenCalledOnce();
  });

  it('uses room fallback identities and leaves state untouched when completed-game storage fails', () => {
    const room = makeRoom({ status: 'playing', state: makeState('choose-source'), gameSessionId: null });
    room.players[0].userId = undefined;
    const harness = createHarness(room);
    const completed = makeState('game-over');
    const error = new Error('database unavailable');
    harness.recordCompletedGame.mockImplementationOnce(() => { throw error; });

    harness.handle(harness.socket, { type: 'update-state', state: completed });

    expect(harness.recordCompletedGame).toHaveBeenCalledWith(expect.objectContaining({
      createdByUserId: null,
      sourceKey: 'multi:ABCDE'
    }));
    expect(harness.reportCompletedGameError).toHaveBeenCalledWith(error);
    expect(lastPayload(harness)).toEqual({ type: 'error', message: 'Could not save the completed game history.' });
    expect(room.state?.phase).toBe('choose-source');
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
  });

  it('enforces reset ownership, secure allocation, and moves the host while detaching peers', () => {
    const nonHostRoom = makeRoom();
    const nonHost = createHarness(nonHostRoom, nonHostRoom.players[1]);
    nonHost.handle(nonHost.socket, { type: 'reset-room' });
    expect(lastPayload(nonHost)).toEqual({ type: 'error', message: 'Only the host can reset the room.' });

    const failed = createHarness();
    failed.setNextCode(null);
    failed.handle(failed.socket, { type: 'reset-room' });
    expect(failed.createWaitingRoom).not.toHaveBeenCalled();

    const harness = createHarness();
    const sibling = new FakeSocket();
    sibling.roomCode = 'ABCDE';
    sibling.playerId = 'p2';
    harness.room.clients.add(sibling);
    harness.handle(harness.socket, { type: 'reset-room' });

    expect(harness.rooms.has('ABCDE')).toBe(false);
    expect(harness.rooms.get('FGHIJ')?.players[0].id).toBe('p1');
    expect(harness.socket).toMatchObject({ roomCode: 'FGHIJ', playerId: 'p1' });
    expect(sibling).toMatchObject({ roomCode: null, playerId: null });
    expect(harness.sendJson).toHaveBeenCalledWith(sibling, {
      type: 'room-reset',
      message: 'The host reset this room. Ask for the new room link to rejoin.'
    });
    expect(lastPayload(harness)).toEqual({ type: 'joined', playerId: 'p1', room: { code: 'FGHIJ' } });
  });
});
