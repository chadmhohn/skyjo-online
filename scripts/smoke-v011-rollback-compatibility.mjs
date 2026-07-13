import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAccountStore } from '../server-account-store.mjs';
import { hashInviteInstallCode } from '../server-invite-codes.mjs';
import { serializeRooms } from '../server-room-persistence.mjs';

const execFileAsync = promisify(execFile);
const tag = 'v0.1.1';
const expectedCommit = '15b354786a0b0ced130b9cdb4da89b904b5942e8';
const roomInstanceId = '44444444-4444-4444-8444-444444444444';
const inviteSecret = 'v011-rollback-invite-secret-0123456789';

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a compatibility port.');
  return address.port;
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`v0.1.1 server exited before readiness with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // The exact old server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('v0.1.1 server did not become ready within 15 seconds.');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('v0.1.1 server did not stop gracefully.')), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function waitingRoom(now) {
  return {
    roomVersion: 2,
    roomInstanceId,
    code: 'ABCDE',
    hostId: 'host-1',
    players: [{
      id: 'host-1',
      userId: 'user-1',
      name: 'Rollback Host',
      connected: false,
      host: true,
      joinedAt: now - 1_000,
      lastSeenAt: now - 1_000,
      controller: 'human'
    }],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: now,
    completedGameId: null,
    gameSessionId: null,
    finishedByAi: false,
    revision: 0,
    recentCommandIds: [],
    resetAliases: [],
    clients: new Set()
  };
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-v011-server-compat-'));
const sourceDirectory = path.join(temporaryRoot, 'source');
const stateDirectory = path.join(temporaryRoot, 'state');
const archivePath = path.join(temporaryRoot, 'v0.1.1.tar');
let server = null;
let logs = '';

try {
  const { stdout: resolvedTag } = await execFileAsync('git', ['rev-parse', `${tag}^{commit}`], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  assert.equal(resolvedTag.trim(), expectedCommit, `${tag} must remain immutable.`);
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.mkdir(stateDirectory, { recursive: true });
  await execFileAsync('git', ['archive', '--format=tar', '--output', archivePath, tag], { cwd: projectRoot });
  await execFileAsync('tar', ['--extract', '--file', archivePath, '--directory', sourceDirectory]);
  await fs.symlink(
    path.join(projectRoot, 'node_modules'),
    path.join(sourceDirectory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  const buildEnvironment = {
    ...process.env,
    SKYJO_BUILD_TIMESTAMP: '2026-07-11T12:00:00.000Z',
    SKYJO_RELEASE_SHA: expectedCommit
  };
  const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const vite = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  await execFileAsync(process.execPath, [tsc], { cwd: sourceDirectory, env: buildEnvironment });
  await execFileAsync(process.execPath, [tsc, '-p', 'tsconfig.server.json'], { cwd: sourceDirectory, env: buildEnvironment });
  await execFileAsync(process.execPath, [vite, 'build'], { cwd: sourceDirectory, env: buildEnvironment });
  await execFileAsync(process.execPath, ['scripts/write-release-json.mjs'], { cwd: sourceDirectory, env: buildEnvironment });

  const now = Date.now();
  const databaseFile = path.join(stateDirectory, 'skyjo.sqlite');
  const roomsFile = path.join(stateDirectory, 'rooms.json');
  const currentStore = await createAccountStore({ filePath: databaseFile, now: () => now });
  const lookupHash = hashInviteInstallCode('RLL2234', inviteSecret);
  assert.equal(currentStore.createInviteCode({
    codeLookupHash: lookupHash,
    roomCode: 'ABCDE',
    roomInstanceId,
    expiresAt: now + 60 * 60 * 1_000
  }).status, 'created');
  const seededRow = currentStore.db.prepare(
    'SELECT code_lookup_hash, room_code, room_instance_id FROM invite_codes WHERE code_lookup_hash = ?'
  ).get(lookupHash);
  assert.deepEqual({ ...seededRow }, {
    code_lookup_hash: lookupHash,
    room_code: 'ABCDE',
    room_instance_id: roomInstanceId
  });
  const indexes = currentStore.db.prepare("PRAGMA index_list('invite_codes')").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_invite_codes_room_instance'), 'Upgraded DB is missing the room-instance index.');
  currentStore.close();
  await fs.writeFile(
    roomsFile,
    `${JSON.stringify(serializeRooms(new Map([['ABCDE', waitingRoom(now)]]), now), null, 2)}\n`,
    'utf8'
  );

  const port = await availablePort();
  const accessPassword = 'v011-shared-access-password';
  const accountEmail = 'v011-rollback@example.test';
  const accountPassword = 'v011-account-password';
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: accessPassword,
    SKYJO_SESSION_SECRET: 'v011-session-secret-0123456789abcdef',
    SKYJO_INVITE_SECRET: inviteSecret,
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_ADMIN_EMAIL: accountEmail,
    SKYJO_ADMIN_INITIAL_PASSWORD: accountPassword,
    SKYJO_ROOMS_FILE: roomsFile,
    SKYJO_DB_FILE: databaseFile,
    SKYJO_VAPID_PUBLIC_KEY: '',
    SKYJO_VAPID_PRIVATE_KEY: ''
  };
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: sourceDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-16_384); });
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, server);
  await execFileAsync(process.execPath, ['scripts/smoke-deployed.mjs'], {
    cwd: sourceDirectory,
    env: {
      ...environment,
      SKYJO_SMOKE_BASE_URL: baseUrl,
      SKYJO_SMOKE_ACCESS_PASSWORD: accessPassword,
      SKYJO_SMOKE_ACCOUNT_EMAIL: accountEmail,
      SKYJO_SMOKE_ACCOUNT_PASSWORD: accountPassword,
      SKYJO_EXPECTED_RELEASE_SHA: expectedCommit,
      SKYJO_EXPECTED_PROTOCOL_VERSION: '1'
    },
    timeout: 20_000
  });
  await stopChild(server);
  server = null;

  const reopened = await createAccountStore({ filePath: databaseFile, now: () => now + 1 });
  assert.equal(reopened.checkReadiness(), true, 'Current AccountStore could not reopen the old-server DB.');
  assert.deepEqual(
    { ...reopened.db.prepare(
      'SELECT code_lookup_hash, room_code, room_instance_id, redeemed_at FROM invite_codes WHERE code_lookup_hash = ?'
    ).get(lookupHash) },
    {
      code_lookup_hash: lookupHash,
      room_code: 'ABCDE',
      room_instance_id: roomInstanceId,
      redeemed_at: null
    },
    'The immutable old server changed the representative UUID-bound invite row.'
  );
  reopened.close();
  console.log(`Immutable ${tag} readiness, login, WebSocket, and upgraded-DB rollback smoke passed.`);
} catch (error) {
  if (logs) console.error(logs);
  throw error;
} finally {
  await stopChild(server);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
