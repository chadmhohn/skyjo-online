import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  createAccountStore,
  PublicApiError,
  publicApiErrorResponse
} from '../../../server-account-store.mjs';
import {
  cleanInviteInstallCode,
  createInviteRedemptionRateLimiter,
  createPersistentInviteInstallCode,
  hashInviteInstallCode
} from '../../../server-invite-codes.mjs';
import {
  createAppleAppSiteAssociation,
  createRoomInviteToken,
  inviteMatchesRoom,
  isRoomInviteToken,
  parseRoomInviteToken,
  resolveAppleApplicationIdentifier,
  SYNTHETIC_APPLE_APPLICATION_IDENTIFIER
} from '../../../server-room-invites.mjs';

const secret = 'test-invite-secret-at-least-sixteen-bytes';
const roomInstanceA = '11111111-1111-4111-8111-111111111111';
const roomInstanceB = '22222222-2222-4222-8222-222222222222';

type ChildStoreResult = {
  ready: boolean;
  schemaVersion: number;
  consumed?: {
    roomCode: string;
    roomInstanceId: string;
    redeemedAt: number;
  } | null;
};

function spawnStoreWorker(databaseFile: string, timestamp: number, action: 'open' | 'consume', lookup = '') {
  const source = `
    const { createAccountStore } = await import(process.env.SKYJO_TEST_STORE_MODULE);
    await new Promise((resolve) => process.stdin.once('data', resolve));
    try {
      const store = await createAccountStore({
        filePath: process.env.SKYJO_TEST_DB,
        now: () => Number(process.env.SKYJO_TEST_NOW)
      });
      const consumed = process.env.SKYJO_TEST_ACTION === 'consume'
        ? store.consumeInviteCode(process.env.SKYJO_TEST_LOOKUP)
        : undefined;
      process.stdout.write(JSON.stringify({
        ready: store.checkReadiness(),
        schemaVersion: store.getSchemaVersion(),
        ...(consumed === undefined ? {} : { consumed })
      }));
      store.close();
    } catch (error) {
      process.stderr.write(error?.stack || String(error));
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: {
      ...process.env,
      SKYJO_TEST_ACTION: action,
      SKYJO_TEST_DB: databaseFile,
      SKYJO_TEST_LOOKUP: lookup,
      SKYJO_TEST_NOW: String(timestamp),
      SKYJO_TEST_STORE_MODULE: pathToFileURL(path.resolve('server-account-store.mjs')).href
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const result = new Promise<ChildStoreResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Account-store worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ChildStoreResult);
      } catch (error) {
        reject(new Error(`Account-store worker returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
  return {
    release() {
      child.stdin.end('go');
    },
    result
  };
}

describe('persistent invite codes', () => {
  let tempDir = '';
  let databaseFile = '';
  let timestamp = Date.UTC(2026, 6, 13, 12);
  const stores: Array<{ close: () => void }> = [];

  async function openStore() {
    const store = await createAccountStore({ filePath: databaseFile, now: () => timestamp });
    stores.push(store);
    return store;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-invite-code-'));
    databaseFile = path.join(tempDir, 'skyjo.sqlite');
    timestamp = Date.UTC(2026, 6, 13, 12);
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it('uses normalized, keyed, domain-separated HMAC lookup values without storing the code or token', async () => {
    expect(cleanInviteInstallCode(' abcd234 ')).toBe('ABCD234');
    expect(cleanInviteInstallCode('abcd-234')).toBe('');
    expect(cleanInviteInstallCode('ABCDEFGATTACK')).toBe('');
    expect(cleanInviteInstallCode('ABC!EFG')).toBe('');
    const lookup = hashInviteInstallCode('ABCD234', secret);
    expect(lookup).toMatch(/^[0-9a-f]{64}$/);
    expect(lookup).not.toBe(hashInviteInstallCode('ABCD234', `${secret}-other`));
    expect(lookup).not.toBe(hashInviteInstallCode('ABCD235', secret));
    expect(() => hashInviteInstallCode('short', secret)).toThrow(/invalid/i);
    expect(() => hashInviteInstallCode('ABCD234', 'short')).toThrow(/secret/i);

    const store = await openStore();
    expect(
      store.createInviteCode({
        codeLookupHash: lookup,
        expiresAt: timestamp + 60_000,
        roomCode: 'ABCDE',
        roomInstanceId: roomInstanceA
      })
    ).toMatchObject({ status: 'created' });
    const row = store.db.prepare('SELECT * FROM invite_codes').get();
    expect(JSON.stringify(row)).not.toContain('ABCD234');
    expect(JSON.stringify(row)).not.toContain('invite-token');
    expect(row).toMatchObject({
      code_lookup_hash: lookup,
      room_code: 'ABCDE',
      room_instance_id: roomInstanceA
    });
  });

  it('survives restart and atomically permits exactly one cross-process redemption', async () => {
    const lookup = hashInviteInstallCode('AAAAAAA', secret);
    const creator = await openStore();
    creator.createInviteCode({
      codeLookupHash: lookup,
      expiresAt: timestamp + 60_000,
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceA
    });
    creator.close();
    stores.splice(stores.indexOf(creator), 1);

    const firstWorker = spawnStoreWorker(databaseFile, timestamp, 'consume', lookup);
    const secondWorker = spawnStoreWorker(databaseFile, timestamp, 'consume', lookup);
    firstWorker.release();
    secondWorker.release();
    const [{ consumed: first }, { consumed: second }] = await Promise.all([
      firstWorker.result,
      secondWorker.result
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first || second).toMatchObject({
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceA,
      redeemedAt: timestamp
    });
    const reopened = await openStore();
    expect(reopened.consumeInviteCode(lookup)).toBeNull();
  });

  it('fails expired, malformed, reused, and room-instance-mismatched records closed', async () => {
    const store = await openStore();
    const expiredHash = hashInviteInstallCode('BBBBBBB', secret);
    const reusedHash = hashInviteInstallCode('CCCCCCC', secret);
    store.createInviteCode({
      codeLookupHash: expiredHash,
      expiresAt: timestamp + 1,
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceA
    });
    store.createInviteCode({
      codeLookupHash: reusedHash,
      expiresAt: timestamp + 60_000,
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceB
    });
    expect(store.consumeInviteCode(reusedHash)?.roomInstanceId).toBe(roomInstanceB);
    expect(store.consumeInviteCode(reusedHash)).toBeNull();
    timestamp += 2;
    expect(store.consumeInviteCode(expiredHash)).toBeNull();
    expect(() => store.consumeInviteCode('not-a-hash')).toThrow(/hash/i);
    expect(() =>
      store.createInviteCode({
        codeLookupHash: '0'.repeat(64),
        expiresAt: timestamp + 100,
        roomCode: 'ABCDE',
        roomInstanceId: 'not-an-instance'
      })
    ).toThrow(/instance/i);
  });

  it('bounds active rows per room instance and prunes expired or old redeemed rows', async () => {
    const store = await openStore();
    for (const [index, code] of ['DDDDDDD', 'EEEEEEE'].entries()) {
      expect(
        store.createInviteCode({
          codeLookupHash: hashInviteInstallCode(code, secret),
          expiresAt: timestamp + 60_000,
          maxActive: 2,
          roomCode: 'ABCDE',
          roomInstanceId: roomInstanceA
        }).status
      ).toBe('created');
      expect(index).toBeLessThan(2);
    }
    expect(
      store.createInviteCode({
        codeLookupHash: hashInviteInstallCode('FFFFFFF', secret),
        expiresAt: timestamp + 60_000,
        maxActive: 2,
        roomCode: 'ABCDE',
        roomInstanceId: roomInstanceA
      })
    ).toEqual({ status: 'limit' });
    const firstHash = hashInviteInstallCode('DDDDDDD', secret);
    expect(store.consumeInviteCode(firstHash)).not.toBeNull();
    timestamp += 24 * 60 * 60 * 1000 + 1;
    expect(store.pruneInviteCodes()).toBeGreaterThanOrEqual(2);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM invite_codes').get()?.count).toBe(0);
    expect(() => store.pruneInviteCodes({ redeemedRetentionMs: -1 })).toThrow(/retention/i);
  });

  it('retries unique collisions, sanitizes exhaustion, and surfaces the active-code limit', () => {
    const results: Array<'collision' | 'created'> = ['collision', 'created'];
    const createInviteCode = vi.fn(() => {
      const status = results.shift() || 'collision';
      return status === 'created' ? { status, expiresAt: timestamp + 60_000 } : { status };
    });
    const created = createPersistentInviteInstallCode({
      store: { createInviteCode },
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceA,
      expiresAt: timestamp + 60_000,
      secret,
      randomInt: () => 0,
      maxAttempts: 2
    });
    expect(created.code).toBe('AAAAAAA');
    expect(createInviteCode).toHaveBeenCalledTimes(2);
    expect(() =>
      createPersistentInviteInstallCode({
        store: { createInviteCode: () => ({ status: 'collision' }) },
        roomCode: 'ABCDE',
        roomInstanceId: roomInstanceA,
        expiresAt: timestamp + 60_000,
        secret,
        randomInt: () => 0,
        maxAttempts: 1
      })
    ).toThrow(PublicApiError);
    expect(() =>
      createPersistentInviteInstallCode({
        store: { createInviteCode: () => ({ status: 'limit' }) },
        roomCode: 'ABCDE',
        roomInstanceId: roomInstanceA,
        expiresAt: timestamp + 60_000,
        secret,
        randomInt: () => 0
      })
    ).toThrow(/too many active/i);
  });

  it('serializes two OS-process initializers on the rollback-compatible physical extension', async () => {
    const original = await openStore();
    original.close();
    stores.splice(stores.indexOf(original), 1);
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      DROP INDEX idx_invite_codes_room_instance;
      ALTER TABLE invite_codes DROP COLUMN room_instance_id;
      INSERT INTO invite_codes (code_lookup_hash, room_code, created_at, expires_at, redeemed_at)
      VALUES ('${'a'.repeat(64)}', 'ABCDE', ${timestamp}, ${timestamp + 60_000}, NULL);
    `);
    database.close();

    const firstWorker = spawnStoreWorker(databaseFile, timestamp, 'open');
    const secondWorker = spawnStoreWorker(databaseFile, timestamp, 'open');
    firstWorker.release();
    secondWorker.release();
    const [first, second] = await Promise.all([firstWorker.result, secondWorker.result]);
    expect(first).toEqual({ ready: true, schemaVersion: 2 });
    expect(second).toEqual({ ready: true, schemaVersion: 2 });

    const reopened = await openStore();
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM invite_codes").get()?.count).toBe(1);
    expect(reopened.db.prepare("SELECT room_instance_id FROM invite_codes").get()?.room_instance_id).toBeNull();
    const columns = reopened.db.prepare('PRAGMA table_info(invite_codes)').all().map((column: { name: string }) => column.name);
    expect(columns).toContain('room_instance_id');
    expect(reopened.getSchemaVersion()).toBe(2);
  });
});

describe('invite redemption rate limiting', () => {
  it('bounds attempts, coalesces windows, and fails closed when the key map is full', () => {
    let now = 1_000;
    const limiter = createInviteRedemptionRateLimiter({ limit: 2, maxKeys: 1, now: () => now, windowMs: 1_000 });
    expect(limiter.consume('one').allowed).toBe(true);
    expect(limiter.consume('one').allowed).toBe(true);
    expect(limiter.consume('one')).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume('two').allowed).toBe(false);
    expect(limiter.size()).toBe(1);
    now += 1_000;
    expect(limiter.consume('two').allowed).toBe(true);
    expect(limiter.size()).toBe(1);
  });
});

describe('signed room invite tokens', () => {
  it('accepts only signed v2 tokens before expiry and binds them to one room instance', () => {
    let now = 5_000;
    const invite = createRoomInviteToken({
      roomCode: 'ABCDE',
      roomInstanceId: roomInstanceA,
      secret,
      ttlMs: 1_000,
      now: () => now,
      randomBytes: () => Buffer.alloc(16, 7)
    });
    const parsed = parseRoomInviteToken(invite.token, { secret, now: () => now });
    expect(parsed).toEqual({
      room: 'ABCDE',
      roomInstanceId: roomInstanceA,
      expiresAt: 6_000
    });
    expect(inviteMatchesRoom(parsed, { code: 'ABCDE', roomInstanceId: roomInstanceA })).toBe(true);
    expect(inviteMatchesRoom(parsed, { code: 'ABCDE', roomInstanceId: roomInstanceB })).toBe(false);
    expect(parseRoomInviteToken(`${invite.token}x`, { secret, now: () => now })).toBeNull();
    const [payload] = invite.token.split('.');
    expect(parseRoomInviteToken(`${payload}.unsigned`, { secret, now: () => now })).toBeNull();
    now = 6_000;
    expect(parseRoomInviteToken(invite.token, { secret, now: () => now })).toBeNull();
  });

  it('shares one exact lexical bound between URL and JSON redemption', () => {
    expect(isRoomInviteToken('payload.signature')).toBe(true);
    expect(isRoomInviteToken('payload')).toBe(false);
    expect(isRoomInviteToken('payload.signature.extra')).toBe(false);
    expect(isRoomInviteToken('payload.bad+signature')).toBe(false);
    expect(isRoomInviteToken(`a.${'b'.repeat(2046)}`)).toBe(true);
    expect(isRoomInviteToken(`a.${'b'.repeat(2047)}`)).toBe(false);
  });
});

describe('native invite public configuration', () => {
  const productionIdentifier = 'A1B2C3D4E5.com.groundworkrevops.skyjo';

  it('publishes one exact invite-only association with browser fallback excluded first', () => {
    expect(createAppleAppSiteAssociation(productionIdentifier)).toEqual({
      applinks: {
        details: [{
          appIDs: [productionIdentifier],
          components: [
            {
              '/': '/invite/*',
              '?': { open: 'browser' },
              exclude: true
            },
            { '/': '/invite/*' }
          ]
        }]
      }
    });
    expect(() => createAppleAppSiteAssociation('com.groundworkrevops.skyjo')).toThrow(/identifier/i);
    expect(JSON.stringify(createAppleAppSiteAssociation(productionIdentifier))).not.toMatch(/webcredentials|"\/":"\/\*"/);
  });

  it('fails production-like configuration closed and confines the fixed synthetic ID to tests and canaries', () => {
    expect(resolveAppleApplicationIdentifier({ value: productionIdentifier, nodeEnv: 'production' }))
      .toBe(productionIdentifier);
    expect(resolveAppleApplicationIdentifier({ nodeEnv: 'test' }))
      .toBe(SYNTHETIC_APPLE_APPLICATION_IDENTIFIER);
    expect(resolveAppleApplicationIdentifier({ nodeEnv: 'production', canaryReleaseDirectory: '/isolated/canary' }))
      .toBe(SYNTHETIC_APPLE_APPLICATION_IDENTIFIER);
    expect(() => resolveAppleApplicationIdentifier({ nodeEnv: 'production' })).toThrow(/required/i);
    expect(() => resolveAppleApplicationIdentifier({ nodeEnv: 'staging' })).toThrow(/required/i);
    expect(() => resolveAppleApplicationIdentifier({})).toThrow(/required/i);
    expect(() => resolveAppleApplicationIdentifier({ value: 'bad', nodeEnv: 'test' })).toThrow(/invalid/i);
    expect(() => resolveAppleApplicationIdentifier({
      value: SYNTHETIC_APPLE_APPLICATION_IDENTIFIER,
      nodeEnv: 'production'
    })).toThrow(/synthetic/i);
  });

  it('publishes stable sanitized native redemption error codes', () => {
    expect(publicApiErrorResponse(new PublicApiError('INVITE_INVALID_OR_EXPIRED'))).toEqual({
      status: 410,
      code: 'INVITE_INVALID_OR_EXPIRED',
      message: 'This invite is invalid or has expired.'
    });
    expect(publicApiErrorResponse(new PublicApiError('INVITE_ROOM_UNAVAILABLE'))).toEqual({
      status: 410,
      code: 'INVITE_ROOM_UNAVAILABLE',
      message: 'That room is no longer available. Ask the host for a new invite.'
    });
    expect(publicApiErrorResponse(new PublicApiError('INVITE_RATE_LIMITED'))).toEqual({
      status: 429,
      code: 'INVITE_RATE_LIMITED',
      message: 'Too many invite attempts. Try again later.'
    });
  });
});
