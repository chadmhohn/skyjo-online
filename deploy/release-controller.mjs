#!/opt/skyjo-online/node/bin/node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  authorizeRollback,
  executeActivationTransaction,
  MAX_ARCHIVE_BYTES,
  loadVerifiedReleaseIdentity,
  readLinkWithin,
  replaceSymlink,
  resolveGithubTag,
  resolveWithin,
  selectReleasePathsToPrune,
  sha256File,
  validateArchiveListing,
  validateDigest,
  validateReleaseSha,
  validateReleaseTag,
  validateRunId
} from './release-controller-lib.mjs';

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
  service: 'skyjo-online.service'
});

export function parseArguments(argv) {
  const command = argv.shift();
  if (!['verify', 'promote', 'rollback', 'self-test'].includes(command || '')) throw new Error('Unsupported controller action.');
  const values = new Map();
  while (argv.length) {
    const key = argv.shift();
    const value = argv.shift();
    if (!['--run-id', '--release-sha', '--artifact-sha256', '--tag'].includes(key || '') || !value || values.has(key)) {
      throw new Error('Invalid controller arguments.');
    }
    values.set(key, value);
  }
  if (command === 'self-test') {
    if (argv.length || values.size) throw new Error('Self-test takes no arguments.');
    return { command };
  }
  const parsed = {
    command,
    runId: validateRunId(values.get('--run-id')),
    releaseSha: validateReleaseSha(values.get('--release-sha')),
    digest: validateDigest(values.get('--artifact-sha256')),
    tag: values.has('--tag') ? validateReleaseTag(values.get('--tag')) : undefined
  };
  if (command === 'verify' && (parsed.tag || !parsed.runId.endsWith('-canary'))) throw new Error('Verify requires a canary run ID and no tag.');
  if (command !== 'verify' && (!parsed.tag || !parsed.runId.endsWith('-production'))) throw new Error('Production actions require a production run ID and tag.');
  return parsed;
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

async function prepareCandidate({ runId, releaseSha, digest }) {
  const stageDirectory = resolveWithin(PATHS.stage, runId);
  const stageStat = await fsp.lstat(stageDirectory);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error('Deployment stage is unsafe.');
  await run('/usr/bin/chown', ['root:skyjo', stageDirectory]);
  await run('/usr/bin/chmod', ['0710', stageDirectory]);
  const sourceArchive = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
  const workDirectory = stageDirectory;
  const privateArchive = resolveWithin(workDirectory, 'artifact.tar.gz');
  try {
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
    return { workDirectory, candidate, identity };
  } catch (error) {
    await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function createSnapshot(releaseDirectory, releaseSha, destination) {
  await run(PATHS.node, [resolveWithin(releaseDirectory, 'scripts/backup-state.mjs'), '--output', destination,
    '--database', resolveWithin(PATHS.state, 'skyjo.sqlite'), '--rooms', resolveWithin(PATHS.state, 'rooms.json'),
    '--release', resolveWithin(releaseDirectory, 'release.json')]);
  await run(PATHS.node, [resolveWithin(releaseDirectory, 'scripts/verify-state-backup.mjs'), '--backup', destination]);
  return destination;
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
  const properties = await run('/usr/bin/systemctl', ['show', PATHS.service, '--property=User', '--property=ExecStart']);
  if (!properties.includes('User=skyjo') || !properties.includes('/opt/skyjo-online/node/bin/node') || !properties.includes('/srv/skyjo-online/current/server.mjs')) {
    throw new Error('The hardened production unit is not active in systemd.');
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

async function canary(releaseDirectory, identity, snapshotDirectory, runId) {
  const runDirectory = resolveWithin(PATHS.stage, runId);
  await run('/usr/bin/chown', ['skyjo-deploy:skyjo', runDirectory]);
  await run('/usr/bin/chmod', ['0710', runDirectory]);
  const stateDirectory = resolveWithin(runDirectory, 'canary-state');
  await fsp.rm(stateDirectory, { recursive: true, force: true });
  await run(PATHS.node, [resolveWithin(releaseDirectory, 'scripts/restore-state.mjs'), '--backup', snapshotDirectory, '--destination', stateDirectory]);
  await run('/usr/bin/chown', ['--recursive', 'skyjo:skyjo', stateDirectory]);
  await fsp.mkdir(PATHS.canaryEnv, { recursive: true, mode: 0o755 });
  const envPath = resolveWithin(PATHS.canaryEnv, `${runId}.env`);
  const env = [
    `SKYJO_CANARY_RELEASE_DIR=${releaseDirectory}`,
    `SKYJO_DB_FILE=${resolveWithin(stateDirectory, 'skyjo.sqlite')}`,
    `SKYJO_ROOMS_FILE=${resolveWithin(stateDirectory, 'rooms.json')}`,
    `SKYJO_RELEASE_FILE=${resolveWithin(releaseDirectory, 'dist/release.json')}`,
    `SKYJO_EXPECTED_RELEASE_SHA=${identity.releaseSha}`,
    `SKYJO_EXPECTED_PROTOCOL_VERSION=${identity.protocolVersion}`,
    'HOST=127.0.0.1', 'PORT=4181', 'NODE_ENV=production',
    'SKYJO_VAPID_PUBLIC_KEY=', 'SKYJO_VAPID_PRIVATE_KEY=', 'SKYJO_VAPID_SUBJECT='
  ].join('\n');
  await fsp.writeFile(envPath, `${env}\n`, { mode: 0o640 });
  await run('/usr/bin/chown', ['root:skyjo', envPath]);
  const serverUnit = `skyjo-online-canary@${runId}.service`;
  const smokeUnit = `skyjo-online-smoke@${runId}.service`;
  try {
    await run('/usr/bin/systemctl', ['start', serverUnit]);
    await waitForRelease('http://127.0.0.1:4181', identity.releaseSha);
    await run('/usr/bin/systemctl', ['start', smokeUnit]);
  } finally {
    await run('/usr/bin/systemctl', ['stop', serverUnit]).catch(() => {});
    await run('/usr/bin/systemctl', ['reset-failed', serverUnit, smokeUnit]).catch(() => {});
    await fsp.rm(envPath, { force: true });
  }
}

async function cleanupRun(runId, workDirectory) {
  if (path.resolve(workDirectory) !== resolveWithin(PATHS.stage, runId)) throw new Error('Refusing to clean an unexpected deployment path.');
  await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
}

async function verifyAction(parsed) {
  const prepared = await prepareCandidate(parsed);
  const snapshot = resolveWithin(prepared.workDirectory, 'snapshot');
  try {
    await createSnapshot(prepared.candidate, parsed.releaseSha, snapshot);
    await canary(prepared.candidate, prepared.identity, snapshot, parsed.runId);
    process.stdout.write(`${JSON.stringify({ verified: parsed.releaseSha, activated: false })}\n`);
  } finally {
    await cleanupRun(parsed.runId, prepared.workDirectory);
  }
}

async function readMetadata(releaseDirectory) {
  return JSON.parse(await fsp.readFile(resolveWithin(releaseDirectory, '.skyjo-deployment.json'), 'utf8'));
}

async function smokeProduction(releaseDirectory, identity, runId) {
  const envPath = resolveWithin(PATHS.canaryEnv, `${runId}.env`);
  await fsp.mkdir(PATHS.canaryEnv, { recursive: true, mode: 0o755 });
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
  await validateRollbackAnchor(oldRelease);
  await run('/usr/bin/systemctl', ['stop', PATHS.service]);
  await prepareStateOwnership();
  await replaceSymlink(PATHS.previous, failedRelease);
  await replaceSymlink(PATHS.current, oldRelease);
  await run('/usr/bin/systemctl', ['start', PATHS.service]);
  const legacy = await fsp.access(resolveWithin(oldRelease, '.skyjo-legacy')).then(() => true).catch(() => false);
  if (legacy) await localHealth();
  else {
    const identity = await loadVerifiedReleaseIdentity(oldRelease, path.basename(oldRelease));
    await waitForRelease('http://127.0.0.1:4180', identity.releaseSha);
    await smokeProduction(oldRelease, identity, runId);
  }
  return legacy;
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
  const oldRelease = await readLinkWithin(PATHS.current, PATHS.releases).catch(() => { throw new Error('No validated rollback anchor exists; promotion is refused.'); });
  await assertHardenedProductionUnit();
  const rollbackAnchor = await validateRollbackAnchor(oldRelease);
  if (rollbackAnchor.legacy) await localHealth();
  else await waitForRelease('http://127.0.0.1:4180', rollbackAnchor.releaseSha);
  const prepared = await prepareCandidate(parsed);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backup = resolveWithin(PATHS.backups, `${timestamp}-pre-${parsed.releaseSha}`);
  let target;
  try {
    await createSnapshot(prepared.candidate, parsed.releaseSha, backup);
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
      if (existingMetadata.artifactSha256 !== parsed.digest || existingMetadata.tag !== parsed.tag || existingIdentity.releaseSha !== parsed.releaseSha) {
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
      process.stdout.write(`${JSON.stringify({ promoted: parsed.releaseSha, tag: parsed.tag, idempotent: true })}\n`);
      return;
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
        restartPrevious: () => run('/usr/bin/systemctl', ['start', PATHS.service]).catch(() => {})
      });
    } catch (error) {
      if (error.activationRolledBack) {
        throw new Error(`Activation failed and code was rolled back without restoring data: ${error.message}`);
      }
      throw new Error(`Activation stopped before link change; the previous service was restarted: ${error.message}`);
    }
    await pruneReleases();
    process.stdout.write(`${JSON.stringify({ promoted: parsed.releaseSha, tag: parsed.tag, backup: path.basename(backup) })}\n`);
  } finally {
    await cleanupRun(parsed.runId, prepared.workDirectory);
  }
}

async function rollbackAction(parsed) {
  await assertHardenedProductionUnit();
  const failed = await readLinkWithin(PATHS.current, PATHS.releases);
  const metadata = await readMetadata(failed);
  authorizeRollback({ currentReleaseSha: path.basename(failed), metadata, requestedReleaseSha: parsed.releaseSha, requestedDigest: parsed.digest, requestedTag: parsed.tag });
  const previous = await readLinkWithin(PATHS.previous, PATHS.releases);
  const legacy = await rollbackLinks(failed, previous, parsed.runId);
  process.stdout.write(`${JSON.stringify({ rolledBackTo: legacy ? 'legacy' : path.basename(previous), legacy })}\n`);
}

async function selfTest() {
  await assertNode24();
  for (const directory of [PATHS.releases, PATHS.stage, PATHS.state, PATHS.backups]) {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe required directory: ${directory}`);
  }
  for (const file of ['/usr/local/sbin/skyjo-release-controller', '/usr/local/lib/skyjo-online/release-controller.mjs', '/etc/systemd/system/skyjo-online-canary@.service', '/etc/systemd/system/skyjo-online-smoke@.service']) {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error(`Unsafe installed controller asset: ${file}`);
  }
  if (!(await run('/usr/bin/id', ['-u', 'skyjo'])).trim()) throw new Error('Skyjo runtime user is missing.');
  const envStat = await fsp.stat('/etc/skyjo-online.env');
  if ((envStat.mode & 0o077) !== 0) throw new Error('/etc/skyjo-online.env must not be group/world accessible.');
  const envNames = new Set((await fsp.readFile('/etc/skyjo-online.env', 'utf8')).split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean));
  for (const required of ['SKYJO_ACCESS_PASSWORD', 'SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL', 'SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD']) {
    if (!envNames.has(required)) throw new Error(`Missing required deployment environment variable: ${required}`);
  }
  process.stdout.write(`${JSON.stringify({ status: 'ok', node: 'v24.18.0', activation: false })}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Release controller must run as root on Linux.');
  const parsed = parseArguments([...argv]);
  await assertNode24();
  if (parsed.command === 'self-test') return selfTest();
  if (parsed.command === 'verify') return verifyAction(parsed);
  if (parsed.command === 'promote') return promoteAction(parsed);
  return rollbackAction(parsed);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`Release controller failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
