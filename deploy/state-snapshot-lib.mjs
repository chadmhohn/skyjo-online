import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const PREDEPLOY_SNAPSHOT_FORMAT = 'skyjo-predeploy-snapshot';
export const PREDEPLOY_SNAPSHOT_VERSION = 1;
export const PREDEPLOY_SNAPSHOT_FILES = Object.freeze({
  database: 'skyjo.sqlite',
  rooms: 'rooms.json',
  manifest: 'manifest.json'
});

const payloadNames = Object.freeze([PREDEPLOY_SNAPSHOT_FILES.database, PREDEPLOY_SNAPSHOT_FILES.rooms]);
const allNames = Object.freeze([...payloadNames, PREDEPLOY_SNAPSHOT_FILES.manifest]);
const fullShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const maxRoomsBytes = 64 * 1024 * 1024;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function resolveSafe(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label} cannot be a filesystem root.`);
  return resolved;
}

async function lstatOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoLinkedPathComponents(targetPath, { allowMissingLeaf = false } = {}) {
  const resolved = path.resolve(targetPath);
  const { root } = path.parse(resolved);
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (allowMissingLeaf && index === segments.length - 1) return;
      throw new Error(`Snapshot path component is missing: ${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Snapshot path contains a symbolic link: ${current}`);
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fs.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function regularFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return stat;
}

async function freshDirectory(directoryPath, mode = 0o700) {
  const resolved = resolveSafe(directoryPath, 'Destination directory');
  const parent = path.dirname(resolved);
  await assertNoLinkedPathComponents(parent);
  await assertNoLinkedPathComponents(resolved, { allowMissingLeaf: true });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Destination parent is unsafe.');
  await fs.mkdir(resolved, { mode });
  await fs.chmod(resolved, mode);
  return resolved;
}

async function openNoFollow(filePath) {
  const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
  return fs.open(filePath, flags);
}

async function copyRegularFile(sourcePath, destinationPath) {
  await regularFile(sourcePath, 'Snapshot source');
  const source = await openNoFollow(sourcePath);
  const destination = await fs.open(destinationPath, 'wx', 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await destination.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    await destination.sync();
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
  await fs.chmod(destinationPath, 0o600);
}

async function writePrivateFile(filePath, data) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
}

async function digestFile(filePath) {
  const handle = await openNoFollow(filePath);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest('hex') };
}

function inspectDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity verification failed.');
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('SQLite foreign-key verification failed.');
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const hasMigrations = tables.includes('schema_migrations');
    let migrationVersion = null;
    if (hasMigrations) {
      const rows = database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
      if (rows.length === 0) throw new Error('SQLite migration history is empty.');
      rows.forEach((row, index) => {
        if (
          row.version !== index + 1 ||
          typeof row.name !== 'string' || row.name.length === 0 ||
          typeof row.checksum !== 'string' || !digestPattern.test(row.checksum) ||
          !Number.isSafeInteger(row.applied_at) || row.applied_at < 0
        ) {
          throw new Error('SQLite migration history is malformed or discontinuous.');
        }
      });
      migrationVersion = rows.at(-1).version;
    }
    return { integrityCheck: 'ok', foreignKeyCheck: 'ok', migrationVersion, tables };
  } finally {
    database.close();
  }
}

function normalizeSnapshotDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    const journal = database.prepare('PRAGMA journal_mode = DELETE').get();
    if (String(journal?.journal_mode || '').toLowerCase() !== 'delete') {
      throw new Error('Snapshot database journal mode could not be normalized.');
    }
  } finally {
    database.close();
  }
}

async function inspectRooms(roomsPath) {
  const stat = await regularFile(roomsPath, 'Room-state snapshot');
  if (stat.size > maxRoomsBytes) throw new Error('Room-state snapshot exceeds the size limit.');
  const handle = await openNoFollow(roomsPath);
  let document;
  try {
    document = JSON.parse(await handle.readFile('utf8'));
  } catch {
    throw new Error('Room-state snapshot is not valid JSON.');
  } finally {
    await handle.close();
  }
  if (!Array.isArray(document) && !isRecord(document)) throw new Error('Room-state snapshot has an invalid top-level shape.');
  let version = 0;
  let protocolVersion = null;
  if (!Array.isArray(document)) {
    if (!Array.isArray(document.rooms)) throw new Error('Room-state snapshot is missing its rooms array.');
    if (Object.hasOwn(document, 'version')) {
      if (!Number.isSafeInteger(document.version) || document.version < 1) {
        throw new Error('Room-state snapshot version is unsupported.');
      }
      version = document.version;
      if (version >= 2 && (
        document.format !== 'skyjo-rooms' ||
        !Number.isSafeInteger(document.protocolVersion) || document.protocolVersion < 1 ||
        !Object.hasOwn(document, 'savedAt')
      )) {
        throw new Error('Current room-state snapshot metadata is invalid.');
      }
      if (version === 1 && document.protocolVersion !== undefined && (
        !Number.isSafeInteger(document.protocolVersion) || document.protocolVersion < 1
      )) {
        throw new Error('Legacy room-state snapshot protocol is unsupported.');
      }
      protocolVersion = Number.isSafeInteger(document.protocolVersion) ? document.protocolVersion : null;
    } else if (Object.hasOwn(document, 'format') || Object.hasOwn(document, 'protocolVersion')) {
      throw new Error('Versioned room-state metadata is missing a version.');
    }
  }
  const rooms = Array.isArray(document) ? document : document.rooms;
  return {
    shape: Array.isArray(document) ? 'legacy-array' : 'object',
    version,
    protocolVersion,
    roomCount: rooms.length
  };
}

function normalizeSource(source) {
  if (!hasExactKeys(source, ['releaseSha', 'legacy']) || !fullShaPattern.test(source.releaseSha) || typeof source.legacy !== 'boolean') {
    throw new Error('Snapshot source metadata is invalid.');
  }
  return { releaseSha: source.releaseSha, legacy: source.legacy };
}

function normalizeManifest(value) {
  if (!hasExactKeys(value, ['format', 'formatVersion', 'createdAt', 'source', 'database', 'rooms', 'files'])) {
    throw new Error('Pre-deployment snapshot manifest shape is invalid.');
  }
  if (value.format !== PREDEPLOY_SNAPSHOT_FORMAT || value.formatVersion !== PREDEPLOY_SNAPSHOT_VERSION) {
    throw new Error('Pre-deployment snapshot format is unsupported.');
  }
  if (typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error('Pre-deployment snapshot timestamp is invalid.');
  }
  const source = normalizeSource(value.source);
  if (
    !hasExactKeys(value.database, ['integrityCheck', 'foreignKeyCheck', 'migrationVersion', 'tables']) ||
    value.database.integrityCheck !== 'ok' || value.database.foreignKeyCheck !== 'ok' ||
    (value.database.migrationVersion !== null && (!Number.isSafeInteger(value.database.migrationVersion) || value.database.migrationVersion < 1)) ||
    !Array.isArray(value.database.tables) || value.database.tables.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error('Pre-deployment snapshot database metadata is invalid.');
  }
  if (
    !hasExactKeys(value.rooms, ['shape', 'version', 'protocolVersion', 'roomCount']) ||
    !['legacy-array', 'object'].includes(value.rooms.shape) ||
    !Number.isSafeInteger(value.rooms.version) || value.rooms.version < 0 ||
    (value.rooms.protocolVersion !== null && (!Number.isSafeInteger(value.rooms.protocolVersion) || value.rooms.protocolVersion < 1)) ||
    !Number.isSafeInteger(value.rooms.roomCount) || value.rooms.roomCount < 0
  ) {
    throw new Error('Pre-deployment snapshot room metadata is invalid.');
  }
  if (!Array.isArray(value.files) || value.files.length !== payloadNames.length) throw new Error('Snapshot file manifest is incomplete.');
  const seen = new Set();
  const files = value.files.map((entry) => {
    if (
      !hasExactKeys(entry, ['name', 'size', 'sha256']) || !payloadNames.includes(entry.name) || seen.has(entry.name) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || !digestPattern.test(entry.sha256)
    ) {
      throw new Error('Snapshot file manifest entry is invalid.');
    }
    seen.add(entry.name);
    return { name: entry.name, size: entry.size, sha256: entry.sha256 };
  });
  if (payloadNames.some((name) => !seen.has(name))) throw new Error('Snapshot file manifest is incomplete.');
  return {
    format: value.format,
    formatVersion: value.formatVersion,
    createdAt: value.createdAt,
    source,
    database: { ...value.database, tables: [...value.database.tables] },
    rooms: { ...value.rooms },
    files
  };
}

async function readManifest(snapshotDirectory) {
  const manifestPath = path.join(snapshotDirectory, PREDEPLOY_SNAPSHOT_FILES.manifest);
  const stat = await regularFile(manifestPath, 'Snapshot manifest');
  if (stat.size > 64 * 1024) throw new Error('Snapshot manifest exceeds the size limit.');
  return normalizeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
}

async function assertExactEntries(snapshotDirectory) {
  const entries = await fs.readdir(snapshotDirectory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== allNames.length || names.some((name, index) => name !== [...allNames].sort()[index])) {
    throw new Error(`Snapshot directory contains missing or unexpected entries: ${names.join(', ')}.`);
  }
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) throw new Error('Snapshot entries must be regular files.');
}

async function assertPrivateOwnership(targetPath, stat, options, label) {
  if (options.expectedOwnerUid !== undefined && stat.uid !== options.expectedOwnerUid) throw new Error(`${label} owner UID is invalid.`);
  if (options.expectedOwnerGid !== undefined && stat.gid !== options.expectedOwnerGid) throw new Error(`${label} owner GID is invalid.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are too broad.`);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  return targetPath;
}

export async function verifyPredeploySnapshot(snapshotDirectory, options = {}) {
  const resolved = resolveSafe(snapshotDirectory, 'Snapshot directory');
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Snapshot path must be a real directory.');
  await assertPrivateOwnership(resolved, stat, options, 'Snapshot directory');
  await assertExactEntries(resolved);
  for (const name of allNames) {
    const filePath = path.join(resolved, name);
    await assertPrivateOwnership(filePath, await fs.lstat(filePath), options, `Snapshot file ${name}`);
  }
  const manifest = await readManifest(resolved);
  for (const expected of manifest.files) {
    const actual = await digestFile(path.join(resolved, expected.name));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`Snapshot checksum mismatch: ${expected.name}`);
  }
  const database = inspectDatabase(path.join(resolved, PREDEPLOY_SNAPSHOT_FILES.database));
  const rooms = await inspectRooms(path.join(resolved, PREDEPLOY_SNAPSHOT_FILES.rooms));
  if (JSON.stringify(database) !== JSON.stringify(manifest.database) || JSON.stringify(rooms) !== JSON.stringify(manifest.rooms)) {
    throw new Error('Snapshot semantic metadata does not match its payload.');
  }
  return manifest;
}

export async function createPredeploySnapshot({
  databasePath,
  roomsPath,
  destinationDirectory,
  source,
  now = new Date(),
  expectedOwnerUid,
  expectedOwnerGid
}) {
  const databaseSource = resolveSafe(databasePath, 'SQLite source path');
  const roomsSource = resolveSafe(roomsPath, 'Room-state source path');
  const destination = resolveSafe(destinationDirectory, 'Snapshot destination');
  await Promise.all([
    assertNoLinkedPathComponents(databaseSource),
    assertNoLinkedPathComponents(roomsSource),
    assertNoLinkedPathComponents(path.dirname(destination)),
    assertNoLinkedPathComponents(destination, { allowMissingLeaf: true }),
    regularFile(databaseSource, 'SQLite source'),
    regularFile(roomsSource, 'Room-state source')
  ]);
  const normalizedSource = normalizeSource(source);
  const parsedTime = new Date(now);
  if (!Number.isFinite(parsedTime.getTime())) throw new Error('Snapshot time is invalid.');
  const timestamp = parsedTime.toISOString();
  const staging = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await freshDirectory(staging);
  try {
    const sourceDatabase = new DatabaseSync(databaseSource, { readOnly: true });
    try {
      await backup(sourceDatabase, path.join(staging, PREDEPLOY_SNAPSHOT_FILES.database));
    } finally {
      sourceDatabase.close();
    }
    normalizeSnapshotDatabase(path.join(staging, PREDEPLOY_SNAPSHOT_FILES.database));
    await Promise.all([
      fs.rm(path.join(staging, `${PREDEPLOY_SNAPSHOT_FILES.database}-wal`), { force: true }),
      fs.rm(path.join(staging, `${PREDEPLOY_SNAPSHOT_FILES.database}-shm`), { force: true })
    ]);
    await fs.chmod(path.join(staging, PREDEPLOY_SNAPSHOT_FILES.database), 0o600);
    await copyRegularFile(roomsSource, path.join(staging, PREDEPLOY_SNAPSHOT_FILES.rooms));
    const database = inspectDatabase(path.join(staging, PREDEPLOY_SNAPSHOT_FILES.database));
    const rooms = await inspectRooms(path.join(staging, PREDEPLOY_SNAPSHOT_FILES.rooms));
    const files = [];
    for (const name of payloadNames) files.push({ name, ...(await digestFile(path.join(staging, name))) });
    await writePrivateFile(path.join(staging, PREDEPLOY_SNAPSHOT_FILES.manifest), `${JSON.stringify({
      format: PREDEPLOY_SNAPSHOT_FORMAT,
      formatVersion: PREDEPLOY_SNAPSHOT_VERSION,
      createdAt: timestamp,
      source: normalizedSource,
      database,
      rooms,
      files
    }, null, 2)}\n`);
    await syncDirectory(staging);
    await verifyPredeploySnapshot(staging, { expectedOwnerUid, expectedOwnerGid });
    await fs.rename(staging, destination);
    await fs.chmod(destination, 0o700);
    await syncDirectory(destination);
    await syncDirectory(path.dirname(destination));
    return verifyPredeploySnapshot(destination, { expectedOwnerUid, expectedOwnerGid });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function materializePredeploySnapshot(snapshotDirectory, destinationDirectory, options = {}) {
  const snapshot = resolveSafe(snapshotDirectory, 'Snapshot directory');
  const destination = resolveSafe(destinationDirectory, 'Snapshot restore destination');
  await assertNoLinkedPathComponents(snapshot);
  await assertNoLinkedPathComponents(path.dirname(destination));
  await assertNoLinkedPathComponents(destination, { allowMissingLeaf: true });
  const manifest = await verifyPredeploySnapshot(snapshot, options);
  await freshDirectory(destination);
  try {
    await copyRegularFile(path.join(snapshot, PREDEPLOY_SNAPSHOT_FILES.database), path.join(destination, PREDEPLOY_SNAPSHOT_FILES.database));
    await copyRegularFile(path.join(snapshot, PREDEPLOY_SNAPSHOT_FILES.rooms), path.join(destination, PREDEPLOY_SNAPSHOT_FILES.rooms));
    await syncDirectory(destination);
    return { destinationDirectory: destination, manifest };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
