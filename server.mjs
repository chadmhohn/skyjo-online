import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';
import { WebSocketServer } from 'ws';
import {
  createInitialRoomState,
  createNextRoundRoomState,
  validateMultiplayerStateUpdate
} from './server-dist/serverValidation.js';
import {
  loadRoomsFromDisk,
  resolveRoomsFilePath,
  ROOM_STALE_MS,
  saveRoomsToDisk
} from './server-room-persistence.mjs';
import {
  createAccountStore,
  resolveAccountDatabasePath
} from './server-account-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const accessPassword = process.env.SKYJO_ACCESS_PASSWORD;
const sessionSecret = process.env.SKYJO_SESSION_SECRET;
const inviteSecret = process.env.SKYJO_INVITE_SECRET || sessionSecret;
const cookieName = process.env.SKYJO_COOKIE_NAME || 'skyjo_session';
const sessionTtlMs = Number(process.env.SKYJO_SESSION_TTL_HOURS || 24 * 14) * 60 * 60 * 1000;
const inviteTtlMs = Number(process.env.SKYJO_INVITE_TTL_HOURS || 24 * 7) * 60 * 60 * 1000;
const inviteCodeTtlMs = Number(process.env.SKYJO_INVITE_CODE_TTL_MINUTES || 30) * 60 * 1000;
const accountCookieName = process.env.SKYJO_ACCOUNT_COOKIE_NAME || 'skyjo_account';
const accountSessionTtlMs = Number(process.env.SKYJO_ACCOUNT_SESSION_TTL_HOURS || 24 * 14) * 60 * 60 * 1000;
const adminEmail = process.env.SKYJO_ADMIN_EMAIL || 'chad.hohn@groundworkrevops.com';
const adminInitialPassword = process.env.SKYJO_ADMIN_INITIAL_PASSWORD || '';
const secureCookies = process.env.SKYJO_SECURE_COOKIES !== 'false';
const vapidPublicKey = process.env.SKYJO_VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.SKYJO_VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.SKYJO_VAPID_SUBJECT || `mailto:${adminEmail}`;
const pushNotificationsEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
const rooms = new Map();
const roomsFile = resolveRoomsFilePath();
const accountDatabaseFile = resolveAccountDatabasePath();
const roomsSaveDebounceMs = 250;
const maxRoomChatMessages = 80;
const maxRoomChatMessageLength = 280;
const inviteCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const inviteCodeLength = 7;
const inviteInstallCodes = new Map();
let roomsSaveTimer = null;
let roomsSaveQueue = Promise.resolve();
let shuttingDown = false;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
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

if (pushNotificationsEnabled) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.warn('Web Push is disabled. Set SKYJO_VAPID_PUBLIC_KEY and SKYJO_VAPID_PRIVATE_KEY to enable notifications.');
}

const accountStore = await createAccountStore({ filePath: accountDatabaseFile });
try {
  const bootstrappedAdmin = await accountStore.bootstrapAdmin({ email: adminEmail, password: adminInitialPassword });
  if (bootstrappedAdmin) {
    console.log(`Admin account ready for ${bootstrappedAdmin.email}`);
  } else {
    console.warn('No admin account was bootstrapped. Set SKYJO_ADMIN_INITIAL_PASSWORD before first production account setup.');
  }
} catch (error) {
  console.error('Failed to bootstrap admin account:', error);
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

function signInvite(value) {
  return crypto.createHmac('sha256', inviteSecret).update(value).digest('base64url');
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

function accountCookieHeader(value, maxAgeSeconds) {
  const secure = secureCookies ? '; Secure' : '';
  return `${accountCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function accountToken(req) {
  return parseCookies(req.headers.cookie).get(accountCookieName) || '';
}

function isPublicPwaAsset(pathname) {
  return pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname.startsWith('/skyjo-icon');
}

function currentAccountUser(req) {
  const token = accountToken(req);
  if (!token) return null;
  return accountStore.getUserBySessionToken(token);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJsonResponse(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? makeRoomCode() : code;
}

function cleanServerRoomCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
}

function cleanInviteInstallCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, inviteCodeLength);
}

function createInviteInstallCodeValue() {
  let code = '';
  for (let index = 0; index < inviteCodeLength; index += 1) {
    code += inviteCodeAlphabet[Math.floor(Math.random() * inviteCodeAlphabet.length)];
  }
  return code;
}

function pruneInviteInstallCodes(timestamp = Date.now()) {
  for (const [code, invite] of inviteInstallCodes) {
    if (invite.expiresAt <= timestamp) inviteInstallCodes.delete(code);
  }
}

function createRoomInviteToken(roomCode) {
  const cleanRoom = cleanServerRoomCode(roomCode);
  if (cleanRoom.length !== 5) throw new Error('Room code is not valid.');
  const expiresAt = Date.now() + inviteTtlMs;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      room: cleanRoom,
      exp: expiresAt,
      nonce: crypto.randomBytes(16).toString('base64url')
    })
  ).toString('base64url');
  return {
    token: `${payload}.${signInvite(payload)}`,
    expiresAt
  };
}

function parseRoomInvitePayload(token, { verifySignature }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  if (verifySignature && !timingSafeEqualString(signature, signInvite(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const room = cleanServerRoomCode(parsed?.room);
    const expiresAt = Number(parsed?.exp);
    if (room.length !== 5 || !Number.isFinite(expiresAt)) return null;
    if (verifySignature && expiresAt < Date.now()) return null;
    return { room, expiresAt };
  } catch {
    return null;
  }
}

function getOrCreateInviteInstallCode(token, invite) {
  const timestamp = Date.now();
  pruneInviteInstallCodes(timestamp);
  for (const [code, savedInvite] of inviteInstallCodes) {
    if (savedInvite.token === token && savedInvite.expiresAt > timestamp) {
      return { code, expiresAt: savedInvite.expiresAt };
    }
  }

  const expiresAt = Math.min(invite.expiresAt, timestamp + inviteCodeTtlMs);
  let code = createInviteInstallCodeValue();
  while (inviteInstallCodes.has(code)) {
    code = createInviteInstallCodeValue();
  }
  inviteInstallCodes.set(code, { token, room: invite.room, expiresAt });
  return { code, expiresAt };
}

function roomInviteTokenFromUrl(url) {
  if (url.pathname.startsWith('/invite/')) return decodeURIComponent(url.pathname.slice('/invite/'.length));
  return url.searchParams.get('invite') || '';
}

function sendInviteRoomAccess(res, roomCode) {
  send(res, 303, '', {
    Location: `/lobby?room=${encodeURIComponent(roomCode)}`,
    'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
  });
}

function handleRoomInviteAccess(res, url, { landing = false } = {}) {
  const token = roomInviteTokenFromUrl(url);
  if (!token) return false;

  const invite = parseRoomInvitePayload(token, { verifySignature: true });
  if (!invite) {
    const untrustedInvite = parseRoomInvitePayload(token, { verifySignature: false });
    const next = untrustedInvite?.room ? `/lobby?room=${encodeURIComponent(untrustedInvite.room)}` : '/';
    send(res, 302, '', { Location: `/login?next=${encodeURIComponent(next)}` });
    return true;
  }

  if (landing && url.searchParams.get('open') !== 'browser') {
    const installCode = getOrCreateInviteInstallCode(token, invite);
    send(res, 200, renderInviteLanding({ token, invite, installCode }), {
      'Content-Type': 'text/html; charset=utf-8'
    });
    return true;
  }

  sendInviteRoomAccess(res, invite.room);
  return true;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players,
    chatMessages: room.chatMessages || [],
    readyForNextRoundPlayerIds: Array.isArray(room.readyForNextRoundPlayerIds) ? room.readyForNextRoundPlayerIds : [],
    state: room.state,
    status: room.status,
    updatedAt: room.updatedAt,
    completedGameId: room.completedGameId || null
  };
}

function gamePlayerIds(room) {
  const players = Array.isArray(room.state?.players) && room.state.players.length > 0 ? room.state.players : room.players;
  return players.map((player) => player.id);
}

function normalizedReadyIds(room) {
  const validIds = new Set(gamePlayerIds(room));
  const current = Array.isArray(room.readyForNextRoundPlayerIds) ? room.readyForNextRoundPlayerIds : [];
  return current.filter((id, index, ids) => validIds.has(id) && ids.indexOf(id) === index);
}

function allPlayersReadyForNextRound(room) {
  const playerIds = gamePlayerIds(room);
  const readyIds = new Set(normalizedReadyIds(room));
  return playerIds.length > 0 && playerIds.every((id) => readyIds.has(id));
}

function setPlayerReadyForNextRound(room, playerId, ready) {
  const current = new Set(normalizedReadyIds(room));
  if (ready) current.add(playerId);
  else current.delete(playerId);
  room.readyForNextRoundPlayerIds = [...current];
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

function queueRoomsSave() {
  roomsSaveQueue = roomsSaveQueue
    .catch(() => {})
    .then(() => saveRoomsToDisk(rooms, roomsFile))
    .catch((error) => {
      console.error('Failed to persist rooms:', error);
    });
  return roomsSaveQueue;
}

function persistRoomsSoon() {
  if (roomsSaveTimer) return;
  roomsSaveTimer = setTimeout(() => {
    roomsSaveTimer = null;
    void queueRoomsSave();
  }, roomsSaveDebounceMs);
  roomsSaveTimer.unref();
}

async function flushRoomPersistence() {
  if (roomsSaveTimer) {
    clearTimeout(roomsSaveTimer);
    roomsSaveTimer = null;
  }
  await queueRoomsSave();
}

function markAllPlayersDisconnected() {
  for (const room of rooms.values()) {
    room.clients.clear();
    for (const player of room.players) {
      player.connected = false;
    }
  }
}

function roomPlayer(ws) {
  if (!ws.roomCode || !ws.playerId) return null;
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const player = room.players.find((item) => item.id === ws.playerId);
  return player ? { room, player } : null;
}

function createWaitingRoom({ code, hostPlayer, ws }) {
  return {
    code,
    hostId: hostPlayer.id,
    players: [{ id: hostPlayer.id, userId: hostPlayer.userId, name: hostPlayer.name, connected: true, host: true }],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: Date.now(),
    completedGameId: null,
    gameSessionId: null,
    clients: new Set([ws])
  };
}

function hasVisibleLiveClient(room, playerId, currentWs = null) {
  for (const client of room.clients) {
    if (client === currentWs) continue;
    if (client.roomCode !== room.code || client.playerId !== playerId) continue;
    if (client.readyState === client.OPEN && client.visible !== false) return true;
  }
  return false;
}

function syncPlayerPresence(room, player) {
  player.connected = hasVisibleLiveClient(room, player.id);
}

async function sendPushToUsers(userIds, payload) {
  if (!pushNotificationsEnabled) return;
  const subscriptions = accountStore.listPushSubscriptionsForUsers(userIds);
  if (subscriptions.length === 0) return;
  await Promise.all(
    subscriptions.map(async ({ endpoint, subscription }) => {
      try {
        await webPush.sendNotification(subscription, JSON.stringify(payload));
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          accountStore.deletePushSubscription(endpoint);
          return;
        }
        console.warn('Failed to send push notification:', error?.message || error);
      }
    })
  );
}

function awayUserIdsForPlayers(room, playerIds) {
  const targetPlayerIds = new Set(playerIds.filter(Boolean));
  return room.players
    .filter((player) => targetPlayerIds.has(player.id) && player.userId && !hasVisibleLiveClient(room, player.id))
    .map((player) => player.userId);
}

function notifyAwayPlayersAfterMove(room, actor, nextState) {
  if (!nextState || !Array.isArray(nextState.players)) return;
  const url = `/lobby?room=${encodeURIComponent(room.code)}`;
  if (nextState.phase === 'round-over' || nextState.phase === 'game-over') {
    const targetUserIds = awayUserIdsForPlayers(
      room,
      room.players.filter((player) => player.id !== actor.id).map((player) => player.id)
    );
    const title = nextState.phase === 'game-over' ? 'Skyjo game finished' : 'Skyjo round ended';
    void sendPushToUsers(targetUserIds, {
      title,
      body: `${actor.name} played in room ${room.code}.`,
      tag: `skyjo-${room.code}-${nextState.phase}`,
      url
    });
    return;
  }

  const activePlayer = nextState.players[nextState.currentPlayerIndex];
  if (!activePlayer || activePlayer.id === actor.id) return;
  const targetUserIds = awayUserIdsForPlayers(room, [activePlayer.id]);
  void sendPushToUsers(targetUserIds, {
    title: 'Your turn in Skyjo',
    body: `${actor.name} played. Tap to take your turn.`,
    tag: `skyjo-${room.code}-turn`,
    url
  });
}

function cleanChatText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxRoomChatMessageLength);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeRedirectPath(value) {
  const path = String(value || '/');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}

function formatInviteCodeMinutes(expiresAt) {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function renderInviteLanding({ token, invite, installCode }) {
  const safeToken = encodeURIComponent(token);
  const safeRoom = escapeHtml(invite.room);
  const safeCode = escapeHtml(installCode.code);
  const safeMinutes = escapeHtml(formatInviteCodeMinutes(installCode.expiresAt));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Join Skyjo</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 20px;
        background:
          radial-gradient(ellipse 90% 60% at 50% 0%, rgba(245, 230, 200, 0.1) 0%, transparent 58%),
          radial-gradient(ellipse 70% 50% at 90% 100%, rgba(34, 197, 94, 0.09) 0%, transparent 60%),
          linear-gradient(180deg, #0a1410 0%, #060c0a 100%);
        color: #f5e6c8;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(100%, 560px); }
      h1 { margin: 0; font-size: clamp(42px, 12vw, 68px); line-height: 0.95; letter-spacing: 0; }
      h2 { margin: 0 0 10px; font-size: 18px; }
      p { margin: 0; color: rgba(245, 230, 200, 0.74); line-height: 1.5; }
      ol { margin: 12px 0 0; padding-left: 22px; color: rgba(245, 230, 200, 0.78); line-height: 1.45; }
      li + li { margin-top: 6px; }
      .shell { display: grid; gap: 14px; }
      .eyebrow { color: rgba(245, 230, 200, 0.58); font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; }
      .lead { margin-top: 10px; font-size: 17px; }
      .room { display: inline-flex; margin-top: 16px; border: 1px solid rgba(245, 230, 200, 0.22); border-radius: 8px; padding: 8px 12px; font-size: 24px; font-weight: 900; letter-spacing: 0.08em; }
      .choice { border: 1px solid rgba(245, 230, 200, 0.14); border-radius: 8px; padding: 16px; background: rgba(255, 255, 255, 0.035); }
      .actions { display: grid; gap: 10px; margin-top: 14px; }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        border: 0;
        border-radius: 8px;
        padding: 0 14px;
        color: #0a1410;
        background: #f5e6c8;
        font: inherit;
        font-weight: 900;
        text-decoration: none;
        cursor: pointer;
      }
      .button.secondary { color: #f5e6c8; background: rgba(245, 230, 200, 0.12); }
      .code-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 14px; }
      input {
        min-height: 46px;
        width: 100%;
        border: 1px solid rgba(245, 230, 200, 0.18);
        border-radius: 8px;
        padding: 0 12px;
        color: #f5e6c8;
        background: rgba(0, 0, 0, 0.22);
        font: inherit;
        font-size: 20px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-align: center;
      }
      .note { margin-top: 9px; font-size: 13px; color: rgba(245, 230, 200, 0.58); }
      .status { min-height: 18px; margin-top: 8px; color: #bbf7d0; font-size: 13px; font-weight: 800; }
      @media (max-width: 480px) {
        body { padding: 14px; }
        .code-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section>
        <div class="eyebrow">Skyjo invite</div>
        <h1>Join Room ${safeRoom}</h1>
        <p class="lead">Choose where to play. Browser is fastest; Home Screen is better for repeat games.</p>
        <div class="room">${safeRoom}</div>
      </section>

      <section class="choice">
        <h2>Add Skyjo to your Home Screen</h2>
        <p>Copy this invite code first, then add Skyjo from Safari.</p>
        <div class="code-row">
          <input id="invite-code" readonly value="${safeCode}" />
          <button class="button" id="copy-code" type="button">Copy Code</button>
        </div>
        <div class="status" id="copy-status" role="status"></div>
        <ol>
          <li>Tap the Safari share button.</li>
          <li>Choose Add to Home Screen.</li>
          <li>Open Skyjo from the new icon and paste this code.</li>
        </ol>
        <p class="note">Code expires in about ${safeMinutes}. If it expires, open the original invite link again.</p>
      </section>

      <section class="choice">
        <h2>Open in browser</h2>
        <p>Continue in this browser now. This still bypasses the shared Skyjo password for this invite.</p>
        <div class="actions">
          <a class="button secondary" href="/invite/${safeToken}?open=browser">Open in Browser</a>
        </div>
      </section>
    </main>
    <script>
      const codeInput = document.getElementById('invite-code');
      const copyButton = document.getElementById('copy-code');
      const status = document.getElementById('copy-status');
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeInput.value);
          status.textContent = 'Invite code copied';
        } catch {
          codeInput.focus();
          codeInput.select();
          status.textContent = 'Code selected';
        }
      });
    </script>
  </body>
</html>`;
}

function appendRoomChatMessage(room, player, text) {
  const message = {
    id: crypto.randomUUID(),
    playerId: player.id,
    playerName: player.name,
    text,
    createdAt: Date.now()
  };
  const currentMessages = Array.isArray(room.chatMessages) ? room.chatMessages : [];
  room.chatMessages = [...currentMessages, message].slice(-maxRoomChatMessages);
  return message;
}

function sendApiError(res, status, message) {
  sendJsonResponse(res, status, { error: message });
}

function accountSessionHeaders(session) {
  return {
    'Set-Cookie': accountCookieHeader(session.token, Math.floor(accountSessionTtlMs / 1000))
  };
}

function requireAccountForApi(req, res) {
  const user = currentAccountUser(req);
  if (!user) {
    sendApiError(res, 401, 'Sign in to your Skyjo account.');
    return null;
  }
  return user;
}

function requireAdminForApi(req, res) {
  const user = requireAccountForApi(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendApiError(res, 403, 'Admin privileges are required.');
    return null;
  }
  return user;
}

function singlePlayerSourceKey(user, body) {
  const rawKey = typeof body.clientGameKey === 'string' ? body.clientGameKey : '';
  return `single:${user.id}:${rawKey.slice(0, 160) || crypto.randomUUID()}`;
}

async function handleApiRequest(req, res, url) {
  try {
    if (url.pathname === '/api/account/me' && req.method === 'GET') {
      sendJsonResponse(res, 200, { user: currentAccountUser(req) });
      return true;
    }

    if (url.pathname === '/api/account/signup' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new Error('Passwords must match.');
      const user = await accountStore.createUser({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        role: 'player'
      });
      const session = accountStore.createSession(user.id, accountSessionTtlMs);
      sendJsonResponse(res, 201, { user: session.user }, accountSessionHeaders(session));
      return true;
    }

    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const user = await accountStore.authenticate(body.email, body.password);
      if (!user) {
        sendApiError(res, 401, 'Email or password did not match.');
        return true;
      }
      const session = accountStore.createSession(user.id, accountSessionTtlMs);
      sendJsonResponse(res, 200, { user: session.user }, accountSessionHeaders(session));
      return true;
    }

    if (url.pathname === '/api/account/logout' && req.method === 'POST') {
      accountStore.deleteSession(accountToken(req));
      sendJsonResponse(res, 200, { ok: true }, { 'Set-Cookie': accountCookieHeader('', 0) });
      return true;
    }

    if (url.pathname === '/api/account/profile' && req.method === 'PATCH') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const updatedUser = accountStore.patchUser(user.id, { displayName: body.displayName });
      sendJsonResponse(res, 200, { user: updatedUser });
      return true;
    }

    if (url.pathname === '/api/account/password' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new Error('Passwords must match.');
      await accountStore.changePassword(user.id, body.currentPassword, body.password);
      sendJsonResponse(res, 200, { ok: true }, { 'Set-Cookie': accountCookieHeader('', 0) });
      return true;
    }

    if (url.pathname === '/api/push/config' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, {
        enabled: pushNotificationsEnabled,
        publicKey: pushNotificationsEnabled ? vapidPublicKey : ''
      });
      return true;
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      if (!pushNotificationsEnabled) {
        sendApiError(res, 503, 'Push notifications are not configured.');
        return true;
      }
      const body = await readJsonBody(req);
      accountStore.savePushSubscription(user.id, body.subscription, req.headers['user-agent'] || '');
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      accountStore.deletePushSubscriptionForUser(user.id, body.endpoint);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/rooms/invite' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const roomCode = cleanServerRoomCode(body.roomCode);
      const room = rooms.get(roomCode);
      if (!room) {
        sendApiError(res, 404, 'Room not found.');
        return true;
      }
      if (!room.players.some((player) => player.userId === user.id)) {
        sendApiError(res, 403, 'Join the room before sharing it.');
        return true;
      }
      const invite = createRoomInviteToken(roomCode);
      sendJsonResponse(res, 200, {
        roomCode,
        path: `/invite/${invite.token}`,
        expiresAt: invite.expiresAt
      });
      return true;
    }

    if (url.pathname === '/api/stats/summary' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, accountStore.getStatsSummary(user));
      return true;
    }

    if (url.pathname === '/api/stats/games' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, { games: accountStore.listVisibleGames(user) });
      return true;
    }

    if (url.pathname === '/api/stats/single-player' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const state = body.state;
      const humanPlayer = Array.isArray(state?.players) ? state.players.find((player) => player.kind === 'human') : null;
      if (!humanPlayer) throw new Error('Single-player game is missing a human player.');
      const game = accountStore.recordCompletedGame({
        mode: 'single',
        state,
        createdByUserId: user.id,
        playerAccounts: { [humanPlayer.id]: user.id },
        sourceKey: singlePlayerSourceKey(user, body)
      });
      sendJsonResponse(res, 201, { game });
      return true;
    }

    const gameMatch = url.pathname.match(/^\/api\/stats\/games\/([^/]+)$/);
    if (gameMatch && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const game = accountStore.getVisibleGame(user, gameMatch[1]);
      if (!game) {
        sendApiError(res, 404, 'Game not found.');
        return true;
      }
      sendJsonResponse(res, 200, { game });
      return true;
    }

    const playerMatch = url.pathname.match(/^\/api\/stats\/players\/([^/]+)$/);
    if (playerMatch && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const playerStats = accountStore.getVisiblePlayerStats(user, playerMatch[1]);
      if (!playerStats) {
        sendApiError(res, 404, 'Player not found.');
        return true;
      }
      sendJsonResponse(res, 200, playerStats);
      return true;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      if (!requireAdminForApi(req, res)) return true;
      sendJsonResponse(res, 200, { users: accountStore.listUsers() });
      return true;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      if (!requireAdminForApi(req, res)) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new Error('Passwords must match.');
      const role = body.role === 'admin' ? 'admin' : 'player';
      const user = await accountStore.createUser({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        role
      });
      sendJsonResponse(res, 201, { user });
      return true;
    }

    const adminPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (adminPasswordMatch && req.method === 'POST') {
      if (!requireAdminForApi(req, res)) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new Error('Passwords must match.');
      await accountStore.setUserPassword(adminPasswordMatch[1], body.password);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && req.method === 'PATCH') {
      const adminUser = requireAdminForApi(req, res);
      if (!adminUser) return true;
      const body = await readJsonBody(req);
      if (adminUser.id === adminUserMatch[1] && (body.disabled === true || body.disabled === 1 || body.role === 'player')) {
        sendApiError(res, 400, 'You cannot revoke your own admin access.');
        return true;
      }
      const user = accountStore.patchUser(adminUserMatch[1], {
        displayName: body.displayName,
        role: body.role,
        disabled: body.disabled
      });
      sendJsonResponse(res, 200, { user });
      return true;
    }

    return false;
  } catch (error) {
    sendApiError(res, 400, error?.message || 'Request failed.');
    return true;
  }
}

function renderLogin(error = false, next = '/', inviteCodeError = false) {
  const safeNext = safeRedirectPath(next);
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
      main { width: min(92vw, 380px); }
      h1 { margin: 0 0 8px; font-size: 48px; letter-spacing: 0; }
      h2 { margin: 0 0 10px; font-size: 18px; }
      p { margin: 0 0 24px; color: #bfdbfe; line-height: 1.45; }
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
      .invite-panel { margin-top: 18px; border-top: 1px solid rgba(191, 219, 254, 0.22); padding-top: 18px; }
      .invite-panel p { margin-bottom: 12px; color: rgba(191, 219, 254, 0.82); }
      .invite-panel input { text-transform: uppercase; letter-spacing: 0.08em; text-align: center; font-weight: 800; }
      .error { margin-top: 12px; color: #fecaca; }
    </style>
  </head>
  <body>
    <main>
      <h1>SKYJO</h1>
      <p>Enter the shared game password.</p>
      <form method="post" action="/login">
        <input name="next" type="hidden" value="${escapeHtml(safeNext)}" />
        <input name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Continue</button>
      </form>
      ${error ? '<div class="error">That password did not work.</div>' : ''}
      <section class="invite-panel">
        <h2>Have an invite code?</h2>
        <p>Paste the code from a Skyjo invite to open that room without the shared password.</p>
        <form method="post" action="/invite-code">
          <input name="code" autocomplete="one-time-code" inputmode="text" placeholder="ABCD123" required />
          <button type="submit">Open Invite</button>
        </form>
        ${inviteCodeError ? '<div class="error">That invite code expired or did not match.</div>' : ''}
      </section>
    </main>
  </body>
</html>`;
}

async function handleInviteCodeRedeem(req, res) {
  const body = await readRequestBody(req);
  const form = new URLSearchParams(body);
  const code = cleanInviteInstallCode(form.get('code'));
  pruneInviteInstallCodes();
  const savedInvite = inviteInstallCodes.get(code);
  if (!savedInvite || savedInvite.expiresAt <= Date.now()) {
    inviteInstallCodes.delete(code);
    send(res, 303, '', { Location: '/login?inviteError=1' });
    return;
  }

  const invite = parseRoomInvitePayload(savedInvite.token, { verifySignature: true });
  if (!invite || invite.room !== savedInvite.room) {
    inviteInstallCodes.delete(code);
    send(res, 303, '', { Location: '/login?inviteError=1' });
    return;
  }

  inviteInstallCodes.delete(code);
  sendInviteRoomAccess(res, invite.room);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
  return parsed;
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
    const fileName = path.basename(filePath);
    const cacheControl = ext === '.html' || ext === '.webmanifest' || fileName === 'sw.js'
      ? 'no-store'
      : 'public, max-age=31536000, immutable';
    send(res, 200, data, {
      'Cache-Control': cacheControl,
      'Content-Type': mimeTypes.get(ext) || 'application/octet-stream'
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

try {
  const restoredRooms = await loadRoomsFromDisk(roomsFile, { staleMs: ROOM_STALE_MS });
  for (const room of restoredRooms) {
    rooms.set(room.code, room);
  }
  if (restoredRooms.length > 0) {
    console.log(`Restored ${restoredRooms.length} persisted room(s) from ${roomsFile}`);
    await saveRoomsToDisk(rooms, roomsFile);
  }
} catch (error) {
  console.error('Failed to load persisted rooms:', error);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (isPublicPwaAsset(url.pathname)) {
      await serveStatic(req, res);
      return;
    }

    if (url.pathname === '/logout') {
      accountStore.deleteSession(accountToken(req));
      send(res, 302, '', {
        Location: '/login',
        'Set-Cookie': [cookieHeader('', 0), accountCookieHeader('', 0)]
      });
      return;
    }

    if (url.pathname.startsWith('/invite/')) {
      if (handleRoomInviteAccess(res, url, { landing: true })) return;
    }

    if (url.pathname === '/invite-code' && req.method === 'POST') {
      await handleInviteCodeRedeem(req, res);
      return;
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      send(
        res,
        200,
        renderLogin(
          url.searchParams.get('error') === '1',
          url.searchParams.get('next') || '/',
          url.searchParams.get('inviteError') === '1'
        ),
        {
          'Content-Type': 'text/html; charset=utf-8'
        }
      );
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const form = new URLSearchParams(body);
      const password = form.get('password') || '';
      const next = safeRedirectPath(form.get('next') || '/');
      if (!timingSafeEqualString(password, accessPassword)) {
        send(res, 303, '', { Location: `/login?error=1&next=${encodeURIComponent(next)}` });
        return;
      }
      send(res, 303, '', {
        Location: next,
        'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
      });
      return;
    }

    if (!hasValidSession(req)) {
      if (url.searchParams.has('invite') && handleRoomInviteAccess(res, url)) return;
      const next = safeRedirectPath(`${url.pathname}${url.search}`);
      send(res, 302, '', { Location: `/login?next=${encodeURIComponent(next)}` });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (await handleApiRequest(req, res, url)) return;
      sendApiError(res, 404, 'API route not found.');
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
  const accountUser = currentAccountUser(req);
  if (!accountUser) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  req.accountUser = accountUser;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  ws.accountUser = req.accountUser;
  ws.visible = true;
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid message.' });
      return;
    }

    if (message.type === 'create-room') {
      const accountUser = ws.accountUser;
      const code = makeRoomCode();
      const playerId = crypto.randomUUID();
      const room = createWaitingRoom({
        code,
        hostPlayer: { id: playerId, userId: accountUser.id, name: accountUser.displayName },
        ws
      });
      rooms.set(code, room);
      ws.roomCode = code;
      ws.playerId = playerId;
      persistRoomsSoon();
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
      const accountUser = ws.accountUser;
      const requestedPlayerId = typeof message.playerId === 'string' ? message.playerId : '';
      let player = requestedPlayerId ? room.players.find((item) => item.id === requestedPlayerId) : null;
      if (player?.userId && player.userId !== accountUser.id) {
        sendJson(ws, { type: 'error', message: 'That saved room seat belongs to another account.' });
        return;
      }
      if (!player) player = room.players.find((item) => item.userId === accountUser.id) || null;
      if (room.status !== 'waiting' && !player) {
        sendJson(ws, { type: 'error', message: 'That game has already started.' });
        return;
      }
      if (!player) {
        if (room.players.length >= 8) {
          sendJson(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        player = { id: crypto.randomUUID(), userId: accountUser.id, name: accountUser.displayName, connected: true, host: false };
        room.players.push(player);
      }
      player.userId = player.userId || accountUser.id;
      player.name = accountUser.displayName;
      room.readyForNextRoundPlayerIds = normalizedReadyIds(room);
      ws.visible = true;
      ws.roomCode = code;
      ws.playerId = player.id;
      room.clients.add(ws);
      syncPlayerPresence(room, player);
      room.updatedAt = Date.now();
      persistRoomsSoon();
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

    if (message.type === 'set-presence') {
      ws.visible = message.visible !== false;
      syncPlayerPresence(room, player);
      room.updatedAt = Date.now();
      persistRoomsSoon();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'send-chat-message') {
      const text = cleanChatText(message.text);
      if (!text) {
        sendJson(ws, { type: 'error', message: 'Enter a message before sending.' });
        return;
      }
      appendRoomChatMessage(room, player, text);
      room.updatedAt = Date.now();
      persistRoomsSoon();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'set-next-round-ready') {
      if (room.state?.phase !== 'round-over' && room.state?.phase !== 'game-over') {
        sendJson(ws, { type: 'error', message: 'The round is not ready for confirmation.' });
        return;
      }
      setPlayerReadyForNextRound(room, player.id, message.ready !== false);
      room.updatedAt = Date.now();
      persistRoomsSoon();
      broadcastRoom(room);
      return;
    }

    if (message.type === 'start-game') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can start the game.' });
        return;
      }
      if (room.status === 'waiting') {
        if (room.players.length < 2) {
          sendJson(ws, { type: 'error', message: 'Need at least two players.' });
          return;
        }
        room.state = createInitialRoomState(room.players);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = crypto.randomUUID();
        room.updatedAt = Date.now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.state?.phase === 'round-over') {
        if (!allPlayersReadyForNextRound(room)) {
          sendJson(ws, { type: 'error', message: 'Everyone must confirm they are ready before the next round starts.' });
          return;
        }
        room.state = createNextRoundRoomState(room.state);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.updatedAt = Date.now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.state?.phase === 'game-over' || room.status === 'finished') {
        if (room.state && !allPlayersReadyForNextRound(room)) {
          sendJson(ws, { type: 'error', message: 'Everyone must confirm they are ready before the game restarts.' });
          return;
        }
        room.state = createInitialRoomState(room.players);
        room.readyForNextRoundPlayerIds = [];
        room.status = 'playing';
        room.completedGameId = null;
        room.gameSessionId = crypto.randomUUID();
        room.updatedAt = Date.now();
        persistRoomsSoon();
        broadcastRoom(room);
        return;
      }
      if (room.players.length < 2) {
        sendJson(ws, { type: 'error', message: 'Need at least two players.' });
        return;
      }
      sendJson(ws, { type: 'error', message: 'The current game is not ready for a new round.' });
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
      const validation = validateMultiplayerStateUpdate(room.state, message.state, player.id);
      if (!validation.ok) {
        sendJson(ws, { type: 'error', message: validation.message || 'That move is not legal.' });
        return;
      }
      if (message.state.phase === 'game-over' && !room.completedGameId) {
        try {
          const playerAccounts = Object.fromEntries(room.players.map((roomPlayer) => [roomPlayer.id, roomPlayer.userId || null]));
          const game = accountStore.recordCompletedGame({
            mode: 'multi',
            state: message.state,
            roomCode: room.code,
            createdByUserId: player.userId || null,
            playerAccounts,
            sourceKey: `multi:${room.gameSessionId || room.code}`
          });
          room.completedGameId = game.id;
        } catch (error) {
          console.error('Failed to record multiplayer game:', error);
          sendJson(ws, { type: 'error', message: 'Could not save the completed game history.' });
          return;
        }
      }
      room.state = message.state;
      room.readyForNextRoundPlayerIds =
        message.state.phase === 'round-over' || message.state.phase === 'game-over' ? [] : normalizedReadyIds(room);
      room.status = message.state.phase === 'game-over' ? 'finished' : 'playing';
      room.updatedAt = Date.now();
      persistRoomsSoon();
      broadcastRoom(room);
      notifyAwayPlayersAfterMove(room, player, message.state);
      return;
    }

    if (message.type === 'reset-room') {
      if (!player.host) {
        sendJson(ws, { type: 'error', message: 'Only the host can reset the room.' });
        return;
      }
      const oldRoom = room;
      const newCode = makeRoomCode();
      const newRoom = createWaitingRoom({ code: newCode, hostPlayer: player, ws });
      for (const client of oldRoom.clients) {
        if (client === ws) continue;
        sendJson(client, {
          type: 'room-reset',
          message: 'The host reset this room. Ask for the new room link to rejoin.'
        });
        client.roomCode = null;
        client.playerId = null;
      }
      rooms.delete(oldRoom.code);
      rooms.set(newCode, newRoom);
      ws.roomCode = newCode;
      ws.playerId = player.id;
      persistRoomsSoon();
      sendJson(ws, { type: 'joined', playerId: player.id, room: publicRoom(newRoom) });
      return;
    }
  });

  ws.on('close', () => {
    if (shuttingDown) return;
    const context = roomPlayer(ws);
    if (!context) return;
    const { room, player } = context;
    room.clients.delete(ws);
    if (!hasVisibleLiveClient(room, player.id, ws)) {
      player.connected = false;
    }
    room.updatedAt = Date.now();
    persistRoomsSoon();
    broadcastRoom(room);
  });
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_STALE_MS;
  let removedRoom = false;
  for (const [code, room] of rooms.entries()) {
    if (room.updatedAt < cutoff && room.clients.size === 0) {
      rooms.delete(code);
      removedRoom = true;
    }
  }
  if (removedRoom) persistRoomsSoon();
}, 1000 * 60 * 30).unref();

server.listen(port, host, () => {
  console.log(`Skyjo Online serving ${distDir}`);
  console.log(`Listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; persisting rooms before shutdown.`);
  markAllPlayersDisconnected();
  await flushRoomPersistence();
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close(() => {});
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
