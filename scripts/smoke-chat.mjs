import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chooseDiscard, drawBlind, replaceCard, revealOpeningCard } from '../server-dist/game.js';

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

function openSocket(url, cookie) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/rooms`, { headers: { Cookie: cookie } });
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);

    function handleMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off('message', handleMessage);
      resolve(message);
    }

    ws.on('message', handleMessage);
  });
}

function firstHiddenCardIndex(player) {
  return player.grid.findIndex((card) => !card.faceUp && !card.removed);
}

function firstReplacementIndex(player) {
  const hiddenIndex = firstHiddenCardIndex(player);
  if (hiddenIndex >= 0) return hiddenIndex;
  return player.grid.findIndex((card) => !card.removed);
}

function nextFastMove(state) {
  const activePlayer = state.players[state.currentPlayerIndex];
  if (state.phase === 'opening-reveal') return revealOpeningCard(state, firstHiddenCardIndex(activePlayer));
  if (state.phase === 'choose-source') return state.discardPile.length > 0 ? chooseDiscard(state) : drawBlind(state);
  if (state.phase === 'choose-replacement') return replaceCard(state, firstReplacementIndex(activePlayer));
  return state;
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

async function sendMoveAndWait(socketsByPlayerId, state) {
  const activePlayer = state.players[state.currentPlayerIndex];
  const socket = socketsByPlayerId.get(activePlayer.id);
  assert.ok(socket, `expected socket for ${activePlayer.name}`);
  const nextState = nextFastMove(state);
  socket.send(JSON.stringify({ type: 'update-state', state: nextState }));
  const message = await waitForMessage(
    socket,
    (payload) =>
      payload.type === 'room' &&
      payload.room.state?.phase === nextState.phase &&
      payload.room.state?.log?.[0] === nextState.log[0],
    'game move broadcast'
  );
  return message.room.state;
}

async function playUntilScoring(socketsByPlayerId, state) {
  let roomState = state;
  for (let turn = 0; turn < 100 && roomState.phase !== 'round-over' && roomState.phase !== 'game-over'; turn += 1) {
    roomState = await sendMoveAndWait(socketsByPlayerId, roomState);
  }
  assert.ok(['round-over', 'game-over'].includes(roomState.phase), 'fast scripted game should reach scoring');
  return roomState;
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
  const protectedShareLink = await fetch(`${baseUrl}/lobby?room=ABCDE`, { redirect: 'manual' });
  assert.equal(protectedShareLink.status, 302);
  assert.equal(protectedShareLink.headers.get('location'), '/login?next=%2Flobby%3Froom%3DABCDE');
  const cookie = await login(baseUrl, password, '/lobby?room=ABCDE');
  await assert.rejects(openSocket(baseUrl, cookie), /Unexpected server response|401/, 'multiplayer sockets require account auth');
  const hostAccount = await createAccount(baseUrl, cookie, 'ada@example.com', 'Ada');
  const guestAccount = await createAccount(baseUrl, cookie, 'grace@example.com', 'Grace');
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

  parkingHostSocket = await openSocket(baseUrl, hostAccount.cookie);
  parkingHostSocket.send(JSON.stringify({ type: 'create-room', name: 'Offline Host' }));
  const parkingHostJoined = await waitForMessage(parkingHostSocket, (message) => message.type === 'joined', 'parking host join');
  const parkingRoomCode = parkingHostJoined.room.code;
  parkingHostSocket.close();
  await new Promise((resolve) => parkingHostSocket.once('close', resolve));
  parkingHostSocket = null;

  parkingGuestSocket = await openSocket(baseUrl, guestAccount.cookie);
  parkingGuestSocket.send(JSON.stringify({ type: 'join-room', code: parkingRoomCode, name: 'Early Guest' }));
  const parkingGuestJoined = await waitForMessage(parkingGuestSocket, (message) => message.type === 'joined', 'guest joins hostless room');
  assert.equal(parkingGuestJoined.room.code, parkingRoomCode);
  assert.equal(parkingGuestJoined.room.players.find((player) => player.host)?.connected, false);
  assert.equal(parkingGuestJoined.room.players.find((player) => player.name === 'Grace')?.connected, true);

  resetHostSocket = await openSocket(baseUrl, hostAccount.cookie);
  resetHostSocket.send(JSON.stringify({ type: 'create-room', name: 'Reset Host' }));
  const resetHostJoined = await waitForMessage(resetHostSocket, (message) => message.type === 'joined', 'reset host join');
  const resetOldRoomCode = resetHostJoined.room.code;
  resetGuestSocket = await openSocket(baseUrl, guestAccount.cookie);
  resetGuestSocket.send(JSON.stringify({ type: 'join-room', code: resetOldRoomCode, name: 'Reset Guest' }));
  await waitForMessage(resetGuestSocket, (message) => message.type === 'joined', 'reset guest join');
  const resetNewHostRoomPromise = waitForMessage(resetHostSocket, (message) => message.type === 'joined', 'host reset to new room');
  const resetGuestNoticePromise = waitForMessage(resetGuestSocket, (message) => message.type === 'room-reset', 'guest reset notice');
  resetHostSocket.send(JSON.stringify({ type: 'reset-room' }));
  const [resetNewHostRoom, resetGuestNotice] = await Promise.all([resetNewHostRoomPromise, resetGuestNoticePromise]);
  assert.notEqual(resetNewHostRoom.room.code, resetOldRoomCode, 'reset creates a fresh room code');
  assert.equal(resetNewHostRoom.room.status, 'waiting');
  assert.equal(resetNewHostRoom.room.players.length, 1, 'fresh reset room starts with the host only');
  assert.match(resetGuestNotice.message, /new room link/i);
  resetShareGuestSocket = await openSocket(baseUrl, guestAccount.cookie);
  resetShareGuestSocket.send(JSON.stringify({ type: 'join-room', code: resetNewHostRoom.room.code, name: 'Shared Link Guest' }));
  const resetShareGuestJoined = await waitForMessage(
    resetShareGuestSocket,
    (message) => message.type === 'joined',
    'share guest joins reset room'
  );
  assert.equal(resetShareGuestJoined.room.code, resetNewHostRoom.room.code);
  assert.equal(resetShareGuestJoined.room.players.find((player) => player.name === 'Grace')?.connected, true);

  hostSocket = await openSocket(baseUrl, hostAccount.cookie);
  hostSocket.send(JSON.stringify({ type: 'create-room', name: 'Ada' }));
  const hostJoined = await waitForMessage(hostSocket, (message) => message.type === 'joined', 'host join');
  const roomCode = hostJoined.room.code;
  assert.deepEqual(hostJoined.room.chatMessages, []);

  guestSocket = await openSocket(baseUrl, guestAccount.cookie);
  guestSocket.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Grace' }));
  const guestJoined = await waitForMessage(guestSocket, (message) => message.type === 'joined', 'guest join');

  const hostRoomPromise = waitForMessage(
    hostSocket,
    (message) => message.type === 'room' && message.room.chatMessages?.length === 1,
    'host chat broadcast'
  );
  const guestRoomPromise = waitForMessage(
    guestSocket,
    (message) => message.type === 'room' && message.room.chatMessages?.length === 1,
    'guest chat broadcast'
  );
  hostSocket.send(JSON.stringify({ type: 'send-chat-message', text: '  Good luck   everyone  ' }));
  const [hostRoom, guestRoom] = await Promise.all([hostRoomPromise, guestRoomPromise]);
  const chatMessage = hostRoom.room.chatMessages[0];
  assert.equal(chatMessage.playerId, hostJoined.playerId);
  assert.equal(chatMessage.playerName, 'Ada Prime');
  assert.equal(chatMessage.text, 'Good luck everyone');
  assert.equal(guestRoom.room.chatMessages[0].id, chatMessage.id);

  reconnectSocket = await openSocket(baseUrl, hostAccount.cookie);
  reconnectSocket.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Ada Prime', playerId: hostJoined.playerId }));
  const reconnectJoined = await waitForMessage(reconnectSocket, (message) => message.type === 'joined', 'reconnect join');
  assert.equal(reconnectJoined.playerId, hostJoined.playerId);
  assert.equal(reconnectJoined.room.chatMessages[0].text, 'Good luck everyone');

  hostSocket.send(JSON.stringify({ type: 'start-game' }));
  let roomState = (await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.state, 'started game')).room.state;
  const socketsByPlayerId = new Map([
    [hostJoined.playerId, hostSocket],
    [guestJoined.playerId, guestSocket]
  ]);
  roomState = await playUntilScoring(socketsByPlayerId, roomState);
  const expectedNewRound = roomState.phase === 'round-over' ? roomState.round + 1 : 1;

  hostSocket.send(JSON.stringify({ type: 'start-game' }));
  const unreadyError = await waitForMessage(hostSocket, (message) => message.type === 'error', 'unready next round rejection');
  assert.match(unreadyError.message, /everyone must confirm/i);

  hostSocket.send(JSON.stringify({ type: 'set-next-round-ready', ready: true }));
  await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.readyForNextRoundPlayerIds?.length === 1, 'host ready');
  hostSocket.send(JSON.stringify({ type: 'start-game' }));
  const partiallyReadyError = await waitForMessage(hostSocket, (message) => message.type === 'error', 'partially ready next round rejection');
  assert.match(partiallyReadyError.message, /everyone must confirm/i);

  guestSocket.send(JSON.stringify({ type: 'set-next-round-ready', ready: true }));
  await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.readyForNextRoundPlayerIds?.length === 2, 'all ready');
  hostSocket.send(JSON.stringify({ type: 'start-game' }));
  const nextRound = await waitForMessage(
    hostSocket,
    (message) => message.type === 'room' && message.room.state?.round === expectedNewRound,
    'next round after ready'
  );
  assert.equal(nextRound.room.readyForNextRoundPlayerIds.length, 0);
  roomState = nextRound.room.state;

  for (let round = 0; round < 12 && roomState.phase !== 'game-over'; round += 1) {
    roomState = await playUntilScoring(socketsByPlayerId, roomState);
    if (roomState.phase === 'game-over') break;
    const nextExpectedRound = roomState.round + 1;
    hostSocket.send(JSON.stringify({ type: 'set-next-round-ready', ready: true }));
    await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.readyForNextRoundPlayerIds?.includes(hostJoined.playerId), 'host ready for stats loop');
    guestSocket.send(JSON.stringify({ type: 'set-next-round-ready', ready: true }));
    await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.readyForNextRoundPlayerIds?.length === 2, 'all ready for stats loop');
    hostSocket.send(JSON.stringify({ type: 'start-game' }));
    roomState = (
      await waitForMessage(
        hostSocket,
        (message) => message.type === 'room' && message.room.state?.round === nextExpectedRound,
        'next round in stats loop'
      )
    ).room.state;
  }
  assert.equal(roomState.phase, 'game-over', 'scripted multiplayer should eventually save a completed game');

  const hostStats = await getJson(baseUrl, hostAccount.cookie, '/api/stats/summary');
  assert.equal(hostStats.self.singlePlayerGames >= 1, true, 'logged-in single-player stats are saved');
  assert.equal(hostStats.self.multiplayerGames >= 1, true, 'host multiplayer stats are saved');
  assert.equal(hostStats.coPlayers.some((player) => player.userId === guestAccount.user.id), true, 'co-player stats are visible');

  console.log(
    'chat smoke passed: login redirect, admin-created accounts, self-admin protection, account-gated rooms, solo stats, reset/share rooms, room chat, reconnect history, ready-gated rounds, and multiplayer stats'
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
