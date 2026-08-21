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
import {
  createRoomInviteToken,
  SYNTHETIC_APPLE_APPLICATION_IDENTIFIER
} from '../server-room-invites.mjs';

const MULTIPLAYER_PROTOCOL_VERSION = 2;
const socketStates = new WeakMap();
const privacyEvidence = { snapshots: 0, drawerBlindFrames: 0, nonDrawerBlindFrames: 0 };
const inviteSecret = 'chat-smoke-invite-secret';
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

function parseCspDirectives(value) {
  const directives = new Map();
  for (const segment of value.split(';')) {
    const [name, ...tokens] = segment.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    assert.equal(directives.has(name), false, `CSP directive ${name} appears only once`);
    directives.set(name, tokens);
  }
  return directives;
}

function assertLocalStyleAndFontPolicy(value, { label, nonce }) {
  const directives = parseCspDirectives(value);
  assert.deepEqual(directives.get('font-src'), ["'self'"], `${label} font-src stays self-only`);

  const styleSources = directives.get('style-src') || [];
  assert.equal(styleSources[0], "'self'", `${label} style-src starts with self`);
  if (nonce) {
    assert.equal(styleSources.length, 2, `${label} style-src permits only self and one nonce`);
    assert.match(
      styleSources[1],
      /^'nonce-[A-Za-z0-9+/]+={0,2}'$/,
      `${label} style-src uses one anchored base64 nonce`
    );
  } else {
    assert.deepEqual(styleSources, ["'self'"], `${label} style-src stays self-only`);
  }
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

async function assertProductionAppleIdentifierRequired(repoRoot) {
  const rejectedConfigurations = [
    { label: 'missing' },
    { label: 'malformed', value: 'not-an-application-identifier' },
    { label: 'placeholder', value: 'XXXXXXXXXX.com.groundworkrevops.skyjo' },
    { label: 'synthetic', value: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER },
    {
      label: 'synthetic with an arbitrary canary directory',
      value: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER,
      canaryReleaseDirectory: '/tmp/not-a-controller-canary/release'
    },
    {
      label: 'synthetic with a spoofed controller-shaped canary directory',
      value: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER,
      canaryReleaseDirectory: '/var/tmp/skyjo-deploy/30352572840-1-canary/release'
    }
  ];

  for (const configuration of rejectedConfigurations) {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apple-id-required-'));
    let child;
    try {
      const environment = {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '0',
        SKYJO_ACCESS_PASSWORD: 'apple-identifier-startup-password',
        SKYJO_DB_FILE: path.join(temporaryDirectory, 'skyjo.sqlite'),
        SKYJO_INVITE_SECRET: 'apple-identifier-startup-invite-secret',
        SKYJO_ROOMS_FILE: path.join(temporaryDirectory, 'rooms.json'),
        SKYJO_SESSION_SECRET: 'apple-identifier-startup-session-secret',
        SKYJO_VAPID_PRIVATE_KEY: '',
        SKYJO_VAPID_PUBLIC_KEY: ''
      };
      delete environment.SKYJO_APPLE_APPLICATION_IDENTIFIER;
      delete environment.SKYJO_CANARY_RELEASE_DIR;
      if (configuration.value) environment.SKYJO_APPLE_APPLICATION_IDENTIFIER = configuration.value;
      if (configuration.canaryReleaseDirectory) {
        environment.SKYJO_CANARY_RELEASE_DIR = configuration.canaryReleaseDirectory;
      }
      child = spawn(process.execPath, ['server.mjs'], {
        cwd: repoRoot,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (data) => { output += String(data); });
      child.stderr.on('data', (data) => { output += String(data); });
      const exitCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${configuration.label} Apple application identifier startup check timed out`));
        }, 5_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      assert.equal(exitCode, 1, `production rejects ${configuration.label} Apple application identifier configuration`);
      assert.match(output, /Apple application identifier configuration is missing or invalid/i);
      if (configuration.value) {
        assert.equal(output.includes(configuration.value), false, 'startup failure does not print the rejected identifier');
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
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

async function accessSessionRequest(url, { method = 'GET', body, cookie, contentType } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(`${url}/api/access/session`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual'
  });
  const payload = await response.json();
  return { response, payload };
}

async function nativeInviteRequest(url, { method = 'POST', body, contentType = 'application/json', search = '' } = {}) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(`${url}/api/rooms/invite/redeem${search}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: 'manual'
  });
  const payload = await response.json();
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

function inspectPublicSnapshot(frame, socketLabel, establishedPlayerId) {
  privacyEvidence.snapshots += 1;
  assert.equal(frame.protocolVersion, MULTIPLAYER_PROTOCOL_VERSION, `${socketLabel} snapshot uses protocol v2`);
  assert.equal(frame.revision, frame.room?.revision, `${socketLabel} frame and room revisions match`);
  const viewerPlayerId = frame.playerId ?? establishedPlayerId;
  assert.equal(typeof viewerPlayerId, 'string', `${socketLabel} snapshot identifies its viewer`);
  if (frame.playerId === undefined) {
    assert.equal(
      typeof establishedPlayerId,
      'string',
      `${socketLabel} shares an identity-free snapshot only after personalized synchronization`
    );
  } else if (establishedPlayerId !== null) {
    assert.equal(frame.playerId, establishedPlayerId, `${socketLabel} snapshot cannot change its viewer`);
  }
  assert.equal(
    frame.room?.players?.some((player) => player.id === viewerPlayerId),
    true,
    `${socketLabel} viewer remains a member of the room`
  );
  assertNoPrivateKeys(frame);
  const encoded = JSON.stringify(frame);
  assert.doesNotMatch(encoded, /card-\d+--?\d+/, `${socketLabel} snapshot hides internal card ids`);

  const state = frame.room?.state;
  if (!state) return viewerPlayerId;
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
    if (viewerPlayerId === drawerId) {
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
  return viewerPlayerId;
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
        const viewerPlayerId = inspectPublicSnapshot(message, label, state.playerId);
        state.revision = message.revision;
        state.playerId = viewerPlayerId;
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
  ws.send(JSON.stringify({
    ...message,
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    snapshotEnvelopeVersion: 2
  }));
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
await assertProductionAppleIdentifierRequired(repoRoot);
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: password,
    SKYJO_ADMIN_INITIAL_PASSWORD: 'admin-secret-123',
    SKYJO_COOKIE_NAME: 'skyjo_smoke',
    SKYJO_DB_FILE: dbFile,
    SKYJO_ROOMS_FILE: roomsFile,
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_APPLE_APPLICATION_IDENTIFIER: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER,
    SKYJO_INVITE_SECRET: inviteSecret,
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
  const appleAssociationResponse = await fetch(`${baseUrl}/.well-known/apple-app-site-association`, {
    redirect: 'manual'
  });
  assert.equal(appleAssociationResponse.status, 200, 'Apple association is public');
  assert.equal(appleAssociationResponse.headers.get('location'), null, 'Apple association is direct');
  assert.equal(appleAssociationResponse.headers.get('set-cookie'), null, 'Apple association never creates a session');
  assert.equal(appleAssociationResponse.headers.get('content-type'), 'application/json');
  assert.match(appleAssociationResponse.headers.get('cache-control') || '', /^public, max-age=\d+$/);
  const appleAssociationLength = appleAssociationResponse.headers.get('content-length');
  const appleAssociation = await appleAssociationResponse.json();
  assert.deepEqual(appleAssociation, {
    applinks: {
      details: [{
        appIDs: [SYNTHETIC_APPLE_APPLICATION_IDENTIFIER],
        components: [
          {
            '/': '/invite/*',
            '?': { open: 'browser' },
            exclude: true
          },
          { '/': '/invite/*' }
        ]
      }]
    }
  });
  assert.equal(JSON.stringify(appleAssociation).includes('webcredentials'), false);
  const appleAssociationHead = await fetch(`${baseUrl}/.well-known/apple-app-site-association`, {
    method: 'HEAD',
    redirect: 'manual'
  });
  assert.equal(appleAssociationHead.status, 200, 'Apple association supports HEAD');
  assert.equal(appleAssociationHead.headers.get('content-length'), appleAssociationLength);
  assert.equal(appleAssociationHead.headers.get('content-type'), 'application/json');
  assert.equal(appleAssociationHead.headers.get('set-cookie'), null);
  assert.equal(await appleAssociationHead.text(), '', 'HEAD omits the Apple association body');
  const appleAssociationMethod = await fetch(`${baseUrl}/.well-known/apple-app-site-association`, {
    method: 'POST',
    redirect: 'manual'
  });
  assert.equal(appleAssociationMethod.status, 405);
  assert.equal(appleAssociationMethod.headers.get('allow'), 'GET, HEAD');
  assert.equal(appleAssociationMethod.headers.get('set-cookie'), null);

  const nativeInviteMethod = await nativeInviteRequest(baseUrl, { method: 'GET' });
  assert.equal(nativeInviteMethod.response.status, 405, 'native invite redemption accepts only POST');
  assert.equal(nativeInviteMethod.response.headers.get('allow'), 'POST');
  assert.deepEqual(nativeInviteMethod.payload, { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' });
  const nativeInviteFailures = [
    await nativeInviteRequest(baseUrl, {
      body: JSON.stringify({ token: 'payload.signature' }),
      contentType: 'text/plain'
    }),
    await nativeInviteRequest(baseUrl, { body: '{"token":' }),
    await nativeInviteRequest(baseUrl, { body: '[]' }),
    await nativeInviteRequest(baseUrl, { body: JSON.stringify({ token: 'payload.signature', extra: true }) }),
    await nativeInviteRequest(baseUrl, {
      body: JSON.stringify({ token: 'payload.signature' }),
      search: '?token=payload.signature'
    }),
    await nativeInviteRequest(baseUrl, { body: JSON.stringify({ token: 'not-a-signed-token' }) }),
    await nativeInviteRequest(baseUrl, { body: JSON.stringify({ token: `a.${'b'.repeat(2047)}` }) }),
    await nativeInviteRequest(baseUrl, { body: JSON.stringify({ token: `a.${'b'.repeat(256 * 1024)}` }) })
  ];
  assert.deepEqual(
    nativeInviteFailures.map(({ response, payload }) => [response.status, payload.code]),
    [
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [400, 'INVALID_JSON'],
      [400, 'EXPECTED_JSON_OBJECT'],
      [400, 'INVALID_REQUEST'],
      [400, 'INVALID_REQUEST'],
      [410, 'INVITE_INVALID_OR_EXPIRED'],
      [410, 'INVITE_INVALID_OR_EXPIRED'],
      [413, 'REQUEST_TOO_LARGE']
    ]
  );
  for (const { response, payload } of nativeInviteFailures) {
    assert.equal(response.headers.get('set-cookie'), null, 'native invite failure never grants access');
    assert.equal(response.headers.get('location'), null, 'native invite failure never redirects');
    assert.match(response.headers.get('cache-control') || '', /no-store/i);
    assert.deepEqual(Object.keys(payload).sort(), ['code', 'error']);
  }
  const publicLoginPage = await fetch(`${baseUrl}/login?next=%2Frules`, { redirect: 'manual' });
  assert.equal(publicLoginPage.status, 302, 'retired password page redirects directly into the app');
  assert.equal(publicLoginPage.headers.get('location'), '/rules');
  assert.equal(publicLoginPage.headers.get('set-cookie'), null);
  const publicManifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(publicManifest.status, 200, 'PWA manifest stays publicly available');
  assert.match(publicManifest.headers.get('content-type') || '', /application\/manifest\+json/);
  const publicManifestJson = await publicManifest.json();
  assert.equal(publicManifestJson.id, '/', 'PWA manifest has a stable app id');
  assert.equal(publicManifestJson.launch_handler?.client_mode, 'navigate-existing', 'PWA manifest opts into app URL launch handling');
  const publicAppleIcon = await fetch(`${baseUrl}/skyjo-icon-180.png`);
  assert.equal(publicAppleIcon.status, 200, 'Apple touch icon stays publicly available');
  assert.match(publicAppleIcon.headers.get('content-type') || '', /image\/png/);
  const publicServiceWorker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(publicServiceWorker.status, 200, 'Service worker stays publicly available');
  assert.match(publicServiceWorker.headers.get('content-type') || '', /application\/javascript/);
  const openShareLink = await fetch(`${baseUrl}/lobby?room=ABCDE`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual'
  });
  assert.equal(openShareLink.status, 200, 'room links reach the open app shell without a shared cookie');

  const signedOutAccount = await fetch(`${baseUrl}/api/account/me?invite=invalid`, { redirect: 'manual' });
  assert.equal(signedOutAccount.status, 200, 'account status is public but remains signed out');
  assert.deepEqual(await signedOutAccount.json(), { user: null });

  const initialAccess = await accessSessionRequest(baseUrl);
  assert.equal(initialAccess.response.status, 200);
  assert.deepEqual(initialAccess.payload, { authenticated: true });
  assert.match(initialAccess.response.headers.get('content-type') || '', /^application\/json\b/);
  assert.match(initialAccess.response.headers.get('cache-control') || '', /no-store/i);

  const malformedAccess = await accessSessionRequest(baseUrl, { cookie: 'skyjo_smoke=%E0%A4%A' });
  assert.equal(malformedAccess.response.status, 200, 'malformed cookies do not escape as server errors');
  assert.deepEqual(malformedAccess.payload, { authenticated: true });

  const unsupportedAccessMethod = await accessSessionRequest(baseUrl, { method: 'PATCH' });
  assert.equal(unsupportedAccessMethod.response.status, 405);
  assert.equal(unsupportedAccessMethod.response.headers.get('allow'), 'GET, POST, DELETE');
  assert.deepEqual(unsupportedAccessMethod.payload, {
    code: 'METHOD_NOT_ALLOWED',
    error: 'Method not allowed.'
  });

  for (const [contentType, body] of [
    ['text/plain', JSON.stringify({ password })],
    ['application/json', '{"password":'],
    ['application/json', '[]'],
    ['application/json', JSON.stringify({ password: 'wrong-password' })],
    ['application/json', JSON.stringify({ password: 'x'.repeat(4096) })],
    ['application/json', JSON.stringify({ password: 'x'.repeat(4097) })],
    ['application/json', JSON.stringify({})],
    ['application/json', JSON.stringify({ password: '' })],
    ['application/json', JSON.stringify({ password: 123 })],
    ['application/json', JSON.stringify({ password, unexpected: true })],
  ]) {
    const compatibleAccess = await accessSessionRequest(baseUrl, {
      method: 'POST',
      body,
      contentType
    });
    assert.equal(compatibleAccess.response.status, 200, 'legacy access POST ignores password-shaped content');
    assert.deepEqual(compatibleAccess.payload, { authenticated: true });
    assert.equal(compatibleAccess.response.headers.getSetCookie().length, 1);
  }

  for (const body of [
    {},
    { password: '' },
    { password: 123 },
    { password, unexpected: true },
    { password: 'x'.repeat(4097) }
  ]) {
    const compatibleAccess = await accessSessionRequest(baseUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      contentType: 'application/json; charset=utf-8'
    });
    assert.equal(compatibleAccess.response.status, 200);
    assert.deepEqual(compatibleAccess.payload, { authenticated: true });
  }

  const oversizedAccess = await accessSessionRequest(baseUrl, {
    method: 'POST',
    body: JSON.stringify({ password: 'x'.repeat(256 * 1024) }),
    contentType: 'application/json'
  });
  assert.equal(oversizedAccess.response.status, 413);
  assert.equal(oversizedAccess.payload.code, 'REQUEST_TOO_LARGE');

  const grantedAccess = await accessSessionRequest(baseUrl, {
    method: 'POST',
    body: JSON.stringify({ password }),
    contentType: 'application/json'
  });
  assert.equal(grantedAccess.response.status, 200);
  assert.deepEqual(grantedAccess.payload, { authenticated: true });
  const grantedCookieHeaders = grantedAccess.response.headers.getSetCookie();
  assert.equal(grantedCookieHeaders.length, 1);
  assert.match(grantedCookieHeaders[0], /^skyjo_smoke=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const grantedCookie = grantedCookieHeaders[0].split(';', 1)[0];
  const confirmedAccess = await accessSessionRequest(baseUrl, { cookie: grantedCookie });
  assert.deepEqual(confirmedAccess.payload, { authenticated: true });

  const accessLogoutAccount = await createAccount(
    baseUrl,
    grantedCookie,
    'access-logout@example.com',
    'Access Logout'
  );
  const accountCookie = accessLogoutAccount.cookie
    .split('; ')
    .find((value) => value.startsWith('skyjo_account='));
  assert.ok(accountCookie, 'access logout setup returned an account cookie');
  const deletedAccess = await accessSessionRequest(baseUrl, {
    method: 'DELETE',
    cookie: accessLogoutAccount.cookie
  });
  assert.equal(deletedAccess.response.status, 200);
  assert.deepEqual(deletedAccess.payload, { authenticated: true });
  const expiredCookies = deletedAccess.response.headers.getSetCookie();
  assert.equal(expiredCookies.length, 2, 'legacy access logout expires both cookie names');
  assert.ok(expiredCookies.some((value) => /^skyjo_smoke=;/.test(value) && /Max-Age=0/.test(value)));
  assert.ok(expiredCookies.some((value) => /^skyjo_account=;/.test(value) && /Max-Age=0/.test(value)));

  const repeatedDelete = await accessSessionRequest(baseUrl, { method: 'DELETE' });
  assert.equal(repeatedDelete.response.status, 200, 'access logout is idempotent');
  assert.equal(repeatedDelete.response.headers.getSetCookie().length, 2);

  const cookie = await login(baseUrl, password, '/lobby?room=ABCDE');
  const revokedAccount = await getJson(baseUrl, `${cookie}; ${accountCookie}`, '/api/account/me');
  assert.equal(revokedAccount.user, null, 'access logout revokes the current account session when available');
  const authenticatedShell = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  assert.equal(authenticatedShell.status, 200);
  assert.match(authenticatedShell.headers.get('cache-control') || '', /no-store/i);
  assert.equal(authenticatedShell.headers.get('referrer-policy'), 'no-referrer');
  const authenticatedShellCsp = authenticatedShell.headers.get('content-security-policy') || '';
  assertLocalStyleAndFontPolicy(authenticatedShellCsp, { label: 'SPA CSP', nonce: false });
  const authenticatedShellHtml = await authenticatedShell.text();
  for (const marker of ['viewport-fit=cover', 'mobile-web-app-capable', 'apple-mobile-web-app-capable', 'manifest.webmanifest', 'apple-touch-icon']) {
    assert.match(authenticatedShellHtml, new RegExp(marker), `SPA head includes ${marker}`);
  }
  const stylesheetPath = authenticatedShellHtml.match(/href="([^"]+\.css)"/)?.[1];
  assert.ok(stylesheetPath, 'SPA shell references its compiled stylesheet');
  const compiledStylesheet = await fetch(new URL(stylesheetPath, baseUrl), { headers: { Cookie: cookie } });
  assert.equal(compiledStylesheet.status, 200, 'compiled stylesheet is available');
  const compiledCss = await compiledStylesheet.text();
  assert.equal(compiledCss.includes('@import'), false, 'critical CSS has no imported stylesheets');
  assert.equal(compiledCss.includes('url('), false, 'critical CSS has no external resource references');
  const cardAudio = await fetch(`${baseUrl}/audio/card-flip.mp3`, { headers: { Cookie: cookie } });
  assert.equal(cardAudio.status, 200, 'card audio assets are served from the open app');
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
  assert.deepEqual(controlledValidation.payload, {
    code: 'PASSWORDS_MUST_MATCH',
    error: 'Passwords must match.'
  });
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
  const soloCompletedAt = Date.now() - 1_000;
  const legacySoloSave = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'legacy-solo',
    completedAt: soloCompletedAt
  });
  assert.equal(legacySoloSave.response.status, 426, 'legacy stats clients must upgrade before delivery');
  const malformedSoloOwner = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'malformed-owner-solo',
    completedAt: soloCompletedAt,
    expectedAccountUserId: 'not-a-uuid'
  });
  assert.equal(malformedSoloOwner.response.status, 426, 'malformed expected account ids require an upgrade');
  const changedSoloOwner = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'changed-owner-solo',
    completedAt: soloCompletedAt,
    expectedAccountUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  });
  assert.equal(changedSoloOwner.response.status, 409, 'stats delivery refuses a changed authenticated account');
  const soloSave = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: completedSoloState(),
    clientGameKey: 'host-solo',
    completedAt: soloCompletedAt,
    expectedAccountUserId: hostAccount.user.id
  });
  assert.equal(soloSave.response.status, 201, 'logged-in single-player games are saved');
  assert.equal(soloSave.payload.game.completedAt, soloCompletedAt, 'single-player completion time survives queued delivery');
  const invalidInternalState = completedSoloState();
  invalidInternalState.players[0] = {
    ...invalidInternalState.players[0],
    id: null,
    name: '<script>internal-sqlite-marker</script>'
  };
  const internalFailure = await accountRequest(baseUrl, hostAccount.cookie, '/api/stats/single-player', {
    state: invalidInternalState,
    clientGameKey: 'internal-error-smoke',
    completedAt: soloCompletedAt,
    expectedAccountUserId: hostAccount.user.id
  });
  assert.equal(internalFailure.response.status, 500, 'unknown persistence failures stay server errors');
  assert.deepEqual(
    internalFailure.payload,
    { code: 'REQUEST_FAILED', error: 'Request failed.' },
    'unknown exception details are not disclosed'
  );
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
  assert.equal(
    typeof hostInvite.payload.path === 'string'
      && /^\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(hostInvite.payload.path),
    true,
    'invite creation returns a structurally valid signed path without logging it'
  );
  const signedInviteToken = hostInvite.payload.path.slice('/invite/'.length);
  const [signedInvitePayload] = signedInviteToken.split('.');
  const decodedInvite = JSON.parse(Buffer.from(signedInvitePayload, 'base64url').toString('utf8'));
  const expiredInvite = createRoomInviteToken({
    roomCode: parkingRoomCode,
    roomInstanceId: decodedInvite.roomInstanceId,
    secret: inviteSecret,
    ttlMs: 1,
    now: () => Date.now() - 2,
    randomBytes: () => Buffer.alloc(16, 9)
  });
  const expiredNativeInvite = await nativeInviteRequest(baseUrl, {
    body: JSON.stringify({ token: expiredInvite.token })
  });
  assert.equal(expiredNativeInvite.response.status, 410, 'expired native invite fails closed');
  assert.equal(
    expiredNativeInvite.payload !== null
      && typeof expiredNativeInvite.payload === 'object'
      && !Array.isArray(expiredNativeInvite.payload)
      && Object.keys(expiredNativeInvite.payload).sort().join(',') === 'code,error'
      && expiredNativeInvite.payload.code === 'INVITE_INVALID_OR_EXPIRED'
      && expiredNativeInvite.payload.error === 'This invite is invalid or has expired.',
    true,
    'expired native invite returns only the generic failure contract'
  );
  assert.equal(expiredNativeInvite.response.headers.get('set-cookie'), null);
  const nativeInvite = await nativeInviteRequest(baseUrl, {
    body: JSON.stringify({ token: signedInviteToken })
  });
  assert.equal(nativeInvite.response.status, 200, 'native invite redeems without a shared-password gate');
  assert.equal(nativeInvite.response.headers.get('location'), null, 'native invite success is direct');
  assert.match(nativeInvite.response.headers.get('cache-control') || '', /no-store/i);
  assert.equal(
    nativeInvite.payload !== null
      && typeof nativeInvite.payload === 'object'
      && !Array.isArray(nativeInvite.payload)
      && Object.keys(nativeInvite.payload).sort().join(',') === 'expiresAt,roomCode'
      && nativeInvite.payload.roomCode === parkingRoomCode
      && nativeInvite.payload.expiresAt === hostInvite.payload.expiresAt,
    true,
    'native invite response returns only the expected room and expiry fields'
  );
  assert.equal(JSON.stringify(nativeInvite.payload).includes(signedInviteToken), false, 'native response does not reflect the token');
  assert.equal(JSON.stringify(nativeInvite.payload).includes(decodedInvite.roomInstanceId), false, 'native response does not expose the room instance');
  const nativeInviteCookies = nativeInvite.response.headers.getSetCookie();
  assert.equal(nativeInviteCookies.length, 1, 'native invite grants only one session layer');
  assert.equal(
    /^skyjo_smoke=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/.test(nativeInviteCookies[0] || ''),
    true,
    'native invite cookie has the expected secure structure without logging its value'
  );
  assert.equal(nativeInviteCookies[0].includes('skyjo_account='), false, 'native invite never grants account authentication');
  const nativeInviteLobby = await fetch(`${baseUrl}/lobby?room=${parkingRoomCode}`, {
    headers: { Accept: 'text/html', Cookie: nativeInviteCookies[0].split(';', 1)[0] },
    redirect: 'manual'
  });
  assert.equal(nativeInviteLobby.status, 200, 'native invite compatibility cookie can load the open lobby');
  const inviteLanding = await fetch(`${baseUrl}${hostInvite.payload.path}`, { redirect: 'manual' });
  assert.equal(inviteLanding.status, 200, 'valid room invite opens the install/browser choice page');
  assert.match(inviteLanding.headers.get('cache-control') || '', /no-store/i);
  assert.equal(inviteLanding.headers.get('referrer-policy'), 'no-referrer');
  assert.match(inviteLanding.headers.get('content-security-policy') || '', /default-src 'self'/);
  const inviteLandingHtml = await inviteLanding.text();
  for (const marker of ['viewport-fit=cover', 'mobile-web-app-capable', 'apple-mobile-web-app-capable', 'manifest.webmanifest', 'apple-touch-icon']) {
    assert.match(inviteLandingHtml, new RegExp(marker), `invite SSR head includes ${marker}`);
  }
  assert.equal(inviteLandingHtml.includes(`Join Room ${parkingRoomCode}`), true, 'invite landing shows the room code');
  assert.match(inviteLandingHtml, /Add Skyjo to your Home Screen/, 'invite landing explains the home screen path');
  assert.match(inviteLandingHtml, /Open in Browser/, 'invite landing keeps the browser path available');
  assert.match(
    inviteLandingHtml,
    new RegExp(`id="room-code" readonly value="${parkingRoomCode}"`),
    'invite landing preserves the reusable room code for Home Screen players'
  );
  assert.equal(inviteLandingHtml.includes('id="invite-code"'), false, 'invite landing does not mint an obsolete install code');
  const secondInviteLanding = await fetch(`${baseUrl}${hostInvite.payload.path}`, { redirect: 'manual' });
  assert.equal(secondInviteLanding.status, 200, 'the same group invite can be opened by another player');
  const secondInviteLandingHtml = await secondInviteLanding.text();
  assert.match(
    secondInviteLandingHtml,
    new RegExp(`id="room-code" readonly value="${parkingRoomCode}"`),
    'the reusable group invite keeps the same room code'
  );
  assert.equal(secondInviteLandingHtml.includes('id="invite-code"'), false, 'a repeated landing still mints no install code');
  const redeemedInvite = await fetch(`${baseUrl}${hostInvite.payload.path}?open=browser`, { redirect: 'manual' });
  assert.equal(redeemedInvite.status, 303, 'valid room invite can continue directly into the open browser app');
  assert.equal(redeemedInvite.headers.get('location'), `/lobby?room=${parkingRoomCode}`);
  const inviteCookie = redeemedInvite.headers.get('set-cookie');
  assert.ok(inviteCookie, 'valid room invite retains the rollback-compatibility cookie');
  const inviteLobby = await fetch(`${baseUrl}/lobby?room=${parkingRoomCode}`, {
    headers: { Accept: 'text/html', Cookie: inviteCookie.split(';')[0] },
    redirect: 'manual'
  });
  assert.equal(inviteLobby.status, 200, 'redeemed invite cookie can load the lobby');
  const invalidInstallCode = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code: 'BADCODE' }),
    redirect: 'manual'
  });
  assert.equal(invalidInstallCode.status, 400, 'invalid install code returns the gate-free invite page');
  assert.match(await invalidInstallCode.text(), /invite code expired or did not match/i);
  const invalidInviteRoom = 'ABCDE';
  const invalidInvitePayload = Buffer.from(JSON.stringify({ room: invalidInviteRoom, exp: Date.now() + 60000 })).toString('base64url');
  const invalidInviteUrl = fixedOriginUrl(baseUrl, `/invite/${invalidInvitePayload}.bad-signature`);
  const invalidInvite = await fetch(invalidInviteUrl, { redirect: 'manual' });
  assert.equal(invalidInvite.status, 410, 'invalid room invite fails closed without reflecting untrusted payload data');
  assert.equal(invalidInvite.headers.get('location'), null, 'invalid room invite does not redirect using attacker-controlled data');
  assert.equal(invalidInvite.headers.get('set-cookie'), null, 'invalid room invite does not grant access');
  const invalidInviteHtml = await invalidInvite.text();
  assert.match(invalidInviteHtml, /invite unavailable/i);
  assert.equal(invalidInviteHtml.includes(invalidInviteRoom), false, 'invalid invite response does not reflect an attacker room');
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
  const resetRoomInvite = await accountRequest(baseUrl, hostAccount.cookie, '/api/rooms/invite', {
    roomCode: resetOldRoomCode
  });
  assert.equal(resetRoomInvite.response.status, 200, 'reset-room host can mint an invite before replacement');
  const resetInviteLanding = await fetch(`${baseUrl}${resetRoomInvite.payload.path}`, { redirect: 'manual' });
  assert.equal(resetInviteLanding.status, 200);
  const resetInviteHtml = await resetInviteLanding.text();
  assert.match(
    resetInviteHtml,
    new RegExp(`id="room-code" readonly value="${resetOldRoomCode}"`),
    'pre-reset invite presents the current reusable room code'
  );
  assert.equal(resetInviteHtml.includes('id="invite-code"'), false, 'pre-reset invite mints no install code');
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
  const staleNativeInvite = await nativeInviteRequest(baseUrl, {
    body: JSON.stringify({ token: resetRoomInvite.payload.path.slice('/invite/'.length) })
  });
  assert.equal(staleNativeInvite.response.status, 410, 'native invite detects a replaced room instance');
  assert.equal(
    staleNativeInvite.payload !== null
      && typeof staleNativeInvite.payload === 'object'
      && !Array.isArray(staleNativeInvite.payload)
      && Object.keys(staleNativeInvite.payload).sort().join(',') === 'code,error'
      && staleNativeInvite.payload.code === 'INVITE_ROOM_UNAVAILABLE'
      && staleNativeInvite.payload.error === 'That room is no longer available. Ask the host for a new invite.',
    true,
    'stale native invite returns only the generic unavailable-room contract'
  );
  assert.equal(staleNativeInvite.response.headers.get('set-cookie'), null);
  const staleLongInvite = await fetch(`${baseUrl}${resetRoomInvite.payload.path}?open=browser`, { redirect: 'manual' });
  assert.equal(staleLongInvite.status, 410, 'long invite is stale after the room instance is replaced');
  assert.equal(staleLongInvite.headers.get('set-cookie'), null, 'stale long invite cannot grant access');
  const boundedNativeInviteAttempts = await Promise.all(Array.from({ length: 2 }, () => nativeInviteRequest(baseUrl, {
    body: JSON.stringify({ token: 'payload.signature' })
  })));
  for (const attempt of boundedNativeInviteAttempts) {
    assert.equal(attempt.response.status, 410, 'native invite attempts remain generic before the bound');
    assert.equal(attempt.payload.code, 'INVITE_INVALID_OR_EXPIRED');
    assert.equal(attempt.response.headers.get('set-cookie'), null);
  }
  const rateLimitedNativeInvite = await nativeInviteRequest(baseUrl, {
    body: JSON.stringify({ token: 'payload.signature' })
  });
  assert.equal(rateLimitedNativeInvite.response.status, 429, 'native invite attempts are rate limited by trusted client IP');
  assert.deepEqual(rateLimitedNativeInvite.payload, {
    code: 'INVITE_RATE_LIMITED',
    error: 'Too many invite attempts. Try again later.'
  });
  assert.match(rateLimitedNativeInvite.response.headers.get('retry-after') || '', /^\d+$/);
  assert.equal(rateLimitedNativeInvite.response.headers.get('set-cookie'), null);
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
  guestSocket.send(JSON.stringify({ type: 'set-presence', visible: false }));
  const guestAwayRoom = await guestAwayPromise;
  assert.equal(guestAwayRoom.room.players.find((player) => player.id === guestJoined.playerId)?.connected, false);

  const guestOnlinePromise = waitForMessage(
    hostSocket,
    (message) => publicSnapshotFrame(message) && message.room.players.find((player) => player.id === guestJoined.playerId)?.connected === true,
    'guest online presence'
  );
  guestSocket.send(JSON.stringify({ type: 'set-presence', visible: true }));
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

  const retainedServerLogs = serverLogs.join('');
  const retainedState = `${await fs.readFile(roomsFile, 'utf8')}\n${await fs.readFile(dbFile)}`;
  for (const privateValue of [
    signedInviteToken,
    expiredInvite.token,
    resetRoomInvite.payload.path.slice('/invite/'.length),
    inviteSecret
  ]) {
    assert.equal(retainedServerLogs.includes(privateValue), false, 'invite secrets and tokens stay out of server logs');
    assert.equal(retainedState.includes(privateValue), false, 'invite secrets and tokens stay out of persistent state');
  }

  let signupRateLimit = null;
  for (let attempt = 0; attempt < 12 && !signupRateLimit; attempt += 1) {
    const result = await accountRequest(baseUrl, '', '/api/account/signup', {
      email: `rate-signup-${attempt}@example.test`,
      displayName: 'Rate Test',
      password: 'short',
      confirmPassword: 'short'
    });
    if (result.response.status === 429) signupRateLimit = result;
    else assert.equal(result.response.status, 400, 'bounded signup attempts fail validation before the client limit');
  }
  assert.ok(signupRateLimit, 'public signup has a bounded per-client attempt window');
  assert.deepEqual(signupRateLimit.payload, {
    code: 'ACCOUNT_RATE_LIMITED',
    error: 'Too many account attempts. Try again later.'
  });
  assert.match(signupRateLimit.response.headers.get('retry-after') || '', /^\d+$/);

  let loginRateLimit = null;
  for (let attempt = 0; attempt < 22 && !loginRateLimit; attempt += 1) {
    const result = await accountRequest(baseUrl, '', '/api/account/login', {
      email: `missing-login-${attempt}@example.test`,
      password: 'not-a-real-password'
    });
    if (result.response.status === 429) loginRateLimit = result;
    else assert.equal(result.response.status, 401, 'bounded login attempts retain the generic credential failure');
  }
  assert.ok(loginRateLimit, 'public login has a bounded per-client attempt window');
  assert.deepEqual(loginRateLimit.payload, {
    code: 'ACCOUNT_RATE_LIMITED',
    error: 'Too many account attempts. Try again later.'
  });
  assert.match(loginRateLimit.response.headers.get('retry-after') || '', /^\d+$/);

  console.log(
    'chat smoke passed: public AASA, native and browser invite redemption, login redirect, rate-limited accounts, account-gated rooms, push config, presence, solo stats, reset/share rooms, room chat, reconnect history, ready-gated rounds, and multiplayer stats'
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
    console.error('Chat smoke server diagnostics were suppressed because they may contain private invite or session data.');
  }
}
