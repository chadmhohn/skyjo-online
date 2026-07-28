import {
  broadcastRealtimeSnapshots,
  detachRealtimeSocket,
  encodeRealtimeJson,
  hasVisibleLiveClient,
  parseRealtimeMessage,
  REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES,
  REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES,
  REALTIME_OVERSIZED_CLOSE_CODE,
  registerRealtimeServer,
  sendRealtimeJson,
  sendRealtimeEncodedJson,
  syncPlayerPresence,
  type RealtimeClientMessage,
  type RealtimeHttpServer,
  type RealtimePlayer,
  type RealtimeRoom,
  type RealtimeRoomPlayer,
  type RealtimeSocket,
  type RealtimeUpgradeRequest,
  type RealtimeUpgradeSocket,
  type RealtimeWebSocketServer
} from '../../../src/serverRealtime';

type SocketEvent = 'message' | 'close';

class FakeSocket implements RealtimeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  accountUser?: unknown;
  playerId?: string | null;
  roomCode?: string | null;
  snapshotRoomCode?: string | null;
  snapshotEnvelopeVersion?: number | null;
  visible?: boolean;
  heartbeatAwaitingPong?: boolean;
  readonly sent: string[] = [];
  readonly rawSent: Array<{ payload: string | Uint8Array; options?: { binary?: boolean } }> = [];
  pingCount = 0;
  pingAttempts = 0;
  terminateCount = 0;
  terminateAttempts = 0;
  closeCount = 0;
  closeCode?: number;
  closeReason?: string;
  throwOnPing = false;
  throwOnSend = false;
  throwOnTerminate = false;
  private readonly listeners = new Map<SocketEvent | 'pong', Array<(...args: unknown[]) => void>>();

  on(event: SocketEvent | 'pong', listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...current, listener]);
  }

  send(payload: string | Uint8Array, options?: { binary?: boolean }): void {
    if (this.throwOnSend) throw new Error('send raced closed');
    this.rawSent.push({ payload, ...(options ? { options } : {}) });
    this.sent.push(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'));
  }

  close(code?: number, reason?: string): void {
    this.closeCount += 1;
    this.closeCode = code;
    this.closeReason = reason;
  }

  ping(): void {
    this.pingAttempts += 1;
    if (this.throwOnPing) throw new Error('ping raced closed');
    this.pingCount += 1;
  }

  terminate(): void {
    this.terminateAttempts += 1;
    if (this.throwOnTerminate) throw new Error('terminate raced closed');
    this.terminateCount += 1;
  }

  emit(event: SocketEvent | 'pong', ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeUpgradeSocket implements RealtimeUpgradeSocket {
  readonly writes: string[] = [];
  destroyed = false;

  write(payload: string): void {
    this.writes.push(payload);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeHttpServer implements RealtimeHttpServer {
  private upgradeListener?: (
    request: RealtimeUpgradeRequest,
    socket: RealtimeUpgradeSocket,
    head: unknown
  ) => void;

  on(
    _event: 'upgrade',
    listener: (request: RealtimeUpgradeRequest, socket: RealtimeUpgradeSocket, head: unknown) => void
  ): void {
    this.upgradeListener = listener;
  }

  upgrade(request: RealtimeUpgradeRequest, socket = new FakeUpgradeSocket(), head: unknown = 'head'): FakeUpgradeSocket {
    this.upgradeListener?.(request, socket, head);
    return socket;
  }
}

class FakeWebSocketServer implements RealtimeWebSocketServer {
  nextSocket = new FakeSocket();
  readonly upgrades: Array<{ request: RealtimeUpgradeRequest; socket: RealtimeUpgradeSocket; head: unknown }> = [];
  private connectionListener?: (socket: RealtimeSocket, request: RealtimeUpgradeRequest) => void;

  on(
    _event: 'connection',
    listener: (socket: RealtimeSocket, request: RealtimeUpgradeRequest) => void
  ): void {
    this.connectionListener = listener;
  }

  handleUpgrade(
    request: RealtimeUpgradeRequest,
    socket: RealtimeUpgradeSocket,
    head: unknown,
    listener: (socket: RealtimeSocket) => void
  ): void {
    this.upgrades.push({ request, socket, head });
    listener(this.nextSocket);
  }

  emit(_event: 'connection', socket: RealtimeSocket, request: RealtimeUpgradeRequest): void {
    this.connectionListener?.(socket, request);
  }
}

function createHarness() {
  const server = new FakeHttpServer();
  const webSocketServer = new FakeWebSocketServer();
  const contexts = new Map<RealtimeSocket, RealtimeRoomPlayer>();
  let shuttingDown = false;
  const hasValidSession = vi.fn(() => true);
  const currentAccountUser = vi.fn((): unknown | null => ({ id: 'account-1' }));
  const persistRoomsSoon = vi.fn();
  const broadcastRoom = vi.fn();
  const sendCurrentRoom = vi.fn();
  const now = vi.fn(() => 1_234);
  const onProtocolV1Message = vi.fn<(socket: RealtimeSocket, message: RealtimeClientMessage) => void>();
  const onPlayerVisible = vi.fn(() => false);
  let heartbeatCallback: (() => void) | null = null;
  const heartbeatHandle = { unref: vi.fn() };
  const scheduleInterval = vi.fn((callback: () => void) => {
    heartbeatCallback = callback;
    return heartbeatHandle;
  });
  const cancelInterval = vi.fn();

  const dispose = registerRealtimeServer({
    server,
    webSocketServer,
    hasValidSession,
    currentAccountUser,
    roomPlayer: (socket) => contexts.get(socket) ?? null,
    persistRoomsSoon,
    broadcastRoom,
    sendCurrentRoom,
    now,
    isShuttingDown: () => shuttingDown,
    onProtocolMessage: onProtocolV1Message,
    onPlayerVisible,
    scheduleInterval,
    cancelInterval
  });

  return {
    server,
    webSocketServer,
    contexts,
    hasValidSession,
    currentAccountUser,
    persistRoomsSoon,
    broadcastRoom,
    sendCurrentRoom,
    now,
    onProtocolV1Message,
    onPlayerVisible,
    scheduleInterval,
    cancelInterval,
    heartbeatHandle,
    dispose,
    heartbeat() {
      heartbeatCallback?.();
    },
    setShuttingDown(value: boolean) {
      shuttingDown = value;
    },
    connect(request: RealtimeUpgradeRequest = { url: '/rooms' }) {
      const networkSocket = server.upgrade(request);
      return { request, networkSocket, socket: webSocketServer.nextSocket };
    }
  };
}

function roomContext(socket: FakeSocket, sibling?: FakeSocket): RealtimeRoomPlayer {
  socket.roomCode = 'ABCDE';
  socket.playerId = 'player-1';
  const clients = new Set<RealtimeSocket>([socket]);
  if (sibling) {
    sibling.roomCode = 'ABCDE';
    sibling.playerId = 'player-1';
    sibling.visible = true;
    clients.add(sibling);
  }
  return {
    room: { code: 'ABCDE', clients, updatedAt: 0 },
    player: { id: 'player-1', connected: true }
  };
}

describe('serverRealtime transport seam', () => {
  it('parses message objects and rejects malformed or non-object envelopes', () => {
    expect(parseRealtimeMessage(Buffer.from('{"type":"update-state","custom":7}'))).toEqual({
      type: 'update-state',
      custom: 7
    });
    for (const raw of ['{', 'null', '42', '"message"', '[]']) expect(parseRealtimeMessage(raw)).toBeNull();
  });

  it('measures inbound client frames by UTF-8 bytes at the exact boundary', () => {
    const payload = JSON.stringify({ type: 'command', text: '🙂'.repeat(4_090) });
    const byteLength = new TextEncoder().encode(payload).byteLength;
    expect(payload.length).toBeLessThan(REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);
    expect(byteLength).toBeGreaterThan(REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);
    expect(parseRealtimeMessage(payload, byteLength)).toEqual({ type: 'command', text: '🙂'.repeat(4_090) });
    expect(parseRealtimeMessage(payload, byteLength - 1)).toBeNull();
  });

  it('serializes payloads only while the socket is open', () => {
    const socket = new FakeSocket();
    expect(sendRealtimeJson(socket, { type: 'room', revision: 3 })).toBe(true);
    socket.readyState = 3;
    expect(sendRealtimeJson(socket, { type: 'ignored' })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"room","revision":3}']);
  });

  it('uses an independent generous UTF-8 outbound public snapshot cap', () => {
    const socket = new FakeSocket();
    const largerThanInbound = { type: 'snapshot', log: ['🙂'.repeat(5_000)] };
    expect(new TextEncoder().encode(JSON.stringify(largerThanInbound)).byteLength)
      .toBeGreaterThan(REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);
    expect(sendRealtimeJson(socket, largerThanInbound)).toBe(true);

    const largerThanOutbound = {
      type: 'snapshot',
      log: ['🙂'.repeat(Math.ceil(REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES / 4))]
    };
    expect(sendRealtimeJson(socket, largerThanOutbound)).toBe(false);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closeCount).toBe(1);
    expect(socket.closeCode).toBe(REALTIME_OVERSIZED_CLOSE_CODE);
  });

  it('encodes one byte-identical public text frame for seven synchronized non-drawers', () => {
    const playerIds = ['drawer', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const sockets = playerIds.map((playerId) => {
      const socket = new FakeSocket();
      socket.playerId = playerId;
      socket.roomCode = 'ABCDE';
      socket.snapshotRoomCode = 'ABCDE';
      socket.snapshotEnvelopeVersion = 2;
      return socket;
    });
    const privateCard = { id: 'private-drawn-card-sentinel', value: 999, faceUp: true, removed: false };
    const state = {
      currentPlayerIndex: 0,
      drawnCard: privateCard,
      players: playerIds.map((id) => ({ id })),
      selectedSource: 'draw'
    } as never;
    const createSnapshot = vi.fn((_room, viewerPlayerId: string, serverNow: number) => ({
      code: 'ABCDE',
      hostId: 'drawer',
      players: playerIds.map((id, index) => ({
        id,
        name: id,
        connected: true,
        host: index === 0,
        controller: 'human',
        disconnectedAt: null,
        aiTakeoverAt: null
      })),
      chatMessages: [],
      readyForNextRoundPlayerIds: [],
      state: {
        players: playerIds.map((id) => ({ id, name: id, kind: 'human', grid: [], totalScore: 0, roundScore: 0 })),
        drawPileCount: 100,
        discardPile: { count: 1, top: null },
        currentPlayerIndex: 0,
        phase: 'choose-replacement',
        selectedSource: 'draw',
        hasDrawnCard: true,
        drawnCard: viewerPlayerId === 'drawer' ? privateCard : null,
        round: 1,
        log: [],
        winnerId: null,
        nextStarterId: null,
        roundCloserId: null,
        finalTurnPlayerIds: [],
        openingRevealCounts: {},
        roundHistory: []
      },
      status: 'playing',
      updatedAt: 1_000,
      completedGameId: null,
      finishedByAi: false,
      hostTransferAt: null,
      revision: 12,
      serverNow
    }) as never);
    const room = {
      clients: new Set(sockets),
      code: 'ABCDE',
      revision: 12,
      state,
      updatedAt: 1_000
    };
    const sendPersonalized = vi.fn((socket: RealtimeSocket, _room, snapshot) => sendRealtimeJson(socket, {
      type: 'snapshot',
      protocolVersion: 2,
      playerId: socket.playerId,
      revision: room.revision,
      room: snapshot
    }));

    const result = broadcastRealtimeSnapshots({ room, createSnapshot, sendPersonalized, now: () => 1_001 });

    expect(result).toEqual({ personalizedRecipients: 1, sharedEncodings: 1, sharedRecipients: 7 });
    expect(createSnapshot).toHaveBeenCalledTimes(2);
    expect(sendPersonalized).toHaveBeenCalledOnce();
    const drawerFrame = JSON.parse(sockets[0].sent[0]);
    expect(drawerFrame).toMatchObject({ playerId: 'drawer', room: { state: { drawnCard: privateCard } } });
    const publicPayloads = sockets.slice(1).map((socket) => socket.rawSent[0]);
    expect(publicPayloads).toHaveLength(7);
    for (const sent of publicPayloads) {
      expect(sent.payload).toBe(publicPayloads[0].payload);
      expect(sent.options).toEqual({ binary: false });
      const frame = JSON.parse(Buffer.from(sent.payload).toString('utf8'));
      expect(frame).not.toHaveProperty('playerId');
      expect(frame.room.state.drawnCard).toBeNull();
      expect(JSON.stringify(frame)).not.toContain('private-drawn-card-sentinel');
      expect(JSON.stringify(frame)).not.toContain('999');
    }
  });

  it('personalizes first sync and room-mismatched reconnects before sharing later updates', () => {
    const established = new FakeSocket();
    const firstSync = new FakeSocket();
    const rejoining = new FakeSocket();
    for (const [index, socket] of [established, firstSync, rejoining].entries()) {
      socket.playerId = `p${index + 1}`;
      socket.roomCode = 'ABCDE';
      socket.snapshotEnvelopeVersion = 2;
    }
    established.snapshotRoomCode = 'ABCDE';
    rejoining.snapshotRoomCode = 'OLD01';
    const room = {
      clients: new Set<RealtimeSocket>([established, firstSync, rejoining]),
      code: 'ABCDE',
      revision: 3,
      state: null,
      updatedAt: 1_000
    };
    const createSnapshot = vi.fn((_room, _viewerPlayerId: string, serverNow: number) => ({
      code: 'ABCDE', hostId: 'p1', players: [], chatMessages: [], readyForNextRoundPlayerIds: [],
      state: null, status: 'waiting', updatedAt: 1_000, completedGameId: null, finishedByAi: false,
      hostTransferAt: null, revision: 3, serverNow
    }) as never);
    const sendPersonalized = vi.fn((socket: RealtimeSocket, _room, snapshot) => {
      const sent = sendRealtimeJson(socket, {
        type: 'snapshot', protocolVersion: 2, playerId: socket.playerId, revision: 3, room: snapshot
      });
      if (sent) socket.snapshotRoomCode = room.code;
      return sent;
    });

    expect(broadcastRealtimeSnapshots({ room, createSnapshot, sendPersonalized, now: () => 1_001 })).toEqual({
      personalizedRecipients: 2,
      sharedEncodings: 1,
      sharedRecipients: 1
    });
    expect(JSON.parse(firstSync.sent[0]).playerId).toBe('p2');
    expect(JSON.parse(rejoining.sent[0]).playerId).toBe('p3');
    expect(JSON.parse(established.sent[0])).not.toHaveProperty('playerId');
    expect(firstSync.snapshotRoomCode).toBe('ABCDE');
    expect(rejoining.snapshotRoomCode).toBe('ABCDE');

    const resync = { type: 'resync', protocolVersion: 2, playerId: 'p2', revision: 3, room: {}, reason: 'stale-revision' };
    expect(sendRealtimeJson(firstSync, resync)).toBe(true);
    expect(JSON.parse(firstSync.sent.at(-1) || '{}')).toEqual(resync);
  });

  it('keeps immediately preceding strict protocol-v2 clients on personalized envelopes forever', () => {
    const legacySockets = [new FakeSocket(), new FakeSocket()];
    for (const [index, socket] of legacySockets.entries()) {
      socket.playerId = `legacy-p${index + 1}`;
      socket.roomCode = 'ABCDE';
      socket.snapshotRoomCode = 'ABCDE';
      // Omitted by the immediately preceding v2 client; a wrong/old version is
      // equally ineligible for anonymous envelopes.
      socket.snapshotEnvelopeVersion = index === 0 ? null : 1;
    }
    const room = {
      clients: new Set<RealtimeSocket>(legacySockets),
      code: 'ABCDE',
      revision: 4,
      state: null,
      updatedAt: 1_000
    };
    const createSnapshot = vi.fn((_room, _viewerPlayerId: string, serverNow: number) => ({
      code: 'ABCDE', hostId: 'legacy-p1', players: [], chatMessages: [], readyForNextRoundPlayerIds: [],
      state: null, status: 'waiting', updatedAt: 1_000, completedGameId: null, finishedByAi: false,
      hostTransferAt: null, revision: 4, serverNow
    }) as never);
    const sendPersonalized = vi.fn((socket: RealtimeSocket, _room, snapshot) => sendRealtimeJson(socket, {
      type: 'snapshot', protocolVersion: 2, playerId: socket.playerId, revision: 4, room: snapshot
    }));

    for (const serverNow of [1_001, 1_002]) {
      expect(broadcastRealtimeSnapshots({ room, createSnapshot, sendPersonalized, now: () => serverNow }))
        .toEqual({ personalizedRecipients: 2, sharedEncodings: 0, sharedRecipients: 0 });
    }
    for (const socket of legacySockets) {
      expect(socket.rawSent).toHaveLength(2);
      for (const sent of socket.rawSent) {
        expect(typeof sent.payload).toBe('string');
        const frame = JSON.parse(String(sent.payload));
        expect(Object.keys(frame).sort()).toEqual(
          ['type', 'protocolVersion', 'playerId', 'revision', 'room'].sort()
        );
        expect(frame.playerId).toBe(socket.playerId);
      }
    }
  });

  it('clears personalized sync on detach so a same-code rejoin cannot receive an anonymous first frame', () => {
    const socket = new FakeSocket();
    socket.playerId = 'p1';
    socket.roomCode = 'ABCDE';
    socket.snapshotRoomCode = 'ABCDE';
    socket.snapshotEnvelopeVersion = 2;
    const detachedRoom: RealtimeRoom = { clients: new Set([socket]), code: 'ABCDE', updatedAt: 1_000 };
    detachRealtimeSocket(detachedRoom, socket);
    expect(socket.snapshotRoomCode).toBeNull();
    expect(socket.snapshotEnvelopeVersion).toBeNull();

    socket.playerId = 'p1';
    socket.roomCode = 'ABCDE';
    const rejoinedRoom = {
      clients: new Set<RealtimeSocket>([socket]),
      code: 'ABCDE',
      revision: 1,
      state: null,
      updatedAt: 1_001
    };
    const sendPersonalized = vi.fn((target: RealtimeSocket) => sendRealtimeJson(target, {
      type: 'snapshot', protocolVersion: 2, playerId: target.playerId, revision: 1, room: { code: 'ABCDE' }
    }));
    expect(broadcastRealtimeSnapshots({
      room: rejoinedRoom,
      createSnapshot: () => ({ code: 'ABCDE' }) as never,
      sendPersonalized,
      now: () => 1_001
    })).toEqual({ personalizedRecipients: 1, sharedEncodings: 0, sharedRecipients: 0 });
    expect(sendPersonalized).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.sent[0]).playerId).toBe('p1');
  });

  it('sends encoded JSON as a text frame and preserves the outbound size fence', () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const encoded = encodeRealtimeJson({ type: 'snapshot', revision: 4 });
    expect(encoded).not.toBeNull();
    expect(sendRealtimeEncodedJson(first, encoded!)).toBe(true);
    expect(sendRealtimeEncodedJson(second, encoded!)).toBe(true);
    expect(first.rawSent[0].payload).toBe(second.rawSent[0].payload);
    expect(first.rawSent[0].options).toEqual({ binary: false });

    expect(sendRealtimeEncodedJson(first, new Uint8Array(5), 4)).toBe(false);
    expect(first.closeCode).toBe(REALTIME_OVERSIZED_CLOSE_CODE);
    expect(encodeRealtimeJson({ tooLarge: 'x'.repeat(10) }, 4)).toBeNull();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(encodeRealtimeJson(circular)).toBeNull();
    second.throwOnSend = true;
    expect(sendRealtimeEncodedJson(second, encoded!)).toBe(false);
  });

  it('rejects wrong-path and invalid-session upgrades before account lookup', () => {
    const harness = createHarness();
    const wrongPath = harness.server.upgrade({ url: '/not-rooms' });
    expect(wrongPath.writes).toEqual(['HTTP/1.1 401 Unauthorized\r\n\r\n']);
    expect(wrongPath.destroyed).toBe(true);
    expect(harness.hasValidSession).not.toHaveBeenCalled();

    harness.hasValidSession.mockReturnValue(false);
    const invalidSession = harness.server.upgrade({ url: '/rooms' });
    expect(invalidSession.destroyed).toBe(true);
    expect(harness.currentAccountUser).not.toHaveBeenCalled();
    expect(harness.webSocketServer.upgrades).toHaveLength(0);
  });

  it('rejects a session without an account identity', () => {
    const harness = createHarness();
    harness.currentAccountUser.mockReturnValue(null);
    const networkSocket = harness.server.upgrade({ url: '/rooms' });

    expect(networkSocket.writes).toEqual(['HTTP/1.1 401 Unauthorized\r\n\r\n']);
    expect(networkSocket.destroyed).toBe(true);
    expect(harness.webSocketServer.upgrades).toHaveLength(0);
  });

  it('upgrades an authorized account, initializes visibility, and delegates protocol-v1 commands unchanged', () => {
    const harness = createHarness();
    const { request, networkSocket, socket } = harness.connect();

    expect(request.accountUser).toEqual({ id: 'account-1' });
    expect(socket.accountUser).toBe(request.accountUser);
    expect(socket.snapshotEnvelopeVersion).toBeNull();
    expect(socket.snapshotRoomCode).toBeNull();
    expect(socket.visible).toBe(false);
    expect(harness.webSocketServer.upgrades).toEqual([{ request, socket: networkSocket, head: 'head' }]);

    socket.emit('message', '{"type":"join-room","code":"ABCDE"}');
    expect(harness.onProtocolV1Message).toHaveBeenCalledWith(socket, { type: 'join-room', code: 'ABCDE' });
  });

  it('keeps explicit-presence v2 joins hidden while rolling prior-v2 joins forward as visible', () => {
    const current = createHarness();
    const { socket: currentSocket } = current.connect();
    currentSocket.emit('message', JSON.stringify({
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'player-1'
    }));
    expect(currentSocket.visible).toBe(false);
    expect(current.onProtocolV1Message).toHaveBeenCalledOnce();

    const prior = createHarness();
    const { socket: priorSocket } = prior.connect();
    const admitted: { context: RealtimeRoomPlayer | null } = { context: null };
    prior.onProtocolV1Message.mockImplementation((admittedSocket) => {
      const priorContext = roomContext(admittedSocket as FakeSocket);
      priorContext.player.connected = false;
      priorContext.player.disconnectedAt = 100;
      prior.contexts.set(admittedSocket, priorContext);
      syncPlayerPresence(priorContext.room, priorContext.player, 500);
      prior.sendCurrentRoom(admittedSocket, priorContext.room);
      admitted.context = priorContext;
    });
    priorSocket.emit('message', JSON.stringify({
      type: 'join-room',
      protocolVersion: 2,
      code: 'ABCDE',
      name: 'Alice',
      playerId: 'player-1'
    }));
    expect(priorSocket.visible).toBe(true);
    expect(prior.onProtocolV1Message).toHaveBeenCalledOnce();
    expect(admitted.context?.player).toMatchObject({ connected: true, disconnectedAt: null, lastSeenAt: 500 });
    expect(prior.sendCurrentRoom).toHaveBeenCalledOnce();
  });

  it('returns the stable error for invalid frames and pre-join presence', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    socket.emit('message', 'not json');
    socket.emit('message', '{"type":"set-presence","visible":false}');

    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'error', protocolVersion: 2, code: 'invalid-message', message: 'Invalid message.' },
      { type: 'error', protocolVersion: 2, code: 'room-required', message: 'Join or create a room first.' }
    ]);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.onProtocolV1Message).not.toHaveBeenCalled();
  });

  it('rejects and closes an oversized multibyte command without protocol or room side effects', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);
    const beforeRoom = structuredClone({
      code: context.room.code,
      updatedAt: context.room.updatedAt,
      player: context.player
    });
    const random = vi.fn(() => 0.5);
    const databaseWrite = vi.fn();
    harness.onProtocolV1Message.mockImplementation(() => {
      random();
      databaseWrite();
      context.room.updatedAt = 9_999;
      harness.persistRoomsSoon();
      harness.broadcastRoom(context.room);
    });
    const payload = JSON.stringify({
      type: 'command',
      protocolVersion: 2,
      commandId: '10000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: { type: 'send-chat-message', text: '🙂'.repeat(4_090) }
    });
    expect(payload.length).toBeLessThan(REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);

    socket.emit('message', payload);

    expect(socket.sent).toEqual([]);
    expect(socket.closeCount).toBe(1);
    expect(socket.closeCode).toBe(REALTIME_OVERSIZED_CLOSE_CODE);
    expect(socket.closeReason).toBe('Message too large.');
    expect(harness.onProtocolV1Message).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(databaseWrite).not.toHaveBeenCalled();
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.broadcastRoom).not.toHaveBeenCalled();
    expect(harness.sendCurrentRoom).not.toHaveBeenCalled();
    expect({ code: context.room.code, updatedAt: context.room.updatedAt, player: context.player }).toEqual(beforeRoom);
  });

  it('requires exact set-presence keys without changing room state on malformed frames', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const sibling = new FakeSocket();
    const context = roomContext(socket, sibling);
    harness.contexts.set(socket, context);

    socket.emit('message', '{"type":"set-presence","visible":false}');
    expect(socket.visible).toBe(false);
    expect(context.player.connected).toBe(true);
    expect(context.room.updatedAt).toBe(0);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.broadcastRoom).not.toHaveBeenCalled();
    expect(harness.sendCurrentRoom).toHaveBeenCalledWith(socket, context.room);

    sibling.visible = false;
    socket.emit('message', '{"type":"set-presence"}');
    socket.emit('message', '{"type":"set-presence","visible":true,"extra":true}');
    expect(socket.visible).toBe(false);
    expect(context.player.connected).toBe(true);
    expect(harness.sendCurrentRoom).toHaveBeenCalledTimes(1);
    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'error', protocolVersion: 2, code: 'invalid-presence', message: 'Invalid presence.' },
      { type: 'error', protocolVersion: 2, code: 'invalid-presence', message: 'Invalid presence.' }
    ]);
  });

  it('rejects an explicitly malformed presence value without changing room state', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);

    socket.emit('message', '{"type":"set-presence","visible":"false"}');

    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'error', protocolVersion: 2, code: 'invalid-presence', message: 'Invalid presence.' }
    ]);
    expect(socket.visible).toBe(false);
    expect(context.player.connected).toBe(true);
    expect(context.room.updatedAt).toBe(0);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.broadcastRoom).not.toHaveBeenCalled();
    expect(harness.sendCurrentRoom).not.toHaveBeenCalled();
  });

  it('persists and broadcasts a genuine aggregate presence edge exactly once', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);

    socket.emit('message', '{"type":"set-presence","visible":false}');

    expect(context.player.connected).toBe(false);
    expect(context.room.updatedAt).toBe(1_234);
    expect(harness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(harness.broadcastRoom).toHaveBeenCalledWith(context.room);
    expect(harness.sendCurrentRoom).not.toHaveBeenCalled();
  });

  it('runs visible-only lifecycle reclaim and publishes its revision-neutral presence envelope once', () => {
    const harness = createHarness();
    harness.onPlayerVisible.mockReturnValue(true);
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);

    socket.emit('message', '{"type":"set-presence","visible":true}');

    expect(harness.onPlayerVisible).toHaveBeenCalledWith(context.room, context.player, 1_234);
    expect(harness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(harness.broadcastRoom).toHaveBeenCalledWith(context.room);
    expect(harness.sendCurrentRoom).not.toHaveBeenCalled();

    harness.onPlayerVisible.mockClear();
    socket.emit('message', '{"type":"set-presence","visible":false}');
    expect(harness.onPlayerVisible).not.toHaveBeenCalled();
  });

  it('keeps a seat connected when a sibling socket remains and disconnects the final socket', () => {
    const siblingHarness = createHarness();
    siblingHarness.now.mockReturnValue(2_001);
    const siblingConnection = siblingHarness.connect();
    const sibling = new FakeSocket();
    const siblingContext = roomContext(siblingConnection.socket, sibling);
    siblingHarness.contexts.set(siblingConnection.socket, siblingContext);
    siblingConnection.socket.emit('close');

    expect(siblingContext.room.clients.has(siblingConnection.socket)).toBe(false);
    expect(siblingContext.player.connected).toBe(true);
    expect(siblingContext.room.updatedAt).toBe(0);
    expect(siblingHarness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(siblingHarness.broadcastRoom).not.toHaveBeenCalled();

    const finalHarness = createHarness();
    finalHarness.now.mockReturnValue(2_002);
    const finalConnection = finalHarness.connect();
    const finalContext = roomContext(finalConnection.socket);
    finalConnection.socket.snapshotRoomCode = 'ABCDE';
    finalConnection.socket.snapshotEnvelopeVersion = 2;
    finalHarness.contexts.set(finalConnection.socket, finalContext);
    finalConnection.socket.emit('close');

    expect(finalContext.player.connected).toBe(false);
    expect(finalConnection.socket.snapshotRoomCode).toBeNull();
    expect(finalConnection.socket.snapshotEnvelopeVersion).toBeNull();
    expect(finalContext.room.updatedAt).toBe(2_002);
    expect(finalHarness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(finalHarness.broadcastRoom).toHaveBeenCalledWith(finalContext.room);
  });

  it('leaves room state untouched for shutdown and sockets without a room', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);
    harness.setShuttingDown(true);
    socket.emit('close');

    expect(context.room.clients.has(socket)).toBe(true);
    expect(context.room.updatedAt).toBe(0);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();

    const noRoomHarness = createHarness();
    noRoomHarness.connect().socket.emit('close');
    expect(noRoomHarness.now).not.toHaveBeenCalled();
    expect(noRoomHarness.broadcastRoom).not.toHaveBeenCalled();
  });

  it('ignores non-live, different-seat, and explicitly excluded sockets during presence scans', () => {
    const current = new FakeSocket();
    const wrongRoom = new FakeSocket();
    const wrongPlayer = new FakeSocket();
    const closed = new FakeSocket();
    const hidden = new FakeSocket();
    for (const socket of [current, wrongRoom, wrongPlayer, closed, hidden]) socket.visible = true;
    current.roomCode = wrongRoom.roomCode = wrongPlayer.roomCode = closed.roomCode = hidden.roomCode = 'ABCDE';
    current.playerId = wrongRoom.playerId = wrongPlayer.playerId = closed.playerId = hidden.playerId = 'player-1';
    wrongRoom.roomCode = 'OTHER';
    wrongPlayer.playerId = 'player-2';
    closed.readyState = 3;
    hidden.visible = false;
    const room: RealtimeRoom = {
      code: 'ABCDE',
      clients: new Set([current, wrongRoom, wrongPlayer, closed, hidden]),
      updatedAt: 0
    };
    const player: RealtimePlayer = { id: 'player-1', connected: true };

    expect(hasVisibleLiveClient(room, player.id, current)).toBe(false);
    syncPlayerPresence(room, player);
    expect(player.connected).toBe(true);
  });

  it('treats a live socket without the v2 visibility marker as visible for rolling compatibility', () => {
    const priorV2Socket = new FakeSocket();
    priorV2Socket.roomCode = 'ABCDE';
    priorV2Socket.playerId = 'player-1';
    delete priorV2Socket.visible;
    const room: RealtimeRoom = {
      code: 'ABCDE',
      clients: new Set([priorV2Socket]),
      updatedAt: 0
    };
    const player: RealtimePlayer = { id: 'player-1', connected: false, disconnectedAt: 100 };

    expect(hasVisibleLiveClient(room, player.id)).toBe(true);
    syncPlayerPresence(room, player, 500);
    expect(player).toMatchObject({ connected: true, disconnectedAt: null, lastSeenAt: 500 });
  });

  it('pings every interval, accepts pong, and terminates a half-open socket on the next interval', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const context = roomContext(socket);
    harness.contexts.set(socket, context);

    expect(harness.scheduleInterval).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(harness.heartbeatHandle.unref).toHaveBeenCalledOnce();

    harness.heartbeat();
    expect(socket.pingCount).toBe(1);
    expect(socket.heartbeatAwaitingPong).toBe(true);
    expect(socket.terminateCount).toBe(0);

    socket.emit('pong');
    expect(socket.heartbeatAwaitingPong).toBe(false);
    harness.heartbeat();
    expect(socket.pingCount).toBe(2);
    harness.heartbeat();
    expect(socket.terminateCount).toBe(1);
    expect(context.room.updatedAt).toBe(0);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.broadcastRoom).not.toHaveBeenCalled();
  });

  it('isolates ping and terminate races so one socket cannot abort the heartbeat sweep', () => {
    const pingHarness = createHarness();
    const throwingPing = pingHarness.connect().socket;
    throwingPing.throwOnPing = true;
    const healthyPing = new FakeSocket();
    pingHarness.webSocketServer.nextSocket = healthyPing;
    pingHarness.connect();
    expect(() => pingHarness.heartbeat()).not.toThrow();
    expect(throwingPing.pingAttempts).toBe(1);
    expect(throwingPing.terminateAttempts).toBe(1);
    expect(healthyPing.pingCount).toBe(1);
    pingHarness.heartbeat();
    expect(throwingPing.terminateAttempts).toBe(2);

    const terminateHarness = createHarness();
    const throwingTerminate = terminateHarness.connect().socket;
    throwingTerminate.heartbeatAwaitingPong = true;
    throwingTerminate.throwOnTerminate = true;
    const healthyTerminate = new FakeSocket();
    healthyTerminate.heartbeatAwaitingPong = true;
    terminateHarness.webSocketServer.nextSocket = healthyTerminate;
    terminateHarness.connect();
    healthyTerminate.heartbeatAwaitingPong = true;
    expect(() => terminateHarness.heartbeat()).not.toThrow();
    expect(throwingTerminate.terminateAttempts).toBe(1);
    expect(healthyTerminate.terminateCount).toBe(1);
    terminateHarness.heartbeat();
    expect(throwingTerminate.terminateAttempts).toBe(2);
  });

  it('removes closed sockets from heartbeat and disposes the shared timer idempotently', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    socket.emit('close');
    harness.heartbeat();
    expect(socket.pingCount).toBe(0);

    harness.dispose();
    harness.dispose();
    expect(harness.cancelInterval).toHaveBeenCalledOnce();
    harness.setShuttingDown(true);
    socket.emit('close');
    expect(harness.cancelInterval).toHaveBeenCalledOnce();
  });

  it('rejects invalid heartbeat configuration', () => {
    const harness = createHarness();
    harness.dispose();
    expect(() => registerRealtimeServer({
      server: harness.server,
      webSocketServer: harness.webSocketServer,
      hasValidSession: harness.hasValidSession,
      currentAccountUser: harness.currentAccountUser,
      roomPlayer: () => null,
      persistRoomsSoon: harness.persistRoomsSoon,
      broadcastRoom: harness.broadcastRoom,
      sendCurrentRoom: harness.sendCurrentRoom,
      now: harness.now,
      isShuttingDown: () => false,
      onProtocolMessage: harness.onProtocolV1Message,
      heartbeatIntervalMs: 0
    })).toThrow(/heartbeatIntervalMs/i);
    expect(() => registerRealtimeServer({
      server: harness.server,
      webSocketServer: harness.webSocketServer,
      hasValidSession: harness.hasValidSession,
      currentAccountUser: harness.currentAccountUser,
      roomPlayer: () => null,
      persistRoomsSoon: harness.persistRoomsSoon,
      broadcastRoom: harness.broadcastRoom,
      sendCurrentRoom: harness.sendCurrentRoom,
      now: harness.now,
      isShuttingDown: () => false,
      onProtocolMessage: harness.onProtocolV1Message,
      heartbeatIntervalMs: Number.POSITIVE_INFINITY
    })).toThrow(/heartbeatIntervalMs/i);
  });

  it('supports the production interval defaults and clears their unrefed timer', () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.dispose();
    const dispose = registerRealtimeServer({
      server: new FakeHttpServer(),
      webSocketServer: new FakeWebSocketServer(),
      hasValidSession: () => true,
      currentAccountUser: () => ({ id: 'account-1' }),
      roomPlayer: () => null,
      persistRoomsSoon: vi.fn(),
      broadcastRoom: vi.fn(),
      sendCurrentRoom: vi.fn(),
      now: () => 0,
      isShuttingDown: () => false,
      onProtocolMessage: vi.fn()
    });
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
