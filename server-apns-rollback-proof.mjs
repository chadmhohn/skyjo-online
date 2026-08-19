import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  APNS_DEVICE_STORAGE_ENVELOPE,
  createAccountStore,
  validateOptionalAPNSDeviceStorageEnvelope
} from './server-account-store.mjs';
import { saveRoomsToDisk } from './server-room-persistence.mjs';

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(modulePath);
const fullShaPattern = /^[a-f0-9]{40}$/;
const shutdownTimeoutMs = 5_000;
const defaultProofTimeoutMs = 60_000;
const proofTerminationCode = 'ERR_APNS_ROLLBACK_PROOF_TERMINATED';
const timedOut = Symbol('timed-out');

class ApnsRollbackProofTerminationError extends Error {
  constructor(reason) {
    super(
      reason === 'timeout'
        ? 'APNs rollback proof timed out; synthetic resources were cleaned up.'
        : 'APNs rollback proof was interrupted; synthetic resources were cleaned up.'
    );
    this.name = 'ApnsRollbackProofTerminationError';
    this.code = proofTerminationCode;
    this.reason = reason;
    this.exitCode = reason === 'SIGINT' ? 130 : reason === 'SIGTERM' ? 143 : 1;
  }
}

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

function validateProofTimeoutMs(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error('APNs rollback proof timeout must be between 1 and 300000 milliseconds.');
  }
  return value;
}

export function assertApnsRowsPreserved(actualRows, expectedRows) {
  if (!isDeepStrictEqual(actualRows, expectedRows)) {
    throw new Error('APNs rollback proof detected a row preservation mismatch.');
  }
}

export function sensitiveBinaryLogRepresentations(hexValue) {
  const bytes = Buffer.from(hexValue, 'hex');
  const spacedHex = hexValue.toLowerCase().match(/../g).join(' ');
  const colonHex = hexValue.toLowerCase().match(/../g).join(':');
  const standardBase64 = bytes.toString('base64');
  const decimalBytes = [...bytes].map(String);
  const indexedDecimalBytes = decimalBytes
    .map((value, index) => `"${index}":${value}`)
    .join(',');
  return [...new Set([
    hexValue.toLowerCase(),
    hexValue.toUpperCase(),
    spacedHex,
    spacedHex.toUpperCase(),
    colonHex,
    colonHex.toUpperCase(),
    standardBase64,
    standardBase64.replace(/=+$/u, ''),
    bytes.toString('base64url'),
    decimalBytes.join(','),
    decimalBytes.join(', '),
    indexedDecimalBytes
  ])];
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

function waitWithSignal(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function awaitWithSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

async function waitForCloseWithin(closePromise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      closePromise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runApnsRollbackProof({
  expectedReleaseSha,
  proofTimeoutMs = defaultProofTimeoutMs,
  testHooks
} = {}) {
  const releaseSha = validateExpectedReleaseSha(expectedReleaseSha);
  const boundedProofTimeoutMs = validateProofTimeoutMs(proofTimeoutMs);
  if (testHooks !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('APNs rollback proof test hooks require NODE_ENV=test.');
  }

  const abortController = new AbortController();
  const requestTermination = (reason) => {
    if (abortController.signal.aborted) return;
    abortController.abort(new ApnsRollbackProofTerminationError(reason));
  };
  const onSigint = () => requestTermination('SIGINT');
  const onSigterm = () => requestTermination('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let proofTimeout;
  let temporaryDirectory;
  let primaryError;
  let cleanupError;
  let completed = false;
  const serverProcesses = [];
  const serverClosePromises = new WeakMap();
  const serverStopPromises = new WeakMap();
  const validatedGracefulStops = new WeakSet();
  const logScanTails = new WeakMap();
  const leakedLogNeedles = new Set();
  let sensitiveLogNeedles = [];
  let maxSensitiveLogNeedleLength = 1;
  let logByteCount = 0;
  let logs = '';

  async function stopServer(serverProcess, { requireCleanExit = true } = {}) {
    if (validatedGracefulStops.has(serverProcess)) return;
    let stopPromise = serverStopPromises.get(serverProcess);
    if (!stopPromise) {
      stopPromise = (async () => {
        const alreadyExited = serverProcess.exitCode !== null || serverProcess.signalCode !== null;
        let gracefulStopRequested = false;
        let forcedStop = false;

        if (!alreadyExited) {
          try {
            gracefulStopRequested = serverProcess.kill('SIGTERM');
          } catch {
            gracefulStopRequested = false;
          }
        }

        const closePromise = serverClosePromises.get(serverProcess);
        let exit = await waitForCloseWithin(closePromise, shutdownTimeoutMs);
        if (exit === timedOut) {
          forcedStop = true;
          try { serverProcess.kill('SIGKILL'); } catch { /* bounded failure below */ }
          exit = await waitForCloseWithin(closePromise, shutdownTimeoutMs);
        }
        if (exit === timedOut) {
          throw new Error('APNs rollback proof server could not be reaped during bounded cleanup.');
        }
        return { ...exit, alreadyExited, gracefulStopRequested, forcedStop };
      })();
      serverStopPromises.set(serverProcess, stopPromise);
    }

    const exit = await stopPromise;
    if (
      requireCleanExit &&
      (
        exit.alreadyExited ||
        !exit.gracefulStopRequested ||
        exit.forcedStop ||
        exit.code !== 0 ||
        exit.signal !== null
      )
    ) {
      throw new Error('APNs rollback proof server did not complete a clean graceful stop.');
    }
    if (requireCleanExit) validatedGracefulStops.add(serverProcess);
  }

  try {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apns-rollback-envelope-'));
    abortController.signal.throwIfAborted();

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
    const userIdCanary = '40000000-0000-4000-8000-000000000203';
    const appVersionCanary = 'APNS-APP-VERSION-MUST-NEVER-REACH-LOGS';
    const localeCanary = 'apns-locale-must-never-reach-logs';
    sensitiveLogNeedles = [sensitiveCanary];
    maxSensitiveLogNeedleLength = sensitiveCanary.length;

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
      serverClosePromises.set(serverProcess, new Promise((resolve) => {
        serverProcess.once('close', (code, signal) => resolve({ code, signal }));
      }));
      serverProcess.once('error', () => {
        // Readiness and bounded close handling surface a constant sanitized failure.
      });
      serverProcesses.push(serverProcess);
      return serverProcess;
    }

    async function waitForReady(baseUrl, serverProcess) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        abortController.signal.throwIfAborted();
        if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
          throw new Error('APNs rollback proof server exited before readiness.');
        }
        let response;
        try {
          response = await fetch(`${baseUrl}/readyz`, {
            signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(1_000)])
          });
        } catch {
          abortController.signal.throwIfAborted();
          // A concurrent process may still hold the bounded migration lock.
        }
        if (response?.status === 200) {
          const [readiness, versionResponse] = await Promise.all([
            response.json(),
            fetch(`${baseUrl}/version`, {
              signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(1_000)])
            })
          ]);
          abortController.signal.throwIfAborted();
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
        await waitWithSignal(100, abortController.signal);
      }
      throw new Error('APNs rollback proof server did not become ready.');
    }

    const store = await createAccountStore({
      filePath: seedDatabase,
      now: () => fixedNow,
      randomUuid: () => userIdCanary
    });
    abortController.signal.throwIfAborted();
    const user = await store.createUser({
      email: accountEmail,
      displayName: 'APNs Rollback',
      password: accountPassword,
      role: 'admin'
    });
    store.close();
    abortController.signal.throwIfAborted();

    const database = new DatabaseSync(seedDatabase);
    database.exec('PRAGMA foreign_keys = ON');
    if (!validateOptionalAPNSDeviceStorageEnvelope(database).present) {
      database.exec(`${APNS_DEVICE_STORAGE_ENVELOPE.createStatements.join(';\n')};`);
    }
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
      appVersionCanary,
      localeCanary,
      fixedNow,
      fixedNow + 1
    );
    database.close();
    abortController.signal.throwIfAborted();

    await fs.copyFile(seedDatabase, copiedDatabase);
    abortController.signal.throwIfAborted();
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
      expectedRows[0].user_id,
      expectedRows[0].app_version,
      expectedRows[0].locale,
      String(expectedRows[0].created_at),
      String(expectedRows[0].updated_at),
      ...sensitiveBinaryColumns.flatMap(sensitiveBinaryLogRepresentations)
    ])];
    maxSensitiveLogNeedleLength = Math.max(...sensitiveLogNeedles.map((needle) => needle.length));
    await Promise.all(roomsFiles.map((roomsFile) => saveRoomsToDisk(new Map(), roomsFile)));
    abortController.signal.throwIfAborted();

    const ports = await Promise.all([availablePort(), availablePort()]);
    abortController.signal.throwIfAborted();
    proofTimeout = setTimeout(() => requestTermination('timeout'), boundedProofTimeoutMs);
    const first = startServer(ports[0], roomsFiles[0], 'a');
    const second = startServer(ports[1], roomsFiles[1], 'b');
    await awaitWithSignal(testHooks?.afterServersStarted?.({
      childProcessIds: [first.pid, second.pid],
      copiedDatabase,
      signal: abortController.signal,
      temporaryDirectory
    }), abortController.signal);
    const releaseShas = await Promise.all([
      waitForReady(`http://127.0.0.1:${ports[0]}`, first),
      waitForReady(`http://127.0.0.1:${ports[1]}`, second)
    ]);
    assert.deepEqual(releaseShas, [releaseSha, releaseSha]);
    await Promise.all([stopServer(first), stopServer(second)]);

    await awaitWithSignal(testHooks?.beforeFirstRowVerification?.({
      copiedDatabase,
      signal: abortController.signal
    }), abortController.signal);
    assertApnsRowsPreserved(apnsRows(copiedDatabase), expectedRows);
    const reopened = await createAccountStore({ filePath: copiedDatabase, now: () => fixedNow + 2 });
    assert.equal(reopened.getSchemaVersion(), 2);
    assert.equal(reopened.checkReadiness(), true);
    reopened.close();
    assertApnsRowsPreserved(apnsRows(copiedDatabase), expectedRows);
    assert.equal(leakedLogNeedles.size, 0, 'APNs storage bytes reached server logs.');
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(proofTimeout);
    const stopResults = await Promise.allSettled(
      serverProcesses.map((serverProcess) => stopServer(serverProcess, { requireCleanExit: false }))
    );
    if (stopResults.some((result) => result.status === 'rejected')) {
      cleanupError = new Error('APNs rollback proof could not terminate every synthetic server.');
    } else if (temporaryDirectory) {
      try {
        await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        cleanupError = new Error('APNs rollback proof could not remove its synthetic state.');
      }
    }
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }

  if (!primaryError && abortController.signal.aborted) primaryError = abortController.signal.reason;
  if (logs && (primaryError || cleanupError)) {
    console.error(`APNs rollback proof server diagnostics withheld (${logByteCount} bytes).`);
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!completed) throw new Error('APNs rollback proof did not complete.');

  console.log(
    `APNs rollback envelope proof passed for ${releaseSha}: two concurrent schema-2 servers opened copied future storage, stopped cleanly, and preserved every row byte.`
  );
}

const invokedModulePath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;

if (invokedModulePath === modulePath) {
  const expectedReleaseSha = parseDirectArguments(process.argv.slice(2));
  try {
    await runApnsRollbackProof({ expectedReleaseSha });
  } catch (error) {
    if (
      error?.code === proofTerminationCode &&
      (error.reason === 'SIGINT' || error.reason === 'SIGTERM')
    ) {
      process.exitCode = error.exitCode;
    } else {
      throw error;
    }
  }
}
