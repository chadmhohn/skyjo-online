import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs';
import { createAppleAppSiteAssociation } from '../server-room-invites.mjs';

function cookieFromResponse(response, label) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, `${label} did not set a cookie`);
  const cookie = setCookie.split(';', 1)[0];
  assert.equal(
    /^[^=;,\s]+=[^;,]+$/.test(cookie),
    true,
    `${label} returned an invalid cookie without logging its value`
  );
  return cookie;
}

function assertNoStore(response, label) {
  assert.match(response.headers.get('cache-control') || '', /(?:^|,)\s*no-store(?:,|$)/i, `${label} must be no-store`);
}

function assertBoundedPublicCache(response, label) {
  const match = (response.headers.get('cache-control') || '').match(/^public, max-age=(\d+)$/i);
  assert.ok(match, `${label} must use an explicit public max-age`);
  const maxAge = Number(match[1]);
  assert.ok(Number.isSafeInteger(maxAge) && maxAge >= 60 && maxAge <= 86_400, `${label} max-age is not bounded`);
}

async function openAuthenticatedSocket(baseUrl, cookies, expectedProtocolVersion) {
  const socketUrl = new URL('/rooms', baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl, { headers: { Cookie: cookies } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket authentication timed out.')), 5000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message handling timed out.')), 5000);
    socket.once('message', (raw) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(String(raw)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.send(JSON.stringify({ type: 'set-presence', visible: true }));
  });
  assert.deepEqual(response, {
    type: 'error',
    protocolVersion: expectedProtocolVersion,
    code: 'room-required',
    message: 'Join or create a room first.'
  });
  await new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close(1000, 'Smoke complete');
  });
}

export async function runDeployedSmoke({
  baseUrl,
  accessPassword,
  accountEmail,
  accountPassword,
  expectedAppleApplicationIdentifier,
  expectedAPNSNotificationsEnabled,
  expectedReleaseSha,
  expectedProtocolVersion = CURRENT_PROTOCOL_VERSION
}) {
  assert.ok(baseUrl, 'A deployed base URL is required.');
  assert.ok(accessPassword, 'The shared access password is required.');
  assert.ok(accountEmail && accountPassword, 'A non-destructive smoke account is required.');
  assert.equal(typeof expectedAPNSNotificationsEnabled, 'boolean', 'Expected APNs availability must be explicit.');
  const expectedAppleAssociation = createAppleAppSiteAssociation(expectedAppleApplicationIdentifier);
  const parsedBaseUrl = new URL(baseUrl);
  const localHost = parsedBaseUrl.hostname === 'localhost' || parsedBaseUrl.hostname === '127.0.0.1' || parsedBaseUrl.hostname === '::1';
  assert.ok(parsedBaseUrl.protocol === 'https:' || (localHost && parsedBaseUrl.protocol === 'http:'), 'Deployed smoke requires HTTPS except on localhost.');
  if (!localHost) assert.match(expectedReleaseSha || '', /^[a-f0-9]{40}$/, 'A full expected release SHA is required remotely.');
  assert.ok(Number.isInteger(expectedProtocolVersion) && expectedProtocolVersion > 0, 'Expected protocol version must be a positive integer.');
  const root = parsedBaseUrl.href.replace(/\/+$/, '');

  const associationResponse = await fetch(`${root}/.well-known/apple-app-site-association`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(associationResponse.status, 200, 'Apple association must be public');
  assert.equal(associationResponse.headers.get('location'), null, 'Apple association must be direct');
  assert.equal(associationResponse.headers.get('set-cookie'), null, 'Apple association must not create a session');
  assert.equal(associationResponse.headers.get('content-type'), 'application/json', 'Apple association content type changed');
  assertBoundedPublicCache(associationResponse, 'Apple association');
  const associationLength = associationResponse.headers.get('content-length');
  assert.deepEqual(await associationResponse.json(), expectedAppleAssociation, 'Apple association content changed');
  const associationHead = await fetch(`${root}/.well-known/apple-app-site-association`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(associationHead.status, 200, 'Apple association HEAD failed');
  assert.equal(associationHead.headers.get('location'), null, 'Apple association HEAD must be direct');
  assert.equal(associationHead.headers.get('set-cookie'), null, 'Apple association HEAD must not create a session');
  assert.equal(associationHead.headers.get('content-type'), 'application/json', 'Apple association HEAD content type changed');
  assert.equal(associationHead.headers.get('content-length'), associationLength, 'Apple association GET/HEAD lengths differ');
  assertBoundedPublicCache(associationHead, 'Apple association HEAD');
  assert.equal(await associationHead.text(), '', 'Apple association HEAD returned a body');

  const healthResponse = await fetch(`${root}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(healthResponse.status, 200, 'liveness must be public');
  assert.equal(await healthResponse.text(), 'ok', 'liveness body changed');

  const versionResponse = await fetch(`${root}/version`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(versionResponse.status, 200, 'version must be public and available');
  assertNoStore(versionResponse, 'version');
  const version = await versionResponse.json();
  assert.match(version.releaseSha, /^[a-f0-9]{40}$/, 'version must identify a full release SHA');
  assert.equal(version.protocolVersion, expectedProtocolVersion, 'deployed protocol version does not match');
  assert.ok(Number.isFinite(Date.parse(version.buildTimestamp)), 'version build timestamp is invalid');
  if (expectedReleaseSha) assert.equal(version.releaseSha, expectedReleaseSha, 'deployed release SHA does not match');

  const readinessResponse = await fetch(`${root}/readyz`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(readinessResponse.status, 200, 'readiness gate failed');
  assertNoStore(readinessResponse, 'readiness');
  const readiness = await readinessResponse.json();
  assert.deepEqual(readiness, {
    status: 'ready',
    releaseSha: version.releaseSha,
    schemaVersion: 2,
    protocolVersion: expectedProtocolVersion,
    checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
  });

  const invalidNativeInvite = await fetch(`${root}/api/rooms/invite/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'invalid.signature' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(invalidNativeInvite.status, 410, 'native invite redemption is not available before the access gate');
  assert.equal(invalidNativeInvite.headers.get('location'), null, 'native invite failure must not redirect');
  assert.equal(invalidNativeInvite.headers.get('set-cookie'), null, 'native invite failure must not grant access');
  assertNoStore(invalidNativeInvite, 'native invite failure');
  assert.deepEqual(await invalidNativeInvite.json(), {
    code: 'INVITE_INVALID_OR_EXPIRED',
    error: 'This invite is invalid or has expired.'
  });

  const siteLogin = await fetch(`${root}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: accessPassword, next: '/' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(siteLogin.status, 303, 'shared access login failed');
  const siteCookie = cookieFromResponse(siteLogin, 'shared access login');

  const appResponse = await fetch(`${root}/`, {
    headers: { Cookie: siteCookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(appResponse.status, 200, 'authenticated app shell failed');
  assert.match(appResponse.headers.get('content-type') || '', /^text\/html\b/i, 'app shell must be HTML');
  const appShell = await appResponse.text();
  assert.match(appShell, /<div id="root"><\/div>/, 'app shell root is missing');
  assert.match(appShell, /<script[^>]+src="\/assets\//, 'app shell build asset is missing');

  const accountLogin = await fetch(`${root}/api/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: siteCookie },
    body: JSON.stringify({ email: accountEmail, password: accountPassword }),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(accountLogin.status, 200, 'account login failed');
  const accountCookie = cookieFromResponse(accountLogin, 'account login');
  assert.notEqual(accountCookie.split('=', 1)[0], siteCookie.split('=', 1)[0], 'site and account cookies must be distinct');
  const cookies = `${siteCookie}; ${accountCookie}`;

  const accountResponse = await fetch(`${root}/api/account/me`, {
    headers: { Cookie: cookies },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(accountResponse.status, 200, 'two-cookie account proof failed');
  const account = await accountResponse.json();
  assert.equal(account.user?.email, accountEmail.trim().toLowerCase(), 'smoke account identity did not match');

  const apnsConfigResponse = await fetch(`${root}/api/push/apns/config`, {
    headers: { Cookie: cookies },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(apnsConfigResponse.status, 200, 'authenticated APNs configuration proof failed');
  assert.equal(apnsConfigResponse.headers.get('location'), null, 'APNs configuration must not redirect');
  assertNoStore(apnsConfigResponse, 'APNs configuration');
  assert.deepEqual(await apnsConfigResponse.json(), {
    enabled: expectedAPNSNotificationsEnabled
  });

  await openAuthenticatedSocket(root, cookies, expectedProtocolVersion);
  return { releaseSha: version.releaseSha, buildTimestamp: version.buildTimestamp, protocolVersion: version.protocolVersion };
}
