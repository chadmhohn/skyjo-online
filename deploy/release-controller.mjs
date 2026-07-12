#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  assertGithubCommitOnMain,
  authorizeRollback,
  executeCodeRollbackTransaction,
  executeActivationTransaction,
  MAX_ARCHIVE_BYTES,
  loadVerifiedReleaseIdentity,
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
  stagedProductionUnit: '/usr/local/share/skyjo-online/skyjo-online.service',
  service: 'skyjo-online.service'
});

const AUTHORIZATION_KEYRING = new Map([
  ['canary-primary', Object.freeze({ role: 'canary', publicKeyPath: '/etc/skyjo-deploy-auth/canary-public.pem' })],
  ['production-primary', Object.freeze({ role: 'production', publicKeyPath: '/etc/skyjo-deploy-auth/production-public.pem' })]
]);
const controllerLifecycleKeepAliveMs = 60_000;

export function parseArguments(argv) {
  const command = argv.shift();
  if (!['upload', 'verify', 'promote', 'rollback', 'self-test'].includes(command || '')) throw new Error('Unsupported controller action.');
  if (command === 'self-test') {
    if (argv.length) throw new Error('Self-test takes no arguments.');
    return { command };
  }
  if (argv.length !== 2 || argv[0] !== '--authorization-command' || typeof argv[1] !== 'string') {
    throw new Error('A signed deployment authorization command is required.');
  }
  return { command, signedCommand: argv[1] };
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
  const version = (await run(PATHS.node, ['--version'])).trim();
  if (version !== 'v24.18.0') throw new Error('Pinned Skyjo Node v24.18.0 is required.');
}

async function copyArchive(source, destination) {
  const sourceHandle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await sourceHandle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('Staged artifact is not a safe regular file.');
    const destinationHandle = await fsp.open(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o400);
    try {
      await pipeline(sourceHandle.createReadStream({ autoClose: false }), destinationHandle.createWriteStream({ autoClose: false }));
      await destinationHandle.sync();
    } finally {
      await destinationHandle.close().catch(() => {});
    }
  } finally {
    await sourceHandle.close().catch(() => {});
  }
}

function lines(value) {
  return value.replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
}

async function prepareCandidate({ runId, releaseSha, digest, bytes }) {
  const stageDirectory = resolveWithin(PATHS.stage, runId);
  const stageStat = await fsp.lstat(stageDirectory);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error('Deployment stage is unsafe.');
  await run('/usr/bin/chown', ['root:skyjo-canary', stageDirectory]);
  await run('/usr/bin/chmod', ['0710', stageDirectory]);
  const sourceArchive = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
  const workDirectory = stageDirectory;
  const privateArchive = resolveWithin(workDirectory, 'artifact.tar.gz');
  try {
    await fsp.rm(privateArchive, { force: true });
    await copyArchive(sourceArchive, privateArchive);
    if ((await fsp.stat(privateArchive)).size !== bytes) throw new Error('Artifact size does not match the signed deployment authorization.');
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
    await fsp.writeFile(resolveWithin(candidate, '.skyjo-deployment.json'), `${JSON.stringify({ releaseSha, artifactSha256: digest, artifactBytes: bytes })}\n`, { mode: 0o444 });
    return { workDirectory, candidate, identity };
  } catch (caught) {
    const primaryError = caught instanceof Error ? caught : new Error(String(caught));
    try {
      await cleanupRun(runId, workDirectory);
    } catch (cleanupCaught) {
      throw combinedActionAndCleanupError(primaryError, cleanupCaught);
    }
    throw primaryError;
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
  keyring = AUTHORIZATION_KEYRING,
  ledgerRoot = PATHS.authorizationReplay,
  nowSeconds = Math.floor(Date.now() / 1000),
  expectedUid = 0,
  allowExactCompletedReplay = false
}) {
  const { fields, signature } = parseSignedDeploymentCommand(signedCommand, { nowSeconds });
  if (fields.command !== expectedCommand) throw new Error('Signed deployment command does not match the requested controller action.');
  const verified = await verifyDeploymentAuthorization({ fields, signature, keyring, nowSeconds, expectedUid });
  const authorizationUse = await beginAuthorizationUse({
    ledgerRoot, ...verified, nowSeconds, expectedUid, allowExactCompletedReplay
  });
  try {
    const result = await action(fields);
    await authorizationUse.complete();
    return result;
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    await authorizationUse.fail().catch((ledgerError) => {
      Object.defineProperty(error, 'authorizationLedgerError', { value: ledgerError, enumerable: false });
    });
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

async function localHealth() {
  const response = await fetch('http://127.0.0.1:4180/healthz', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
  if (!response.ok || await response.text() !== 'ok') throw new Error('Production liveness check failed.');
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
  for (const [property, expected] of exactProperties) {
    const actual = (await run('/usr/bin/systemctl', ['show', PATHS.service, `--property=${property}`, '--value'])).trim();
    if (actual !== expected) throw new Error(`The hardened production unit ${property} property is invalid.`);
  }
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
  for (const [name, cleanup] of [
    ['stop-server', operations.stopServer],
    ['reset-units', operations.resetUnits],
    ['remove-environment', operations.removeEnvironment]
  ]) {
    try {
      await cleanup();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      Object.defineProperty(error, 'canaryCleanupStage', { value: name, enumerable: true });
      cleanupErrors.push(error);
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      Object.defineProperty(primaryError, 'canaryCleanupErrors', { value: cleanupErrors, enumerable: false });
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Canary passed but cleanup did not complete safely.');
  }
}

async function canary(releaseDirectory, identity, snapshotDirectory, runId) {
  const runDirectory = resolveWithin(PATHS.stage, runId);
  // prepareCandidate has already taken ownership from the upload identity. Keep
  // the run root controller-owned while granting the runtime group traversal;
  // otherwise skyjo-deploy could replace the candidate during the canary.
  await run('/usr/bin/chown', ['root:skyjo-canary', runDirectory]);
  await run('/usr/bin/chmod', ['0710', runDirectory]);
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
  const canaryEmail = `canary-${runId}@example.invalid`;
  const env = [
    `SKYJO_CANARY_RELEASE_DIR=${releaseDirectory}`,
    `SKYJO_DB_FILE=${resolveWithin(stateDirectory, 'skyjo.sqlite')}`,
    `SKYJO_ROOMS_FILE=${resolveWithin(stateDirectory, 'rooms.json')}`,
    `SKYJO_CANARY_PROOF_DIR=${proofDirectory}`,
    `SKYJO_RELEASE_FILE=${resolveWithin(releaseDirectory, 'dist/release.json')}`,
    `SKYJO_EXPECTED_RELEASE_SHA=${identity.releaseSha}`,
    `SKYJO_EXPECTED_PROTOCOL_VERSION=${identity.protocolVersion}`,
    `SKYJO_ACCESS_PASSWORD=${crypto.randomBytes(32).toString('base64url')}`,
    `SKYJO_SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`,
    `SKYJO_INVITE_SECRET=${crypto.randomBytes(48).toString('base64url')}`,
    `SKYJO_ADMIN_EMAIL=${canaryEmail}`,
    `SKYJO_ADMIN_INITIAL_PASSWORD=${canaryPassword}`,
    `SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=${canaryEmail}`,
    `SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=${canaryPassword}`,
    'SKYJO_SECURE_COOKIES=false',
    'SKYJO_DATABASE_RETRY_MS=100',
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4181',
    'HOST=127.0.0.1', 'PORT=4181', 'NODE_ENV=production',
    'SKYJO_VAPID_PUBLIC_KEY=', 'SKYJO_VAPID_PRIVATE_KEY=', 'SKYJO_VAPID_SUBJECT='
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
    resetUnits: () => run('/usr/bin/systemctl', ['reset-failed', serverUnit, smokeUnit, stateProofUnit]),
    removeEnvironment: () => fsp.rm(envPath, { force: true })
  });
}

function combinedActionAndCleanupError(primaryError, cleanupCaught) {
  const cleanupError = cleanupCaught instanceof Error ? cleanupCaught : new Error(String(cleanupCaught));
  const combined = new AggregateError(
    [primaryError, cleanupError],
    'Deployment action failed and its run directory cleanup also failed.',
    { cause: primaryError }
  );
  Object.defineProperty(combined, 'deploymentActionError', { value: primaryError, enumerable: false });
  Object.defineProperty(combined, 'deploymentCleanupError', { value: cleanupError, enumerable: false });
  return combined;
}

export async function cleanupRun(runId, workDirectory, {
  stageRoot = PATHS.stage,
  remove = fsp.rm,
  inspect = fsp.lstat
} = {}) {
  if (path.resolve(workDirectory) !== resolveWithin(stageRoot, runId)) throw new Error('Refusing to clean an unexpected deployment path.');
  await remove(workDirectory, { recursive: true, force: true });
  const residue = await inspect(workDirectory).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (residue) throw new Error('Deployment run directory remains after cleanup.');
}

export async function executeWithRunCleanup({ runId, workDirectory, action, cleanup = cleanupRun }) {
  let result;
  let primaryError;
  try {
    result = await action();
  } catch (caught) {
    primaryError = caught instanceof Error ? caught : new Error(String(caught));
  }

  let cleanupError;
  try {
    await cleanup(runId, workDirectory);
  } catch (caught) {
    cleanupError = caught instanceof Error ? caught : new Error(String(caught));
  }

  if (primaryError && cleanupError) throw combinedActionAndCleanupError(primaryError, cleanupError);
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

async function verifyAction(parsed) {
  const oldRelease = await readLinkWithin(PATHS.current, PATHS.releases).catch(() => {
    throw new Error('No validated rollback anchor exists; canary verification is refused.');
  });
  const rollbackAnchor = await validateRollbackAnchor(oldRelease);
  const prepared = await prepareCandidate(parsed);
  const snapshot = resolveWithin(prepared.workDirectory, 'snapshot');
  return executeWithRunCleanup({
    runId: parsed.runId,
    workDirectory: prepared.workDirectory,
    action: async () => {
      await createSnapshot(rollbackAnchor, snapshot);
      await canary(prepared.candidate, prepared.identity, snapshot, parsed.runId);
      return { verified: parsed.releaseSha, activated: false };
    }
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
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4180'
  ].join('\n') + '\n', { mode: 0o640 });
  await run('/usr/bin/chown', ['root:skyjo', envPath]);
  try { await run('/usr/bin/systemctl', ['start', `skyjo-online-smoke@${runId}.service`]); }
  finally {
    await run('/usr/bin/systemctl', ['reset-failed', `skyjo-online-smoke@${runId}.service`]).catch(() => {});
    await fsp.rm(envPath, { force: true });
  }
}

async function rollbackLinks(failedRelease, oldRelease, runId) {
  const recoveredAnchor = await validateRollbackAnchor(oldRelease);
  const failedAnchor = await validateRollbackAnchor(failedRelease);
  const verifyRelease = async (releaseDirectory, anchor) => {
    await run('/usr/bin/systemctl', ['start', PATHS.service]);
    if (anchor.legacy) await localHealth();
    else {
      await waitForRelease('http://127.0.0.1:4180', anchor.releaseSha);
      await smokeProduction(releaseDirectory, anchor, runId);
    }
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
  await run('/usr/bin/systemctl', ['start', PATHS.service]);
  if (rollbackAnchor.legacy) {
    await localHealth();
    return;
  }
  await waitForRelease('http://127.0.0.1:4180', rollbackAnchor.releaseSha);
  await smokeProduction(oldRelease, rollbackAnchor, runId);
}

async function pruneReleases() {
  const protectedPaths = [await readLinkWithin(PATHS.current, PATHS.releases), await readLinkWithin(PATHS.previous, PATHS.releases)];
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
  if (rollbackAnchor.legacy) await localHealth();
  else await waitForRelease('http://127.0.0.1:4180', rollbackAnchor.releaseSha);
  const prepared = await prepareCandidate(parsed);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backup = resolveWithin(PATHS.backups, `${timestamp}-pre-${parsed.releaseSha}`);
  let target;
  return executeWithRunCleanup({
    runId: parsed.runId,
    workDirectory: prepared.workDirectory,
    action: async () => {
    await createSnapshot(rollbackAnchor, backup);
    await canary(prepared.candidate, prepared.identity, backup, parsed.runId);
    target = resolveWithin(PATHS.releases, parsed.releaseSha);
    const incoming = resolveWithin(PATHS.releases, `.incoming-${parsed.releaseSha}-${parsed.runId}`);
    await fsp.rm(incoming, { recursive: true, force: true });
    const targetExists = await fsp.lstat(target).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (targetExists) {
      const existingIdentity = await loadVerifiedReleaseIdentity(target, parsed.releaseSha);
      const existingMetadata = await readMetadata(target);
      if (existingMetadata.artifactSha256 !== parsed.digest || existingMetadata.artifactBytes !== parsed.bytes ||
          existingMetadata.tag !== parsed.tag || existingIdentity.releaseSha !== parsed.releaseSha) {
        throw new Error('An existing release directory conflicts with the approved artifact.');
      }
    } else {
      await fsp.cp(prepared.candidate, incoming, { recursive: true, force: false, errorOnExist: true });
      await loadVerifiedReleaseIdentity(incoming, parsed.releaseSha);
      const metadata = await readMetadata(incoming);
      metadata.tag = parsed.tag;
      await fsp.writeFile(resolveWithin(incoming, '.skyjo-deployment.json'), `${JSON.stringify(metadata)}\n`, { mode: 0o444 });
      await run('/usr/bin/chown', ['--recursive', 'root:root', incoming]);
      await run('/usr/bin/chmod', ['--recursive', 'u=rwX,go=rX', incoming]);
      await fsp.rename(incoming, target);
    }
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
        swap: async () => {
          await replaceSymlink(PATHS.previous, oldRelease);
          await replaceSymlink(PATHS.current, target);
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
    await pruneReleases();
    return { promoted: parsed.releaseSha, tag: parsed.tag, backup: path.basename(backup) };
    }
  });
}

async function rollbackAction(parsed) {
  await assertHardenedProductionUnit();
  const failed = await readLinkWithin(PATHS.current, PATHS.releases);
  const metadata = await readMetadata(failed);
  authorizeRollback({
    currentReleaseSha: path.basename(failed), metadata, requestedReleaseSha: parsed.releaseSha,
    requestedDigest: parsed.digest, requestedBytes: parsed.bytes, requestedTag: parsed.tag
  });
  const previous = await readLinkWithin(PATHS.previous, PATHS.releases);
  const legacy = await rollbackLinks(failed, previous, parsed.runId);
  return { rolledBackTo: legacy ? 'legacy' : path.basename(previous), legacy };
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
    'SKYJO_ACCESS_PASSWORD',
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
  for (const forbidden of ['SKYJO_CANARY_RELEASE_DIR', 'SKYJO_CANARY_PROOF_DIR', 'SKYJO_EXPECTED_RELEASE_SHA', 'SKYJO_SMOKE_BASE_URL']) {
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

async function assertEffectiveTemplate(unit, fragmentPath, expectedUser, expectedGroup) {
  const exact = new Map([
    ['FragmentPath', fragmentPath],
    ['DropInPaths', ''],
    ['User', expectedUser],
    ['Group', expectedGroup],
    ['NoNewPrivileges', 'yes'],
    ['ProtectSystem', 'strict']
  ]);
  for (const [property, expected] of exact) {
    const actual = (await run('/usr/bin/systemctl', ['show', unit, `--property=${property}`, '--value'])).trim();
    if (actual !== expected) throw new Error(`Effective systemd property ${property} is invalid for ${unit}.`);
  }
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
  await exactPath(PATHS.stage, { type: 'directory', uid: 0, gid: identities['skyjo-deploy'].gid, mode: 0o1731 });
  await exactPath(PATHS.authorizationReplay, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(PATHS.authorizationKeys, { type: 'directory', uid: 0, gid: 0, mode: 0o700 });
  await exactPath(PATHS.canaryEnv, { type: 'directory', uid: 0, gid: 0, mode: 0o711 });

  const root0555 = [
    '/usr/local/sbin/skyjo-release-controller',
    '/usr/local/lib/skyjo-online/release-controller.mjs',
    '/usr/local/lib/skyjo-online/release-controller-lib.mjs',
    '/usr/local/lib/skyjo-online/state-snapshot-lib.mjs',
    '/usr/local/lib/skyjo-online/deployment-authorization-lib.mjs',
    '/usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs',
    '/usr/local/lib/skyjo-online/validate-deployment-public-keys.mjs',
    '/usr/local/lib/skyjo-online/skyjo-canary-launch',
    '/usr/local/lib/skyjo-online/skyjo-smoke-launch',
    '/usr/local/lib/skyjo-online/skyjo-state-proof-launch'
  ];
  for (const file of root0555) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o555 });
  for (const file of [
    PATHS.stagedProductionUnit,
    '/etc/systemd/system/skyjo-online-canary@.service',
    '/etc/systemd/system/skyjo-online-canary-smoke@.service',
    '/etc/systemd/system/skyjo-online-smoke@.service',
    '/etc/systemd/system/skyjo-online-state-proof@.service',
    '/etc/tmpfiles.d/skyjo-online.conf',
    PATHS.assetManifest
  ]) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o444 });
  for (const file of [
    `${PATHS.authorizationKeys}/canary-public.pem`,
    `${PATHS.authorizationKeys}/production-public.pem`
  ]) await exactPath(file, { type: 'file', uid: 0, gid: 0, mode: 0o600 });
  await exactPath('/etc/sudoers.d/skyjo-deploy', { type: 'file', uid: 0, gid: 0, mode: 0o440 });
  await run('/usr/bin/sha256sum', ['--check', '--strict', PATHS.assetManifest]);
  await run('/usr/bin/systemd-analyze', ['verify',
    '/etc/systemd/system/skyjo-online-canary@.service',
    '/etc/systemd/system/skyjo-online-canary-smoke@.service',
    '/etc/systemd/system/skyjo-online-smoke@.service',
    '/etc/systemd/system/skyjo-online-state-proof@.service',
    PATHS.stagedProductionUnit
  ]);

  await validateDeploymentPublicKeys({
    canaryPath: `${PATHS.authorizationKeys}/canary-public.pem`,
    productionPath: `${PATHS.authorizationKeys}/production-public.pem`,
    expectedUid: 0
  });

  await exactPath('/var/lib/skyjo-deploy', { type: 'directory', uid: 0, gid: 0, mode: 0o755 });
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
  parseProductionEnvironment(await readNoFollow('/etc/skyjo-online.env'));

  const unitContracts = [
    ['/etc/systemd/system/skyjo-online-canary@.service', {
      required: ['User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo']
    }],
    ['/etc/systemd/system/skyjo-online-canary-smoke@.service', {
      required: ['User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo']
    }],
    ['/etc/systemd/system/skyjo-online-state-proof@.service', {
      required: ['User=skyjo-canary', 'Group=skyjo-canary', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=false', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'InaccessiblePaths=/var/lib/skyjo-online /etc/skyjo-online.env'],
      forbidden: ['EnvironmentFile=/etc/skyjo-online.env', 'User=skyjo', 'IPAddressAllow=localhost']
    }],
    ['/etc/systemd/system/skyjo-online-smoke@.service', {
      required: ['User=skyjo', 'Group=skyjo', 'EnvironmentFile=/etc/skyjo-online.env', 'EnvironmentFile=/run/skyjo-online-canary/%i.env', 'PrivateTmp=true', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'IPAddressDeny=any', 'IPAddressAllow=localhost'],
      forbidden: ['User=skyjo-canary']
    }]
  ];
  for (const [unitPath, contract] of unitContracts) assertUnitDirectives(unitPath, await readNoFollow(unitPath), contract);
  await assertEffectiveTemplate(
    'skyjo-online-canary@1-1-canary.service',
    '/etc/systemd/system/skyjo-online-canary@.service',
    'skyjo-canary',
    'skyjo-canary'
  );
  await assertEffectiveTemplate(
    'skyjo-online-canary-smoke@1-1-canary.service',
    '/etc/systemd/system/skyjo-online-canary-smoke@.service',
    'skyjo-canary',
    'skyjo-canary'
  );
  await assertEffectiveTemplate(
    'skyjo-online-state-proof@1-1-canary.service',
    '/etc/systemd/system/skyjo-online-state-proof@.service',
    'skyjo-canary',
    'skyjo-canary'
  );
  await assertEffectiveTemplate(
    'skyjo-online-smoke@1-1-production.service',
    '/etc/systemd/system/skyjo-online-smoke@.service',
    'skyjo',
    'skyjo'
  );

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
  process.stdout.write(`${JSON.stringify({ status: 'ok', node: 'v24.18.0', productionUnit, activation: false })}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Release controller must run as root on Linux.');
  const parsed = parseArguments([...argv]);
  await assertNode24();
  if (parsed.command === 'self-test') return selfTest();
  const result = await executeAuthorizedControllerAction({
    expectedCommand: parsed.command,
    signedCommand: parsed.signedCommand,
    allowExactCompletedReplay: parsed.command === 'upload',
    action: async (fields) => {
      const authorized = {
        command: fields.command,
        runId: fields.runId,
        releaseSha: fields.releaseSha,
        digest: fields.artifactSha256,
        bytes: fields.artifactBytes,
        tag: fields.tag === '-' ? undefined : fields.tag
      };
      if (authorized.command === 'upload') return { authorized: authorized.releaseSha, bytes: authorized.bytes };
      if (authorized.command === 'verify') return verifyAction(authorized);
      if (authorized.command === 'promote') return promoteAction(authorized);
      return rollbackAction(authorized);
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

export async function invokeDirectController(mainImpl = main, argv = process.argv, {
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
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
      process.stderr.write(`Release controller failed: ${JSON.stringify({
        status,
        message: error?.message || 'unknown error',
        dataRestored: false
      })}\n`);
      process.exitCode = status === 'rollback-failed' ? 2 : 1;
      return undefined;
    }
  } finally {
    if (keepAlive !== undefined) clearIntervalImpl(keepAlive);
  }
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  await invokeDirectController();
}
