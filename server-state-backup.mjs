import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const STATE_BACKUP_FORMAT = 'skyjo-state-backup';
export const STATE_BACKUP_FORMAT_VERSION = 1;
export const STATE_BACKUP_FILES = Object.freeze({
  database: 'skyjo.sqlite',
  rooms: 'rooms.json',
  release: 'release.json',
  manifest: 'manifest.json'
});

const payloadFileNames = Object.freeze([
  STATE_BACKUP_FILES.database,
  STATE_BACKUP_FILES.rooms,
  STATE_BACKUP_FILES.release
]);
const allBackupFileNames = Object.freeze([...payloadFileNames, STATE_BACKUP_FILES.manifest]);
const allowedRoomStatuses = new Set(['waiting', 'playing', 'finished']);
const maxManifestBytes = 64 * 1024;
const maxJsonStateBytes = 64 * 1024 * 1024;
const fileMode = 0o600;
const directoryMode = 0o700;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function errorWithCode(message, code = 'INVALID_STATE_BACKUP') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolvedPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw errorWithCode(`${label} is required.`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw errorWithCode(`${label} cannot be a filesystem root.`);
  return resolved;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathContains(parentPath, childPath) {
  const parent = comparablePath(parentPath);
  const child = comparablePath(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function assertSafeFixedBasename(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw errorWithCode('Backup manifest file names must be non-empty strings.');
  }
  if (
    path.isAbsolute(name) ||
    path.win32.isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.startsWith('\\\\') ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    path.posix.basename(name) !== name ||
    path.win32.basename(name) !== name
  ) {
    throw errorWithCode(`Backup manifest contains an unsafe file name: ${JSON.stringify(name)}.`);
  }
  if (!payloadFileNames.includes(name)) {
    throw errorWithCode(`Backup manifest contains a non-allowlisted file name: ${JSON.stringify(name)}.`);
  }
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
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
      if (allowMissingLeaf) return;
      throw errorWithCode(`Required path does not exist: ${current}.`, 'STATE_BACKUP_PATH_MISSING');
    }
    if (stat.isSymbolicLink()) {
      throw errorWithCode(`Symbolic links and junctions are not allowed in state backup paths: ${current}.`);
    }
  }
}

async function assertRegularFile(filePath, label) {
  const stat = await lstatOrNull(filePath);
  if (!stat) throw errorWithCode(`${label} is missing.`, 'STATE_BACKUP_PATH_MISSING');
  if (stat.isSymbolicLink()) throw errorWithCode(`${label} cannot be a symbolic link or junction.`);
  if (!stat.isFile()) throw errorWithCode(`${label} must be a regular file.`);
  return stat;
}

async function openVerifiedRegularFile(filePath, label) {
  const before = await assertRegularFile(filePath, label);
  const handle = await fs.open(filePath, fsConstants.constants.O_RDONLY);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw errorWithCode(`${label} changed while it was being opened.`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function enforceMode(filePath, mode) {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    if (process.platform === 'win32' && ['EINVAL', 'ENOSYS', 'EPERM'].includes(error?.code)) return;
    throw error;
  }
}

async function readBoundedJson(filePath, label, maximumBytes = maxJsonStateBytes) {
  const stat = await assertRegularFile(filePath, label);
  if (stat.size > maximumBytes) throw errorWithCode(`${label} exceeds the maximum supported size.`);
  const handle = await openVerifiedRegularFile(filePath, label);
  try {
    const data = await handle.readFile({ encoding: 'utf8' });
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw errorWithCode(`${label} is not valid JSON.`);
    }
    return { data, parsed };
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(filePath, data) {
  const handle = await fs.open(filePath, 'wx', fileMode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await enforceMode(filePath, fileMode);
}

async function copyPrivateFile(sourcePath, destinationPath, label) {
  const source = await openVerifiedRegularFile(sourcePath, label);
  const destination = await fs.open(destinationPath, 'wx', fileMode);
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
  await enforceMode(destinationPath, fileMode);
}

async function fileDigest(filePath, label) {
  const handle = await openVerifiedRegularFile(filePath, label);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let size = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest('hex') };
}

function requireValidatorResult(result, label) {
  if (result === false) throw errorWithCode(`${label} failed validation.`);
  return result;
}

async function validateJsonFile(filePath, label, validator) {
  const { parsed } = await readBoundedJson(filePath, label);
  const validation = requireValidatorResult(await validator(parsed, { filePath, label }), label);
  return { document: parsed, validation };
}

function validateRoomPlayer(player) {
  if (!isRecord(player)) return false;
  if (typeof player.id !== 'string' || player.id.trim() === '') return false;
  if (typeof player.name !== 'string' || player.name.trim() === '') return false;
  if ('userId' in player && player.userId !== undefined && typeof player.userId !== 'string') return false;
  if ('connected' in player && typeof player.connected !== 'boolean') return false;
  if ('host' in player && typeof player.host !== 'boolean') return false;
  return true;
}

function validateRoom(room) {
  if (!isRecord(room)) return false;
  if (typeof room.code !== 'string' || !/^[A-Z0-9]{5}$/.test(room.code)) return false;
  if (typeof room.hostId !== 'string' || room.hostId.trim() === '') return false;
  if (!allowedRoomStatuses.has(room.status)) return false;
  if (!Number.isFinite(room.updatedAt)) return false;
  if (!Array.isArray(room.players) || room.players.length < 1 || room.players.length > 8) return false;
  if (!room.players.every(validateRoomPlayer)) return false;
  if (!room.players.some((player) => player.id === room.hostId)) return false;
  if (!Array.isArray(room.chatMessages) || !Array.isArray(room.readyForNextRoundPlayerIds)) return false;
  if (!(room.state === null || isRecord(room.state))) return false;
  return true;
}

export function validateRoomsBackupDocument(value) {
  if (!isRecord(value)) return false;
  const isVersionOne = value.version === 1 && hasExactKeys(value, ['version', 'savedAt', 'rooms']);
  const isVersionTwo =
    value.version === 2 && hasExactKeys(value, ['format', 'version', 'protocolVersion', 'savedAt', 'rooms']);
  if (!isVersionOne && !isVersionTwo) return false;
  if (isVersionTwo && (typeof value.format !== 'string' || value.format.trim() === '' || value.format.length > 64)) return false;
  if (isVersionTwo && (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1)) return false;
  if (![1, 2].includes(value.version) || !Number.isFinite(value.savedAt) || !Array.isArray(value.rooms)) return false;
  if (value.rooms.length > 10_000) return false;
  return value.rooms.every(validateRoom);
}

export function validateReleaseBackupDocument(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['formatVersion', 'releaseSha', 'buildTimestamp', 'schemaVersion', 'protocolVersion'])
  ) {
    return false;
  }
  if (value.formatVersion !== 1) return false;
  if (value.releaseSha !== 'development' && !/^[a-f0-9]{7,64}$/.test(value.releaseSha)) return false;
  if (
    typeof value.buildTimestamp !== 'string' ||
    Number.isNaN(Date.parse(value.buildTimestamp)) ||
    new Date(value.buildTimestamp).toISOString() !== value.buildTimestamp
  ) {
    return false;
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) return false;
  if (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) return false;
  return true;
}

function readMigrationRows(database) {
  const migrationTable = database
    .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!migrationTable?.found) throw errorWithCode('SQLite schema migration history is missing.');
  return database.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
}

export function validateSchemaMigrationHistory(database) {
  const rows = readMigrationRows(database);
  if (rows.length < 1) throw errorWithCode('SQLite schema migration history is empty.');
  rows.forEach((row, index) => {
    if (row.version !== index + 1) throw errorWithCode('SQLite schema migration history is not contiguous.');
    if (typeof row.name !== 'string' || row.name.trim() === '') {
      throw errorWithCode('SQLite schema migration name is invalid.');
    }
    if (typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum)) {
      throw errorWithCode('SQLite schema migration checksum is invalid.');
    }
    if (!Number.isSafeInteger(row.applied_at) || row.applied_at < 0) {
      throw errorWithCode('SQLite schema migration timestamp is invalid.');
    }
  });
  return { schemaVersion: rows.at(-1).version, migrations: rows };
}

export function inspectSqliteState(filePath, options = {}) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrityCheck = database.prepare('PRAGMA integrity_check').all();
    if (integrityCheck.length !== 1 || integrityCheck[0].integrity_check !== 'ok') {
      throw errorWithCode('SQLite integrity verification failed.');
    }
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length > 0) throw errorWithCode('SQLite foreign-key verification failed.');
    const migrationState = validateSchemaMigrationHistory(database);
    const schemaValidator = options.validateSchema;
    if (schemaValidator) {
      const result = schemaValidator(database, {
        filePath,
        label: options.label || 'SQLite database',
        schemaVersion: migrationState.schemaVersion,
        migrations: migrationState.migrations.map((row) => ({ ...row }))
      });
      if (result && typeof result.then === 'function') {
        throw errorWithCode('SQLite schema validator must be synchronous while the read-only database is open.');
      }
      requireValidatorResult(result, 'SQLite schema migration history');
    }
    return {
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
      schemaVersion: migrationState.schemaVersion
    };
  } catch (error) {
    if (error?.code === 'INVALID_STATE_BACKUP') throw error;
    throw errorWithCode(`SQLite integrity verification failed: ${error?.message || 'unknown SQLite error'}.`);
  } finally {
    database.close();
  }
}

async function validateSqliteFile(filePath, label, options = {}) {
  await assertRegularFile(filePath, label);
  try {
    return inspectSqliteState(filePath, { ...options, label });
  } catch (error) {
    if (error?.code === 'INVALID_STATE_BACKUP') throw error;
    throw errorWithCode(`${label} failed SQLite validation.`);
  }
}

function normalizeManifestMetadata(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'releaseSha', 'buildTimestamp', 'protocolVersion', 'database', 'rooms'])
  ) {
    throw errorWithCode('Backup manifest metadata has an invalid shape.');
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw errorWithCode('Backup manifest schema version is invalid.');
  }
  if (value.releaseSha !== 'development' && !/^[a-f0-9]{7,64}$/.test(value.releaseSha)) {
    throw errorWithCode('Backup manifest release SHA is invalid.');
  }
  if (typeof value.buildTimestamp !== 'string' || Number.isNaN(Date.parse(value.buildTimestamp))) {
    throw errorWithCode('Backup manifest build timestamp is invalid.');
  }
  if (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) {
    throw errorWithCode('Backup manifest protocol version is invalid.');
  }
  if (
    !isRecord(value.database) ||
    !hasExactKeys(value.database, ['integrityCheck', 'foreignKeyCheck', 'schemaVersion']) ||
    value.database.integrityCheck !== 'ok' ||
    value.database.foreignKeyCheck !== 'ok' ||
    value.database.schemaVersion !== value.schemaVersion
  ) {
    throw errorWithCode('Backup manifest database metadata is invalid.');
  }
  if (
    !isRecord(value.rooms) ||
    !hasExactKeys(value.rooms, ['format', 'version', 'protocolVersion', 'count']) ||
    typeof value.rooms.format !== 'string' ||
    value.rooms.format.trim() === '' ||
    ![1, 2].includes(value.rooms.version) ||
    !Number.isSafeInteger(value.rooms.protocolVersion) ||
    value.rooms.protocolVersion < 1 ||
    !Number.isSafeInteger(value.rooms.count) ||
    value.rooms.count < 0
  ) {
    throw errorWithCode('Backup manifest room-state metadata is invalid.');
  }
  return {
    schemaVersion: value.schemaVersion,
    releaseSha: value.releaseSha,
    buildTimestamp: value.buildTimestamp,
    protocolVersion: value.protocolVersion,
    database: { ...value.database },
    rooms: { ...value.rooms }
  };
}

function normalizeManifest(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['format', 'formatVersion', 'createdAt', 'metadata', 'files'])) {
    throw errorWithCode('Backup manifest has an invalid top-level shape.');
  }
  if (value.format !== STATE_BACKUP_FORMAT || value.formatVersion !== STATE_BACKUP_FORMAT_VERSION) {
    throw errorWithCode('Backup manifest format is unsupported.');
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw errorWithCode('Backup manifest timestamp is invalid.');
  }
  if (!Array.isArray(value.files) || value.files.length !== payloadFileNames.length) {
    throw errorWithCode('Backup manifest must list exactly the required state files.');
  }

  const seen = new Set();
  const files = value.files.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['name', 'size', 'sha256'])) {
      throw errorWithCode('Backup manifest contains an invalid file entry.');
    }
    assertSafeFixedBasename(entry.name);
    if (seen.has(entry.name)) throw errorWithCode(`Backup manifest contains duplicate file entry ${entry.name}.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw errorWithCode(`Backup manifest contains an invalid size for ${entry.name}.`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw errorWithCode(`Backup manifest contains an invalid SHA-256 for ${entry.name}.`);
    }
    seen.add(entry.name);
    return { name: entry.name, size: entry.size, sha256: entry.sha256 };
  });

  if (seen.size !== payloadFileNames.length || payloadFileNames.some((name) => !seen.has(name))) {
    throw errorWithCode('Backup manifest does not contain the complete fixed state-file allowlist.');
  }
  return {
    format: value.format,
    formatVersion: value.formatVersion,
    createdAt: value.createdAt,
    metadata: normalizeManifestMetadata(value.metadata),
    files
  };
}

async function assertExactDirectoryEntries(directoryPath, expectedNames) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const sortedExpected = [...expectedNames].sort();
  if (
    actualNames.length !== sortedExpected.length ||
    actualNames.some((name, index) => name !== sortedExpected[index])
  ) {
    throw errorWithCode('State backup directory contains missing or unexpected entries.');
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw errorWithCode(`State backup entry ${entry.name} must be a regular file, not a link, junction, or directory.`);
    }
  }
}

function roomMetadata(document, releaseProtocolVersion) {
  return {
    format: document.version === 1 ? 'legacy-v1' : document.format,
    version: document.version,
    protocolVersion: document.version === 1 ? releaseProtocolVersion : document.protocolVersion,
    count: document.rooms.length
  };
}

function semanticMetadata(databaseState, roomsDocument, releaseDocument) {
  if (databaseState.schemaVersion !== releaseDocument.schemaVersion) {
    throw errorWithCode('Release identity schema version does not match the SQLite migration history.');
  }
  const rooms = roomMetadata(roomsDocument, releaseDocument.protocolVersion);
  if (rooms.protocolVersion !== releaseDocument.protocolVersion) {
    throw errorWithCode('Room-state protocol version does not match the release identity.');
  }
  return {
    schemaVersion: databaseState.schemaVersion,
    releaseSha: releaseDocument.releaseSha.toLowerCase(),
    buildTimestamp: new Date(releaseDocument.buildTimestamp).toISOString(),
    protocolVersion: releaseDocument.protocolVersion,
    database: { ...databaseState },
    rooms
  };
}

function metadataEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyPayloadDirectory(directoryPath, manifest, options = {}) {
  const expectedNames = options.includeManifest ? allBackupFileNames : payloadFileNames;
  await assertExactDirectoryEntries(directoryPath, expectedNames);

  for (const entry of manifest.files) {
    const filePath = path.join(directoryPath, entry.name);
    const digest = await fileDigest(filePath, `Backup payload ${entry.name}`);
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) {
      throw errorWithCode(`Backup payload ${entry.name} failed size or SHA-256 verification.`);
    }
  }

  const databaseState = await validateSqliteFile(
    path.join(directoryPath, STATE_BACKUP_FILES.database),
    'Backup SQLite database',
    { validateSchema: options.validateSchema }
  );
  const roomsState = await validateJsonFile(
    path.join(directoryPath, STATE_BACKUP_FILES.rooms),
    'Backup room state',
    options.validateRooms || validateRoomsBackupDocument
  );
  const releaseState = await validateJsonFile(
    path.join(directoryPath, STATE_BACKUP_FILES.release),
    'Backup release identity',
    options.validateRelease || validateReleaseBackupDocument
  );
  const metadata = semanticMetadata(databaseState, roomsState.document, releaseState.document);
  if (manifest.metadata && !metadataEqual(manifest.metadata, metadata)) {
    throw errorWithCode('Backup manifest semantic metadata does not match its payload.');
  }
  return metadata;
}

export function resolveStateSourcePaths(env = process.env) {
  const roomsPath = path.resolve(String(env.SKYJO_ROOMS_FILE || '').trim() || path.join('.data', 'rooms.json'));
  const databasePath = path.resolve(
    String(env.SKYJO_DB_FILE || '').trim() ||
      (path.isAbsolute(String(env.SKYJO_ROOMS_FILE || '').trim())
        ? path.join(path.dirname(roomsPath), 'skyjo.sqlite')
        : path.join('.data', 'skyjo.sqlite'))
  );
  const releasePath = path.resolve(String(env.SKYJO_RELEASE_FILE || '').trim() || path.join('dist', 'release.json'));
  return { databasePath, roomsPath, releasePath };
}

export async function verifyStateBackup(backupDirectory, options = {}) {
  const resolvedBackupDirectory = resolvedPath(backupDirectory, 'Backup directory');
  await assertNoLinkedPathComponents(resolvedBackupDirectory);
  const directoryStat = await fs.lstat(resolvedBackupDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw errorWithCode('Backup path must be a real directory, not a file, symbolic link, or junction.');
  }
  await assertExactDirectoryEntries(resolvedBackupDirectory, allBackupFileNames);

  const { parsed } = await readBoundedJson(
    path.join(resolvedBackupDirectory, STATE_BACKUP_FILES.manifest),
    'Backup manifest',
    maxManifestBytes
  );
  const manifest = normalizeManifest(parsed);
  await verifyPayloadDirectory(resolvedBackupDirectory, manifest, {
    ...options,
    includeManifest: true
  });
  return {
    backupDirectory: resolvedBackupDirectory,
    ...manifest
  };
}

function timestampFrom(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw errorWithCode('Backup timestamp is invalid.');
  return date.toISOString();
}

function stagingDirectoryFor(finalDirectory) {
  return path.join(
    path.dirname(finalDirectory),
    `.${path.basename(finalDirectory)}.staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
}

async function prepareFreshStagingDirectory(finalDirectory, { allowExistingEmpty = false } = {}) {
  const existing = await lstatOrNull(finalDirectory);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw errorWithCode('Destination must be a fresh real directory, not a file, symbolic link, or junction.');
    }
    const contents = await fs.readdir(finalDirectory);
    if (!allowExistingEmpty || contents.length > 0) {
      throw errorWithCode('Destination must not already exist or contain files.');
    }
  }

  const parentDirectory = path.dirname(finalDirectory);
  await fs.mkdir(parentDirectory, { recursive: true, mode: directoryMode });
  await assertNoLinkedPathComponents(parentDirectory);
  const stagingDirectory = stagingDirectoryFor(finalDirectory);
  await fs.mkdir(stagingDirectory, { mode: directoryMode });
  await enforceMode(stagingDirectory, directoryMode);
  return { stagingDirectory, existingEmptyDestination: Boolean(existing) };
}

async function finalizeStagingDirectory(stagingDirectory, finalDirectory, existingEmptyDestination) {
  if (existingEmptyDestination) await fs.rmdir(finalDirectory);
  await fs.rename(stagingDirectory, finalDirectory);
  await enforceMode(finalDirectory, directoryMode);
}

export async function createStateBackup(options = {}) {
  const defaults = resolveStateSourcePaths(options.env);
  const databasePath = resolvedPath(options.databasePath || defaults.databasePath, 'SQLite source path');
  const roomsPath = resolvedPath(options.roomsPath || defaults.roomsPath, 'Room-state source path');
  const releasePath = resolvedPath(options.releasePath || defaults.releasePath, 'Release-identity source path');
  const destinationDirectory = resolvedPath(options.destinationDirectory, 'Backup destination directory');

  for (const sourcePath of [databasePath, roomsPath, releasePath]) {
    if (pathsOverlap(sourcePath, destinationDirectory)) {
      throw errorWithCode('Backup destination must be isolated from every live source path.');
    }
    await assertNoLinkedPathComponents(sourcePath);
  }

  await validateSqliteFile(databasePath, 'Source SQLite database', { validateSchema: options.validateSchema });
  await validateJsonFile(roomsPath, 'Source room state', options.validateRooms || validateRoomsBackupDocument);
  await validateJsonFile(releasePath, 'Source release identity', options.validateRelease || validateReleaseBackupDocument);

  const { stagingDirectory } = await prepareFreshStagingDirectory(destinationDirectory);
  try {
    const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(sourceDatabase, path.join(stagingDirectory, STATE_BACKUP_FILES.database));
    } finally {
      sourceDatabase.close();
    }
    await enforceMode(path.join(stagingDirectory, STATE_BACKUP_FILES.database), fileMode);
    await copyPrivateFile(roomsPath, path.join(stagingDirectory, STATE_BACKUP_FILES.rooms), 'Source room state');
    await copyPrivateFile(releasePath, path.join(stagingDirectory, STATE_BACKUP_FILES.release), 'Source release identity');

    const databaseState = await validateSqliteFile(
      path.join(stagingDirectory, STATE_BACKUP_FILES.database),
      'Copied SQLite database',
      { validateSchema: options.validateSchema }
    );
    const roomsState = await validateJsonFile(
      path.join(stagingDirectory, STATE_BACKUP_FILES.rooms),
      'Copied room state',
      options.validateRooms || validateRoomsBackupDocument
    );
    const releaseState = await validateJsonFile(
      path.join(stagingDirectory, STATE_BACKUP_FILES.release),
      'Copied release identity',
      options.validateRelease || validateReleaseBackupDocument
    );

    const files = [];
    for (const name of payloadFileNames) {
      files.push({ name, ...(await fileDigest(path.join(stagingDirectory, name), `Copied state file ${name}`)) });
    }
    const manifest = {
      format: STATE_BACKUP_FORMAT,
      formatVersion: STATE_BACKUP_FORMAT_VERSION,
      createdAt: timestampFrom(options.now),
      metadata: semanticMetadata(databaseState, roomsState.document, releaseState.document),
      files
    };
    await writePrivateFile(
      path.join(stagingDirectory, STATE_BACKUP_FILES.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await verifyStateBackup(stagingDirectory, options);
    await finalizeStagingDirectory(stagingDirectory, destinationDirectory, false);
    return verifyStateBackup(destinationDirectory, options);
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function defaultLivePaths(env) {
  return Object.values(resolveStateSourcePaths(env));
}

export async function restoreStateBackup(backupDirectory, options = {}) {
  const resolvedBackupDirectory = resolvedPath(backupDirectory, 'Backup directory');
  const destinationDirectory = resolvedPath(options.destinationDirectory, 'Restore destination directory');
  const livePaths = options.livePaths || defaultLivePaths(options.env);

  if (!Array.isArray(livePaths)) throw errorWithCode('Restore live-path allowlist must be an array.');
  if (pathsOverlap(resolvedBackupDirectory, destinationDirectory)) {
    throw errorWithCode('Restore destination must be isolated from the source backup directory.');
  }
  for (const livePathValue of livePaths) {
    const livePath = resolvedPath(livePathValue, 'Live state path');
    if (pathsOverlap(livePath, destinationDirectory)) {
      throw errorWithCode('Restore destination overlaps a live state target and is not allowed.');
    }
  }

  const manifest = await verifyStateBackup(resolvedBackupDirectory, options);
  const { stagingDirectory, existingEmptyDestination } = await prepareFreshStagingDirectory(destinationDirectory, {
    allowExistingEmpty: true
  });
  try {
    for (const name of payloadFileNames) {
      await copyPrivateFile(
        path.join(resolvedBackupDirectory, name),
        path.join(stagingDirectory, name),
        `Backup payload ${name}`
      );
    }
    await verifyPayloadDirectory(stagingDirectory, manifest, options);
    await finalizeStagingDirectory(stagingDirectory, destinationDirectory, existingEmptyDestination);
    await verifyPayloadDirectory(destinationDirectory, manifest, options);
    return {
      destinationDirectory,
      databasePath: path.join(destinationDirectory, STATE_BACKUP_FILES.database),
      roomsPath: path.join(destinationDirectory, STATE_BACKUP_FILES.rooms),
      releasePath: path.join(destinationDirectory, STATE_BACKUP_FILES.release),
      manifest
    };
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
