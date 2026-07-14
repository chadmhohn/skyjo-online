import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadReleaseIdentity } from '../server-release.mjs';
import {
  isForbiddenArchivePathSegment,
  validateArchiveListing
} from '../deploy/release-controller-lib.mjs';
import { buildRuntimeArtifact } from './runtime-artifact-lib.mjs';

const execFileAsync = promisify(execFile);

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForReady(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited before readiness with code ${child.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch {
      // The isolated server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged server did not become ready within 15 seconds.');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Packaged server did not stop gracefully.')), 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

if (process.platform !== 'linux') throw new Error('Runtime artifact integration must run on Linux.');
const projectRoot = process.cwd();
const releaseSha = (process.env.SKYJO_RELEASE_SHA || process.env.GITHUB_SHA || '').trim().toLowerCase();
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
assert.match(releaseSha, /^[a-f0-9]{40}$/, 'A full release SHA is required.');
assert.ok(Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0, 'SOURCE_DATE_EPOCH is required.');
const releaseIdentity = await loadReleaseIdentity(path.join(projectRoot, 'dist'), { allowDevelopment: false, requireFullSha: true });
assert.equal(releaseIdentity.releaseSha, releaseSha, 'Downloaded build identity differs from the integration SHA.');
assert.equal(releaseIdentity.buildTimestamp, new Date(sourceDateEpoch * 1000).toISOString(), 'Downloaded build identity differs from SOURCE_DATE_EPOCH.');

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-runtime-integration-'));
const firstDirectory = path.join(temporaryRoot, 'first');
const secondDirectory = path.join(temporaryRoot, 'second');
const extractedDirectory = path.join(temporaryRoot, 'extracted');
const stateDirectory = path.join(temporaryRoot, 'state');
let server = null;
let logs = '';
try {
  const first = await buildRuntimeArtifact({ projectRoot, outputDirectory: firstDirectory, releaseSha });
  const [{ stdout: namesOutput }, { stdout: verboseOutput }] = await Promise.all([
    execFileAsync('tar', ['--gzip', '--list', '--file', first.archivePath], { maxBuffer: 4 * 1024 * 1024 }),
    execFileAsync('tar', ['--gzip', '--list', '--verbose', '--full-time', '--numeric-owner', '--file', first.archivePath], { maxBuffer: 4 * 1024 * 1024 })
  ]);
  const archiveLines = (value) => value.replace(/\r/g, '').split('\n').filter(Boolean);
  const controllerContract = validateArchiveListing(archiveLines(namesOutput), archiveLines(verboseOutput));
  assert.ok(
    controllerContract.entries.has('server-game-state-validation.mjs'),
    'The packaged artifact must include the persisted game-state validator imported at production startup.'
  );
  assert.ok(
    controllerContract.entries.has('server-invite-codes.mjs'),
    'The packaged artifact must include the persistent invite-code module imported at production startup.'
  );
  assert.ok(
    controllerContract.entries.has('server-room-invites.mjs'),
    'The packaged artifact must include the signed room-invite module imported at production startup.'
  );
  assert.ok(
    controllerContract.entries.has('server-push.mjs'),
    'The packaged artifact must include the Web Push validation and delivery module imported at production startup.'
  );
  assert.ok(controllerContract.entries.has('node_modules/minimist/package.json'), 'The real production tree must exercise minimist pruning.');
  assert.equal(
    [...controllerContract.entries].some((entry) => entry.split('/').some(isForbiddenArchivePathSegment)),
    false,
    'The packaged artifact retained a forbidden SCM or environment segment.'
  );
  assert.equal(
    [...controllerContract.entries].some((entry) => entry.startsWith('node_modules/minimist/.github')),
    false,
    'The real minimist .github directory was not pruned.'
  );
  const second = await buildRuntimeArtifact({ projectRoot, outputDirectory: secondDirectory, releaseSha });
  for (const key of ['archivePath', 'checksumPath', 'sbomPath']) {
    const [left, right] = await Promise.all([fs.readFile(first[key]), fs.readFile(second[key])]);
    assert.ok(left.equals(right), `${key} was not byte-reproducible.`);
  }
  assert.equal(first.sha256, second.sha256, 'Runtime artifact hashes differ across identical package builds.');
  assert.equal(first.packages, second.packages, 'Runtime package inventories differ across builds.');

  await fs.mkdir(extractedDirectory, { recursive: true, mode: 0o700 });
  await execFileAsync('tar', [
    '--extract', '--gzip', '--file', first.archivePath, '--directory', extractedDirectory,
    '--no-same-owner', '--no-same-permissions'
  ]);
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const port = await availablePort();
  const accessPassword = 'artifact-access-password';
  const accountEmail = 'artifact-smoke@example.test';
  const accountPassword = 'artifact-account-password';
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    SKYJO_ACCESS_PASSWORD: accessPassword,
    SKYJO_SESSION_SECRET: 'artifact-integration-session-secret-0123456789abcdef',
    SKYJO_INVITE_SECRET: 'artifact-integration-invite-secret-0123456789abcdef',
    SKYJO_SECURE_COOKIES: 'false',
    SKYJO_ADMIN_EMAIL: accountEmail,
    SKYJO_ADMIN_INITIAL_PASSWORD: accountPassword,
    SKYJO_ROOMS_FILE: path.join(stateDirectory, 'rooms.json'),
    SKYJO_DB_FILE: path.join(stateDirectory, 'skyjo.sqlite'),
    SKYJO_VAPID_PUBLIC_KEY: '',
    SKYJO_VAPID_PRIVATE_KEY: ''
  };
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: extractedDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-16_384); });
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(`${baseUrl}/readyz`, server);
  await execFileAsync(process.execPath, ['scripts/smoke-deployed.mjs'], {
    cwd: extractedDirectory,
    env: {
      ...environment,
      SKYJO_SMOKE_BASE_URL: baseUrl,
      SKYJO_SMOKE_ACCESS_PASSWORD: accessPassword,
      SKYJO_SMOKE_ACCOUNT_EMAIL: accountEmail,
      SKYJO_SMOKE_ACCOUNT_PASSWORD: accountPassword,
      SKYJO_EXPECTED_RELEASE_SHA: releaseSha,
      SKYJO_EXPECTED_PROTOCOL_VERSION: String(releaseIdentity.protocolVersion)
    },
    timeout: 15_000
  });
  console.log(JSON.stringify({
    status: 'ok',
    releaseSha,
    sha256: first.sha256,
    size: first.size,
    entries: first.entries,
    packages: first.packages
  }));
} catch (error) {
  if (logs) console.error(logs);
  throw error;
} finally {
  if (server) await stopChild(server);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
