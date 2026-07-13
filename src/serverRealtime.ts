import {
  MAX_INBOUND_CLIENT_FRAME_BYTES,
  MULTIPLAYER_PROTOCOL_VERSION
} from './protocolV2.js';
import { presenceFields } from './serverRoomLifecycle.js';

export type RealtimeClientMessage = Record<string, unknown>;

export interface RealtimeSocket {
  readonly OPEN: number;
  readonly readyState: number;
  accountUser?: unknown;
  admittedRoomCode?: string | null;
  playerId?: string | null;
  roomCode?: string | null;
  visible?: boolean;
  heartbeatAwaitingPong?: boolean;
  on(event: 'message' | 'close' | 'pong', listener: (...args: unknown[]) => void): unknown;
  close?(code?: number, reason?: string): unknown;
  ping(): unknown;
  send(payload: string): unknown;
  terminate(): unknown;
}

export interface RealtimePlayer {
  connected: boolean;
  disconnectedAt?: number | null;
  id: string;
  lastSeenAt?: number;
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
  onProtocolMessage: (socket: RealtimeSocket, message: RealtimeClientMessage) => void;
  onPlayerVisible?: (room: RealtimeRoom, player: RealtimePlayer, timestamp: number) => boolean;
  heartbeatIntervalMs?: number;
  scheduleInterval?: (callback: () => void, intervalMs: number) => unknown;
  cancelInterval?: (handle: unknown) => void;
}

export const REALTIME_HEARTBEAT_INTERVAL_MS = 15_000;
// Client commands stay deliberately small. Public server snapshots use the
// separate outbound budget below and must never be constrained by this limit.
export const REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES = MAX_INBOUND_CLIENT_FRAME_BYTES;
export const REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES = 1_024 * 1_024;
export const REALTIME_OVERSIZED_CLOSE_CODE = 1_009;

export function sendRealtimeJson(
  socket: RealtimeSocket,
  payload: unknown,
  maxPayloadBytes = REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES
): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) return false;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== 'string') return false;
    if (new TextEncoder().encode(serialized).byteLength > maxPayloadBytes) {
      closeOversizedSocket(socket);
      return false;
    }
    socket.send(serialized);
    return true;
  } catch {
    return false;
  }
}

export function parseRealtimeMessage(
  raw: unknown,
  maxPayloadBytes = REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES
): RealtimeClientMessage | null {
  return parseRealtimeFrame(raw, maxPayloadBytes).message;
}

function parseRealtimeFrame(
  raw: unknown,
  maxPayloadBytes: number
): { message: RealtimeClientMessage | null; oversized: boolean } {
  const payload = String(raw);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    return { message: null, oversized: false };
  }
  if (new TextEncoder().encode(payload).byteLength > maxPayloadBytes) {
    return { message: null, oversized: true };
  }
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return { message: null, oversized: false };
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { message: null, oversized: false };
  }
  return { message: message as RealtimeClientMessage, oversized: false };
}

function closeOversizedSocket(socket: RealtimeSocket): void {
  try {
    if (socket.close) {
      socket.close(REALTIME_OVERSIZED_CLOSE_CODE, 'Message too large.');
      return;
    }
    socket.terminate();
  } catch {
    try {
      socket.terminate();
    } catch {
      // A racing close has already removed the oversized client.
    }
  }
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

export function syncPlayerPresence(room: RealtimeRoom, player: RealtimePlayer, now = Date.now()): void {
  Object.assign(player, presenceFields(player, hasVisibleLiveClient(room, player.id), now));
}

export function detachRealtimeSocket(room: RealtimeRoom, socket: RealtimeSocket): void {
  room.clients.delete(socket);
  socket.roomCode = null;
  socket.playerId = null;
  socket.admittedRoomCode = null;
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
  onProtocolMessage,
  onPlayerVisible = () => false,
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
    // Presence is established explicitly after the first authoritative snapshot.
    // This prevents a hidden reconnect from resetting grace timers or reclaiming AI.
    socket.visible = false;
    socket.heartbeatAwaitingPong = false;
    liveSockets.add(socket);

    socket.on('pong', () => {
      socket.heartbeatAwaitingPong = false;
    });

    socket.on('message', (raw) => {
      const parsed = parseRealtimeFrame(raw, REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES);
      const message = parsed.message;
      if (!message) {
        if (parsed.oversized) {
          closeOversizedSocket(socket);
          return;
        }
        sendRealtimeJson(socket, { type: 'error', protocolVersion: 2, code: 'invalid-message', message: 'Invalid message.' });
        return;
      }

      if (message.type === 'set-presence') {
        const context = roomPlayer(socket);
        if (!context) {
          sendRealtimeJson(socket, { type: 'error', protocolVersion: 2, code: 'room-required', message: 'Join or create a room first.' });
          return;
        }
        if ('visible' in message && typeof message.visible !== 'boolean') {
          sendRealtimeJson(socket, { type: 'error', protocolVersion: 2, code: 'invalid-presence', message: 'Invalid presence.' });
          return;
        }
        const wasConnected = context.player.connected;
        socket.visible = message.visible !== false;
        const timestamp = now();
        syncPlayerPresence(context.room, context.player, timestamp);
        const lifecycleChanged = message.visible === true && context.player.connected
          ? onPlayerVisible(context.room, context.player, timestamp)
          : false;
        if (context.player.connected !== wasConnected || lifecycleChanged) {
          context.room.updatedAt = timestamp;
          persistRoomsSoon();
          broadcastRoom(context.room);
        } else {
          sendCurrentRoom(socket, context.room);
        }
        return;
      }

      if (
        message.type === 'join-room' &&
        message.protocolVersion === MULTIPLAYER_PROTOCOL_VERSION &&
        !Object.prototype.hasOwnProperty.call(message, 'presenceVersion')
      ) {
        // Protocol-v2 clients deployed before explicit presence support remain
        // visible during a rolling upgrade. New clients advertise the marker
        // and publish their foreground state after the first snapshot.
        socket.visible = true;
      }

      onProtocolMessage(socket, message);
    });

    socket.on('close', () => {
      liveSockets.delete(socket);
      if (isShuttingDown()) return;
      const context = roomPlayer(socket);
      if (!context) return;
      detachRealtimeSocket(context.room, socket);
      const wasConnected = context.player.connected;
      syncPlayerPresence(context.room, context.player, now());
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
