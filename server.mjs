import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';
import { WebSocketServer } from 'ws';
import {
  createInitialRoomState,
  createNextRoundRoomState
} from './server-dist/serverValidation.js';
import {
  hasVisibleLiveClient,
  REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES,
  registerRealtimeServer,
  sendRealtimeJson,
  syncPlayerPresence
} from './server-dist/serverRealtime.js';
import {
  createProtocolV2MessageHandler,
  createResetAliasIndex,
  isResetAliasCodeReserved
} from './server-dist/serverProtocolV2.js';
import {
  ACTIVE_PLAYER_GRACE_MS,
  createRoomLifecycleScheduler,
  dueHostTransfer,
  hostFlags,
  markPlayersDisconnectedForShutdown,
  reclaimAiSeat,
  WAITING_HOST_TRANSFER_MS
} from './server-dist/serverRoomLifecycle.js';
import {
  createRoomSnapshot,
  MULTIPLAYER_PROTOCOL_VERSION
} from './server-dist/protocolV2.js';
import {
  loadRoomsSnapshotFromDisk,
  reconcileCompletedRoomJournals,
  resolveRoomsFilePath,
  ROOM_STALE_MS,
  saveRoomsToDisk
} from './server-room-persistence.mjs';
import { normalizePersistedGameState } from './server-game-state-validation.mjs';
import {
  createAccountStore,
  createUniqueRandomCode,
  PublicApiError,
  publicApiErrorResponse,
  resolveAccountDatabasePath
} from './server-account-store.mjs';
import { createPersistenceHealthTracker } from './server-persistence-health.mjs';
import { createReadinessResult, createVersionResult } from './server-readiness.mjs';
import { loadReleaseIdentity, releaseValidationOptionsForEnvironment } from './server-release.mjs';

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
const databaseRetryDelayMs = Math.max(100, Number(process.env.SKYJO_DATABASE_RETRY_MS || 5000));
const roomsSaveDebounceMs = 250;
const maxRoomChatMessages = 80;
const maxRoomChatMessageLength = 280;
const inviteCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const inviteCodeLength = 7;
const roomCodeLength = 5;
const secureCodeMaxAttempts = 128;
const lifecyclePolicy = Object.freeze({
  activePlayerGraceMs: positiveDurationFromEnvironment('SKYJO_ACTIVE_PLAYER_GRACE_MS', ACTIVE_PLAYER_GRACE_MS),
  waitingHostTransferMs: positiveDurationFromEnvironment('SKYJO_WAITING_HOST_TRANSFER_MS', WAITING_HOST_TRANSFER_MS)
});
const lifecycleTickMs = positiveDurationFromEnvironment('SKYJO_LIFECYCLE_TICK_MS', 250);
const aiActionDelayMs = positiveDurationFromEnvironment('SKYJO_AI_ACTION_DELAY_MS', 650, true);
const inviteInstallCodes = new Map();
let roomsSaveTimer = null;
let roomsSaveQueue = Promise.resolve();
let shuttingDown = false;
let accountStore = null;
let nextDatabaseRetryAt = 0;
let databaseFailureLogged = false;
let releaseIdentity = null;

function positiveDurationFromEnvironment(name, fallback, allowZero = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 10 * 60 * 1000) {
    throw new Error(`${name} must be an integer between ${minimum} and 600000.`);
  }
  return value;
}
let roomPersistenceLoadAccepted = false;
let roomCompletionRecoveryPending = false;
const roomPersistenceHealth = createPersistenceHealthTracker();

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

try {
  releaseIdentity = await loadReleaseIdentity(distDir, releaseValidationOptionsForEnvironment(process.env.NODE_ENV));
} catch {
  console.error('Release identity validation failed; readiness and version endpoints will remain unavailable.');
}

async function ensureAccountStore({ force = false } = {}) {
  if (accountStore?.checkReadiness()) return accountStore;
  accountStore?.close();
  accountStore = null;

  const timestamp = Date.now();
  if (!force && timestamp < nextDatabaseRetryAt) return null;
  nextDatabaseRetryAt = timestamp + databaseRetryDelayMs;

  let candidate = null;
  try {
    candidate = await createAccountStore({ filePath: accountDatabaseFile });
    const bootstrappedAdmin = await candidate.bootstrapAdmin({ email: adminEmail, password: adminInitialPassword });
    if (bootstrappedAdmin) {
      console.log(`Admin account ready for ${bootstrappedAdmin.email}`);
    } else {
      console.warn('No admin account was bootstrapped. Set SKYJO_ADMIN_INITIAL_PASSWORD before first production account setup.');
    }
    if (roomPersistenceLoadAccepted) {
      const reconciled = reconcileCompletedRoomJournals(
        rooms,
        (sourceKey) => candidate.getCompletedGameJournalBySourceKey(sourceKey)
      );
      if (reconciled > 0) roomCompletionRecoveryPending = true;
      if (roomCompletionRecoveryPending) {
        await roomPersistenceHealth.track(() => saveRoomsToDisk(rooms, roomsFile));
        roomCompletionRecoveryPending = false;
      }
    }
    accountStore = candidate;
    databaseFailureLogged = false;
    return accountStore;
  } catch {
    candidate?.close();
    if (!databaseFailureLogged) {
      console.error('Account database is unavailable; the service is running in health-only mode.');
      databaseFailureLogged = true;
    }
    return null;
  }
}

await ensureAccountStore({ force: true });

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
  if (!token || !accountStore) return null;
  try {
    return accountStore.getUserBySessionToken(token);
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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

function makeRoomCode(randomInt = crypto.randomInt) {
  return createUniqueRandomCode({
    alphabet: inviteCodeAlphabet,
    length: roomCodeLength,
    isTaken: (code) => rooms.has(code) || isResetAliasCodeReserved(resetAliasIndex, code, Date.now()),
    randomInt,
    maxAttempts: secureCodeMaxAttempts
  });
}

function makeRoomCodeForSocket() {
  try {
    return makeRoomCode();
  } catch {
    console.error('Secure room code allocation failed.');
    return null;
  }
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

function pruneInviteInstallCodes(timestamp = Date.now()) {
  for (const [code, invite] of inviteInstallCodes) {
    if (invite.expiresAt <= timestamp) inviteInstallCodes.delete(code);
  }
}

function createRoomInviteToken(roomCode) {
  const cleanRoom = cleanServerRoomCode(roomCode);
  if (cleanRoom.length !== roomCodeLength) throw new PublicApiError('INVALID_ROOM_CODE');
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

function createInviteInstallCode(token, invite, randomInt = crypto.randomInt) {
  const timestamp = Date.now();
  pruneInviteInstallCodes(timestamp);
  const expiresAt = Math.min(invite.expiresAt, timestamp + inviteCodeTtlMs);
  const code = createUniqueRandomCode({
    alphabet: inviteCodeAlphabet,
    length: inviteCodeLength,
    isTaken: (candidate) => inviteInstallCodes.has(candidate),
    randomInt,
    maxAttempts: secureCodeMaxAttempts
  });
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
    const installCode = createInviteInstallCode(token, invite);
    send(res, 200, renderInviteLanding({ token, invite, installCode }), {
      'Content-Type': 'text/html; charset=utf-8'
    });
    return true;
  }

  sendInviteRoomAccess(res, invite.room);
  return true;
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
  sendRealtimeJson(ws, payload);
}

function broadcastRoom(room) {
  for (const client of room.clients) {
    sendRoomSnapshot(client, room);
  }
}

function sendCurrentRoom(ws, room) {
  sendRoomSnapshot(ws, room);
}

function sendRoomSnapshot(ws, room, options = {}) {
  if (!ws.playerId || !room.players.some((player) => player.id === ws.playerId)) return false;
  const type = options.type === 'resync' ? 'resync' : 'snapshot';
  const payload = {
    type,
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    playerId: ws.playerId,
    revision: room.revision,
    room: createRoomSnapshot(room, ws.playerId, Date.now(), lifecyclePolicy),
    ...(type === 'resync'
      ? {
          reason: options.reason || 'revision-mismatch',
          ...(options.commandId ? { commandId: options.commandId } : {})
        }
      : {})
  };
  return sendJson(ws, payload);
}

function queueRoomsSave() {
  if (!roomPersistenceLoadAccepted) {
    const error = new Error('Room persistence is unavailable.');
    error.code = 'ROOM_PERSISTENCE_UNAVAILABLE';
    return Promise.reject(error);
  }
  const currentSave = roomsSaveQueue
    .catch(() => {})
    .then(() => roomPersistenceHealth.track(() => saveRoomsToDisk(rooms, roomsFile)));
  roomsSaveQueue = currentSave.catch(() => {});
  return currentSave;
}

function persistRoomsSoon() {
  if (roomsSaveTimer) return;
  roomsSaveTimer = setTimeout(() => {
    roomsSaveTimer = null;
    void queueRoomsSave().catch(() => {
      console.error('Failed to persist rooms.');
    });
  }, roomsSaveDebounceMs);
  roomsSaveTimer.unref();
}

async function flushRoomPersistence() {
  if (roomsSaveTimer) {
    clearTimeout(roomsSaveTimer);
    roomsSaveTimer = null;
  }
  if (!roomPersistenceLoadAccepted) {
    const error = new Error('Room persistence is unavailable.');
    error.code = 'ROOM_PERSISTENCE_UNAVAILABLE';
    throw error;
  }
  await queueRoomsSave();
}

function markAllPlayersDisconnected() {
  const timestamp = Date.now();
  for (const room of rooms.values()) {
    room.clients.clear();
    markPlayersDisconnectedForShutdown(room, timestamp);
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
  const timestamp = Date.now();
  return {
    roomVersion: 2,
    code,
    hostId: hostPlayer.id,
    players: [{
      id: hostPlayer.id,
      userId: hostPlayer.userId,
      name: hostPlayer.name,
      connected: true,
      host: true,
      joinedAt: timestamp,
      lastSeenAt: timestamp,
      disconnectedAt: null,
      controller: 'human'
    }],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: timestamp,
    completedGameId: null,
    gameSessionId: null,
    finishedByAi: false,
    revision: 0,
    recentCommandIds: [],
    resetAliases: [],
    clients: new Set([ws])
  };
}

function reclaimVisiblePlayer(room, player, timestamp) {
  const reclaimed = reclaimAiSeat(room, player.id);
  if (!reclaimed || room.revision >= Number.MAX_SAFE_INTEGER) return false;
  room.players = reclaimed.players;
  room.readyForNextRoundPlayerIds = reclaimed.readyForNextRoundPlayerIds;
  const reclaimedPlayer = room.players.find((candidate) => candidate.id === player.id);
  if (reclaimedPlayer) {
    reclaimedPlayer.disconnectedAt = null;
    reclaimedPlayer.lastSeenAt = timestamp;
  }
  room.revision += 1;
  room.updatedAt = timestamp;
  return true;
}

function transferRoomHost(fence) {
  const room = rooms.get(fence.roomCode);
  if (!room || room.revision !== fence.expectedRevision || room.hostId !== fence.fromPlayerId) return false;
  const timestamp = Date.now();
  const transfer = dueHostTransfer(room, timestamp, lifecyclePolicy);
  if (!transfer || transfer.toPlayerId !== fence.toPlayerId || transfer.deadline !== fence.deadline) return false;
  if (room.revision >= Number.MAX_SAFE_INTEGER) return false;
  room.hostId = transfer.toPlayerId;
  room.players = hostFlags(room.players, transfer.toPlayerId);
  room.revision += 1;
  room.updatedAt = timestamp;
  persistRoomsSoon();
  broadcastRoom(room);
  return true;
}

async function sendPushToUsers(userIds, payload) {
  if (!pushNotificationsEnabled || !accountStore) return;
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
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
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
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
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
      if (!humanPlayer) throw new PublicApiError('MISSING_HUMAN_PLAYER');
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
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
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
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
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
    const publicError = publicApiErrorResponse(error);
    if (publicError.status === 500) console.error('API request failed:', error);
    sendApiError(res, publicError.status, publicError.message);
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
    if (size > 256 * 1024) throw new PublicApiError('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PublicApiError('INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PublicApiError('EXPECTED_JSON_OBJECT');
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
  const snapshot = await roomPersistenceHealth.track(() =>
    loadRoomsSnapshotFromDisk(roomsFile, { staleMs: ROOM_STALE_MS })
  );
  const restoredRoomMap = new Map(snapshot.rooms.map((room) => [room.code, room]));
  const reconciledCompletions = accountStore
    ? reconcileCompletedRoomJournals(
        restoredRoomMap,
        (sourceKey) => accountStore.getCompletedGameJournalBySourceKey(sourceKey)
      )
    : 0;
  if (snapshot.missing || snapshot.legacy || reconciledCompletions > 0) {
    await roomPersistenceHealth.track(() => saveRoomsToDisk(restoredRoomMap, roomsFile));
  }
  for (const room of snapshot.rooms) {
    rooms.set(room.code, room);
  }
  roomPersistenceLoadAccepted = true;
  if (snapshot.rooms.length > 0) {
    console.log(`Restored ${snapshot.rooms.length} persisted room(s) from ${roomsFile}`);
  }
} catch {
  console.error('Persisted room state was rejected; room writes are disabled to protect the source file.');
}

const resetAliasIndex = createResetAliasIndex(rooms);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (url.pathname === '/version') {
      const result = createVersionResult(releaseIdentity);
      sendJsonResponse(res, result.statusCode, result.payload, { 'Cache-Control': 'no-store' });
      return;
    }

    if (url.pathname === '/readyz') {
      await ensureAccountStore();
      const persistence = roomPersistenceHealth.probe();
      const result = createReadinessResult({
        releaseIdentity,
        databaseReady: accountStore?.checkReadiness() === true,
        roomState: roomPersistenceLoadAccepted,
        lastPersist: persistence.status === 'ok'
      });
      sendJsonResponse(res, result.statusCode, result.payload, { 'Cache-Control': 'no-store' });
      return;
    }

    if (isPublicPwaAsset(url.pathname)) {
      await serveStatic(req, res);
      return;
    }

    if (url.pathname === '/logout') {
      accountStore?.deleteSession(accountToken(req));
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
      if (!(await ensureAccountStore())) {
        sendApiError(res, 503, 'Service is not ready.');
        return;
      }
      if (await handleApiRequest(req, res, url)) return;
      sendApiError(res, 404, 'API route not found.');
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    if (error instanceof PublicApiError) {
      const publicError = publicApiErrorResponse(error);
      send(res, publicError.status, publicError.message, { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    console.error(error);
    send(res, 500, 'Internal server error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES });

const handleProtocolV2Message = createProtocolV2MessageHandler({
  allPlayersReadyForNextRound,
  appendRoomChatMessage,
  broadcastRoom,
  cleanChatText,
  createInitialRoomState,
  createNextRoundRoomState,
  createWaitingRoom,
  digestAction: (canonicalAction) => crypto.createHash('sha256').update(canonicalAction).digest('hex'),
  lifecyclePolicy,
  makeRoomCodeForSocket,
  normalizedReadyIds,
  notifyAwayPlayersAfterMove,
  now: Date.now,
  persistRoomsSoon,
  random: () => crypto.randomInt(0, 0x1_0000_0000) / 0x1_0000_0000,
  randomUuid: crypto.randomUUID,
  recordCompletedGame: (input) => {
    const validationContext = {
      rosterPlayerIds: input.state.players.map((player) => player.id),
      roomStatus: 'finished',
      readyForNextRoundPlayerIds: []
    };
    const submittedState = normalizePersistedGameState(input.state, validationContext);
    const game = accountStore.recordCompletedGame({ ...input, state: submittedState });
    const journal = accountStore.getCompletedGameJournalBySourceKey(input.sourceKey);
    if (
      !journal ||
      journal.id !== game.id ||
      journal.sourceKey !== input.sourceKey ||
      journal.roomCode !== input.roomCode
    ) {
      throw new Error('Completed game journal identity does not match the recorded game.');
    }
    const state = normalizePersistedGameState(journal.state, validationContext);
    if (state.phase !== 'game-over') {
      throw new Error('Completed game journal is not terminal.');
    }
    return {
      id: journal.id,
      finishedByAi: journal.finishedByAi,
      recovered: !isDeepStrictEqual(state, submittedState),
      state
    };
  },
  roomPlayer,
  rooms,
  resetAliasIndex,
  sendJson,
  sendRoomSnapshot,
  setPlayerReadyForNextRound,
  syncPlayerPresence,
  reportCompletedGameError: (error) => console.error('Failed to record multiplayer game:', error)
});

const lifecycleScheduler = createRoomLifecycleScheduler({
  aiActionDelayMs,
  executeAiAction: (fence) => handleProtocolV2Message.executeAutomatedAction(fence),
  lifecyclePolicy,
  now: Date.now,
  randomUuid: crypto.randomUUID,
  rooms: () => rooms.values(),
  tickIntervalMs: lifecycleTickMs,
  transferHost: transferRoomHost
});
lifecycleScheduler.runNow();

const disposeRealtimeServer = registerRealtimeServer({
  server,
  webSocketServer: wss,
  hasValidSession,
  currentAccountUser,
  roomPlayer,
  persistRoomsSoon,
  broadcastRoom,
  sendCurrentRoom,
  now: Date.now,
  isShuttingDown: () => shuttingDown,
  onPlayerVisible: reclaimVisiblePlayer,
  onProtocolMessage: handleProtocolV2Message
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
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Skyjo Online serving ${distDir}`);
  console.log(`Listening on http://${host}:${listeningPort}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycleScheduler.dispose();
  console.log(`Received ${signal}; persisting rooms before shutdown.`);
  markAllPlayersDisconnected();
  let exitCode = 0;
  try {
    await flushRoomPersistence();
  } catch {
    exitCode = 1;
    console.error('Room persistence flush failed during shutdown.');
  }
  disposeRealtimeServer();
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close(() => {});
  server.close(() => {
    accountStore?.close();
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 3000).unref();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
