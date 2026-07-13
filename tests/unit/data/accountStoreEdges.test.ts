import path from 'node:path';
import {
  createAccountStore,
  resolveAccountDatabasePath
} from '../../../server-account-store.mjs';

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
