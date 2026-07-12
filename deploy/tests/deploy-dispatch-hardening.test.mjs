import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  acquireUploadLock,
  dispatch,
  MAX_PARTIALS_CLEANED_PER_UPLOAD,
  parseCommand,
  performUpload,
  UPLOAD_LOCK_STALE_MS
} from '../skyjo-deploy-dispatch.mjs';

const releaseSha = 'a'.repeat(40);
const runId = '123-1-canary';
const signature = 'A'.repeat(86);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signedCommand(command, { body = 'data', bytes = Buffer.byteLength(body), run = runId, tag = '-' } = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return `${command} ${run} ${releaseSha} ${digest(body)} ${bytes} ${tag} ${issuedAt} ${issuedAt + 300} canary-primary ${signature}`;
}

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-dispatch-'));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function input(value) {
  return Readable.from([Buffer.from(value)]);
}

test('forced-command grammar remains strict', () => {
  const command = signedCommand('upload');
  const parsed = parseCommand(command);
  assert.equal(parsed.command, 'upload');
  assert.equal(parsed.bytes, 4);
  assert.equal(parsed.digest, digest('data'));
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4`), /rejected/);
  assert.throws(() => parseCommand(command.replace(' 4 - ', ' 0 - ')), /rejected/);
  assert.throws(() => parseCommand(`${command} extra`), /rejected/);
  assert.throws(() => parseCommand(`${command}\nrollback`), /rejected/);
});

test('all transport commands require the exact ten-token signed authorization grammar', () => {
  const digest = 'b'.repeat(64);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const signedCommand = `verify ${runId} ${releaseSha} ${digest} 4096 - ${issuedAt} ${expiresAt} canary-primary ${signature}`;
  assert.deepEqual(parseCommand(signedCommand), {
    command: 'verify', runId, releaseSha, digest, bytes: 4096, tag: '-', issuedAt, expiresAt,
    keyId: 'canary-primary', signature, signedCommand
  });
  assert.throws(() => parseCommand(`verify ${runId} ${releaseSha} ${digest}`), /rejected/);
  assert.throws(() => parseCommand(signedCommand.replace('canary-primary', 'production-primary')), /rejected/);
});

test('signed upload authorization completes before the first staged write', async () => {
  const calls = [];
  const command = signedCommand('upload');
  const status = await dispatch({
    originalCommand: command,
    runControllerImpl: async (parsed) => { calls.push(`authorize:${parsed.command}`); return 0; },
    performUploadImpl: async (parsed) => { calls.push(`write:${parsed.digest}`); return { received: parsed.bytes, idempotent: false }; },
    input: input('data')
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [`authorize:upload`, `write:${digest('data')}`]);

  calls.length = 0;
  assert.equal(await dispatch({
    originalCommand: command,
    runControllerImpl: async () => { calls.push('authorize:rejected'); return 65; },
    performUploadImpl: async () => { calls.push('write'); }
  }), 65);
  assert.deepEqual(calls, ['authorize:rejected']);
});

test('non-upload controller failures propagate through the forced-command dispatcher', async () => {
  const command = signedCommand('verify');
  let observed;
  const status = await dispatch({
    originalCommand: command,
    runControllerImpl: async (parsed) => {
      observed = parsed.signedCommand;
      return 42;
    }
  });
  assert.equal(observed, command);
  assert.equal(status, 42);
});

test('upload publishes with no-overwrite hard link and removes only its unique partial', async () => fixture(async (root) => {
  const first = await performUpload({ stageRoot: root, runId, releaseSha, digest: digest('first'), bytes: 5, input: input('first') });
  assert.equal(first.idempotent, false);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
  const entries = await fs.readdir(path.dirname(first.archivePath));
  assert.deepEqual(entries, [`skyjo-runtime-${releaseSha}.tar.gz`]);

  const replay = await performUpload({ stageRoot: root, runId, releaseSha, digest: digest('first'), bytes: 5, input: input('other') });
  assert.equal(replay.idempotent, true);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first', 'same-size replay must never overwrite completed content');
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('tiny'), bytes: 4, input: input('tiny') }),
    /conflicts with the declared size/
  );
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
}));

test('first upload tolerates only EACCES for the verified 1731 stage parent', async () => fixture(async (root) => {
  await fs.chmod(root, 0o1731);
  const stageRootStat = await fs.lstat(root);
  const body = 'first-authorized-upload';
  let parentSyncAttempts = 0;
  const result = await performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    digest: digest(body),
    bytes: Buffer.byteLength(body),
    input: input(body),
    enforceStageRootContract: true,
    expectedStageRootUid: stageRootStat.uid,
    expectedStageRootGid: stageRootStat.gid,
    stageRootFsync: async () => {
      parentSyncAttempts += 1;
      throw Object.assign(new Error('non-enumerable parent cannot be opened for read'), { code: 'EACCES' });
    }
  });
  assert.equal(result.idempotent, false, 'the clean first attempt must publish rather than rely on retry');
  assert.equal(parentSyncAttempts, 1);
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), body);
  assert.equal(digest(await fs.readFile(result.archivePath)), digest(body));

  const rejected = [
    { run: '124-1-canary', enforce: false, code: 'EACCES' },
    { run: '125-1-canary', enforce: true, code: 'EIO' }
  ];
  for (const scenario of rejected) {
    await assert.rejects(performUpload({
      stageRoot: root,
      runId: scenario.run,
      releaseSha,
      digest: digest(body),
      bytes: Buffer.byteLength(body),
      input: input(body),
      enforceStageRootContract: scenario.enforce,
      expectedStageRootUid: stageRootStat.uid,
      expectedStageRootGid: stageRootStat.gid,
      stageRootFsync: async () => { throw Object.assign(new Error(`injected ${scenario.code}`), { code: scenario.code }); }
    }), (error) => error.code === scenario.code);
    await assert.rejects(fs.lstat(path.join(root, scenario.run)), (error) => error.code === 'ENOENT');
  }
}));

test('a concurrent upload fails nonblocking while the lock owner completes intact', async () => fixture(async (root) => {
  let releaseInput;
  let firstChunkRead;
  const gate = new Promise((resolve) => { releaseInput = resolve; });
  const started = new Promise((resolve) => { firstChunkRead = resolve; });
  async function* slowInput() {
    firstChunkRead();
    yield Buffer.from('ab');
    await gate;
    yield Buffer.from('cd');
  }
  const first = performUpload({ stageRoot: root, runId, releaseSha, digest: digest('abcd'), bytes: 4, input: slowInput() });
  await started;
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('evil'), bytes: 4, input: input('evil') }),
    (error) => error.exitCode === 75 && /already active/.test(error.message)
  );
  releaseInput();
  const result = await first;
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), 'abcd');
  assert.deepEqual(await fs.readdir(path.dirname(result.archivePath)), [`skyjo-runtime-${releaseSha}.tar.gz`]);
}));

test('failed or short streams leave no completed archive, partial, or lock', async () => fixture(async (root) => {
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('short!'), bytes: 6, input: input('short') }),
    /did not match declared size/
  );
  assert.deepEqual(await fs.readdir(path.join(root, runId)), []);
}));

test('upload never publishes bytes outside the signed digest and rejects corrupted retries', async () => fixture(async (root) => {
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('approved'), bytes: 4, input: input('evil') }),
    /approved digest/
  );
  assert.deepEqual(await fs.readdir(path.join(root, runId)), []);

  const first = await performUpload({ stageRoot: root, runId, releaseSha, digest: digest('good'), bytes: 4, input: input('good') });
  await fs.writeFile(first.archivePath, 'evil');
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('good'), bytes: 4, input: input('good') }),
    /approved digest/
  );
}));

test('only a proven dead stale owner can be reclaimed and live ownership is never unlinked', async () => fixture(async (root) => {
  const stage = path.join(root, runId);
  await fs.mkdir(stage);
  const release = await acquireUploadLock(stage, { now: 1_000 });
  await assert.rejects(acquireUploadLock(stage, { now: 1_000 + UPLOAD_LOCK_STALE_MS + 1, isProcessAlive: () => true }), /already active/);
  await release();

  const lock = path.join(stage, '.upload.lock');
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: 999_999, token: 'b'.repeat(32), createdAt: 1_000 })}\n`);
  const releaseReclaimed = await acquireUploadLock(stage, {
    now: 1_000 + UPLOAD_LOCK_STALE_MS + 1,
    isProcessAlive: () => false
  });
  await releaseReclaimed();
  assert.deepEqual(await fs.readdir(stage), []);
}));

test('unsafe lock objects are rejected without following or removing them', { skip: process.platform === 'win32' }, async () => fixture(async (root) => {
  const stage = path.join(root, runId);
  const outside = path.join(root, 'outside');
  await fs.mkdir(stage);
  await fs.mkdir(outside);
  const owner = path.join(outside, 'owner.json');
  await fs.writeFile(owner, `${JSON.stringify({ pid: 999_999, token: 'c'.repeat(32), createdAt: 1_000 })}\n`);
  await fs.symlink(outside, path.join(stage, '.upload.lock'), 'dir');
  await assert.rejects(acquireUploadLock(stage, {
    now: 1_000 + UPLOAD_LOCK_STALE_MS + 1,
    isProcessAlive: () => false
  }), /already active/);
  assert.equal(await fs.readFile(owner, 'utf8'), `${JSON.stringify({ pid: 999_999, token: 'c'.repeat(32), createdAt: 1_000 })}\n`);
}));

test('abandoned-partial cleanup is bounded and refuses an unbounded stage', async () => fixture(async (root) => {
  const stage = path.join(root, runId);
  await fs.mkdir(stage);
  for (let index = 0; index <= MAX_PARTIALS_CLEANED_PER_UPLOAD; index += 1) {
    await fs.writeFile(path.join(stage, `.upload-${releaseSha}-${index + 1}-${String(index).padStart(32, '0')}.part`), 'x');
  }
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, digest: digest('x'), bytes: 1, input: input('x') }),
    /too many abandoned uploads/
  );
  assert.equal((await fs.readdir(stage)).filter((name) => name.endsWith('.part')).length, MAX_PARTIALS_CLEANED_PER_UPLOAD + 1);
}));
