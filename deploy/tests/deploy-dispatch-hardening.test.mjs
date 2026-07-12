import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  acquireUploadLock,
  MAX_PARTIALS_CLEANED_PER_UPLOAD,
  parseCommand,
  performUpload,
  UPLOAD_LOCK_STALE_MS
} from '../skyjo-deploy-dispatch.mjs';

const releaseSha = 'a'.repeat(40);
const runId = '123-1-canary';

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
  assert.deepEqual(parseCommand(`upload ${runId} ${releaseSha} 4`), { command: 'upload', runId, releaseSha, bytes: 4 });
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 0`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4 extra`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4\nrollback`), /rejected/);
});

test('upload publishes with no-overwrite hard link and removes only its unique partial', async () => fixture(async (root) => {
  const first = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 5, input: input('first') });
  assert.equal(first.idempotent, false);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
  const entries = await fs.readdir(path.dirname(first.archivePath));
  assert.deepEqual(entries, [`skyjo-runtime-${releaseSha}.tar.gz`]);

  const replay = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 5, input: input('other') });
  assert.equal(replay.idempotent, true);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first', 'same-size replay must never overwrite completed content');
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('tiny') }),
    /conflicts with the declared size/
  );
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
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
  const first = performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: slowInput() });
  await started;
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('evil') }),
    (error) => error.exitCode === 75 && /already active/.test(error.message)
  );
  releaseInput();
  const result = await first;
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), 'abcd');
  assert.deepEqual(await fs.readdir(path.dirname(result.archivePath)), [`skyjo-runtime-${releaseSha}.tar.gz`]);
}));

test('failed or short streams leave no completed archive, partial, or lock', async () => fixture(async (root) => {
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 6, input: input('short') }),
    /did not match declared size/
  );
  assert.deepEqual(await fs.readdir(path.join(root, runId)), []);
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
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 1, input: input('x') }),
    /too many abandoned uploads/
  );
  assert.equal((await fs.readdir(stage)).filter((name) => name.endsWith('.part')).length, MAX_PARTIALS_CLEANED_PER_UPLOAD + 1);
}));
