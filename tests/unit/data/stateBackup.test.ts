import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  APNS_DEVICE_STORAGE_ENVELOPE,
  createAccountStore,
  SCHEMA_MIGRATIONS
} from '../../../server-account-store.mjs';
import { createAccountDeletionLedger } from '../../../server-account-deletion-ledger.mjs';
import { CURRENT_PROTOCOL_VERSION, writeReleaseIdentity } from '../../../server-release.mjs';
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
        state: null,
        status: 'waiting',
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
    protocolVersion: CURRENT_PROTOCOL_VERSION
  };
}

async function writeChecksummedReleaseIdentity(directory: string, identity: ReturnType<typeof releaseIdentity>) {
  const data = `${JSON.stringify(identity, null, 2)}\n`;
  const checksum = crypto.createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(directory, 'release.json'), data, 'utf8');
  await fs.writeFile(path.join(directory, 'release.json.sha256'), `${checksum}  release.json\n`, 'utf8');
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

function installAPNSDeviceEnvelope(database: DatabaseSync) {
  const present = database
    .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'apns_devices'")
    .get();
  if (!present) database.exec(`${APNS_DEVICE_STORAGE_ENVELOPE.createStatements.join(';\n')};`);
}

function apnsRows(database: DatabaseSync) {
  return database.prepare(`
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
    ORDER BY installation_id
  `).all().map((row) => ({ ...row }));
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

  async function rewriteBackupAsHistoricalSchemaOne(backupDirectory: string) {
    const databaseFile = path.join(backupDirectory, STATE_BACKUP_FILES.database);
    const releaseFile = path.join(backupDirectory, STATE_BACKUP_FILES.release);
    const manifestFile = path.join(backupDirectory, STATE_BACKUP_FILES.manifest);
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      DROP TABLE children;
      DROP TABLE parents;
      DROP TABLE invite_codes;
      ALTER TABLE games DROP COLUMN finished_by_ai;
      DELETE FROM schema_migrations WHERE version = 2;
    `);
    database.close();

    const release = JSON.parse(await fs.readFile(releaseFile, 'utf8'));
    release.schemaVersion = 1;
    await fs.writeFile(releaseFile, `${JSON.stringify(release, null, 2)}\n`, 'utf8');

    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.metadata.schemaVersion = 1;
    manifest.metadata.database.schemaVersion = 1;
    for (const entry of manifest.files) {
      const data = await fs.readFile(path.join(backupDirectory, entry.name));
      entry.size = data.byteLength;
      entry.sha256 = crypto.createHash('sha256').update(data).digest('hex');
    }
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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
        protocolVersion: CURRENT_PROTOCOL_VERSION,
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

  it('verifies, backs up, and restores the exact optional APNs envelope without changing row bytes or public schema', async () => {
    let database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.prepare(`
      INSERT INTO users (
        id, email, display_name, password_hash, password_salt, role, disabled, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '20000000-0000-4000-8000-000000000001',
      'backup-apns@example.com',
      'Backup APNs',
      'unused-hash',
      'unused-salt',
      'player',
      0,
      Date.parse(fixedTimestamp),
      Date.parse(fixedTimestamp),
      null
    );
    installAPNSDeviceEnvelope(database);
    database.prepare(`
      INSERT INTO apns_devices (
        installation_id,
        user_id,
        environment,
        token_ciphertext,
        token_nonce,
        token_auth_tag,
        token_fingerprint,
        app_version,
        locale,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000001',
      'production',
      Buffer.from('00017fff80fe', 'hex'),
      Buffer.from('000102030405060708090a0b', 'hex'),
      Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex'),
      Buffer.from('cd'.repeat(32), 'hex'),
      '0.1.0 (42)',
      'fr-CA',
      Date.parse(fixedTimestamp),
      Date.parse(fixedTimestamp) + 1
    );
    const expectedRows = apnsRows(database);
    database.close();

    const backup = await createBackup('apns-envelope-backup');
    expect(backup.metadata.schemaVersion).toBe(2);
    await expect(verifyStateBackup(backup.backupDirectory)).resolves.toMatchObject({
      metadata: { schemaVersion: 2, database: { schemaVersion: 2 } }
    });

    const restored = await restoreStateBackup(backup.backupDirectory, {
      destinationDirectory: path.join(tempDirectory, 'apns-envelope-restore'),
      livePaths: []
    });
    expect(inspectSqliteState(restored.databasePath)).toEqual({
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
      schemaVersion: 2
    });
    database = new DatabaseSync(restored.databasePath, { readOnly: true });
    try {
      expect(apnsRows(database)).toEqual(expectedRows);
    } finally {
      database.close();
    }
  });

  it('rejects a malformed optional APNs envelope before creating a backup', async () => {
    const database = new DatabaseSync(databasePath);
    installAPNSDeviceEnvelope(database);
    database.exec('DROP INDEX idx_apns_devices_updated_at');
    database.close();

    await expect(createBackup('malformed-apns-envelope')).rejects.toThrow(/APNs device storage envelope/i);
    await expect(fs.stat(path.join(tempDirectory, 'malformed-apns-envelope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('backs up and restores the v0.1.1 release identity with the protocol-v1 room envelope', async () => {
    const historicalRelease = { ...releaseIdentity(), protocolVersion: 1 };
    await writeChecksummedReleaseIdentity(sourceDirectory, historicalRelease);

    const backup = await createBackup('v0.1.1-release-compatibility');
    expect(backup.metadata).toMatchObject({
      protocolVersion: 1,
      rooms: { format: 'skyjo-rooms', version: 2, protocolVersion: 1, count: 1 }
    });
    await expect(verifyStateBackup(backup.backupDirectory)).resolves.toMatchObject({
      metadata: { protocolVersion: 1, rooms: { protocolVersion: 1 } }
    });

    const restored = await restoreStateBackup(backup.backupDirectory, {
      destinationDirectory: path.join(tempDirectory, 'v0.1.1-release-restore'),
      livePaths: []
    });
    expect(JSON.parse(await fs.readFile(restored.releasePath, 'utf8'))).toEqual(historicalRelease);
    expect(JSON.parse(await fs.readFile(restored.roomsPath, 'utf8'))).toMatchObject({
      version: 2,
      protocolVersion: 1
    });
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

  it('strictly rejects malformed room envelopes, rooms, and players', () => {
    type RoomContext = {
      document: Record<string, unknown>;
      room: Record<string, unknown>;
      players: Array<Record<string, unknown>>;
    };
    const invalidCases: Array<[string, (context: RoomContext) => void]> = [
      ['missing version', ({ document }) => delete document.version],
      ['unsupported version', ({ document }) => (document.version = 3)],
      ['invalid save time', ({ document }) => (document.savedAt = Number.NaN)],
      ['non-array rooms', ({ document }) => (document.rooms = {})],
      ['non-record room', ({ document }) => (document.rooms = [null])],
      ['invalid code type', ({ room }) => (room.code = 123)],
      ['invalid code value', ({ room }) => (room.code = 'ABC')],
      ['empty host', ({ room }) => (room.hostId = '')],
      ['unsupported status', ({ room }) => (room.status = 'paused')],
      ['invalid update time', ({ room }) => (room.updatedAt = Number.NaN)],
      ['non-array players', ({ room }) => (room.players = {})],
      ['empty players', ({ room }) => (room.players = [])],
      ['too many players', ({ room, players }) => (room.players = Array(9).fill(players[0]))],
      ['non-record player', ({ players }) => (players[0] = null as unknown as Record<string, unknown>)],
      ['invalid player id type', ({ players }) => (players[0].id = 1)],
      ['empty player id', ({ players }) => (players[0].id = '')],
      ['invalid player name type', ({ players }) => (players[0].name = 1)],
      ['empty player name', ({ players }) => (players[0].name = '')],
      ['invalid user id', ({ players }) => (players[0].userId = 1)],
      ['invalid connected state', ({ players }) => (players[0].connected = 'yes')],
      ['invalid host state', ({ players }) => (players[0].host = 'yes')],
      ['host not present', ({ room }) => (room.hostId = 'missing-player')],
      ['non-array chat', ({ room }) => (room.chatMessages = {})],
      ['non-array readiness', ({ room }) => (room.readyForNextRoundPlayerIds = {})],
      ['invalid game state', ({ room }) => (room.state = [])]
    ];

    expect(validateRoomsBackupDocument(null)).toBe(false);
    for (const [label, mutate] of invalidCases) {
      const candidate = structuredClone(roomState()) as unknown as Record<string, unknown>;
      const rooms = candidate.rooms as Array<Record<string, unknown>>;
      const room = rooms[0];
      const players = room.players as Array<Record<string, unknown>>;
      mutate({ document: candidate, room, players });
      expect(validateRoomsBackupDocument(candidate), label).toBe(false);
    }

    const invalidV2Format = {
      format: '',
      version: 2,
      protocolVersion: 1,
      savedAt: Date.parse(fixedTimestamp),
      rooms: []
    };
    expect(validateRoomsBackupDocument(invalidV2Format)).toBe(false);
    expect(validateRoomsBackupDocument({ ...invalidV2Format, format: 'valid', protocolVersion: 0 })).toBe(false);
    expect(validateRoomsBackupDocument({
      ...invalidV2Format,
      format: 'valid',
      protocolVersion: CURRENT_PROTOCOL_VERSION + 1
    })).toBe(false);
    expect(
      validateRoomsBackupDocument({ ...invalidV2Format, format: 'x'.repeat(65), protocolVersion: 1 })
    ).toBe(false);
    expect(validateRoomsBackupDocument({ ...roomState(), rooms: Array(10_001).fill(roomState().rooms[0]) })).toBe(false);
  });

  it('uses the runtime room normalizer for duplicate, chat, and optional-field invariants', () => {
    const duplicatePlayers = structuredClone(roomState());
    duplicatePlayers.rooms[0].players[1].id = duplicatePlayers.rooms[0].players[0].id;
    expect(validateRoomsBackupDocument(duplicatePlayers)).toBe(false);

    const nullChat = structuredClone(roomState());
    nullChat.rooms[0].chatMessages = [null as never];
    expect(validateRoomsBackupDocument(nullChat)).toBe(false);

    const duplicateRooms = structuredClone(roomState());
    duplicateRooms.rooms.push({ ...structuredClone(duplicateRooms.rooms[0]), code: 'abcde' });
    expect(validateRoomsBackupDocument(duplicateRooms)).toBe(false);

    const invalidOptionalFields = structuredClone(roomState());
    invalidOptionalFields.rooms[0].players[0].connected = 'yes' as never;
    invalidOptionalFields.rooms[0].completedGameId = 42 as never;
    invalidOptionalFields.rooms[0].readyForNextRoundPlayerIds = [42 as never];
    expect(validateRoomsBackupDocument(invalidOptionalFields)).toBe(false);
  });

  it('strictly rejects malformed release identities', () => {
    const invalidCases: Array<[string, unknown]> = [
      ['non-record', null],
      ['wrong format', { ...releaseIdentity(), formatVersion: 2 }],
      ['uppercase SHA', { ...releaseIdentity(), releaseSha: releaseSha.toUpperCase() }],
      ['short SHA', { ...releaseIdentity(), releaseSha: 'abc' }],
      ['invalid timestamp', { ...releaseIdentity(), buildTimestamp: 'not-a-date' }],
      ['noncanonical timestamp', { ...releaseIdentity(), buildTimestamp: '2026-07-11T12:00:00Z' }],
      ['invalid schema', { ...releaseIdentity(), schemaVersion: 0 }],
      ['invalid protocol', { ...releaseIdentity(), protocolVersion: 0 }]
    ];
    for (const [label, value] of invalidCases) {
      expect(validateReleaseBackupDocument(value), label).toBe(false);
    }
    expect(validateReleaseBackupDocument({ ...releaseIdentity(), releaseSha: 'development' })).toBe(false);
    expect(validateReleaseBackupDocument({
      ...releaseIdentity(),
      protocolVersion: CURRENT_PROTOCOL_VERSION + 1
    })).toBe(false);
  });

  it('rejects missing, empty, discontinuous, or malformed migration histories and async validators', async () => {
    async function replaceDatabase(sql: string) {
      await fs.rm(databasePath, { force: true });
      const database = new DatabaseSync(databasePath);
      database.exec(sql);
      database.close();
    }

    await replaceDatabase('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
    expect(() => inspectSqliteState(databasePath)).toThrow(/migration history is missing/i);

    await replaceDatabase(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    expect(() => inspectSqliteState(databasePath)).toThrow(/does not match this release/i);

    const mutations: Array<[string, string, RegExp]> = [
      ['gap', 'DELETE FROM schema_migrations WHERE version = 1', /does not match this release/i],
      ['name', "UPDATE schema_migrations SET name = '' WHERE version = 1", /checksum does not match/i],
      ['checksum', "UPDATE schema_migrations SET checksum = 'bad' WHERE version = 1", /checksum does not match/i],
      ['timestamp', 'UPDATE schema_migrations SET applied_at = -1', /timestamp is invalid/i]
    ];
    for (const [, sql, expected] of mutations) {
      await fs.rm(databasePath, { force: true });
      await createDatabase(databasePath);
      const database = new DatabaseSync(databasePath);
      database.exec(sql);
      database.close();
      expect(() => inspectSqliteState(databasePath)).toThrow(expected);
      await fs.rm(databasePath);
    }

    await createDatabase(databasePath);
    expect(() => inspectSqliteState(databasePath, { validateSchema: () => false })).toThrow(/failed validation/i);
    expect(() => inspectSqliteState(databasePath, { validateSchema: async () => true })).toThrow(/must be synchronous/i);
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
    await fs.writeFile(
      releasePath,
      `${JSON.stringify({ ...releaseIdentity(), protocolVersion: CURRENT_PROTOCOL_VERSION })}\n`,
      'utf8'
    );
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

  it('verifies and restores a checksum-valid historical migration prefix for long-term retention', async () => {
    const backup = await createBackup('historical-prefix');
    await rewriteBackupAsHistoricalSchemaOne(backup.backupDirectory);

    const verified = await verifyStateBackup(backup.backupDirectory);
    expect(verified.metadata.schemaVersion).toBe(1);
    expect(verified.metadata.database.schemaVersion).toBe(1);
    expect(inspectSqliteState(path.join(backup.backupDirectory, STATE_BACKUP_FILES.database), {
      requireCurrentSchema: false
    })).toMatchObject({ schemaVersion: 1, integrityCheck: 'ok', foreignKeyCheck: 'ok' });
    expect(() => inspectSqliteState(path.join(backup.backupDirectory, STATE_BACKUP_FILES.database))).toThrow(/current release/i);

    const restored = await restoreStateBackup(backup.backupDirectory, {
      destinationDirectory: path.join(tempDirectory, 'historical-restore'),
      livePaths: []
    });
    expect(inspectSqliteState(restored.databasePath, { requireCurrentSchema: false }).schemaVersion).toBe(1);
    expect(JSON.parse(await fs.readFile(restored.releasePath, 'utf8')).schemaVersion).toBe(1);

    const migratedCopy = await createAccountStore({ filePath: restored.databasePath });
    migratedCopy.close();
    expect(inspectSqliteState(restored.databasePath).schemaVersion).toBe(2);
    expect((await verifyStateBackup(backup.backupDirectory)).metadata.schemaVersion).toBe(1);
  });

  it('refuses to create a live backup from a stale migration prefix', async () => {
    const database = new DatabaseSync(databasePath);
    database.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    database.close();
    const destinationDirectory = path.join(tempDirectory, 'stale-live-backup');
    await expect(createStateBackup({
      databasePath,
      roomsPath,
      releasePath,
      destinationDirectory,
      now: fixedTimestamp
    })).rejects.toThrow(/current release/i);
    await expect(fs.lstat(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('rejects malformed manifest shapes, entries, and sanitized metadata', async () => {
    const result = await createBackup();
    const manifestPath = path.join(result.backupDirectory, STATE_BACKUP_FILES.manifest);
    const original = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    type ManifestMutation = (manifest: Record<string, unknown>) => void;
    const files = (manifest: Record<string, unknown>) => manifest.files as Array<Record<string, unknown>>;
    const metadata = (manifest: Record<string, unknown>) => manifest.metadata as Record<string, unknown>;
    const database = (manifest: Record<string, unknown>) => metadata(manifest).database as Record<string, unknown>;
    const rooms = (manifest: Record<string, unknown>) => metadata(manifest).rooms as Record<string, unknown>;
    const mutations: Array<[string, ManifestMutation]> = [
      ['top-level shape', (manifest) => delete manifest.createdAt],
      ['format', (manifest) => (manifest.format = 'unknown')],
      ['timestamp', (manifest) => (manifest.createdAt = 'invalid')],
      ['file count', (manifest) => (manifest.files = [])],
      ['file entry shape', (manifest) => (files(manifest)[0].unexpected = true)],
      ['duplicate file', (manifest) => (files(manifest)[1].name = files(manifest)[0].name)],
      ['negative file size', (manifest) => (files(manifest)[0].size = -1)],
      ['invalid file digest', (manifest) => (files(manifest)[0].sha256 = 'invalid')],
      ['metadata shape', (manifest) => delete metadata(manifest).schemaVersion],
      ['metadata schema', (manifest) => (metadata(manifest).schemaVersion = 0)],
      ['metadata release SHA', (manifest) => (metadata(manifest).releaseSha = 'INVALID')],
      ['metadata timestamp', (manifest) => (metadata(manifest).buildTimestamp = 'invalid')],
      ['metadata protocol', (manifest) => (metadata(manifest).protocolVersion = 0)],
      ['database shape', (manifest) => delete database(manifest).integrityCheck],
      ['database integrity', (manifest) => (database(manifest).integrityCheck = 'failed')],
      ['room shape', (manifest) => delete rooms(manifest).count],
      ['room format', (manifest) => (rooms(manifest).format = '')],
      ['room version', (manifest) => (rooms(manifest).version = 3)],
      ['room protocol', (manifest) => (rooms(manifest).protocolVersion = 0)],
      ['room count', (manifest) => (rooms(manifest).count = -1)]
    ];

    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(original);
      mutate(candidate);
      await fs.writeFile(manifestPath, `${JSON.stringify(candidate)}\n`, 'utf8');
      await expect(verifyStateBackup(result.backupDirectory), label).rejects.toThrow();
    }

    await fs.writeFile(manifestPath, '{', 'utf8');
    await expect(verifyStateBackup(result.backupDirectory)).rejects.toThrow(/not valid JSON/i);
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

  it('reapplies external deletion tombstones to restored accounts and room seats', async () => {
    const deletedUserId = '30000000-0000-4000-8000-000000000001';
    const database = new DatabaseSync(databasePath);
    database.exec('DROP TABLE children; DROP TABLE parents;');
    database.prepare(`
      INSERT INTO users (
        id, email, display_name, password_hash, password_salt, role, disabled, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, 'player', 0, ?, ?, NULL)
    `).run(
      deletedUserId,
      'restore-deleted@example.test',
      'Restore Deleted',
      'unused-hash',
      'unused-salt',
      Date.parse(fixedTimestamp),
      Date.parse(fixedTimestamp)
    );
    database.close();
    const rooms = roomState();
    rooms.rooms[0].players[0].userId = deletedUserId;
    await fs.writeFile(roomsPath, `${JSON.stringify(rooms)}\n`, { mode: 0o600 });
    const backup = await createBackup('pre-deletion-backup');
    const deletionLedgerPath = path.join(sourceDirectory, 'account-deletions.json');
    const ledger = await createAccountDeletionLedger({ filePath: deletionLedgerPath, now: () => 123 });
    await ledger.recordDeletion(deletedUserId);

    const restored = await restoreStateBackup(backup.backupDirectory, {
      destinationDirectory: path.join(tempDirectory, 'reconciled-restore'),
      deletionLedgerPath,
      env: {
        SKYJO_DB_FILE: databasePath,
        SKYJO_ROOMS_FILE: roomsPath,
        SKYJO_RELEASE_FILE: releasePath,
        SKYJO_ACCOUNT_DELETION_LEDGER_FILE: deletionLedgerPath
      }
    });

    expect(restored.reconciledAccountDeletions).toEqual({ databaseAccounts: 1, rooms: 1 });
    const restoredDatabase = new DatabaseSync(restored.databasePath, { readOnly: true });
    expect(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(deletedUserId)?.count).toBe(0);
    restoredDatabase.close();
    const restoredRooms = JSON.parse(await fs.readFile(restored.roomsPath, 'utf8'));
    expect(restoredRooms.rooms[0].players).toEqual([
      expect.objectContaining({ id: 'player-2', host: true })
    ]);
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

  it('cleans restore staging after post-verification failure and validates path arguments', async () => {
    const backupResult = await createBackup();
    const destinationDirectory = path.join(tempDirectory, 'failed-restore');
    let validationCalls = 0;
    await expect(
      restoreStateBackup(backupResult.backupDirectory, {
        destinationDirectory,
        livePaths: [],
        validateRelease: (value: unknown) => {
          validationCalls += 1;
          return validationCalls === 1 && validateReleaseBackupDocument(value);
        }
      })
    ).rejects.toThrow(/failed validation/i);
    await expect(fs.lstat(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tempDirectory)).some((name) => name.includes('.failed-restore.staging-'))).toBe(false);

    await expect(verifyStateBackup('')).rejects.toThrow(/required/i);
    await expect(verifyStateBackup(path.join(tempDirectory, 'missing-backup'))).rejects.toThrow(/does not exist/i);
    const backupFile = path.join(tempDirectory, 'backup-file');
    await fs.writeFile(backupFile, 'not a directory', 'utf8');
    await expect(verifyStateBackup(backupFile)).rejects.toThrow(/real directory/i);
    await expect(
      restoreStateBackup(backupResult.backupDirectory, {
        destinationDirectory: path.join(tempDirectory, 'bad-live-paths'),
        livePaths: 'not-an-array' as unknown as string[]
      })
    ).rejects.toThrow(/must be an array/i);
  });

  it('rejects overlapping sources and invalid backup timestamps without leaving staging state', async () => {
    const overlappingDestination = path.join(sourceDirectory, 'nested-backup');
    await expect(
      createStateBackup({ databasePath, roomsPath, releasePath, destinationDirectory: overlappingDestination })
    ).rejects.toThrow(/isolated from every live source/i);

    const invalidTimestampDestination = path.join(tempDirectory, 'invalid-timestamp');
    await expect(
      createStateBackup({
        databasePath,
        roomsPath,
        releasePath,
        destinationDirectory: invalidTimestampDestination,
        now: 'invalid'
      })
    ).rejects.toThrow(/timestamp is invalid/i);
    await expect(fs.lstat(invalidTimestampDestination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tempDirectory)).some((name) => name.includes('.invalid-timestamp.staging-'))).toBe(false);
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
    const deletionLedgerPath = path.join(tempDirectory, 'account-deletions.json');
    await createAccountDeletionLedger({ filePath: deletionLedgerPath });
    const restoreRun = await execFileAsync(process.execPath, [
      restoreScript,
      '--backup',
      cliBackup,
      '--destination',
      cliRestore,
      '--deletion-ledger',
      deletionLedgerPath
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
