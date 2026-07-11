import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createAccountStore,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS
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
        'redeemed_at'
      ]);
      expect(columnNames(db, 'invite_codes')).not.toEqual(expect.arrayContaining(['code', 'invite_token']));
    } finally {
      db.close();
    }
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
