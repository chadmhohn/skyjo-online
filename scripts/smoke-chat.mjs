import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

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
  await waitForMessage(guestSocket, (message) => message.type === 'joined', 'guest join');

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

  console.log('chat smoke passed: room chat broadcasts live and reconnect returns chat history');
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
