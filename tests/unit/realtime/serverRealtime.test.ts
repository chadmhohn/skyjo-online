import {
  hasVisibleLiveClient,
  parseRealtimeMessage,
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
  readonly sent: string[] = [];
  private readonly listeners = new Map<SocketEvent, Array<(...args: unknown[]) => void>>();

  on(event: SocketEvent, listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...current, listener]);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  emit(event: SocketEvent, ...args: unknown[]): void {
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
  const now = vi.fn(() => 1_234);
  const onProtocolV1Message = vi.fn<(socket: RealtimeSocket, message: RealtimeClientMessage) => void>();

  registerRealtimeServer({
    server,
    webSocketServer,
    hasValidSession,
    currentAccountUser,
    roomPlayer: (socket) => contexts.get(socket) ?? null,
    persistRoomsSoon,
    broadcastRoom,
    now,
    isShuttingDown: () => shuttingDown,
    onProtocolV1Message
  });

  return {
    server,
    webSocketServer,
    contexts,
    hasValidSession,
    currentAccountUser,
    persistRoomsSoon,
    broadcastRoom,
    now,
    onProtocolV1Message,
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

  it('serializes payloads only while the socket is open', () => {
    const socket = new FakeSocket();
    expect(sendRealtimeJson(socket, { type: 'room', revision: 3 })).toBe(true);
    socket.readyState = 3;
    expect(sendRealtimeJson(socket, { type: 'ignored' })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"room","revision":3}']);
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
      { type: 'error', message: 'Invalid message.' },
      { type: 'error', message: 'Join or create a room first.' }
    ]);
    expect(harness.persistRoomsSoon).not.toHaveBeenCalled();
    expect(harness.onProtocolV1Message).not.toHaveBeenCalled();
  });

  it('updates same-seat presence with an exact injected timestamp', () => {
    const harness = createHarness();
    const { socket } = harness.connect();
    const sibling = new FakeSocket();
    const context = roomContext(socket, sibling);
    harness.contexts.set(socket, context);

    socket.emit('message', '{"type":"set-presence","visible":false}');
    expect(socket.visible).toBe(false);
    expect(context.player.connected).toBe(true);
    expect(context.room.updatedAt).toBe(1_234);
    expect(harness.persistRoomsSoon).toHaveBeenCalledOnce();
    expect(harness.broadcastRoom).toHaveBeenCalledWith(context.room);

    sibling.visible = false;
    socket.emit('message', '{"type":"set-presence"}');
    expect(socket.visible).toBe(true);
    expect(context.player.connected).toBe(true);
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
    expect(siblingContext.room.updatedAt).toBe(2_001);

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
});
