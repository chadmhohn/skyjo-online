import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountStore } from '../server-account-store.mjs';
import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs';
import { runDeployedSmoke } from './deployed-smoke-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accessPassword = 'ops-smoke-access-password';
const adminEmail = 'ops-smoke@example.com';
const adminPassword = 'ops-smoke-admin-password';

async function getOpenPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(port > 0);
  return port;
}

async function waitForResponse(url, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (await predicate(response)) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw lastError || new Error(`Timed out waiting for ${new URL(url).pathname}.`);
}

async function startServer(dataDir) {
  const port = await getOpenPort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      SKYJO_ACCESS_PASSWORD: accessPassword,
      SKYJO_ADMIN_EMAIL: adminEmail,
      SKYJO_ADMIN_INITIAL_PASSWORD: adminPassword,
      SKYJO_DATABASE_RETRY_MS: '100',
      SKYJO_DB_FILE: path.join(dataDir, 'skyjo.sqlite'),
      SKYJO_INVITE_SECRET: 'ops-smoke-invite-secret',
      SKYJO_ROOMS_FILE: path.join(dataDir, 'rooms.json'),
      SKYJO_SECURE_COOKIES: 'false',
      SKYJO_SESSION_SECRET: 'ops-smoke-session-secret',
      SKYJO_VAPID_PRIVATE_KEY: '',
      SKYJO_VAPID_PUBLIC_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString('utf8');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForResponse(`${baseUrl}/healthz`, async (response) => response.status === 200 && (await response.text()) === 'ok');
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${logs}`);
  }
  return { baseUrl, child, getLogs: () => logs };
}

async function stopServer(server, { allowFailure = false } = {}) {
  if (server.child.exitCode === null) server.child.kill('SIGTERM');
  if (server.child.exitCode === null) {
    await Promise.race([once(server.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
  if (server.child.exitCode === null) server.child.kill();
  if (!allowFailure && server.child.exitCode && server.child.exitCode !== 0) throw new Error(server.getLogs());
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-ops-smoke-'));
let server;

try {
  const healthyDir = path.join(tempDir, 'healthy');
  await fs.mkdir(healthyDir);
  server = await startServer(healthyDir);
  const initialRooms = await fs.readFile(path.join(healthyDir, 'rooms.json'), 'utf8');
  await runDeployedSmoke({
    baseUrl: server.baseUrl,
    accessPassword,
    accountEmail: adminEmail,
    accountPassword: adminPassword,
    expectedProtocolVersion: CURRENT_PROTOCOL_VERSION
  });
  const roomsAfterSocket = await fs.readFile(path.join(healthyDir, 'rooms.json'), 'utf8');
  assert.equal(roomsAfterSocket, initialRooms, 'non-mutating WebSocket proof must not change room state');
  await stopServer(server);
  server = undefined;

  const recoveryDir = path.join(tempDir, 'recovery');
  await fs.mkdir(recoveryDir);
  const databasePath = path.join(recoveryDir, 'skyjo.sqlite');
  await fs.writeFile(databasePath, 'not a sqlite database', 'utf8');
  server = await startServer(recoveryDir);
  const degraded = await fetch(`${server.baseUrl}/readyz`);
  assert.equal(degraded.status, 503, 'corrupt database must not fail liveness or report ready');
  assert.deepEqual((await degraded.json()).checks, { database: 'error', roomState: 'ok', lastPersist: 'ok' });

  const replacementPath = path.join(recoveryDir, 'replacement.sqlite');
  const replacement = await createAccountStore({ filePath: replacementPath });
  replacement.close();
  await fs.rm(databasePath, { force: true });
  await fs.rename(replacementPath, databasePath);
  await waitForResponse(`${server.baseUrl}/readyz`, async (response) => response.status === 200, 8000);
  await runDeployedSmoke({
    baseUrl: server.baseUrl,
    accessPassword,
    accountEmail: adminEmail,
    accountPassword: adminPassword,
    expectedProtocolVersion: CURRENT_PROTOCOL_VERSION
  });

  await stopServer(server);
  server = undefined;

  const rejectedRoomsDir = path.join(tempDir, 'rejected-rooms');
  await fs.mkdir(rejectedRoomsDir);
  const rejectedRoomsPath = path.join(rejectedRoomsDir, 'rooms.json');
  const rejectedRooms = '{"version":99,"private":"preserve-this-file"}\n';
  await fs.writeFile(rejectedRoomsPath, rejectedRooms, 'utf8');
  server = await startServer(rejectedRoomsDir);
  const roomDegraded = await fetch(`${server.baseUrl}/readyz`);
  assert.equal(roomDegraded.status, 503, 'future room state must fail readiness without failing liveness');
  assert.deepEqual((await roomDegraded.json()).checks, { database: 'ok', roomState: 'error', lastPersist: 'error' });
  assert.equal(await fs.readFile(rejectedRoomsPath, 'utf8'), rejectedRooms, 'rejected room state must never be overwritten');
  await stopServer(server, { allowFailure: true });
  server = undefined;

  const staleCorruptDir = path.join(tempDir, 'stale-corrupt-rooms');
  await fs.mkdir(staleCorruptDir);
  const staleCorruptPath = path.join(staleCorruptDir, 'rooms.json');
  const staleCorruptDocument = {
    format: 'skyjo-rooms',
    version: 2,
    protocolVersion: 1,
    savedAt: Date.now(),
    rooms: [
      {
        code: 'STALE',
        hostId: 'host-1',
        players: [{ id: 'host-1', name: 'Host', connected: false, host: true }],
        chatMessages: [null],
        readyForNextRoundPlayerIds: [],
        state: null,
        status: 'waiting',
        updatedAt: Date.now() - 1000 * 60 * 60 * 24,
        completedGameId: null,
        gameSessionId: null
      }
    ]
  };
  const staleCorruptBytes = `${JSON.stringify(staleCorruptDocument)}\n`;
  await fs.writeFile(staleCorruptPath, staleCorruptBytes, 'utf8');
  server = await startServer(staleCorruptDir);
  const staleRoomDegraded = await fetch(`${server.baseUrl}/readyz`);
  assert.equal(staleRoomDegraded.status, 503, 'stale corrupt room state must fail readiness');
  assert.deepEqual((await staleRoomDegraded.json()).checks, { database: 'ok', roomState: 'error', lastPersist: 'error' });
  assert.equal(
    await fs.readFile(staleCorruptPath, 'utf8'),
    staleCorruptBytes,
    'stale corrupt room state must be fully validated and never overwritten'
  );
  await stopServer(server, { allowFailure: true });
  server = undefined;
  console.log('operations smoke passed: release metadata, sanitized readiness, two-cookie auth, non-mutating WebSocket, database recovery, and rejected-room preservation');
} finally {
  if (server) await stopServer(server);
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
