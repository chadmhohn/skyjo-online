import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore, resolveAccountDatabasePath } from '../../../server-account-store.mjs';

function completedState() {
  return {
    players: [
      { id: 'player-1', kind: 'human', name: 'Ada', grid: [], totalScore: 23, roundScore: 9 },
      { id: 'player-2', kind: 'human', name: 'Grace', grid: [], totalScore: 31, roundScore: 12 }
    ],
    drawPile: [],
    discardPile: [],
    currentPlayerIndex: 0,
    phase: 'game-over',
    selectedSource: null,
    drawnCard: null,
    round: 2,
    log: ['Ada wins.'],
    winnerId: 'player-1',
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { 'player-1': 2, 'player-2': 2 },
    roundHistory: [
      {
        round: 1,
        closerId: 'player-2',
        scores: [
          { playerId: 'player-1', name: 'Ada', roundScore: 14, totalScore: 14 },
          { playerId: 'player-2', name: 'Grace', roundScore: 19, totalScore: 19 }
        ]
      },
      {
        round: 2,
        closerId: 'player-1',
        scores: [
          { playerId: 'player-1', name: 'Ada', roundScore: 9, totalScore: 23 },
          { playerId: 'player-2', name: 'Grace', roundScore: 12, totalScore: 31 }
        ]
      }
    ]
  };
}

const fixedNow = Date.parse('2026-07-11T12:00:00Z');

describe('account and stats persistence', () => {
  let tempDir = '';
  let dbFile = '';
  let currentTime = fixedNow;
  let store: Awaited<ReturnType<typeof createAccountStore>> | undefined;

  beforeEach(async () => {
    currentTime = fixedNow;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-account-test-'));
    dbFile = path.join(tempDir, 'skyjo.sqlite');
    store = await createAccountStore({ filePath: dbFile, now: () => currentTime });
  });

  afterEach(async () => {
    store?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves an isolated database beside an absolute rooms file', () => {
    expect(resolveAccountDatabasePath({ SKYJO_DB_FILE: dbFile })).toBe(dbFile);
    expect(resolveAccountDatabasePath({ SKYJO_ROOMS_FILE: path.join(tempDir, 'rooms.json') })).toBe(dbFile);
  });

  it('covers account creation, normalized auth, sessions, password changes, and admin controls', async () => {
    const admin = await store!.bootstrapAdmin({ email: 'admin@example.com', password: 'admin-secret-123' });
    expect(admin.role).toBe('admin');
    expect((await store!.bootstrapAdmin({ email: 'admin@example.com', password: 'ignored-secret-123' })).id).toBe(admin.id);

    const ada = await store!.createUser({ email: 'Ada@Example.com', displayName: '  Ada   Lovelace  ', password: 'ada-secret-123' });
    const grace = await store!.createUser({ email: 'grace@example.com', displayName: 'Grace', password: 'grace-secret-123' });
    expect(ada).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      role: 'player',
      createdAt: fixedNow,
      updatedAt: fixedNow
    });
    expect((await store!.authenticate('ADA@example.com', 'ada-secret-123')).id).toBe(ada.id);
    expect(await store!.authenticate('ada@example.com', 'wrong-password')).toBeNull();

    const expiringSession = store!.createSession(ada.id, 60_000);
    expect(expiringSession.expiresAt).toBe(fixedNow + 60_000);
    expect(store!.getUserBySessionToken(expiringSession.token).id).toBe(ada.id);
    currentTime += 60_001;
    expect(store!.getUserBySessionToken(expiringSession.token)).toBeNull();

    const revocableSession = store!.createSession(ada.id, 60_000);
    store!.deleteSession(revocableSession.token);
    expect(store!.getUserBySessionToken(revocableSession.token)).toBeNull();

    await store!.changePassword(ada.id, 'ada-secret-123', 'ada-secret-456');
    expect(await store!.authenticate('ada@example.com', 'ada-secret-123')).toBeNull();
    expect((await store!.authenticate('ada@example.com', 'ada-secret-456')).id).toBe(ada.id);

    expect(store!.patchUser(grace.id, { displayName: 'Grace Hopper', role: 'admin', disabled: true })).toMatchObject({
      displayName: 'Grace Hopper',
      role: 'admin',
      disabled: true
    });
    expect(await store!.authenticate('grace@example.com', 'grace-secret-123')).toBeNull();
    await store!.setUserPassword(grace.id, 'reset-secret-123');
    store!.patchUser(grace.id, { disabled: false });
    store!.patchUser(grace.id, { role: 'player' });
    expect((await store!.authenticate('grace@example.com', 'reset-secret-123')).id).toBe(grace.id);
    expect(store!.listUsers()).toHaveLength(3);
  });

  it('stores idempotent completed games and enforces stats visibility', async () => {
    const ada = await store!.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
    const grace = await store!.createUser({ email: 'grace@example.com', displayName: 'Grace', password: 'grace-secret-123' });
    const outsider = await store!.createUser({ email: 'outsider@example.com', displayName: 'Outsider', password: 'outsider-secret-123' });
    const input = {
      mode: 'multi',
      state: completedState(),
      roomCode: 'ABCDE',
      createdByUserId: ada.id,
      playerAccounts: { 'player-1': ada.id, 'player-2': grace.id },
      sourceKey: 'multi:abcde'
    };

    const game = store!.recordCompletedGame(input);
    const duplicate = store!.recordCompletedGame(input);
    expect(duplicate.id).toBe(game.id);
    expect(store!.getCompletedGameJournalBySourceKey(input.sourceKey)).toEqual({
      id: game.id,
      sourceKey: input.sourceKey,
      roomCode: input.roomCode,
      completedAt: fixedNow,
      finishedByAi: false,
      state: input.state
    });
    expect(store!.getCompletedGameJournalBySourceKey('multi:missing')).toBeNull();
    expect(store!.listVisibleGames(ada)).toHaveLength(1);
    expect(store!.getVisibleGame(ada, game.id)?.rounds).toHaveLength(4);
    expect(store!.getVisibleGame(ada, game.id)?.finishedByAi).toBe(false);
    expect(store!.getVisibleGame(outsider, game.id)).toBeNull();

    const summary = store!.getStatsSummary(ada);
    expect(summary.self).toMatchObject({ gamesPlayed: 1, wins: 1, multiplayerGames: 1 });
    expect(summary.coPlayers[0].userId).toBe(grace.id);
    expect(store!.getVisiblePlayerStats(ada, grace.id)?.user.id).toBe(grace.id);
    expect(store!.getVisiblePlayerStats(outsider, grace.id)).toBeNull();
  });

  it('preserves client completion time for solo games, clamps future values, and keeps the first idempotent timestamp', async () => {
    const ada = await store!.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
    const state = completedState();
    const playerAccounts = { 'player-1': ada.id };
    const past = fixedNow - 60_000;
    const first = store!.recordCompletedGame({
      mode: 'single',
      state,
      createdByUserId: ada.id,
      playerAccounts,
      sourceKey: 'single:ada:stable',
      completedAt: past
    });
    currentTime += 10_000;
    const duplicate = store!.recordCompletedGame({
      mode: 'single',
      state,
      createdByUserId: ada.id,
      playerAccounts,
      sourceKey: 'single:ada:stable',
      completedAt: fixedNow - 120_000
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.completedAt).toBe(past);

    const future = store!.recordCompletedGame({
      mode: 'single',
      state,
      createdByUserId: ada.id,
      playerAccounts,
      sourceKey: 'single:ada:future',
      completedAt: currentTime + 60_000
    });
    expect(future.completedAt).toBe(currentTime);

    const multiplayer = store!.recordCompletedGame({
      mode: 'multi',
      state,
      createdByUserId: ada.id,
      playerAccounts,
      sourceKey: 'multi:ignores-client-time',
      completedAt: past
    });
    expect(multiplayer.completedAt).toBe(currentTime);
  });

  it('orders games with equal completion times by stable insertion order', async () => {
    const ada = await store!.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
    const input = {
      mode: 'single',
      state: completedState(),
      createdByUserId: ada.id,
      playerAccounts: { 'player-1': ada.id },
      completedAt: fixedNow
    };
    const first = store!.recordCompletedGame({ ...input, sourceKey: 'single:ada:first' });
    const second = store!.recordCompletedGame({ ...input, sourceKey: 'single:ada:second' });
    expect(store!.listVisibleGames(ada).map((game: { id: string }) => game.id)).toEqual([second.id, first.id]);
  });

  it('deletes private account data transactionally and anonymizes retained multiplayer history', async () => {
    const ada = await store!.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
    const grace = await store!.createUser({ email: 'grace@example.com', displayName: 'Grace', password: 'grace-secret-123' });
    const session = store!.createSession(ada.id, 60_000);
    store!.savePushSubscription(
      ada.id,
      { endpoint: 'https://push.example.test/ada', keys: { p256dh: 'key', auth: 'auth' } },
      'test'
    );
    store!.db.prepare(
      `INSERT INTO apns_devices (
        installation_id, user_id, environment, token_ciphertext, token_nonce, token_auth_tag,
        token_fingerprint, app_version, locale, created_at, updated_at
      ) VALUES (?, ?, 'production', ?, ?, ?, ?, '0.1.0', 'en-US', ?, ?)`
    ).run(
      '10000000-0000-4000-8000-000000000192',
      ada.id,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(16, 3),
      Buffer.alloc(32, 4),
      fixedNow,
      fixedNow
    );

    const multiplayer = store!.recordCompletedGame({
      mode: 'multi',
      state: completedState(),
      roomCode: 'ABCDE',
      createdByUserId: ada.id,
      playerAccounts: { 'player-1': ada.id, 'player-2': grace.id },
      sourceKey: 'multi:account-deletion'
    });
    const solo = store!.recordCompletedGame({
      mode: 'single',
      state: completedState(),
      createdByUserId: ada.id,
      playerAccounts: { 'player-1': ada.id },
      sourceKey: `single:${ada.id}:account-deletion`,
      completedAt: fixedNow
    });

    await expect(store!.authorizeAccountDeletion(ada.id, 'wrong-password')).rejects.toMatchObject({
      code: 'CURRENT_PASSWORD_MISMATCH'
    });
    expect(store!.getUserRowById(ada.id)).not.toBeNull();

    const staleAuthorization = await store!.authorizeAccountDeletion(ada.id, 'ada-secret-123');
    await store!.setUserPassword(ada.id, 'ada-secret-456');
    expect(() => store!.deleteAccount(staleAuthorization)).toThrow(expect.objectContaining({ code: 'ACCOUNT_DELETION_STALE' }));

    const authorization = await store!.authorizeAccountDeletion(ada.id, 'ada-secret-456');
    expect(store!.deleteAccount(authorization)).toEqual({ deletedSoloGames: 1, anonymizedMultiplayerGames: 1 });

    expect(store!.getUserRowById(ada.id)).toBeUndefined();
    expect(store!.getUserBySessionToken(session.token)).toBeNull();
    expect(store!.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(ada.id).count).toBe(0);
    expect(store!.db.prepare('SELECT COUNT(*) AS count FROM apns_devices WHERE user_id = ?').get(ada.id).count).toBe(0);
    expect(store!.getGame(solo.id)).toBeNull();

    const retained = store!.getVisibleGame(grace, multiplayer.id)!;
    expect(retained.roomCode).toBeNull();
    expect(retained.winnerUserId).toBeNull();
    expect(retained.winnerName).toBe('Deleted player');
    expect(retained.participants.find((participant: { playerId: string }) => participant.playerId === 'player-1')).toMatchObject({
      userId: null,
      displayName: 'Deleted player'
    });
    expect(retained.rounds.filter((score: { playerId: string }) => score.playerId === 'player-1'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ userId: null, displayName: 'Deleted player' })]));
    const journalRow = store!.db.prepare('SELECT source_key, final_state_json FROM games WHERE id = ?').get(multiplayer.id);
    expect(journalRow.source_key).toBeNull();
    const journalState = JSON.parse(journalRow.final_state_json);
    expect(journalState.players[0].name).toBe('Deleted player');
    expect(journalState.log).toEqual([]);
  });

  it('keeps at least one active administrator and never bootstraps a deleted admin again', async () => {
    const admin = await store!.bootstrapAdmin({ email: 'admin@example.com', password: 'admin-secret-123' });
    await expect(store!.authorizeAccountDeletion(admin.id, 'admin-secret-123')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(store!.getUserRowById(admin.id)).not.toBeNull();

    await store!.createUser({
      email: 'surviving-admin@example.com',
      displayName: 'Surviving Admin',
      password: 'surviving-admin-secret',
      role: 'admin'
    });
    const authorization = await store!.authorizeAccountDeletion(admin.id, 'admin-secret-123');
    store!.deleteAccount(authorization);
    expect(await store!.bootstrapAdmin({
      email: 'admin@example.com',
      password: 'admin-secret-123'
    })).toBeNull();

    store!.close();
    store = await createAccountStore({ filePath: dbFile, now: () => currentTime });
    expect(await store!.bootstrapAdmin({
      email: 'admin@example.com',
      password: 'admin-secret-123'
    })).toBeNull();
    expect(store!.getUserRowByEmail('surviving-admin@example.com')?.role).toBe('admin');
  });
});
