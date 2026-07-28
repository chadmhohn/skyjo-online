import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return 'Usage: node scripts/smoke-public-release.mjs --base-url <https-url> [--release-sha <40-char-sha>] [--allow-legacy-rollback | --allow-pre-native-invite-rollback]';
}

function parseArgs(argv) {
  const values = new Map();
  let allowLegacyRollback = false;
  let allowPreNativeInviteRollback = false;
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (flag === '--allow-legacy-rollback') {
      if (allowLegacyRollback) throw new Error(`Duplicate argument: ${flag}`);
      allowLegacyRollback = true;
      index += 1;
      continue;
    }
    if (flag === '--allow-pre-native-invite-rollback') {
      if (allowPreNativeInviteRollback) throw new Error(`Duplicate argument: ${flag}`);
      allowPreNativeInviteRollback = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!['--base-url', '--release-sha'].includes(flag) || !value || value.startsWith('--')) throw new Error(usage());
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag, value);
    index += 2;
  }
  if (!values.has('--base-url')) throw new Error(usage());
  if (allowLegacyRollback && values.has('--release-sha')) throw new Error('Legacy rollback smoke cannot expect a release SHA.');
  if (allowLegacyRollback && allowPreNativeInviteRollback) throw new Error('Rollback compatibility modes are mutually exclusive.');
  if (allowPreNativeInviteRollback && !values.has('--release-sha')) {
    throw new Error('Pre-native-invite rollback smoke requires an exact release SHA.');
  }
  return {
    baseUrl: values.get('--base-url'),
    releaseSha: values.get('--release-sha'),
    allowLegacyRollback,
    allowPreNativeInviteRollback
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Public release smoke requires HTTPS (HTTP is allowed only for localhost tests).');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL must not include credentials, query, or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function assertPublicResponse(response, label, expectedContentType) {
  assert.equal(response.status, 200, `${label} must return 200`);
  assert.equal(response.headers.get('set-cookie'), null, `${label} must not create a session`);
  if (expectedContentType) {
    assert.match(response.headers.get('content-type') || '', expectedContentType, `${label} content type is invalid`);
  }
}

function assertNoStore(response, label) {
  assert.match(response.headers.get('cache-control') || '', /(?:^|,)\s*no-store\s*(?:,|$)/i, `${label} must be no-store`);
}

function assertBoundedPublicCache(response, label) {
  const match = (response.headers.get('cache-control') || '').match(/^public, max-age=(\d+)$/i);
  assert.ok(match, `${label} must use an explicit public max-age`);
  const maxAge = Number(match[1]);
  assert.ok(Number.isSafeInteger(maxAge) && maxAge >= 60 && maxAge <= 86_400, `${label} max-age is not bounded`);
}

function assertAppleAssociationDocument(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Apple association must be an object');
  assert.deepEqual(Object.keys(value), ['applinks'], 'Apple association exposes unrelated services');
  assert.deepEqual(Object.keys(value.applinks || {}), ['details'], 'Apple applinks shape changed');
  assert.ok(Array.isArray(value.applinks.details) && value.applinks.details.length === 1, 'Apple association must have one detail');
  const detail = value.applinks.details[0];
  assert.deepEqual(Object.keys(detail || {}).sort(), ['appIDs', 'components'], 'Apple association detail fields changed');
  assert.ok(Array.isArray(detail.appIDs) && detail.appIDs.length === 1, 'Apple association must have one application identifier');
  assert.match(detail.appIDs[0], /^[A-Z0-9]{10}\.com\.groundworkrevops\.skyjo$/, 'Apple application identifier is malformed');
  assert.deepEqual(detail.components, [
    {
      '/': '/invite/*',
      '?': { open: 'browser' },
      exclude: true
    },
    { '/': '/invite/*' }
  ], 'Apple association paths or fallback exclusion changed');
}

async function fetchPublic(baseUrl, pathname) {
  return fetch(new URL(pathname, baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(7500),
    headers: { 'user-agent': 'skyjo-release-smoke/1' }
  });
}

async function runOnce(baseUrl, expectedReleaseSha, { allowPreNativeInviteRollback = false } = {}) {
  const health = await fetchPublic(baseUrl, '/healthz');
  assertPublicResponse(health, 'healthz', /^text\/plain\b/i);
  assert.equal(await health.text(), 'ok', 'healthz body is invalid');

  const readiness = await fetchPublic(baseUrl, '/readyz');
  assertPublicResponse(readiness, 'readyz', /^application\/json\b/i);
  assertNoStore(readiness, 'readyz');
  const ready = await readiness.json();
  assert.equal(ready.status, 'ready', 'readyz did not report ready');
  assert.match(ready.releaseSha, /^[a-f0-9]{40}$/, 'readyz release SHA is invalid');
  assert.deepEqual(ready.checks, { database: 'ok', roomState: 'ok', lastPersist: 'ok' });

  const versionResponse = await fetchPublic(baseUrl, '/version');
  assertPublicResponse(versionResponse, 'version', /^application\/json\b/i);
  assertNoStore(versionResponse, 'version');
  const version = await versionResponse.json();
  assert.equal(version.releaseSha, ready.releaseSha, 'readyz and version disagree about the release');
  assert.match(version.releaseSha, /^[a-f0-9]{40}$/, 'version release SHA is invalid');
  assert.ok(Number.isFinite(Date.parse(version.buildTimestamp)), 'version build timestamp is invalid');
  assert.ok(Number.isInteger(version.protocolVersion) && version.protocolVersion > 0, 'version protocol is invalid');
  if (expectedReleaseSha) assert.equal(version.releaseSha, expectedReleaseSha, 'public edge serves the wrong release');

  const associationResponse = await fetchPublic(baseUrl, '/.well-known/apple-app-site-association');
  if (allowPreNativeInviteRollback && associationResponse.status !== 200) {
    assert.equal(associationResponse.status, 302, 'pre-native-invite rollback must retain the shared access gate');
    assert.equal(associationResponse.headers.get('set-cookie'), null, 'pre-native-invite rollback must not create a session');
    assert.match(associationResponse.headers.get('location') || '', /^\/login\?next=/, 'pre-native-invite rollback did not use the login gate');
    assertNoStore(associationResponse, 'pre-native-invite rollback association fallback');
  } else {
    assertPublicResponse(associationResponse, 'Apple association', /^application\/json$/i);
    assert.equal(associationResponse.headers.get('location'), null, 'Apple association must not redirect');
    assertBoundedPublicCache(associationResponse, 'Apple association');
    const associationLength = associationResponse.headers.get('content-length');
    assertAppleAssociationDocument(await associationResponse.json());
    const associationHead = await fetch(new URL('/.well-known/apple-app-site-association', baseUrl), {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(7500),
      headers: { 'user-agent': 'skyjo-release-smoke/1' }
    });
    assertPublicResponse(associationHead, 'Apple association HEAD', /^application\/json$/i);
    assert.equal(associationHead.headers.get('location'), null, 'Apple association HEAD must not redirect');
    assert.equal(associationHead.headers.get('content-length'), associationLength, 'Apple association GET/HEAD lengths differ');
    assertBoundedPublicCache(associationHead, 'Apple association HEAD');
    assert.equal(await associationHead.text(), '', 'Apple association HEAD returned a body');
  }

  const manifestResponse = await fetchPublic(baseUrl, '/manifest.webmanifest');
  assertPublicResponse(manifestResponse, 'manifest', /^application\/manifest\+json\b/i);
  assertNoStore(manifestResponse, 'manifest');
  const manifest = await manifestResponse.json();
  assert.equal(manifest.id, '/', 'manifest app id changed unexpectedly');
  assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest name is missing');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest icons are missing');

  const loginResponse = await fetchPublic(baseUrl, '/login');
  assertPublicResponse(loginResponse, 'login', /^text\/html\b/i);
  assertNoStore(loginResponse, 'login');
  const login = await loginResponse.text();
  assert.match(login, /<form\b[^>]*\baction=["']\/login["']/i, 'public login form is missing');

  return { releaseSha: version.releaseSha, protocolVersion: version.protocolVersion };
}

async function runLegacyOnce(baseUrl) {
  const health = await fetchPublic(baseUrl, '/healthz');
  assertPublicResponse(health, 'legacy healthz', /^text\/plain\b/i);
  assert.equal(await health.text(), 'ok', 'legacy healthz body is invalid');

  const manifestResponse = await fetchPublic(baseUrl, '/manifest.webmanifest');
  assertPublicResponse(manifestResponse, 'legacy manifest', /^application\/manifest\+json\b/i);
  const manifest = await manifestResponse.json();
  assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'legacy manifest name is missing');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'legacy manifest icons are missing');

  const loginResponse = await fetchPublic(baseUrl, '/login');
  assertPublicResponse(loginResponse, 'legacy login', /^text\/html\b/i);
  const login = await loginResponse.text();
  assert.match(login, /<form\b[^>]*\baction=["']\/login["']/i, 'legacy public login form is missing');
  return { releaseSha: 'legacy', protocolVersion: null, legacy: true };
}

export async function runPublicReleaseSmoke({
  baseUrl,
  releaseSha,
  allowLegacyRollback = false,
  allowPreNativeInviteRollback = false,
  timeoutMs = 45_000,
  retryMs = 1000
}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (releaseSha && !/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error('Expected release SHA must be 40 lowercase hex characters.');
  if (allowLegacyRollback && allowPreNativeInviteRollback) throw new Error('Rollback compatibility modes are mutually exclusive.');
  if (allowPreNativeInviteRollback && !releaseSha) throw new Error('Pre-native-invite rollback smoke requires an exact release SHA.');
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await runOnce(normalized, releaseSha, { allowPreNativeInviteRollback });
    } catch (error) {
      lastError = error;
      if (allowLegacyRollback) {
        try {
          return await runLegacyOnce(normalized);
        } catch (legacyError) {
          lastError = new Error(`${error.message}; legacy rollback proof also failed: ${legacyError.message}`);
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } while (Date.now() < deadline);
  throw lastError || new Error('Public release smoke failed.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = await runPublicReleaseSmoke(parseArgs(process.argv.slice(2)));
    console.log(`Public release smoke passed for ${result.releaseSha}.`);
  } catch (error) {
    process.stderr.write(`Public release smoke failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
