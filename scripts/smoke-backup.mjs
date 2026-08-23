import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  APNS_DEVICE_STORAGE_ENVELOPE,
  createAccountStore,
  validateOptionalAPNSDeviceStorageEnvelope
} from '../server-account-store.mjs';
import { createAccountDeletionLedger } from '../server-account-deletion-ledger.mjs';
import { loadRoomsSnapshotFromDisk, saveRoomsToDisk } from '../server-room-persistence.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';
import { inspectSqliteState } from '../server-state-backup.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupScript = path.join(root, 'scripts', 'backup-state.mjs');
const verifyScript = path.join(root, 'scripts', 'verify-state-backup.mjs');
const restoreScript = path.join(root, 'scripts', 'restore-state.mjs');
const releasePath = path.join(root, 'dist', 'release.json');
const releaseIdentity = await loadReleaseIdentity(path.dirname(releasePath), {
  allowDevelopment: false,
  requireFullSha: true,
  allowedProtocolVersions: [1, 2]
});
const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo backup smoke with spaces '));
const deletionLedgerPath = path.join(tempDirectory, 'external account deletions.json');

function completedState(players) {
  return {
    players,
    phase: 'game-over',
    round: 1,
    winnerId: players[0].id,
    roundHistory: [{
      round: 1,
      closerId: players[0].id,
      scores: players.map((player) => ({
        playerId: player.id,
        name: player.name,
        roundScore: player.roundScore,
        totalScore: player.totalScore
      }))
    }],
    log: [`${players[0].name} finished the game`]
  };
}

try {
  const deletionLedger = await createAccountDeletionLedger({
    filePath: deletionLedgerPath,
    now: () => 10
  });
  const sourceDirectory = path.join(tempDirectory, 'source state');
  const databasePath = path.join(sourceDirectory, 'skyjo.sqlite');
  const roomsPath = path.join(sourceDirectory, 'rooms.json');
  await fs.mkdir(sourceDirectory);
  const store = await createAccountStore({ filePath: databasePath });
  const user = await store.createUser({
    email: 'backup-smoke@example.com',
    displayName: 'Backup Smoke',
    password: 'backup-smoke-password'
  });
  const deletedUser = await store.createUser({
    email: 'deleted-backup-smoke@example.com',
    displayName: 'Deleted Backup Smoke',
    password: 'deleted-backup-password'
  });
  const deletedSession = store.createSession(deletedUser.id, 60_000);
  store.savePushSubscription(
    deletedUser.id,
    { endpoint: 'https://push.example.test/deleted-backup', keys: { p256dh: 'key', auth: 'auth' } },
    'backup smoke'
  );
  store.db.prepare(`
    INSERT INTO apns_devices (
      installation_id, user_id, environment, token_ciphertext, token_nonce,
      token_auth_tag, token_fingerprint, app_version, locale, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '40000000-0000-4000-8000-000000000002',
    deletedUser.id,
    'development',
    Buffer.from('00027fff80fe', 'hex'),
    Buffer.from('000102030405060708090a0b', 'hex'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from('43'.repeat(32), 'hex'),
    '0.1.0 (203)',
    'en-US',
    1,
    2
  );
  const deletedPlayers = [
    { id: 'deleted-player', kind: 'human', name: 'Deleted Backup Smoke', roundScore: 4, totalScore: 4 },
    { id: 'retained-player', kind: 'human', name: 'Backup Smoke', roundScore: 9, totalScore: 9 }
  ];
  const retainedMultiplayer = store.recordCompletedGame({
    mode: 'multi',
    state: completedState(deletedPlayers),
    roomCode: 'DEL01',
    createdByUserId: deletedUser.id,
    playerAccounts: { 'deleted-player': deletedUser.id, 'retained-player': user.id },
    sourceKey: 'multi:backup-account-deletion'
  });
  const deletedSolo = store.recordCompletedGame({
    mode: 'single',
    state: completedState([deletedPlayers[0]]),
    createdByUserId: deletedUser.id,
    playerAccounts: { 'deleted-player': deletedUser.id },
    sourceKey: `single:${deletedUser.id}:backup-account-deletion`
  });
  const deletionAuthorization = await store.authorizeAccountDeletion(
    deletedUser.id,
    'deleted-backup-password'
  );
  assert.deepEqual(store.deleteAccount(deletionAuthorization), {
    deletedSoloGames: 1,
    anonymizedMultiplayerGames: 1
  });
  assert.equal(store.getUserBySessionToken(deletedSession.token), null);
  assert.equal(store.getGame(deletedSolo.id), null);
  assert.equal(
    store.getVisibleGame(user, retainedMultiplayer.id).participants[0].displayName,
    'Deleted player'
  );
  store.close();
  const sourceDatabase = new DatabaseSync(databasePath);
  sourceDatabase.exec('PRAGMA foreign_keys = ON');
  if (!validateOptionalAPNSDeviceStorageEnvelope(sourceDatabase).present) {
    sourceDatabase.exec(`${APNS_DEVICE_STORAGE_ENVELOPE.createStatements.join(';\n')};`);
  }
  sourceDatabase.prepare(`
    INSERT INTO apns_devices (
      installation_id, user_id, environment, token_ciphertext, token_nonce,
      token_auth_tag, token_fingerprint, app_version, locale, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '40000000-0000-4000-8000-000000000001',
    user.id,
    'development',
    Buffer.from('00017fff80fe', 'hex'),
    Buffer.from('000102030405060708090a0b', 'hex'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from('42'.repeat(32), 'hex'),
    '0.1.0 (203)',
    'en-US',
    1,
    2
  );
  const expectedAPNSRow = {
    ...sourceDatabase.prepare(`
      SELECT
        installation_id,
        user_id,
        environment,
        hex(token_ciphertext) AS token_ciphertext_hex,
        hex(token_nonce) AS token_nonce_hex,
        hex(token_auth_tag) AS token_auth_tag_hex,
        hex(token_fingerprint) AS token_fingerprint_hex,
        app_version,
        locale,
        created_at,
        updated_at
      FROM apns_devices
    `).get()
  };
  sourceDatabase.close();
  await saveRoomsToDisk(new Map(), roomsPath);

  const backupDirectory = path.join(tempDirectory, 'verified backup');
  const backupRun = await execFileAsync(process.execPath, [
    backupScript,
    '--output',
    backupDirectory,
    '--database',
    databasePath,
    '--rooms',
    roomsPath,
    '--release',
    releasePath
  ]);
  const backupResult = JSON.parse(backupRun.stdout);
  assert.equal(backupResult.metadata.releaseSha, releaseIdentity.releaseSha);
  assert.equal(backupResult.metadata.schemaVersion, 2);

  const verifyResult = JSON.parse((await execFileAsync(process.execPath, [verifyScript, '--backup', backupDirectory])).stdout);
  assert.equal(verifyResult.metadata.database.integrityCheck, 'ok');
  assert.equal(verifyResult.metadata.database.foreignKeyCheck, 'ok');

  const restoreDirectory = path.join(tempDirectory, 'isolated restore');
  const childEnv = {
    ...process.env,
    SKYJO_DB_FILE: databasePath,
    SKYJO_ROOMS_FILE: roomsPath,
    SKYJO_RELEASE_FILE: releasePath
  };
  const restoreResult = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        restoreScript,
        '--backup',
        backupDirectory,
        '--destination',
        restoreDirectory,
        '--deletion-ledger',
        deletionLedgerPath
      ], { env: childEnv })
    ).stdout
  );
  assert.equal(restoreResult.destinationDirectory, restoreDirectory);
  assert.deepEqual(inspectSqliteState(path.join(restoreDirectory, 'skyjo.sqlite')), {
    integrityCheck: 'ok',
    foreignKeyCheck: 'ok',
    schemaVersion: 2
  });
  const restoredDatabase = new DatabaseSync(path.join(restoreDirectory, 'skyjo.sqlite'), { readOnly: true });
  assert.equal(
    restoredDatabase.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(deletedUser.id).count,
    0,
    'post-deletion backup restore does not resurrect the account'
  );
  assert.equal(
    restoredDatabase.prepare('SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?').get(deletedUser.id).count,
    0
  );
  assert.equal(
    restoredDatabase.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(deletedUser.id).count,
    0
  );
  assert.equal(
    restoredDatabase.prepare('SELECT COUNT(*) AS count FROM apns_devices WHERE user_id = ?').get(deletedUser.id).count,
    0
  );
  assert.equal(
    restoredDatabase.prepare('SELECT COUNT(*) AS count FROM games WHERE id = ?').get(deletedSolo.id).count,
    0
  );
  assert.deepEqual(
    { ...restoredDatabase.prepare(
      'SELECT user_id, display_name FROM game_participants WHERE game_id = ? AND player_id = ?'
    ).get(retainedMultiplayer.id, 'deleted-player') },
    { user_id: null, display_name: 'Deleted player' },
    'shared multiplayer history stays anonymized after restore'
  );
  const restoredAPNSRow = {
    ...restoredDatabase.prepare(`
      SELECT
        installation_id,
        user_id,
        environment,
        hex(token_ciphertext) AS token_ciphertext_hex,
        hex(token_nonce) AS token_nonce_hex,
        hex(token_auth_tag) AS token_auth_tag_hex,
        hex(token_fingerprint) AS token_fingerprint_hex,
        app_version,
        locale,
        created_at,
        updated_at
      FROM apns_devices
    `).get()
  };
  restoredDatabase.close();
  assert.deepEqual(restoredAPNSRow, expectedAPNSRow);
  const restoredRooms = await loadRoomsSnapshotFromDisk(path.join(restoreDirectory, 'rooms.json'));
  assert.equal(restoredRooms.version, 2);
  assert.deepEqual(restoredRooms.rooms, []);
  assert.equal(
    await fs.readFile(path.join(restoreDirectory, 'release.json'), 'utf8'),
    await fs.readFile(releasePath, 'utf8')
  );

  const oldSourceDirectory = path.join(tempDirectory, 'pre-deletion source');
  const oldDatabasePath = path.join(oldSourceDirectory, 'skyjo.sqlite');
  const oldRoomsPath = path.join(oldSourceDirectory, 'rooms.json');
  await fs.mkdir(oldSourceDirectory);
  const oldStore = await createAccountStore({ filePath: oldDatabasePath });
  const retainedOldUser = await oldStore.createUser({
    email: 'retained-old-backup@example.com',
    displayName: 'Retained Old Backup',
    password: 'retained-old-password'
  });
  const resurrectableUser = await oldStore.createUser({
    email: 'resurrectable-old-backup@example.com',
    displayName: 'Resurrectable Old Backup',
    password: 'resurrectable-old-password'
  });
  oldStore.createSession(resurrectableUser.id, 60_000);
  oldStore.savePushSubscription(
    resurrectableUser.id,
    { endpoint: 'https://push.example.test/pre-deletion', keys: { p256dh: 'key', auth: 'auth' } },
    'pre-deletion backup smoke'
  );
  oldStore.db.prepare(`
    INSERT INTO apns_devices (
      installation_id, user_id, environment, token_ciphertext, token_nonce,
      token_auth_tag, token_fingerprint, app_version, locale, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '40000000-0000-4000-8000-000000000003',
    resurrectableUser.id,
    'development',
    Buffer.from('00037fff80fe', 'hex'),
    Buffer.from('000102030405060708090a0b', 'hex'),
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from('44'.repeat(32), 'hex'),
    '0.1.0 (204)',
    'en-US',
    1,
    2
  );
  const oldPlayers = [
    { id: 'old-deleted-player', kind: 'human', name: 'Resurrectable Old Backup', roundScore: 3, totalScore: 3 },
    { id: 'old-retained-player', kind: 'human', name: 'Retained Old Backup', roundScore: 8, totalScore: 8 }
  ];
  const oldMultiplayer = oldStore.recordCompletedGame({
    mode: 'multi',
    state: completedState(oldPlayers),
    roomCode: 'OLD01',
    createdByUserId: resurrectableUser.id,
    playerAccounts: {
      'old-deleted-player': resurrectableUser.id,
      'old-retained-player': retainedOldUser.id
    },
    sourceKey: 'multi:pre-deletion-backup'
  });
  const oldSolo = oldStore.recordCompletedGame({
    mode: 'single',
    state: completedState([oldPlayers[0]]),
    createdByUserId: resurrectableUser.id,
    playerAccounts: { 'old-deleted-player': resurrectableUser.id },
    sourceKey: `single:${resurrectableUser.id}:pre-deletion-backup`
  });
  const activeOldRoom = {
    code: 'OLD01',
    hostId: 'old-deleted-player',
    players: [
      { id: 'old-deleted-player', userId: resurrectableUser.id, name: 'Resurrectable Old Backup', connected: false, host: true },
      { id: 'old-retained-player', userId: retainedOldUser.id, name: 'Retained Old Backup', connected: false, host: false }
    ],
    chatMessages: [{
      id: 'old-chat',
      playerId: 'old-deleted-player',
      playerName: 'Resurrectable Old Backup',
      text: 'private authored message',
      createdAt: 1
    }],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: 2,
    completedGameId: null,
    gameSessionId: null,
    finishedByAi: false,
    roomInstanceId: '50000000-0000-4000-8000-000000000001',
    revision: 0,
    recentCommandIds: [],
    resetAliases: [],
    clients: new Set()
  };
  await saveRoomsToDisk(new Map([[activeOldRoom.code, activeOldRoom]]), oldRoomsPath);
  const oldBackupDirectory = path.join(tempDirectory, 'verified pre-deletion backup');
  await execFileAsync(process.execPath, [
    backupScript,
    '--output',
    oldBackupDirectory,
    '--database',
    oldDatabasePath,
    '--rooms',
    oldRoomsPath,
    '--release',
    releasePath
  ]);
  oldStore.close();

  await deletionLedger.recordDeletion(resurrectableUser.id);
  const oldRestoreDirectory = path.join(tempDirectory, 'reconciled old restore');
  const oldRestoreResult = JSON.parse((await execFileAsync(process.execPath, [
    restoreScript,
    '--backup',
    oldBackupDirectory,
    '--destination',
    oldRestoreDirectory,
    '--deletion-ledger',
    deletionLedgerPath
  ], {
    env: {
      ...process.env,
      SKYJO_DB_FILE: oldDatabasePath,
      SKYJO_ROOMS_FILE: oldRoomsPath,
      SKYJO_RELEASE_FILE: releasePath,
      SKYJO_ACCOUNT_DELETION_LEDGER_FILE: deletionLedgerPath
    }
  })).stdout);
  assert.deepEqual(oldRestoreResult.reconciledAccountDeletions, { databaseAccounts: 1, rooms: 1 });
  const reconciledOldDatabase = new DatabaseSync(path.join(oldRestoreDirectory, 'skyjo.sqlite'), { readOnly: true });
  assert.equal(reconciledOldDatabase.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(resurrectableUser.id).count, 0);
  assert.equal(reconciledOldDatabase.prepare('SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?').get(resurrectableUser.id).count, 0);
  assert.equal(reconciledOldDatabase.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').get(resurrectableUser.id).count, 0);
  assert.equal(reconciledOldDatabase.prepare('SELECT COUNT(*) AS count FROM apns_devices WHERE user_id = ?').get(resurrectableUser.id).count, 0);
  assert.equal(reconciledOldDatabase.prepare('SELECT COUNT(*) AS count FROM games WHERE id = ?').get(oldSolo.id).count, 0);
  assert.deepEqual(
    { ...reconciledOldDatabase.prepare(
      'SELECT user_id, display_name FROM game_participants WHERE game_id = ? AND player_id = ?'
    ).get(oldMultiplayer.id, 'old-deleted-player') },
    { user_id: null, display_name: 'Deleted player' }
  );
  reconciledOldDatabase.close();
  const reconciledOldRooms = await loadRoomsSnapshotFromDisk(path.join(oldRestoreDirectory, 'rooms.json'), {
    now: 10,
    staleMs: Number.MAX_SAFE_INTEGER
  });
  assert.equal(reconciledOldRooms.rooms[0].players.length, 1);
  assert.equal(reconciledOldRooms.rooms[0].players[0].id, 'old-retained-player');
  assert.equal(reconciledOldRooms.rooms[0].players[0].host, true);
  assert.deepEqual(reconciledOldRooms.rooms[0].chatMessages, []);

  await assert.rejects(
    execFileAsync(process.execPath, [
      restoreScript,
      '--backup',
      backupDirectory,
      '--destination',
      sourceDirectory,
      '--deletion-ledger',
      deletionLedgerPath
    ], { env: childEnv }),
    /live state target/i
  );
  console.log(
    'backup smoke passed: online SQLite snapshot, fixed checksums, external-ledger reconciliation of pre-deletion backups, exact optional APNs-row preservation, and isolated restore in paths with spaces'
  );
} finally {
  await fs.rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
