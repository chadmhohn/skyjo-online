import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAccountStore } from '../server-account-store.mjs';
import { loadRoomsSnapshotFromDisk, saveRoomsToDisk } from '../server-room-persistence.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';
import { inspectSqliteState } from '../server-state-backup.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupScript = path.join(root, 'scripts', 'backup-state.mjs');
const verifyScript = path.join(root, 'scripts', 'verify-state-backup.mjs');
const restoreScript = path.join(root, 'scripts', 'restore-state.mjs');
const releasePath = path.join(root, 'dist', 'release.json');
const releaseIdentity = await loadReleaseIdentity(path.dirname(releasePath), { allowDevelopment: false, requireFullSha: true });
const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo backup smoke with spaces '));

try {
  const sourceDirectory = path.join(tempDirectory, 'source state');
  const databasePath = path.join(sourceDirectory, 'skyjo.sqlite');
  const roomsPath = path.join(sourceDirectory, 'rooms.json');
  await fs.mkdir(sourceDirectory);
  const store = await createAccountStore({ filePath: databasePath });
  await store.createUser({ email: 'backup-smoke@example.com', displayName: 'Backup Smoke', password: 'backup-smoke-password' });
  store.close();
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
  console.log('backup smoke passed: online SQLite snapshot, fixed checksums, verification, and isolated restore in paths with spaces');
} finally {
  await fs.rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
