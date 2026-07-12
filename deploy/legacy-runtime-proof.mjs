#!/opt/skyjo-online/node/bin/node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectRuntimeState } from './state-snapshot-lib.mjs';

const fullShaPattern = /^[a-f0-9]{40}$/;
const productionContracts = Object.freeze({
  releaseRoot: '/srv/skyjo-online/releases',
  stateRoot: '/var/lib/skyjo-online',
  baseUrl: 'http://127.0.0.1:4180'
});

function proofError(message) {
  return new Error(`Legacy runtime proof failed: ${message}`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw proofError(`${label} is missing or invalid.`);
  return value;
}

async function exactRealDirectory(directory, parent, expectedName) {
  const resolved = path.resolve(requiredString(directory, 'release directory'));
  if (path.dirname(resolved) !== path.resolve(parent) || path.basename(resolved) !== expectedName) {
    throw proofError('release directory is outside the immutable release store.');
  }
  const stat = await fsp.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw proofError('release directory is not a real directory.');
  return resolved;
}

export async function normalizeLegacyProofConfiguration(value, contracts = productionContracts) {
  const expectedReleaseSha = requiredString(value?.expectedReleaseSha, 'expected release SHA');
  if (!fullShaPattern.test(expectedReleaseSha)) throw proofError('expected release SHA is invalid.');
  const releaseDirectory = await exactRealDirectory(value?.releaseDirectory, contracts.releaseRoot, expectedReleaseSha);
  const databasePath = path.resolve(requiredString(value?.databasePath, 'database path'));
  const roomsPath = path.resolve(requiredString(value?.roomsPath, 'rooms path'));
  if (databasePath !== path.join(path.resolve(contracts.stateRoot), 'skyjo.sqlite')) throw proofError('database path differs from the hardened production path.');
  if (roomsPath !== path.join(path.resolve(contracts.stateRoot), 'rooms.json')) throw proofError('rooms path differs from the hardened production path.');
  const baseUrl = requiredString(value?.baseUrl, 'base URL').replace(/\/+$/, '');
  if (baseUrl !== contracts.baseUrl) throw proofError('base URL differs from the local production endpoint.');
  const accountEmail = requiredString(value?.accountEmail, 'smoke account email').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) throw proofError('smoke account email is invalid.');
  return {
    releaseDirectory,
    expectedReleaseSha,
    databasePath,
    roomsPath,
    baseUrl,
    accessPassword: requiredString(value?.accessPassword, 'shared access password'),
    accountEmail,
    accountPassword: requiredString(value?.accountPassword, 'smoke account password')
  };
}

function cookieFromResponse(response, label) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw proofError(`${label} did not set a cookie.`);
  const cookie = setCookie.split(';', 1)[0];
  if (!/^[^=;,\s]+=[^;,]+$/.test(cookie)) throw proofError(`${label} returned an invalid cookie.`);
  return cookie;
}

async function fetchLocal(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    ...options
  });
}

function inspectSmokeAccount(databasePath, accountEmail) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const user = database.prepare('SELECT email, disabled FROM users WHERE lower(email) = ?').get(accountEmail);
    if (!user || String(user.email).trim().toLowerCase() !== accountEmail || user.disabled !== 0) {
      throw proofError('the dedicated smoke account is missing or disabled.');
    }
  } finally {
    database.close();
  }
}

function loadReleaseWebSocket(releaseDirectory) {
  const require = createRequire(path.join(releaseDirectory, 'package.json'));
  const resolved = path.resolve(require.resolve('ws'));
  const packageRoot = path.join(releaseDirectory, 'node_modules', 'ws');
  if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`)) {
    throw proofError('WebSocket client resolved outside the immutable release.');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw proofError('WebSocket client entry is unsafe.');
  const loaded = require(resolved);
  return loaded.WebSocket || loaded;
}

async function proveAuthenticatedSocket(WebSocketImpl, baseUrl, cookies) {
  const socketUrl = new URL('/rooms', baseUrl);
  socketUrl.protocol = 'ws:';
  const socket = new WebSocketImpl(socketUrl, { headers: { Cookie: cookies } });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(proofError('WebSocket authentication timed out.')), 5000);
      socket.once('open', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(proofError('WebSocket response timed out.')), 5000);
      socket.once('message', (raw) => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(String(raw))); }
        catch { reject(proofError('WebSocket returned malformed JSON.')); }
      });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.send(JSON.stringify({ type: 'set-presence', visible: true }));
    });
    if (response?.type !== 'error' || response?.message !== 'Join or create a room first.') {
      throw proofError('authenticated WebSocket contract changed.');
    }
  } finally {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try { socket.terminate?.(); } catch {}
        resolve();
      }, 1000);
      socket.once('close', () => { clearTimeout(timeout); resolve(); });
      try { socket.close(1000, 'Proof complete'); }
      catch {
        clearTimeout(timeout);
        try { socket.terminate?.(); } catch {}
        resolve();
      }
    });
  }
}

export async function runLegacyRuntimeProof(value, options = {}) {
  const config = await normalizeLegacyProofConfiguration(value, options.contracts || productionContracts);
  const fetchImpl = options.fetchImpl || fetch;

  const health = await fetchLocal(fetchImpl, `${config.baseUrl}/healthz`);
  if (health.status !== 200 || await health.text() !== 'ok') throw proofError('liveness failed.');

  const state = await inspectRuntimeState({ databasePath: config.databasePath, roomsPath: config.roomsPath });
  if (!state.database.tables.includes('users')) throw proofError('database is missing the account schema.');
  inspectSmokeAccount(config.databasePath, config.accountEmail);

  const readiness = await fetchLocal(fetchImpl, `${config.baseUrl}/readyz`);
  if (readiness.status === 200) {
    const body = await readiness.json();
    if (
      body?.status !== 'ready' || body?.checks?.database !== 'ok' ||
      body?.checks?.roomState !== 'ok' || body?.checks?.lastPersist !== 'ok'
    ) throw proofError('readiness reported degraded state.');
  } else {
    const legacyRedirect = [302, 303, 307, 308].includes(readiness.status) && /^\/login(?:[?/#]|$)/.test(readiness.headers.get('location') || '');
    if (readiness.status !== 404 && !legacyRedirect) throw proofError(`readiness endpoint failed with status ${readiness.status}.`);
  }

  const siteLogin = await fetchLocal(fetchImpl, `${config.baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: config.accessPassword, next: '/' })
  });
  if (siteLogin.status !== 303) throw proofError('shared access authentication failed.');
  const siteCookie = cookieFromResponse(siteLogin, 'shared access authentication');

  const accountLogin = await fetchLocal(fetchImpl, `${config.baseUrl}/api/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: siteCookie },
    body: JSON.stringify({ email: config.accountEmail, password: config.accountPassword })
  });
  if (accountLogin.status !== 200) throw proofError('smoke account authentication failed.');
  const accountCookie = cookieFromResponse(accountLogin, 'smoke account authentication');
  const cookies = `${siteCookie}; ${accountCookie}`;

  const account = await fetchLocal(fetchImpl, `${config.baseUrl}/api/account/me`, { headers: { Cookie: cookies } });
  if (account.status !== 200 || (await account.json())?.user?.email !== config.accountEmail) {
    throw proofError('authenticated account identity did not match.');
  }

  const WebSocketImpl = options.WebSocketImpl || loadReleaseWebSocket(config.releaseDirectory);
  await proveAuthenticatedSocket(WebSocketImpl, config.baseUrl, cookies);
  return {
    status: 'ok',
    releaseSha: config.expectedReleaseSha,
    database: state.database.integrityCheck,
    rooms: state.rooms.shape,
    authenticated: true
  };
}

function configurationFromEnvironment(environment) {
  return {
    releaseDirectory: environment.SKYJO_LEGACY_RELEASE_DIR,
    expectedReleaseSha: environment.SKYJO_EXPECTED_RELEASE_SHA,
    databasePath: environment.SKYJO_DB_FILE,
    roomsPath: environment.SKYJO_ROOMS_FILE,
    baseUrl: environment.SKYJO_SMOKE_BASE_URL,
    accessPassword: environment.SKYJO_ACCESS_PASSWORD,
    accountEmail: environment.SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL,
    accountPassword: environment.SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  runLegacyRuntimeProof(configurationFromEnvironment(process.env)).then(
    (result) => fs.writeSync(process.stdout.fd, `${JSON.stringify(result)}\n`),
    (error) => {
      fs.writeSync(process.stderr.fd, `${error?.message || 'Legacy runtime proof failed.'}\n`);
      process.exitCode = 1;
    }
  );
}
