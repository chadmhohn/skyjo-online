import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import path from 'node:path';

export const APNS_BUNDLE_TOPIC = 'com.groundworkrevops.skyjo';
export const APNS_SANDBOX_ORIGIN = 'https://api.sandbox.push.apple.com';
export const APNS_PRODUCTION_ORIGIN = 'https://api.push.apple.com';
export const APNS_MAX_TOKEN_BYTES = 2048;
export const APNS_PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1000;

const canonicalInstallationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const deviceTokenPattern = /^[0-9a-f]+$/;
const boundedMetadataPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const providerIdentifierPattern = /^[A-Z0-9]{10}$/;
const roomCodePattern = /^[A-Z0-9]{5}$/;
const encryptionContext = Buffer.from('skyjo-apns-token-v1', 'utf8');
const supportedEnvironments = new Set(['development', 'production']);
const supportedKinds = new Set(['turn', 'round-ended', 'game-ended']);
const transientStatuses = new Set([429, 500, 503]);
const providerReasonAllowlist = new Set([
  'BadCollapseId',
  'BadDeviceToken',
  'BadExpirationDate',
  'BadMessageId',
  'BadPriority',
  'BadTopic',
  'DeviceTokenNotForTopic',
  'DuplicateHeaders',
  'ExpiredProviderToken',
  'ExpiredToken',
  'Forbidden',
  'IdleTimeout',
  'InternalServerError',
  'InvalidProviderToken',
  'InvalidPushType',
  'MissingDeviceToken',
  'MissingProviderToken',
  'MissingPushType',
  'MissingTopic',
  'PayloadEmpty',
  'PayloadTooLarge',
  'ServiceUnavailable',
  'Shutdown',
  'TooManyProviderTokenUpdates',
  'TooManyRequests',
  'TopicDisallowed',
  'Unregistered'
]);

function normalizedEnvironmentValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isCanonicalAPNSInstallationId(value) {
  return typeof value === 'string' && canonicalInstallationIdPattern.test(value);
}

function invalidDevice() {
  const error = new TypeError('APNs device registration is invalid.');
  error.code = 'INVALID_APNS_DEVICE';
  return error;
}

export function validateAPNSRegistration(installationId, value) {
  if (!isCanonicalAPNSInstallationId(installationId) || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDevice();
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'appVersion,deviceToken,environment,locale') throw invalidDevice();
  const { deviceToken, environment, appVersion, locale } = value;
  if (
    typeof deviceToken !== 'string' ||
    deviceToken.length < 16 ||
    deviceToken.length > APNS_MAX_TOKEN_BYTES * 2 ||
    deviceToken.length % 2 !== 0 ||
    !deviceTokenPattern.test(deviceToken) ||
    !supportedEnvironments.has(environment) ||
    typeof appVersion !== 'string' ||
    !boundedMetadataPattern.test(appVersion) ||
    typeof locale !== 'string' ||
    !boundedMetadataPattern.test(locale)
  ) {
    throw invalidDevice();
  }
  return Object.freeze({
    installationId,
    deviceToken,
    environment,
    appVersion,
    locale
  });
}

function derivedKey(masterKey, label) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(label, 'utf8'), 32));
}

export function createAPNSTokenCodec(masterKey, { randomBytes = crypto.randomBytes } = {}) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32 || typeof randomBytes !== 'function') {
    throw new TypeError('APNs token encryption key is invalid.');
  }
  const encryptionKey = derivedKey(masterKey, 'skyjo-apns-aes-256-gcm-v1');
  const fingerprintKey = derivedKey(masterKey, 'skyjo-apns-hmac-sha256-v1');
  return Object.freeze({
    encrypt(deviceToken) {
      if (typeof deviceToken !== 'string' || !deviceTokenPattern.test(deviceToken) || deviceToken.length % 2 !== 0) {
        throw invalidDevice();
      }
      const plaintext = Buffer.from(deviceToken, 'hex');
      if (plaintext.length < 8 || plaintext.length > APNS_MAX_TOKEN_BYTES) throw invalidDevice();
      const nonce = Buffer.from(randomBytes(12));
      if (nonce.length !== 12) throw new Error('APNs token encryption nonce generation failed.');
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce, { authTagLength: 16 });
      cipher.setAAD(encryptionContext);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        tokenCiphertext: ciphertext,
        tokenNonce: nonce,
        tokenAuthTag: cipher.getAuthTag(),
        tokenFingerprint: crypto.createHmac('sha256', fingerprintKey).update(plaintext).digest()
      });
    },
    decrypt({ tokenCiphertext, tokenNonce, tokenAuthTag, tokenFingerprint }) {
      try {
        if (
          !Buffer.isBuffer(tokenCiphertext) || tokenCiphertext.length < 1 || tokenCiphertext.length > APNS_MAX_TOKEN_BYTES ||
          !Buffer.isBuffer(tokenNonce) || tokenNonce.length !== 12 ||
          !Buffer.isBuffer(tokenAuthTag) || tokenAuthTag.length !== 16 ||
          !Buffer.isBuffer(tokenFingerprint) || tokenFingerprint.length !== 32
        ) {
          throw new Error('invalid encrypted token');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, tokenNonce, { authTagLength: 16 });
        decipher.setAAD(encryptionContext);
        decipher.setAuthTag(tokenAuthTag);
        const plaintext = Buffer.concat([decipher.update(tokenCiphertext), decipher.final()]);
        if (plaintext.length < 8 || plaintext.length > APNS_MAX_TOKEN_BYTES) throw new Error('invalid token length');
        const expectedFingerprint = crypto.createHmac('sha256', fingerprintKey).update(plaintext).digest();
        if (!crypto.timingSafeEqual(tokenFingerprint, expectedFingerprint)) throw new Error('invalid token fingerprint');
        return plaintext.toString('hex');
      } catch {
        throw new Error('Stored APNs device token could not be decrypted.');
      }
    }
  });
}

function canonicalBase64UrlKey(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === normalized ? decoded : null;
}

async function readPrivateConfigurationFile(filePath, label, {
  openFile = fs.open,
  requireRootOwned = process.platform !== 'win32'
} = {}) {
  const resolved = path.resolve(filePath);
  let handle;
  try {
    handle = await openFile(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} file is invalid.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} file is invalid.`);
    if (requireRootOwned && (stat.uid !== 0 || (stat.mode & 0o027) !== 0)) {
      throw new Error(`${label} file ownership or permissions are invalid.`);
    }
    if (stat.size < 1 || stat.size > 16 * 1024) throw new Error(`${label} file size is invalid.`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function validatedProviderPrivateKey(pem) {
  try {
    const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') throw new Error('wrong key type');
    return key;
  } catch {
    throw new Error('APNs provider private key is invalid.');
  }
}

export async function loadAPNSConfiguration(env = process.env, dependencies = {}) {
  const teamId = normalizedEnvironmentValue(env.SKYJO_APNS_TEAM_ID);
  const keyId = normalizedEnvironmentValue(env.SKYJO_APNS_KEY_ID);
  const privateKeyFile = normalizedEnvironmentValue(env.SKYJO_APNS_PRIVATE_KEY_FILE);
  const tokenKeyFile = normalizedEnvironmentValue(env.SKYJO_APNS_TOKEN_KEY_FILE);
  const values = [teamId, keyId, privateKeyFile, tokenKeyFile];
  if (values.every((value) => !value)) {
    return Object.freeze({ enabled: false, teamId: '', keyId: '', privateKey: null, tokenCodec: null });
  }
  if (values.some((value) => !value)) throw new Error('APNs configuration must be either complete or disabled.');
  if (!providerIdentifierPattern.test(teamId) || !providerIdentifierPattern.test(keyId)) {
    throw new Error('APNs provider identifiers are invalid.');
  }
  const [privateKeyPem, tokenKeyText] = await Promise.all([
    readPrivateConfigurationFile(privateKeyFile, 'APNs provider key', dependencies),
    readPrivateConfigurationFile(tokenKeyFile, 'APNs token encryption key', dependencies)
  ]);
  const masterKey = canonicalBase64UrlKey(tokenKeyText);
  if (!masterKey) throw new Error('APNs token encryption key is invalid.');
  return Object.freeze({
    enabled: true,
    teamId,
    keyId,
    privateKey: validatedProviderPrivateKey(privateKeyPem),
    tokenCodec: createAPNSTokenCodec(masterKey)
  });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createAPNSProviderToken({ teamId, keyId, privateKey, issuedAtSeconds }) {
  if (
    !providerIdentifierPattern.test(teamId) ||
    !providerIdentifierPattern.test(keyId) ||
    !Number.isSafeInteger(issuedAtSeconds) ||
    issuedAtSeconds < 0
  ) {
    throw new TypeError('APNs provider token input is invalid.');
  }
  const unsigned = `${base64UrlJson({ alg: 'ES256', kid: keyId })}.${base64UrlJson({ iss: teamId, iat: issuedAtSeconds })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned, 'ascii'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  if (signature.length !== 64) throw new Error('APNs provider token signing failed.');
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function createAPNSPayload({ kind, roomCode }) {
  if (!supportedKinds.has(kind) || !roomCodePattern.test(roomCode)) {
    throw new TypeError('APNs notification event is invalid.');
  }
  const copy = {
    turn: ['Your turn in Skyjo', 'Open Skyjo to take your turn.'],
    'round-ended': ['Skyjo round ended', 'Open Skyjo to review the round.'],
    'game-ended': ['Skyjo game finished', 'Open Skyjo to review the game.']
  }[kind];
  return Object.freeze({
    aps: Object.freeze({
      alert: Object.freeze({ title: copy[0], body: copy[1] }),
      sound: 'default'
    }),
    version: 1,
    kind,
    route: 'room',
    roomCode
  });
}

export function createAPNSCollapseId({ kind, roomCode }) {
  if (!supportedKinds.has(kind) || !roomCodePattern.test(roomCode)) {
    throw new TypeError('APNs notification event is invalid.');
  }
  return crypto.createHash('sha256').update(`skyjo-apns-v1\0${kind}\0${roomCode}`).digest('base64url').slice(0, 48);
}

function sanitizedProviderResponse(statusCode, body) {
  let reason = null;
  let timestamp = null;
  if (Buffer.isBuffer(body) && body.length > 0 && body.length <= 8 * 1024) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object' && providerReasonAllowlist.has(parsed.reason)) reason = parsed.reason;
      if (Number.isSafeInteger(parsed?.timestamp) && parsed.timestamp >= 0) timestamp = parsed.timestamp;
    } catch {
      // Provider bodies are intentionally discarded rather than surfaced.
    }
  }
  return Object.freeze({
    delivered: statusCode === 200,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    reason,
    timestamp,
    permanentTokenFailure: (
      statusCode === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')
    ) || (statusCode === 410 && reason === 'Unregistered'),
    retryable: transientStatuses.has(statusCode)
  });
}

function transportFailure() {
  return Object.freeze({
    delivered: false,
    statusCode: null,
    reason: null,
    timestamp: null,
    permanentTokenFailure: false,
    retryable: true
  });
}

export class APNSHTTP2Transport {
  constructor({
    connect = http2.connect,
    maxConcurrentStreams = 8,
    maxQueuedRequests = 128,
    responseTimeoutMs = 10_000,
    maxResponseBytes = 8 * 1024
  } = {}) {
    if (typeof connect !== 'function') throw new TypeError('APNs transport connector is invalid.');
    if (!Number.isSafeInteger(maxConcurrentStreams) || maxConcurrentStreams < 1 || maxConcurrentStreams > 100) {
      throw new TypeError('APNs transport stream limit is invalid.');
    }
    if (!Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 0 || maxQueuedRequests > 1024) {
      throw new TypeError('APNs transport queue limit is invalid.');
    }
    if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 100 || responseTimeoutMs > 60_000) {
      throw new TypeError('APNs transport timeout is invalid.');
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024) {
      throw new TypeError('APNs transport response limit is invalid.');
    }
    this.connect = connect;
    this.maxConcurrentStreams = maxConcurrentStreams;
    this.maxQueuedRequests = maxQueuedRequests;
    this.responseTimeoutMs = responseTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.states = new Map();
    this.closed = false;
  }

  stateFor(environment) {
    if (!supportedEnvironments.has(environment)) throw new TypeError('APNs environment is invalid.');
    let state = this.states.get(environment);
    if (!state) {
      state = { active: 0, queue: [], session: null };
      this.states.set(environment, state);
    }
    return state;
  }

  sessionFor(environment, state) {
    if (state.session && !state.session.closed && !state.session.destroyed) return state.session;
    const origin = environment === 'development' ? APNS_SANDBOX_ORIGIN : APNS_PRODUCTION_ORIGIN;
    const session = this.connect(origin);
    state.session = session;
    const retire = () => {
      if (state.session === session) state.session = null;
    };
    session.once('close', retire);
    // Keep a listener installed for the session lifetime: a second transport
    // error must remain contained rather than becoming an unhandled event.
    session.on('error', retire);
    session.once('goaway', () => {
      retire();
      try {
        session.close();
      } catch {
        session.destroy();
      }
    });
    return session;
  }

  async send({ environment, headers, body }) {
    if (this.closed) throw new Error('APNs transport is closed.');
    const state = this.stateFor(environment);
    if (state.active >= this.maxConcurrentStreams) {
      if (state.queue.length >= this.maxQueuedRequests) throw new Error('APNs transport queue is full.');
      await new Promise((resolve, reject) => state.queue.push({ resolve, reject }));
    } else {
      state.active += 1;
    }
    try {
      if (this.closed) throw new Error('APNs transport is closed.');
      return await new Promise((resolve, reject) => {
        let settled = false;
        let responseHeaders = null;
        const chunks = [];
        let size = 0;
        const request = this.sessionFor(environment, state).request(headers, { endStream: false });
        const fail = () => {
          if (settled) return;
          settled = true;
          try {
            request.close(http2.constants.NGHTTP2_CANCEL);
          } catch {
            // The rejection below still releases the bounded stream permit.
          }
          reject(new Error('APNs transport request failed.'));
        };
        request.setTimeout(this.responseTimeoutMs, fail);
        request.once('error', fail);
        request.once('aborted', fail);
        request.once('response', (receivedHeaders) => {
          responseHeaders = receivedHeaders;
        });
        request.on('data', (chunk) => {
          size += chunk.length;
          if (size > this.maxResponseBytes) {
            fail();
            return;
          }
          chunks.push(chunk);
        });
        request.once('end', () => {
          if (settled) return;
          const statusCode = Number(responseHeaders?.[':status'] || 0);
          if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            fail();
            return;
          }
          settled = true;
          resolve({
            statusCode,
            body: Buffer.concat(chunks)
          });
        });
        request.end(body);
      });
    } finally {
      const waiter = state.queue.shift();
      if (waiter) waiter.resolve();
      else state.active -= 1;
    }
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) {
      for (const waiter of state.queue.splice(0)) waiter.reject(new Error('APNs transport is closed.'));
      const session = state.session;
      state.session = null;
      if (!session) continue;
      try {
        session.close();
      } catch {
        session.destroy();
        continue;
      }
      const timer = setTimeout(() => session.destroy(), 5_000);
      timer.unref?.();
    }
  }
}

export function createAPNSProvider({
  configuration,
  transport = new APNSHTTP2Transport(),
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomUUID = crypto.randomUUID
}) {
  if (!configuration?.enabled || !configuration.privateKey) throw new TypeError('APNs provider configuration is unavailable.');
  let cachedToken = null;
  let cachedAt = 0;
  function providerToken(force = false) {
    const timestamp = now();
    if (!force && cachedToken && timestamp - cachedAt < APNS_PROVIDER_TOKEN_LIFETIME_MS) return cachedToken;
    cachedAt = timestamp;
    cachedToken = createAPNSProviderToken({
      teamId: configuration.teamId,
      keyId: configuration.keyId,
      privateKey: configuration.privateKey,
      issuedAtSeconds: Math.floor(timestamp / 1000)
    });
    return cachedToken;
  }
  return Object.freeze({
    async send({ environment, deviceToken, event }) {
      if (
        !supportedEnvironments.has(environment) ||
        typeof deviceToken !== 'string' ||
        deviceToken.length < 16 ||
        deviceToken.length > APNS_MAX_TOKEN_BYTES * 2 ||
        deviceToken.length % 2 !== 0 ||
        !deviceTokenPattern.test(deviceToken)
      ) {
        throw invalidDevice();
      }
      const payload = Buffer.from(JSON.stringify(createAPNSPayload(event)), 'utf8');
      if (payload.length > 4096) throw new Error('APNs notification payload exceeds the provider limit.');
      const apnsId = randomUUID();
      let refreshedExpiredToken = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const headers = {
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${providerToken(refreshedExpiredToken)}`,
          'content-type': 'application/json',
          'apns-id': apnsId,
          'apns-topic': APNS_BUNDLE_TOPIC,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(now() / 1000) + 300),
          'apns-collapse-id': createAPNSCollapseId(event)
        };
        let result;
        try {
          const response = await transport.send({ environment, headers, body: payload });
          result = sanitizedProviderResponse(response.statusCode, response.body);
        } catch {
          result = transportFailure();
        }
        if (result.delivered || result.permanentTokenFailure) return result;
        if (result.statusCode === 403 && result.reason === 'ExpiredProviderToken' && !refreshedExpiredToken) {
          refreshedExpiredToken = true;
          cachedToken = null;
          continue;
        }
        if (!result.retryable || attempt === 1) return result;
        await sleep(100 * (attempt + 1));
      }
      return transportFailure();
    },
    shutdown() {
      transport.shutdown?.();
    }
  });
}

export function createAPNSRegistrationRateLimiter({
  limit = 20,
  windowMs = 60 * 60 * 1000,
  maxEntries = 4096,
  now = Date.now
} = {}) {
  if (
    !Number.isSafeInteger(limit) || limit < 1 ||
    !Number.isSafeInteger(windowMs) || windowMs < 1 ||
    !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65_536
  ) {
    throw new TypeError('APNs registration rate limit is invalid.');
  }
  const entries = new Map();
  return Object.freeze({
    consume(key) {
      const timestamp = now();
      if (!entries.has(key) && entries.size >= maxEntries) {
        for (const [candidate, value] of entries) {
          if (timestamp - value.startedAt >= windowMs) entries.delete(candidate);
        }
        if (entries.size >= maxEntries) {
          let earliestExpiry = Number.POSITIVE_INFINITY;
          for (const entry of entries.values()) earliestExpiry = Math.min(earliestExpiry, entry.startedAt + windowMs);
          return Object.freeze({
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((earliestExpiry - timestamp) / 1000))
          });
        }
      }
      const prior = entries.get(key);
      const entry = !prior || timestamp - prior.startedAt >= windowMs
        ? { count: 0, startedAt: timestamp }
        : prior;
      entry.count += 1;
      entries.set(key, entry);
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.startedAt + windowMs - timestamp) / 1000));
      return Object.freeze({ allowed: entry.count <= limit, retryAfterSeconds });
    }
  });
}

function safeReport(reporter, diagnostic) {
  if (typeof reporter !== 'function') return;
  try {
    const result = reporter(diagnostic);
    if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
  } catch {
    // Diagnostics cannot affect notification delivery.
  }
}

export async function deliverAPNSNotifications({
  devices,
  event,
  tokenCodec,
  provider,
  deleteDevice,
  reportFailure,
  reportCleanupFailure
}) {
  const entries = Array.isArray(devices) ? devices : [];
  return Promise.all(entries.map(async (device) => {
    let deviceToken;
    try {
      deviceToken = tokenCodec.decrypt(device);
    } catch {
      const diagnostic = Object.freeze({ statusCode: null, providerReason: null, environment: null, stage: 'decrypt' });
      safeReport(reportFailure, diagnostic);
      return { delivered: false, deleted: false, cleanupFailed: false, diagnostic };
    }
    let result;
    try {
      result = await provider.send({ environment: device.environment, deviceToken, event });
    } catch {
      result = transportFailure();
    }
    if (result.delivered) return { delivered: true, deleted: false, cleanupFailed: false };
    const diagnostic = Object.freeze({
      statusCode: result.statusCode,
      providerReason: result.reason,
      environment: supportedEnvironments.has(device.environment) ? device.environment : null,
      stage: 'provider'
    });
    safeReport(reportFailure, diagnostic);
    const timestampAllowsCleanup = result.statusCode !== 410 || (
      Number.isSafeInteger(result.timestamp) && result.timestamp >= device.updatedAt
    );
    if (!result.permanentTokenFailure || !timestampAllowsCleanup) {
      return { delivered: false, deleted: false, cleanupFailed: false, diagnostic };
    }
    try {
      const deleted = Number(await deleteDevice(device)) > 0;
      return { delivered: false, deleted, cleanupFailed: false, diagnostic };
    } catch {
      safeReport(reportCleanupFailure, diagnostic);
      return { delivered: false, deleted: false, cleanupFailed: true, diagnostic };
    }
  }));
}
