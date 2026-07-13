export type RealtimeClientMessage = Record<string, unknown>;

export interface RealtimeSocket {
  readonly OPEN: number;
  readonly readyState: number;
  accountUser?: unknown;
  playerId?: string | null;
  roomCode?: string | null;
  visible?: boolean;
  heartbeatAwaitingPong?: boolean;
  on(event: 'message' | 'close' | 'pong', listener: (...args: unknown[]) => void): unknown;
  ping(): unknown;
  send(payload: string): unknown;
  terminate(): unknown;
}

export interface RealtimePlayer {
  connected: boolean;
  id: string;
}

export interface RealtimeRoom {
  clients: Set<RealtimeSocket>;
  code: string;
  updatedAt: number;
}

export interface RealtimeRoomPlayer {
  player: RealtimePlayer;
  room: RealtimeRoom;
}

export interface RealtimeUpgradeRequest {
  accountUser?: unknown;
  url?: string;
}

export interface RealtimeUpgradeSocket {
  destroy(): unknown;
  write(payload: string): unknown;
}

export interface RealtimeHttpServer {
  on(
    event: 'upgrade',
    listener: (request: RealtimeUpgradeRequest, socket: RealtimeUpgradeSocket, head: unknown) => void
  ): unknown;
}

export interface RealtimeWebSocketServer {
  emit(event: 'connection', socket: RealtimeSocket, request: RealtimeUpgradeRequest): unknown;
  handleUpgrade(
    request: RealtimeUpgradeRequest,
    socket: RealtimeUpgradeSocket,
    head: unknown,
    listener: (socket: RealtimeSocket) => void
  ): unknown;
  on(
    event: 'connection',
    listener: (socket: RealtimeSocket, request: RealtimeUpgradeRequest) => void
  ): unknown;
}

export interface RealtimeServerOptions {
  server: RealtimeHttpServer;
  webSocketServer: RealtimeWebSocketServer;
  hasValidSession: (request: RealtimeUpgradeRequest) => boolean;
  currentAccountUser: (request: RealtimeUpgradeRequest) => unknown | null;
  roomPlayer: (socket: RealtimeSocket) => RealtimeRoomPlayer | null;
  persistRoomsSoon: () => unknown;
  broadcastRoom: (room: RealtimeRoom) => unknown;
  sendCurrentRoom: (socket: RealtimeSocket, room: RealtimeRoom) => unknown;
  now: () => number;
  isShuttingDown: () => boolean;
  onProtocolV1Message: (socket: RealtimeSocket, message: RealtimeClientMessage) => void;
  heartbeatIntervalMs?: number;
  scheduleInterval?: (callback: () => void, intervalMs: number) => unknown;
  cancelInterval?: (handle: unknown) => void;
}

export const REALTIME_HEARTBEAT_INTERVAL_MS = 15_000;

export function sendRealtimeJson(socket: RealtimeSocket, payload: unknown): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

export function parseRealtimeMessage(raw: unknown): RealtimeClientMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return null;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  return message as RealtimeClientMessage;
}

export function hasVisibleLiveClient(
  room: RealtimeRoom,
  playerId: string,
  currentSocket: RealtimeSocket | null = null
): boolean {
  for (const client of room.clients) {
    if (client === currentSocket) continue;
    if (client.roomCode !== room.code || client.playerId !== playerId) continue;
    if (client.readyState === client.OPEN && client.visible !== false) return true;
  }
  return false;
}

export function syncPlayerPresence(room: RealtimeRoom, player: RealtimePlayer): void {
  player.connected = hasVisibleLiveClient(room, player.id);
}

function rejectUpgrade(socket: RealtimeUpgradeSocket): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  socket.destroy();
}

export function registerRealtimeServer({
  server,
  webSocketServer,
  hasValidSession,
  currentAccountUser,
  roomPlayer,
  persistRoomsSoon,
  broadcastRoom,
  sendCurrentRoom,
  now,
  isShuttingDown,
  onProtocolV1Message,
  heartbeatIntervalMs = REALTIME_HEARTBEAT_INTERVAL_MS,
  scheduleInterval = (callback, intervalMs) => setInterval(callback, intervalMs),
  cancelInterval = (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}: RealtimeServerOptions): () => void {
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new TypeError('heartbeatIntervalMs must be a positive finite number.');
  }
  const liveSockets = new Set<RealtimeSocket>();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/rooms' || !hasValidSession(request)) {
      rejectUpgrade(socket);
      return;
    }
    const accountUser = currentAccountUser(request);
    if (!accountUser) {
      rejectUpgrade(socket);
      return;
    }
    request.accountUser = accountUser;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket, request) => {
    socket.accountUser = request.accountUser;
    socket.visible = true;
    socket.heartbeatAwaitingPong = false;
    liveSockets.add(socket);

    socket.on('pong', () => {
      socket.heartbeatAwaitingPong = false;
    });

    socket.on('message', (raw) => {
      const message = parseRealtimeMessage(raw);
      if (!message) {
        sendRealtimeJson(socket, { type: 'error', message: 'Invalid message.' });
        return;
      }

      if (message.type === 'set-presence') {
        const context = roomPlayer(socket);
        if (!context) {
          sendRealtimeJson(socket, { type: 'error', message: 'Join or create a room first.' });
          return;
        }
        if ('visible' in message && typeof message.visible !== 'boolean') {
          sendRealtimeJson(socket, { type: 'error', message: 'Invalid presence.' });
          return;
        }
        const wasConnected = context.player.connected;
        socket.visible = message.visible !== false;
        syncPlayerPresence(context.room, context.player);
        if (context.player.connected !== wasConnected) {
          context.room.updatedAt = now();
          persistRoomsSoon();
          broadcastRoom(context.room);
        } else {
          sendCurrentRoom(socket, context.room);
        }
        return;
      }

      onProtocolV1Message(socket, message);
    });

    socket.on('close', () => {
      liveSockets.delete(socket);
      if (isShuttingDown()) return;
      const context = roomPlayer(socket);
      if (!context) return;
      context.room.clients.delete(socket);
      const wasConnected = context.player.connected;
      syncPlayerPresence(context.room, context.player);
      if (context.player.connected !== wasConnected) {
        context.room.updatedAt = now();
        persistRoomsSoon();
        broadcastRoom(context.room);
      }
    });
  });

  const heartbeatTimer = scheduleInterval(() => {
    for (const socket of liveSockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.heartbeatAwaitingPong) {
        try {
          socket.terminate();
        } catch {
          // A racing socket stays tracked so the next heartbeat or close can converge it.
        }
        continue;
      }
      socket.heartbeatAwaitingPong = true;
      try {
        socket.ping();
      } catch {
        try {
          socket.terminate();
        } catch {
          // A racing socket stays tracked so the next heartbeat or close can converge it.
        }
      }
    }
  }, heartbeatIntervalMs);
  if (heartbeatTimer && typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
    const unref = (heartbeatTimer as { unref?: () => unknown }).unref;
    unref?.call(heartbeatTimer);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    cancelInterval(heartbeatTimer);
    liveSockets.clear();
  };
}
