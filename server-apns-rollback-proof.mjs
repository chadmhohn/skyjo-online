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
} from './server-account-store.mjs';
import { saveRoomsToDisk } from './server-room-persistence.mjs';

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(modulePath);
const fullShaPattern = /^[a-f0-9]{40}$/;
const shutdownTimeoutMs = 5_000;

function parseDirectArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--expected-release-sha' ||
    !fullShaPattern.test(argv[1])
  ) {
    throw new Error('Usage: server-apns-rollback-proof.mjs --expected-release-sha <lowercase-40-sha>');
  }
  return argv[1];
}

function validateExpectedReleaseSha(value) {
  if (typeof value !== 'string' || !fullShaPattern.test(value)) {
    throw new Error('APNs rollback proof requires an exact lowercase 40-character release SHA.');
  }
  return value;
}

export function sensitiveBinaryLogRepresentations(hexValue) {
  const bytes = Buffer.from(hexValue, 'hex');
  const spacedHex = hexValue.toLowerCase().match(/../g).join(' ');
  const decimalBytes = [...bytes].map(String);
  const indexedDecimalBytes = decimalBytes
    .map((value, index) => `"${index}":${value}`)
    .join(',');
  return [
    hexValue.toLowerCase(),
    hexValue.toUpperCase(),
    spacedHex,
    spacedHex.toUpperCase(),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    decimalBytes.join(','),
    decimalBytes.join(', '),
    indexedDecimalBytes
  ];
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate an APNs rollback proof port.');
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

export async function runApnsRollbackProof({ expectedReleaseSha } = {}) {
  const releaseSha = validateExpectedReleaseSha(expectedReleaseSha);
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
  const validatedGracefulStops = new WeakSet();
  const logScanTails = new WeakMap();
  const leakedLogNeedles = new Set();
  let sensitiveLogNeedles = [sensitiveCanary];
  let maxSensitiveLogNeedleLength = sensitiveCanary.length;
  let logByteCount = 0;
  let logs = '';

  function recordServerLog(stream, chunk) {
    logByteCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      logByteCount + Buffer.byteLength(chunk, 'utf8')
    );
    logs = `${logs}${chunk}`.slice(-64_000);
    const combined = `${logScanTails.get(stream) || ''}${chunk}`;
    for (const needle of sensitiveLogNeedles) {
      if (combined.includes(needle)) leakedLogNeedles.add(needle);
    }
    logScanTails.set(stream, combined.slice(-(maxSensitiveLogNeedleLength - 1)));
  }

  function startServer(port, roomsFile, suffix) {
    const serverProcess = spawn(process.execPath, ['server.mjs'], {
      cwd: projectRoot,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        SKYJO_ACCESS_PASSWORD: 'apns-rollback-access-password',
        SKYJO_ACCOUNT_COOKIE_NAME: `skyjo_apns_account_${suffix}`,
        SKYJO_ADMIN_EMAIL: accountEmail,
        SKYJO_ADMIN_INITIAL_PASSWORD: '',
        SKYJO_APPLE_APPLICATION_IDENTIFIER: 'FAKEAPPID1.com.groundworkrevops.skyjo',
        SKYJO_COOKIE_NAME: `skyjo_apns_access_${suffix}`,
        SKYJO_DB_FILE: copiedDatabase,
        SKYJO_INVITE_SECRET: 'apns-rollback-invite-secret-0123456789abcdef',
        SKYJO_ROOMS_FILE: roomsFile,
        SKYJO_SECURE_COOKIES: 'false',
        SKYJO_SESSION_SECRET: 'apns-rollback-session-secret-0123456789abcdef',
        SKYJO_VAPID_PRIVATE_KEY: '',
        SKYJO_VAPID_PUBLIC_KEY: '',
        SKYJO_VAPID_SUBJECT: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => recordServerLog(stream, chunk));
    }
    serverProcesses.push(serverProcess);
    return serverProcess;
  }

  async function waitForReady(baseUrl, serverProcess) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
        throw new Error('APNs rollback proof server exited before readiness.');
      }
      let response;
      try {
        response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
      } catch {
        // A concurrent process may still hold the bounded migration lock.
      }
      if (response?.status === 200) {
        const [readiness, versionResponse] = await Promise.all([
          response.json(),
          fetch(`${baseUrl}/version`, { signal: AbortSignal.timeout(1_000) })
        ]);
        assert.equal(versionResponse.status, 200);
        const version = await versionResponse.json();
        assert.deepEqual(Object.keys(version).sort(), ['buildTimestamp', 'protocolVersion', 'releaseSha']);
        assert.equal(version.releaseSha, releaseSha);
        assert.equal(version.protocolVersion, 2);
        assert.ok(typeof version.buildTimestamp === 'string' && Number.isFinite(Date.parse(version.buildTimestamp)));
        assert.deepEqual(readiness, {
          status: 'ready',
          releaseSha,
          schemaVersion: 2,
          protocolVersion: 2,
          checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
        });
        return version.releaseSha;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('APNs rollback proof server did not become ready.');
  }

  async function stopServer(serverProcess) {
    if (validatedGracefulStops.has(serverProcess)) return;
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error('APNs rollback proof server exited before a validated graceful stop.');
    }

    const exit = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        serverProcess.off('close', onClose);
        if (error) reject(error);
        else resolve(status);
      };
      const onClose = (code, signal) => finish(null, { code, signal });
      const timeout = setTimeout(() => {
        try { serverProcess.kill('SIGKILL'); } catch { /* best-effort synthetic cleanup */ }
        finish(new Error('APNs rollback proof server did not stop within the bounded timeout.'));
      }, shutdownTimeoutMs);
      serverProcess.once('close', onClose);
      try {
        if (!serverProcess.kill('SIGTERM')) {
          finish(new Error('APNs rollback proof server exited before SIGTERM could request a graceful stop.'));
        }
      } catch {
        finish(new Error('APNs rollback proof server could not receive the graceful-stop request.'));
      }
    });

    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error('APNs rollback proof server did not complete a clean graceful stop.');
    }
    validatedGracefulStops.add(serverProcess);
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
    const sensitiveBinaryColumns = [
      expectedRows[0].token_ciphertext_hex,
      expectedRows[0].token_nonce_hex,
      expectedRows[0].token_auth_tag_hex,
      expectedRows[0].token_fingerprint_hex
    ];
    sensitiveLogNeedles = [...new Set([
      sensitiveCanary,
      expectedRows[0].installation_id,
      ...sensitiveBinaryColumns.flatMap(sensitiveBinaryLogRepresentations)
    ])];
    maxSensitiveLogNeedleLength = Math.max(...sensitiveLogNeedles.map((needle) => needle.length));
    await Promise.all(roomsFiles.map((roomsFile) => saveRoomsToDisk(new Map(), roomsFile)));

    const ports = await Promise.all([availablePort(), availablePort()]);
    const first = startServer(ports[0], roomsFiles[0], 'a');
    const second = startServer(ports[1], roomsFiles[1], 'b');
    const releaseShas = await Promise.all([
      waitForReady(`http://127.0.0.1:${ports[0]}`, first),
      waitForReady(`http://127.0.0.1:${ports[1]}`, second)
    ]);
    assert.deepEqual(releaseShas, [releaseSha, releaseSha]);
    await Promise.all([stopServer(first), stopServer(second)]);

    assert.deepEqual(apnsRows(copiedDatabase), expectedRows);
    const reopened = await createAccountStore({ filePath: copiedDatabase, now: () => fixedNow + 2 });
    assert.equal(reopened.getSchemaVersion(), 2);
    assert.equal(reopened.checkReadiness(), true);
    reopened.close();
    assert.deepEqual(apnsRows(copiedDatabase), expectedRows);
    assert.equal(leakedLogNeedles.size, 0, 'APNs storage bytes reached server logs.');

    console.log(
      `APNs rollback envelope proof passed for ${releaseSha}: two concurrent schema-2 servers opened copied future storage, stopped cleanly, and preserved every row byte.`
    );
  } catch (error) {
    if (logs) {
      console.error(`APNs rollback proof server diagnostics withheld (${logByteCount} bytes).`);
    }
    throw error;
  } finally {
    await Promise.allSettled(serverProcesses.map((serverProcess) => stopServer(serverProcess)));
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const invokedModulePath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;

if (invokedModulePath === modulePath) {
  const expectedReleaseSha = parseDirectArguments(process.argv.slice(2));
  await runApnsRollbackProof({ expectedReleaseSha });
}
