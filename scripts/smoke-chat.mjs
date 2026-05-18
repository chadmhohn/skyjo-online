import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

async function login(url, password) {
  const response = await fetch(`${url}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password }),
    redirect: 'manual'
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected a login cookie');
  return cookie.split(';')[0];
}

function openSocket(url, cookie) {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/rooms`, { headers: { Cookie: cookie } });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-chat-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const port = await getOpenPort();
const baseUrl = `http://127.0.0.1:${port}`;
const password = 'test-password';
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve(new URL('..', import.meta.url).pathname),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: password,
    SKYJO_COOKIE_NAME: 'skyjo_smoke',
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
let reconnectSocket;

try {
  await waitForHealth(baseUrl);
  const cookie = await login(baseUrl, password);

  hostSocket = await openSocket(baseUrl, cookie);
  hostSocket.send(JSON.stringify({ type: 'create-room', name: 'Ada' }));
  const hostJoined = await waitForMessage(hostSocket, (message) => message.type === 'joined', 'host join');
  const roomCode = hostJoined.room.code;
  assert.deepEqual(hostJoined.room.chatMessages, []);

  guestSocket = await openSocket(baseUrl, cookie);
  guestSocket.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Grace' }));
  const guestJoined = await waitForMessage(guestSocket, (message) => message.type === 'joined', 'guest join');

  hostSocket.send(JSON.stringify({ type: 'send-chat-message', text: '  Good luck   everyone  ' }));
  const hostRoom = await waitForMessage(
    hostSocket,
    (message) => message.type === 'room' && message.room.chatMessages?.length === 1,
    'host chat broadcast'
  );
  const guestRoom = await waitForMessage(
    guestSocket,
    (message) => message.type === 'room' && message.room.chatMessages?.length === 1,
    'guest chat broadcast'
  );
  const chatMessage = hostRoom.room.chatMessages[0];
  assert.equal(chatMessage.playerId, hostJoined.playerId);
  assert.equal(chatMessage.playerName, 'Ada');
  assert.equal(chatMessage.text, 'Good luck everyone');
  assert.equal(guestRoom.room.chatMessages[0].id, chatMessage.id);

  reconnectSocket = await openSocket(baseUrl, cookie);
  reconnectSocket.send(JSON.stringify({ type: 'join-room', code: roomCode, name: 'Ada', playerId: hostJoined.playerId }));
  const reconnectJoined = await waitForMessage(reconnectSocket, (message) => message.type === 'joined', 'reconnect join');
  assert.equal(reconnectJoined.playerId, hostJoined.playerId);
  assert.equal(reconnectJoined.room.chatMessages[0].text, 'Good luck everyone');

  hostSocket.send(JSON.stringify({ type: 'start-game' }));
  let roomState = (await waitForMessage(hostSocket, (message) => message.type === 'room' && message.room.state, 'started game')).room.state;
  const socketsByPlayerId = new Map([
    [hostJoined.playerId, hostSocket],
    [guestJoined.playerId, guestSocket]
  ]);
  for (let turn = 0; turn < 80 && roomState.phase !== 'round-over' && roomState.phase !== 'game-over'; turn += 1) {
    roomState = await sendMoveAndWait(socketsByPlayerId, roomState);
  }
  assert.ok(['round-over', 'game-over'].includes(roomState.phase), 'fast scripted game should reach scoring');
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

  console.log('chat smoke passed: room chat, reconnect history, and ready-gated next round');
} finally {
  reconnectSocket?.close();
  guestSocket?.close();
  hostSocket?.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('close', resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
  if (server.exitCode && server.exitCode !== 0) {
    console.error(serverLogs.join(''));
  }
}
