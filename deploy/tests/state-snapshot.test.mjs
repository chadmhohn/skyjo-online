import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  backupWithKeepAlive,
  createPredeploySnapshot,
  materializePredeploySnapshot,
  PREDEPLOY_SNAPSHOT_FILES,
  verifyPredeploySnapshot
} from '../state-snapshot-lib.mjs';

const releaseSha = 'a'.repeat(40);

test('SQLite backup keepalive is referenced only during backup and always cleaned up', async () => {
  for (const failure of [null, new Error('injected backup failure')]) {
    const calls = [];
    const database = { close: () => calls.push('close') };
    const timer = { ref: () => calls.push('ref') };
    const operation = backupWithKeepAlive('/source.sqlite', '/backup.sqlite', {
      openDatabase: () => { calls.push('open'); return database; },
      setIntervalImpl: (callback, milliseconds) => {
        assert.equal(typeof callback, 'function');
        assert.equal(milliseconds, 60_000);
        calls.push('set');
        return timer;
      },
      clearIntervalImpl: (value) => { assert.equal(value, timer); calls.push('clear'); },
      backupImpl: async (value, destination) => {
        assert.equal(value, database);
        assert.equal(destination, '/backup.sqlite');
        calls.push('backup');
        if (failure) throw failure;
        return 'complete';
      }
    });
    if (failure) await assert.rejects(operation, (error) => error === failure);
    else assert.equal(await operation, 'complete');
    assert.deepEqual(calls, ['open', 'set', 'ref', 'backup', 'clear', 'close']);
  }
});

test('SQLite backup closes its database even when keepalive setup or cleanup fails', async () => {
  for (const stage of ['set', 'clear']) {
    const failure = new Error(`injected ${stage} failure`);
    let closed = 0;
    await assert.rejects(backupWithKeepAlive('/source.sqlite', '/backup.sqlite', {
      openDatabase: () => ({ close: () => { closed += 1; } }),
      setIntervalImpl: () => {
        if (stage === 'set') throw failure;
        return { ref() {} };
      },
      clearIntervalImpl: () => { throw failure; },
      backupImpl: async () => 'complete'
    }), (error) => error === failure);
    assert.equal(closed, 1);
  }
});

async function fixture({ rooms = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-predeploy-test-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const databasePath = path.join(source, 'skyjo.sqlite');
  const roomsPath = path.join(source, 'rooms.json');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE games (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    INSERT INTO users (id, email) VALUES ('one', 'one@example.test');
  `);
  await fs.writeFile(roomsPath, `${JSON.stringify(rooms)}\n`);
  return { root, source, database, databasePath, roomsPath };
}

test('schema-neutral snapshot captures and restores the live legacy database without migration history', async () => {
  const value = await fixture({ rooms: [{ code: 'OLD' }] });
  try {
    const snapshot = path.join(value.root, 'snapshot');
    const manifest = await createPredeploySnapshot({
      databasePath: value.databasePath,
      roomsPath: value.roomsPath,
      destinationDirectory: snapshot,
      source: { releaseSha, legacy: true },
      now: '2026-07-11T00:00:00.000Z'
    });
    assert.deepEqual(manifest.source, { releaseSha, legacy: true });
    assert.equal(manifest.database.migrationVersion, null);
    assert.deepEqual(manifest.database.tables, ['games', 'users']);
    assert.deepEqual(manifest.rooms, { shape: 'legacy-array', version: 0, protocolVersion: null, roomCount: 1 });
    assert.deepEqual((await fs.readdir(snapshot)).sort(), Object.values(PREDEPLOY_SNAPSHOT_FILES).sort());

    const restored = path.join(value.root, 'restored');
    await materializePredeploySnapshot(snapshot, restored);
    const restoredDatabase = new DatabaseSync(path.join(restored, 'skyjo.sqlite'), { readOnly: true });
    try {
      assert.equal(restoredDatabase.prepare('SELECT email FROM users WHERE id = ?').get('one').email, 'one@example.test');
    } finally {
      restoredDatabase.close();
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(restored, 'rooms.json'), 'utf8')), [{ code: 'OLD' }]);
  } finally {
    value.database.close();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('previous-schema snapshot accepts contiguous known history without requiring the candidate schema', async () => {
  const value = await fixture({ rooms: { version: 1, savedAt: 1, rooms: [] } });
  try {
    value.database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    value.database.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(1, 'previous-schema', 'b'.repeat(64), 1);
    const snapshot = path.join(value.root, 'snapshot');
    const manifest = await createPredeploySnapshot({
      databasePath: value.databasePath,
      roomsPath: value.roomsPath,
      destinationDirectory: snapshot,
      source: { releaseSha, legacy: false }
    });
    assert.equal(manifest.database.migrationVersion, 1);
    assert.deepEqual(manifest.rooms, { shape: 'object', version: 1, protocolVersion: null, roomCount: 0 });
  } finally {
    value.database.close();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('root snapshot stays schema-neutral for protocol two and future room envelope versions', async () => {
  const value = await fixture({ rooms: [] });
  try {
    for (const [version, protocolVersion] of [[2, 2], [3, 7]]) {
      await fs.writeFile(value.roomsPath, `${JSON.stringify({
        format: 'skyjo-rooms',
        version,
        protocolVersion,
        savedAt: 1,
        rooms: []
      })}\n`);
      const snapshot = path.join(value.root, `snapshot-${version}`);
      const manifest = await createPredeploySnapshot({
        databasePath: value.databasePath,
        roomsPath: value.roomsPath,
        destinationDirectory: snapshot,
        source: { releaseSha, legacy: false }
      });
      assert.deepEqual(manifest.rooms, { shape: 'object', version, protocolVersion, roomCount: 0 });
    }
  } finally {
    value.database.close();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('snapshot verification rejects tampering, malformed history, unsafe rooms, and reused destinations', async () => {
  const value = await fixture();
  try {
    const malformedDatabase = new DatabaseSync(value.databasePath);
    malformedDatabase.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER)`);
    malformedDatabase.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(2, 'gap', 'c'.repeat(64), 1);
    malformedDatabase.close();
    await assert.rejects(
      createPredeploySnapshot({
        databasePath: value.databasePath,
        roomsPath: value.roomsPath,
        destinationDirectory: path.join(value.root, 'bad-history'),
        source: { releaseSha, legacy: false }
      }),
      /malformed|discontinuous/i
    );

    value.database.close();
    const clean = new DatabaseSync(value.databasePath);
    clean.exec('DROP TABLE schema_migrations');
    clean.close();
    const snapshot = path.join(value.root, 'snapshot');
    await createPredeploySnapshot({
      databasePath: value.databasePath,
      roomsPath: value.roomsPath,
      destinationDirectory: snapshot,
      source: { releaseSha, legacy: true }
    });
    await fs.appendFile(path.join(snapshot, 'rooms.json'), ' ');
    await assert.rejects(verifyPredeploySnapshot(snapshot), /checksum/i);
    await assert.rejects(materializePredeploySnapshot(snapshot, path.join(value.root, 'restore')), /checksum/i);

    await fs.writeFile(value.roomsPath, '{"format":"skyjo-rooms","rooms":[]}\n');
    await assert.rejects(
      createPredeploySnapshot({
        databasePath: value.databasePath,
        roomsPath: value.roomsPath,
        destinationDirectory: path.join(value.root, 'bad-rooms'),
        source: { releaseSha, legacy: true }
      }),
      /missing a version/i
    );
    assert.equal((await fs.readdir(value.root)).some((name) => name.startsWith('bad-rooms.tmp-')), false);
  } finally {
    try { value.database.close(); } catch {}
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('snapshot sources and destinations reject symlink path components', async (context) => {
  const value = await fixture();
  try {
    const linked = path.join(value.root, 'linked-source');
    try {
      await fs.symlink(value.source, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        context.skip('symlink creation is unavailable');
        return;
      }
      throw error;
    }
    await assert.rejects(
      createPredeploySnapshot({
        databasePath: path.join(linked, 'skyjo.sqlite'),
        roomsPath: path.join(linked, 'rooms.json'),
        destinationDirectory: path.join(value.root, 'snapshot'),
        source: { releaseSha, legacy: true }
      }),
      /symbolic link/i
    );
  } finally {
    value.database.close();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});
