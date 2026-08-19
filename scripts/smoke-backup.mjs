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

try {
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
        restoreDirectory
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

  await assert.rejects(
    execFileAsync(process.execPath, [
      restoreScript,
      '--backup',
      backupDirectory,
      '--destination',
      sourceDirectory
    ], { env: childEnv }),
    /live state target/i
  );
  console.log(
    'backup smoke passed: online SQLite snapshot, fixed checksums, exact optional APNs-row preservation, and isolated restore in paths with spaces'
  );
} finally {
  await fs.rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
