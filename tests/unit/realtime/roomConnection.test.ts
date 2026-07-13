import {
  RECONNECT_BASE_DELAYS_MS,
  ROOM_SYNC_TIMEOUT_MS,
  createRoomConnection,
  isMultiplayerRoomSnapshot,
  parseRoomConnectionFrame,
  reconnectDelayMs,
  type RoomConnectionFrame,
  type RoomConnectionSocket,
  type RoomConnectionState
} from '../../../src/roomConnection';
import { PUBLIC_SNAPSHOT_LIMITS } from '../../../src/protocolV2';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type SocketEvent = 'open' | 'message' | 'error' | 'close';

class FakeSocket implements RoomConnectionSocket {
  readyState = 0;
  readonly sent: RoomConnectionFrame[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  deferClose = false;
  throwOnClose = false;
  throwOnSend = false;
  private readonly listeners = new Map<SocketEvent, Array<(event: unknown) => void>>();

  addEventListener(event: SocketEvent, listener: (event: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) throw new Error('close failed');
    this.closes.push({ code, reason });
    this.readyState = 3;
    if (!this.deferClose) this.emit('close', { code, reason });
  }

  send(payload: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(JSON.parse(payload) as RoomConnectionFrame);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(frame: unknown): void {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  flushClose(): void {
    this.emit('close', this.closes.at(-1) ?? {});
  }

  fail(): void {
    this.emit('error', {});
  }

  private emit(event: SocketEvent, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

type TimerRecord = { callback: () => void; canceled: boolean; delayMs: number };

function room(code = 'ABCDE', updatedAt = 100) {
  return {
    code,
    hostId: 'p1',
    players: [{ id: 'p1', name: 'Alice', connected: true, host: true, controller: 'human', disconnectedAt: null, aiTakeoverAt: null }],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    status: 'waiting',
    state: null,
    updatedAt,
    completedGameId: null,
    finishedByAi: false,
    hostTransferAt: null,
    revision: 0,
    serverNow: updatedAt
  };
}

function validCard(id: string, value: number | null = null, faceUp = false) {
  return { id, value, faceUp, removed: false };
}

function validGamePlayer(id: string, playerIndex = id === 'p1' ? 0 : 1) {
  return {
    id,
    name: id === 'p1' ? 'Alice' : 'Bob',
    kind: 'human',
    grid: Array.from({ length: 12 }, (_, index) => validCard(`grid-${playerIndex}-${index}`)),
    totalScore: 0,
    roundScore: 0
  };
}

function validGameState() {
  return {
    players: [validGamePlayer('p1'), validGamePlayer('p2')],
    drawPileCount: 125,
    discardPile: { count: 1, top: validCard('discard-top', 4, true) },
    currentPlayerIndex: 0,
    phase: 'choose-source',
    selectedSource: null,
    hasDrawnCard: false,
    drawnCard: null,
    round: 1,
    log: ['Alice starts.'],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { p1: 2, p2: 2 },
    roundHistory: [
      {
        round: 1,
        closerId: 'p1',
        scores: [{ playerId: 'p1', name: 'Alice', roundScore: 4, totalScore: 4 }]
      }
    ]
  };
}

function validActiveRoom() {
  return {
    ...room(),
    players: [
      { id: 'p1', name: 'Alice', connected: true, host: true, controller: 'human', disconnectedAt: null, aiTakeoverAt: null },
      { id: 'p2', name: 'Bob', connected: true, host: false, controller: 'human', disconnectedAt: null, aiTakeoverAt: null }
    ],
    chatMessages: [
      { id: 'chat-1', playerId: 'p1', playerName: 'Alice', text: 'Hello', createdAt: Date.UTC(2026, 0, 1) }
    ],
    readyForNextRoundPlayerIds: ['p1'],
    state: validGameState(),
    status: 'playing',
    completedGameId: null
  };
}

function snapshotFrame(roomValue = room(), playerId = 'p1') {
  return {
    type: 'snapshot',
    protocolVersion: 2,
    playerId,
    revision: roomValue.revision,
    room: roomValue
  };
}

function errorFrame(message: string, code = 'room-error') {
  return { type: 'error', protocolVersion: 2, code, message };
}

function createHarness({ initiallyOnline = true, randomValue = 0.5 } = {}) {
  const sockets: FakeSocket[] = [];
  const states: Array<{ state: RoomConnectionState; retryInMs: number | null }> = [];
  const frames: RoomConnectionFrame[] = [];
  const errors: string[] = [];
  const timers: TimerRecord[] = [];
  const syncTimers: TimerRecord[] = [];
  let online = initiallyOnline;
  let now = 1_000;

  const controller = createRoomConnection({
    url: 'wss://example.test/rooms',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    clock: () => now,
    random: () => randomValue,
    isOnline: () => online,
    scheduleTimer: (callback, delayMs) => {
      const record = { callback, delayMs, canceled: false };
      timers.push(record);
      return record;
    },
    cancelTimer: (handle) => {
      (handle as TimerRecord).canceled = true;
    },
    scheduleSyncTimer: (callback, delayMs) => {
      const record = { callback, delayMs, canceled: false };
      syncTimers.push(record);
      return record;
    },
    cancelSyncTimer: (handle) => {
      (handle as TimerRecord).canceled = true;
    },
    onStateChange: (state, detail) => states.push({ state, retryInMs: detail.retryInMs }),
    onFrame: (frame) => frames.push(frame),
    onError: (message) => errors.push(message)
  });

  return {
    controller,
    errors,
    frames,
    sockets,
    states,
    syncTimers,
    timers,
    setNow(value: number) {
      now = value;
    },
    setOnlineValue(value: boolean) {
      online = value;
    },
    runTimer(index: number, includeCanceled = false) {
      const timer = timers[index];
      if (!timer) throw new Error(`Missing timer ${index}.`);
      if (!timer.canceled || includeCanceled) timer.callback();
    },
    runSyncTimer(index: number, includeCanceled = false) {
      const timer = syncTimers[index];
      if (!timer) throw new Error(`Missing sync timer ${index}.`);
      if (!timer.canceled || includeCanceled) timer.callback();
    }
  };
}

describe('room connection controller', () => {
  it('uses the exact capped base schedule with deterministic bounded jitter', () => {
    expect(RECONNECT_BASE_DELAYS_MS).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
    expect(RECONNECT_BASE_DELAYS_MS.map((_, index) => reconnectDelayMs(index, () => 0.5))).toEqual(
      RECONNECT_BASE_DELAYS_MS
    );
    expect(reconnectDelayMs(0, () => 0)).toBe(400);
    expect(reconnectDelayMs(0, () => 1)).toBe(600);
    expect(reconnectDelayMs(99, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(Number.NaN, () => Number.NaN)).toBe(500);
  });

  it('parses only object frames', () => {
    expect(parseRoomConnectionFrame('{"type":"room"}')).toEqual({ type: 'room' });
    for (const value of ['{', 'null', '[]', '42', '"room"']) expect(parseRoomConnectionFrame(value)).toBeNull();
  });

  it('accepts a render-safe complete room and rejects malformed room, chat, player, and game-state shapes', () => {
    const valid = validActiveRoom();
    const game = validGameState();
    const player = validGamePlayer('p1');
    const card = validCard('card');
    expect(isMultiplayerRoomSnapshot(valid, 'ABCDE')).toBe(true);

    const invalidRooms: unknown[] = [
      null,
      [],
      { ...valid, code: '' },
      { ...valid, code: 'OTHER' },
      { ...valid, hostId: '' },
      { ...valid, players: [] },
      { ...valid, players: Array.from({ length: 9 }, (_, index) => ({ ...valid.players[0], id: `p${index}` })) },
      { ...valid, players: [null] },
      { ...valid, players: [{ ...valid.players[0], id: 1 }] },
      { ...valid, players: [{ ...valid.players[0], name: null }] },
      { ...valid, players: [{ ...valid.players[0], connected: 'yes' }] },
      { ...valid, players: [{ ...valid.players[0], host: 1 }] },
      { ...valid, players: [{ ...valid.players[0], userId: 1 }] },
      { ...valid, status: 'paused' },
      { ...valid, updatedAt: Number.NaN },
      { ...valid, chatMessages: null },
      { ...valid, chatMessages: [null] },
      { ...valid, chatMessages: [{ ...valid.chatMessages[0], id: 1 }] },
      { ...valid, chatMessages: [{ ...valid.chatMessages[0], playerId: 1 }] },
      { ...valid, chatMessages: [{ ...valid.chatMessages[0], playerName: 1 }] },
      { ...valid, chatMessages: [{ ...valid.chatMessages[0], text: 1 }] },
      { ...valid, chatMessages: [{ ...valid.chatMessages[0], createdAt: 9e20 }] },
      { ...valid, readyForNextRoundPlayerIds: null },
      { ...valid, readyForNextRoundPlayerIds: [1] },
      { ...valid, completedGameId: 1 },
      { ...valid, state: { ...game, players: [] } },
      { ...valid, state: { ...game, players: Array.from({ length: 9 }, (_, index) => validGamePlayer(`p${index}`)) } },
      { ...valid, state: { ...game, players: [null] } },
      { ...valid, state: { ...game, players: [{ ...player, id: 1 }] } },
      { ...valid, state: { ...game, players: [{ ...player, name: 1 }] } },
      { ...valid, state: { ...game, players: [{ ...player, kind: 'robot' }] } },
      { ...valid, state: { ...game, players: [{ ...player, grid: [] }] } },
      { ...valid, state: { ...game, players: [{ ...player, grid: [{ ...card, id: 1 }] }] } },
      { ...valid, state: { ...game, players: [{ ...player, totalScore: Number.NaN }] } },
      { ...valid, state: { ...game, players: [{ ...player, roundScore: Number.NaN }] } },
      { ...valid, state: { ...game, currentPlayerIndex: -1 } },
      { ...valid, state: { ...game, currentPlayerIndex: 2 } },
      { ...valid, state: { ...game, phase: 'paused' } },
      { ...valid, state: { ...game, selectedSource: 'table' } },
      { ...valid, state: { ...game, drawPile: null } },
      { ...valid, state: { ...game, drawPile: [{ ...card, value: Number.NaN }] } },
      { ...valid, state: { ...game, discardPile: null } },
      { ...valid, state: { ...game, discardPile: [{ ...card, faceUp: 'yes' }] } },
      { ...valid, state: { ...game, drawnCard: { ...card, removed: 'no' } } },
      { ...valid, state: { ...game, round: 0 } },
      { ...valid, state: { ...game, log: [1] } },
      { ...valid, state: { ...game, winnerId: 1 } },
      { ...valid, state: { ...game, nextStarterId: 1 } },
      { ...valid, state: { ...game, roundCloserId: 1 } },
      { ...valid, state: { ...game, finalTurnPlayerIds: [1] } },
      { ...valid, state: { ...game, openingRevealCounts: { p1: Number.NaN } } },
      { ...valid, state: { ...game, roundHistory: null } },
      { ...valid, state: { ...game, roundHistory: [null] } },
      { ...valid, state: { ...game, roundHistory: [{ ...game.roundHistory[0], round: 1.5 }] } },
      { ...valid, state: { ...game, roundHistory: [{ ...game.roundHistory[0], closerId: 1 }] } },
      { ...valid, state: { ...game, roundHistory: [{ ...game.roundHistory[0], scores: null }] } },
      { ...valid, state: { ...game, roundHistory: [{ ...game.roundHistory[0], scores: [null] }] } },
      {
        ...valid,
        state: {
          ...game,
          roundHistory: [{ ...game.roundHistory[0], scores: [{ ...game.roundHistory[0].scores[0], playerId: 1 }] }]
        }
      },
      {
        ...valid,
        state: {
          ...game,
          roundHistory: [{ ...game.roundHistory[0], scores: [{ ...game.roundHistory[0].scores[0], name: 1 }] }]
        }
      },
      {
        ...valid,
        state: {
          ...game,
          roundHistory: [{ ...game.roundHistory[0], scores: [{ ...game.roundHistory[0].scores[0], roundScore: Number.NaN }] }]
        }
      },
      {
        ...valid,
        state: {
          ...game,
          roundHistory: [{ ...game.roundHistory[0], scores: [{ ...game.roundHistory[0].scores[0], totalScore: Number.NaN }] }]
        }
      }
    ];

    for (const invalid of invalidRooms) expect(isMultiplayerRoomSnapshot(invalid, 'ABCDE')).toBe(false);
  });

  it('enforces every shared public snapshot string and collection boundary', () => {
    type MutableGameStateFixture = Omit<
      ReturnType<typeof validGameState>,
      'winnerId' | 'finalTurnPlayerIds' | 'openingRevealCounts'
    > & {
      winnerId: string | null;
      finalTurnPlayerIds: string[];
      openingRevealCounts: Record<string, number>;
    };
    type MutableRoomFixture = Omit<ReturnType<typeof validActiveRoom>, 'completedGameId' | 'state'> & {
      completedGameId: string | null;
      state: MutableGameStateFixture;
    };
    const overIdentifier = 'i'.repeat(PUBLIC_SNAPSHOT_LIMITS.identifierLength + 1);
    const overName = 'n'.repeat(PUBLIC_SNAPSHOT_LIMITS.nameLength + 1);
    const overLog = 'l'.repeat(PUBLIC_SNAPSHOT_LIMITS.logEntryLength + 1);
    const overChat = 'c'.repeat(PUBLIC_SNAPSHOT_LIMITS.chatMessageLength + 1);
    const mutations: Array<(candidate: MutableRoomFixture) => void> = [
      (candidate) => { candidate.code = 'ABCDEF'; },
      (candidate) => { candidate.hostId = overIdentifier; },
      (candidate) => { candidate.players[0].id = overIdentifier; },
      (candidate) => { candidate.players[0].name = overName; },
      (candidate) => { candidate.chatMessages[0].id = overIdentifier; },
      (candidate) => { candidate.chatMessages[0].playerId = overIdentifier; },
      (candidate) => { candidate.chatMessages[0].playerName = overName; },
      (candidate) => { candidate.chatMessages[0].text = overChat; },
      (candidate) => { candidate.completedGameId = overIdentifier; },
      (candidate) => { candidate.readyForNextRoundPlayerIds = [overIdentifier]; },
      (candidate) => { candidate.state.players[0].id = overIdentifier; },
      (candidate) => { candidate.state.players[0].name = overName; },
      (candidate) => { candidate.state.log = [overLog]; },
      (candidate) => { candidate.state.winnerId = overIdentifier; },
      (candidate) => { candidate.state.finalTurnPlayerIds = [overIdentifier]; },
      (candidate) => { candidate.state.openingRevealCounts = { [overIdentifier]: 2 }; },
      (candidate) => { candidate.state.roundHistory[0].closerId = overIdentifier; },
      (candidate) => { candidate.state.roundHistory[0].scores[0].playerId = overIdentifier; },
      (candidate) => { candidate.state.roundHistory[0].scores[0].name = overName; },
      (candidate) => {
        candidate.state.roundHistory = Array.from(
          { length: PUBLIC_SNAPSHOT_LIMITS.historyEntries + 1 },
          () => structuredClone(candidate.state.roundHistory[0])
        );
      }
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(validActiveRoom()) as MutableRoomFixture;
      mutate(candidate);
      expect(isMultiplayerRoomSnapshot(candidate)).toBe(false);
    }
  });

  it('uses the production WebSocket and timer defaults behind a deterministic fake-time boundary', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sockets: FakeSocket[] = [];
    class DefaultSocket extends FakeSocket {
      constructor(_url: string) {
        super();
        void _url;
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', DefaultSocket);
    try {
      const controller = createRoomConnection({
        url: 'wss://example.test/rooms',
        onFrame: vi.fn(),
        onStateChange: vi.fn()
      });
      controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('maps internal create and join sessions to exact protocol-v2 wire frames', () => {
    const created = createHarness();
    created.controller.connect({ action: 'create-room', name: 'Alice' });
    created.sockets[0].open();
    expect(created.sockets[0].sent).toEqual([{ type: 'create-room', protocolVersion: 2, name: 'Alice' }]);
    expect(created.sockets[0].sent[0]).not.toHaveProperty('action');

    const joined = createHarness();
    joined.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    joined.sockets[0].open();
    expect(joined.sockets[0].sent).toEqual([{
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, code: 'ABCDE', name: 'Alice'
    }]);

    const recovered = createHarness();
    recovered.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    recovered.runTimer(0);
    recovered.sockets[0].open();
    expect(recovered.sockets[0].sent).toEqual([
      { type: 'join-room', protocolVersion: 2, presenceVersion: 1, code: 'ABCDE', name: 'Alice', playerId: 'p1' }
    ]);

    const resetRecovery = createHarness();
    resetRecovery.controller.recover({
      action: 'join-room',
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'p1',
      recoveryCommandId: '10000000-0000-4000-8000-000000000001',
      recoveryExpectedRevision: 7
    });
    resetRecovery.runTimer(0);
    resetRecovery.sockets[0].open();
    expect(resetRecovery.sockets[0].sent).toEqual([
      {
        type: 'join-room',
        protocolVersion: 2,
        presenceVersion: 1,
        code: 'ABCDE',
        name: 'Alice',
        playerId: 'p1',
        recoveryCommandId: '10000000-0000-4000-8000-000000000001'
      }
    ]);
    expect(resetRecovery.sockets[0].sent[0]).not.toHaveProperty('recoveryExpectedRevision');
  });

  it.each([
    ['missing player id', undefined, '10000000-0000-4000-8000-000000000001', 0],
    ['missing expected revision', 'p1', '10000000-0000-4000-8000-000000000001', undefined],
    ['negative expected revision', 'p1', '10000000-0000-4000-8000-000000000001', -1],
    ['fractional expected revision', 'p1', '10000000-0000-4000-8000-000000000001', 1.5],
    ['maximum expected revision', 'p1', '10000000-0000-4000-8000-000000000001', Number.MAX_SAFE_INTEGER],
    ['malformed id', 'p1', 'not-a-uuid', 0],
    ['invalid UUID version', 'p1', '10000000-0000-0000-8000-000000000001', 0],
    ['invalid UUID variant', 'p1', '10000000-0000-4000-7000-000000000001', 0]
  ])('omits a reset recovery hint with %s', (_label, playerId, recoveryCommandId, recoveryExpectedRevision) => {
    const harness = createHarness();
    harness.controller.connect({
      action: 'join-room',
      code: 'ABCDE',
      name: 'Alice',
      ...(playerId ? { playerId } : {}),
      recoveryCommandId,
      recoveryExpectedRevision
    });
    harness.sockets[0].open();

    expect(harness.sockets[0].sent).toEqual([
      {
        type: 'join-room',
        protocolVersion: 2,
        presenceVersion: 1,
        code: 'ABCDE',
        name: 'Alice',
        ...(playerId ? { playerId } : {})
      }
    ]);
  });

  it('enables commands and resets backoff only after a structurally valid authoritative snapshot', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    expect(harness.states.at(-1)).toEqual({ state: 'reconnecting', retryInMs: 500 });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    expect(harness.controller.send({ type: 'send-chat-message', text: 'blocked' })).toBe(false);

    socket.receive(snapshotFrame());
    expect(harness.controller.getState()).toBe('connected');
    expect(harness.controller.send({ type: 'send-chat-message', text: 'ready' })).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'send-chat-message', text: 'ready' });

    socket.serverClose();
    expect(harness.states.at(-1)).toEqual({ state: 'reconnecting', retryInMs: 500 });
  });

  it('fails closed for malformed, incomplete, and cross-room snapshots', () => {
    for (const frame of [
      '{',
      { type: 'room' },
      snapshotFrame(room('OTHER')),
      { ...snapshotFrame(), playerId: undefined },
      snapshotFrame({ ...room(), players: [null] } as never),
      snapshotFrame({ ...room(), chatMessages: [null] } as never),
      snapshotFrame({ ...room(), state: { players: [null] } } as never)
    ]) {
      const harness = createHarness();
      harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
      harness.runTimer(0);
      const socket = harness.sockets[0];
      socket.open();
      socket.receive(frame);
      expect(harness.controller.getState()).not.toBe('connected');
      expect(harness.controller.send({ type: 'start-game' })).toBe(false);
      expect(socket.closes.at(-1)?.code).toBe(1002);
      expect(harness.frames).toHaveLength(0);
    }
  });

  it('accepts identity-free public snapshots only after personalized socket sync and retains the seat identity', () => {
    const anonymousBeforeSync = createHarness();
    anonymousBeforeSync.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    anonymousBeforeSync.runTimer(0);
    anonymousBeforeSync.sockets[0].open();
    const firstSharedRoom = { ...room(), revision: 1, updatedAt: 101, serverNow: 101 };
    anonymousBeforeSync.sockets[0].receive({
      type: 'snapshot', protocolVersion: 2, revision: 1, room: firstSharedRoom
    });
    expect(anonymousBeforeSync.sockets[0].closes.at(-1)).toEqual({
      code: 1002, reason: 'Invalid server response'
    });
    expect(anonymousBeforeSync.frames).toHaveLength(0);

    const established = createHarness();
    established.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    established.runTimer(0);
    const socket = established.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    socket.receive({ type: 'snapshot', protocolVersion: 2, revision: 1, room: firstSharedRoom });

    expect(established.controller.getState()).toBe('connected');
    expect(established.frames.at(-1)).toMatchObject({
      type: 'snapshot', playerId: 'p1', revision: 1, room: { code: 'ABCDE', revision: 1 }
    });
    expect(established.frames.at(-1)).toHaveProperty('playerId', 'p1');
    expect(socket.closes).toEqual([]);
  });

  it('rejects stale identity-free revisions, missing seat membership, and anonymous private-draw views', () => {
    function synchronizedHarness(playerId: string, revision = 0) {
      const harness = createHarness();
      harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: playerId, playerId });
      harness.runTimer(0);
      const socket = harness.sockets[0];
      socket.open();
      socket.receive(snapshotFrame({ ...validActiveRoom(), revision } as never, playerId));
      return { harness, socket };
    }

    const stale = synchronizedHarness('p2', 2);
    stale.socket.receive({
      type: 'snapshot', protocolVersion: 2, revision: 1,
      room: { ...validActiveRoom(), revision: 1 }
    });
    expect(stale.socket.closes.at(-1)?.code).toBe(1002);

    const wrongRevision = synchronizedHarness('p2');
    wrongRevision.socket.receive({
      type: 'snapshot', protocolVersion: 2, revision: 2,
      room: { ...validActiveRoom(), revision: 1 }
    });
    expect(wrongRevision.socket.closes.at(-1)?.code).toBe(1002);

    const missingSeat = synchronizedHarness('p2');
    missingSeat.socket.receive({
      type: 'snapshot', protocolVersion: 2, revision: 1,
      room: { ...room(), revision: 1 }
    });
    expect(missingSeat.socket.closes.at(-1)?.code).toBe(1002);

    const privateDrawer = synchronizedHarness('p1');
    const privateState = {
      ...validGameState(),
      phase: 'choose-replacement',
      selectedSource: 'draw',
      hasDrawnCard: true,
      drawnCard: validCard('drawn-card', 9, true)
    };
    privateDrawer.socket.receive({
      type: 'snapshot', protocolVersion: 2, revision: 1,
      room: { ...validActiveRoom(), revision: 1, state: privateState }
    });
    expect(privateDrawer.socket.closes.at(-1)?.code).toBe(1002);

    const publicNonDrawer = synchronizedHarness('p2');
    publicNonDrawer.socket.receive({
      type: 'snapshot', protocolVersion: 2, revision: 1,
      room: { ...validActiveRoom(), revision: 1, state: { ...privateState, drawnCard: null } }
    });
    expect(publicNonDrawer.socket.closes).toEqual([]);
    expect(publicNonDrawer.harness.frames.at(-1)).toMatchObject({ playerId: 'p2', revision: 1 });
  });

  it('accepts a fresh room code only for the matching in-memory reset command and converges on ack', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    const resetCommand = {
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'reset-room' }
    };
    expect(harness.controller.send(resetCommand)).toBe(true);
    const replacement = { ...room('FGHIJ'), revision: 1 };
    socket.receive({
      type: 'resync',
      protocolVersion: 2,
      playerId: 'p1',
      revision: 1,
      room: replacement,
      reason: 'room-reset',
      commandId: resetCommand.commandId
    });
    expect(harness.controller.getState()).toBe('connected');
    expect(harness.frames.at(-1)).toMatchObject({ type: 'resync', room: { code: 'FGHIJ' } });
    socket.receive({ type: 'ack', protocolVersion: 2, commandId: resetCommand.commandId, revision: 1 });
    expect(harness.controller.send({
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000002',
      expectedRevision: 1,
      action: { type: 'send-chat-message', text: 'new room' }
    })).toBe(true);
    socket.serverClose();
    harness.runTimer(1);
    harness.sockets[1].open();
    expect(harness.sockets[1].sent[0]).toMatchObject({ type: 'join-room', code: 'FGHIJ', playerId: 'p1' });
  });

  it('binds reset recovery before transport and never replays it after an advanced target proves application', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const first = harness.sockets[0];
    first.open();
    first.receive(snapshotFrame());
    const resetCommand = {
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'reset-room' }
    };
    expect(harness.controller.send(resetCommand)).toBe(true);

    first.serverClose();
    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();
    expect(recovered.sent).toEqual([{
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'p1',
      recoveryCommandId: resetCommand.commandId
    }]);

    const advancedReplacement = { ...room('FGHIJ', 300), revision: 3 };
    recovered.receive({
      type: 'resync',
      protocolVersion: 2,
      playerId: 'p1',
      revision: 3,
      room: advancedReplacement,
      reason: 'room-reset',
      commandId: resetCommand.commandId
    });
    expect(harness.controller.getState()).toBe('connected');
    expect(harness.frames.at(-1)).toMatchObject({ type: 'resync', room: { code: 'FGHIJ', revision: 3 } });

    recovered.serverClose();
    harness.runTimer(2);
    const targetReconnect = harness.sockets[2];
    targetReconnect.open();
    expect(targetReconnect.sent).toEqual([{
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'FGHIJ',
      name: 'Alice',
      playerId: 'p1'
    }]);
    targetReconnect.receive(snapshotFrame(advancedReplacement));
    expect(targetReconnect.sent).toHaveLength(2);
    expect(targetReconnect.sent[1]).toEqual({ type: 'set-presence', visible: true });

    targetReconnect.serverClose();
    harness.runTimer(3);
    const secondTargetReconnect = harness.sockets[3];
    secondTargetReconnect.open();
    expect(secondTargetReconnect.sent).toEqual([{
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'FGHIJ',
      name: 'Alice',
      playerId: 'p1'
    }]);
  });

  it('accepts an advanced reset target from a boot recovery session without replaying the reset', () => {
    const harness = createHarness();
    const commandId = '10000000-0000-4000-8000-000000000001';
    harness.controller.recover({
      action: 'join-room',
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'p1',
      recoveryCommandId: commandId,
      recoveryExpectedRevision: 0
    });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    const advancedReplacement = { ...room('FGHIJ', 300), revision: 4 };
    socket.receive({
      type: 'resync',
      protocolVersion: 2,
      playerId: 'p1',
      revision: 4,
      room: advancedReplacement,
      reason: 'room-reset',
      commandId
    });
    socket.receive({ type: 'ack', protocolVersion: 2, commandId, revision: 1 });

    expect(harness.controller.getState()).toBe('connected');
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toEqual({ type: 'set-presence', visible: true });
    socket.serverClose();
    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();
    expect(recovered.sent).toEqual([{
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'FGHIJ',
      name: 'Alice',
      playerId: 'p1'
    }]);
  });

  it.each([
    ['unsolicited', null, '10000000-0000-4000-8000-000000000001', 'p1', 1, 'room-reset', 'FGHIJ'],
    ['different action', 'start-game', '10000000-0000-4000-8000-000000000001', 'p1', 1, 'room-reset', 'FGHIJ'],
    ['wrong command id', 'reset-room', '10000000-0000-4000-8000-000000000099', 'p1', 1, 'room-reset', 'FGHIJ'],
    ['wrong player', 'reset-room', '10000000-0000-4000-8000-000000000001', 'p2', 1, 'room-reset', 'FGHIJ'],
    ['wrong revision', 'reset-room', '10000000-0000-4000-8000-000000000001', 'p1', 2, 'room-reset', 'FGHIJ'],
    ['wrong reason', 'reset-room', '10000000-0000-4000-8000-000000000001', 'p1', 1, 'stale-revision', 'FGHIJ'],
    ['unchanged code', 'reset-room', '10000000-0000-4000-8000-000000000001', 'p1', 1, 'room-reset', 'ABCDE']
  ])('rejects an unsafe reset code transition: %s', (_name, actionType, commandId, playerId, revision, reason, code) => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    if (actionType) {
      expect(harness.controller.send({
        type: 'command',
        protocolVersion: 2,
        commandId: '10000000-0000-4000-8000-000000000001',
        expectedRevision: 0,
        action: { type: actionType }
      })).toBe(true);
    }
    socket.receive({
      type: 'resync',
      protocolVersion: 2,
      playerId,
      revision,
      room: { ...room(code), revision },
      reason,
      commandId
    });
    expect(socket.closes.at(-1)?.code).toBe(1002);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'snapshot', room: { code: 'ABCDE' } });
    expect(harness.controller.getState()).toBe('reconnecting');
  });

  it('fails terminally when a create-room socket receives a malformed frame and has no seat to recover', () => {
    const harness = createHarness();
    harness.controller.connect({ action: 'create-room', name: 'Alice' });
    const socket = harness.sockets[0];
    socket.open();
    socket.receive('{');
    expect(harness.controller.getState()).toBe('error');
    expect(harness.timers).toHaveLength(0);
  });

  it('synchronously generation-fences an invalid frame before deferred close or a queued later snapshot', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.deferClose = true;
    socket.open();
    socket.receive({ ...snapshotFrame(), extra: true });
    expect(harness.controller.getState()).toBe('reconnecting');
    expect(harness.timers).toHaveLength(2);

    socket.receive(snapshotFrame());
    socket.flushClose();
    expect(harness.controller.getState()).toBe('reconnecting');
    expect(harness.frames).toHaveLength(0);
    expect(harness.timers).toHaveLength(2);
  });

  it('backs off through the full sequence and keeps one retry timer', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });

    for (let index = 0; index < RECONNECT_BASE_DELAYS_MS.length; index += 1) {
      expect(harness.timers[index].delayMs).toBe(RECONNECT_BASE_DELAYS_MS[index]);
      harness.controller.resume();
      expect(harness.timers).toHaveLength(index + 1);
      harness.runTimer(index);
      harness.sockets[index].open();
      harness.sockets[index].serverClose();
    }
    expect(harness.timers.at(-1)?.delayMs).toBe(30_000);
  });

  it('times out stalled CONNECTING and OPEN-without-snapshot joins and schedules the next retry', () => {
    for (const openBeforeTimeout of [false, true]) {
      const harness = createHarness();
      harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
      harness.runTimer(0);
      const socket = harness.sockets[0];
      if (openBeforeTimeout) socket.open();
      expect(harness.syncTimers[0].delayMs).toBe(ROOM_SYNC_TIMEOUT_MS);
      harness.runSyncTimer(0);
      expect(socket.closes.at(-1)).toEqual({ code: 4001, reason: 'Room synchronization timed out' });
      expect(harness.controller.getState()).toBe('reconnecting');
      expect(harness.timers[1].delayMs).toBe(1_000);
      expect(harness.errors.at(-1)).toMatch(/timed out/i);
    }
  });

  it('keeps the maximum-jitter saved-seat timeout path within ten seconds to replacement construction', () => {
    const harness = createHarness({ randomValue: 1 });
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    expect(harness.timers[0].delayMs).toBe(600);
    harness.runTimer(0);
    harness.runSyncTimer(0);
    expect(harness.timers[1].delayMs).toBe(1_200);
    expect(harness.timers[0].delayMs + ROOM_SYNC_TIMEOUT_MS + harness.timers[1].delayMs).toBeLessThanOrEqual(10_000);
  });

  it('cancels the sync watchdog on a timely snapshot and generation-fences stale watchdog callbacks', () => {
    const timely = createHarness();
    timely.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    timely.runTimer(0);
    timely.sockets[0].open();
    timely.sockets[0].receive(snapshotFrame());
    expect(timely.syncTimers[0].canceled).toBe(true);
    timely.runSyncTimer(0, true);
    expect(timely.controller.getState()).toBe('connected');
    expect(timely.timers).toHaveLength(1);

    const stale = createHarness();
    stale.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    stale.runTimer(0);
    stale.sockets[0].open();
    stale.controller.recover({ action: 'join-room', code: 'FGHIJ', name: 'Alice', playerId: 'p2' });
    stale.runTimer(1);
    stale.sockets[1].open();
    expect(stale.syncTimers[0].canceled).toBe(true);
    stale.runSyncTimer(0, true);
    expect(stale.syncTimers[1].canceled).toBe(false);
    expect(stale.sockets[1].closes).toHaveLength(0);
  });

  it('fails a stalled create-room request terminally without duplicating room creation', () => {
    const harness = createHarness();
    harness.controller.connect({ action: 'create-room', name: 'Alice' });
    harness.sockets[0].open();
    harness.runSyncTimer(0);
    expect(harness.controller.getState()).toBe('error');
    expect(harness.timers).toHaveLength(0);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.errors.at(-1)).toMatch(/creating the room again/i);
  });

  it('never auto-retries a first-time join without a saved seat after close or timeout', () => {
    const closed = createHarness();
    closed.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    closed.sockets[0].open();
    closed.sockets[0].serverClose();
    expect(closed.controller.getState()).toBe('error');
    expect(closed.timers).toHaveLength(0);

    const timedOut = createHarness();
    timedOut.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    timedOut.sockets[0].open();
    timedOut.runSyncTimer(0);
    expect(timedOut.controller.getState()).toBe('error');
    expect(timedOut.timers).toHaveLength(0);
    expect(timedOut.errors.at(-1)).toMatch(/joining the room again/i);
  });

  it('uses value equality for idempotent recover calls and preserves a healthy or pending connection', () => {
    const harness = createHarness();
    const first = { action: 'join-room' as const, code: 'ABCDE', name: 'Alice', playerId: 'p1' };
    harness.controller.recover(first);
    harness.controller.recover({ ...first });
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].canceled).toBe(false);

    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    harness.controller.recover({ ...first });
    expect(socket.closes).toHaveLength(0);
    expect(harness.sockets).toHaveLength(1);
  });

  it('generation-fences stale socket events and canceled timer callbacks', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.controller.recover({ action: 'join-room', code: 'FGHIJ', name: 'Alice', playerId: 'p2' });
    expect(harness.timers[0].canceled).toBe(true);
    expect(harness.timers[1].delayMs).toBe(500);

    harness.runTimer(0, true);
    expect(harness.sockets).toHaveLength(0);
    harness.runTimer(1);
    expect(harness.sockets).toHaveLength(1);
    harness.sockets[0].open();
    expect(harness.sockets[0].sent[0]).toMatchObject({ type: 'join-room', code: 'FGHIJ', playerId: 'p2' });

    harness.sockets[0].receive(snapshotFrame({ ...room('FGHIJ'), hostId: 'p2', players: [{ id: 'p2', name: 'Alice', connected: true, host: true, controller: 'human', disconnectedAt: null, aiTakeoverAt: null }] }, 'p2'));
    expect(harness.controller.getState()).toBe('connected');

    const replaced = createHarness();
    replaced.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    replaced.runTimer(0);
    const oldSocket = replaced.sockets[0];
    oldSocket.deferClose = true;
    oldSocket.open();
    replaced.controller.recover({ action: 'join-room', code: 'FGHIJ', name: 'Alice', playerId: 'p2' });
    oldSocket.receive(snapshotFrame());
    oldSocket.flushClose();
    expect(replaced.controller.getState()).toBe('reconnecting');
    expect(replaced.frames).toHaveLength(0);
    expect(replaced.timers.at(-1)?.delayMs).toBe(500);
  });

  it('preserves OPEN and CONNECTING sockets across focus storms and coalesces targeted resync', () => {
    const pending = createHarness();
    pending.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    pending.runTimer(0);
    pending.controller.resume();
    pending.controller.resume();
    expect(pending.sockets).toHaveLength(1);

    const connected = createHarness();
    connected.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    connected.runTimer(0);
    const socket = connected.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    connected.controller.resume();
    connected.controller.resume();
    expect(socket.closes).toHaveLength(0);
    expect(connected.sockets).toHaveLength(1);
    expect(socket.sent.filter((frame) => frame.type === 'set-presence')).toEqual([
      { type: 'set-presence', visible: true }
    ]);

    connected.setNow(1_251);
    connected.controller.resume();
    expect(socket.sent.filter((frame) => frame.type === 'set-presence')).toHaveLength(2);
  });

  it('enters offline immediately, cancels retry, and restarts from the first delay on online', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.setOnlineValue(false);
    harness.controller.setOnline(false);
    expect(harness.controller.getState()).toBe('offline');
    expect(harness.timers[0].canceled).toBe(true);
    expect(harness.controller.send({ type: 'start-game' })).toBe(false);

    harness.setOnlineValue(true);
    harness.controller.setOnline(true);
    expect(harness.timers[1].delayMs).toBe(500);
    expect(harness.controller.getState()).toBe('reconnecting');
  });

  it('stays offline when recovery starts offline or connectivity disappears before socket construction', () => {
    const offline = createHarness({ initiallyOnline: false });
    offline.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    expect(offline.controller.getState()).toBe('offline');
    expect(offline.timers).toHaveLength(0);

    const changed = createHarness();
    changed.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    changed.setOnlineValue(false);
    changed.runTimer(0);
    expect(changed.controller.getState()).toBe('offline');
    expect(changed.sockets).toHaveLength(0);

    const manual = createHarness({ initiallyOnline: false });
    manual.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    expect(manual.controller.getState()).toBe('offline');
  });

  it('converges an OPEN socket through resume-observed offline, explicit offline, and online recovery', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());

    harness.setOnlineValue(false);
    harness.controller.resume();
    expect(harness.controller.getState()).toBe('offline');
    expect(socket.closes.at(-1)).toEqual({ code: 4000, reason: 'Browser offline' });
    harness.controller.setOnline(false);
    expect(socket.closes).toHaveLength(1);

    harness.setOnlineValue(true);
    harness.controller.setOnline(true);
    expect(harness.controller.getState()).toBe('reconnecting');
    expect(harness.timers.at(-1)?.delayMs).toBe(500);
  });

  it('sends hidden presence only on an authoritative live connection', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.controller.setVisible(false);
    harness.runTimer(0);
    const socket = harness.sockets[0];
    socket.open();
    harness.controller.setVisible(false);
    expect(socket.sent.filter((frame) => frame.type === 'set-presence')).toHaveLength(0);
    socket.receive(snapshotFrame());
    expect(socket.sent.filter((frame) => frame.type === 'set-presence')).toEqual([
      { type: 'set-presence', visible: false }
    ]);
    harness.setNow(1_100);
    harness.controller.setVisible(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'set-presence', visible: true });
    expect(socket.sent.filter((frame) => frame.type === 'set-presence')).toEqual([
      { type: 'set-presence', visible: false },
      { type: 'set-presence', visible: true }
    ]);
  });

  it('retains hidden intent across a disconnect and reapplies it after the reconnect snapshot', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const first = harness.sockets[0];
    first.open();
    first.receive(snapshotFrame());
    harness.controller.setVisible(false);
    first.serverClose();

    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();
    recovered.receive(snapshotFrame(room('ABCDE', 200)));
    expect(recovered.sent).toEqual([
      { type: 'join-room', protocolVersion: 2, presenceVersion: 1, code: 'ABCDE', name: 'Alice', playerId: 'p1' },
      { type: 'set-presence', visible: false }
    ]);
  });

  it('replays an ambiguous command when ack arrived before a lower persisted reconnect snapshot', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const first = harness.sockets[0];
    first.open();
    first.receive(snapshotFrame());
    const pending = {
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'send-chat-message', text: 'once' }
    };
    expect(harness.controller.send(pending)).toBe(true);
    first.receive({ type: 'ack', protocolVersion: 2, commandId: pending.commandId, revision: 1 });
    first.serverClose();
    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();
    recovered.receive(snapshotFrame());
    expect(recovered.sent).toEqual([
      { type: 'join-room', protocolVersion: 2, presenceVersion: 1, code: 'ABCDE', name: 'Alice', playerId: 'p1' },
      { type: 'set-presence', visible: true },
      pending
    ]);
  });

  it('clears matching pending commands on stale resync or application error', () => {
    for (const terminalFrame of [
      {
        type: 'resync',
        protocolVersion: 2,
        playerId: 'p1',
        revision: 0,
        room: room(),
        reason: 'stale-revision',
        commandId: '10000000-0000-4000-8000-000000000001'
      },
      {
        type: 'error',
        protocolVersion: 2,
        code: 'illegal-move',
        message: 'No.',
        commandId: '10000000-0000-4000-8000-000000000001'
      }
    ]) {
      const harness = createHarness();
      harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
      harness.runTimer(0);
      const socket = harness.sockets[0];
      socket.open();
      socket.receive(snapshotFrame());
      expect(harness.controller.send({
        type: 'command',
        protocolVersion: 2,
        commandId: '10000000-0000-4000-8000-000000000001',
        expectedRevision: 0,
        action: { type: 'start-game' }
      })).toBe(true);
      socket.receive(terminalFrame);
      expect(harness.controller.send({
        type: 'command',
        protocolVersion: 2,
        commandId: '10000000-0000-4000-8000-000000000002',
        expectedRevision: 0,
        action: { type: 'start-game' }
      })).toBe(true);
    }
  });

  it('clears a rejected reset and reconnects the unchanged seat without a recovery hint or replay', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const first = harness.sockets[0];
    first.open();
    first.receive(snapshotFrame());
    const resetCommand = {
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'reset-room' }
    };
    expect(harness.controller.send(resetCommand)).toBe(true);

    first.receive({
      type: 'error',
      protocolVersion: 2,
      code: 'room-code-unavailable',
      message: 'A room code could not be created. Try again.',
      commandId: resetCommand.commandId
    });
    expect(harness.controller.getState()).toBe('connected');
    first.serverClose();
    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();

    expect(recovered.sent).toEqual([
      { type: 'join-room', protocolVersion: 2, presenceVersion: 1, code: 'ABCDE', name: 'Alice', playerId: 'p1' }
    ]);
    recovered.receive(snapshotFrame(room('ABCDE', 200)));
    expect(recovered.sent).toHaveLength(2);
    expect(recovered.sent[1]).toEqual({ type: 'set-presence', visible: true });
    expect(harness.controller.getState()).toBe('connected');
  });

  it('rolls back reset recovery state when the initial transport send throws', () => {
    const harness = createHarness();
    harness.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    harness.runTimer(0);
    const first = harness.sockets[0];
    first.open();
    first.receive(snapshotFrame());
    first.throwOnSend = true;
    expect(harness.controller.send({
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'reset-room' }
    })).toBe(false);

    first.throwOnSend = false;
    first.serverClose();
    harness.runTimer(1);
    const recovered = harness.sockets[1];
    recovered.open();
    expect(recovered.sent).toEqual([{
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'p1'
    }]);
  });

  it('handles upgrade shutdown, initial join-send failure, and transport close observed offline', () => {
    const upgrade = createHarness();
    upgrade.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    upgrade.runTimer(0);
    upgrade.sockets[0].open();
    upgrade.sockets[0].receive({
      type: 'upgrade-required',
      protocolVersion: 2,
      message: 'Refresh.',
      commandId: '10000000-0000-4000-8000-000000000001'
    });
    expect(upgrade.controller.getState()).toBe('error');
    expect(upgrade.sockets[0].closes.at(-1)?.code).toBe(1002);

    const sendFailure = createHarness();
    sendFailure.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    sendFailure.runTimer(0);
    sendFailure.sockets[0].throwOnSend = true;
    expect(() => sendFailure.sockets[0].open()).not.toThrow();
    expect(sendFailure.sockets[0].closes.at(-1)?.code).toBe(1011);

    const offlineClose = createHarness();
    offlineClose.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    offlineClose.runTimer(0);
    offlineClose.sockets[0].open();
    offlineClose.sockets[0].receive(snapshotFrame());
    offlineClose.setOnlineValue(false);
    offlineClose.sockets[0].serverClose();
    expect(offlineClose.controller.getState()).toBe('offline');
  });

  it('retires a rejected pending session but keeps established-room application errors connected', () => {
    const pending = createHarness();
    pending.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    pending.sockets[0].open();
    pending.sockets[0].receive(errorFrame('Room not found.', 'room-not-found'));
    expect(pending.controller.getState()).toBe('error');
    expect(pending.sockets[0].closes.at(-1)).toEqual({ code: 1000, reason: 'Pending room request rejected' });
    expect(pending.frames.at(-1)).toMatchObject({ type: 'error', message: 'Room not found.' });

    const established = createHarness();
    established.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    const socket = established.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    socket.receive(errorFrame('That move is not legal.', 'illegal-move'));
    expect(established.controller.getState()).toBe('connected');
    expect(socket.closes).toHaveLength(0);
    expect(established.controller.send({ type: 'send-chat-message', text: 'still connected' })).toBe(true);
  });

  it('retires a room only on the strict correlated terminal leave acknowledgement', () => {
    const harness = createHarness();
    harness.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    const leave = {
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000010',
      expectedRevision: 0,
      action: { type: 'leave-room' }
    };
    expect(harness.controller.send(leave)).toBe(true);
    socket.receive({
      type: 'ack',
      protocolVersion: 2,
      commandId: leave.commandId,
      revision: 1,
      result: 'room-left'
    });
    expect(harness.controller.getState()).toBe('idle');
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Room left' }]);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'ack', result: 'room-left' });

    const malformed = createHarness();
    malformed.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    malformed.sockets[0].open();
    malformed.sockets[0].receive(snapshotFrame());
    malformed.sockets[0].receive({
      type: 'ack',
      protocolVersion: 2,
      commandId: leave.commandId,
      revision: 1,
      result: 'room-left'
    });
    expect(malformed.sockets[0].closes.at(-1)).toEqual({ code: 1002, reason: 'Invalid server response' });
  });

  it('retires a kicked seat exactly once and does not fall through to a generic join error', () => {
    const harness = createHarness();
    harness.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(snapshotFrame());
    socket.receive(errorFrame('This room seat was removed.', 'seat-removed'));
    expect(harness.controller.getState()).toBe('idle');
    expect(socket.closes).toEqual([{ code: 1000, reason: 'Room seat removed' }]);
    expect(harness.frames.at(-1)).toMatchObject({ type: 'error', code: 'seat-removed' });
  });

  it('handles transport errors, constructor failures, manual disconnect, and idempotent disposal', () => {
    const harness = createHarness();
    harness.controller.connect({ action: 'create-room', name: 'Alice' });
    harness.sockets[0].fail();
    expect(harness.errors.at(-1)).toMatch(/interrupted/i);

    harness.controller.disconnect();
    expect(harness.controller.getState()).toBe('idle');
    harness.controller.dispose();
    harness.controller.dispose();
    expect(harness.controller.send({ type: 'start-game' })).toBe(false);

    const canceled = createHarness();
    canceled.controller.recover({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    canceled.controller.dispose();
    canceled.runTimer(0, true);
    expect(canceled.sockets).toHaveLength(0);

    const constructorFailure = createRoomConnection({
      url: 'wss://example.test/rooms',
      createSocket: () => { throw new Error('no socket'); },
      onFrame: vi.fn(),
      onStateChange: vi.fn(),
      onError: vi.fn()
    });
    constructorFailure.connect({ action: 'create-room', name: 'Alice' });
    expect(constructorFailure.getState()).toBe('error');

    const throwingSend = createHarness();
    throwingSend.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    const sendSocket = throwingSend.sockets[0];
    sendSocket.open();
    sendSocket.receive(snapshotFrame());
    sendSocket.throwOnSend = true;
    expect(throwingSend.controller.send({ type: 'start-game' })).toBe(false);

    const throwingClose = createHarness();
    throwingClose.controller.connect({ action: 'join-room', code: 'ABCDE', name: 'Alice' });
    throwingClose.sockets[0].throwOnClose = true;
    expect(() => throwingClose.controller.disconnect()).not.toThrow();

    const noSession = createHarness();
    noSession.controller.setOnline(false);
    expect(noSession.controller.getState()).toBe('offline');
    noSession.setOnlineValue(true);
    noSession.controller.setOnline(true);
    expect(noSession.controller.getState()).toBe('idle');

    const pending = createHarness();
    pending.controller.connect({ action: 'create-room', name: 'Alice' });
    pending.setOnlineValue(false);
    pending.controller.setOnline(false);
    expect(pending.controller.getState()).toBe('offline');
    expect(pending.sockets[0].closes.at(-1)).toEqual({ code: 4000, reason: 'Browser offline' });
    pending.setOnlineValue(true);
    pending.controller.setOnline(true);
    expect(pending.controller.getState()).toBe('idle');
    expect(pending.sockets).toHaveLength(1);
  });
});
