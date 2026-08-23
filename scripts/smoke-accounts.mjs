import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../server-account-store.mjs';

function completedState() {
  return {
    players: [
      {
        id: 'player-1',
        kind: 'human',
        name: 'Ada',
        grid: [],
        totalScore: 23,
        roundScore: 9
      },
      {
        id: 'player-2',
        kind: 'human',
        name: 'Grace',
        grid: [],
        totalScore: 31,
        roundScore: 12
      }
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-accounts-'));
const dbFile = path.join(tempDir, 'skyjo.sqlite');
const store = await createAccountStore({ filePath: dbFile });

try {
  const admin = await store.bootstrapAdmin({ email: 'chad.hohn@groundworkrevops.com', password: 'admin-secret-123' });
  assert.equal(admin.role, 'admin');
  const bootstrappedAgain = await store.bootstrapAdmin({ email: 'chad.hohn@groundworkrevops.com', password: 'admin-secret-123' });
  assert.equal(bootstrappedAgain.id, admin.id, 'admin bootstrap is idempotent');

  const ada = await store.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
  const grace = await store.createUser({ email: 'grace@example.com', displayName: 'Grace', password: 'grace-secret-123' });
  assert.equal((await store.authenticate('ADA@example.com', 'ada-secret-123')).id, ada.id, 'email login is normalized');
  assert.equal(await store.authenticate('ada@example.com', 'wrong-password'), null, 'bad passwords are rejected');

  const session = store.createSession(ada.id, 1000 * 60);
  assert.equal(store.getUserBySessionToken(session.token).id, ada.id, 'session token resolves to a user');
  store.deleteSession(session.token);
  assert.equal(store.getUserBySessionToken(session.token), null, 'deleted sessions stop resolving');

  await store.changePassword(ada.id, 'ada-secret-123', 'ada-secret-456');
  assert.equal(await store.authenticate('ada@example.com', 'ada-secret-123'), null, 'old password no longer works');
  assert.equal((await store.authenticate('ada@example.com', 'ada-secret-456')).id, ada.id, 'new password works');

  const multiplayer = store.recordCompletedGame({
    mode: 'multi',
    state: completedState(),
    roomCode: 'ABCDE',
    createdByUserId: ada.id,
    playerAccounts: { 'player-1': ada.id, 'player-2': grace.id },
    sourceKey: 'multi:abcde'
  });
  const duplicate = store.recordCompletedGame({
    mode: 'multi',
    state: completedState(),
    roomCode: 'ABCDE',
    createdByUserId: ada.id,
    playerAccounts: { 'player-1': ada.id, 'player-2': grace.id },
    sourceKey: 'multi:abcde'
  });
  assert.equal(store.listVisibleGames(ada).length, 1, 'source keys prevent duplicate game history');
  assert.equal(duplicate.rounds.length, 4, 'round scores are stored for each player and round');

  const adaSummary = store.getStatsSummary(ada);
  assert.equal(adaSummary.self.gamesPlayed, 1);
  assert.equal(adaSummary.self.wins, 1);
  assert.equal(adaSummary.coPlayers[0].userId, grace.id);
  assert.equal(store.getVisiblePlayerStats(ada, grace.id).user.id, grace.id, 'co-player stats are visible');

  const outsider = await store.createUser({ email: 'outsider@example.com', displayName: 'Outsider', password: 'outsider-secret-123' });
  assert.equal(store.getVisiblePlayerStats(outsider, grace.id), null, 'unrelated player stats are hidden');

  store.patchUser(grace.id, { disabled: true });
  assert.equal(await store.authenticate('grace@example.com', 'grace-secret-123'), null, 'disabled users cannot log in');
  await store.setUserPassword(grace.id, 'reset-secret-123');
  store.patchUser(grace.id, { disabled: false });
  assert.equal((await store.authenticate('grace@example.com', 'reset-secret-123')).id, grace.id, 'admin-set password works');

  await assert.rejects(
    store.authorizeAccountDeletion(ada.id, 'wrong-password'),
    (error) => error?.code === 'CURRENT_PASSWORD_MISMATCH'
  );
  const deletion = await store.authorizeAccountDeletion(ada.id, 'ada-secret-456');
  assert.deepEqual(store.deleteAccount(deletion), { deletedSoloGames: 0, anonymizedMultiplayerGames: 1 });
  assert.equal(await store.authenticate('ada@example.com', 'ada-secret-456'), null, 'deleted account cannot authenticate');
  const retained = store.getVisibleGame(grace, multiplayer.id);
  assert.equal(retained.roomCode, null, 'retained multiplayer history drops the private room code');
  assert.equal(retained.participants[0].displayName, 'Deleted player', 'retained history is anonymized');
  assert.equal(store.listUsers().length, 3);
  console.log('accounts smoke passed: auth, sessions, history, stats visibility, and verified account deletion');
} finally {
  store.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
