import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { TextDecoder } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  loadReleaseIdentity,
  parseReleaseChecksum,
  sha256,
  validateReleaseIdentity
} from '../server-release.mjs';

const execFileAsync = promisify(execFile);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const RUNTIME_SBOM_NAME = 'skyjo-runtime.cdx.json';

export const RUNTIME_ROOT_FILES = Object.freeze([
  'package-lock.json',
  'package.json',
  'server-account-store.mjs',
  'server-persistence-health.mjs',
  'server-readiness.mjs',
  'server-release.mjs',
  'server-room-persistence.mjs',
  'server-state-backup.mjs',
  'server.mjs'
]);

export const RUNTIME_SCRIPT_FILES = Object.freeze([
  'scripts/backup-state.mjs',
  'scripts/deployed-smoke-lib.mjs',
  'scripts/restore-state.mjs',
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
  'server-dist/runtime.js',
  'server-dist/serverValidation.js',
  'server-dist/types.js',
  RUNTIME_SBOM_NAME,
  ...RUNTIME_ROOT_FILES,
  ...RUNTIME_SCRIPT_FILES,
  'node_modules/react/package.json',
  'node_modules/react-dom/package.json',
  'node_modules/react-router-dom/package.json',
  'node_modules/web-push/package.json',
  'node_modules/ws/package.json'
]);

const exactAllowedPaths = new Set([
  ...RUNTIME_ROOT_FILES,
  ...RUNTIME_SCRIPT_FILES,
  'release.json',
  'release.json.sha256',
  RUNTIME_SBOM_NAME
]);
const allowedDirectoryRoots = new Set(['dist', 'server-dist', 'scripts', 'node_modules']);
const forbiddenSbomComponents = new Set([
  '@cyclonedx/cyclonedx-npm',
  '@playwright/test',
  'typescript',
  'vite',
  'vitest'
]);
const fullShaPattern = /^[a-f0-9]{40}$/;
const checksumPattern = /^[a-f0-9]{64}$/;

export function assertFullReleaseSha(value) {
  const releaseSha = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!fullShaPattern.test(releaseSha)) {
    throw new Error('A full lowercase 40-character release SHA is required.');
  }
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
  if (rawPath.includes('\0') || rawPath.includes('\\')) throw new Error(`Unsafe archive path: ${JSON.stringify(rawPath)}.`);
  let candidate = rawPath;
  while (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (candidate === '.' || candidate === '') {
    if (allowRoot) return '';
    throw new Error('Archive entry cannot target the archive root.');
  }
  if (candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate)) {
    throw new Error(`Absolute archive path is not allowed: ${JSON.stringify(rawPath)}.`);
  }
  const withoutTrailingSlash = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Archive traversal or ambiguous path is not allowed: ${JSON.stringify(rawPath)}.`);
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error(`Archive path contains control characters: ${JSON.stringify(rawPath)}.`);
  }
  return withoutTrailingSlash;
}

export function isAllowedRuntimePath(archivePath, isDirectory = false) {
  const normalized = normalizeArchivePath(archivePath, { allowRoot: true });
  if (normalized === '') return isDirectory;
  if (exactAllowedPaths.has(normalized)) return !isDirectory;
  if (allowedDirectoryRoots.has(normalized)) return isDirectory;
  const [root] = normalized.split('/');
  if (!allowedDirectoryRoots.has(root)) return false;
  if (root === 'scripts') return false;
  return true;
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
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  try {
    return utf8Decoder.decode(content);
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
  if (!Buffer.isBuffer(tarBuffer) || tarBuffer.length === 0 || tarBuffer.length % 512 !== 0) {
    throw new Error('Invalid tar archive length.');
  }
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.length !== 512) throw new Error('Truncated tar header.');
    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) {
        const remainder = tarBuffer.subarray(offset);
        if (!isZeroBlock(remainder)) throw new Error('Unexpected data after tar end marker.');
        return entries;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error('Invalid tar end marker.');
    const expectedChecksum = parseTarNumber(header.subarray(148, 156), 'header checksum');
    if (tarHeaderChecksum(header) !== expectedChecksum) throw new Error('Tar header checksum mismatch.');
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('Only the ustar archive format is accepted.');
    const name = decodeTarString(header.subarray(0, 100), 'entry name');
    const prefix = decodeTarString(header.subarray(345, 500), 'entry prefix');
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = parseTarNumber(header.subarray(124, 136), 'entry size');
    const linkName = decodeTarString(header.subarray(157, 257), 'link name');
    offset += 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarBuffer.length) throw new Error(`Truncated tar entry: ${rawPath}.`);
    entries.push({
      rawPath,
      typeFlag,
      size,
      linkName,
      data: Buffer.from(tarBuffer.subarray(offset, offset + size))
    });
    offset += paddedSize;
  }
  throw new Error('Tar archive is missing the two-block end marker.');
}

function validateSbom(data, releaseSha) {
  let sbom;
  try {
    sbom = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Runtime SBOM is not valid JSON.');
  }
  if (sbom?.bomFormat !== 'CycloneDX' || sbom?.specVersion !== '1.6') {
    throw new Error('Runtime SBOM must be CycloneDX 1.6 JSON.');
  }
  if (sbom?.metadata?.component?.name !== 'skyjo-online') throw new Error('Runtime SBOM component is not Skyjo Online.');
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  const names = new Set(components.map((component) => component?.group ? `${component.group}/${component.name}` : component?.name));
  for (const required of ['react', 'react-dom', 'react-router-dom', 'web-push', 'ws']) {
    if (!names.has(required)) throw new Error(`Runtime SBOM is missing production dependency ${required}.`);
  }
  for (const forbidden of forbiddenSbomComponents) {
    if (names.has(forbidden)) throw new Error(`Runtime SBOM contains dev dependency ${forbidden}.`);
  }
  return { sbom, releaseSha };
}

function validatePackageMetadata(data) {
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Runtime package.json is not valid JSON.');
  }
  if (packageMetadata?.name !== 'skyjo-online' || packageMetadata?.private !== true || packageMetadata?.type !== 'module') {
    throw new Error('Runtime package metadata is invalid.');
  }
  for (const dependency of ['react', 'react-dom', 'react-router-dom', 'web-push', 'ws']) {
    if (typeof packageMetadata.dependencies?.[dependency] !== 'string') {
      throw new Error(`Runtime package metadata is missing ${dependency}.`);
    }
  }
  return packageMetadata;
}

export function validateRuntimeEntries(entries, expectedReleaseSha) {
  const releaseSha = assertFullReleaseSha(expectedReleaseSha);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Runtime archive is empty.');
  const seen = new Set();
  const files = new Map();
  for (const entry of entries) {
    const isDirectory = entry.typeFlag === '5';
    if (entry.typeFlag !== '0' && !isDirectory) {
      const kind = entry.typeFlag === '1' ? 'hardlink' : entry.typeFlag === '2' ? 'symlink' : 'special entry';
      throw new Error(`Runtime archive contains forbidden ${kind}: ${entry.rawPath}.`);
    }
    if (entry.linkName) throw new Error(`Runtime archive entry unexpectedly has a link target: ${entry.rawPath}.`);
    const normalized = normalizeArchivePath(entry.rawPath, { allowRoot: isDirectory });
    if (normalized === '') continue;
    if (!isAllowedRuntimePath(normalized, isDirectory)) throw new Error(`Runtime archive path is not allowlisted: ${normalized}.`);
    if (seen.has(normalized)) throw new Error(`Runtime archive contains duplicate path: ${normalized}.`);
    seen.add(normalized);
    if (isDirectory) {
      if (entry.size !== 0) throw new Error(`Runtime archive directory has content bytes: ${normalized}.`);
    } else {
      files.set(normalized, entry.data);
    }
  }
  for (const requiredPath of REQUIRED_ARCHIVE_FILES) {
    if (!files.has(requiredPath)) throw new Error(`Runtime archive is missing required file: ${requiredPath}.`);
  }
  for (const [archivePath] of files) {
    if (archivePath.startsWith('node_modules/.bin/')) {
      throw new Error('Runtime archive must not contain node_modules executable links.');
    }
  }

  const rootRelease = files.get('release.json');
  const distRelease = files.get('dist/release.json');
  const rootChecksum = files.get('release.json.sha256');
  const distChecksum = files.get('dist/release.json.sha256');
  if (!rootRelease.equals(distRelease) || !rootChecksum.equals(distChecksum)) {
    throw new Error('Root and dist release identities must be byte-identical.');
  }
  const expectedIdentityChecksum = parseReleaseChecksum(rootChecksum.toString('utf8'));
  if (sha256(rootRelease) !== expectedIdentityChecksum) throw new Error('Runtime release identity checksum mismatch.');
  let releaseIdentity;
  try {
    releaseIdentity = validateReleaseIdentity(JSON.parse(rootRelease.toString('utf8')), {
      allowDevelopment: false,
      requireFullSha: true
    });
  } catch (error) {
    throw new Error(`Invalid runtime release identity: ${error.message}`);
  }
  if (releaseIdentity.releaseSha !== releaseSha) throw new Error('Runtime release identity does not match the expected SHA.');
  validatePackageMetadata(files.get('package.json'));
  validateSbom(files.get(RUNTIME_SBOM_NAME), releaseSha);
  return { releaseIdentity, files };
}

async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  return sha256(data);
}

export async function verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha }) {
  const releaseSha = assertFullReleaseSha(expectedReleaseSha);
  const names = artifactNames(releaseSha);
  const resolvedArchive = path.resolve(archivePath);
  const resolvedChecksum = path.resolve(checksumPath);
  if (path.basename(resolvedArchive) !== names.archiveName || path.basename(resolvedChecksum) !== names.checksumName) {
    throw new Error('Runtime artifact filenames do not match the expected release SHA.');
  }
  const archiveStat = await fs.lstat(resolvedArchive);
  const checksumStat = await fs.lstat(resolvedChecksum);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || !checksumStat.isFile() || checksumStat.isSymbolicLink()) {
    throw new Error('Runtime artifact and checksum must be regular files.');
  }
  if (archiveStat.size <= 0 || archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('Runtime artifact size is outside the allowed range.');
  const checksumText = await fs.readFile(resolvedChecksum, 'utf8');
  const checksumMatch = checksumText.match(/^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)\n$/);
  if (!checksumMatch || checksumMatch[2] !== names.archiveName || !checksumPattern.test(checksumMatch[1])) {
    throw new Error('Invalid runtime artifact checksum sidecar.');
  }
  const archiveData = await fs.readFile(resolvedArchive);
  const actualChecksum = sha256(archiveData);
  if (!crypto.timingSafeEqual(Buffer.from(checksumMatch[1]), Buffer.from(actualChecksum))) {
    throw new Error('Runtime artifact checksum mismatch.');
  }
  let tarData;
  try {
    tarData = gunzipSync(archiveData, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(`Runtime artifact gzip validation failed: ${error.message}`);
  }
  const entries = parseTarArchive(tarData);
  const { releaseIdentity } = validateRuntimeEntries(entries, releaseSha);
  return {
    releaseSha,
    archivePath: resolvedArchive,
    checksumPath: resolvedChecksum,
    sha256: actualChecksum,
    size: archiveStat.size,
    releaseIdentity,
    entries: entries.length
  };
}

async function copyRegularFile(sourcePath, targetPath) {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime source must be a regular file: ${sourcePath}.`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, 0o644);
}

async function copyRegularTree(sourceDirectory, targetDirectory) {
  const rootStat = await fs.lstat(sourceDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Runtime source must be a real directory: ${sourceDirectory}.`);
  await fs.mkdir(targetDirectory, { recursive: true, mode: 0o755 });
  const children = await fs.readdir(sourceDirectory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const child of children) {
    const sourcePath = path.join(sourceDirectory, child.name);
    const targetPath = path.join(targetDirectory, child.name);
    if (child.isSymbolicLink()) throw new Error(`Runtime source contains a symlink: ${sourcePath}.`);
    if (child.isDirectory()) await copyRegularTree(sourcePath, targetPath);
    else if (child.isFile()) await copyRegularFile(sourcePath, targetPath);
    else throw new Error(`Runtime source contains a special filesystem entry: ${sourcePath}.`);
  }
}

async function assertTreeHasOnlyRegularFiles(rootDirectory) {
  const children = await fs.readdir(rootDirectory, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(rootDirectory, child.name);
    if (child.isSymbolicLink()) throw new Error(`Runtime stage contains a symlink: ${childPath}.`);
    if (child.isDirectory()) await assertTreeHasOnlyRegularFiles(childPath);
    else if (!child.isFile()) throw new Error(`Runtime stage contains a special filesystem entry: ${childPath}.`);
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...options
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function assertPackagingTools() {
  if (process.platform !== 'linux') throw new Error('Reproducible runtime artifacts must be built on Linux.');
  const [{ stdout: tarVersion }, { stdout: gzipVersion }] = await Promise.all([
    run('tar', ['--version']),
    run('gzip', ['--version'])
  ]);
  if (!tarVersion.startsWith('tar (GNU tar)')) throw new Error('GNU tar is required for reproducible runtime artifacts.');
  if (!gzipVersion.toLowerCase().includes('gzip')) throw new Error('GNU gzip is required for reproducible runtime artifacts.');
}

async function gzipFile(sourcePath, targetPath) {
  const child = spawn('gzip', ['-n', '-9', '-c', sourcePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = createWriteStream(targetPath, { flags: 'wx', mode: 0o644 });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.pipe(output);
  await Promise.all([
    new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`gzip failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      });
    }),
    new Promise((resolve, reject) => {
      output.on('error', reject);
      output.on('close', resolve);
    })
  ]);
}

function cyclonedxCliPath(projectRoot) {
  return path.join(projectRoot, 'node_modules', '@cyclonedx', 'cyclonedx-npm', 'bin', 'cyclonedx-npm-cli.js');
}

export async function generateRuntimeSbom({ projectRoot, packageRoot = projectRoot, outputPath }) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o755 });
  const cliPath = cyclonedxCliPath(resolvedProjectRoot);
  const cliStat = await fs.lstat(cliPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) throw new Error('Pinned CycloneDX CLI is not a regular file.');
  await run(process.execPath, [
    cliPath,
    '--omit', 'dev',
    '--spec-version', '1.6',
    '--output-reproducible',
    '--output-format', 'JSON',
    '--output-file', resolvedOutput,
    '--validate',
    path.join(resolvedPackageRoot, 'package.json')
  ], {
    cwd: resolvedPackageRoot,
    env: { ...process.env, NODE_ENV: 'production' }
  });
  const data = await fs.readFile(resolvedOutput);
  validateSbom(data, '0000000000000000000000000000000000000000');
  await fs.chmod(resolvedOutput, 0o644);
  return resolvedOutput;
}

export async function buildRuntimeArtifact({ projectRoot, outputDirectory, releaseSha }) {
  await assertPackagingTools();
  const normalizedSha = assertFullReleaseSha(releaseSha);
  const root = path.resolve(projectRoot);
  const output = path.resolve(outputDirectory);
  const names = artifactNames(normalizedSha);
  const archivePath = path.join(output, names.archiveName);
  const checksumPath = path.join(output, names.checksumName);
  const externalSbomPath = path.join(output, names.sbomName);
  const releaseIdentity = await loadReleaseIdentity(path.join(root, 'dist'), {
    allowDevelopment: false,
    requireFullSha: true
  });
  if (releaseIdentity.releaseSha !== normalizedSha) throw new Error('Built release identity does not match the requested artifact SHA.');
  await fs.mkdir(output, { recursive: true, mode: 0o755 });
  for (const target of [archivePath, checksumPath, externalSbomPath]) await fs.rm(target, { force: true });

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-runtime-artifact-'));
  const stage = path.join(temporaryRoot, 'stage');
  const tarPath = path.join(temporaryRoot, `${names.archiveName}.tar`);
  try {
    await fs.mkdir(stage, { recursive: true, mode: 0o755 });
    await Promise.all([
      copyRegularTree(path.join(root, 'dist'), path.join(stage, 'dist')),
      copyRegularTree(path.join(root, 'server-dist'), path.join(stage, 'server-dist'))
    ]);
    for (const relativePath of [...RUNTIME_ROOT_FILES, ...RUNTIME_SCRIPT_FILES]) {
      await copyRegularFile(path.join(root, relativePath), path.join(stage, relativePath));
    }
    await Promise.all([
      copyRegularFile(path.join(root, 'dist', 'release.json'), path.join(stage, 'release.json')),
      copyRegularFile(path.join(root, 'dist', 'release.json.sha256'), path.join(stage, 'release.json.sha256'))
    ]);

    await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: stage,
      env: { ...process.env, NODE_ENV: 'production' }
    });
    await fs.rm(path.join(stage, 'node_modules', '.bin'), { recursive: true, force: true });
    await generateRuntimeSbom({ projectRoot: root, packageRoot: stage, outputPath: path.join(stage, RUNTIME_SBOM_NAME) });
    await copyRegularFile(path.join(stage, RUNTIME_SBOM_NAME), externalSbomPath);
    await assertTreeHasOnlyRegularFiles(stage);

    const buildEpoch = Math.floor(Date.parse(releaseIdentity.buildTimestamp) / 1000);
    await run('tar', [
      '--sort=name',
      '--format=ustar',
      `--mtime=@${buildEpoch}`,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=u+rwX,go+rX,go-w',
      '-cf', tarPath,
      '-C', stage,
      '.'
    ]);
    await gzipFile(tarPath, archivePath);
    const archiveChecksum = await hashFile(archivePath);
    await fs.writeFile(checksumPath, `${archiveChecksum}  ${names.archiveName}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    const verification = await verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: normalizedSha });
    return { ...verification, sbomPath: externalSbomPath };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
