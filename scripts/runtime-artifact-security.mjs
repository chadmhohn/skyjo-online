import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  parseReleaseChecksum,
  sha256,
  validateReleaseIdentity
} from '../server-release.mjs';
import { isForbiddenArchivePathSegment } from '../deploy/release-controller-lib.mjs';

export { isForbiddenArchivePathSegment };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 4096;
export const RUNTIME_SBOM_NAME = 'skyjo-runtime.cdx.json';

const RETIRED_WHOLE_STATE_VALIDATION_SYMBOLS = Object.freeze([
  'validateMultiplayerStateUpdate',
  'legalMultiplayerStateUpdates',
  'deepEqual',
  'isLegalRecycledDrawUpdate',
  'unorderedCardsEqual',
  'proposedState'
]);

export const RUNTIME_ROOT_FILES = Object.freeze([
  'package-lock.json',
  'package.json',
  'server-account-store.mjs',
  'server-game-state-validation.mjs',
  'server-invite-codes.mjs',
  'server-persistence-health.mjs',
  'server-push.mjs',
  'server-readiness.mjs',
  'server-release.mjs',
  'server-room-invites.mjs',
  'server-room-persistence.mjs',
  'server-state-backup.mjs',
  'server-unicode.mjs',
  'server.mjs'
]);

export const RUNTIME_SCRIPT_FILES = Object.freeze([
  'scripts/backup-state.mjs',
  'scripts/deployed-smoke-lib.mjs',
  'scripts/monitor-readiness.mjs',
  'scripts/readiness-monitor-lib.mjs',
  'scripts/restore-state.mjs',
  'scripts/run-scheduled-backup.mjs',
  'scripts/scheduled-backup-lib.mjs',
  'scripts/smoke-deployed.mjs',
  'scripts/verify-state-backup.mjs'
]);

export const REQUIRED_ARCHIVE_FILES = Object.freeze([
  'release.json',
  'release.json.sha256',
  'dist/release.json',
  'dist/release.json.sha256',
  'dist/index.html',
  'server-dist/game.js',
  'server-dist/protocolV2.js',
  'server-dist/runtime.js',
  'server-dist/serverProtocolV2.js',
  'server-dist/serverRealtime.js',
  'server-dist/serverValidation.js',
  'server-dist/types.js',
  RUNTIME_SBOM_NAME,
  ...RUNTIME_ROOT_FILES,
  ...RUNTIME_SCRIPT_FILES
]);

const exactAllowedPaths = new Set([
  ...RUNTIME_ROOT_FILES,
  ...RUNTIME_SCRIPT_FILES,
  'release.json',
  'release.json.sha256',
  RUNTIME_SBOM_NAME
]);
const allowedDirectoryRoots = new Set(['dist', 'server-dist', 'scripts', 'node_modules']);
const fullShaPattern = /^[a-f0-9]{40}$/;
const artifactOpenFlags = fsConstants.O_RDONLY
  | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileMetadata(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertStableFile(expected, actual, label) {
  if (!actual.isFile() || !sameFileMetadata(expected, actual)) {
    throw new Error(`${label} changed during validation.`);
  }
}

async function openStableRegularFile(filePath, label) {
  let handle;
  try {
    handle = await fs.open(filePath, artifactOpenFlags);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
    }
    throw error;
  }
  try {
    const descriptorStat = await handle.stat({ bigint: true });
    const pathnameStat = await fs.lstat(filePath, { bigint: true });
    if (!descriptorStat.isFile() || !pathnameStat.isFile() || pathnameStat.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file and cannot be a symbolic link.`);
    }
    if (!sameFileIdentity(descriptorStat, pathnameStat)) {
      throw new Error(`${label} was replaced while it was being opened.`);
    }
    assertStableFile(descriptorStat, pathnameStat, label);
    const confirmedStat = await handle.stat({ bigint: true });
    assertStableFile(pathnameStat, confirmedStat, label);
    return { handle, stat: confirmedStat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readStableFile(openedFile, label) {
  const beforeRead = await openedFile.handle.stat({ bigint: true });
  assertStableFile(openedFile.stat, beforeRead, label);
  const data = await openedFile.handle.readFile();
  const afterRead = await openedFile.handle.stat({ bigint: true });
  assertStableFile(beforeRead, afterRead, label);
  return { data, stat: afterRead };
}

async function assertPathStillReferencesFile(filePath, expectedStat, label) {
  let reopened;
  try {
    reopened = await openStableRegularFile(filePath, label);
    assertStableFile(expectedStat, reopened.stat, label);
  } catch (error) {
    if (error?.message === `${label} changed during validation.`) throw error;
    throw new Error(`${label} changed during validation.`);
  } finally {
    await reopened?.handle.close();
  }
}

export function assertFullReleaseSha(value) {
  const releaseSha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!fullShaPattern.test(releaseSha)) throw new Error('A full lowercase 40-character release SHA is required.');
  return releaseSha;
}

export function artifactNames(releaseSha) {
  const normalizedSha = assertFullReleaseSha(releaseSha);
  const baseName = `skyjo-runtime-${normalizedSha}`;
  return {
    archiveName: `${baseName}.tar.gz`,
    checksumName: `${baseName}.tar.gz.sha256`,
    sbomName: `${baseName}.cdx.json`
  };
}

export function normalizeArchivePath(rawPath, { allowRoot = false } = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) throw new Error('Archive entry has an empty path.');
  if (rawPath.includes('\\')) throw new Error(`Unsafe archive path: ${JSON.stringify(rawPath)}.`);
  let candidate = rawPath;
  if (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (candidate === '.' || candidate === '') {
    if (allowRoot) return '';
    throw new Error('Archive entry cannot target the archive root.');
  }
  if (candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate)) {
    throw new Error(`Absolute archive path is not allowed: ${JSON.stringify(rawPath)}.`);
  }
  const normalized = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Archive traversal or ambiguous path is not allowed: ${JSON.stringify(rawPath)}.`);
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error(`Archive path contains control characters: ${JSON.stringify(rawPath)}.`);
  }
  if (segments.some(isForbiddenArchivePathSegment)) {
    throw new Error(`Archive path contains a forbidden SCM or environment segment: ${JSON.stringify(rawPath)}.`);
  }
  return normalized;
}

export function isAllowedRuntimePath(archivePath, isDirectory = false) {
  const normalized = normalizeArchivePath(archivePath, { allowRoot: true });
  if (normalized === '') return isDirectory;
  if (exactAllowedPaths.has(normalized)) return !isDirectory;
  if (allowedDirectoryRoots.has(normalized)) return isDirectory;
  const [root] = normalized.split('/');
  return allowedDirectoryRoots.has(root) && root !== 'scripts';
}

function parseTarNumber(bytes, label) {
  if (bytes.length === 0 || (bytes[0] & 0x80) !== 0) throw new Error(`Unsupported binary tar ${label}.`);
  const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  if (value === '') return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${label}.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Unsafe tar ${label}.`);
  return parsed;
}

function decodeTarString(bytes, label) {
  const end = bytes.indexOf(0);
  try {
    return utf8Decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
  } catch {
    throw new Error(`Tar ${label} is not valid UTF-8.`);
  }
}

function tarHeaderChecksum(header) {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let total = 0;
  for (const byte of copy) total += byte;
  return total;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

export function parseTarArchive(tarBuffer) {
  if (!Buffer.isBuffer(tarBuffer) || tarBuffer.length === 0 || tarBuffer.length > MAX_UNCOMPRESSED_BYTES || tarBuffer.length % 512 !== 0) {
    throw new Error('Invalid tar archive length.');
  }
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  let totalFileBytes = 0;
  while (offset < tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) {
        if (!isZeroBlock(tarBuffer.subarray(offset))) throw new Error('Unexpected data after tar end marker.');
        return entries;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error('Invalid tar end marker.');
    if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error('Runtime archive has too many entries.');
    const expectedChecksum = parseTarNumber(header.subarray(148, 156), 'header checksum');
    if (tarHeaderChecksum(header) !== expectedChecksum) throw new Error('Tar header checksum mismatch.');
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('Only the ustar archive format is accepted.');
    const name = decodeTarString(header.subarray(0, 100), 'entry name');
    const prefix = decodeTarString(header.subarray(345, 500), 'entry prefix');
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = parseTarNumber(header.subarray(124, 136), 'entry size');
    if (size > MAX_FILE_BYTES) throw new Error(`Runtime archive entry exceeds the per-file limit: ${rawPath}.`);
    totalFileBytes += size;
    if (totalFileBytes > MAX_TOTAL_FILE_BYTES) throw new Error('Runtime archive exceeds the total file size limit.');
    const linkName = decodeTarString(header.subarray(157, 257), 'link name');
    offset += 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarBuffer.length) throw new Error(`Truncated tar entry: ${rawPath}.`);
    entries.push({
      rawPath,
      typeFlag,
      size,
      mode: parseTarNumber(header.subarray(100, 108), 'entry mode'),
      uid: parseTarNumber(header.subarray(108, 116), 'entry uid'),
      gid: parseTarNumber(header.subarray(116, 124), 'entry gid'),
      mtime: parseTarNumber(header.subarray(136, 148), 'entry mtime'),
      linkName,
      data: tarBuffer.subarray(offset, offset + size)
    });
    offset += paddedSize;
  }
  throw new Error('Tar archive is missing the two-block end marker.');
}

function parseJson(data, label) {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const tail = lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
  const segments = tail.split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

export function deriveRuntimeInventory(packageData, lockData) {
  const packageMetadata = parseJson(packageData, 'Runtime package.json');
  const lock = parseJson(lockData, 'Runtime package-lock.json');
  const rootLock = lock?.packages?.[''];
  if (packageMetadata?.name !== 'skyjo-online' || packageMetadata?.private !== true || packageMetadata?.type !== 'module') {
    throw new Error('Runtime package metadata is invalid.');
  }
  if (lock?.lockfileVersion !== 3 || rootLock?.name !== packageMetadata.name || rootLock?.version !== packageMetadata.version) {
    throw new Error('Runtime package lock root does not match package metadata.');
  }
  const packageDependencies = packageMetadata.dependencies || {};
  const lockDependencies = rootLock.dependencies || {};
  if (JSON.stringify(Object.entries(packageDependencies).sort()) !== JSON.stringify(Object.entries(lockDependencies).sort())) {
    throw new Error('Runtime package dependencies do not match the lock root.');
  }
  const packages = Object.entries(lock.packages)
    .filter(([lockPath, value]) => lockPath.includes('node_modules/') && value?.dev !== true && value?.optional !== true && value?.link !== true && typeof value?.version === 'string')
    .map(([lockPath, value]) => {
      const name = packageNameFromLockPath(lockPath);
      return {
        lockPath,
        archiveRoot: lockPath.replaceAll('\\', '/'),
        manifestPath: `${lockPath.replaceAll('\\', '/')}/package.json`,
        name,
        version: value.version
      };
    })
    .sort((left, right) => left.lockPath.localeCompare(right.lockPath, 'en'));
  if (packages.length === 0) throw new Error('Runtime package inventory is empty.');
  return { root: { name: packageMetadata.name, version: packageMetadata.version }, packages };
}

function tuple(name, version) {
  return `${name}\u0000${version}`;
}

function validateSbom(data, releaseSha, inventory) {
  const sbom = parseJson(data, 'Runtime SBOM');
  if (sbom?.bomFormat !== 'CycloneDX' || sbom?.specVersion !== '1.6') throw new Error('Runtime SBOM must be CycloneDX 1.6 JSON.');
  const root = sbom?.metadata?.component;
  if (root?.name !== inventory.root.name || root?.version !== inventory.root.version) throw new Error('Runtime SBOM root component does not match package metadata.');
  const releaseProperties = Array.isArray(root.properties) ? root.properties.filter((property) => property?.name === 'skyjo:releaseSha') : [];
  if (releaseProperties.length !== 1 || releaseProperties[0].value !== releaseSha) throw new Error('Runtime SBOM is not bound to the release SHA.');
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  const expected = new Map();
  for (const item of inventory.packages) expected.set(tuple(item.name, item.version), (expected.get(tuple(item.name, item.version)) || 0) + 1);
  const actual = new Map();
  for (const component of components) {
    if (component?.type !== 'library' || typeof component?.name !== 'string' || typeof component?.version !== 'string') {
      throw new Error('Runtime SBOM contains an invalid component.');
    }
    const name = component.group ? `${component.group}/${component.name}` : component.name;
    actual.set(tuple(name, component.version), (actual.get(tuple(name, component.version)) || 0) + 1);
  }
  if (components.length !== inventory.packages.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error('Runtime SBOM component inventory does not exactly match package-lock.json.');
  }
  return sbom;
}

function validateInstalledPackages(files, seen, inventory) {
  const expectedRoots = inventory.packages.map((item) => item.archiveRoot);
  const expectedRootSet = new Set(expectedRoots);
  const expectedManifests = new Set(inventory.packages.map((item) => item.manifestPath));
  for (const archivePath of seen) {
    if (archivePath === 'node_modules') continue;
    if (!archivePath.startsWith('node_modules/')) continue;
    const isScopeDirectory = expectedRoots.some((root) => root.startsWith(`${archivePath}/`));
    const marker = 'node_modules/';
    const markerIndex = archivePath.lastIndexOf(marker);
    const prefix = archivePath.slice(0, markerIndex + marker.length);
    const remainder = archivePath.slice(markerIndex + marker.length).split('/');
    const packageSegments = remainder[0]?.startsWith('@') ? remainder.slice(0, 2) : remainder.slice(0, 1);
    const inferredRoot = packageSegments.every(Boolean) ? `${prefix}${packageSegments.join('/')}` : '';
    if (!isScopeDirectory && !expectedRootSet.has(inferredRoot)) {
      throw new Error(`Runtime node_modules path is absent from package-lock inventory: ${archivePath}.`);
    }
    if (archivePath.endsWith('/package.json') && !expectedManifests.has(archivePath)) {
      throw new Error(`Runtime archive contains an extra installed package manifest: ${archivePath}.`);
    }
  }
  for (const item of inventory.packages) {
    const manifestData = files.get(item.manifestPath);
    if (!manifestData) throw new Error(`Runtime archive is missing locked package manifest: ${item.manifestPath}.`);
    const manifest = parseJson(manifestData, `Installed manifest ${item.manifestPath}`);
    if (manifest?.name !== item.name || manifest?.version !== item.version) {
      throw new Error(`Installed package does not match package-lock inventory: ${item.manifestPath}.`);
    }
  }
}

export function validateRuntimeEntries(entries, expectedReleaseSha) {
  const releaseSha = assertFullReleaseSha(expectedReleaseSha);
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Runtime archive has an invalid entry count.');
  const seen = new Set();
  const files = new Map();
  for (const entry of entries) {
    const isDirectory = entry.typeFlag === '5';
    if (entry.typeFlag !== '0' && !isDirectory) {
      const kind = entry.typeFlag === '1' ? 'hardlink' : entry.typeFlag === '2' ? 'symlink' : 'special entry';
      throw new Error(`Runtime archive contains forbidden ${kind}: ${entry.rawPath}.`);
    }
    if (entry.linkName) throw new Error(`Runtime archive entry unexpectedly has a link target: ${entry.rawPath}.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES || entry.data?.length !== entry.size) {
      throw new Error(`Runtime archive entry has an invalid size: ${entry.rawPath}.`);
    }
    const normalized = normalizeArchivePath(entry.rawPath, { allowRoot: isDirectory });
    if (normalized === '') continue;
    if (normalized === 'server-dist/serverProtocolV1.js') {
      throw new Error('Runtime archive contains the retired protocol-v1 state mutation handler.');
    }
    if (!isAllowedRuntimePath(normalized, isDirectory)) throw new Error(`Runtime archive path is not allowlisted: ${normalized}.`);
    if (seen.has(normalized)) throw new Error(`Runtime archive contains duplicate path: ${normalized}.`);
    seen.add(normalized);
    if (isDirectory) {
      if (entry.size !== 0) throw new Error(`Runtime archive directory has content bytes: ${normalized}.`);
    } else files.set(normalized, entry.data);
  }
  for (const requiredPath of REQUIRED_ARCHIVE_FILES) {
    if (!files.has(requiredPath)) throw new Error(`Runtime archive is missing required file: ${requiredPath}.`);
  }

  for (const [runtimePath, contents] of files) {
    if (runtimePath !== 'server.mjs' && !/^server-dist\/[^/]+\.js$/.test(runtimePath)) continue;
    const source = contents.toString('utf8');
    for (const symbol of RETIRED_WHOLE_STATE_VALIDATION_SYMBOLS) {
      if (source.includes(symbol)) {
        throw new Error(`Runtime archive contains retired whole-state validation symbol: ${symbol}.`);
      }
    }
  }

  const rootRelease = files.get('release.json');
  const distRelease = files.get('dist/release.json');
  const rootChecksum = files.get('release.json.sha256');
  const distChecksum = files.get('dist/release.json.sha256');
  if (!rootRelease.equals(distRelease) || !rootChecksum.equals(distChecksum)) throw new Error('Root and dist release identities must be byte-identical.');
  if (sha256(rootRelease) !== parseReleaseChecksum(rootChecksum.toString('utf8'))) throw new Error('Runtime release identity checksum mismatch.');
  let releaseIdentity;
  try {
    releaseIdentity = validateReleaseIdentity(parseJson(rootRelease, 'Runtime release identity'), { allowDevelopment: false, requireFullSha: true });
  } catch (error) {
    throw new Error(`Invalid runtime release identity: ${error.message}`);
  }
  if (releaseIdentity.releaseSha !== releaseSha) throw new Error('Runtime release identity does not match the expected SHA.');
  const expectedMtime = Math.floor(Date.parse(releaseIdentity.buildTimestamp) / 1000);
  for (const entry of entries) {
    const directory = entry.typeFlag === '5';
    if (entry.uid !== 0 || entry.gid !== 0 || entry.mode !== (directory ? 0o755 : 0o644) || entry.mtime !== expectedMtime) {
      throw new Error(`Runtime archive has noncanonical metadata: ${entry.rawPath}.`);
    }
  }

  const inventory = deriveRuntimeInventory(files.get('package.json'), files.get('package-lock.json'));
  validateInstalledPackages(files, seen, inventory);
  validateSbom(files.get(RUNTIME_SBOM_NAME), releaseSha, inventory);
  return { releaseIdentity, inventory, files };
}

export async function verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha }) {
  const releaseSha = assertFullReleaseSha(expectedReleaseSha);
  const names = artifactNames(releaseSha);
  const resolvedArchive = path.resolve(archivePath);
  const resolvedChecksum = path.resolve(checksumPath);
  if (path.basename(resolvedArchive) !== names.archiveName || path.basename(resolvedChecksum) !== names.checksumName) {
    throw new Error('Runtime artifact filenames do not match the expected release SHA.');
  }
  let archiveFile;
  let checksumFile;
  try {
    archiveFile = await openStableRegularFile(resolvedArchive, 'Runtime artifact');
    checksumFile = await openStableRegularFile(resolvedChecksum, 'Runtime artifact checksum');
    if (archiveFile.stat.size <= 0n || archiveFile.stat.size > BigInt(MAX_ARCHIVE_BYTES)) {
      throw new Error('Runtime artifact size is outside the allowed range.');
    }
    const checksumRead = await readStableFile(checksumFile, 'Runtime artifact checksum');
    const checksumMatch = checksumRead.data.toString('utf8').match(/^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)\n$/);
    if (!checksumMatch || checksumMatch[2] !== names.archiveName) throw new Error('Invalid runtime artifact checksum sidecar.');
    const archiveRead = await readStableFile(archiveFile, 'Runtime artifact');
    const actualChecksum = sha256(archiveRead.data);
    if (!crypto.timingSafeEqual(Buffer.from(checksumMatch[1]), Buffer.from(actualChecksum))) throw new Error('Runtime artifact checksum mismatch.');
    let tarData;
    try {
      tarData = gunzipSync(archiveRead.data, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } catch (error) {
      throw new Error(`Runtime artifact gzip validation failed: ${error.message}`);
    }
    const entries = parseTarArchive(tarData);
    const { releaseIdentity, inventory } = validateRuntimeEntries(entries, releaseSha);
    const finalArchiveStat = await archiveFile.handle.stat({ bigint: true });
    const finalChecksumStat = await checksumFile.handle.stat({ bigint: true });
    assertStableFile(archiveRead.stat, finalArchiveStat, 'Runtime artifact');
    assertStableFile(checksumRead.stat, finalChecksumStat, 'Runtime artifact checksum');
    await assertPathStillReferencesFile(resolvedArchive, finalArchiveStat, 'Runtime artifact');
    await assertPathStillReferencesFile(resolvedChecksum, finalChecksumStat, 'Runtime artifact checksum');
    return {
      releaseSha,
      archivePath: resolvedArchive,
      checksumPath: resolvedChecksum,
      sha256: actualChecksum,
      size: Number(finalArchiveStat.size),
      releaseIdentity,
      packages: inventory.packages.length,
      entries: entries.length
    };
  } finally {
    await checksumFile?.handle.close();
    await archiveFile?.handle.close();
  }
}
