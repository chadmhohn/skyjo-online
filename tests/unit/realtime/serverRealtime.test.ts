import {
  hasVisibleLiveClient,
  parseRealtimeMessage,
  REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES,
  REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES,
  REALTIME_OVERSIZED_CLOSE_CODE,
  registerRealtimeServer,
  sendRealtimeJson,
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
  visible?: boolean;
  heartbeatAwaitingPong?: boolean;
  readonly sent: string[] = [];
  pingCount = 0;
  pingAttempts = 0;
  terminateCount = 0;
  terminateAttempts = 0;
  closeCount = 0;
  closeCode?: number;
  closeReason?: string;
  throwOnPing = false;
  throwOnTerminate = false;
  private readonly listeners = new Map<SocketEvent | 'pong', Array<(...args: unknown[]) => void>>();

  on(event: SocketEvent | 'pong', listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...current, listener]);
  }

  send(payload: string): void {
    this.sent.push(payload);
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
    expect(socket.visible).toBe(true);
    expect(harness.webSocketServer.upgrades).toEqual([{ request, socket: networkSocket, head: 'head' }]);

    socket.emit('message', '{"type":"join-room","code":"ABCDE"}');
    expect(harness.onProtocolV1Message).toHaveBeenCalledWith(socket, { type: 'join-room', code: 'ABCDE' });
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

  it('targeted-resynchronizes redundant same-seat presence without persistence or peer broadcast', () => {
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
    expect(socket.visible).toBe(true);
    expect(context.player.connected).toBe(true);
    expect(harness.sendCurrentRoom).toHaveBeenCalledTimes(2);
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
    expect(socket.visible).toBe(true);
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
    finalHarness.contexts.set(finalConnection.socket, finalContext);
    finalConnection.socket.emit('close');

    expect(finalContext.player.connected).toBe(false);
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
