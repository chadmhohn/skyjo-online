import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signDeploymentAuthorization } from '../deployment-authorization-lib.mjs';

const fixture = path.join(import.meta.dirname, 'fixtures', 'authorized-action-child.mjs');
const linux = process.platform === 'linux';

function signedAuthorization(privateKey, runId = '8123-1-canary') {
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    role: 'canary', command: 'verify', runId,
    releaseSha: 'a'.repeat(40), artifactSha256: 'b'.repeat(64), tag: '-',
    issuedAt: now, expiresAt: now + 300, keyId: 'canary-2026-07'
  };
  const signature = signDeploymentAuthorization(fields, privateKey, { nowSeconds: now });
  return `verify ${fields.runId} ${fields.releaseSha} ${fields.artifactSha256} - ${fields.issuedAt} ${fields.expiresAt} ${fields.keyId} ${signature}`;
}

async function waitForFile(filePath, child, stderr, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true).catch(() => false)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before marker: ${stderr.value}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for marker ${filePath}: ${stderr.value}`);
}

function childStatus(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function contender(lockPath) {
  const child = spawn('/usr/bin/flock', [
    '--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '73', lockPath, '/usr/bin/true'
  ], { stdio: 'ignore' });
  return childStatus(child);
}

async function fixtureRoot(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-controller-disconnect-'));
  const ledgerRoot = path.join(root, 'ledger');
  const keyPath = path.join(root, 'public.pem');
  const keyPair = crypto.generateKeyPairSync('ed25519');
  await fs.mkdir(ledgerRoot, { mode: 0o700 });
  await fs.writeFile(keyPath, keyPair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  try { await callback({ root, ledgerRoot, keyPath, keyPair }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function spawnFixture({ mode, root, ledgerRoot, keyPath, keyPair, runId }) {
  const startedPath = path.join(root, `${runId}.started`);
  const continuePath = path.join(root, `${runId}.continue`);
  const completedPath = path.join(root, `${runId}.completed`);
  const lockPath = path.join(root, `${runId}.lock`);
  const child = spawn('/usr/bin/flock', [
    '--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '73', lockPath,
    process.execPath, fixture, mode, ledgerRoot, keyPath, signedAuthorization(keyPair.privateKey, runId),
    startedPath, continuePath, completedPath
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = { value: '' };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr.value += chunk; });
  return { child, status: childStatus(child), stderr, startedPath, continuePath, completedPath, lockPath };
}

test('no-fork controller survives authorized SIGHUP while retaining its lock and completing the ledger', { skip: !linux }, async () => {
  await fixtureRoot(async (context) => {
    const processFixture = spawnFixture({ ...context, mode: 'hold', runId: '8123-1-canary' });
    const { child, status, stderr, startedPath, continuePath, completedPath, lockPath } = processFixture;
    try {
      await waitForFile(startedPath, child, stderr);
      assert.equal(JSON.parse(await fs.readFile(startedPath, 'utf8')).pid, child.pid, 'flock must exec Node without forking');
      const [recordPath] = (await fs.readdir(context.ledgerRoot)).map((name) => path.join(context.ledgerRoot, name));
      assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).status, 'started');

      assert.equal(child.kill('SIGHUP'), true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(child.exitCode, null, `authorized action died on SIGHUP: ${stderr.value}`);
      assert.deepEqual(await contender(lockPath), { code: 73, signal: null });

      await fs.writeFile(continuePath, 'continue\n', { flag: 'wx' });
      await waitForFile(completedPath, child, stderr);
      assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).status, 'completed');
      assert.deepEqual(await contender(lockPath), { code: 73, signal: null }, 'Node must retain the flock through finalization');

      assert.equal(child.kill('SIGHUP'), true);
      assert.deepEqual(await status, { code: null, signal: 'SIGHUP' }, 'SIGHUP protection must be scoped to the authorized transaction');
      assert.deepEqual(await contender(lockPath), { code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});

test('closed final stdout is harmless after action and ledger completion', { skip: !linux }, async () => {
  await fixtureRoot(async (context) => {
    const processFixture = spawnFixture({ ...context, mode: 'output', runId: '8124-1-canary' });
    const { child, status, stderr, startedPath, continuePath, completedPath } = processFixture;
    try {
      await waitForFile(startedPath, child, stderr);
      const stdoutClosed = new Promise((resolve) => child.stdout.once('close', resolve));
      child.stdout.destroy();
      await stdoutClosed;
      await fs.writeFile(continuePath, 'continue\n', { flag: 'wx' });
      assert.deepEqual(await status, { code: 0, signal: null }, stderr.value);
      assert.equal(stderr.value, '');
      assert.ok(await fs.access(completedPath).then(() => true).catch(() => false));
      const [record] = await fs.readdir(context.ledgerRoot);
      assert.equal(JSON.parse(await fs.readFile(path.join(context.ledgerRoot, record), 'utf8')).status, 'completed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
