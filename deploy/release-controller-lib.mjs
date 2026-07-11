import crypto from 'node:crypto';
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

export const REQUIRED_ARCHIVE_ENTRIES = new Set([
  'release.json',
  'release.json.sha256',
  'dist/release.json',
  'dist/release.json.sha256',
  'package.json',
  'package-lock.json',
  'server.mjs',
  'server-account-store.mjs',
  'server-persistence-health.mjs',
  'server-readiness.mjs',
  'server-release.mjs',
  'server-room-persistence.mjs',
  'server-state-backup.mjs',
  'skyjo-runtime.cdx.json',
  'dist/index.html',
  'server-dist/game.js',
  'server-dist/runtime.js',
  'server-dist/serverValidation.js',
  'server-dist/types.js',
  'scripts/backup-state.mjs',
  'scripts/deployed-smoke-lib.mjs',
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
  if (parts.some((part) => part === '.git' || part === '.github' || /^\.env(?:\.|$)/i.test(part))) {
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

export async function replaceSymlink(linkPath, targetPath) {
  const temporary = `${linkPath}.next-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.symlink(targetPath, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await fs.rename(temporary, linkPath);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
      await fs.rm(linkPath, { force: true });
      await fs.rename(temporary, linkPath);
    } else {
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
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
    await operations.swap();
    linksActivated = true;
    phase = 'start';
    await operations.start();
    phase = 'verify';
    await operations.verify();
  } catch (caught) {
    const activationError = caught instanceof Error ? caught : new Error(String(caught));
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
