import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const accessPassword = process.env.SKYJO_ACCESS_PASSWORD;
const sessionSecret = process.env.SKYJO_SESSION_SECRET;
const cookieName = process.env.SKYJO_COOKIE_NAME || 'skyjo_session';
const sessionTtlMs = Number(process.env.SKYJO_SESSION_TTL_HOURS || 24 * 14) * 60 * 60 * 1000;
const secureCookies = process.env.SKYJO_SECURE_COOKIES !== 'false';
const rooms = new Map();

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);

if (!accessPassword || !sessionSecret) {
  console.error('Missing SKYJO_ACCESS_PASSWORD or SKYJO_SESSION_SECRET.');
  console.error('Set both env vars before running npm start.');
  process.exit(1);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSessionCookie() {
  const expiresAt = Date.now() + sessionTtlMs;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
  }
  return cookies;
}

function hasValidSession(req) {
  const token = parseCookies(req.headers.cookie).get(cookieName);
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiresAtRaw, nonce, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !nonce) return false;

  const payload = `${expiresAtRaw}.${nonce}`;
  return timingSafeEqualString(signature, sign(payload));
}

function cookieHeader(value, maxAgeSeconds) {
  const secure = secureCookies ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? makeRoomCode() : code;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    state: room.state,
    status: room.status,
    updatedAt: room.updatedAt
  };
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room) {
  const payload = JSON.stringify({ type: 'room', room: publicRoom(room) });
  for (const client of room.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function roomPlayer(ws) {
  if (!ws.roomCode || !ws.playerId) return null;
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const player = room.players.find((item) => item.id === ws.playerId);
  return player ? { room, player } : null;
}

function renderLogin(error = false) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Skyjo Online</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #1d4ed8 0, #111827 48%, #020617 100%);
        color: #f8fafc;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(92vw, 360px); }
      h1 { margin: 0 0 8px; font-size: 48px; letter-spacing: 0; }
      p { margin: 0 0 24px; color: #bfdbfe; }
      form { display: grid; gap: 12px; }
      input, button {
        width: 100%;
        box-sizing: border-box;
        border: 0;
        border-radius: 8px;
        font: inherit;
        min-height: 44px;
      }
      input { padding: 0 12px; background: #f8fafc; color: #0f172a; }
      button { background: #38bdf8; color: #082f49; font-weight: 700; cursor: pointer; }
      .error { margin-top: 12px; color: #fecaca; }
    </style>
  </head>
  <body>
    <main>
      <h1>SKYJO</h1>
      <p>Enter the shared game password.</p>
      <form method="post" action="/login">
        <input name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Continue</button>
      </form>
      ${error ? '<div class="error">That password did not work.</div>' : ''}
    </main>
  </body>
</html>`;
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(req, res) {
  const parsed = new URL(req.url || '/', 'http://localhost');
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requestedPath = path.normalize(path.join(distDir, pathname));
  const inDist = requestedPath === distDir || requestedPath.startsWith(`${distDir}${path.sep}`);
  if (!inDist) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let filePath = requestedPath;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(distDir, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'Content-Type': mimeTypes.get(ext) || 'application/octet-stream'
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (url.pathname === '/logout') {
      send(res, 302, '', {
        Location: '/login',
        'Set-Cookie': cookieHeader('', 0)
      });
      return;
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      send(res, 200, renderLogin(url.searchParams.get('error') === '1'), {
        'Content-Type': 'text/html; charset=utf-8'
      });
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const form = new URLSearchParams(body);
      const password = form.get('password') || '';
      if (!timingSafeEqualString(password, accessPassword)) {
        send(res, 303, '', { Location: '/login?error=1' });
        return;
      }
      send(res, 303, '', {
        Location: '/',
        'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
      });
      return;
    }

    if (!hasValidSession(req)) {
      send(res, 302, '', { Location: '/login' });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    send(res, 500, 'Internal server error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/rooms' || !hasValidSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid message.' });
      return;
    }

    if (message.type === 'create-room') {
      const code = makeRoomCode();
      const playerId = crypto.randomUUID();
      const name = String(message.name || 'Player').trim().slice(0, 24) || 'Player';
      const room = {
        code,
        hostId: playerId,
        players: [{ id: playerId, name, connected: true, host: true }],
        state: null,
        status: 'waiting',
        updatedAt: Date.now(),
        clients: new Set([ws])
      };
      rooms.set(code, room);
      ws.roomCode = code;
      ws.playerId = playerId;
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
      if (room.status !== 'waiting' && !message.playerId) {
        sendJson(ws, { type: 'error', message: 'That game has already started.' });
        return;
      }
      const name = String(message.name || 'Player').trim().slice(0, 24) || 'Player';
      let player = message.playerId ? room.players.find((item) => item.id === message.playerId) : null;
      if (!player) {
        if (room.players.length >= 8) {
          sendJson(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        player = { id: crypto.randomUUID(), name, connected: true, host: false };
        room.players.push(player);
      }
      player.name = name;
      player.connected = true;
      room.clients.add(ws);
      room.updatedAt = Date.now();
      ws.roomCode = code;
      ws.playerId = player.id;
      sendJson(ws, { type: 'joined', playerId: player.id, room: publicRoom(room) });
      broadcastRoom(room);
      return;
    }

    const context = roomPlayer(ws);
    if (!context) {
      sendJson(ws, { type: 'error', message: 'Join or create a room first.' });
      return;
    }
    const { room, player } = context;

    if (message.type === 'start-game') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can start the game.' });
        return;
      }
      if (!message.state || room.players.length < 2) {
        sendJson(ws, { type: 'error', message: 'Need at least two players.' });
        return;
      }
      room.state = message.state;
      room.status = 'playing';
      room.updatedAt = Date.now();
      broadcastRoom(room);
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
      room.state = message.state;
      room.status = message.state.phase === 'game-over' ? 'finished' : 'playing';
      room.updatedAt = Date.now();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'reset-room') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can reset the room.' });
        return;
      }
      room.state = null;
      room.status = 'waiting';
      room.updatedAt = Date.now();
      broadcastRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    const context = roomPlayer(ws);
    if (!context) return;
    const { room, player } = context;
    room.clients.delete(ws);
    player.connected = false;
    room.updatedAt = Date.now();
    if (room.clients.size === 0 && room.status === 'waiting') {
      rooms.delete(room.code);
      return;
    }
    broadcastRoom(room);
  });
});

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60 * 6;
  for (const [code, room] of rooms.entries()) {
    if (room.updatedAt < cutoff && room.clients.size === 0) rooms.delete(code);
  }
}, 1000 * 60 * 30).unref();

server.listen(port, host, () => {
  console.log(`Skyjo Online serving ${distDir}`);
  console.log(`Listening on http://${host}:${port}`);
});
