import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(?:canary|production)$/;
export const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
export const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const RELEASE_TAG_PATTERN = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 24 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_RELEASE_ROOT_ENTRIES = 128;
export const MAX_STALE_LINK_TEMPS = 32;
export const MAX_STALE_INCOMING_DIRECTORIES = 32;
export const STALE_DEPLOYMENT_ARTIFACT_MS = 15 * 60 * 1000;
export const DEPLOYMENT_CLOCK_SKEW_MS = 60 * 1000;

export const REQUIRED_ARCHIVE_ENTRIES = new Set([
  'release.json',
  'release.json.sha256',
  'dist/release.json',
  'dist/release.json.sha256',
  'package.json',
  'package-lock.json',
  'server.mjs',
  'server-account-store.mjs',
  'server-game-state-validation.mjs',
  'server-invite-codes.mjs',
  'server-persistence-health.mjs',
  'server-readiness.mjs',
  'server-release.mjs',
  'server-room-invites.mjs',
  'server-room-persistence.mjs',
  'server-state-backup.mjs',
  'server-test-pwa-diagnostics.mjs',
  'skyjo-runtime.cdx.json',
  'dist/index.html',
  'server-dist/game.js',
  'server-dist/runtime.js',
  'server-dist/serverValidation.js',
  'server-dist/types.js',
  'scripts/backup-state.mjs',
  'scripts/deployed-smoke-lib.mjs',
  'scripts/monitor-readiness.mjs',
  'scripts/readiness-monitor-lib.mjs',
  'scripts/run-scheduled-backup.mjs',
  'scripts/scheduled-backup-lib.mjs',
  'scripts/verify-state-backup.mjs',
  'scripts/restore-state.mjs',
  'scripts/smoke-deployed.mjs'
]);

const EXACT_ALLOWED_FILES = new Set([
  ...REQUIRED_ARCHIVE_ENTRIES,
]);
const ALLOWED_DIRECTORY_ROOTS = new Set(['dist', 'server-dist', 'scripts', 'node_modules']);

function isAllowedRuntimeEntry(entry, isDirectory) {
  if (EXACT_ALLOWED_FILES.has(entry)) return !isDirectory;
  if (ALLOWED_DIRECTORY_ROOTS.has(entry)) return isDirectory;
  const root = entry.split('/', 1)[0];
  return ALLOWED_DIRECTORY_ROOTS.has(root) && root !== 'scripts';
}

export function validateRunId(value) {
  if (!RUN_ID_PATTERN.test(value || '')) throw new Error('Invalid deployment run ID.');
  return value;
}

export function validateReleaseSha(value) {
  if (!RELEASE_SHA_PATTERN.test(value || '')) throw new Error('Invalid release SHA.');
  return value;
}

export function validateDigest(value) {
  if (!DIGEST_PATTERN.test(value || '')) throw new Error('Invalid SHA-256 digest.');
  return value;
}

export function validateReleaseTag(value) {
  if (!RELEASE_TAG_PATTERN.test(value || '')) throw new Error('Invalid release tag.');
  return value;
}

export function resolveWithin(baseDirectory, ...segments) {
  const base = path.resolve(baseDirectory);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('Resolved path escapes its allowed root.');
  }
  return resolved;
}

export function isForbiddenArchivePathSegment(segment) {
  const normalized = typeof segment === 'string' ? segment.toLowerCase() : '';
  return normalized === '.git' || normalized === '.github' || normalized.startsWith('.env');
}

export function normalizeArchiveEntry(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new Error('Archive contains an invalid path.');
  }
  let entry = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!entry || entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) throw new Error('Archive contains an absolute path.');
  const parts = entry.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Archive contains a path traversal entry.');
  }
  if (parts.some((part) => /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Archive contains a path control character.');
  }
  if (parts.some(isForbiddenArchivePathSegment)) {
    throw new Error('Archive contains a forbidden path.');
  }
  return entry;
}

export function validateArchiveListing(names, verboseLines) {
  if (!Array.isArray(names) || !Array.isArray(verboseLines) || names.length !== verboseLines.length) {
    throw new Error('Archive listings are inconsistent.');
  }
  if (names.length === 0 || names.length > MAX_ARCHIVE_ENTRIES) throw new Error('Archive entry count is invalid.');
  const normalized = new Set();
  let totalBytes = 0;
  let canonicalTimestamp;
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === './' && (verboseLines[index] || '')[0] === 'd') continue;
    const entry = normalizeArchiveEntry(names[index]);
    if (normalized.has(entry)) throw new Error(`Archive contains a duplicate entry: ${entry}`);
    normalized.add(entry);
    const line = verboseLines[index] || '';
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`Archive entry is not a regular file or directory: ${entry}`);
    if (!isAllowedRuntimeEntry(entry, type === 'd')) throw new Error(`Archive contains an unexpected runtime entry: ${entry}`);
    const metadata = line.match(/^([d-][rwx-]{9})\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+/);
    if (!metadata || metadata[2] !== '0/0') throw new Error(`Archive metadata is invalid for: ${entry}`);
    if ((type === '-' && metadata[1] !== '-rw-r--r--') || (type === 'd' && metadata[1] !== 'drwxr-xr-x')) {
      throw new Error(`Archive mode is non-canonical for: ${entry}`);
    }
    const fileBytes = Number(metadata[3]);
    if (type === '-' && fileBytes > MAX_FILE_BYTES) throw new Error(`Archive file is too large: ${entry}`);
    if (type === '-') totalBytes += fileBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error('Archive expands beyond the allowed size.');
    }
    const timestamp = `${metadata[4]}T${metadata[5]}Z`;
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Archive timestamp is invalid for: ${entry}`);
    canonicalTimestamp ||= timestamp;
    if (timestamp !== canonicalTimestamp) throw new Error('Archive entries do not share one canonical timestamp.');
  }
  for (const required of REQUIRED_ARCHIVE_ENTRIES) {
    if (!normalized.has(required)) throw new Error(`Archive is missing required runtime entry: ${required}`);
  }
  return { entries: normalized, totalBytes, canonicalTimestamp };
}

export function parseChecksumFile(value, expectedFileName) {
  const escaped = expectedFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(value).match(new RegExp(`^([a-f0-9]{64})  ${escaped}\\r?\\n$`));
  if (!match) throw new Error('Checksum file has an invalid format.');
  return match[1];
}

export function validateReleaseIdentity(value, expectedSha) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release identity is invalid.');
  if (value.formatVersion !== 1) throw new Error('Release identity format is unsupported.');
  if (value.releaseSha !== validateReleaseSha(expectedSha)) throw new Error('Release identity SHA does not match.');
  if (new Date(value.buildTimestamp).toISOString() !== value.buildTimestamp) throw new Error('Release build timestamp is invalid.');
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error('Release schema version is invalid.');
  if (!Number.isInteger(value.protocolVersion) || value.protocolVersion < 1) throw new Error('Release protocol version is invalid.');
  return {
    formatVersion: 1,
    releaseSha: value.releaseSha,
    buildTimestamp: value.buildTimestamp,
    schemaVersion: value.schemaVersion,
    protocolVersion: value.protocolVersion
  };
}

export async function sha256File(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function loadVerifiedReleaseIdentity(releaseDirectory, expectedSha) {
  const rootIdentityPath = resolveWithin(releaseDirectory, 'release.json');
  const rootChecksumPath = resolveWithin(releaseDirectory, 'release.json.sha256');
  const distIdentityPath = resolveWithin(releaseDirectory, 'dist', 'release.json');
  const distChecksumPath = resolveWithin(releaseDirectory, 'dist', 'release.json.sha256');
  const [rootData, rootChecksum, distData, distChecksum] = await Promise.all([
    fs.readFile(rootIdentityPath, 'utf8'),
    fs.readFile(rootChecksumPath, 'utf8'),
    fs.readFile(distIdentityPath, 'utf8'),
    fs.readFile(distChecksumPath, 'utf8')
  ]);
  if (rootData !== distData || rootChecksum !== distChecksum) throw new Error('Root and served release identities differ.');
  const expected = parseChecksumFile(rootChecksum, 'release.json');
  const actual = crypto.createHash('sha256').update(rootData).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error('Release identity checksum mismatch.');
  return validateReleaseIdentity(JSON.parse(rootData), expectedSha);
}

function normalizedError(caught) {
  return caught instanceof Error ? caught : new Error(String(caught));
}

function uncertaintyError(caught, property) {
  const error = normalizedError(caught);
  try {
    Object.defineProperty(error, property, { value: true, enumerable: true, configurable: true });
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: error });
    Object.defineProperty(wrapped, property, { value: true, enumerable: true });
    return wrapped;
  }
}

export async function fsyncFilesystemPath(filePath, {
  directory = false,
  openFile = fs.open
} = {}) {
  const flags = nodeFs.constants.O_RDONLY |
    (nodeFs.constants.O_NOFOLLOW || 0) |
    (directory ? (nodeFs.constants.O_DIRECTORY || 0) : 0);
  let handle;
  let primaryError;
  try {
    handle = await openFile(filePath, flags);
    await handle.sync();
  } catch (caught) {
    const error = normalizedError(caught);
    if (!(directory && process.platform === 'win32' && ['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code))) {
      primaryError = error;
    }
  }
  let closeError;
  try { await handle?.close(); }
  catch (caught) { closeError = normalizedError(caught); }
  if (primaryError && closeError) throw new AggregateError([primaryError, closeError], `Failed to sync and close ${filePath}.`, { cause: primaryError });
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

export async function syncTreeDurably(rootPath, operations = {}) {
  const lstat = operations.lstat || fs.lstat;
  const readdir = operations.readdir || fs.readdir;
  const syncEntry = operations.syncEntry || fsyncFilesystemPath;
  const stat = await lstat(rootPath);
  if (stat.isSymbolicLink()) throw new Error(`Durable release tree contains a symbolic link: ${rootPath}`);
  if (stat.isFile()) {
    await syncEntry(rootPath, { directory: false });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Durable release tree contains a special entry: ${rootPath}`);
  const entries = await readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    await syncTreeDurably(path.join(rootPath, entry.name), operations);
  }
  await syncEntry(rootPath, { directory: true });
}

export async function renameDurably(sourcePath, destinationPath, {
  rename = fs.rename,
  syncParent = fsyncFilesystemPath
} = {}) {
  let renamed = false;
  try {
    await rename(sourcePath, destinationPath);
    renamed = true;
    await syncParent(path.dirname(destinationPath), { directory: true });
  } catch (caught) {
    if (renamed) throw uncertaintyError(caught, 'renameMayHaveCommitted');
    throw caught;
  }
}

export async function proveDurablePublishedDirectory(targetPath, operations = {}) {
  const syncTree = operations.syncTree || syncTreeDurably;
  const syncParent = operations.syncParent || fsyncFilesystemPath;
  await syncTree(targetPath);
  await syncParent(path.dirname(targetPath), { directory: true });
}

export async function publishImmutableDirectory(incomingPath, targetPath, operations = {}) {
  const parent = path.dirname(targetPath);
  if (path.dirname(incomingPath) !== parent || incomingPath === targetPath) {
    throw new Error('Immutable release publication paths must be distinct siblings.');
  }
  const syncTree = operations.syncTree || syncTreeDurably;
  const syncParent = operations.syncParent || fsyncFilesystemPath;
  const rename = operations.rename || ((source, destination) => renameDurably(source, destination, { syncParent }));
  const remove = operations.remove || fs.rm;
  try {
    await syncTree(incomingPath);
    await rename(incomingPath, targetPath);
  } catch (caught) {
    const primaryError = normalizedError(caught);
    const cleanupErrors = [];
    try { await remove(incomingPath, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupErrors.push(normalizedError(cleanupError)); }
    try { await syncParent(parent, { directory: true }); }
    catch (cleanupError) { cleanupErrors.push(normalizedError(cleanupError)); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'Immutable release publication failed and cleanup was incomplete.', { cause: primaryError });
    }
    throw primaryError;
  }
}

async function assertTrustedReleaseRoots(appRoot, releasesRoot, operations = {}) {
  const lstat = operations.lstat || fs.lstat;
  const trustedUid = operations.trustedUid ?? 0;
  const trustedGid = operations.trustedGid ?? 0;
  if (!Number.isSafeInteger(trustedUid) || trustedUid < 0 || !Number.isSafeInteger(trustedGid) || trustedGid < 0) {
    throw new Error('Trusted release owner identity is invalid.');
  }
  const app = path.resolve(appRoot);
  const releases = path.resolve(releasesRoot);
  if (releases !== path.join(app, 'releases')) throw new Error('Release store is not the exact application-root child.');
  for (const [description, directory] of [['application root', app], ['release store', releases]]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Trusted ${description} is not a real directory.`);
    if (process.platform !== 'win32' && (stat.uid !== trustedUid || stat.gid !== trustedGid || (stat.mode & 0o022) !== 0)) {
      throw new Error(`Trusted ${description} is not root-owned and non-writable.`);
    }
  }
  return { app, releases };
}

function validateArtifactTimestamp(stat, now, description) {
  if (!Number.isFinite(stat.mtimeMs)) throw new Error(`${description} timestamp is invalid.`);
  if (stat.mtimeMs > now + DEPLOYMENT_CLOCK_SKEW_MS) throw new Error(`${description} timestamp is in the future.`);
  return now - stat.mtimeMs >= STALE_DEPLOYMENT_ARTIFACT_MS;
}

function propagateUncertainty(primary, cleanup) {
  const failure = new AggregateError([primary, cleanup], 'Release link operation failed and temporary-link cleanup was incomplete.', { cause: primary });
  if (primary.linkMayHaveChanged === true) Object.defineProperty(failure, 'linkMayHaveChanged', { value: true, enumerable: true });
  if (primary.renameMayHaveCommitted === true) Object.defineProperty(failure, 'renameMayHaveCommitted', { value: true, enumerable: true });
  return failure;
}

export async function cleanupStaleReleaseLinkTemps({
  appRoot,
  releasesRoot,
  now = Date.now()
}, operations = {}) {
  const { app, releases } = await assertTrustedReleaseRoots(appRoot, releasesRoot, operations);
  const trustedUid = operations.trustedUid ?? 0;
  const trustedGid = operations.trustedGid ?? 0;
  const readdir = operations.readdir || fs.readdir;
  const lstat = operations.lstat || fs.lstat;
  const readlink = operations.readlink || fs.readlink;
  const unlink = operations.unlink || fs.unlink;
  const syncParent = operations.syncParent || fsyncFilesystemPath;
  const entries = await readdir(app, { withFileTypes: true });
  if (entries.length > MAX_RELEASE_ROOT_ENTRIES) throw new Error('Application root contains too many entries for bounded link cleanup.');
  const candidates = entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('current.next-') || name.startsWith('previous.next-'))
    .sort();
  if (candidates.length > MAX_STALE_LINK_TEMPS) throw new Error('Too many release-link cleanup candidates.');
  const exact = /^(?:current|previous)\.next-[1-9][0-9]{0,9}-[a-f0-9]{8}$/;
  const stale = [];
  for (const name of candidates) {
    if (!exact.test(name)) throw new Error(`Malformed release-link temporary entry: ${name}`);
    const candidate = resolveWithin(app, name);
    const stat = await lstat(candidate);
    if (!stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== trustedUid || stat.gid !== trustedGid))) {
      throw new Error(`Release-link temporary entry is unsafe: ${name}`);
    }
    const rawTarget = await readlink(candidate);
    const resolvedTarget = path.resolve(app, rawTarget);
    const releaseSha = path.basename(resolvedTarget);
    if (!RELEASE_SHA_PATTERN.test(releaseSha) || resolvedTarget !== resolveWithin(releases, releaseSha)) {
      throw new Error(`Release-link temporary target is unsafe: ${name}`);
    }
    if (validateArtifactTimestamp(stat, now, `Release-link temporary entry ${name}`)) stale.push(candidate);
  }
  let removed = 0;
  let primaryError;
  try {
    for (const candidate of stale) {
      await unlink(candidate);
      removed += 1;
    }
  } catch (caught) {
    primaryError = normalizedError(caught);
  }
  let syncError;
  if (removed > 0) {
    try { await syncParent(app, { directory: true }); }
    catch (caught) { syncError = normalizedError(caught); }
  }
  if (primaryError && syncError) throw new AggregateError([primaryError, syncError], 'Stale release-link cleanup and parent sync failed.', { cause: primaryError });
  if (primaryError) throw primaryError;
  if (syncError) throw syncError;
  return { candidates: candidates.length, removed };
}

async function validateRootOwnedTree(rootPath, operations, counter = { entries: 0, bytes: 0 }) {
  const lstat = operations.lstat || fs.lstat;
  const readdir = operations.readdir || fs.readdir;
  const stat = await lstat(rootPath);
  counter.entries += 1;
  if (counter.entries > MAX_ARCHIVE_ENTRIES) throw new Error('Incoming release tree exceeds the bounded cleanup entry limit.');
  const trustedUid = operations.trustedUid ?? 0;
  const trustedGid = operations.trustedGid ?? 0;
  if (process.platform !== 'win32' && (stat.uid !== trustedUid || stat.gid !== trustedGid)) throw new Error('Incoming release tree contains a non-root-owned entry.');
  if (stat.isSymbolicLink()) throw new Error('Incoming release tree contains a symbolic link.');
  if (stat.isFile()) {
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) throw new Error('Incoming release tree contains a writable file.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('Incoming release tree contains an invalid file size.');
    if (stat.size > MAX_EXTRACTED_BYTES - counter.bytes) {
      throw new Error('Incoming release tree exceeds the bounded cleanup byte limit.');
    }
    counter.bytes += stat.size;
    return counter;
  }
  if (!stat.isDirectory()) throw new Error('Incoming release tree contains a special entry.');
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) throw new Error('Incoming release tree contains a writable directory.');
  const entries = await readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) await validateRootOwnedTree(path.join(rootPath, entry.name), operations, counter);
  return counter;
}

async function removeTreeNoFollow(rootPath, operations, mutation = { count: 0 }) {
  const lstat = operations.lstat || fs.lstat;
  const readdir = operations.readdir || fs.readdir;
  const unlink = operations.unlink || fs.unlink;
  const rmdir = operations.rmdir || fs.rmdir;
  const stat = await lstat(rootPath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const entries = await readdir(rootPath, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) await removeTreeNoFollow(path.join(rootPath, entry.name), operations, mutation);
    await rmdir(rootPath);
    mutation.count += 1;
    return mutation;
  }
  if (stat.isFile() || stat.isSymbolicLink()) {
    await unlink(rootPath);
    mutation.count += 1;
    return mutation;
  }
  throw new Error('Incoming release cleanup encountered a special entry.');
}

export async function cleanupStaleIncomingDirectories({
  appRoot,
  releasesRoot,
  activeRunId,
  activeReleaseSha,
  now = Date.now()
}, operations = {}) {
  const { releases } = await assertTrustedReleaseRoots(appRoot, releasesRoot, operations);
  const trustedUid = operations.trustedUid ?? 0;
  const trustedGid = operations.trustedGid ?? 0;
  if (activeRunId !== undefined && !RUN_ID_PATTERN.test(activeRunId)) throw new Error('Active deployment run ID is invalid for incoming cleanup.');
  if (activeReleaseSha !== undefined && !RELEASE_SHA_PATTERN.test(activeReleaseSha)) throw new Error('Active release SHA is invalid for incoming cleanup.');
  if ((activeRunId === undefined) !== (activeReleaseSha === undefined)) throw new Error('Active incoming cleanup identity is incomplete.');
  const activeName = activeRunId === undefined ? null : `.incoming-${activeReleaseSha}-${activeRunId}`;
  const readdir = operations.readdir || fs.readdir;
  const lstat = operations.lstat || fs.lstat;
  const syncParent = operations.syncParent || fsyncFilesystemPath;
  const entries = await readdir(releases, { withFileTypes: true });
  if (entries.length > MAX_RELEASE_ROOT_ENTRIES) throw new Error('Release store contains too many entries for bounded incoming cleanup.');
  const candidates = entries.map((entry) => entry.name).filter((name) => name.startsWith('.incoming-')).sort();
  if (candidates.length > MAX_STALE_INCOMING_DIRECTORIES) throw new Error('Too many incoming release cleanup candidates.');
  const exact = /^\.incoming-([a-f0-9]{40})-([1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(?:canary|production))$/;
  const stale = [];
  for (const name of candidates) {
    const match = name.match(exact);
    if (!match) throw new Error(`Malformed incoming release directory: ${name}`);
    const candidate = resolveWithin(releases, name);
    const stat = await lstat(candidate);
    const mode = stat.mode & 0o7777;
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.uid !== trustedUid || stat.gid !== trustedGid || ![0o700, 0o755].includes(mode)))) {
      throw new Error(`Incoming release directory is unsafe: ${name}`);
    }
    const isStale = validateArtifactTimestamp(stat, now, `Incoming release directory ${name}`);
    if (name !== activeName && isStale) {
      await validateRootOwnedTree(candidate, operations);
      stale.push(candidate);
    }
  }
  let removed = 0;
  const mutation = { count: 0 };
  let primaryError;
  try {
    for (const candidate of stale) {
      await removeTreeNoFollow(candidate, operations, mutation);
      removed += 1;
    }
  } catch (caught) {
    primaryError = normalizedError(caught);
  }
  let syncError;
  if (mutation.count > 0) {
    try { await syncParent(releases, { directory: true }); }
    catch (caught) { syncError = normalizedError(caught); }
  }
  if (primaryError && syncError) throw new AggregateError([primaryError, syncError], 'Incoming release cleanup and parent sync failed.', { cause: primaryError });
  if (primaryError) throw primaryError;
  if (syncError) throw syncError;
  return { candidates: candidates.length, removed, activePreserved: activeName !== null && candidates.includes(activeName) };
}

async function cleanupOwnReleaseLinkTemp(temporary, targetPath, operations = {}) {
  const lstat = operations.lstat || fs.lstat;
  const readlink = operations.readlink || fs.readlink;
  const unlink = operations.unlinkTemporary || fs.unlink;
  const syncParent = operations.syncParent || fsyncFilesystemPath;
  const stat = await lstat(temporary).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return false;
  const trustedUid = operations.trustedUid ?? 0;
  const trustedGid = operations.trustedGid ?? 0;
  if (!/^(?:current|previous)\.next-[1-9][0-9]{0,9}-[a-f0-9]{8}$/.test(path.basename(temporary)) ||
      !stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== trustedUid || stat.gid !== trustedGid))) {
    throw new Error('Owned release-link temporary entry is unsafe.');
  }
  const resolvedTarget = path.resolve(path.dirname(temporary), await readlink(temporary));
  if (resolvedTarget !== path.resolve(targetPath)) throw new Error('Owned release-link temporary target changed unexpectedly.');
  await unlink(temporary);
  await syncParent(path.dirname(temporary), { directory: true });
  return true;
}

export async function replaceSymlink(linkPath, targetPath, operations = {}) {
  const createSymlink = operations.createSymlink || fs.symlink;
  const removeLink = operations.removeLink || fs.rm;
  const rename = operations.rename || ((source, destination) => renameDurably(source, destination, {
    syncParent: operations.syncParent || fsyncFilesystemPath
  }));
  const temporary = `${linkPath}.next-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const appRoot = path.dirname(linkPath);
  const releasesRoot = operations.releasesDirectory || path.join(appRoot, 'releases');
  if (['current', 'previous'].includes(path.basename(linkPath))) {
    const cleanupStaleTemps = operations.cleanupStaleTemps || cleanupStaleReleaseLinkTemps;
    await cleanupStaleTemps({ appRoot, releasesRoot, now: operations.now ?? Date.now() }, operations);
  }
  let linkMayHaveChanged = false;
  let operationError;
  try {
    await createSymlink(targetPath, temporary, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await rename(temporary, linkPath);
    } catch (caught) {
      const error = normalizedError(caught);
      const replacementRequired = error.code === 'EEXIST' || error.code === 'ENOTEMPTY' ||
        (process.platform === 'win32' && error.code === 'EPERM');
      if (!error.renameMayHaveCommitted && replacementRequired) {
        linkMayHaveChanged = true;
        try {
          await removeLink(linkPath, { force: true });
          await rename(temporary, linkPath);
        } catch (fallbackError) {
          throw uncertaintyError(fallbackError, 'linkMayHaveChanged');
        }
      } else {
        if (error.renameMayHaveCommitted) linkMayHaveChanged = true;
        if (linkMayHaveChanged) throw uncertaintyError(error, 'linkMayHaveChanged');
        throw error;
      }
    }
  } catch (caught) {
    operationError = normalizedError(caught);
  }
  let cleanupError;
  try { await cleanupOwnReleaseLinkTemp(temporary, targetPath, operations); }
  catch (caught) { cleanupError = normalizedError(caught); }
  if (operationError && cleanupError) throw propagateUncertainty(operationError, cleanupError);
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

export async function readLinkWithin(linkPath, releasesDirectory) {
  const raw = await fs.readlink(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), raw);
  const allowed = resolveWithin(releasesDirectory, path.basename(resolved));
  if (resolved !== allowed) throw new Error('Release symlink points outside the releases directory.');
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Release symlink target is not an immutable directory.');
  return resolved;
}

const GITHUB_API_ROOT = 'https://api.github.com/repos/chadmhohn/skyjo-online';
const GITHUB_REQUEST_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'skyjo-release-controller/1',
  'X-GitHub-Api-Version': '2022-11-28'
});

async function githubJson(resource, description, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API_ROOT}${resource}`, {
      headers: GITHUB_REQUEST_HEADERS,
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new Error(`${description} request failed.`, { cause: error });
  }
  if (!response || typeof response.ok !== 'boolean') throw new Error(`${description} returned an invalid response.`);
  if (!response.ok) throw new Error(`${description} failed (${Number.isInteger(response.status) ? response.status : 'unknown'}).`);
  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new Error(`${description} returned invalid JSON.`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} returned an invalid payload.`);
  return value;
}

function githubObject(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} is missing its object.`);
  if ((value.type !== 'tag' && value.type !== 'commit') || !RELEASE_SHA_PATTERN.test(value.sha || '')) {
    throw new Error(`${description} contains an invalid Git object.`);
  }
  return { type: value.type, sha: value.sha };
}

export async function assertGithubCommitOnMain(releaseSha, fetchImpl = fetch) {
  const safeSha = validateReleaseSha(releaseSha);
  const comparison = await githubJson(`/compare/${safeSha}...main`, 'GitHub main ancestry verification', fetchImpl);
  const status = comparison.status;
  const mergeBaseSha = comparison.merge_base_commit?.sha;
  const baseSha = comparison.base_commit?.sha;
  const counts = [comparison.ahead_by, comparison.behind_by, comparison.total_commits];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('GitHub main ancestry verification returned invalid commit counts.');
  }
  if (!RELEASE_SHA_PATTERN.test(mergeBaseSha || '') || !RELEASE_SHA_PATTERN.test(baseSha || '')) {
    throw new Error('GitHub main ancestry verification returned invalid commit identities.');
  }
  if (mergeBaseSha !== safeSha || baseSha !== safeSha) {
    throw new Error('Release commit is not the exact merge base of public main.');
  }
  const isAhead = status === 'ahead' && comparison.ahead_by > 0 && comparison.behind_by === 0;
  const isIdentical = status === 'identical' && comparison.ahead_by === 0 && comparison.behind_by === 0;
  if (!isAhead && !isIdentical) throw new Error('Release commit is not identical to or an ancestor of public main.');
  return { releaseSha: safeSha, status, commitsAhead: comparison.ahead_by };
}

export const verifyGithubCommitIsOnMain = assertGithubCommitOnMain;

export async function resolveGithubTag(tag, fetchImpl = fetch) {
  const safeTag = validateReleaseTag(tag);
  let payload = await githubJson(`/git/ref/tags/${encodeURIComponent(safeTag)}`, 'GitHub tag verification', fetchImpl);
  let object = githubObject(payload.object, 'GitHub tag verification');
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth += 1) {
    payload = await githubJson(`/git/tags/${object.sha}`, 'GitHub annotated tag verification', fetchImpl);
    object = githubObject(payload.object, 'GitHub annotated tag verification');
  }
  if (object?.type !== 'commit' || !RELEASE_SHA_PATTERN.test(object.sha || '')) throw new Error('Release tag does not resolve to a commit.');
  return object.sha;
}

export function authorizeRollback({ currentReleaseSha, metadata, requestedReleaseSha, requestedDigest, requestedTag }) {
  if (currentReleaseSha !== validateReleaseSha(requestedReleaseSha)) throw new Error('Current release does not match the requested failed SHA.');
  if (!metadata || metadata.releaseSha !== requestedReleaseSha || metadata.artifactSha256 !== validateDigest(requestedDigest) || metadata.tag !== validateReleaseTag(requestedTag)) {
    throw new Error('Rollback authorization does not match current release metadata.');
  }
  return true;
}

export function selectReleasePathsToPrune(entries, protectedPaths, maximum = 5) {
  if (!Number.isInteger(maximum) || maximum < 2) throw new Error('Release retention maximum is invalid.');
  const protectedSet = new Set(protectedPaths);
  const unprotected = entries.filter((entry) => !protectedSet.has(entry.path)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const available = Math.max(0, maximum - protectedSet.size);
  return unprotected.slice(available).map((entry) => entry.path);
}

export async function executeActivationTransaction(operations) {
  let phase = 'stop';
  let linksActivated = false;
  try {
    await operations.stop();
    phase = 'prepare';
    await operations.prepare();
    phase = 'swap';
    await operations.swap(() => { linksActivated = true; });
    linksActivated = true;
    phase = 'start';
    await operations.start();
    phase = 'verify';
    await operations.verify();
  } catch (caught) {
    const activationError = caught instanceof Error ? caught : new Error(String(caught));
    if (phase === 'swap' && activationError.linkMayHaveChanged === true) linksActivated = true;
    const state = {
      activationPhase: phase,
      activationRolledBack: false,
      rollbackFailed: false,
      previousRestarted: false,
      restartPreviousFailed: false
    };
    if (linksActivated) {
      try {
        await operations.rollback();
        state.activationRolledBack = true;
      } catch (caughtRollback) {
        const rollbackError = caughtRollback instanceof Error ? caughtRollback : new Error(String(caughtRollback));
        const failure = new AggregateError(
          [activationError, rollbackError],
          `Activation failed during ${phase}; automatic rollback also failed.`,
          { cause: activationError }
        );
        Object.assign(failure, state, { activationError, rollbackError, rollbackFailed: true });
        throw failure;
      }
    } else {
      try {
        await operations.restartPrevious();
        state.previousRestarted = true;
      } catch (caughtRestart) {
        const restartError = caughtRestart instanceof Error ? caughtRestart : new Error(String(caughtRestart));
        const failure = new AggregateError(
          [activationError, restartError],
          `Activation failed during ${phase}; restarting the previous release also failed.`,
          { cause: activationError }
        );
        Object.assign(failure, state, { activationError, restartError, restartPreviousFailed: true });
        throw failure;
      }
    }
    const failure = new Error(activationError.message, { cause: activationError });
    failure.name = 'ActivationTransactionError';
    Object.assign(failure, state, { activationError });
    throw failure;
  }
}

function rollbackFailure(message, cause, serviceRecovered, stage) {
  const error = new Error(message);
  error.cause = cause;
  error.deploymentStatus = 'rollback-failed';
  error.serviceRecovered = serviceRecovered;
  error.rollbackStage = stage;
  return error;
}

export async function executeCodeRollbackTransaction(operations) {
  const recoverFailedRelease = async ({ restoreLink, stage, cause }) => {
    const recoveryErrors = [];
    if (restoreLink) {
      try { await operations.stop(); } catch (error) { recoveryErrors.push(error); }
      try { await operations.restoreOriginalLinks(); } catch (error) { recoveryErrors.push(error); }
    }
    let serviceRecovered = false;
    try {
      await operations.restartFailed();
      serviceRecovered = true;
    } catch (error) {
      recoveryErrors.push(error);
    }
    if (recoveryErrors.length > 0) {
      const aggregate = new AggregateError([cause, ...recoveryErrors], `${stage} failed and the failed release could not be re-established.`, { cause });
      throw rollbackFailure(aggregate.message, aggregate, serviceRecovered, stage);
    }
    throw rollbackFailure(`${stage} failed; the original release was restarted and reverified: ${cause.message}`, cause, true, stage);
  };

  try {
    await operations.stop();
  } catch (error) {
    await recoverFailedRelease({ restoreLink: false, stage: 'stop', cause: error });
  }
  try {
    await operations.prepare();
  } catch (error) {
    await recoverFailedRelease({ restoreLink: false, stage: 'prepare', cause: error });
  }
  try {
    await operations.restoreCurrent();
  } catch (error) {
    await recoverFailedRelease({ restoreLink: error?.linkMayHaveChanged === true, stage: 'restore-current', cause: error });
  }

  let recordError;
  try {
    await operations.recordFailed();
  } catch (error) {
    recordError = error;
  }

  try {
    await operations.startRecovered();
  } catch (error) {
    await recoverFailedRelease({ restoreLink: true, stage: 'start-recovered', cause: error });
  }
  if (recordError) {
    throw rollbackFailure(`Recovered code is running, but recording the failed release link failed: ${recordError.message}`, recordError, true, 'record-failed');
  }
  return { status: 'rolled-back' };
}
