import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  APNS_DEVICE_STORAGE_ENVELOPE,
  createAccountStore
} from '../server-account-store.mjs';
import { saveRoomsToDisk } from '../server-room-persistence.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apns-rollback-envelope-'));
const seedDatabase = path.join(temporaryDirectory, 'future-feature.sqlite');
const copiedDatabase = path.join(temporaryDirectory, 'rollback-copy.sqlite');
const roomsFiles = [
  path.join(temporaryDirectory, 'rooms-a.json'),
  path.join(temporaryDirectory, 'rooms-b.json')
];
const fixedNow = Date.parse('2026-07-28T00:00:00.000Z');
const accountEmail = 'apns-rollback-envelope@example.test';
const accountPassword = 'apns-rollback-envelope-password';
const sensitiveCanary = 'APNS-ROW-MUST-NEVER-REACH-LOGS';
const serverProcesses = [];
let logs = '';

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate an APNs rollback smoke port.');
  return address.port;
}

function apnsRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT
        installation_id,
        user_id,
        environment,
        hex(token_ciphertext) AS token_ciphertext_hex,
        hex(token_nonce) AS token_nonce_hex,
        hex(token_auth_tag) AS token_auth_tag_hex,
        hex(token_fingerprint) AS token_fingerprint_hex,
        app_version,
        locale,
        created_at,
        updated_at
      FROM apns_devices
      ORDER BY installation_id
    `).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function startServer(port, roomsFile, suffix) {
  const serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      SKYJO_ACCESS_PASSWORD: 'apns-rollback-access-password',
      SKYJO_ACCOUNT_COOKIE_NAME: `skyjo_apns_account_${suffix}`,
      SKYJO_ADMIN_EMAIL: accountEmail,
      SKYJO_ADMIN_INITIAL_PASSWORD: '',
      SKYJO_COOKIE_NAME: `skyjo_apns_access_${suffix}`,
      SKYJO_DB_FILE: copiedDatabase,
      SKYJO_INVITE_SECRET: 'apns-rollback-invite-secret-0123456789abcdef',
      SKYJO_ROOMS_FILE: roomsFile,
      SKYJO_SECURE_COOKIES: 'false',
      SKYJO_SESSION_SECRET: 'apns-rollback-session-secret-0123456789abcdef',
      SKYJO_VAPID_PRIVATE_KEY: '',
      SKYJO_VAPID_PUBLIC_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-64_000); });
  }
  serverProcesses.push(serverProcess);
  return serverProcess;
}

async function waitForReady(baseUrl, serverProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`APNs rollback smoke server exited ${serverProcess.exitCode} before readiness.`);
    }
    let response;
    try {
      response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      // A concurrent process may still hold the bounded migration lock.
    }
    if (response?.status === 200) {
      const body = await response.json();
      assert.equal(body.schemaVersion, 2);
      assert.equal(body.checks?.database, 'ok');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('APNs rollback smoke server did not become ready.');
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('APNs rollback smoke server did not stop.')),
      5_000
    ))
  ]);
}

try {
  const store = await createAccountStore({ filePath: seedDatabase, now: () => fixedNow });
  const user = await store.createUser({
    email: accountEmail,
    displayName: 'APNs Rollback',
    password: accountPassword,
    role: 'admin'
  });
  store.close();

  const database = new DatabaseSync(seedDatabase);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`${APNS_DEVICE_STORAGE_ENVELOPE.createStatements.join(';\n')};`);
  database.prepare(`
    INSERT INTO apns_devices (
      installation_id,
      user_id,
      environment,
      token_ciphertext,
      token_nonce,
      token_auth_tag,
      token_fingerprint,
      app_version,
      locale,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '30000000-0000-4000-8000-000000000001',
    user.id,
    'production',
    Buffer.from(sensitiveCanary, 'utf8'),
    Buffer.from('000102030405060708090a0b', 'hex'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from('ef'.repeat(32), 'hex'),
    '0.1.0 (203)',
    'en-US',
    fixedNow,
    fixedNow + 1
  );
  database.close();

  await fs.copyFile(seedDatabase, copiedDatabase);
  const expectedRows = apnsRows(copiedDatabase);
  assert.equal(expectedRows.length, 1);
  await Promise.all(roomsFiles.map((roomsFile) => saveRoomsToDisk(new Map(), roomsFile)));

  const ports = await Promise.all([availablePort(), availablePort()]);
  const first = startServer(ports[0], roomsFiles[0], 'a');
  const second = startServer(ports[1], roomsFiles[1], 'b');
  await Promise.all([
    waitForReady(`http://127.0.0.1:${ports[0]}`, first),
    waitForReady(`http://127.0.0.1:${ports[1]}`, second)
  ]);
  await Promise.all([stopServer(first), stopServer(second)]);

  assert.deepEqual(apnsRows(copiedDatabase), expectedRows);
  const reopened = await createAccountStore({ filePath: copiedDatabase, now: () => fixedNow + 2 });
  assert.equal(reopened.getSchemaVersion(), 2);
  assert.equal(reopened.checkReadiness(), true);
  reopened.close();
  assert.deepEqual(apnsRows(copiedDatabase), expectedRows);
  assert.equal(logs.includes(sensitiveCanary), false, 'APNs storage bytes reached server logs.');
  assert.equal(logs.includes(expectedRows[0].token_fingerprint_hex), false, 'APNs token fingerprint reached server logs.');

  console.log(
    'APNs rollback envelope smoke passed: two concurrent schema-2 servers opened copied future storage and preserved every row byte.'
  );
} catch (error) {
  if (logs) console.error(logs);
  throw error;
} finally {
  await Promise.allSettled(serverProcesses.map((serverProcess) => stopServer(serverProcess)));
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
