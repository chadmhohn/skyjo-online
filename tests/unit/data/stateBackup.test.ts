import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createAccountStore, SCHEMA_MIGRATIONS } from '../../../server-account-store.mjs';
import { writeReleaseIdentity } from '../../../server-release.mjs';
import {
  createStateBackup,
  inspectSqliteState,
  resolveStateSourcePaths,
  restoreStateBackup,
  STATE_BACKUP_FILES,
  validateReleaseBackupDocument,
  validateRoomsBackupDocument,
  verifyStateBackup
} from '../../../server-state-backup.mjs';

const execFileAsync = promisify(execFile);
const fixedTimestamp = '2026-07-11T12:00:00.000Z';
const releaseSha = 'a'.repeat(40);

function roomState() {
  return {
    format: 'skyjo-rooms',
    version: 2,
    protocolVersion: 1,
    savedAt: Date.parse(fixedTimestamp),
    rooms: [
      {
        code: 'ABCDE',
        hostId: 'player-1',
        players: [
          { id: 'player-1', userId: 'user-1', name: 'Ada', connected: false, host: true },
          { id: 'player-2', userId: 'user-2', name: 'Grace', connected: false, host: false }
        ],
        chatMessages: [],
        readyForNextRoundPlayerIds: [],
        state: { phase: 'choose-source' },
        status: 'playing',
        updatedAt: Date.parse(fixedTimestamp),
        completedGameId: null,
        gameSessionId: 'session-1'
      }
    ]
  };
}

function releaseIdentity() {
  return {
    formatVersion: 1,
    releaseSha,
    buildTimestamp: fixedTimestamp,
    schemaVersion: 2,
    protocolVersion: 1
  };
}

async function createDatabase(filePath: string) {
  const store = await createAccountStore({ filePath, now: () => Date.parse(fixedTimestamp) });
  store.close();
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id)
    );
  `);
  database.prepare('INSERT INTO parents (id) VALUES (?)').run(1);
  database.prepare('INSERT INTO children (id, parent_id) VALUES (?, ?)').run(1, 1);
  database.close();
}

describe('verified state backups', () => {
  let tempDirectory = '';
  let sourceDirectory = '';
  let databasePath = '';
  let roomsPath = '';
  let releasePath = '';

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-state-backup-test-'));
    sourceDirectory = path.join(tempDirectory, 'source');
    databasePath = path.join(sourceDirectory, 'skyjo.sqlite');
    roomsPath = path.join(sourceDirectory, 'rooms.json');
    releasePath = path.join(sourceDirectory, 'release.json');
    await fs.mkdir(sourceDirectory, { recursive: true });
    await createDatabase(databasePath);
    await fs.writeFile(roomsPath, `${JSON.stringify(roomState())}\n`, { mode: 0o600 });
    await writeReleaseIdentity(sourceDirectory, releaseIdentity());
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function createBackup(name = 'backup') {
    const destinationDirectory = path.join(tempDirectory, name);
    return createStateBackup({
      databasePath,
      roomsPath,
      releasePath,
      destinationDirectory,
      now: fixedTimestamp
    });
  }

  it('creates an atomic fixed-layout backup and verifies hashes, semantics, SQLite, and private modes', async () => {
    const result = await createBackup();
    const names = (await fs.readdir(result.backupDirectory)).sort();
    expect(names).toEqual(['manifest.json', 'release.json', 'rooms.json', 'skyjo.sqlite']);
    expect(result).toMatchObject({
      format: 'skyjo-state-backup',
      formatVersion: 1,
      createdAt: fixedTimestamp,
      metadata: {
        schemaVersion: 2,
        releaseSha,
        buildTimestamp: fixedTimestamp,
        protocolVersion: 1,
        database: { integrityCheck: 'ok', foreignKeyCheck: 'ok', schemaVersion: 2 },
        rooms: { format: 'skyjo-rooms', version: 2, protocolVersion: 1, count: 1 }
      }
    });
    expect(result.files.map((entry: { name: string }) => entry.name)).toEqual([
      'skyjo.sqlite',
      'rooms.json',
      'release.json'
    ]);
    expect(result.files.every((entry: { size: number; sha256: string }) => entry.size > 0 && /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(inspectSqliteState(path.join(result.backupDirectory, STATE_BACKUP_FILES.database))).toEqual({
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
      schemaVersion: 2
    });

    if (process.platform !== 'win32') {
      expect((await fs.stat(result.backupDirectory)).mode & 0o777).toBe(0o700);
      for (const name of names) expect((await fs.stat(path.join(result.backupDirectory, name))).mode & 0o777).toBe(0o600);
    }
  });

  it('supports the strict v2 room envelope and its checksummed release identity', () => {
    const v2 = roomState();
    expect(validateRoomsBackupDocument(v2)).toBe(true);
    expect(validateRoomsBackupDocument({ ...v2, unexpected: true })).toBe(false);
    expect(
      validateRoomsBackupDocument({ version: 1, savedAt: Date.parse(fixedTimestamp), rooms: v2.rooms })
    ).toBe(true);
    expect(validateReleaseBackupDocument(releaseIdentity())).toBe(true);
    expect(validateReleaseBackupDocument({ ...releaseIdentity(), unexpected: true })).toBe(false);
  });

  it('runs an injected schema validator for source, copied, staged, and finalized databases', async () => {
    const calls: Array<{ schemaVersion: number; count: number }> = [];
    await createStateBackup({
      databasePath,
      roomsPath,
      releasePath,
      destinationDirectory: path.join(tempDirectory, 'validated-backup'),
      now: fixedTimestamp,
      validateSchema: (database: DatabaseSync, context: { schemaVersion: number }) => {
        calls.push({
          schemaVersion: context.schemaVersion,
          count: Number(database.prepare('SELECT COUNT(*) AS count FROM parents').get()?.count)
        });
        return true;
      }
    });
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((call) => call.schemaVersion === 2 && call.count === 1)).toBe(true);
  });

  it('rejects corrupt or foreign-key-invalid source databases before creating a final directory', async () => {
    const invalidDatabase = new DatabaseSync(databasePath);
    invalidDatabase.exec('PRAGMA foreign_keys = OFF');
    invalidDatabase.prepare('INSERT INTO children (id, parent_id) VALUES (?, ?)').run(2, 999);
    invalidDatabase.close();

    const destinationDirectory = path.join(tempDirectory, 'invalid-database-backup');
    await expect(
      createStateBackup({ databasePath, roomsPath, releasePath, destinationDirectory, now: fixedTimestamp })
    ).rejects.toThrow(/foreign-key/i);
    await expect(fs.lstat(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(databasePath, 'not a sqlite database', 'utf8');
    await expect(
      createStateBackup({
        databasePath,
        roomsPath,
        releasePath,
        destinationDirectory: path.join(tempDirectory, 'corrupt-backup'),
        now: fixedTimestamp
      })
    ).rejects.toThrow(/SQLite/i);
  });

  it('rejects malformed room/release state and schema/release version disagreement', async () => {
    await fs.writeFile(roomsPath, '{"version":99,"rooms":[]}', 'utf8');
    await expect(createBackup('bad-rooms')).rejects.toThrow(/room state.*validation/i);

    await fs.writeFile(roomsPath, `${JSON.stringify(roomState())}\n`, 'utf8');
    await fs.writeFile(releasePath, `${JSON.stringify({ ...releaseIdentity(), protocolVersion: 2 })}\n`, 'utf8');
    await expect(createBackup('bad-release-schema')).rejects.toThrow(/checksum/i);
  });

  it('rejects migration checksum drift and unsupported future migration rows', async () => {
    let database = new DatabaseSync(databasePath);
    database.prepare("UPDATE schema_migrations SET checksum = '0' WHERE version = 1").run();
    database.close();
    await expect(createBackup('drifted-migration')).rejects.toThrow(/migration checksum/i);

    database = new DatabaseSync(databasePath);
    database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(SCHEMA_MIGRATIONS[0].checksum);
    database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
      3,
      'future-migration',
      'f'.repeat(64),
      Date.parse(fixedTimestamp)
    );
    database.close();
    await expect(createBackup('future-migration')).rejects.toThrow(/does not match this release/i);
  });

  it('requires the baked source release checksum before creating a backup', async () => {
    await fs.appendFile(releasePath, ' ');
    await expect(createBackup('invalid-source-release')).rejects.toThrow(/checksum mismatch/i);
  });

  it('rejects tampering, missing payloads, extra entries, and semantic manifest edits', async () => {
    const tampered = await createBackup('tampered');
    await fs.appendFile(path.join(tampered.backupDirectory, STATE_BACKUP_FILES.rooms), ' ');
    await expect(verifyStateBackup(tampered.backupDirectory)).rejects.toThrow(/size or SHA-256/i);

    const missing = await createBackup('missing');
    await fs.rm(path.join(missing.backupDirectory, STATE_BACKUP_FILES.release));
    await expect(verifyStateBackup(missing.backupDirectory)).rejects.toThrow(/missing or unexpected/i);

    const extra = await createBackup('extra');
    await fs.writeFile(path.join(extra.backupDirectory, 'notes.txt'), 'unexpected', 'utf8');
    await expect(verifyStateBackup(extra.backupDirectory)).rejects.toThrow(/missing or unexpected/i);

    const semantic = await createBackup('semantic');
    const manifestPath = path.join(semantic.backupDirectory, STATE_BACKUP_FILES.manifest);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.metadata.rooms.count = 99;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await expect(verifyStateBackup(semantic.backupDirectory)).rejects.toThrow(/semantic metadata/i);
  });

  it.each([
    ['path traversal', '../rooms.json'],
    ['POSIX absolute', '/tmp/rooms.json'],
    ['Windows drive absolute', 'C:\\state\\rooms.json'],
    ['UNC absolute', '\\\\server\\share\\rooms.json']
  ])('rejects %s manifest file names before path resolution', async (_label, maliciousName) => {
    const result = await createBackup(`unsafe-${String(_label).replace(/\s+/g, '-')}`);
    const manifestPath = path.join(result.backupDirectory, STATE_BACKUP_FILES.manifest);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.files[0].name = maliciousName;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    await expect(verifyStateBackup(result.backupDirectory)).rejects.toThrow(/unsafe file name/i);
  });

  it('rejects linked backup roots and linked payloads', async () => {
    const result = await createBackup();
    const linkedRoot = path.join(tempDirectory, 'linked-backup');
    await fs.symlink(result.backupDirectory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(verifyStateBackup(linkedRoot)).rejects.toThrow(/links and junctions/i);

    if (process.platform !== 'win32') {
      const linkedPayload = await createBackup('linked-payload');
      const payloadPath = path.join(linkedPayload.backupDirectory, STATE_BACKUP_FILES.rooms);
      await fs.rm(payloadPath);
      await fs.symlink(roomsPath, payloadPath);
      await expect(verifyStateBackup(linkedPayload.backupDirectory)).rejects.toThrow(/link, junction, or directory/i);
    }
  });

  it('restores only payload files into a fresh destination and reverifies the final copy', async () => {
    const backupResult = await createBackup();
    const destinationDirectory = path.join(tempDirectory, 'restored');
    let releaseValidationCalls = 0;
    const result = await restoreStateBackup(backupResult.backupDirectory, {
      destinationDirectory,
      livePaths: [],
      validateRelease: (value: unknown) => {
        releaseValidationCalls += 1;
        return validateReleaseBackupDocument(value);
      }
    });

    expect((await fs.readdir(destinationDirectory)).sort()).toEqual(['release.json', 'rooms.json', 'skyjo.sqlite']);
    expect(releaseValidationCalls).toBe(3);
    const restoredDatabase = new DatabaseSync(result.databasePath, { readOnly: true });
    expect(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM children').get()?.count).toBe(1);
    restoredDatabase.close();
    expect(JSON.parse(await fs.readFile(result.roomsPath, 'utf8'))).toEqual(roomState());
    expect(JSON.parse(await fs.readFile(result.releasePath, 'utf8'))).toEqual(releaseIdentity());
  });

  it('accepts an existing empty restore directory but rejects nonempty, same, live, and linked targets', async () => {
    const backupResult = await createBackup();
    const emptyDestination = path.join(tempDirectory, 'empty-destination');
    await fs.mkdir(emptyDestination);
    await restoreStateBackup(backupResult.backupDirectory, { destinationDirectory: emptyDestination, livePaths: [] });
    expect(await fs.readdir(emptyDestination)).toHaveLength(3);

    const nonempty = path.join(tempDirectory, 'nonempty');
    await fs.mkdir(nonempty);
    await fs.writeFile(path.join(nonempty, 'keep.txt'), 'keep', 'utf8');
    await expect(
      restoreStateBackup(backupResult.backupDirectory, { destinationDirectory: nonempty, livePaths: [] })
    ).rejects.toThrow(/contain files/i);
    expect(await fs.readFile(path.join(nonempty, 'keep.txt'), 'utf8')).toBe('keep');

    await expect(
      restoreStateBackup(backupResult.backupDirectory, {
        destinationDirectory: backupResult.backupDirectory,
        livePaths: []
      })
    ).rejects.toThrow(/isolated from the source backup/i);

    const liveDestination = path.join(tempDirectory, 'live-state');
    await expect(
      restoreStateBackup(backupResult.backupDirectory, {
        destinationDirectory: liveDestination,
        livePaths: [path.join(liveDestination, STATE_BACKUP_FILES.database)]
      })
    ).rejects.toThrow(/live state target/i);

    const linkedTarget = path.join(tempDirectory, 'linked-target');
    const realTarget = path.join(tempDirectory, 'real-target');
    await fs.mkdir(realTarget);
    await fs.symlink(realTarget, linkedTarget, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      restoreStateBackup(backupResult.backupDirectory, { destinationDirectory: linkedTarget, livePaths: [] })
    ).rejects.toThrow(/symbolic link.*junction/i);
  });

  it('runs all three CLI wrappers with explicit isolated paths', async () => {
    const cliBackup = path.join(tempDirectory, 'cli-backup');
    const backupScript = path.resolve('scripts', 'backup-state.mjs');
    const verifyScript = path.resolve('scripts', 'verify-state-backup.mjs');
    const restoreScript = path.resolve('scripts', 'restore-state.mjs');
    const backupRun = await execFileAsync(process.execPath, [
      backupScript,
      '--output',
      cliBackup,
      '--database',
      databasePath,
      '--rooms',
      roomsPath,
      '--release',
      releasePath
    ]);
    expect(JSON.parse(backupRun.stdout).backupDirectory).toBe(cliBackup);
    expect(JSON.parse((await execFileAsync(process.execPath, [verifyScript, '--backup', cliBackup])).stdout).formatVersion).toBe(1);

    const cliRestore = path.join(tempDirectory, 'cli-restore');
    const restoreRun = await execFileAsync(process.execPath, [
      restoreScript,
      '--backup',
      cliBackup,
      '--destination',
      cliRestore
    ]);
    expect(JSON.parse(restoreRun.stdout).destinationDirectory).toBe(cliRestore);
  });

  it('resolves production-compatible source defaults without importing account or release modules', () => {
    const paths = resolveStateSourcePaths({
      SKYJO_ROOMS_FILE: path.join(tempDirectory, 'live', 'rooms.json'),
      SKYJO_DB_FILE: path.join(tempDirectory, 'live', 'skyjo.sqlite')
    });
    expect(paths.roomsPath).toBe(path.join(tempDirectory, 'live', 'rooms.json'));
    expect(paths.databasePath).toBe(path.join(tempDirectory, 'live', 'skyjo.sqlite'));
    expect(paths.releasePath).toBe(path.resolve('dist', 'release.json'));
  });
});
