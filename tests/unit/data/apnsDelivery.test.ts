import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APNS_BUNDLE_TOPIC,
  APNSHTTP2Transport,
  APNS_PROVIDER_TOKEN_LIFETIME_MS,
  APNS_PRODUCTION_ORIGIN,
  APNS_SANDBOX_ORIGIN,
  createAPNSCollapseId,
  createAPNSPayload,
  createAPNSProvider,
  createAPNSProviderToken,
  createAPNSRegistrationRateLimiter,
  createAPNSTokenCodec,
  deliverAPNSNotifications,
  isCanonicalAPNSInstallationId,
  loadAPNSConfiguration,
  validateAPNSRegistration
} from '../../../server-apns.mjs';

const installationId = '1000000a-0000-4000-8000-000000000001';
const fixedNow = Date.parse('2026-08-19T12:00:00.000Z');
const deviceToken = '01'.repeat(32);
const event = { kind: 'turn', roomCode: 'ABCDE' };

class FakeAPNSStream extends EventEmitter {
  setTimeout = vi.fn((_milliseconds: number, callback: () => void) => {
    if (this.timeout) queueMicrotask(callback);
    return this;
  });
  close = vi.fn();
  end = vi.fn(() => {
    if (this.timeout || !this.autoRespond) return;
    this.respond();
  });
  respond() {
    queueMicrotask(() => {
      this.emit('response', { ':status': this.statusCode });
      if (this.responseBody.length > 0) this.emit('data', this.responseBody);
      this.emit('end');
    });
  }

  constructor(
    private readonly statusCode = 200,
    private readonly responseBody = Buffer.alloc(0),
    private readonly timeout = false,
    private readonly autoRespond = true
  ) {
    super();
  }
}

class FakeAPNSSession extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: FakeAPNSStream[] = [];
  request = vi.fn(() => {
    const stream = new FakeAPNSStream(this.statusCode, this.responseBody, this.timeout, this.autoRespond);
    this.streams.push(stream);
    return stream;
  });
  close = vi.fn(() => {
    this.closed = true;
    this.emit('close');
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });

  constructor(
    private readonly statusCode = 200,
    private readonly responseBody = Buffer.alloc(0),
    private readonly timeout = false,
    private readonly autoRespond = true
  ) {
    super();
  }
}

function providerKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function providerConfiguration() {
  const { privateKey } = providerKeyPair();
  return {
    enabled: true,
    teamId: 'TEAMID1234',
    keyId: 'KEYID12345',
    privateKey,
    tokenCodec: createAPNSTokenCodec(Buffer.alloc(32, 9))
  };
}

describe('APNs registration and encrypted token material', () => {
  it('accepts exact variable-size lowercase tokens and rejects malformed registrations', () => {
    expect(isCanonicalAPNSInstallationId(installationId)).toBe(true);
    expect(isCanonicalAPNSInstallationId(installationId.toUpperCase())).toBe(false);
    expect(validateAPNSRegistration(installationId, {
      deviceToken,
      environment: 'development',
      appVersion: '0.1.0-42',
      locale: 'en-US'
    })).toEqual({
      installationId,
      deviceToken,
      environment: 'development',
      appVersion: '0.1.0-42',
      locale: 'en-US'
    });
    expect(validateAPNSRegistration(installationId, {
      deviceToken: 'ab'.repeat(96),
      environment: 'production',
      appVersion: '27.0',
      locale: 'fr_CA'
    }).deviceToken).toHaveLength(192);

    for (const [candidateId, body] of [
      ['not-a-uuid', { deviceToken, environment: 'development', appVersion: '0.1.0', locale: 'en-US' }],
      [installationId, null],
      [installationId, { deviceToken, environment: 'development', appVersion: '0.1.0', locale: 'en-US', extra: true }],
      [installationId, { deviceToken: 'AB'.repeat(32), environment: 'development', appVersion: '0.1.0', locale: 'en-US' }],
      [installationId, { deviceToken: 'a'.repeat(17), environment: 'development', appVersion: '0.1.0', locale: 'en-US' }],
      [installationId, { deviceToken: '01'.repeat(2049), environment: 'development', appVersion: '0.1.0', locale: 'en-US' }],
      [installationId, { deviceToken, environment: 'staging', appVersion: '0.1.0', locale: 'en-US' }],
      [installationId, { deviceToken, environment: 'development', appVersion: 'bad version', locale: 'en-US' }],
      [installationId, { deviceToken, environment: 'development', appVersion: '0.1.0', locale: '' }]
    ] as const) {
      expect(() => validateAPNSRegistration(candidateId, body)).toThrow(/invalid/i);
    }
  });

  it('round-trips AES-256-GCM ciphertext and uses a stable keyed fingerprint', () => {
    let nonceByte = 0;
    const codec = createAPNSTokenCodec(Buffer.alloc(32, 4), {
      randomBytes: (length: number) => Buffer.alloc(length, ++nonceByte)
    });
    const first = codec.encrypt(deviceToken);
    const second = codec.encrypt(deviceToken);
    const other = codec.encrypt('02'.repeat(32));
    expect(codec.decrypt(first)).toBe(deviceToken);
    expect(first.tokenCiphertext.equals(Buffer.from(deviceToken, 'hex'))).toBe(false);
    expect(first.tokenCiphertext.equals(second.tokenCiphertext)).toBe(false);
    expect(first.tokenFingerprint.equals(second.tokenFingerprint)).toBe(true);
    expect(first.tokenFingerprint.equals(other.tokenFingerprint)).toBe(false);
    expect(first.tokenNonce).toHaveLength(12);
    expect(first.tokenAuthTag).toHaveLength(16);

    const tampered = { ...first, tokenAuthTag: Buffer.from(first.tokenAuthTag) };
    tampered.tokenAuthTag[0] ^= 1;
    expect(() => codec.decrypt(tampered)).toThrow(/could not be decrypted/i);
    const mismatchedFingerprint = { ...first, tokenFingerprint: Buffer.from(first.tokenFingerprint) };
    mismatchedFingerprint.tokenFingerprint[0] ^= 1;
    expect(() => codec.decrypt(mismatchedFingerprint)).toThrow(/could not be decrypted/i);
    expect(() => createAPNSTokenCodec(Buffer.alloc(31))).toThrow(/key is invalid/i);
    expect(() => createAPNSTokenCodec(Buffer.alloc(32), { randomBytes: () => Buffer.alloc(11) }).encrypt(deviceToken))
      .toThrow(/nonce generation/i);
    expect(() => codec.encrypt('ABCDEF')).toThrow(/invalid/i);
    expect(() => codec.decrypt({ tokenCiphertext: Buffer.alloc(0), tokenNonce: Buffer.alloc(12), tokenAuthTag: Buffer.alloc(16) }))
      .toThrow(/could not be decrypted/i);
  });
});

describe('APNs server-only configuration and provider token', () => {
  it('supports disabled configuration and loads coherent key files without exposing values', async () => {
    expect(await loadAPNSConfiguration({})).toEqual({
      enabled: false,
      teamId: '',
      keyId: '',
      privateKey: null,
      tokenCodec: null
    });
    await expect(loadAPNSConfiguration({ SKYJO_APNS_TEAM_ID: 'TEAMID1234' })).rejects.toThrow(/complete or disabled/i);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apns-config-'));
    const privateKeyFile = path.join(directory, 'provider.p8');
    const tokenKeyFile = path.join(directory, 'token.key');
    const { privateKey } = providerKeyPair();
    try {
      await fs.writeFile(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
      await fs.writeFile(tokenKeyFile, `${Buffer.alloc(32, 5).toString('base64url')}\n`);
      const configuration = await loadAPNSConfiguration({
        SKYJO_APNS_TEAM_ID: 'TEAMID1234',
        SKYJO_APNS_KEY_ID: 'KEYID12345',
        SKYJO_APNS_PRIVATE_KEY_FILE: privateKeyFile,
        SKYJO_APNS_TOKEN_KEY_FILE: tokenKeyFile
      }, { requireRootOwned: false });
      expect(configuration.enabled).toBe(true);
      expect(configuration.privateKey.asymmetricKeyType).toBe('ec');
      const encrypted = configuration.tokenCodec.encrypt(deviceToken);
      expect(configuration.tokenCodec.decrypt(encrypted)).toBe(deviceToken);

      await fs.writeFile(tokenKeyFile, 'not-a-key\n');
      await expect(loadAPNSConfiguration({
        SKYJO_APNS_TEAM_ID: 'TEAMID1234',
        SKYJO_APNS_KEY_ID: 'KEYID12345',
        SKYJO_APNS_PRIVATE_KEY_FILE: privateKeyFile,
        SKYJO_APNS_TOKEN_KEY_FILE: tokenKeyFile
      }, { requireRootOwned: false })).rejects.toThrow(/encryption key is invalid/i);

      const tokenKeyTarget = path.join(directory, 'token-target.key');
      await fs.writeFile(tokenKeyTarget, `${Buffer.alloc(32, 5).toString('base64url')}\n`);
      await fs.rm(tokenKeyFile);
      await fs.symlink(tokenKeyTarget, tokenKeyFile);
      await expect(loadAPNSConfiguration({
        SKYJO_APNS_TEAM_ID: 'TEAMID1234',
        SKYJO_APNS_KEY_ID: 'KEYID12345',
        SKYJO_APNS_PRIVATE_KEY_FILE: privateKeyFile,
        SKYJO_APNS_TOKEN_KEY_FILE: tokenKeyFile
      }, { requireRootOwned: false })).rejects.toThrow(/file is invalid/i);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('creates a verifiable ES256 provider JWT with only the required claims', () => {
    const { privateKey, publicKey } = providerKeyPair();
    const issuedAtSeconds = Math.floor(fixedNow / 1000);
    const token = createAPNSProviderToken({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey,
      issuedAtSeconds
    });
    const [header, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toEqual({ iss: 'TEAMID1234', iat: issuedAtSeconds });
    expect(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363'
    }, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(() => createAPNSProviderToken({
      teamId: 'bad', keyId: 'KEYID12345', privateKey, issuedAtSeconds
    })).toThrow(/input is invalid/i);
  });
});

describe('APNs payload and provider behavior', () => {
  it('cancels a snapshotted device when account deletion fences delivery', async () => {
    const codec = createAPNSTokenCodec(Buffer.alloc(32, 6), { randomBytes: () => Buffer.alloc(12, 8) });
    const device = {
      installationId,
      environment: 'production',
      ...codec.encrypt(deviceToken),
      updatedAt: fixedNow
    };
    const provider = { send: vi.fn() };
    await expect(deliverAPNSNotifications({
      devices: [device],
      event,
      tokenCodec: codec,
      provider,
      deleteDevice: vi.fn(),
      shouldDeliver: vi.fn().mockResolvedValue(false)
    })).resolves.toEqual([{
      delivered: false,
      deleted: false,
      cleanupFailed: false,
      cancelled: true
    }]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('uses generic visible copy and only the approved routing fields', () => {
    for (const kind of ['turn', 'round-ended', 'game-ended'] as const) {
      const payload = createAPNSPayload({ kind, roomCode: 'ABCDE' });
      expect(payload).toMatchObject({ version: 1, kind, route: 'room', roomCode: 'ABCDE' });
      expect(Object.keys(payload).sort()).toEqual(['aps', 'kind', 'roomCode', 'route', 'version']);
      expect(JSON.stringify(payload.aps)).not.toContain('ABCDE');
      expect(JSON.stringify(payload)).not.toMatch(/actor|email|score|card|chat|invite|token|command/i);
    }
    const collapseId = createAPNSCollapseId(event);
    expect(collapseId).toBe(createAPNSCollapseId(event));
    expect(collapseId).not.toContain('ABCDE');
    expect(() => createAPNSPayload({ kind: 'unknown', roomCode: 'ABCDE' })).toThrow(/event is invalid/i);
    expect(() => createAPNSCollapseId({ kind: 'turn', roomCode: 'bad' })).toThrow(/event is invalid/i);
  });

  it('sends fixed headers, caches JWTs, and shuts down the injected transport', async () => {
    let now = fixedNow;
    const transport = {
      send: vi.fn().mockResolvedValue({ statusCode: 200, body: Buffer.alloc(0) }),
      shutdown: vi.fn()
    };
    const provider = createAPNSProvider({
      configuration: providerConfiguration(),
      transport,
      now: () => now,
      randomUUID: () => '20000000-0000-4000-8000-000000000002'
    });
    await expect(provider.send({ environment: 'development', deviceToken, event })).resolves.toMatchObject({ delivered: true });
    await provider.send({ environment: 'production', deviceToken, event });
    const [first, second] = transport.send.mock.calls.map(([request]) => request);
    expect(first.environment).toBe('development');
    expect(second.environment).toBe('production');
    expect(first.headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'apns-topic': APNS_BUNDLE_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(now / 1000) + 300),
      'apns-id': '20000000-0000-4000-8000-000000000002'
    });
    expect(first.headers.authorization).toBe(second.headers.authorization);
    expect(JSON.parse(first.body.toString('utf8'))).toEqual(createAPNSPayload(event));

    now += APNS_PROVIDER_TOKEN_LIFETIME_MS + 1;
    await provider.send({ environment: 'production', deviceToken, event });
    expect(transport.send.mock.calls[2][0].headers.authorization).not.toBe(first.headers.authorization);
    provider.shutdown();
    expect(transport.shutdown).toHaveBeenCalledOnce();
  });

  it('retries one transient response, refreshes an expired JWT, and never retries a permanent token failure', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const transientTransport = {
      send: vi.fn()
        .mockResolvedValueOnce({ statusCode: 503, body: Buffer.from('{"reason":"ServiceUnavailable"}') })
        .mockResolvedValueOnce({ statusCode: 200, body: Buffer.alloc(0) })
    };
    const transientProvider = createAPNSProvider({
      configuration: providerConfiguration(),
      transport: transientTransport,
      now: () => fixedNow,
      sleep
    });
    await expect(transientProvider.send({ environment: 'production', deviceToken, event })).resolves.toMatchObject({ delivered: true });
    expect(transientTransport.send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);

    const expiredTransport = {
      send: vi.fn()
        .mockResolvedValueOnce({ statusCode: 403, body: Buffer.from('{"reason":"ExpiredProviderToken"}') })
        .mockResolvedValueOnce({ statusCode: 200, body: Buffer.alloc(0) })
    };
    const expiredProvider = createAPNSProvider({
      configuration: providerConfiguration(),
      transport: expiredTransport,
      now: () => fixedNow
    });
    await expect(expiredProvider.send({ environment: 'development', deviceToken, event })).resolves.toMatchObject({ delivered: true });
    expect(expiredTransport.send).toHaveBeenCalledTimes(2);

    const permanentTransport = {
      send: vi.fn().mockResolvedValue({ statusCode: 400, body: Buffer.from('{"reason":"BadDeviceToken"}') })
    };
    const permanentProvider = createAPNSProvider({
      configuration: providerConfiguration(),
      transport: permanentTransport,
      now: () => fixedNow
    });
    await expect(permanentProvider.send({ environment: 'production', deviceToken, event })).resolves.toMatchObject({
      delivered: false,
      permanentTokenFailure: true,
      reason: 'BadDeviceToken'
    });
    expect(permanentTransport.send).toHaveBeenCalledOnce();

    const mismatchedTransport = {
      send: vi.fn().mockResolvedValue({ statusCode: 400, body: Buffer.from('{"reason":"Unregistered"}') })
    };
    const mismatchedProvider = createAPNSProvider({
      configuration: providerConfiguration(),
      transport: mismatchedTransport,
      now: () => fixedNow
    });
    await expect(mismatchedProvider.send({ environment: 'production', deviceToken, event })).resolves.toMatchObject({
      delivered: false,
      permanentTokenFailure: false,
      reason: 'Unregistered'
    });
    expect(mismatchedTransport.send).toHaveBeenCalledOnce();
  });

  it('bounds the fixed-host HTTP/2 transport and retires sessions on GOAWAY, timeout, overflow, and shutdown', async () => {
    const sessions: FakeAPNSSession[] = [];
    const connect = vi.fn(() => {
      const session = new FakeAPNSSession(200, Buffer.from('{}'));
      sessions.push(session);
      return session;
    });
    const transport = new APNSHTTP2Transport({ connect, maxConcurrentStreams: 1, maxQueuedRequests: 1 });
    await expect(transport.send({
      environment: 'development', headers: { ':path': '/redacted' }, body: Buffer.from('{}')
    })).resolves.toEqual({ statusCode: 200, body: Buffer.from('{}') });
    expect(connect).toHaveBeenCalledWith(APNS_SANDBOX_ORIGIN);
    sessions[0].emit('goaway');
    await transport.send({ environment: 'development', headers: { ':path': '/redacted' }, body: Buffer.from('{}') });
    await transport.send({ environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.from('{}') });
    expect(connect).toHaveBeenLastCalledWith(APNS_PRODUCTION_ORIGIN);
    transport.shutdown();
    expect(sessions.every((session) => session.closed)).toBe(true);

    const overflow = new APNSHTTP2Transport({
      connect: () => new FakeAPNSSession(400, Buffer.alloc(9)),
      maxResponseBytes: 8
    });
    await expect(overflow.send({
      environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.alloc(0)
    })).rejects.toThrow(/request failed/i);
    overflow.shutdown();

    const timeout = new APNSHTTP2Transport({
      connect: () => new FakeAPNSSession(200, Buffer.alloc(0), true),
      responseTimeoutMs: 100
    });
    await expect(timeout.send({
      environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.alloc(0)
    })).rejects.toThrow(/request failed/i);
    timeout.shutdown();

    const deferredSession = new FakeAPNSSession(200, Buffer.alloc(0), false, false);
    const bounded = new APNSHTTP2Transport({
      connect: () => deferredSession,
      maxConcurrentStreams: 1,
      maxQueuedRequests: 1
    });
    const first = bounded.send({ environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.alloc(0) });
    const second = bounded.send({ environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.alloc(0) });
    await expect(bounded.send({
      environment: 'production', headers: { ':path': '/redacted' }, body: Buffer.alloc(0)
    })).rejects.toThrow(/queue is full/i);
    expect(deferredSession.request).toHaveBeenCalledOnce();
    deferredSession.streams[0].respond();
    await first;
    await Promise.resolve();
    expect(deferredSession.request).toHaveBeenCalledTimes(2);
    deferredSession.streams[1].respond();
    await second;
    bounded.shutdown();

    expect(() => new APNSHTTP2Transport({ maxConcurrentStreams: 0 })).toThrow(/stream limit/i);
    expect(() => new APNSHTTP2Transport({ maxQueuedRequests: 1025 })).toThrow(/queue limit/i);
    expect(() => new APNSHTTP2Transport({ responseTimeoutMs: 99 })).toThrow(/timeout/i);
    expect(() => new APNSHTTP2Transport({ maxResponseBytes: 0 })).toThrow(/response limit/i);
  });
});

describe('APNs delivery cleanup and registration throttling', () => {
  it('retires only current, documented permanent failures and keeps redacted diagnostics', async () => {
    const codec = createAPNSTokenCodec(Buffer.alloc(32, 6), { randomBytes: () => Buffer.alloc(12, 8) });
    const makeDevice = (suffix: string, updatedAt = fixedNow) => ({
      installationId: `10000000-0000-4000-8000-0000000000${suffix}`,
      environment: 'production',
      ...codec.encrypt(suffix.repeat(64)),
      updatedAt
    });
    const success = makeDevice('1');
    const bad = makeDevice('2');
    const oldUnregistered = makeDevice('3');
    const currentUnregistered = makeDevice('4');
    const corrupt = { ...makeDevice('5'), tokenAuthTag: Buffer.alloc(16) };
    const provider = {
      send: vi.fn(async ({ deviceToken: token }: { deviceToken: string }) => {
        if (token.startsWith('1')) return { delivered: true };
        if (token.startsWith('2')) return {
          delivered: false, statusCode: 400, reason: 'BadDeviceToken', timestamp: null, permanentTokenFailure: true, retryable: false
        };
        return {
          delivered: false,
          statusCode: 410,
          reason: 'Unregistered',
          timestamp: token.startsWith('3') ? fixedNow - 1 : fixedNow,
          permanentTokenFailure: true,
          retryable: false
        };
      })
    };
    const deleteDevice = vi.fn().mockReturnValue(1);
    const diagnostics: unknown[] = [];
    const results = await deliverAPNSNotifications({
      devices: [success, bad, oldUnregistered, currentUnregistered, corrupt],
      event,
      tokenCodec: codec,
      provider,
      deleteDevice,
      reportFailure: (diagnostic: unknown) => diagnostics.push(diagnostic)
    });
    expect(results.map(({ delivered, deleted }: { delivered: boolean; deleted: boolean }) => ({ delivered, deleted }))).toEqual([
      { delivered: true, deleted: false },
      { delivered: false, deleted: true },
      { delivered: false, deleted: false },
      { delivered: false, deleted: true },
      { delivered: false, deleted: false }
    ]);
    expect(deleteDevice.mock.calls.map(([device]) => device.installationId)).toEqual([
      bad.installationId,
      currentUnregistered.installationId
    ]);
    const exposed = JSON.stringify({ diagnostics, results });
    expect(exposed).not.toContain('ABCDE');
    expect(exposed).not.toContain(deviceToken);
    expect(exposed).not.toMatch(/installationId|tokenCiphertext|tokenFingerprint|apns-id/i);
  });

  it('bounds per-account registration attempts with a stable retry interval', () => {
    let now = fixedNow;
    const limiter = createAPNSRegistrationRateLimiter({ limit: 2, windowMs: 1_000, maxEntries: 2, now: () => now });
    expect(limiter.consume('account').allowed).toBe(true);
    expect(limiter.consume('account').allowed).toBe(true);
    expect(limiter.consume('account')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume('other').allowed).toBe(true);
    expect(limiter.consume('third')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now += 1_000;
    expect(limiter.consume('account').allowed).toBe(true);
    expect(() => createAPNSRegistrationRateLimiter({ limit: 0 })).toThrow(/rate limit is invalid/i);
    expect(() => createAPNSRegistrationRateLimiter({ maxEntries: 0 })).toThrow(/rate limit is invalid/i);
  });
});
