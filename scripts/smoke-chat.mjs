import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MULTIPLAYER_PROTOCOL_VERSION = 2;
const socketStates = new WeakMap();
const privacyEvidence = { snapshots: 0, drawerBlindFrames: 0, nonDrawerBlindFrames: 0 };
let commandSequence = 0;

async function getOpenPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port > 0, 'expected an open port');
  return port;
}

function fixedOriginUrl(baseUrl, pathname) {
  const base = new URL(baseUrl);
  assert.equal(base.protocol, 'http:', 'chat smoke only targets its loopback HTTP server');
  assert.equal(base.hostname, '127.0.0.1', 'chat smoke only targets loopback');
  const target = new URL(base.origin);
  target.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  assert.equal(target.origin, base.origin, 'request path cannot change the smoke server origin');
  return target;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok && (await response.text()) === 'ok') return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('server did not become healthy');
}

async function login(url, password, next = '/') {
  const response = await fetch(`${url}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password, next }),
    redirect: 'manual'
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), next);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected a login cookie');
  return cookie.split(';')[0];
}

async function accountRequest(url, siteCookie, path, body, method = 'POST') {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      Cookie: siteCookie,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function createAccount(url, siteCookie, email, displayName) {
  const { response, payload } = await accountRequest(url, siteCookie, '/api/account/signup', {
    email,
    displayName,
    password: 'account-secret-123',
    confirmPassword: 'account-secret-123'
  });
  assert.equal(response.status, 201);
  const accountCookie = response.headers.get('set-cookie');
  assert.ok(accountCookie, 'expected an account cookie');
  assert.equal(payload.user.email, email);
  return {
    cookie: `${siteCookie}; ${accountCookie.split(';')[0]}`,
    user: payload.user
  };
}

async function loginAccount(url, siteCookie, email, password = 'account-secret-123') {
  const { response, payload } = await accountRequest(url, siteCookie, '/api/account/login', { email, password });
  assert.equal(response.status, 200);
  const accountCookie = response.headers.get('set-cookie');
  assert.ok(accountCookie, 'expected an account login cookie');
  assert.equal(payload.user.email, email);
  return {
    cookie: `${siteCookie}; ${accountCookie.split(';')[0]}`,
    user: payload.user
  };
}

async function getJson(url, cookie, path) {
  const response = await fetch(`${url}${path}`, { headers: { Cookie: cookie } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  return payload;
}

function publicSnapshotFrame(message) {
  return message?.type === 'snapshot' || message?.type === 'resync';
}

function assertNoPrivateKeys(value, pathLabel = 'snapshot') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeys(item, `${pathLabel}[${index}]`));
    return;
  }
  const forbiddenKeys = new Set(['userId', 'gameSessionId', 'recentCommandIds', 'resetAliases', 'clients', 'drawPile']);
  for (const [key, item] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `${pathLabel}.${key} must not be public`);
    assertNoPrivateKeys(item, `${pathLabel}.${key}`);
  }
}

function inspectPublicSnapshot(frame, socketLabel) {
  privacyEvidence.snapshots += 1;
  assert.equal(frame.protocolVersion, MULTIPLAYER_PROTOCOL_VERSION, `${socketLabel} snapshot uses protocol v2`);
  assert.equal(frame.revision, frame.room?.revision, `${socketLabel} frame and room revisions match`);
  assert.equal(typeof frame.playerId, 'string', `${socketLabel} snapshot identifies its viewer`);
  assertNoPrivateKeys(frame);
  const encoded = JSON.stringify(frame);
  assert.doesNotMatch(encoded, /card-\d+--?\d+/, `${socketLabel} snapshot hides internal card ids`);

  const state = frame.room?.state;
  if (!state) return;
  assert.equal(Number.isSafeInteger(state.drawPileCount), true, `${socketLabel} receives only a draw count`);
  state.players.forEach((player, playerIndex) => {
    player.grid.forEach((card, cardIndex) => {
      assert.equal(card.id, `grid-${playerIndex}-${cardIndex}`, `${socketLabel} receives positional grid ids`);
      if (!card.faceUp) assert.equal(card.value, null, `${socketLabel} face-down cards are redacted`);
    });
  });
  if (state.discardPile.top) assert.equal(state.discardPile.top.id, 'discard-top');
  if (state.drawnCard) assert.equal(state.drawnCard.id, 'drawn-card');
  assert.equal(
    state.log.some((entry) => / drew a -?\d+\.$/.test(entry)),
    false,
    `${socketLabel} log hides blind values`
  );

  if (state.hasDrawnCard) {
    assert.equal(state.selectedSource, 'draw', `${socketLabel} blind draw metadata is coherent`);
    const drawerId = state.players[state.currentPlayerIndex]?.id;
    if (frame.playerId === drawerId) {
      privacyEvidence.drawerBlindFrames += 1;
      assert.ok(state.drawnCard, `${socketLabel} drawer receives its blind card`);
      assert.equal(Number.isInteger(state.drawnCard.value), true, `${socketLabel} drawer receives the blind value`);
    } else {
      privacyEvidence.nonDrawerBlindFrames += 1;
      assert.equal(state.drawnCard, null, `${socketLabel} non-drawer cannot see the blind value`);
    }
  } else {
    assert.equal(state.drawnCard, null, `${socketLabel} has no stray drawn-card value`);
  }
}

function trackSocket(ws, label) {
  const state = {
    label,
    frames: [],
    received: [],
    waiters: [],
    revision: null,
    playerId: null,
    room: null,
    error: null
  };
  socketStates.set(ws, state);
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
      if (publicSnapshotFrame(message)) {
        inspectPublicSnapshot(message, label);
        state.revision = message.revision;
        state.playerId = message.playerId;
        state.room = message.room;
      } else if (message.type === 'ack' && Number.isSafeInteger(message.revision)) {
        state.revision = message.revision;
      }
    } catch (error) {
      state.error = error;
      for (const waiter of state.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      return;
    }
    state.received.push(message);
    const waiterIndex = state.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = state.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else {
      state.frames.push(message);
      if (state.frames.length > 512) state.frames.shift();
    }
  });
}

function socketState(ws) {
  const state = socketStates.get(ws);
  assert.ok(state, 'socket must be tracked');
  if (state.error) throw state.error;
  return state;
}

function openSocket(url, cookie, label = 'socket') {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/rooms`, { headers: { Cookie: cookie } });
  trackSocket(ws, label);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForServerClose(serverProcess) {
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => serverProcess.once('close', resolve));
}

function waitForMessage(ws, predicate, label) {
  const state = socketState(ws);
  const queuedIndex = state.frames.findIndex(predicate);
  if (queuedIndex >= 0) return Promise.resolve(state.frames.splice(queuedIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const waiterIndex = state.waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (waiterIndex >= 0) state.waiters.splice(waiterIndex, 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    state.waiters.push({ predicate, resolve, reject, timeout });
  });
}

function nextCommandId() {
  commandSequence += 1;
  return `70000000-0000-4000-8000-${String(commandSequence).padStart(12, '0')}`;
}

function sendAdmission(ws, message, label) {
  const snapshot = waitForMessage(ws, publicSnapshotFrame, label);
  ws.send(JSON.stringify({ ...message, protocolVersion: MULTIPLAYER_PROTOCOL_VERSION }));
  return snapshot;
}

async function sendCommand(ws, action, label = action.type) {
  const client = socketState(ws);
  assert.equal(Number.isSafeInteger(client.revision), true, `${client.label} has an authoritative revision`);
  const expectedRevision = client.revision;
  const commandId = nextCommandId();
  const nextRevision = expectedRevision + 1;
  const snapshotPromise = waitForMessage(
    ws,
    (message) => publicSnapshotFrame(message) && message.revision === nextRevision,
    `${label} snapshot`
  );
  const ackPromise = waitForMessage(
    ws,
    (message) => message.type === 'ack' && message.commandId === commandId,
    `${label} ack`
  );
  ws.send(JSON.stringify({
    type: 'command',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    commandId,
    expectedRevision,
    action
  }));
  const [snapshot, ack] = await Promise.all([snapshotPromise, ackPromise]);
  assert.equal(ack.revision, nextRevision, `${label} ack advances exactly one revision`);
  assert.equal(snapshot.room.revision, nextRevision, `${label} snapshot advances exactly one revision`);
  return { snapshot, ack, commandId };
}

async function sendCommandExpectError(ws, action, label = action.type) {
  const client = socketState(ws);
  const expectedRevision = client.revision;
  const commandId = nextCommandId();
  const errorPromise = waitForMessage(
    ws,
    (message) => message.type === 'error' && message.commandId === commandId,
    `${label} error`
  );
  ws.send(JSON.stringify({
    type: 'command',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    commandId,
    expectedRevision,
    action
  }));
  const error = await errorPromise;
  assert.equal(socketState(ws).revision, expectedRevision, `${label} rejection does not mutate revision`);
  return error;
}

async function waitForSocketRevision(ws, revision, label) {
  if (socketState(ws).revision >= revision) return socketState(ws).room;
  const frame = await waitForMessage(
    ws,
    (message) => publicSnapshotFrame(message) && message.revision >= revision,
    label
  );
  return frame.room;
}

function firstHiddenCardIndex(player) {
  return player.grid.findIndex((card) => !card.faceUp && !card.removed);
}

function firstReplacementIndex(player) {
  const hiddenIndex = firstHiddenCardIndex(player);
  if (hiddenIndex >= 0) return hiddenIndex;
  return player.grid.findIndex((card) => !card.removed);
}

function nextFastAction(state) {
  const activePlayer = state.players[state.currentPlayerIndex];
  if (state.phase === 'opening-reveal') {
    const cardIndex = firstHiddenCardIndex(activePlayer);
    assert.ok(cardIndex >= 0, 'opening reveal requires a hidden card');
    return { type: 'reveal-opening-card', cardIndex };
  }
  if (state.phase === 'choose-source') {
    if (state.drawPileCount > 0) return { type: 'draw-blind' };
    assert.ok(state.discardPile.count > 0, 'discard pile is available when draw pile is empty');
    return { type: 'choose-discard' };
  }
  if (state.phase === 'choose-replacement') {
    const cardIndex = firstReplacementIndex(activePlayer);
    assert.ok(cardIndex >= 0, 'replacement requires a grid card');
    return { type: 'replace-card', cardIndex };
  }
  throw new Error(`no scripted action for phase ${state.phase}`);
}

function completedSoloState() {
  return {
    players: [
      {
        id: 'human-1',
        kind: 'human',
        name: 'Ada',
        grid: [],
        totalScore: 22,
        roundScore: 8
      },
      {
        id: 'ai-1',
        kind: 'ai',
        name: 'Finn',
        grid: [],
        totalScore: 44,
        roundScore: 17
      }
    ],
    drawPile: [],
    discardPile: [],
    currentPlayerIndex: 0,
    phase: 'game-over',
    selectedSource: null,
    drawnCard: null,
    round: 2,
    log: ['Ada wins.'],
    winnerId: 'human-1',
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { 'human-1': 2, 'ai-1': 2 },
    roundHistory: [
      {
        round: 1,
        closerId: 'human-1',
        scores: [
          { playerId: 'human-1', name: 'Ada', roundScore: 14, totalScore: 14 },
          { playerId: 'ai-1', name: 'Finn', roundScore: 27, totalScore: 27 }
        ]
      },
      {
        round: 2,
        closerId: 'ai-1',
        scores: [
          { playerId: 'human-1', name: 'Ada', roundScore: 8, totalScore: 22 },
          { playerId: 'ai-1', name: 'Finn', roundScore: 17, totalScore: 44 }
        ]
      }
    ]
  };
}

async function sendMoveAndWait(socketsByPlayerId, room) {
  const activePlayer = room.state.players[room.state.currentPlayerIndex];
  const socket = socketsByPlayerId.get(activePlayer.id);
  assert.ok(socket, `expected socket for ${activePlayer.name}`);
  await waitForSocketRevision(socket, room.revision, `${activePlayer.name} catches up before moving`);
  const actorState = socketState(socket).room?.state;
  assert.ok(actorState, 'active player receives an authoritative state');
  assert.equal(actorState.players[actorState.currentPlayerIndex]?.id, activePlayer.id);
  const action = nextFastAction(actorState);
  return (await sendCommand(socket, action, `game ${action.type}`)).snapshot.room;
}

async function playUntilScoring(socketsByPlayerId, initialRoom) {
  let room = initialRoom;
  for (let turn = 0; turn < 200 && room.state.phase !== 'round-over' && room.state.phase !== 'game-over'; turn += 1) {
    room = await sendMoveAndWait(socketsByPlayerId, room);
  }
  assert.ok(['round-over', 'game-over'].includes(room.state.phase), 'fast scripted game should reach scoring');
  return room;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-chat-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const dbFile = path.join(tempDir, 'skyjo.sqlite');
const port = await getOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const password = 'test-password';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: password,
    SKYJO_ADMIN_INITIAL_PASSWORD: 'admin-secret-123',
    SKYJO_COOKIE_NAME: 'skyjo_smoke',
    SKYJO_DB_FILE: dbFile,
    SKYJO_ROOMS_FILE: roomsFile,
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_INVITE_SECRET: 'chat-smoke-invite-secret',
    SKYJO_INVITE_TTL_HOURS: '168',
    SKYJO_SESSION_SECRET: 'chat-smoke-secret'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const serverLogs = [];
server.stdout.on('data', (data) => serverLogs.push(String(data)));
server.stderr.on('data', (data) => serverLogs.push(String(data)));

let hostSocket;
let guestSocket;
let parkingHostSocket;
let parkingGuestSocket;
let resetHostSocket;
let resetGuestSocket;
let resetShareGuestSocket;
let reconnectSocket;

try {
  await waitForHealth(baseUrl);
  const publicManifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(publicManifest.status, 200, 'PWA manifest stays available before the site-password gate');
  assert.match(publicManifest.headers.get('content-type') || '', /application\/manifest\+json/);
  const publicManifestJson = await publicManifest.json();
  assert.equal(publicManifestJson.id, '/', 'PWA manifest has a stable app id');
  assert.equal(publicManifestJson.launch_handler?.client_mode, 'navigate-existing', 'PWA manifest opts into app URL launch handling');
  const publicAppleIcon = await fetch(`${baseUrl}/skyjo-icon-180.png`);
  assert.equal(publicAppleIcon.status, 200, 'Apple touch icon stays available before the site-password gate');
  assert.match(publicAppleIcon.headers.get('content-type') || '', /image\/png/);
  const publicServiceWorker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(publicServiceWorker.status, 200, 'Service worker stays available before the site-password gate');
  assert.match(publicServiceWorker.headers.get('content-type') || '', /application\/javascript/);
  const protectedShareLink = await fetch(`${baseUrl}/lobby?room=ABCDE`, { redirect: 'manual' });
  assert.equal(protectedShareLink.status, 302);
  assert.equal(protectedShareLink.headers.get('location'), '/login?next=%2Flobby%3Froom%3DABCDE');
  const cookie = await login(baseUrl, password, '/lobby?room=ABCDE');
  const cardAudio = await fetch(`${baseUrl}/audio/card-flip.mp3`, { headers: { Cookie: cookie } });
  assert.equal(cardAudio.status, 200, 'card audio assets are served after shared-password login');
  assert.match(cardAudio.headers.get('content-type') || '', /audio\/mpeg/);
  await assert.rejects(openSocket(baseUrl, cookie), /Unexpected server response|401/, 'multiplayer sockets require account auth');
  const hostAccount = await createAccount(baseUrl, cookie, 'ada@example.com', 'Ada');
  const guestAccount = await createAccount(baseUrl, cookie, 'grace@example.com', 'Grace');
  const hostilePathUrl = fixedOriginUrl(baseUrl, '//attacker.invalid/invite?<script>');
  assert.equal(hostilePathUrl.origin, new URL(baseUrl).origin, 'hostile path text stays on the loopback origin');
  assert.equal(hostilePathUrl.hostname, '127.0.0.1', 'hostile path text cannot become URL authority');
  const controlledValidation = await accountRequest(baseUrl, cookie, '/api/account/signup', {
    email: '<img src=x onerror=alert(1)>@example.com',
    displayName: '<script>validation-marker</script>',
    password: 'first-password',
    confirmPassword: 'different-password'
  });
  assert.equal(controlledValidation.response.status, 400, 'controlled validation remains a client error');
  assert.deepEqual(controlledValidation.payload, { error: 'Passwords must match.' });
  assert.equal(controlledValidation.response.headers.get('x-content-type-options'), 'nosniff');
  const pushConfig = await getJson(baseUrl, hostAccount.cookie, '/api/push/config');
  assert.equal(typeof pushConfig.enabled, 'boolean', 'push config reports enabled state');
  const fakePushSubscription = {
    endpoint: `https://example.com/skyjo-push-smoke-${Date.now()}`,
    keys: {
      auth: 'ZmFrZS1hdXRo',
      p256dh: 'ZmFrZS1wMjU2ZGg'
    }
  };
  const pushSubscribe = await accountRequest(baseUrl, hostAccount.cookie, '/api/push/subscribe', {
    subscription: fakePushSubscription
  });
  assert.equal(pushSubscribe.response.status, pushConfig.enabled ? 200 : 503, 'push subscription follows server push configuration');
  const pushUnsubscribe = await accountRequest(baseUrl, hostAccount.cookie, '/api/push/unsubscribe', {
    endpoint: fakePushSubscription.endpoint
  });
  assert.equal(pushUnsubscribe.response.status, 200, 'push unsubscribe is accepted');
  const profileUpdate = await accountRequest(baseUrl, hostAccount.cookie, '/api/account/profile', { displayName: 'Ada Prime' }, 'PATCH');
  assert.equal(profileUpdate.response.status, 200, 'players can update their display name');
  assert.equal(profileUpdate.payload.user.displayName, 'Ada Prime');
  const adminAccount = await loginAccount(baseUrl, cookie, 'chad.hohn@groundworkrevops.com', 'admin-secret-123');
  const selfDemote = await accountRequest(
    baseUrl,
    adminAccount.cookie,
    `/api/admin/users/${adminAccount.user.id}`,
    { role: 'player' },
    'PATCH'
  );
  assert.equal(selfDemote.response.status, 400, 'admins cannot revoke their own admin role');
  const selfDisable = await accountRequest(
    baseUrl,
    adminAccount.cookie,
    `/api/admin/users/${adminAccount.user.id}`,
    { disabled: true },
    'PATCH'
  );
  assert.equal(selfDisable.response.status, 400, 'admins cannot disable their own account');
  const adminCreated = await accountRequest(baseUrl, adminAccount.cookie, '/api/admin/users', {
    email: 'created@example.com',
    displayName: 'Created User',
    password: 'created-secret-123',
    confirmPassword: 'created-secret-123',
    role: 'player'
  });
  assert.equal(adminCreated.response.status, 201);
  assert.equal(adminCreated.payload.user.email, 'created@example.com');
  const createdLogin = await loginAccount(baseUrl, cookie, 'created@example.com', 'created-secret-123');
  const changedPassword = await accountRequest(baseUrl, createdLogin.cookie, '/api/account/password', {
    currentPassword: 'created-secret-123',
    password: 'created-secret-456',
    confirmPassword: 'created-secret-456'
  });
  assert.equal(changedPassword.response.status, 200);
  const reloggedCreated = await loginAccount(baseUrl, cookie, 'created@example.com', 'created-secret-456');
  assert.equal(reloggedCreated.user.email, 'created@example.com');
  const guestSoloSave = await accountRequest(baseUrl, cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'guest-solo'
  });
  assert.equal(guestSoloSave.response.status, 401, 'guest single-player games are not saved');
  const soloSave = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'host-solo'
  });
  assert.equal(soloSave.response.status, 201, 'logged-in single-player games are saved');
  const invalidInternalState = completedSoloState();
  invalidInternalState.players[0] = {
    ...invalidInternalState.players[0],
    id: null,
    name: '<script>internal-sqlite-marker</script>'
  };
  const internalFailure = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: invalidInternalState,
    clientGameKey: 'internal-error-smoke'
  });
  assert.equal(internalFailure.response.status, 500, 'unknown persistence failures stay server errors');
  assert.deepEqual(internalFailure.payload, { error: 'Request failed.' }, 'unknown exception details are not disclosed');
  assert.equal(internalFailure.response.headers.get('x-content-type-options'), 'nosniff');
  assert.doesNotMatch(JSON.stringify(internalFailure.payload), /sqlite|constraint|script|internal-sqlite-marker/i);

  parkingHostSocket = await openSocket(baseUrl, hostAccount.cookie, 'parking host');
  const parkingHostJoined = await sendAdmission(
    parkingHostSocket,
    { type: 'create-room', name: 'Offline Host' },
    'parking host snapshot'
  );
  const parkingRoomCode = parkingHostJoined.room.code;
  assert.match(parkingRoomCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/, 'room codes use the secure unambiguous alphabet');
  const unauthenticatedInvite = await accountRequest(baseUrl, cookie, '/api/rooms/invite', { roomCode: parkingRoomCode });
  assert.equal(unauthenticatedInvite.response.status, 401, 'room invite creation requires account auth');
  const outsiderInvite = await accountRequest(baseUrl, adminAccount.cookie, '/api/rooms/invite', { roomCode: parkingRoomCode });
  assert.equal(outsiderInvite.response.status, 403, 'room invite creation requires room membership');
  const hostInvite = await accountRequest(baseUrl, hostAccount.cookie, '/api/rooms/invite', { roomCode: parkingRoomCode });
  assert.equal(hostInvite.response.status, 200, 'room members can create invite links');
  assert.equal(hostInvite.payload.roomCode, parkingRoomCode);
  assert.match(hostInvite.payload.path, /^\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const inviteLanding = await fetch(`${baseUrl}${hostInvite.payload.path}`, { redirect: 'manual' });
  assert.equal(inviteLanding.status, 200, 'valid room invite opens the install/browser choice page');
  const inviteLandingHtml = await inviteLanding.text();
  assert.equal(inviteLandingHtml.includes(`Join Room ${parkingRoomCode}`), true, 'invite landing shows the room code');
  assert.match(inviteLandingHtml, /Add Skyjo to your Home Screen/, 'invite landing explains the home screen path');
  assert.match(inviteLandingHtml, /Open in Browser/, 'invite landing keeps the browser path available');
  const installCode = inviteLandingHtml.match(/id="invite-code" readonly value="([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7})"/)?.[1];
  assert.ok(installCode, 'invite landing includes a short install code');
  const secondInviteLanding = await fetch(`${baseUrl}${hostInvite.payload.path}`, { redirect: 'manual' });
  assert.equal(secondInviteLanding.status, 200, 'the same group invite can be opened by another player');
  const secondInviteLandingHtml = await secondInviteLanding.text();
  const secondInstallCode = secondInviteLandingHtml.match(/id="invite-code" readonly value="([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7})"/)?.[1];
  assert.ok(secondInstallCode, 'a second invite landing includes a short install code');
  assert.notEqual(secondInstallCode, installCode, 'each invite landing mints its own install code');
  const redeemedInvite = await fetch(`${baseUrl}${hostInvite.payload.path}?open=browser`, { redirect: 'manual' });
  assert.equal(redeemedInvite.status, 303, 'valid room invite can still redeem in browser before the password gate');
  assert.equal(redeemedInvite.headers.get('location'), `/lobby?room=${parkingRoomCode}`);
  const inviteCookie = redeemedInvite.headers.get('set-cookie');
  assert.ok(inviteCookie, 'valid room invite sets the shared gate cookie');
  const inviteLobby = await fetch(`${baseUrl}/lobby?room=${parkingRoomCode}`, {
    headers: { Cookie: inviteCookie.split(';')[0] },
    redirect: 'manual'
  });
  assert.equal(inviteLobby.status, 200, 'redeemed invite cookie can load the lobby');
  const installCodeRedeem = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code: installCode }),
    redirect: 'manual'
  });
  assert.equal(installCodeRedeem.status, 303, 'install code redeems before the password gate');
  assert.equal(installCodeRedeem.headers.get('location'), `/lobby?room=${parkingRoomCode}`);
  const installCodeCookie = installCodeRedeem.headers.get('set-cookie');
  assert.ok(installCodeCookie, 'install code redemption sets the shared gate cookie');
  const installCodeLobby = await fetch(`${baseUrl}/lobby?room=${parkingRoomCode}`, {
    headers: { Cookie: installCodeCookie.split(';')[0] },
    redirect: 'manual'
  });
  assert.equal(installCodeLobby.status, 200, 'install code cookie can load the lobby');
  const secondInstallCodeRedeem = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code: secondInstallCode }),
    redirect: 'manual'
  });
  assert.equal(secondInstallCodeRedeem.status, 303, 'second install code from the same invite also redeems');
  assert.equal(secondInstallCodeRedeem.headers.get('location'), `/lobby?room=${parkingRoomCode}`);
  const reusedInstallCode = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code: installCode }),
    redirect: 'manual'
  });
  assert.equal(reusedInstallCode.status, 303, 'install codes are one-time use');
  assert.equal(reusedInstallCode.headers.get('location'), '/login?inviteError=1');
  const invalidInstallCode = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code: 'BADCODE' }),
    redirect: 'manual'
  });
  assert.equal(invalidInstallCode.status, 303, 'invalid install code redirects back to login');
  assert.equal(invalidInstallCode.headers.get('location'), '/login?inviteError=1');
  const invalidInviteRoom = 'ABCDE';
  const invalidInvitePayload = Buffer.from(JSON.stringify({ room: invalidInviteRoom, exp: Date.now() + 60000 })).toString('base64url');
  const invalidInviteUrl = fixedOriginUrl(baseUrl, `/invite/${invalidInvitePayload}.bad-signature`);
  const invalidInvite = await fetch(invalidInviteUrl, { redirect: 'manual' });
  assert.equal(invalidInvite.status, 302, 'invalid room invite falls back to the normal password gate');
  assert.equal(invalidInvite.headers.get('location'), `/login?next=${encodeURIComponent(`/lobby?room=${invalidInviteRoom}`)}`);
  parkingHostSocket.close();
  await new Promise((resolve) => parkingHostSocket.once('close', resolve));
  parkingHostSocket = null;

  parkingGuestSocket = await openSocket(baseUrl, guestAccount.cookie, 'parking guest');
  const parkingGuestJoined = await sendAdmission(
    parkingGuestSocket,
    { type: 'join-room', code: parkingRoomCode, name: 'Early Guest' },
    'guest joins hostless room'
  );
  assert.equal(parkingGuestJoined.room.code, parkingRoomCode);
  assert.equal(parkingGuestJoined.room.players.find((player) => player.host)?.connected, false);
  assert.equal(parkingGuestJoined.room.players.find((player) => player.name === 'Grace')?.connected, true);

  resetHostSocket = await openSocket(baseUrl, hostAccount.cookie, 'reset host');
  const resetHostJoined = await sendAdmission(
    resetHostSocket,
    { type: 'create-room', name: 'Reset Host' },
    'reset host snapshot'
  );
  const resetOldRoomCode = resetHostJoined.room.code;
  resetGuestSocket = await openSocket(baseUrl, guestAccount.cookie, 'reset guest');
  await sendAdmission(
    resetGuestSocket,
    { type: 'join-room', code: resetOldRoomCode, name: 'Reset Guest' },
    'reset guest snapshot'
  );
  const resetGuestNoticePromise = waitForMessage(
    resetGuestSocket,
    (message) => message.type === 'error' && message.code === 'room-reset',
    'guest reset notice'
  );
  const resetNewHostRoom = (await sendCommand(resetHostSocket, { type: 'reset-room' }, 'room reset')).snapshot;
  const resetGuestNotice = await resetGuestNoticePromise;
  assert.notEqual(resetNewHostRoom.room.code, resetOldRoomCode, 'reset creates a fresh room code');
  assert.equal(resetNewHostRoom.room.status, 'waiting');
  assert.equal(resetNewHostRoom.room.players.length, 1, 'fresh reset room starts with the host only');
  assert.match(resetGuestNotice.message, /new room link/i);
  resetShareGuestSocket = await openSocket(baseUrl, guestAccount.cookie, 'reset share guest');
  const resetShareGuestJoined = await sendAdmission(
    resetShareGuestSocket,
    { type: 'join-room', code: resetNewHostRoom.room.code, name: 'Shared Link Guest' },
    'share guest joins reset room'
  );
  assert.equal(resetShareGuestJoined.room.code, resetNewHostRoom.room.code);
  assert.equal(resetShareGuestJoined.room.players.find((player) => player.name === 'Grace')?.connected, true);

  hostSocket = await openSocket(baseUrl, hostAccount.cookie, 'main host');
  const hostJoined = await sendAdmission(
    hostSocket,
    { type: 'create-room', name: 'Ada' },
    'host room snapshot'
  );
  const roomCode = hostJoined.room.code;
  assert.deepEqual(hostJoined.room.chatMessages, []);

  guestSocket = await openSocket(baseUrl, guestAccount.cookie, 'main guest');
  const guestJoined = await sendAdmission(
    guestSocket,
    { type: 'join-room', code: roomCode, name: 'Grace' },
    'guest room snapshot'
  );
  await waitForSocketRevision(hostSocket, guestJoined.revision, 'host sees guest admission');

  const hostBeforeLegacy = socketState(hostSocket);
  const legacyRevision = hostBeforeLegacy.revision;
  const legacyRoomBytes = JSON.stringify(hostBeforeLegacy.room);
  const legacyFrameStart = hostBeforeLegacy.received.length;
  const upgradePromise = waitForMessage(
    hostSocket,
    (message) => message.type === 'upgrade-required',
    'legacy update-state rejection'
  );
  hostSocket.send(JSON.stringify({
    type: 'update-state',
    state: { status: 'forged', revision: legacyRevision + 100 }
  }));
  const upgradeRequired = await upgradePromise;
  assert.equal(upgradeRequired.protocolVersion, MULTIPLAYER_PROTOCOL_VERSION);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const legacyFrames = socketState(hostSocket).received.slice(legacyFrameStart);
  assert.equal(legacyFrames.filter((message) => message.type === 'upgrade-required').length, 1);
  assert.equal(legacyFrames.some((message) => publicSnapshotFrame(message) || message.type === 'ack'), false);
  assert.equal(socketState(hostSocket).revision, legacyRevision, 'legacy state write cannot mutate revision');
  assert.equal(JSON.stringify(socketState(hostSocket).room), legacyRoomBytes, 'legacy state write cannot mutate room');

  const guestAwayPromise = waitForMessage(
    hostSocket,
    (message) => publicSnapshotFrame(message) && message.room.players.find((player) => player.id === guestJoined.playerId)?.connected === false,
    'guest away presence'
  );
  guestSocket.send(JSON.stringify({ type: 'set-presence', protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, visible: false }));
  const guestAwayRoom = await guestAwayPromise;
  assert.equal(guestAwayRoom.room.players.find((player) => player.id === guestJoined.playerId)?.connected, false);

  const guestOnlinePromise = waitForMessage(
    hostSocket,
    (message) => publicSnapshotFrame(message) && message.room.players.find((player) => player.id === guestJoined.playerId)?.connected === true,
    'guest online presence'
  );
  guestSocket.send(JSON.stringify({ type: 'set-presence', protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, visible: true }));
  const guestOnlineRoom = await guestOnlinePromise;
  assert.equal(guestOnlineRoom.room.players.find((player) => player.id === guestJoined.playerId)?.connected, true);

  await waitForSocketRevision(guestSocket, socketState(hostSocket).revision, 'guest catches up before chat');
  const chatRevision = socketState(hostSocket).revision + 1;
  const guestRoomPromise = waitForMessage(
    guestSocket,
    (message) => publicSnapshotFrame(message) && message.revision === chatRevision && message.room.chatMessages?.length === 1,
    'guest chat broadcast'
  );
  const hostRoom = (
    await sendCommand(
      hostSocket,
      { type: 'send-chat-message', text: '  Good luck   everyone  ' },
      'room chat'
    )
  ).snapshot;
  const guestRoom = await guestRoomPromise;
  const chatMessage = hostRoom.room.chatMessages[0];
  assert.equal(chatMessage.playerId, hostJoined.playerId);
  assert.equal(chatMessage.playerName, 'Ada Prime');
  assert.equal(chatMessage.text, 'Good luck everyone');
  assert.equal(guestRoom.room.chatMessages[0].id, chatMessage.id);

  reconnectSocket = await openSocket(baseUrl, hostAccount.cookie, 'reconnected host');
  const reconnectJoined = await sendAdmission(
    reconnectSocket,
    { type: 'join-room', code: roomCode, name: 'Ada Prime', playerId: hostJoined.playerId },
    'reconnect snapshot'
  );
  assert.equal(reconnectJoined.playerId, hostJoined.playerId);
  assert.equal(reconnectJoined.room.chatMessages[0].text, 'Good luck everyone');

  let gameRoom = (await sendCommand(hostSocket, { type: 'start-game' }, 'start game')).snapshot.room;
  assert.ok(gameRoom.state, 'start-game returns authoritative game state');
  const socketsByPlayerId = new Map([
    [hostJoined.playerId, hostSocket],
    [guestJoined.playerId, guestSocket]
  ]);
  gameRoom = await playUntilScoring(socketsByPlayerId, gameRoom);
  await waitForSocketRevision(hostSocket, gameRoom.revision, 'host sees scoring state');
  const expectedNewRound = gameRoom.state.phase === 'round-over' ? gameRoom.state.round + 1 : 1;

  const unreadyError = await sendCommandExpectError(hostSocket, { type: 'start-game' }, 'unready next round');
  assert.match(unreadyError.message, /everyone must confirm/i);

  gameRoom = (
    await sendCommand(hostSocket, { type: 'set-next-round-ready', ready: true }, 'host ready')
  ).snapshot.room;
  assert.deepEqual(gameRoom.readyForNextRoundPlayerIds, [hostJoined.playerId]);
  const partiallyReadyError = await sendCommandExpectError(hostSocket, { type: 'start-game' }, 'partially ready next round');
  assert.match(partiallyReadyError.message, /everyone must confirm/i);

  await waitForSocketRevision(guestSocket, gameRoom.revision, 'guest sees host ready');
  const guestReady = await sendCommand(guestSocket, { type: 'set-next-round-ready', ready: true }, 'guest ready');
  await waitForSocketRevision(hostSocket, guestReady.snapshot.revision, 'host sees all ready');
  assert.equal(socketState(hostSocket).room.readyForNextRoundPlayerIds.length, 2);
  const nextRound = (await sendCommand(hostSocket, { type: 'start-game' }, 'next round after ready')).snapshot;
  assert.equal(nextRound.room.state?.round, expectedNewRound);
  assert.equal(nextRound.room.readyForNextRoundPlayerIds.length, 0);
  gameRoom = nextRound.room;

  for (let round = 0; round < 12 && gameRoom.state.phase !== 'game-over'; round += 1) {
    gameRoom = await playUntilScoring(socketsByPlayerId, gameRoom);
    if (gameRoom.state.phase === 'game-over') break;
    const nextExpectedRound = gameRoom.state.round + 1;
    await waitForSocketRevision(hostSocket, gameRoom.revision, 'host sees round scoring');
    const hostReady = await sendCommand(
      hostSocket,
      { type: 'set-next-round-ready', ready: true },
      'host ready for stats loop'
    );
    await waitForSocketRevision(guestSocket, hostReady.snapshot.revision, 'guest sees host ready for stats loop');
    const allReady = await sendCommand(
      guestSocket,
      { type: 'set-next-round-ready', ready: true },
      'all ready for stats loop'
    );
    await waitForSocketRevision(hostSocket, allReady.snapshot.revision, 'host sees all ready for stats loop');
    gameRoom = (
      await sendCommand(hostSocket, { type: 'start-game' }, 'next round in stats loop')
    ).snapshot.room;
    assert.equal(gameRoom.state?.round, nextExpectedRound);
  }
  assert.equal(gameRoom.state.phase, 'game-over', 'scripted multiplayer should eventually save a completed game');
  assert.ok(privacyEvidence.snapshots > 0, 'the smoke inspects authoritative public snapshots');
  assert.ok(privacyEvidence.drawerBlindFrames > 0, 'the smoke observes drawer-only blind values');
  assert.ok(privacyEvidence.nonDrawerBlindFrames > 0, 'the smoke proves blind values are absent for non-drawers');

  const hostStats = await getJson(baseUrl, hostAccount.cookie, '/api/stats/summary');
  assert.equal(hostStats.self.singlePlayerGames >= 1, true, 'logged-in single-player stats are saved');
  assert.equal(hostStats.self.multiplayerGames >= 1, true, 'host multiplayer stats are saved');
  assert.equal(hostStats.coPlayers.some((player) => player.userId === guestAccount.user.id), true, 'co-player stats are visible');

  console.log(
    'chat smoke passed: login redirect, admin-created accounts, self-admin protection, account-gated rooms, signed invite landing/install codes, push config, presence, solo stats, reset/share rooms, room chat, reconnect history, ready-gated rounds, and multiplayer stats'
  );
} finally {
  reconnectSocket?.close();
  resetShareGuestSocket?.close();
  resetGuestSocket?.close();
  resetHostSocket?.close();
  parkingGuestSocket?.close();
  parkingHostSocket?.close();
  guestSocket?.close();
  hostSocket?.close();
  const serverClose = waitForServerClose(server);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await serverClose;
  await fs.rm(tempDir, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    console.error(serverLogs.join(''));
  }
}
