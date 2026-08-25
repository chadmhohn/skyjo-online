#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_LOCK_PATH,
  acquireAdmissionLock,
  combineAdmissionLockErrors,
  isAdmissionLockConflict
} from './admission-lock.mjs';
import {
  assertGithubCommitOnMain,
  authorizeRollback,
  cleanupStaleIncomingDirectories,
  executeCodeRollbackTransaction,
  executeActivationTransaction,
  fsyncFilesystemPath,
  MAX_ARCHIVE_BYTES,
  loadVerifiedReleaseIdentity,
  proveDurablePublishedDirectory,
  publishImmutableDirectory,
  readLinkWithin,
  replaceSymlink,
  resolveGithubTag,
  resolveWithin,
  selectReleasePathsToPrune,
  sha256File,
  validateArchiveListing
} from './release-controller-lib.mjs';
import {
  createPredeploySnapshot,
  materializePredeploySnapshot,
  verifyPredeploySnapshot
} from './state-snapshot-lib.mjs';
import {
  beginAuthorizationUse,
  parseSignedDeploymentCommand,
  verifyDeploymentAuthorization
} from './deployment-authorization-lib.mjs';
import { validateDeploymentPublicKeys } from './validate-deployment-public-keys.mjs';

const PATHS = Object.freeze({
  node: '/opt/skyjo-online/node/bin/node',
  nodeRoot: '/opt/skyjo-online',
  nodeTarget: '/opt/skyjo-online/node-v24.18.0',
  nodeMarker: '/opt/skyjo-online/node-v24.18.0/.skyjo-node-runtime',
  appRoot: '/srv/skyjo-online',
  releases: '/srv/skyjo-online/releases',
  current: '/srv/skyjo-online/current',
  previous: '/srv/skyjo-online/previous',
  stage: '/var/tmp/skyjo-deploy',
  state: '/var/lib/skyjo-online',
  backups: '/var/backups/skyjo-online',
  canaryEnv: '/run/skyjo-online-canary',
  authorizationKeys: '/etc/skyjo-deploy-auth',
  authorizationReplay: '/var/lib/skyjo-deploy-authorizations',
  assetManifest: '/usr/local/share/skyjo-online/delivery-assets.sha256',
  bootstrapStore: '/usr/local/lib/skyjo-online/bootstrap',
  bootstrapWrapper: '/usr/local/sbin/skyjo-delivery-bootstrap',
  stagedProductionUnit: '/usr/local/share/skyjo-online/skyjo-online.service',
  service: 'skyjo-online.service'
});

const AUTHORIZATION_KEYRING = new Map([
  ['canary-2026-07', Object.freeze({ role: 'canary', publicKeyPath: '/etc/skyjo-deploy-auth/canary-2026-07.pem' })],
  ['production-2026-07', Object.freeze({ role: 'production', publicKeyPath: '/etc/skyjo-deploy-auth/production-2026-07.pem' })]
]);
const STAGE_ADMISSION_MARKER = '.quota-admitted';
const controllerLifecycleKeepAliveMs = 60_000;
const archiveCopyBufferBytes = 64 * 1024;

export function parseArguments(argv) {
  const command = argv.shift();
  if (!['verify', 'promote', 'rollback', 'self-test'].includes(command || '')) throw new Error('Unsupported controller action.');
  if (command === 'self-test') {
    if (argv.length) throw new Error('Self-test takes no arguments.');
    return { command };
  }
  if (argv.length !== 2 || argv[0] !== '--authorization-command' || typeof argv[1] !== 'string') {
    throw new Error('A signed deployment authorization command is required.');
  }
  return { command, signedCommand: argv[1] };
}

export function validatePrivateIdentityGroups(identities, passwdText) {
  const ownersByGid = new Map(Object.entries(identities).map(([name, identity]) => [identity.gid, name]));
  if (ownersByGid.size !== Object.keys(identities).length) throw new Error('Production, canary, and deployment primary groups must be distinct.');
  for (const record of passwdText.replace(/\r/g, '').split('\n').filter(Boolean)) {
    const fields = record.split(':');
    if (fields.length !== 7 || !/^[0-9]+$/.test(fields[3])) throw new Error('System passwd identity is malformed.');
    const owner = ownersByGid.get(Number(fields[3]));
    if (owner && fields[0] !== owner) throw new Error(`Private runtime group ${owner} is shared by another primary identity.`);
  }
}

async function run(file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 4 * 1024 * 1024) child.kill('SIGKILL'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 120_000);
  timer.unref();
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (status.code !== 0 || status.signal) {
    const detail = stderr.trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${path.basename(file)} failed${detail ? `: ${detail}` : ''}`);
  }
  return stdout;
}

async function assertNode24() {
  const expectedMarker = 'format=1\nversion=24.18.0\narchive_sha256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742\n';
  const link = await fsp.lstat(path.join(PATHS.nodeRoot, 'node'));
  if (!link.isSymbolicLink() || link.uid !== 0 || link.gid !== 0 || await fsp.readlink(path.join(PATHS.nodeRoot, 'node')) !== 'node-v24.18.0') {
    throw new Error('Pinned Skyjo Node link is unsafe or points to an unexpected target.');
  }
  for (const component of ['/opt', PATHS.nodeRoot, PATHS.nodeTarget, `${PATHS.nodeTarget}/bin`, `${PATHS.nodeTarget}/lib`, `${PATHS.nodeTarget}/lib/node_modules`, `${PATHS.nodeTarget}/lib/node_modules/npm`, `${PATHS.nodeTarget}/lib/node_modules/npm/bin`]) {
    const stat = await fsp.lstat(component);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`Pinned Skyjo Node path component is unsafe: ${component}`);
    }
  }
  for (const file of [PATHS.node, `${PATHS.nodeTarget}/lib/node_modules/npm/bin/npm-cli.js`, PATHS.nodeMarker]) {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`Pinned Skyjo Node file is unsafe: ${file}`);
    }
  }
  if (await readNoFollow(PATHS.nodeMarker) !== expectedMarker) throw new Error('Pinned Skyjo Node runtime marker is invalid.');
  const version = (await run(PATHS.node, ['--version'])).trim();
  if (version !== 'v24.18.0') throw new Error('Pinned Skyjo Node v24.18.0 is required.');
}

function normalizeError(caught) {
  return caught instanceof Error ? caught : new Error(String(caught));
}

export async function copyArchive(source, destination, {
  openFile = fsp.open,
  removeFile = fsp.rm
} = {}) {
  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  let copiedBytes;
  let primaryError;
  try {
    sourceHandle = await openFile(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await sourceHandle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('Staged artifact is not a safe regular file.');
    destinationHandle = await openFile(
      destination,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o400
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(archiveCopyBufferBytes);
    let position = 0;
    while (position < stat.size) {
      const requested = Math.min(buffer.length, stat.size - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > requested) {
        throw new Error('Staged artifact changed or ended during copy.');
      }
      let writeOffset = 0;
      while (writeOffset < bytesRead) {
        const remaining = bytesRead - writeOffset;
        const { bytesWritten } = await destinationHandle.write(buffer, writeOffset, remaining, position + writeOffset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) {
          throw new Error('Staged artifact copy made no forward progress.');
        }
        writeOffset += bytesWritten;
      }
      position += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await sourceHandle.read(trailing, 0, 1, position)).bytesRead !== 0) throw new Error('Staged artifact grew during copy.');
    await destinationHandle.sync();
    copiedBytes = position;
  } catch (caught) {
    primaryError = normalizeError(caught);
  }

  const cleanupErrors = [];
  for (const handle of [destinationHandle, sourceHandle]) {
    if (!handle) continue;
    try { await handle.close(); }
    catch (caught) { cleanupErrors.push(normalizeError(caught)); }
  }
  if ((primaryError || cleanupErrors.length > 0) && destinationCreated) {
    try { await removeFile(destination, { force: true }); }
    catch (caught) { cleanupErrors.push(normalizeError(caught)); }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], 'Archive copy failed and cleanup was incomplete.', { cause: primaryError });
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Archive copy cleanup failed.');
  return copiedBytes;
}

async function fsyncDirectoryStrict(directory) {
  const handle = await fsp.open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function lines(value) {
  return value.replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
}

export function classifyStageClaimOwnership(value, { deployUid, deployGid }) {
  const uploaderStage = value.stageUid === deployUid && value.stageGid === deployGid && value.stageMode === 0o700;
  const rootStage = value.stageUid === 0 && value.stageGid === 0 && [0o700, 0o711].includes(value.stageMode);
  const uploaderMarker = value.markerUid === deployUid && value.markerGid === deployGid && value.markerMode === 0o400;
  const rootMarker = value.markerUid === 0 && value.markerGid === 0 && value.markerMode === 0o400;
  const uploaderArchive = value.archiveUid === deployUid && value.archiveGid === deployGid && value.archiveMode === 0o600;
  const rootArchive = value.archiveUid === 0 && value.archiveGid === 0 && [0o600, 0o400].includes(value.archiveMode);
  if ((!uploaderStage && !rootStage) || (!uploaderMarker && !rootMarker) || (!uploaderArchive && !rootArchive)) {
    throw new Error('Deployment stage claim ownership is unsafe.');
  }
  if (uploaderStage && uploaderMarker && uploaderArchive) return 'uploaded';
  if (rootStage && value.stageMode === 0o711 && rootMarker && rootArchive && value.archiveMode === 0o400) return 'claimed';
  return 'claiming';
}

function combinedActionAndCleanupError(primaryCaught, cleanupCaught) {
  const primaryError = normalizeError(primaryCaught);
  const cleanupError = normalizeError(cleanupCaught);
  const combined = new AggregateError(
    [primaryError, cleanupError],
    'Deployment action failed and its run directory cleanup also failed.',
    { cause: primaryError }
  );
  Object.defineProperty(combined, 'deploymentActionError', { value: primaryError, enumerable: false });
  Object.defineProperty(combined, 'deploymentCleanupError', { value: cleanupError, enumerable: false });
  Object.defineProperty(combined, 'runCleanupError', { value: cleanupError, enumerable: false });
  const reserved = new Set(['name', 'message', 'stack', 'cause', 'errors']);
  for (const key of Reflect.ownKeys(primaryError)) {
    if (typeof key === 'string' && reserved.has(key)) continue;
    if (Object.hasOwn(combined, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(primaryError, key);
    if (descriptor) Object.defineProperty(combined, key, descriptor);
  }
  return combined;
}

function assertRunIdentity(stat, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity !== 'object') {
    throw new Error('A proven deployment run identity is required for cleanup.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Deployment run directory type changed before cleanup.');
  }
  const actual = {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777
  };
  for (const key of ['dev', 'ino', 'uid', 'gid', 'mode']) {
    if (actual[key] !== expectedIdentity[key]) {
      throw new Error(`Deployment run directory ${key} changed before cleanup.`);
    }
  }
}

export async function proveClaimedRunDirectory(workDirectory, {
  openFile = fsp.open,
  inspect = fsp.lstat,
  requireRootOwnership = process.platform !== 'win32'
} = {}) {
  const handle = await openFile(
    workDirectory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)
  );
  let handleStat;
  let pathStat;
  try {
    handleStat = await handle.stat();
    pathStat = await inspect(workDirectory);
  } finally {
    await handle.close();
  }
  if (!handleStat.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink() ||
      handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    throw new Error('Deployment run directory identity is unsafe.');
  }
  const identity = Object.freeze({
    dev: handleStat.dev,
    ino: handleStat.ino,
    uid: handleStat.uid,
    gid: handleStat.gid,
    mode: handleStat.mode & 0o7777
  });
  if (requireRootOwnership && (identity.uid !== 0 || identity.gid !== 0 || identity.mode !== 0o711)) {
    throw new Error('Deployment run directory claim is incomplete.');
  }
  assertRunIdentity(pathStat, identity);
  return identity;
}

async function proveClaimedFile(filePath, originalStat, expectedContent) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let handleStat;
  let pathStat;
  let content;
  try {
    handleStat = await handle.stat();
    pathStat = await fsp.lstat(filePath);
    if (expectedContent !== undefined) content = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  if (!handleStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
      handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino ||
      handleStat.dev !== originalStat.dev || handleStat.ino !== originalStat.ino ||
      (process.platform !== 'win32' && (handleStat.uid !== 0 || handleStat.gid !== 0 || (handleStat.mode & 0o7777) !== 0o400)) ||
      (expectedContent !== undefined && content !== expectedContent)) {
    throw new Error('Deployment stage claim artifact identity is unsafe.');
  }
}

async function prepareCandidate({ runId, releaseSha, digest }) {
  await fsyncDirectoryStrict(PATHS.stage);
  const stageDirectory = resolveWithin(PATHS.stage, runId);
  const stageStat = await fsp.lstat(stageDirectory);
  const deployUid = Number((await run('/usr/bin/id', ['-u', 'skyjo-deploy'])).trim());
  const deployGid = Number((await run('/usr/bin/id', ['-g', 'skyjo-deploy'])).trim());
  if (!Number.isSafeInteger(deployUid) || !Number.isSafeInteger(deployGid)) throw new Error('Deployment identity is invalid.');
  const stageMode = stageStat.mode & 0o7777;
  const uploadedStage = process.platform === 'win32' || (stageStat.uid === deployUid && stageStat.gid === deployGid && stageMode === 0o700);
  const controllerOwnedStage = process.platform !== 'win32' && stageStat.uid === 0 && stageStat.gid === 0 && [0o700, 0o711].includes(stageMode);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || (!uploadedStage && !controllerOwnedStage)) {
    throw new Error('Deployment stage is unsafe.');
  }
  const markerPath = resolveWithin(stageDirectory, STAGE_ADMISSION_MARKER);
  const markerHandle = await fsp.open(
    markerPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  let markerStat;
  try {
    markerStat = await markerHandle.stat();
    const uploadedMarker = markerStat.uid === deployUid && markerStat.gid === deployGid;
    const controllerMarker = markerStat.uid === 0 && markerStat.gid === 0;
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || (!uploadedMarker && !controllerMarker) ||
        (process.platform !== 'win32' && (markerStat.mode & 0o7777) !== 0o400) ||
        await markerHandle.readFile('utf8') !== `${runId}\n`) {
      throw new Error('Deployment stage admission marker is unsafe.');
    }
  } finally {
    await markerHandle.close();
  }
  const sourceArchive = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
  const archiveStat = await fsp.lstat(sourceArchive);
  const archiveMode = archiveStat.mode & 0o7777;
  const uploadedArchive = archiveStat.uid === deployUid && archiveStat.gid === deployGid && archiveMode === 0o600;
  const controllerArchive = archiveStat.uid === 0 && archiveStat.gid === 0 && [0o600, 0o400].includes(archiveMode);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || (process.platform !== 'win32' && !uploadedArchive && !controllerArchive)) {
    throw new Error('Deployment stage archive ownership is unsafe.');
  }
  classifyStageClaimOwnership({
    stageUid: stageStat.uid,
    stageGid: stageStat.gid,
    stageMode,
    markerUid: markerStat.uid,
    markerGid: markerStat.gid,
    markerMode: markerStat.mode & 0o7777,
    archiveUid: archiveStat.uid,
    archiveGid: archiveStat.gid,
    archiveMode
  }, { deployUid, deployGid });
  await fsyncDirectoryStrict(stageDirectory);
  await run('/usr/bin/chown', ['root:root', stageDirectory]);
  await run('/usr/bin/chmod', ['0711', stageDirectory]);
  await run('/usr/bin/chown', ['root:root', markerPath]);
  await run('/usr/bin/chmod', ['0400', markerPath]);
  await run('/usr/bin/chown', ['root:root', sourceArchive]);
  await run('/usr/bin/chmod', ['0400', sourceArchive]);
  await fsyncDirectoryStrict(stageDirectory);
  const workDirectory = stageDirectory;
  const runIdentity = await proveClaimedRunDirectory(workDirectory);
  if (runIdentity.dev !== stageStat.dev || runIdentity.ino !== stageStat.ino) {
    throw new Error('Deployment run directory changed while it was claimed.');
  }
  await proveClaimedFile(markerPath, markerStat, `${runId}\n`);
  await proveClaimedFile(sourceArchive, archiveStat);
  const privateArchive = resolveWithin(workDirectory, 'artifact.tar.gz');
  return executeWithRequiredRunCleanup({
    cleanupOnSuccess: false,
    cleanup: () => cleanupRun(runId, workDirectory, { expectedIdentity: runIdentity }),
    action: async () => {
      await fsp.rm(privateArchive, { force: true });
      await copyArchive(sourceArchive, privateArchive);
      if (await sha256File(privateArchive) !== digest) throw new Error('Artifact SHA-256 does not match the approved digest.');
      const names = lines(await run('/usr/bin/tar', ['--gzip', '--list', '--file', privateArchive], { timeoutMs: 30_000 }));
      const verbose = lines(await run('/usr/bin/tar', ['--gzip', '--list', '--verbose', '--full-time', '--numeric-owner', '--file', privateArchive], { timeoutMs: 30_000 }));
      const archiveContract = validateArchiveListing(names, verbose);
      const candidate = resolveWithin(workDirectory, 'release');
      await fsp.rm(candidate, { recursive: true, force: true });
      await fsp.mkdir(candidate, { mode: 0o755 });
      await run('/usr/bin/tar', ['--gzip', '--extract', '--file', privateArchive, '--directory', candidate, '--no-same-owner', '--no-same-permissions', '--delay-directory-restore']);
      const identity = await loadVerifiedReleaseIdentity(candidate, releaseSha);
      if (Math.floor(Date.parse(archiveContract.canonicalTimestamp) / 1000) !== Math.floor(Date.parse(identity.buildTimestamp) / 1000)) {
        throw new Error('Archive timestamp does not match release identity.');
      }
      await run('/usr/bin/chown', ['--recursive', 'root:root', candidate]);
      await run('/usr/bin/chmod', ['--recursive', 'u=rwX,go=rX', candidate]);
      await fsp.writeFile(resolveWithin(candidate, '.skyjo-deployment.json'), `${JSON.stringify({ releaseSha, artifactSha256: digest })}\n`, { mode: 0o444 });
      return { workDirectory, candidate, identity, runIdentity };
    }
  });
}

export function validateEffectiveSystemdProperties(unit, actual, expected) {
  for (const [property, expectedValue] of expected) {
    if (actual.get(property) !== expectedValue) throw new Error(`Effective systemd property ${property} is invalid for ${unit}.`);
  }
}

async function createSnapshot(rollbackAnchor, destination) {
  await createPredeploySnapshot({
    databasePath: resolveWithin(PATHS.state, 'skyjo.sqlite'),
    roomsPath: resolveWithin(PATHS.state, 'rooms.json'),
    destinationDirectory: destination,
    source: {
      releaseSha: rollbackAnchor.releaseSha,
      legacy: rollbackAnchor.legacy === true
    },
    expectedOwnerUid: 0,
    expectedOwnerGid: 0
  });
  await verifyPredeploySnapshot(destination, { expectedOwnerUid: 0, expectedOwnerGid: 0 });
  return destination;
}

export async function executeAuthorizedControllerAction({
  expectedCommand,
  signedCommand,
  action,
  reconcileReplay,
  reconcileStarted,
  reconcileCompletion,
  recoverCompletionFailure,
  keyring = AUTHORIZATION_KEYRING,
  ledgerRoot = PATHS.authorizationReplay,
  nowSeconds = Math.floor(Date.now() / 1000),
  expectedUid = 0,
  beginAuthorization = beginAuthorizationUse,
  allowStartedRecovery = false
}) {
  const { fields, signature } = parseSignedDeploymentCommand(signedCommand, { nowSeconds, checkFreshness: false });
  if (fields.command !== expectedCommand) throw new Error('Signed deployment command does not match the requested controller action.');
  const verified = await verifyDeploymentAuthorization({
    fields,
    signature,
    keyring,
    nowSeconds,
    expectedUid,
    checkFreshness: false
  });
  // The SSH transport can disappear after authorization. Once the replay record
  // is about to be consumed, a hangup must not interrupt stop/swap/recovery or
  // ledger finalization. The no-fork flock wrapper keeps the same Node process
  // holding the host lock while this handler is installed.
  const ignoreAuthorizedHangup = () => {};
  if (process.platform === 'linux') process.on('SIGHUP', ignoreAuthorizedHangup);
  try {
    const authorizationUse = await beginAuthorization({
      ledgerRoot,
      ...verified,
      nowSeconds,
      expectedUid,
      allowStartedRecovery
    });
    if (authorizationUse.replayed) {
      await reconcileReplay?.(fields, authorizationUse.result);
      return authorizationUse.result;
    }
    let result;
    let resumedWithResult = false;
    if (authorizationUse.resumed) {
      const decision = await reconcileStarted?.(fields);
      if (!decision || !['execute', 'complete'].includes(decision.kind)) {
        throw new Error('Started deployment operation cannot be safely reconciled.');
      }
      if (decision.kind === 'complete') {
        result = decision.result;
        resumedWithResult = true;
      }
    }
    if (!resumedWithResult) {
      try {
        result = await action(fields);
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        await authorizationUse.fail().catch((ledgerError) => {
          Object.defineProperty(error, 'authorizationLedgerError', { value: ledgerError, enumerable: false });
        });
        throw error;
      }
    }
    try {
      await authorizationUse.complete(result);
      return result;
    } catch (firstCaught) {
      const firstError = firstCaught instanceof Error ? firstCaught : new Error(String(firstCaught));
      try {
        await reconcileCompletion?.(fields, result);
        await authorizationUse.complete(result);
        return result;
      } catch (secondCaught) {
        const error = secondCaught instanceof Error ? secondCaught : new Error(String(secondCaught));
        Object.defineProperty(error, 'initialAuthorizationCompletionError', { value: firstError, enumerable: false });
        let terminalError = error;
        try {
          await recoverCompletionFailure?.(fields, result, error);
        } catch (recoveryCaught) {
          const recoveryError = recoveryCaught instanceof Error ? recoveryCaught : new Error(String(recoveryCaught));
          if (fields.command === 'promote' && recoveryError.deploymentStatus !== 'rollback-failed') {
            Object.defineProperty(recoveryError, 'deploymentStatus', { value: 'rollback-failed', enumerable: true });
          }
          Object.defineProperty(recoveryError, 'completionPersistenceError', { value: error, enumerable: false });
          terminalError = recoveryError;
        }
        await authorizationUse.fail().catch((ledgerError) => {
          Object.defineProperty(terminalError, 'authorizationLedgerError', { value: ledgerError, enumerable: false });
        });
        Object.defineProperty(terminalError, 'deploymentActionCompleted', { value: true, enumerable: false });
        throw terminalError;
      }
    }
  } finally {
    if (process.platform === 'linux') process.off('SIGHUP', ignoreAuthorizedHangup);
  }
}

export function writeTerminalLine(fd, line) {
  try {
    fs.writeFileSync(fd, line, { encoding: 'utf8' });
    return true;
  } catch (error) {
    if (error?.code === 'EPIPE') return false;
    throw error;
  }
}

async function waitForRelease(baseUrl, expectedSha, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
      const body = await response.json();
      if (response.status === 200 && body.status === 'ready' && body.releaseSha === expectedSha) return body;
      lastError = new Error('Readiness did not identify the expected release.');
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Release readiness timed out: ${lastError?.message || 'unknown error'}`);
}

async function assertHardenedProductionUnit() {
  const exactProperties = new Map([
    ['User', 'skyjo'],
    ['Group', 'skyjo'],
    ['FragmentPath', '/etc/systemd/system/skyjo-online.service'],
    ['NoNewPrivileges', 'yes'],
    ['PrivateTmp', 'yes'],
    ['ProtectSystem', 'strict'],
    ['ProtectHome', 'yes'],
    ['DropInPaths', '']
  ]);
  const actualProperties = new Map();
  for (const property of exactProperties.keys()) {
    actualProperties.set(property, (await run('/usr/bin/systemctl', ['show', PATHS.service, `--property=${property}`, '--value'])).trim());
  }
  validateEffectiveSystemdProperties(PATHS.service, actualProperties, exactProperties);
  const execStart = (await run('/usr/bin/systemctl', ['show', PATHS.service, '--property=ExecStart', '--value'])).trim();
  if (!/^\{ path=\/opt\/skyjo-online\/node\/bin\/node ; argv\[\]=\/opt\/skyjo-online\/node\/bin\/node \/srv\/skyjo-online\/current\/server\.mjs ;/.test(execStart)) {
    throw new Error('The hardened production unit ExecStart property is invalid.');
  }
  const readWritePaths = (await run('/usr/bin/systemctl', ['show', PATHS.service, '--property=ReadWritePaths', '--value'])).trim().split(/\s+/);
  if (readWritePaths.length !== 1 || readWritePaths[0] !== '/var/lib/skyjo-online') {
    throw new Error('The hardened production unit writable path boundary is invalid.');
  }
}

async function prepareStateOwnership() {
  const stat = await fsp.lstat(PATHS.state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Production state directory is unsafe.');
  for (const entry of await fsp.readdir(PATHS.state)) {
    const entryStat = await fsp.lstat(resolveWithin(PATHS.state, entry));
    if (entryStat.isSymbolicLink() || (!entryStat.isFile() && !entryStat.isDirectory())) {
      throw new Error(`Production state contains an unsafe entry: ${entry}`);
    }
  }
  await run('/usr/bin/chown', ['--recursive', 'skyjo:skyjo', PATHS.state]);
  await run('/usr/bin/chmod', ['0700', PATHS.state]);
  for (const file of ['skyjo.sqlite', 'skyjo.sqlite-wal', 'skyjo.sqlite-shm', 'rooms.json']) {
    const filePath = resolveWithin(PATHS.state, file);
    await fsp.chmod(filePath, 0o600).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function validateRollbackAnchor(releaseDirectory) {
  const legacy = await fsp.access(resolveWithin(releaseDirectory, '.skyjo-legacy')).then(() => true).catch(() => false);
  if (!legacy) return loadVerifiedReleaseIdentity(releaseDirectory, path.basename(releaseDirectory));
  await run('/usr/bin/sha256sum', ['--check', '--strict', '.skyjo-legacy-manifest.sha256'], { cwd: releaseDirectory });
  await run(PATHS.node, ['--check', resolveWithin(releaseDirectory, 'server.mjs')]);
  return { legacy: true, releaseSha: path.basename(releaseDirectory) };
}

export async function executeCanaryLifecycle(operations) {
  let primaryError;
  try {
    await operations.prepareEnvironment();
    await operations.startServer();
    await operations.waitUntilReady();
    await operations.runAuthenticatedSmoke();
    await operations.runStateProof();
    await operations.verifySourceSnapshot();
  } catch (caught) {
    primaryError = caught instanceof Error ? caught : new Error(String(caught));
  }

  const cleanupErrors = [];
  for (const [stage, cleanup] of [
    ['stop-server', operations.stopServer],
    ['reset-units', operations.resetUnits],
    ['remove-environment', operations.removeEnvironment]
  ]) {
    try { await cleanup(); }
    catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      Object.defineProperty(error, 'canaryCleanupStage', { value: stage, enumerable: true });
      cleanupErrors.push(error);
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) Object.defineProperty(primaryError, 'canaryCleanupErrors', { value: cleanupErrors, enumerable: false });
    if (cleanupErrors.some((error) => error.canaryCleanupStage === 'stop-server' || error.preserveRunRoot === true)) {
      Object.defineProperty(primaryError, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    const error = new AggregateError(cleanupErrors, 'Canary passed but cleanup did not complete safely.');
    if (cleanupErrors.some((cleanupError) => cleanupError.canaryCleanupStage === 'stop-server' || cleanupError.preserveRunRoot === true)) {
      Object.defineProperty(error, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw error;
  }
}

const temporaryUnitStateKeys = Object.freeze([
  'Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID', 'ControlPID', 'Job',
  'FragmentPath', 'DropInPaths', 'CollectMode'
]);
const temporaryUnitFragments = Object.freeze({
  'skyjo-online-canary': '/etc/systemd/system/skyjo-online-canary@.service',
  'skyjo-online-canary-smoke': '/etc/systemd/system/skyjo-online-canary-smoke@.service',
  'skyjo-online-state-proof': '/etc/systemd/system/skyjo-online-state-proof@.service',
  'skyjo-online-smoke': '/etc/systemd/system/skyjo-online-smoke@.service',
  'skyjo-online-legacy-proof': '/etc/systemd/system/skyjo-online-legacy-proof@.service'
});
const temporaryUnitNamePattern = /^(?:(skyjo-online-(?:canary|canary-smoke|state-proof))@[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(?:canary|production)|(skyjo-online-(?:smoke|legacy-proof))@[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-production)\.service$/;

function temporaryUnitContract(unit) {
  const match = typeof unit === 'string' ? unit.match(temporaryUnitNamePattern) : null;
  const fragmentPath = match && temporaryUnitFragments[match[1] || match[2]];
  return fragmentPath ? { unit, fragmentPath } : null;
}

export function parseCanaryUnitState(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\0\r]/.test(value)) {
    throw new Error('Canary unit state probe is malformed.');
  }
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  const lines = normalized.split('\n');
  if (lines.length !== temporaryUnitStateKeys.length) throw new Error('Canary unit state probe has an invalid property count.');
  const state = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z]+)=(.*)$/);
    if (!match || /[\u0000-\u001f\u007f]/.test(line) ||
        !temporaryUnitStateKeys.includes(match[1]) || Object.hasOwn(state, match[1])) {
      throw new Error('Canary unit state probe contains an invalid property.');
    }
    state[match[1]] = match[2];
  }
  if (temporaryUnitStateKeys.some((key) => !Object.hasOwn(state, key))) {
    throw new Error('Canary unit state probe is incomplete.');
  }
  return Object.freeze(state);
}

function hasExactTemporaryUnitIdentity(state, contract) {
  return state.Id === contract.unit && state.LoadState === 'loaded' && state.FragmentPath === contract.fragmentPath &&
    state.DropInPaths === '' && state.CollectMode === 'inactive';
}

function hasNoTemporaryUnitWork(state) {
  return state.MainPID === '0' && state.ControlPID === '0' && state.Job === '';
}

function isCleanTemporaryUnitState(state, contract) {
  return hasExactTemporaryUnitIdentity(state, contract) && hasNoTemporaryUnitWork(state) &&
    state.ActiveState === 'inactive' && state.SubState === 'dead' && state.Result === 'success';
}

function temporaryUnitError(contract, stage, message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  Object.defineProperty(error, 'canaryUnit', { value: contract.unit, enumerable: true });
  Object.defineProperty(error, 'canaryUnitResetStage', { value: stage, enumerable: true });
  if (options.state) Object.defineProperty(error, 'canaryUnitState', { value: options.state, enumerable: false });
  return error;
}

async function inspectTemporaryUnit(contract, systemctl) {
  const output = await systemctl([
    'show', '--no-pager', '--all',
    ...temporaryUnitStateKeys.map((property) => `--property=${property}`),
    contract.unit
  ]);
  return parseCanaryUnitState(output);
}

function attachTemporaryUnitFinalState(error, state, contract) {
  Object.defineProperty(error, 'canaryUnitFinalState', { value: state, enumerable: false });
  if (!isCleanTemporaryUnitState(state, contract)) {
    Object.defineProperty(error, 'canaryUnitFinalStateUnsafe', { value: true, enumerable: false });
  }
}

function temporaryUnitFailureRequiresRunRoot(error) {
  if (error instanceof AggregateError) return error.errors.some(temporaryUnitFailureRequiresRunRoot);
  return error?.canaryUnitResetStage === 'initial-state-probe' ||
    error?.canaryUnitResetStage === 'unsafe-state' ||
    error?.canaryUnitFinalStateUnsafe === true ||
    error?.canaryUnitFinalStateProbeError instanceof Error ||
    error?.canaryUnitStopError instanceof Error;
}

async function resetFailedTemporaryUnit(contract, certificationError, systemctl) {
  try {
    await systemctl(['reset-failed', contract.unit]);
  } catch (caught) {
    Object.defineProperty(certificationError, 'canaryUnitResetError', {
      value: normalizeError(caught), enumerable: false
    });
  }
  try {
    attachTemporaryUnitFinalState(certificationError, await inspectTemporaryUnit(contract, systemctl), contract);
  } catch (caught) {
    Object.defineProperty(certificationError, 'canaryUnitFinalStateProbeError', {
      value: normalizeError(caught), enumerable: false
    });
  }
}

export async function certifyTemporaryUnitsClean(unitNames, {
  systemctl = (args) => run('/usr/bin/systemctl', args)
} = {}) {
  const contracts = Array.isArray(unitNames) ? unitNames.map(temporaryUnitContract) : [];
  if (contracts.length < 1 || contracts.length > 8 || contracts.some((contract) => !contract) ||
      new Set(unitNames).size !== unitNames.length) {
    throw new Error('Canary cleanup unit list is invalid.');
  }
  const results = [];
  const certificationErrors = [];
  for (const contract of contracts) {
    let initialState;
    try {
      initialState = await inspectTemporaryUnit(contract, systemctl);
    } catch (caught) {
      certificationErrors.push(temporaryUnitError(
        contract, 'initial-state-probe', 'Canary unit state could not be inspected safely.', { cause: normalizeError(caught) }
      ));
      continue;
    }
    if (isCleanTemporaryUnitState(initialState, contract)) {
      results.push({ unit: contract.unit, status: 'clean' });
      continue;
    }
    if (!hasExactTemporaryUnitIdentity(initialState, contract)) {
      certificationErrors.push(temporaryUnitError(
        contract, 'unsafe-state', 'Canary unit did not reach its exact terminal state.', { state: initialState }
      ));
      continue;
    }

    const hasUnexpectedResidue = ['active', 'activating', 'deactivating'].includes(initialState.ActiveState) ||
      !hasNoTemporaryUnitWork(initialState);
    if (hasUnexpectedResidue) {
      const residueError = temporaryUnitError(
        contract, 'unexpected-residue', 'Canary unit retained active process or job residue.', { state: initialState }
      );
      try { await systemctl(['stop', contract.unit]); }
      catch (caught) {
        Object.defineProperty(residueError, 'canaryUnitStopError', { value: normalizeError(caught), enumerable: false });
      }
      try {
        const stoppedState = await inspectTemporaryUnit(contract, systemctl);
        if (stoppedState.ActiveState === 'failed' &&
            hasExactTemporaryUnitIdentity(stoppedState, contract) && hasNoTemporaryUnitWork(stoppedState)) {
          await resetFailedTemporaryUnit(contract, residueError, systemctl);
        } else {
          attachTemporaryUnitFinalState(residueError, stoppedState, contract);
        }
      } catch (caught) {
        Object.defineProperty(residueError, 'canaryUnitFinalStateProbeError', {
          value: normalizeError(caught), enumerable: false
        });
      }
      certificationErrors.push(residueError);
      continue;
    }

    if (initialState.ActiveState !== 'failed') {
      certificationErrors.push(temporaryUnitError(
        contract, 'unsafe-state', 'Canary unit did not reach its exact terminal state.', { state: initialState }
      ));
      continue;
    }

    const failedStateError = temporaryUnitError(
      contract, 'unexpected-failed', 'Canary unit unexpectedly entered the failed state.', { state: initialState }
    );
    await resetFailedTemporaryUnit(contract, failedStateError, systemctl);
    certificationErrors.push(failedStateError);
  }
  if (certificationErrors.length === 1) {
    if (temporaryUnitFailureRequiresRunRoot(certificationErrors[0])) {
      Object.defineProperty(certificationErrors[0], 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw certificationErrors[0];
  }
  if (certificationErrors.length > 1) {
    const error = new AggregateError(certificationErrors, 'One or more temporary units failed cleanup certification.');
    if (temporaryUnitFailureRequiresRunRoot(error)) {
      Object.defineProperty(error, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw error;
  }
  return results;
}

async function canary(releaseDirectory, identity, snapshotDirectory, runId) {
  const runDirectory = resolveWithin(PATHS.stage, runId);
  // prepareCandidate has already taken ownership from the upload identity. Keep
  // the run root controller-owned while granting the runtime group traversal;
  // otherwise skyjo-deploy could replace the candidate during the canary.
  await run('/usr/bin/chown', ['root:root', runDirectory]);
  await run('/usr/bin/chmod', ['0711', runDirectory]);
  const stateDirectory = resolveWithin(runDirectory, 'canary-state');
  await fsp.rm(stateDirectory, { recursive: true, force: true });
  await materializePredeploySnapshot(snapshotDirectory, stateDirectory);
  await run('/usr/bin/chown', ['--recursive', 'skyjo-canary:skyjo-canary', stateDirectory]);
  const proofDirectory = resolveWithin(runDirectory, 'canary-proof');
  await fsp.rm(proofDirectory, { recursive: true, force: true });
  await fsp.mkdir(proofDirectory, { mode: 0o700 });
  await run('/usr/bin/chown', ['skyjo-canary:skyjo-canary', proofDirectory]);
  await fsp.mkdir(PATHS.canaryEnv, { recursive: true, mode: 0o711 });
  await run('/usr/bin/chown', ['root:root', PATHS.canaryEnv]);
  await run('/usr/bin/chmod', ['0711', PATHS.canaryEnv]);
  const envPath = resolveWithin(PATHS.canaryEnv, `${runId}.env`);
  const canaryPassword = crypto.randomBytes(32).toString('base64url');
  const canaryEmail = `canary-${crypto.randomBytes(18).toString('hex')}@example.invalid`;
  const env = [
    `SKYJO_CANARY_RELEASE_DIR=${releaseDirectory}`,
    `SKYJO_DB_FILE=${resolveWithin(stateDirectory, 'skyjo.sqlite')}`,
    `SKYJO_ROOMS_FILE=${resolveWithin(stateDirectory, 'rooms.json')}`,
    `SKYJO_CANARY_PROOF_DIR=${proofDirectory}`,
    `SKYJO_RELEASE_FILE=${resolveWithin(releaseDirectory, 'dist/release.json')}`,
    `SKYJO_EXPECTED_RELEASE_SHA=${identity.releaseSha}`,
    `SKYJO_EXPECTED_PROTOCOL_VERSION=${identity.protocolVersion}`,
    `SKYJO_SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`,
    `SKYJO_INVITE_SECRET=${crypto.randomBytes(48).toString('base64url')}`,
    `SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=${canaryEmail}`,
    `SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=${canaryPassword}`,
    'SKYJO_SMOKE_ACCOUNT_SETUP=signup',
    'SKYJO_SECURE_COOKIES=false',
    'SKYJO_DATABASE_RETRY_MS=100',
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4181',
    'HOST=127.0.0.1', 'PORT=4181', 'NODE_ENV=production',
    'SKYJO_VAPID_PUBLIC_KEY=', 'SKYJO_VAPID_PRIVATE_KEY=', 'SKYJO_VAPID_SUBJECT=',
    'SKYJO_APNS_TEAM_ID=', 'SKYJO_APNS_KEY_ID=',
    'SKYJO_APNS_PRIVATE_KEY_FILE=', 'SKYJO_APNS_TOKEN_KEY_FILE='
  ].join('\n');
  const serverUnit = `skyjo-online-canary@${runId}.service`;
  const smokeUnit = `skyjo-online-canary-smoke@${runId}.service`;
  const stateProofUnit = `skyjo-online-state-proof@${runId}.service`;
  await executeCanaryLifecycle({
    prepareEnvironment: async () => {
      await fsp.writeFile(envPath, `${env}\n`, { mode: 0o640, flag: 'wx' });
      await run('/usr/bin/chown', ['root:skyjo-canary', envPath]);
    },
    startServer: () => run('/usr/bin/systemctl', ['start', serverUnit]),
    waitUntilReady: () => waitForRelease('http://127.0.0.1:4181', identity.releaseSha),
    runAuthenticatedSmoke: () => run('/usr/bin/systemctl', ['start', smokeUnit]),
    runStateProof: () => run('/usr/bin/systemctl', ['start', stateProofUnit]),
    verifySourceSnapshot: () => verifyPredeploySnapshot(snapshotDirectory, { expectedOwnerUid: 0, expectedOwnerGid: 0 }),
    stopServer: () => run('/usr/bin/systemctl', ['stop', serverUnit]),
    resetUnits: () => certifyTemporaryUnitsClean([serverUnit, smokeUnit, stateProofUnit]),
    removeEnvironment: () => fsp.rm(envPath, { force: true })
  });
}

export async function cleanupRun(runId, workDirectory, {
  stageRoot = PATHS.stage,
  expectedIdentity,
  remove = fsp.rm,
  inspect = fsp.lstat
} = {}) {
  if (path.resolve(workDirectory) !== resolveWithin(stageRoot, runId)) throw new Error('Refusing to clean an unexpected deployment path.');
  const current = await inspect(workDirectory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!current) return;
  assertRunIdentity(current, expectedIdentity);
  await remove(workDirectory, { recursive: true, force: true });
  const residue = await inspect(workDirectory).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (residue) throw new Error('Deployment run directory remains after cleanup.');
}

async function cleanupReplayedRun(runId) {
  const workDirectory = resolveWithin(PATHS.stage, runId);
  const stat = await fsp.lstat(workDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Replayed deployment stage is unsafe.');
  const expectedIdentity = await proveClaimedRunDirectory(workDirectory);
  await cleanupRun(runId, workDirectory, { expectedIdentity });
}

export async function executeWithRequiredRunCleanup({ action, cleanup, cleanupOnSuccess = true }) {
  let primaryError;
  let result;
  try {
    result = await action();
  } catch (caught) {
    primaryError = caught instanceof Error ? caught : new Error(String(caught));
  }
  if (primaryError?.preserveRunRoot === true) throw primaryError;
  if (!primaryError && !cleanupOnSuccess) return result;
  try {
    await cleanup();
  } catch (caught) {
    const cleanupError = normalizeError(caught);
    if (!primaryError) throw cleanupError;
    throw combinedActionAndCleanupError(primaryError, cleanupError);
  }
  if (primaryError) throw primaryError;
  return result;
}

async function verifyAction(parsed) {
  const oldRelease = await readLinkWithin(PATHS.current, PATHS.releases).catch(() => {
    throw new Error('No validated rollback anchor exists; canary verification is refused.');
  });
  const rollbackAnchor = await validateRollbackAnchor(oldRelease);
  const prepared = await prepareCandidate(parsed);
  const snapshot = resolveWithin(prepared.workDirectory, 'snapshot');
  return executeWithRequiredRunCleanup({
    action: async () => {
      await createSnapshot(rollbackAnchor, snapshot);
      await canary(prepared.candidate, prepared.identity, snapshot, parsed.runId);
      return { verified: parsed.releaseSha, activated: false };
    },
    cleanup: () => cleanupRun(parsed.runId, prepared.workDirectory, { expectedIdentity: prepared.runIdentity })
  });
}

async function readMetadata(releaseDirectory) {
  return JSON.parse(await fsp.readFile(resolveWithin(releaseDirectory, '.skyjo-deployment.json'), 'utf8'));
}

async function smokeProduction(releaseDirectory, identity, runId) {
  const envPath = resolveWithin(PATHS.canaryEnv, `${runId}.env`);
  await fsp.mkdir(PATHS.canaryEnv, { recursive: true, mode: 0o711 });
  await run('/usr/bin/chown', ['root:root', PATHS.canaryEnv]);
  await run('/usr/bin/chmod', ['0711', PATHS.canaryEnv]);
  await fsp.writeFile(envPath, [
    `SKYJO_CANARY_RELEASE_DIR=${releaseDirectory}`,
    `SKYJO_EXPECTED_RELEASE_SHA=${identity.releaseSha}`,
    `SKYJO_EXPECTED_PROTOCOL_VERSION=${identity.protocolVersion}`,
    'SKYJO_SMOKE_ACCOUNT_SETUP=existing',
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4180'
  ].join('\n') + '\n', { mode: 0o640, flag: 'wx' });
  await run('/usr/bin/chown', ['root:skyjo', envPath]);
  const smokeUnit = `skyjo-online-smoke@${runId}.service`;
  let primaryError;
  try { await run('/usr/bin/systemctl', ['start', smokeUnit]); }
  catch (caught) { primaryError = normalizeError(caught); }
  const cleanupErrors = [];
  for (const [stage, cleanup] of [
    ['certify-unit', () => certifyTemporaryUnitsClean([smokeUnit])],
    ['remove-environment', () => fsp.rm(envPath, { force: true })]
  ]) {
    try { await cleanup(); }
    catch (caught) {
      const error = normalizeError(caught);
      Object.defineProperty(error, 'productionSmokeCleanupStage', { value: stage, enumerable: true });
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      Object.defineProperty(primaryError, 'productionSmokeCleanupErrors', { value: cleanupErrors, enumerable: false });
    }
    if (cleanupErrors.some((error) => error.preserveRunRoot === true)) {
      Object.defineProperty(primaryError, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    const error = new AggregateError(cleanupErrors, 'Production smoke cleanup did not complete safely.');
    if (cleanupErrors.some((cleanupError) => cleanupError.preserveRunRoot === true)) {
      Object.defineProperty(error, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw error;
  }
}

async function proveLegacyProduction(releaseDirectory, identity, runId) {
  const envPath = resolveWithin(PATHS.canaryEnv, `${runId}.env`);
  await fsp.mkdir(PATHS.canaryEnv, { recursive: true, mode: 0o711 });
  await run('/usr/bin/chown', ['root:root', PATHS.canaryEnv]);
  await run('/usr/bin/chmod', ['0711', PATHS.canaryEnv]);
  await fsp.writeFile(envPath, [
    `SKYJO_LEGACY_RELEASE_DIR=${releaseDirectory}`,
    `SKYJO_EXPECTED_RELEASE_SHA=${identity.releaseSha}`,
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4180'
  ].join('\n') + '\n', { mode: 0o640, flag: 'wx' });
  await run('/usr/bin/chown', ['root:skyjo', envPath]);
  const unit = `skyjo-online-legacy-proof@${runId}.service`;
  let primaryError;
  try { await run('/usr/bin/systemctl', ['start', unit]); }
  catch (caught) { primaryError = normalizeError(caught); }
  const cleanupErrors = [];
  for (const [stage, cleanup] of [
    ['certify-unit', () => certifyTemporaryUnitsClean([unit])],
    ['remove-environment', () => fsp.rm(envPath, { force: true })]
  ]) {
    try { await cleanup(); }
    catch (caught) {
      const error = normalizeError(caught);
      Object.defineProperty(error, 'legacyProofCleanupStage', { value: stage, enumerable: true });
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      Object.defineProperty(primaryError, 'legacyProofCleanupErrors', { value: cleanupErrors, enumerable: false });
    }
    if (cleanupErrors.some((error) => error.preserveRunRoot === true)) {
      Object.defineProperty(primaryError, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    const error = new AggregateError(cleanupErrors, 'Legacy production proof cleanup did not complete safely.');
    if (cleanupErrors.some((cleanupError) => cleanupError.preserveRunRoot === true)) {
      Object.defineProperty(error, 'preserveRunRoot', { value: true, enumerable: false });
    }
    throw error;
  }
}

export async function verifyRunningProduction(releaseDirectory, identity, runId, operations = {}) {
  const startProduction = operations.startProduction || (() => run('/usr/bin/systemctl', ['start', PATHS.service]));
  const proveLegacy = operations.proveLegacy || proveLegacyProduction;
  const waitUntilReady = operations.waitUntilReady || waitForRelease;
  const runSmoke = operations.runSmoke || smokeProduction;
  await startProduction();
  if (identity.legacy) return proveLegacy(releaseDirectory, identity, runId);
  await waitUntilReady('http://127.0.0.1:4180', identity.releaseSha);
  return runSmoke(releaseDirectory, identity, runId);
}

async function rollbackLinks(failedRelease, oldRelease, runId) {
  const recoveredAnchor = await validateRollbackAnchor(oldRelease);
  const failedAnchor = await validateRollbackAnchor(failedRelease);
  const verifyRelease = async (releaseDirectory, anchor) => {
    await verifyRunningProduction(releaseDirectory, anchor, runId);
  };
  await executeCodeRollbackTransaction({
    stop: () => run('/usr/bin/systemctl', ['stop', PATHS.service]),
    prepare: prepareStateOwnership,
    restoreCurrent: () => replaceSymlink(PATHS.current, oldRelease),
    restoreOriginalLinks: async () => {
      await replaceSymlink(PATHS.current, failedRelease);
      await replaceSymlink(PATHS.previous, oldRelease);
    },
    recordFailed: () => replaceSymlink(PATHS.previous, failedRelease),
    startRecovered: () => verifyRelease(oldRelease, recoveredAnchor),
    restartFailed: () => verifyRelease(failedRelease, failedAnchor)
  });
  const legacy = recoveredAnchor.legacy === true;
  return legacy;
}

async function restartAndVerifyPrevious(oldRelease, rollbackAnchor, runId) {
  await verifyRunningProduction(oldRelease, rollbackAnchor, runId);
}

async function pruneReleases(additionalProtectedPaths = []) {
  const protectedPaths = [
    await readLinkWithin(PATHS.current, PATHS.releases),
    await readLinkWithin(PATHS.previous, PATHS.releases),
    ...additionalProtectedPaths
  ];
  const entries = await fsp.readdir(PATHS.releases, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)) continue;
    const entryPath = resolveWithin(PATHS.releases, entry.name);
    candidates.push({ path: entryPath, stat: await fsp.stat(entryPath) });
  }
  for (const releasePath of selectReleasePathsToPrune(candidates.map(({ path: entryPath, stat }) => ({ path: entryPath, mtimeMs: stat.mtimeMs })), protectedPaths, 5)) {
    await fsp.rm(releasePath, { recursive: true, force: true });
  }
}

async function promoteAction(parsed) {
  if (await resolveGithubTag(parsed.tag) !== parsed.releaseSha) throw new Error('Release tag does not resolve to the approved SHA.');
  await assertGithubCommitOnMain(parsed.releaseSha);
  const oldRelease = await readLinkWithin(PATHS.current, PATHS.releases).catch(() => { throw new Error('No validated rollback anchor exists; promotion is refused.'); });
  await assertHardenedProductionUnit();
  const rollbackAnchor = await validateRollbackAnchor(oldRelease);
  // A prior controller can be killed after a graceful stop but before it can
  // journal recovery. A fresh immutable-tag dispatch must revive and fully
  // prove the unchanged current release before attempting another promotion.
  await verifyRunningProduction(oldRelease, rollbackAnchor, parsed.runId);
  const prepared = await prepareCandidate(parsed);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backup = resolveWithin(PATHS.backups, `${timestamp}-pre-${parsed.releaseSha}`);
  const target = await executeWithRequiredRunCleanup({
    action: async () => {
      await createSnapshot(rollbackAnchor, backup);
      await canary(prepared.candidate, prepared.identity, backup, parsed.runId);
      const immutableTarget = resolveWithin(PATHS.releases, parsed.releaseSha);
      const incoming = resolveWithin(PATHS.releases, `.incoming-${parsed.releaseSha}-${parsed.runId}`);
      await fsp.rm(incoming, { recursive: true, force: true });
      const targetExists = await fsp.lstat(immutableTarget).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (targetExists) {
        const existingIdentity = await loadVerifiedReleaseIdentity(immutableTarget, parsed.releaseSha);
        const existingMetadata = await readMetadata(immutableTarget);
        if (existingMetadata.artifactSha256 !== parsed.digest || existingMetadata.tag !== parsed.tag || existingIdentity.releaseSha !== parsed.releaseSha) {
          throw new Error('An existing release directory conflicts with the approved artifact.');
        }
        // A prior attempt may have completed the directory rename but lost its
        // acknowledgement while syncing the parent. Re-prove the complete
        // visible tree and releases directory before this target can activate.
        await proveDurablePublishedDirectory(immutableTarget);
      } else {
        try {
          await fsp.cp(prepared.candidate, incoming, { recursive: true, force: false, errorOnExist: true });
          await loadVerifiedReleaseIdentity(incoming, parsed.releaseSha);
          const metadata = await readMetadata(incoming);
          metadata.tag = parsed.tag;
          await fsp.writeFile(resolveWithin(incoming, '.skyjo-deployment.json'), `${JSON.stringify(metadata)}\n`, { mode: 0o444 });
          await run('/usr/bin/chown', ['--recursive', 'root:root', incoming]);
          await run('/usr/bin/chmod', ['--recursive', 'u=rwX,go=rX', incoming]);
          await publishImmutableDirectory(incoming, immutableTarget);
        } catch (caught) {
          const publicationError = normalizeError(caught);
          const cleanupErrors = [];
          try { await fsp.rm(incoming, { recursive: true, force: true }); }
          catch (cleanupError) { cleanupErrors.push(normalizeError(cleanupError)); }
          try { await fsyncFilesystemPath(PATHS.releases, { directory: true }); }
          catch (cleanupError) { cleanupErrors.push(normalizeError(cleanupError)); }
          if (cleanupErrors.length > 0) {
            throw new AggregateError([publicationError, ...cleanupErrors], 'Release preparation failed and its incoming tree could not be removed durably.', { cause: publicationError });
          }
          throw publicationError;
        }
      }
      return immutableTarget;
    },
    cleanup: () => cleanupRun(parsed.runId, prepared.workDirectory, { expectedIdentity: prepared.runIdentity })
  });
  // Everything that can fail without changing the live service, including
  // retention and run-root deletion, completes before stop/swap.
  await pruneReleases([target]);
  const currentBefore = await readLinkWithin(PATHS.current, PATHS.releases);
  if (currentBefore === target) {
    await waitForRelease('http://127.0.0.1:4180', parsed.releaseSha);
    await smokeProduction(target, prepared.identity, parsed.runId);
    return { promoted: parsed.releaseSha, tag: parsed.tag, idempotent: true };
  }
  try {
      await executeActivationTransaction({
        stop: () => run('/usr/bin/systemctl', ['stop', PATHS.service]),
        prepare: prepareStateOwnership,
        swap: async (markLinksChanged) => {
          let linkChanged = false;
          try {
            await replaceSymlink(PATHS.previous, oldRelease);
            linkChanged = true;
            markLinksChanged();
            await replaceSymlink(PATHS.current, target);
          } catch (error) {
            if (linkChanged || error?.linkMayHaveChanged === true) markLinksChanged();
            throw error;
          }
        },
        start: () => run('/usr/bin/systemctl', ['start', PATHS.service]),
        verify: async () => {
          await waitForRelease('http://127.0.0.1:4180', parsed.releaseSha);
          await smokeProduction(target, prepared.identity, parsed.runId);
        },
        rollback: () => rollbackLinks(target, oldRelease, parsed.runId),
        restartPrevious: () => restartAndVerifyPrevious(oldRelease, rollbackAnchor, parsed.runId)
      });
  } catch (error) {
      if (error.rollbackFailed) {
        throw new Error(`Activation failed and automatic code rollback also failed; manual recovery is required: ${error.message}`, { cause: error });
      }
      if (error.restartPreviousFailed) {
        throw new Error(`Activation stopped before link change and the previous service failed to restart; manual recovery is required: ${error.message}`, { cause: error });
      }
      if (error.activationRolledBack) {
        throw new Error(`Activation failed and code was rolled back without restoring data: ${error.message}`, { cause: error });
      }
      if (error.previousRestarted) {
        throw new Error(`Activation stopped before link change; the previous service was restarted and reverified: ${error.message}`, { cause: error });
      }
      throw new Error(`Activation failed with an unknown recovery state; manual verification is required: ${error.message}`, { cause: error });
  }
  return { promoted: parsed.releaseSha, tag: parsed.tag, backup: path.basename(backup) };
}

async function rollbackAction(parsed) {
  await assertHardenedProductionUnit();
  const failed = await readLinkWithin(PATHS.current, PATHS.releases);
  const metadata = await readMetadata(failed);
  authorizeRollback({ currentReleaseSha: path.basename(failed), metadata, requestedReleaseSha: parsed.releaseSha, requestedDigest: parsed.digest, requestedTag: parsed.tag });
  const previous = await readLinkWithin(PATHS.previous, PATHS.releases);
  const legacy = await rollbackLinks(failed, previous, parsed.runId);
  return { rolledBackTo: legacy ? 'legacy' : path.basename(previous), legacy };
}

export function validateControllerActionResult(fields, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Controller action result is invalid.');
  if (fields.command === 'verify') {
    const canonical = { verified: fields.releaseSha, activated: false };
    if (JSON.stringify(result) !== JSON.stringify(canonical)) throw new Error('Verify result does not match the authorized release.');
    return canonical;
  }
  if (fields.command === 'promote') {
    const base = { promoted: fields.releaseSha, tag: fields.tag };
    const normal = typeof result.backup === 'string' &&
      new RegExp(`^[0-9]{8}T[0-9]{6}Z-pre-${fields.releaseSha}$`).test(result.backup) &&
      JSON.stringify(result) === JSON.stringify({ ...base, backup: result.backup });
    const idempotent = result.idempotent === true &&
      JSON.stringify(result) === JSON.stringify({ ...base, idempotent: true });
    if (!normal && !idempotent) throw new Error('Promotion result does not match the authorized release.');
    return result;
  }
  if (fields.command === 'rollback') {
    const normal = result.legacy === false && /^[a-f0-9]{40}$/.test(result.rolledBackTo || '') &&
      result.rolledBackTo !== fields.releaseSha &&
      JSON.stringify(result) === JSON.stringify({ rolledBackTo: result.rolledBackTo, legacy: false });
    const legacy = result.legacy === true && result.rolledBackTo === 'legacy' &&
      JSON.stringify(result) === JSON.stringify({ rolledBackTo: 'legacy', legacy: true });
    if (!normal && !legacy) throw new Error('Rollback result does not identify an authorized recovery target.');
    return result;
  }
  throw new Error('Controller action result command is unsupported.');
}

async function reconcileCompletedControllerResult(fields, result) {
  validateControllerActionResult(fields, result);
  if (fields.command === 'verify') {
    await cleanupReplayedRun(fields.runId);
    return;
  }
  const current = await readLinkWithin(PATHS.current, PATHS.releases);
  if (fields.command === 'promote') {
    if (path.basename(current) !== fields.releaseSha) throw new Error('Cached promotion no longer matches the active release.');
    const identity = await loadVerifiedReleaseIdentity(current, fields.releaseSha);
    const metadata = await readMetadata(current);
    if (metadata.artifactSha256 !== fields.artifactSha256 || metadata.tag !== fields.tag) {
      throw new Error('Cached promotion metadata no longer matches the authorization.');
    }
    await verifyRunningProduction(current, identity, fields.runId);
    await cleanupReplayedRun(fields.runId);
    return;
  }
  const failed = await readLinkWithin(PATHS.previous, PATHS.releases);
  if (path.basename(failed) !== fields.releaseSha) throw new Error('Cached rollback no longer records the authorized failed release.');
  const failedMetadata = await readMetadata(failed);
  if (failedMetadata.artifactSha256 !== fields.artifactSha256 || failedMetadata.tag !== fields.tag) {
    throw new Error('Cached rollback failed-release metadata no longer matches the authorization.');
  }
  await loadVerifiedReleaseIdentity(failed, fields.releaseSha);
  const anchor = await validateRollbackAnchor(current);
  if ((result.legacy && anchor.legacy !== true) || (!result.legacy && path.basename(current) !== result.rolledBackTo)) {
    throw new Error('Cached rollback no longer matches the active recovery target.');
  }
  await verifyRunningProduction(current, anchor, fields.runId);
}

export async function recoverUnpersistedControllerResult(fields, result, operations = {}) {
  const reconcile = operations.reconcile || reconcileCompletedControllerResult;
  const readReleaseLink = operations.readReleaseLink || ((linkPath) => readLinkWithin(linkPath, PATHS.releases));
  const rollback = operations.rollback || rollbackLinks;
  validateControllerActionResult(fields, result);
  if (fields.command === 'promote') {
    if (result.idempotent === true) {
      await reconcile(fields, result);
      return;
    }
    const current = await readReleaseLink(PATHS.current);
    if (path.basename(current) !== fields.releaseSha) throw new Error('Unjournaled promotion active release is ambiguous.');
    const previous = await readReleaseLink(PATHS.previous);
    try {
      await rollback(current, previous, fields.runId);
    } catch (cause) {
      const error = new Error('Completion persistence failed and automatic code rollback failed; manual recovery is required.', { cause });
      Object.defineProperty(error, 'deploymentStatus', { value: 'rollback-failed', enumerable: true });
      throw error;
    }
    return;
  }
  if (fields.command === 'rollback') {
    await reconcile(fields, result);
  }
}

async function requireResumableStage(runId) {
  const stageDirectory = resolveWithin(PATHS.stage, runId);
  const stat = await fsp.lstat(stageDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) throw new Error('Started deployment requires the exact artifact to be uploaded again before recovery.');
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Started deployment stage is unsafe.');
}

export function classifyStartedControllerState(fields, { currentSha, previousSha, stagePresent }) {
  if (fields.command === 'verify') return stagePresent ? 'execute' : 'reupload';
  if (fields.command === 'promote') {
    if (currentSha === fields.releaseSha) return 'complete';
    if (previousSha === fields.releaseSha) return 'manual';
    return stagePresent ? 'execute' : 'reupload';
  }
  if (fields.command === 'rollback') {
    if (currentSha === fields.releaseSha && previousSha !== fields.releaseSha) return 'execute';
    if (currentSha !== fields.releaseSha && previousSha === fields.releaseSha) return 'complete';
    if (currentSha !== fields.releaseSha && currentSha === previousSha) return 'repair-complete';
    return 'manual';
  }
  return 'manual';
}

export async function completeStartedRollbackRecovery(fields, {
  current,
  failedRelease,
  repairPrevious
}, operations = {}) {
  const readReleaseMetadata = operations.readReleaseMetadata || readMetadata;
  const loadReleaseIdentity = operations.loadReleaseIdentity || loadVerifiedReleaseIdentity;
  const validateAnchor = operations.validateAnchor || validateRollbackAnchor;
  const replacePrevious = operations.replacePrevious || ((target) => replaceSymlink(PATHS.previous, target));
  const startProduction = operations.startProduction || (() => run('/usr/bin/systemctl', ['start', PATHS.service]));
  const verifyProduction = operations.verifyProduction || verifyRunningProduction;
  const priorMetadata = await readReleaseMetadata(failedRelease);
  if (priorMetadata.artifactSha256 !== fields.artifactSha256 || priorMetadata.tag !== fields.tag) {
    throw new Error('Started rollback authorization no longer matches the failed release.');
  }
  await loadReleaseIdentity(failedRelease, fields.releaseSha);
  const recovered = await validateAnchor(current);
  if (repairPrevious) await replacePrevious(failedRelease);
  await startProduction();
  await verifyProduction(current, recovered, fields.runId);
  const result = { rolledBackTo: recovered.legacy ? 'legacy' : path.basename(current), legacy: recovered.legacy === true };
  validateControllerActionResult(fields, result);
  return { kind: 'complete', result };
}

async function reconcileStartedControllerOperation(fields) {
  if (fields.command === 'verify') {
    await requireResumableStage(fields.runId);
    return { kind: 'execute' };
  }
  const current = await readLinkWithin(PATHS.current, PATHS.releases);
  const previous = await readLinkWithin(PATHS.previous, PATHS.releases);
  if (fields.command === 'promote') {
    if (path.basename(current) === fields.releaseSha) {
      const identity = await loadVerifiedReleaseIdentity(current, fields.releaseSha);
      const metadata = await readMetadata(current);
      if (metadata.artifactSha256 !== fields.artifactSha256 || metadata.tag !== fields.tag) {
        throw new Error('Started promotion target metadata is ambiguous.');
      }
      await verifyRunningProduction(current, identity, fields.runId);
      const result = { promoted: fields.releaseSha, tag: fields.tag, idempotent: true };
      validateControllerActionResult(fields, result);
      await cleanupReplayedRun(fields.runId);
      return { kind: 'complete', result };
    }
    if (path.basename(previous) === fields.releaseSha) {
      throw new Error('Started promotion was already rolled back; refusing to promote it again.');
    }
    const currentAnchor = await validateRollbackAnchor(current);
    await verifyRunningProduction(current, currentAnchor, fields.runId);
    await requireResumableStage(fields.runId);
    return { kind: 'execute' };
  }

  const failedMetadata = path.basename(current) === fields.releaseSha ? await readMetadata(current) : null;
  if (failedMetadata) {
    if (failedMetadata.artifactSha256 !== fields.artifactSha256 || failedMetadata.tag !== fields.tag) {
      throw new Error('Started rollback failed-release metadata is ambiguous.');
    }
    await loadVerifiedReleaseIdentity(current, fields.releaseSha);
    await validateRollbackAnchor(previous);
    await verifyRunningProduction(current, await validateRollbackAnchor(current), fields.runId);
    return { kind: 'execute' };
  }
  let failedRelease = previous;
  if (path.basename(previous) !== fields.releaseSha) {
    if (current !== previous) throw new Error('Started rollback link state is ambiguous.');
    failedRelease = resolveWithin(PATHS.releases, fields.releaseSha);
  }
  return completeStartedRollbackRecovery(fields, {
    current,
    failedRelease,
    repairPrevious: current === previous
  });
}

async function exactPath(filePath, { type, uid, gid, mode }) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink() || (type === 'file' ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Installed path has an unsafe type: ${filePath}`);
  if (stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) throw new Error(`Installed path owner or mode is invalid: ${filePath}`);
  return stat;
}

async function readNoFollow(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}

function parseProductionEnvironment(value) {
  const entries = new Map();
  for (const line of value.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || entries.has(match[1]) || /[\0\r\n]/.test(match[2])) throw new Error('Production environment file has invalid or duplicate entries.');
    entries.set(match[1], match[2]);
  }
  const requiredSecrets = [
    'SKYJO_SESSION_SECRET',
    'SKYJO_INVITE_SECRET',
    'SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL',
    'SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD'
  ];
  for (const name of requiredSecrets) {
    const valueForName = entries.get(name) || '';
    if (!valueForName || /change-me|replace-with/i.test(valueForName)) throw new Error(`Production environment ${name} is missing or still a placeholder.`);
  }
  const exact = new Map([
    ['HOST', '127.0.0.1'],
    ['PORT', '4180'],
    ['SKYJO_DB_FILE', '/var/lib/skyjo-online/skyjo.sqlite'],
    ['SKYJO_ROOMS_FILE', '/var/lib/skyjo-online/rooms.json'],
    ['SKYJO_SECURE_COOKIES', 'true']
  ]);
  for (const [name, expected] of exact) {
    if (entries.get(name) !== expected) throw new Error(`Production environment ${name} must equal its hardened runtime value.`);
  }
  if (entries.get('SKYJO_ADMIN_EMAIL') && entries.get('SKYJO_ADMIN_EMAIL') === entries.get('SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL')) {
    throw new Error('Deployment smoke account must be distinct from the administrator account.');
  }
  const apnsNames = [
    'SKYJO_APNS_TEAM_ID',
    'SKYJO_APNS_KEY_ID',
    'SKYJO_APNS_PRIVATE_KEY_FILE',
    'SKYJO_APNS_TOKEN_KEY_FILE'
  ];
  const apnsValues = apnsNames.map((name) => entries.get(name) || '');
  if (apnsValues.some(Boolean) && apnsValues.some((valueForName) => !valueForName)) {
    throw new Error('Production APNs configuration must be either complete or disabled.');
  }
  if (apnsValues.every(Boolean)) {
    if (!/^[A-Z0-9]{10}$/.test(apnsValues[0]) || !/^[A-Z0-9]{10}$/.test(apnsValues[1])) {
      throw new Error('Production APNs provider identifiers are invalid.');
    }
    if (
      apnsValues[2] !== '/etc/skyjo-online/apns-provider.p8' ||
      apnsValues[3] !== '/etc/skyjo-online/apns-token.key'
    ) {
      throw new Error('Production APNs key paths must equal their hardened runtime values.');
    }
  }
  for (const forbidden of ['SKYJO_CANARY_RELEASE_DIR', 'SKYJO_CANARY_PROOF_DIR', 'SKYJO_LEGACY_RELEASE_DIR', 'SKYJO_EXPECTED_RELEASE_SHA', 'SKYJO_SMOKE_BASE_URL']) {
    if (entries.has(forbidden)) throw new Error(`Canary-only variable is forbidden in production environment: ${forbidden}`);
  }
  return entries;
}

function assertUnitDirectives(unitPath, unitText, expected) {
  const lines = unitText.replace(/\r/g, '').split('\n').filter((line) => line && !line.startsWith('#'));
  const count = (directive) => lines.filter((line) => line === directive).length;
  for (const directive of expected.required) {
    if (count(directive) !== 1) throw new Error(`Systemd unit must contain exactly one ${directive}: ${unitPath}`);
  }
  for (const directive of expected.forbidden) {
    if (count(directive) !== 0) throw new Error(`Systemd unit contains forbidden ${directive}: ${unitPath}`);
  }
}

export function validateStageRootEntries(stat, entries) {
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(?:canary|production)$/.test(entry.name))) {
    throw new Error('Deployment staging root contains an unexpected entry.');
  }
  if (!Number.isSafeInteger(stat.nlink) || stat.nlink !== 2 + entries.length || entries.length > 32) {
    throw new Error('Deployment staging link-count admission is inconsistent.');
  }
  return entries.length;
}

async function assertStageRootContract() {
  const deployGid = Number((await run('/usr/bin/id', ['-g', 'skyjo-deploy'])).trim());
  if (!Number.isSafeInteger(deployGid) || deployGid < 0) throw new Error('Deployment staging group is invalid.');
  const stat = await exactPath(PATHS.stage, { type: 'directory', uid: 0, gid: deployGid, mode: 0o1731 });
  const fileSystem = (await run('/usr/bin/findmnt', ['--noheadings', '--output', 'FSTYPE', '--target', PATHS.stage])).trim();
  if (fileSystem !== 'ext4') throw new Error('Deployment staging requires verified ext4 directory link-count semantics.');
  const entries = await fsp.readdir(PATHS.stage, { withFileTypes: true });
  validateStageRootEntries(stat, entries);
  await fsyncDirectoryStrict(PATHS.stage);
  return { deployGid, entries: entries.length };
}

async function assertEffectiveTemplate(unit, fragmentPath, expectedUser, expectedGroup) {
  const exact = new Map([
    ['FragmentPath', fragmentPath],
    ['DropInPaths', ''],
    ['User', expectedUser],
    ['Group', expectedGroup],
    ['CollectMode', 'inactive'],
    ['NoNewPrivileges', 'yes'],
    ['ProtectSystem', 'strict']
  ]);
  const actual = new Map();
  for (const property of exact.keys()) {
    actual.set(property, (await run('/usr/bin/systemctl', ['show', unit, `--property=${property}`, '--value'])).trim());
  }
  validateEffectiveSystemdProperties(unit, actual, exact);
}

async function assertEffectiveDeliveryUnits() {
  for (const [unit, fragmentPath, user, group] of [
    ['skyjo-online-canary@1-1-canary.service', '/etc/systemd/system/skyjo-online-canary@.service', 'skyjo-canary', 'skyjo-canary'],
    ['skyjo-online-canary-smoke@1-1-canary.service', '/etc/systemd/system/skyjo-online-canary-smoke@.service', 'skyjo-canary', 'skyjo-canary'],
    ['skyjo-online-state-proof@1-1-canary.service', '/etc/systemd/system/skyjo-online-state-proof@.service', 'skyjo-canary', 'skyjo-canary'],
    ['skyjo-online-smoke@1-1-production.service', '/etc/systemd/system/skyjo-online-smoke@.service', 'skyjo', 'skyjo'],
    ['skyjo-online-legacy-proof@1-1-production.service', '/etc/systemd/system/skyjo-online-legacy-proof@.service', 'skyjo', 'skyjo']
  ]) await assertEffectiveTemplate(unit, fragmentPath, user, group);
  const productionDropIns = (await run('/usr/bin/systemctl', ['show', PATHS.service, '--property=DropInPaths', '--value'])).trim();
  if (productionDropIns !== '') throw new Error('Effective production systemd DropInPaths must be empty.');
}

async function selfTest() {
  await assertNode24();
  const identities = {};
  for (const name of ['skyjo', 'skyjo-canary', 'skyjo-deploy']) {
    const passwd = (await run('/usr/bin/getent', ['passwd', name])).trim().split(':');
    if (passwd.length !== 7) throw new Error(`Runtime identity is malformed: ${name}`);
    identities[name] = { uid: Number(passwd[2]), gid: Number(passwd[3]), home: passwd[5], shell: passwd[6] };
  }
  if (new Set(Object.values(identities).map(({ uid }) => uid)).size !== 3) throw new Error('Production, canary, and deployment users must be distinct.');
  validatePrivateIdentityGroups(identities, await run('/usr/bin/getent', ['passwd']));
  if (identities.skyjo.shell !== '/usr/sbin/nologin' || identities['skyjo-canary'].shell !== '/usr/sbin/nologin') {
    throw new Error('Production and canary runtime identities must be non-login users.');
  }
  if (identities['skyjo-deploy'].shell !== '/bin/sh' || !(await run('/usr/bin/passwd', ['--status', 'skyjo-deploy'])).trim().split(/\s+/)[1]?.startsWith('L')) {
    throw new Error('Deployment transport identity must have a locked password.');
  }

  await exactPath(PATHS.appRoot, { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
  await exactPath(PATHS.releases, { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
  for (const linkPath of [PATHS.current, PATHS.previous]) {
    const linkStat = await fsp.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!linkStat) continue;
    if (!linkStat.isSymbolicLink() || linkStat.uid !== 0 || linkStat.gid !== 0) {
      throw new Error(`Release link ownership or type is invalid: ${linkPath}`);
    }
    await readLinkWithin(linkPath, PATHS.releases);
  }
  await exactPath(PATHS.backups, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  const stateStat = await fsp.lstat(PATHS.state);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('Production state directory is unsafe.');
  const hardenedStateOwnership = stateStat.uid === identities.skyjo.uid && stateStat.gid === identities.skyjo.gid && (stateStat.mode & 0o7777) === 0o700;
  const safeLegacyStateOwnership = stateStat.uid === 0 && (stateStat.mode & 0o022) === 0;
  if (!hardenedStateOwnership && !safeLegacyStateOwnership) throw new Error('Production state ownership is neither safe legacy nor hardened runtime state.');
  await assertStageRootContract();
  await exactPath(PATHS.authorizationReplay, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(PATHS.authorizationKeys, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(PATHS.canaryEnv, { type: 'directory', uid: 0, gid: 0, mode: 0o711 });

  if ((await run('/usr/bin/find', [PATHS.nodeTarget, '-xdev', '(', '!', '-user', 'root', '-o', '!', '-group', 'root', ')', '-print', '-quit'])).trim()) {
    throw new Error('Pinned Node runtime contains a non-root-owned entry or group.');
  }
  if ((await run('/usr/bin/find', [PATHS.nodeTarget, '-xdev', '(', '-type', 'd', '-o', '-type', 'f', ')', '-perm', '/022', '-print', '-quit'])).trim()) {
    throw new Error('Pinned Node runtime contains a group/world-writable entry.');
  }
  if ((await run('/usr/bin/find', [PATHS.nodeTarget, '-xdev', '(', '!', '-type', 'd', '!', '-type', 'f', '!', '-type', 'l', ')', '-print', '-quit'])).trim()) {
    throw new Error('Pinned Node runtime contains an unsupported special entry.');
  }

  await exactPath(PATHS.bootstrapStore, { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
  const bootstrapCurrent = path.join(PATHS.bootstrapStore, 'current');
  const bootstrapLink = await fsp.lstat(bootstrapCurrent);
  const bootstrapGenerationName = await fsp.readlink(bootstrapCurrent);
  if (!bootstrapLink.isSymbolicLink() || bootstrapLink.uid !== 0 || bootstrapLink.gid !== 0 || !/^[a-f0-9]{64}$/.test(bootstrapGenerationName)) {
    throw new Error('Installed bootstrap generation link is unsafe.');
  }
  const bootstrapGeneration = resolveWithin(PATHS.bootstrapStore, bootstrapGenerationName);
  await exactPath(bootstrapGeneration, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(path.join(bootstrapGeneration, 'inputs'), { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(path.join(bootstrapGeneration, 'bundle.sha256'), { type: 'file', uid: 0, gid: 0, mode: 0o400 });
  for (const file of ['transport.pub', 'canary.pem', 'production.pem']) {
    await exactPath(path.join(bootstrapGeneration, 'inputs', file), { type: 'file', uid: 0, gid: 0, mode: 0o600 });
  }
  await run('/usr/bin/sha256sum', ['--check', '--strict', path.join(bootstrapGeneration, 'bundle.sha256')], { cwd: bootstrapGeneration });

  const root0555 = [
    '/usr/local/sbin/skyjo-release-controller',
    PATHS.bootstrapWrapper,
    '/usr/local/lib/skyjo-online/admission-lock.mjs',
    '/usr/local/lib/skyjo-online/release-controller.mjs',
    '/usr/local/lib/skyjo-online/release-controller-lib.mjs',
    '/usr/local/lib/skyjo-online/state-snapshot-lib.mjs',
    '/usr/local/lib/skyjo-online/deployment-authorization-lib.mjs',
    '/usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs',
    '/usr/local/lib/skyjo-online/validate-deployment-public-keys.mjs',
    '/usr/local/lib/skyjo-online/legacy-runtime-proof.mjs',
    '/usr/local/lib/skyjo-online/node-runtime-guard-lib.sh',
    '/usr/local/lib/skyjo-online/bootstrap-generation-guard-lib.sh',
    '/usr/local/lib/skyjo-online/skyjo-canary-launch',
    '/usr/local/lib/skyjo-online/skyjo-smoke-launch',
    '/usr/local/lib/skyjo-online/skyjo-state-proof-launch',
    '/usr/local/lib/skyjo-online/skyjo-controller-launch'
  ];
  for (const file of root0555) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o555 });
  for (const file of [
    PATHS.stagedProductionUnit,
    '/etc/systemd/system/skyjo-online-canary@.service',
    '/etc/systemd/system/skyjo-online-canary-smoke@.service',
    '/etc/systemd/system/skyjo-online-smoke@.service',
    '/etc/systemd/system/skyjo-online-state-proof@.service',
    '/etc/systemd/system/skyjo-online-legacy-proof@.service',
    '/etc/tmpfiles.d/skyjo-online.conf',
    PATHS.assetManifest
  ]) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o444 });
  for (const file of [
    `${PATHS.authorizationKeys}/canary-2026-07.pem`,
    `${PATHS.authorizationKeys}/production-2026-07.pem`
  ]) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o600 });
  await exactPath('/etc/sudoers.d/skyjo-deploy', { type: 'file', uid: 0, gid: 0, mode: 0o440 });
  await run('/usr/bin/sha256sum', ['--check', '--strict', PATHS.assetManifest]);
  await run('/usr/bin/systemd-analyze', ['verify',
    '/etc/systemd/system/skyjo-online-canary@.service',
    '/etc/systemd/system/skyjo-online-canary-smoke@.service',
    '/etc/systemd/system/skyjo-online-smoke@.service',
    '/etc/systemd/system/skyjo-online-state-proof@.service',
    '/etc/systemd/system/skyjo-online-legacy-proof@.service',
    PATHS.stagedProductionUnit
  ]);

  await validateDeploymentPublicKeys({
    canaryPath: `${PATHS.authorizationKeys}/canary-2026-07.pem`,
    productionPath: `${PATHS.authorizationKeys}/production-2026-07.pem`,
    expectedUid: 0
  });

  await exactPath('/var/lib/skyjo-deploy', { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
  const admissionLockStat = await exactPath(ADMISSION_LOCK_PATH, { type: 'file', uid: 0, gid: identities['skyjo-deploy'].gid, mode: 0o640 });
  if (admissionLockStat.nlink !== 1 || admissionLockStat.size !== 0) throw new Error('Deployment admission lock file is not unique and empty.');
  await exactPath('/var/lib/skyjo-deploy/.ssh', { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
  await exactPath('/var/lib/skyjo-deploy/.ssh/authorized_keys', { type: 'file', uid: 0, gid: 0, mode: 0o644 });
  const authorizedKeys = await readNoFollow('/var/lib/skyjo-deploy/.ssh/authorized_keys');
  if (!/^restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="\/opt\/skyjo-online\/node\/bin\/node \/usr\/local\/lib\/skyjo-online\/skyjo-deploy-dispatch\.mjs" ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?\n$/.test(authorizedKeys)) {
    throw new Error('Deployment SSH forced-command policy is invalid.');
  }
  const sudoers = await readNoFollow('/etc/sudoers.d/skyjo-deploy');
  if (sudoers !== 'Defaults:skyjo-deploy !requiretty\nskyjo-deploy ALL=(root) NOPASSWD: /usr/local/sbin/skyjo-release-controller *\n') {
    throw new Error('Deployment sudo policy differs from the exact controller-only contract.');
  }

  await exactPath('/etc/skyjo-online.env', { type: 'file', uid: 0, gid: 0, mode: 0o600 });
  const productionEnvironment = parseProductionEnvironment(await readNoFollow('/etc/skyjo-online.env'));
  if (productionEnvironment.get('SKYJO_APNS_PRIVATE_KEY_FILE')) {
    await exactPath('/etc/skyjo-online', { type: 'directory', uid: 0, gid: identities.skyjo.gid, mode: 0o750 });
    await exactPath('/etc/skyjo-online/apns-provider.p8', { type: 'file', uid: 0, gid: identities.skyjo.gid, mode: 0o640 });
    await exactPath('/etc/skyjo-online/apns-token.key', { type: 'file', uid: 0, gid: identities.skyjo.gid, mode: 0o640 });
  }

  const unitContracts = [
    ['/etc/systemd/system/skyjo-online-canary@.service', {
      required: ['CollectMode=inactive', 'User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env -/etc/skyjo-online'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo']
    }],
    ['/etc/systemd/system/skyjo-online-canary-smoke@.service', {
      required: ['CollectMode=inactive', 'User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env -/etc/skyjo-online'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo']
    }],
    ['/etc/systemd/system/skyjo-online-state-proof@.service', {
      required: ['CollectMode=inactive', 'User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env -/etc/skyjo-online'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo', 'IPAddressAllow=localhost']
    }],
    ['/etc/systemd/system/skyjo-online-smoke@.service', {
      required: ['CollectMode=inactive', 'User=skyjo', 'Group=skyjo', 'EnvironmentFile=/etc/skyjo-online.env', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=true', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost'],
      forbidden: ['User=skyjo-canary']
    }],
    ['/etc/systemd/system/skyjo-online-legacy-proof@.service', {
      required: ['CollectMode=inactive', 'User=skyjo', 'Group=skyjo', 'EnvironmentFile=/etc/skyjo-online.env', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=true', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost'],
      forbidden: ['User=skyjo-canary', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env -/etc/skyjo-online']
    }]
  ];
  for (const [unitPath, contract] of unitContracts) assertUnitDirectives(unitPath, await readNoFollow(unitPath), contract);
  let productionUnit = 'staged';
  const activeUnit = '/etc/systemd/system/skyjo-online.service';
  const activeStat = await fsp.lstat(activeUnit).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (activeStat) {
    if (!activeStat.isFile() || activeStat.isSymbolicLink() || activeStat.uid !== 0 || activeStat.gid !== 0 || (activeStat.mode & 0o022) !== 0) {
      throw new Error('Active production unit is unsafe.');
    }
    if (await sha256File(activeUnit) === await sha256File(PATHS.stagedProductionUnit)) {
      if (!hardenedStateOwnership) throw new Error('Hardened production unit requires skyjo-owned mode-0700 state.');
      await assertHardenedProductionUnit();
      productionUnit = 'hardened';
    } else {
      productionUnit = 'legacy-pending-cutover';
    }
  }
  return { status: 'ok', node: 'v24.18.0', productionUnit, activation: false };
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Release controller must run as root on Linux.');
  const parsed = parseArguments([...argv]);
  await assertNode24();
  const deployGid = Number((await run('/usr/bin/id', ['-g', 'skyjo-deploy'])).trim());
  if (!Number.isSafeInteger(deployGid) || deployGid < 0) throw new Error('Deployment staging group is invalid.');
  const admission = await acquireAdmissionLock(PATHS.stage, {
    stageRootContract: { uid: 0, gid: deployGid, mode: 0o1731 },
    lockPath: ADMISSION_LOCK_PATH,
    lockParentContract: { uid: 0, gid: 0, mode: 0o755 },
    lockContract: { uid: 0, gid: deployGid, mode: 0o640 },
    conflictExitCode: 73
  });
  let result;
  let primaryError;
  try {
    await assertStageRootContract();
    await assertEffectiveDeliveryUnits();
    result = parsed.command === 'self-test'
      ? await selfTest()
      : await executeAuthorizedControllerAction({
          expectedCommand: parsed.command,
          signedCommand: parsed.signedCommand,
          action: async (fields) => {
            await cleanupStaleIncomingDirectories({
              appRoot: PATHS.appRoot,
              releasesRoot: PATHS.releases,
              activeRunId: fields.runId,
              activeReleaseSha: fields.releaseSha
            });
            const authorized = {
              command: fields.command,
              runId: fields.runId,
              releaseSha: fields.releaseSha,
              digest: fields.artifactSha256,
              tag: fields.tag === '-' ? undefined : fields.tag
            };
            const actionResult = authorized.command === 'verify'
              ? await verifyAction(authorized)
              : authorized.command === 'promote'
                ? await promoteAction(authorized)
                : await rollbackAction(authorized);
            return validateControllerActionResult(fields, actionResult);
          },
          reconcileReplay: reconcileCompletedControllerResult,
          reconcileStarted: reconcileStartedControllerOperation,
          reconcileCompletion: reconcileCompletedControllerResult,
          recoverCompletionFailure: recoverUnpersistedControllerResult,
          allowStartedRecovery: true
        });
  } catch (error) {
    primaryError = error;
  }
  let releaseError;
  try { await admission.release(); }
  catch (error) { releaseError = error; }
  if (primaryError && releaseError) {
    throw combineAdmissionLockErrors(primaryError, releaseError, 'Release controller failed and its admission lock did not release.');
  }
  if (primaryError) throw primaryError;
  if (releaseError) throw releaseError;
  writeTerminalLine(1, `${JSON.stringify(result)}\n`);
  return result;
}

export async function invokeDirectController(mainImpl = main, argv = process.argv, {
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  isAdmissionLockConflictImpl = isAdmissionLockConflict
} = {}) {
  let keepAlive;
  try {
    keepAlive = setIntervalImpl(() => {}, controllerLifecycleKeepAliveMs);
    keepAlive?.ref?.();
    try {
      return await mainImpl();
    } catch (error) {
      const command = argv[2];
      const status = error?.deploymentStatus || (command === 'rollback' ? 'rollback-failed' : 'failed');
      writeTerminalLine(2, `Release controller failed: ${JSON.stringify({
        status,
        message: error?.message || 'unknown error',
        dataRestored: false
      })}\n`);
      process.exitCode = isAdmissionLockConflictImpl(error, 73) ? 73 : status === 'rollback-failed' ? 2 : 1;
      return undefined;
    }
  } finally {
    if (keepAlive !== undefined) clearIntervalImpl(keepAlive);
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) await invokeDirectController();
