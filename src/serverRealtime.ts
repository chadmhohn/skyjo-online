export type RealtimeClientMessage = Record<string, unknown>;

export interface RealtimeSocket {
  readonly OPEN: number;
  readonly readyState: number;
  accountUser?: unknown;
  playerId?: string | null;
  roomCode?: string | null;
  visible?: boolean;
  on(event: 'message' | 'close', listener: (...args: unknown[]) => void): unknown;
  send(payload: string): unknown;
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
  now: () => number;
  isShuttingDown: () => boolean;
  onProtocolV1Message: (socket: RealtimeSocket, message: RealtimeClientMessage) => void;
}

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
  now,
  isShuttingDown,
  onProtocolV1Message
}: RealtimeServerOptions): void {
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
        socket.visible = message.visible !== false;
        syncPlayerPresence(context.room, context.player);
        context.room.updatedAt = now();
        persistRoomsSoon();
        broadcastRoom(context.room);
        return;
      }

      onProtocolV1Message(socket, message);
    });

    socket.on('close', () => {
      if (isShuttingDown()) return;
      const context = roomPlayer(socket);
      if (!context) return;
      context.room.clients.delete(socket);
      if (!hasVisibleLiveClient(context.room, context.player.id, socket)) {
        context.player.connected = false;
      }
      context.room.updatedAt = now();
      persistRoomsSoon();
      broadcastRoom(context.room);
    });
  });
}
