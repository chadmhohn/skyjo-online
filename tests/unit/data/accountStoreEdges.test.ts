import path from 'node:path';
import {
  APNS_DEVICE_RETENTION_MS,
  createAccountStore,
  resolveAccountDatabasePath
} from '../../../server-account-store.mjs';
import { createAPNSTokenCodec } from '../../../server-apns.mjs';

const fixedNow = Date.parse('2026-07-11T12:00:00.000Z');

function completedState(players: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    players,
    phase: 'game-over',
    round: 0,
    roundHistory: [],
    winnerId: null,
    ...overrides
  };
}

describe('account store defensive and fallback behavior', () => {
  let store: Awaited<ReturnType<typeof createAccountStore>>;

  beforeEach(async () => {
    store = await createAccountStore({ filePath: ':memory:', now: () => fixedNow });
  });

  afterEach(() => {
    store.close();
  });

  it('validates account inputs, bootstrap promotion, uniqueness, and last-admin safety', async () => {
    expect(await store.bootstrapAdmin({ email: '', password: '' })).toBeNull();
    expect(await store.bootstrapAdmin({ email: 'nobody@example.com', password: '' })).toBeNull();
    await expect(store.createUser({ email: '', displayName: '', password: 'password-123' })).rejects.toThrow(/valid email/i);
    await expect(
      store.createUser({ email: `${'a'.repeat(255)}@example.com`, displayName: '', password: 'password-123' })
    ).rejects.toThrow(/valid email/i);
    await expect(store.createUser({ email: 'invalid', displayName: '', password: 'password-123' })).rejects.toThrow(/valid email/i);
    await expect(
      store.createUser({ email: 'role@example.com', displayName: '', password: 'password-123', role: 'owner' })
    ).rejects.toThrow(/role/i);
    await expect(store.createUser({ email: 'short@example.com', displayName: '', password: 'short' })).rejects.toThrow(/8 characters/i);

    const admin = await store.bootstrapAdmin({ email: 'admin@example.com', password: 'admin-password' });
    expect((await store.bootstrapAdmin({ email: 'ADMIN@example.com', password: 'ignored-password' })).id).toBe(admin.id);
    expect(() => store.patchUser(admin.id, { role: 'player' })).toThrow(/one active admin/i);
    expect(() => store.patchUser(admin.id, { disabled: true })).toThrow(/one active admin/i);

    const player = await store.createUser({
      email: 'player@example.com',
      displayName: '',
      password: 'player-password'
    });
    expect(player.displayName).toBe('player');
    await expect(
      store.createUser({ email: 'PLAYER@example.com', displayName: 'Duplicate', password: 'player-password' })
    ).rejects.toThrow(/already exists/i);
    store.patchUser(player.id, { displayName: '   ' });
    expect(store.getUserRowById(player.id).display_name).toBe('Player');

    const secondAdmin = await store.createUser({
      email: 'second-admin@example.com',
      displayName: 'Second Admin',
      password: 'second-admin-password',
      role: 'admin'
    });
    expect(store.patchUser(admin.id, { role: 'player' }).role).toBe('player');
    await store.createUser({
      email: 'third-admin@example.com',
      displayName: 'Third Admin',
      password: 'third-admin-password',
      role: 'admin'
    });
    expect(store.patchUser(secondAdmin.id, { disabled: true }).disabled).toBe(true);
    const repaired = await store.bootstrapAdmin({ email: 'second-admin@example.com', password: '' });
    expect(repaired).toMatchObject({ role: 'admin', disabled: false });

    const promoted = await store.bootstrapAdmin({ email: 'player@example.com', password: '' });
    expect(promoted).toMatchObject({ role: 'admin', disabled: false });
    expect(() => store.patchUser('missing-user', {})).toThrow(/not found/i);
    expect(() => store.patchUser(player.id, { role: 'owner' })).toThrow(/role/i);
  });

  it('normalizes account display names to a well-formed UTF-16 prefix', async () => {
    const astral = '🃏'.repeat(30);
    const malformed = String.fromCharCode(0xd800);
    const user = await store.createUser({
      email: 'unicode@example.com',
      displayName: astral,
      password: 'unicode-password'
    });
    expect(user.displayName).toBe('🃏'.repeat(12));
    expect(user.displayName).toHaveLength(24);

    expect(store.patchUser(user.id, { displayName: `A${malformed}B` }).displayName).toBe('A�B');
  });

  it('handles missing and disabled sessions plus password failure paths', async () => {
    const user = await store.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-password' });
    expect(store.createSession('missing-user', 1000)).toBeNull();
    store.patchUser(user.id, { disabled: true });
    expect(store.createSession(user.id, 1000)).toBeNull();
    await expect(store.changePassword(user.id, 'ada-password', 'next-password')).rejects.toThrow(/not found/i);
    store.patchUser(user.id, { disabled: false });
    await expect(store.changePassword(user.id, 'wrong-password', 'next-password')).rejects.toThrow(/did not match/i);
    await expect(store.changePassword('missing-user', 'wrong-password', 'next-password')).rejects.toThrow(/not found/i);
    await expect(store.setUserPassword('missing-user', 'next-password')).rejects.toThrow(/not found/i);
    await expect(store.setUserPassword(user.id, 'short')).rejects.toThrow(/8 characters/i);

    const session = store.createSession(user.id, 1000);
    expect(store.getUserBySessionToken('')).toBeNull();
    expect(store.getUserBySessionToken(session.token)?.id).toBe(user.id);
    store.deleteSession('');
    store.deleteSession(session.token);
    expect(store.getUserBySessionToken(session.token)).toBeNull();

    expect(store.getSchemaVersion()).toBe(2);
    await expect(store.open()).resolves.toBe(store);
    store.close();
    expect(store.getSchemaVersion()).toBe(0);
    expect(store.checkReadiness()).toBe(false);
    await store.open();
    expect(store.checkReadiness()).toBe(true);
  });

  it('validates, upserts, lists, repairs, and deletes push subscriptions', async () => {
    const user = await store.createUser({ email: 'push@example.com', displayName: 'Push', password: 'push-password' });
    expect(() => store.savePushSubscription('missing', null)).toThrow(/not found/i);
    store.patchUser(user.id, { disabled: true });
    expect(() => store.savePushSubscription(user.id, null)).toThrow(/not found/i);
    store.patchUser(user.id, { disabled: false });
    expect(() => store.savePushSubscription(user.id, null)).toThrow(/invalid/i);
    expect(() => store.savePushSubscription(user.id, { endpoint: 3 })).toThrow(/invalid/i);
    expect(() => store.savePushSubscription(user.id, { endpoint: 'http://push.example' })).toThrow(/invalid/i);
    expect(() => store.savePushSubscription(user.id, { endpoint: 'https://push.example' })).toThrow(/missing keys/i);
    expect(() =>
      store.savePushSubscription(user.id, { endpoint: 'https://push.example', keys: { auth: 'auth' } })
    ).toThrow(/missing keys/i);
    expect(() =>
      store.savePushSubscription(user.id, { endpoint: 'https://push.example', keys: { p256dh: 'key' } })
    ).toThrow(/missing keys/i);

    const subscription = {
      endpoint: 'https://push.example/subscription',
      keys: { p256dh: 'public-key', auth: 'auth-key' }
    };
    store.savePushSubscription(user.id, subscription, 42);
    store.savePushSubscription(user.id, { ...subscription, keys: { p256dh: 'updated', auth: 'updated' } }, 'a'.repeat(300));
    expect(store.listPushSubscriptionsForUsers([])).toEqual([]);
    expect(store.listPushSubscriptionsForUsers([null, user.id, user.id])).toEqual([
      {
        endpoint: subscription.endpoint,
        userId: user.id,
        subscription: { ...subscription, keys: { p256dh: 'updated', auth: 'updated' } }
      }
    ]);

    store.db.prepare("UPDATE push_subscriptions SET subscription_json = '{' WHERE endpoint = ?").run(subscription.endpoint);
    expect(store.listPushSubscriptionsForUsers([user.id])).toEqual([]);
    expect(store.listPushSubscriptionsForUsers([user.id])).toEqual([]);
    store.deletePushSubscriptionForUser(user.id, '');
    store.deletePushSubscription('');
    store.savePushSubscription(user.id, subscription);
    store.deletePushSubscriptionForUser('missing-user', subscription.endpoint);
    expect(store.listPushSubscriptionsForUsers([user.id])).toHaveLength(1);
    store.deletePushSubscription(subscription.endpoint);
    expect(store.listPushSubscriptionsForUsers([user.id])).toEqual([]);
  });

  it('encrypts, rotates, reassigns, caps, prunes, and conditionally retires APNs devices', async () => {
    let timestamp = fixedNow;
    const apnsStore = await createAccountStore({ filePath: ':memory:', now: () => timestamp });
    const codec = createAPNSTokenCodec(Buffer.alloc(32, 7), { randomBytes: () => Buffer.alloc(12, 3) });
    const firstUser = await apnsStore.createUser({
      email: 'apns-first@example.com',
      displayName: 'APNs First',
      password: 'apns-first-password'
    });
    const secondUser = await apnsStore.createUser({
      email: 'apns-second@example.com',
      displayName: 'APNs Second',
      password: 'apns-second-password'
    });
    const firstInstallation = '10000000-0000-4000-8000-000000000001';
    const secondInstallation = '10000000-0000-4000-8000-000000000002';
    const tokenOne = '01'.repeat(32);
    const tokenTwo = '02'.repeat(48);
    const save = (userId: string, installationId: string, token: string, maxActive = 8) => apnsStore.saveAPNSDevice({
      userId,
      installationId,
      environment: 'development',
      ...codec.encrypt(token),
      appVersion: '0.1.0',
      locale: 'en-US',
      maxActive
    });

    try {
      expect(() => save('missing-user', firstInstallation, tokenOne)).toThrow(/not found/i);
      expect(() => apnsStore.pruneAPNSDevices({ retentionMs: 0 })).toThrow(/retention/i);
      expect(apnsStore.listAPNSDevicesForUsers([])).toEqual([]);
      expect(apnsStore.deleteAPNSDeviceForUser('', '')).toBe(0);

      save(firstUser.id, firstInstallation, tokenOne);
      const stored = apnsStore.db.prepare(`
        SELECT typeof(token_ciphertext) AS ciphertext_type, token_ciphertext, created_at
        FROM apns_devices WHERE installation_id = ?
      `).get(firstInstallation);
      expect(stored.ciphertext_type).toBe('blob');
      expect(Buffer.from(stored.token_ciphertext).includes(Buffer.from(tokenOne, 'utf8'))).toBe(false);
      const firstRead = apnsStore.listAPNSDevicesForUsers([firstUser.id])[0];
      expect(codec.decrypt(firstRead)).toBe(tokenOne);

      timestamp += 1;
      save(firstUser.id, firstInstallation, tokenTwo);
      const rotated = apnsStore.listAPNSDevicesForUsers([firstUser.id])[0];
      expect(codec.decrypt(rotated)).toBe(tokenTwo);
      expect(apnsStore.db.prepare('SELECT created_at FROM apns_devices WHERE installation_id = ?').get(firstInstallation).created_at)
        .toBe(stored.created_at);
      expect(apnsStore.deleteAPNSDeviceIfCurrent(firstRead)).toBe(0);

      timestamp += 1;
      save(secondUser.id, secondInstallation, tokenTwo, 1);
      expect(apnsStore.listAPNSDevicesForUsers([firstUser.id])).toEqual([]);
      const reassigned = apnsStore.listAPNSDevicesForUsers([secondUser.id])[0];
      expect(reassigned.installationId).toBe(secondInstallation);
      timestamp += 1;
      save(secondUser.id, firstInstallation, tokenTwo, 1);
      const movedWithinCap = apnsStore.listAPNSDevicesForUsers([secondUser.id])[0];
      expect(movedWithinCap.installationId).toBe(firstInstallation);
      expect(() => save(secondUser.id, secondInstallation, tokenOne, 1)).toThrow(/too many/i);
      expect(apnsStore.deleteAPNSDeviceIfCurrent(movedWithinCap)).toBe(1);

      save(secondUser.id, secondInstallation, tokenTwo);
      const session = apnsStore.createSession(secondUser.id, 60_000);
      apnsStore.deleteSessionAndAPNSDevice(session.token, secondInstallation);
      expect(apnsStore.getUserBySessionToken(session.token)).toBeNull();
      expect(apnsStore.listAPNSDevicesForUsers([secondUser.id])).toEqual([]);
      apnsStore.deleteSessionAndAPNSDevice('', secondInstallation);

      save(firstUser.id, firstInstallation, tokenOne);
      timestamp += APNS_DEVICE_RETENTION_MS + 1;
      expect(apnsStore.pruneAPNSDevices()).toBe(1);
      expect(apnsStore.listAPNSDevicesForUsers([firstUser.id])).toEqual([]);

      timestamp += 1;
      save(firstUser.id, firstInstallation, tokenOne);
      apnsStore.patchUser(firstUser.id, { disabled: true });
      expect(apnsStore.listAPNSDevicesForUsers([firstUser.id])).toEqual([]);
      expect(() => save(firstUser.id, firstInstallation, tokenOne)).toThrow(/not found/i);

      const cascadeUser = await apnsStore.createUser({
        email: 'apns-cascade@example.com',
        displayName: 'APNs Cascade',
        password: 'apns-cascade-password'
      });
      save(cascadeUser.id, firstInstallation, tokenOne);
      apnsStore.db.prepare('DELETE FROM users WHERE id = ?').run(cascadeUser.id);
      expect(apnsStore.db.prepare('SELECT COUNT(*) AS count FROM apns_devices').get().count).toBe(0);
    } finally {
      apnsStore.close();
    }
  });

  it('records fallback game shapes, rolls back invalid participants, and exposes empty admin stats', async () => {
    const admin = await store.createUser({
      email: 'stats-admin@example.com',
      displayName: 'Stats Admin',
      password: 'stats-admin-password',
      role: 'admin'
    });
    await expect(() => store.recordCompletedGame({ mode: 'single', state: null })).toThrow(/completed games/i);
    expect(() => store.recordCompletedGame({ mode: 'single', state: { players: {}, phase: 'game-over' } })).toThrow(/completed games/i);
    expect(() => store.recordCompletedGame({ mode: 'single', state: { players: [], phase: 'playing' } })).toThrow(/completed games/i);

    const emptyGame = store.recordCompletedGame({
      mode: 'single',
      state: completedState([], { roundHistory: [{ round: 0, scores: null }] }),
      finishedByAi: true
    });
    expect(emptyGame).toMatchObject({
      roomCode: null,
      winnerPlayerId: null,
      winnerUserId: null,
      createdByUserId: null,
      winnerName: 'Unknown',
      finishedByAi: true,
      participants: [],
      rounds: []
    });

    const fallbackGame = store.recordCompletedGame({
      mode: 'single',
      state: completedState([{ id: 'solo', name: 'Solo', totalScore: 0, roundScore: 0 }]),
      createdByUserId: admin.id
    });
    expect(fallbackGame).toMatchObject({ winnerPlayerId: 'solo', winnerName: 'Solo' });
    expect(fallbackGame.participants[0]).toMatchObject({ userId: null, kind: 'human', roundScore: 0, totalScore: 0 });
    expect(fallbackGame.rounds[0]).toMatchObject({ userId: null, round: 1, roundScore: 0, totalScore: 0 });

    expect(() =>
      store.recordCompletedGame({
        mode: 'single',
        state: completedState([{ id: 'bad', name: 'Bad', kind: 'robot', totalScore: 1, roundScore: 1 }])
      })
    ).toThrow();
    expect(store.getGame('missing-game')).toBeNull();
    expect(store.getVisibleGame(admin, 'missing-game')).toBeNull();
    expect(store.canViewUserStats(admin, 'any-user')).toBe(true);
    expect(store.canViewUserStats(admin, admin.id)).toBe(true);
    expect(store.listVisibleGames(admin)).toHaveLength(2);
    expect(store.getStatsSummary(admin).admin).toMatchObject({ users: 1, games: 2 });
  });

  it('rejects poison solo completion timestamps while leaving multiplayer time server-authoritative', () => {
    const state = completedState([{ id: 'solo', name: 'Solo', kind: 'human', totalScore: 0, roundScore: 0 }]);
    for (const completedAt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.recordCompletedGame({ mode: 'single', state, completedAt })).toThrow(/completion time is invalid/i);
    }
    expect(store.recordCompletedGame({ mode: 'multi', state, completedAt: Number.NaN }).completedAt).toBe(fixedNow);
  });

  it('resolves the local fallback database path for relative room state', () => {
    expect(resolveAccountDatabasePath({ SKYJO_ROOMS_FILE: path.join('relative', 'rooms.json') })).toBe(
      path.resolve('.data', 'skyjo.sqlite')
    );
    expect(resolveAccountDatabasePath({})).toBe(path.resolve('.data', 'skyjo.sqlite'));
  });
});
