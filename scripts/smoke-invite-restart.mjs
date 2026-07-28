import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { SYNTHETIC_APPLE_APPLICATION_IDENTIFIER } from '../server-room-invites.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-invite-restart-'));
const databaseFile = path.join(temporaryDirectory, 'skyjo.sqlite');
const roomsFile = path.join(temporaryDirectory, 'rooms.json');
const accessPassword = 'invite-restart-access-password';
const accountPassword = 'invite-restart-account-password';
const accountEmail = 'invite-restart@example.test';
const protocolVersion = 2;
let child = null;
let logs = '';

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate an invite smoke port.');
  return address.port;
}

async function waitForReady(baseUrl, serverProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Invite smoke server exited ${serverProcess.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Invite smoke server did not become ready.');
}

function startServer(port) {
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: accessPassword,
    SKYJO_APPLE_APPLICATION_IDENTIFIER: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER,
    SKYJO_ACCOUNT_COOKIE_NAME: 'skyjo_restart_account',
    SKYJO_ADMIN_INITIAL_PASSWORD: '',
    SKYJO_COOKIE_NAME: 'skyjo_restart_session',
    SKYJO_DB_FILE: databaseFile,
    SKYJO_INVITE_SECRET: 'invite-restart-secret-0123456789abcdef',
    SKYJO_ROOMS_FILE: roomsFile,
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_SESSION_SECRET: 'restart-session-secret-0123456789abcdef',
    SKYJO_VAPID_PRIVATE_KEY: '',
    SKYJO_VAPID_PUBLIC_KEY: ''
  };
  const serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-64_000); });
  }
  return serverProcess;
}

async function assertShortInviteSecretIsRejected() {
  const rawShortSecret = 'raw-key';
  const serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SKYJO_ACCESS_PASSWORD: accessPassword,
      SKYJO_INVITE_SECRET: rawShortSecret,
      SKYJO_SESSION_SECRET: 'valid-session-secret-0123456789abcdef'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { output += chunk; });
  }
  const exitCode = await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => {
      serverProcess.kill();
      reject(new Error('Short-secret process did not exit.'));
    }, 5_000))
  ]);
  assert.notEqual(exitCode, 0, 'A short effective invite secret must fail startup.');
  assert.equal(output.includes(rawShortSecret), false, 'Startup logs exposed the rejected invite secret.');
  assert.equal(
    /authentication secrets are missing or invalid/i.test(output),
    true,
    'Short-secret startup failure stays generic without logging diagnostic contents.'
  );
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Invite smoke server did not stop.')), 5_000))
  ]);
}

async function waitForPersistedRoom(roomCode) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const document = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
      const room = document.rooms?.find((candidate) => candidate.code === roomCode);
      if (room?.roomInstanceId) return room.roomInstanceId;
    } catch {
      // The debounced atomic room write has not completed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Room and instance id were not persisted before restart.');
}

function cookieFrom(response, label) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, `${label} did not set a cookie.`);
  return header.split(';', 1)[0];
}

async function openRoom(baseUrl, cookies) {
  const websocketUrl = new URL('/rooms', baseUrl);
  websocketUrl.protocol = 'ws:';
  const socket = new WebSocket(websocketUrl, { headers: { Cookie: cookies } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const snapshot = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Create-room snapshot timed out.')), 5_000);
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'snapshot') return;
      clearTimeout(timeout);
      resolve(frame);
    });
  });
  socket.send(JSON.stringify({
    type: 'create-room',
    name: 'Restart Host',
    protocolVersion,
    snapshotEnvelopeVersion: 2
  }));
  const frame = await snapshot;
  return { socket, roomCode: frame.room.code };
}

try {
  await assertShortInviteSecretIsRejected();
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = startServer(port);
  await waitForReady(baseUrl, child);

  const sharedLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: accessPassword, next: '/' }),
    redirect: 'manual'
  });
  assert.equal(sharedLogin.status, 303);
  const siteCookie = cookieFrom(sharedLogin, 'Shared login');
  const signup = await fetch(`${baseUrl}/api/account/signup`, {
    method: 'POST',
    headers: { Cookie: siteCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: accountEmail,
      displayName: 'Restart Host',
      password: accountPassword,
      confirmPassword: accountPassword
    })
  });
  assert.equal(signup.status, 201);
  const accountCookie = cookieFrom(signup, 'Account signup');
  const cookies = `${siteCookie}; ${accountCookie}`;
  const { socket, roomCode } = await openRoom(baseUrl, cookies);
  const inviteResponse = await fetch(`${baseUrl}/api/rooms/invite`, {
    method: 'POST',
    headers: { Cookie: cookies, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomCode })
  });
  assert.equal(inviteResponse.status, 200);
  const invite = await inviteResponse.json();
  const inviteToken = invite.path.slice('/invite/'.length);
  const landing = await fetch(`${baseUrl}${invite.path}`);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  const code = landingHtml.match(/id="invite-code" readonly value="([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7})"/)?.[1];
  assert.ok(code, 'Invite landing did not mint a short code.');
  assert.equal(landingHtml.includes(invite.path), false, 'Invite landing duplicated the signed token in response HTML.');
  const persistedRoomInstanceId = await waitForPersistedRoom(roomCode);
  assert.equal(
    /^[0-9a-f-]{36}$/.test(persistedRoomInstanceId),
    true,
    'Persisted room instance has the expected UUID structure without logging its value.'
  );
  await stopServer(child);
  child = null;
  if (socket.readyState !== WebSocket.CLOSED) {
    await new Promise((resolve) => socket.once('close', resolve));
  }

  child = startServer(port);
  await waitForReady(baseUrl, child);
  const longAfterRestart = await fetch(`${baseUrl}${invite.path}?open=browser`, { redirect: 'manual' });
  assert.equal(longAfterRestart.status, 303, 'Room-bound long invite did not survive restart.');
  assert.equal(
    longAfterRestart.headers.get('location') === `/lobby?room=${roomCode}`,
    true,
    'Room-bound long invite redirects to its lobby without logging private room state.'
  );
  assert.ok(longAfterRestart.headers.get('set-cookie'));

  const nativeAfterRestart = await fetch(`${baseUrl}/api/rooms/invite/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken }),
    redirect: 'manual'
  });
  assert.equal(nativeAfterRestart.status, 200, 'Native room invite did not survive restart.');
  assert.equal(nativeAfterRestart.headers.get('location'), null, 'Native redemption must not redirect.');
  assert.match(nativeAfterRestart.headers.get('cache-control') || '', /no-store/i);
  const nativePayload = await nativeAfterRestart.json();
  assert.equal(
    nativePayload !== null
      && typeof nativePayload === 'object'
      && !Array.isArray(nativePayload)
      && Object.keys(nativePayload).sort().join(',') === 'expiresAt,roomCode'
      && nativePayload.roomCode === roomCode
      && nativePayload.expiresAt === invite.expiresAt,
    true,
    'Native redemption returns only the expected room and expiry fields.'
  );
  const nativeCookies = nativeAfterRestart.headers.getSetCookie();
  assert.equal(nativeCookies.length, 1, 'Native redemption grants only the outer session cookie.');
  assert.equal(
    /^skyjo_restart_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/.test(nativeCookies[0] || ''),
    true,
    'Native redemption cookie has the expected secure structure without logging its value.'
  );

  const redemptions = await Promise.all(Array.from({ length: 6 }, () => fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code }),
    redirect: 'manual'
  })));
  assert.equal(redemptions.filter((response) => response.status === 303 && response.headers.get('set-cookie')).length, 1);
  const failures = redemptions.filter((response) => !response.headers.get('set-cookie'));
  assert.equal(failures.length, 5);
  for (const response of failures) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login?inviteError=1');
  }
  const replay = await fetch(`${baseUrl}/invite-code`, {
    method: 'POST',
    body: new URLSearchParams({ code }),
    redirect: 'manual'
  });
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('location'), '/login?inviteError=1');
  assert.equal(replay.headers.get('set-cookie'), null);
  await stopServer(child);
  child = null;

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const rows = database.prepare('SELECT * FROM invite_codes').all();
  database.close();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(code), false, 'Raw invite code reached SQLite.');
  assert.equal(JSON.stringify(rows).includes(invite.path), false, 'Signed invite token reached SQLite.');
  assert.equal(JSON.stringify(rows).includes(inviteToken), false, 'Signed invite token reached SQLite without its route prefix.');
  assert.equal(rows[0].room_code === roomCode, true, 'Persisted invite remains bound to its private room.');
  assert.equal(typeof rows[0].room_instance_id, 'string');
  assert.equal(typeof rows[0].redeemed_at, 'number');
  assert.equal(logs.includes(code), false, 'Raw invite code reached server logs.');
  assert.equal(logs.includes(invite.path), false, 'Signed invite token reached server logs.');
  assert.equal(logs.includes(inviteToken), false, 'Signed invite token reached server logs without its route prefix.');
  console.log('Invite restart smoke passed: browser/native restart survival, one atomic install-code redemption, replay rejection, and no raw secret persistence.');
} catch (error) {
  if (logs) {
    console.error('Invite restart server diagnostics were suppressed because they may contain private invite or session data.');
  }
  throw error;
} finally {
  await stopServer(child);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
