import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('APNs smoke server exited before readiness.');
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('APNs smoke server did not become ready.');
}

function cookiePair(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const match = values.join(',').match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]*)`));
  if (!match) throw new Error('Expected smoke cookie was not returned.');
  return `${name}=${match[1]}`;
}

async function jsonRequest(baseUrl, pathname, { method = 'GET', cookie = '', body, contentType = 'application/json' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && contentType) headers['Content-Type'] = contentType;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(3_000)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Tests below assert JSON only where the route promises it.
  }
  return { response, payload, text };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('APNs smoke server did not stop gracefully.')), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apns-smoke-'));
const databaseFile = path.join(temporaryDirectory, 'skyjo.sqlite');
const roomsFile = path.join(temporaryDirectory, 'rooms.json');
const providerKeyFile = path.join(temporaryDirectory, 'provider.p8');
const tokenKeyFile = path.join(temporaryDirectory, 'token.key');
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const accessPassword = crypto.randomBytes(24).toString('base64url');
const accountPassword = crypto.randomBytes(24).toString('base64url');
const deviceToken = 'ab'.repeat(32);
const rotatedToken = 'cd'.repeat(48);
const installationId = '1000000a-0000-4000-8000-000000000001';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
await fs.writeFile(providerKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
await fs.writeFile(tokenKeyFile, `${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });

let logs = '';
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: accessPassword,
    SKYJO_SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
    SKYJO_INVITE_SECRET: crypto.randomBytes(48).toString('base64url'),
    SKYJO_APPLE_APPLICATION_IDENTIFIER: 'TESTSKYJ01.com.groundworkrevops.skyjo',
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_DB_FILE: databaseFile,
    SKYJO_ROOMS_FILE: roomsFile,
    SKYJO_ADMIN_EMAIL: 'apns-admin@example.invalid',
    SKYJO_ADMIN_INITIAL_PASSWORD: accountPassword,
    SKYJO_VAPID_PUBLIC_KEY: '',
    SKYJO_VAPID_PRIVATE_KEY: '',
    SKYJO_VAPID_SUBJECT: '',
    SKYJO_APNS_TEAM_ID: 'TEAMID1234',
    SKYJO_APNS_KEY_ID: 'KEYID12345',
    SKYJO_APNS_PRIVATE_KEY_FILE: providerKeyFile,
    SKYJO_APNS_TOKEN_KEY_FILE: tokenKeyFile
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (chunk) => { logs += chunk.toString('utf8'); });
server.stderr.on('data', (chunk) => { logs += chunk.toString('utf8'); });

try {
  await waitForReady(baseUrl, server);
  const access = await jsonRequest(baseUrl, '/api/access/session', {
    method: 'POST',
    body: { password: accessPassword }
  });
  assert.equal(access.response.status, 200);
  const accessCookie = cookiePair(access.response, 'skyjo_session');

  const signup = await jsonRequest(baseUrl, '/api/account/signup', {
    method: 'POST',
    cookie: accessCookie,
    body: {
      email: 'apns-user@example.invalid',
      displayName: 'APNs User',
      password: accountPassword,
      confirmPassword: accountPassword
    }
  });
  assert.equal(signup.response.status, 201);
  const accountCookie = cookiePair(signup.response, 'skyjo_account');
  const authenticatedCookies = `${accessCookie}; ${accountCookie}`;

  const unauthenticatedConfig = await jsonRequest(baseUrl, '/api/push/apns/config', { cookie: accessCookie });
  assert.deepEqual([unauthenticatedConfig.response.status, unauthenticatedConfig.payload?.code], [401, 'ACCOUNT_AUTHENTICATION_REQUIRED']);
  const config = await jsonRequest(baseUrl, '/api/push/apns/config', { cookie: authenticatedCookies });
  assert.equal(config.response.status, 200);
  assert.deepEqual(config.payload, { enabled: true });

  const wrongMethod = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
    method: 'POST',
    cookie: authenticatedCookies,
    body: {}
  });
  assert.deepEqual([wrongMethod.response.status, wrongMethod.payload?.code], [405, 'METHOD_NOT_ALLOWED']);
  assert.equal(wrongMethod.response.headers.get('allow'), 'PUT, DELETE');

  const wrongMedia = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
    method: 'PUT',
    cookie: authenticatedCookies,
    body: '{}',
    contentType: 'text/plain'
  });
  assert.deepEqual([wrongMedia.response.status, wrongMedia.payload?.code], [415, 'UNSUPPORTED_MEDIA_TYPE']);

  const registration = {
    deviceToken,
    environment: 'development',
    appVersion: '0.1.0-42',
    locale: 'en-US'
  };
  const registered = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
    method: 'PUT',
    cookie: authenticatedCookies,
    body: registration
  });
  assert.equal(registered.response.status, 200);
  assert.deepEqual(registered.payload, { ok: true });
  assert.doesNotMatch(registered.text, new RegExp(deviceToken, 'i'));

  const rotated = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
    method: 'PUT',
    cookie: authenticatedCookies,
    body: { ...registration, deviceToken: rotatedToken, environment: 'production' }
  });
  assert.deepEqual([rotated.response.status, rotated.payload], [200, { ok: true }]);

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT environment, typeof(token_ciphertext) AS ciphertext_type,
             length(token_nonce) AS nonce_bytes, length(token_auth_tag) AS tag_bytes,
             length(token_fingerprint) AS fingerprint_bytes
      FROM apns_devices WHERE installation_id = ?
    `).get(installationId);
    assert.deepEqual({ ...row }, {
      environment: 'production',
      ciphertext_type: 'blob',
      nonce_bytes: 12,
      tag_bytes: 16,
      fingerprint_bytes: 32
    });
  } finally {
    database.close();
  }
  const databaseBytes = await fs.readFile(databaseFile);
  assert.equal(databaseBytes.includes(Buffer.from(deviceToken, 'utf8')), false);
  assert.equal(databaseBytes.includes(Buffer.from(rotatedToken, 'utf8')), false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deleted = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
      method: 'DELETE',
      cookie: authenticatedCookies
    });
    assert.deepEqual([deleted.response.status, deleted.payload], [200, { ok: true }]);
  }
  const registeredForLogout = await jsonRequest(baseUrl, `/api/push/apns/devices/${installationId}`, {
    method: 'PUT',
    cookie: authenticatedCookies,
    body: { ...registration, deviceToken: rotatedToken, environment: 'production' }
  });
  assert.deepEqual([registeredForLogout.response.status, registeredForLogout.payload], [200, { ok: true }]);

  const logout = await jsonRequest(baseUrl, '/api/account/logout', {
    method: 'POST',
    cookie: authenticatedCookies,
    body: { installationId }
  });
  assert.deepEqual([logout.response.status, logout.payload], [200, { ok: true }]);
  const signedOut = await jsonRequest(baseUrl, '/api/account/me', { cookie: authenticatedCookies });
  assert.deepEqual(signedOut.payload, { user: null });
  const postLogoutDatabase = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(postLogoutDatabase.prepare('SELECT COUNT(*) AS count FROM apns_devices').get().count, 0);
  } finally {
    postLogoutDatabase.close();
  }
} finally {
  await stopChild(server).catch(() => server.kill('SIGKILL'));
  assert.doesNotMatch(logs, new RegExp(`${deviceToken}|${rotatedToken}|TEAMID1234|KEYID12345`, 'i'));
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('APNs smoke passed: authenticated config/register/rotate/delete/logout, encrypted storage, exact errors, and log redaction');
