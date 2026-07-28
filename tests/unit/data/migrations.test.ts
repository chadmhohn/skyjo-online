import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  APNS_DEVICE_STORAGE_ENVELOPE,
  createAccountStore,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  validateOptionalAPNSDeviceStorageEnvelope
} from '../../../server-account-store.mjs';

const fixedNow = Date.parse('2026-07-11T12:00:00.000Z');

function openDatabase(filePath: string) {
  return new DatabaseSync(filePath);
}

function migrationRows(db: DatabaseSync) {
  return db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
}

function columnNames(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((column) => String(column.name));
}

function installAPNSDeviceEnvelope(db: DatabaseSync) {
  db.exec(`${APNS_DEVICE_STORAGE_ENVELOPE.createStatements.join(';\n')};`);
}

function apnsRows(db: DatabaseSync) {
  return db.prepare(`
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

function downgradeCurrentDatabase(filePath: string) {
  const db = openDatabase(filePath);
  try {
    db.exec(`
      DROP TABLE invite_codes;
      DROP TABLE schema_migrations;
      ALTER TABLE games DROP COLUMN finished_by_ai;
    `);
  } finally {
    db.close();
  }
}

async function createCurrentDatabase(filePath: string) {
  const store = await createAccountStore({ filePath, now: () => fixedNow });
  store.close();
}

describe('transactional database migrations', () => {
  let tempDir = '';
  let dbFile = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-migration-test-'));
    dbFile = path.join(tempDir, 'skyjo.sqlite');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates the current schema with stable migration checksums and no raw invite secret columns', async () => {
    const store = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    expect(store.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(store.checkReadiness()).toBe(true);
    store.close();

    const db = openDatabase(dbFile);
    try {
      expect(migrationRows(db)).toEqual(
        SCHEMA_MIGRATIONS.map((migration: { version: number; name: string; checksum: string }) => ({
          ...migration,
          applied_at: fixedNow
        }))
      );
      expect(columnNames(db, 'games')).toContain('finished_by_ai');
      expect(columnNames(db, 'invite_codes')).toEqual([
        'code_lookup_hash',
        'room_code',
        'created_at',
        'expires_at',
        'redeemed_at',
        'room_instance_id'
      ]);
      expect(columnNames(db, 'invite_codes')).not.toEqual(expect.arrayContaining(['code', 'invite_token']));
      expect(
        db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'apns_devices'").get()
      ).toBeUndefined();
      expect(validateOptionalAPNSDeviceStorageEnvelope(db)).toEqual({ present: false, version: 1 });
    } finally {
      db.close();
    }
  });

  it('accepts the exact future APNs table concurrently without changing schema 2 or any row bytes', async () => {
    const seedStore = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    const user = await seedStore.createUser({
      email: 'apns-envelope@example.com',
      displayName: 'APNs Envelope',
      password: 'apns-envelope-password'
    });
    seedStore.close();

    let db = openDatabase(dbFile);
    installAPNSDeviceEnvelope(db);
    const insertDevice = db.prepare(`
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
    `);
    const nonce = Buffer.from('0102030405060708090a0b0c', 'hex');
    const authTag = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex');
    const fingerprint = Buffer.from('F'.repeat(32), 'utf8');

    expect(() => insertDevice.run(
      '10000000-0000-4000-8000-000000000000',
      user.id,
      'development',
      'C',
      'N'.repeat(12),
      'T'.repeat(16),
      'F'.repeat(32),
      '0.1.0 (1)',
      'en-US',
      fixedNow,
      fixedNow + 1
    )).toThrow(/CHECK constraint/i);
    expect(() => insertDevice.run(
      '10000000-0000-4000-8000-000000000000',
      user.id,
      'development',
      Buffer.from('00ff807f10aa', 'hex'),
      nonce,
      authTag,
      fingerprint,
      '0.1.0 (1)',
      'en-US',
      fixedNow + 0.5,
      fixedNow + 1.5
    )).toThrow(/CHECK constraint/i);

    insertDevice.run(
      '10000000-0000-4000-8000-000000000001',
      user.id,
      'development',
      Buffer.from('00ff807f10aa', 'hex'),
      nonce,
      authTag,
      fingerprint,
      '0.1.0 (1)',
      'en-US',
      fixedNow,
      fixedNow + 1
    );
    expect(() => insertDevice.run(
      '10000000-0000-4000-8000-000000000002',
      user.id,
      'development',
      Buffer.from('10aa', 'hex'),
      nonce,
      authTag,
      'F'.repeat(32),
      '0.1.0 (1)',
      'en-US',
      fixedNow,
      fixedNow + 1
    )).toThrow(/CHECK constraint/i);
    const beforeRows = apnsRows(db);
    const beforeMigrations = migrationRows(db);
    expect(validateOptionalAPNSDeviceStorageEnvelope(db)).toEqual({ present: true, version: 1 });
    db.close();

    const [first, second] = await Promise.all([
      createAccountStore({ filePath: dbFile, now: () => fixedNow + 2 }),
      createAccountStore({ filePath: dbFile, now: () => fixedNow + 3 })
    ]);
    expect(first.getSchemaVersion()).toBe(2);
    expect(second.getSchemaVersion()).toBe(2);
    expect(first.checkReadiness()).toBe(true);
    expect(second.checkReadiness()).toBe(true);
    first.close();
    second.close();

    db = openDatabase(dbFile);
    try {
      expect(migrationRows(db)).toEqual(beforeMigrations);
      expect(apnsRows(db)).toEqual(beforeRows);
      expect(validateOptionalAPNSDeviceStorageEnvelope(db)).toEqual({ present: true, version: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    [
      'partial table',
      (db: DatabaseSync) => {
        db.exec('DROP TABLE apns_devices; CREATE TABLE apns_devices (installation_id TEXT PRIMARY KEY)');
      }
    ],
    [
      'reserved view instead of the table',
      (db: DatabaseSync) => {
        db.exec('DROP TABLE apns_devices; CREATE VIEW apns_devices AS SELECT id AS installation_id FROM users');
      }
    ],
    [
      'reserved index while the table is absent',
      (db: DatabaseSync) => {
        db.exec('DROP TABLE apns_devices; CREATE INDEX idx_apns_devices_updated_at ON users(updated_at)');
      }
    ],
    [
      'missing unique index',
      (db: DatabaseSync) => db.exec('DROP INDEX idx_apns_devices_environment_token')
    ],
    [
      'widened table',
      (db: DatabaseSync) => db.exec('ALTER TABLE apns_devices ADD COLUMN plaintext_token TEXT')
    ],
    [
      'wrong foreign-key action',
      (db: DatabaseSync) => {
        db.exec(`
          DROP TABLE apns_devices;
          ${APNS_DEVICE_STORAGE_ENVELOPE.createTableSql.replace(' ON DELETE CASCADE', '')};
          ${APNS_DEVICE_STORAGE_ENVELOPE.indexes.map((index: { sql: string }) => index.sql).join(';\n')};
        `);
      }
    ],
    [
      'unexpected index',
      (db: DatabaseSync) => db.exec('CREATE INDEX idx_apns_devices_locale ON apns_devices(locale)')
    ],
    [
      'unexpected trigger',
      (db: DatabaseSync) => db.exec(`
        CREATE TRIGGER mutate_apns_device_after_insert
        AFTER INSERT ON apns_devices
        BEGIN
          UPDATE apns_devices SET locale = 'mutated' WHERE installation_id = NEW.installation_id;
        END
      `)
    ]
  ])('rejects a %s APNs envelope without changing the migration ledger', async (_label, corrupt) => {
    await createCurrentDatabase(dbFile);
    let db = openDatabase(dbFile);
    installAPNSDeviceEnvelope(db);
    corrupt(db);
    const beforeMigrations = migrationRows(db);
    db.close();

    await expect(createAccountStore({ filePath: dbFile, now: () => fixedNow + 1 }))
      .rejects.toThrow(/APNs device storage envelope/i);
    db = openDatabase(dbFile);
    try {
      expect(migrationRows(db)).toEqual(beforeMigrations);
    } finally {
      db.close();
    }
  });

  it('rejects an indirect account trigger before normal account activity can mutate APNs rows', async () => {
    const seedStore = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    const user = await seedStore.createUser({
      email: 'apns-trigger@example.com',
      displayName: 'APNs Trigger',
      password: 'apns-trigger-password'
    });
    seedStore.close();

    let db = openDatabase(dbFile);
    installAPNSDeviceEnvelope(db);
    db.prepare(`
      INSERT INTO apns_devices (
        installation_id, user_id, environment, token_ciphertext, token_nonce,
        token_auth_tag, token_fingerprint, app_version, locale, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '10000000-0000-4000-8000-000000000003',
      user.id,
      'development',
      Buffer.from('0102', 'hex'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      Buffer.alloc(32, 3),
      '0.1.0 (1)',
      'en-US',
      fixedNow,
      fixedNow + 1
    );
    db.exec(`
      CREATE TRIGGER delete_apns_after_user_update
      AFTER UPDATE ON users
      BEGIN
        DELETE FROM apns_devices;
      END
    `);
    const beforeRows = apnsRows(db);
    db.close();

    await expect(createAccountStore({ filePath: dbFile, now: () => fixedNow + 2 }))
      .rejects.toThrow(/APNs device storage envelope/i);
    db = openDatabase(dbFile);
    try {
      expect(apnsRows(db)).toEqual(beforeRows);
    } finally {
      db.close();
    }
  });

  it('degrades readiness if the exact optional envelope changes after startup', async () => {
    const seed = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    seed.close();
    const db = openDatabase(dbFile);
    installAPNSDeviceEnvelope(db);
    db.close();

    const store = await createAccountStore({ filePath: dbFile, now: () => fixedNow + 1 });
    expect(store.checkReadiness()).toBe(true);
    store.db.exec(`
      CREATE TRIGGER unexpected_user_trigger
      AFTER UPDATE ON users
      BEGIN
        SELECT 1;
      END
    `);
    expect(store.checkReadiness()).toBe(false);
    store.db.exec('DROP TRIGGER unexpected_user_trigger');
    expect(store.checkReadiness()).toBe(true);
    store.db.exec('DROP INDEX idx_apns_devices_updated_at');
    expect(store.checkReadiness()).toBe(false);
    const retentionIndex = APNS_DEVICE_STORAGE_ENVELOPE.indexes.find(
      (index: { name: string }) => index.name === 'idx_apns_devices_updated_at'
    );
    if (!retentionIndex) throw new Error('Frozen APNs retention index is missing.');
    store.db.exec(retentionIndex.sql);
    expect(store.checkReadiness()).toBe(true);
    store.close();
  });

  it('adopts an unversioned legacy database without losing account data', async () => {
    let store = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    const user = await store.createUser({ email: 'ada@example.com', displayName: 'Ada', password: 'ada-secret-123' });
    store.close();
    downgradeCurrentDatabase(dbFile);

    store = await createAccountStore({ filePath: dbFile, now: () => fixedNow });
    expect(store.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect((await store.authenticate('ada@example.com', 'ada-secret-123')).id).toBe(user.id);
    store.close();
  });

  it('upgrades a checksummed version-one database and reopens version two idempotently', async () => {
    await createCurrentDatabase(dbFile);
    downgradeCurrentDatabase(dbFile);
    const db = openDatabase(dbFile);
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `);
      const migration = SCHEMA_MIGRATIONS[0];
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum, fixedNow);
    } finally {
      db.close();
    }

    let store = await createAccountStore({ filePath: dbFile, now: () => fixedNow + 1 });
    expect(store.getSchemaVersion()).toBe(2);
    store.close();
    store = await createAccountStore({ filePath: dbFile, now: () => fixedNow + 2 });
    expect(store.getSchemaVersion()).toBe(2);
    store.close();
  });

  it.each([
    ['checksum', (db: DatabaseSync) => db.prepare("UPDATE schema_migrations SET checksum = '0' WHERE version = 1").run()],
    ['gap', (db: DatabaseSync) => db.prepare('DELETE FROM schema_migrations WHERE version = 1').run()],
    [
      'future',
      (db: DatabaseSync) =>
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (3, ?, ?, ?)')
          .run('future', 'f'.repeat(64), fixedNow)
    ]
  ])('rejects a %s migration history without changing it', async (_label, corrupt) => {
    await createCurrentDatabase(dbFile);
    let db = openDatabase(dbFile);
    corrupt(db);
    const before = migrationRows(db);
    db.close();

    await expect(createAccountStore({ filePath: dbFile, now: () => fixedNow + 1 })).rejects.toThrow();
    db = openDatabase(dbFile);
    try {
      expect(migrationRows(db)).toEqual(before);
      expect(columnNames(db, 'games')).toContain('finished_by_ai');
    } finally {
      db.close();
    }
  });

  it('rejects partial version-two artifacts instead of blessing them with a migration row', async () => {
    await createCurrentDatabase(dbFile);
    let db = openDatabase(dbFile);
    db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    db.close();

    await expect(createAccountStore({ filePath: dbFile })).rejects.toThrow(/partially applied/i);
    db = openDatabase(dbFile);
    try {
      expect(migrationRows(db)).toHaveLength(1);
      expect(columnNames(db, 'games')).toContain('finished_by_ai');
    } finally {
      db.close();
    }
  });

  it('rolls back ledger creation when an unversioned baseline is corrupt', async () => {
    let db = openDatabase(dbFile);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.close();

    await expect(createAccountStore({ filePath: dbFile })).rejects.toThrow(/baseline schema/i);
    db = openDatabase(dbFile);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      expect(tables).toEqual([{ name: 'users' }]);
    } finally {
      db.close();
    }
  });
});
