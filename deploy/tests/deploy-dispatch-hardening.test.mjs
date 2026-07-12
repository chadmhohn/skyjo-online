import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  ADMISSION_MARKER,
  acquireUploadLock,
  admittedDirectoryCountFromLinkCount,
  MAX_PARTIALS_CLEANED_PER_UPLOAD,
  MAX_STAGED_RUNS,
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

async function admitRun(root, admittedRunId) {
  const stage = path.join(root, admittedRunId);
  await fs.mkdir(stage, { mode: 0o700 });
  await fs.writeFile(path.join(stage, ADMISSION_MARKER), `${admittedRunId}\n`, { mode: 0o400, flag: 'wx' });
  return stage;
}

test('forced-command grammar remains strict', () => {
  assert.deepEqual(parseCommand(`upload ${runId} ${releaseSha} 4`), { command: 'upload', runId, releaseSha, bytes: 4 });
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 0`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4 extra`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4\nrollback`), /rejected/);
});

test('privileged commands require the exact nine-token signed authorization grammar', () => {
  const digest = 'b'.repeat(64);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const signature = 'A'.repeat(86);
  const signedCommand = `verify ${runId} ${releaseSha} ${digest} - ${issuedAt} ${expiresAt} canary-2026-07 ${signature}`;
  assert.deepEqual(parseCommand(signedCommand), {
    command: 'verify', runId, releaseSha, digest, tag: '-', issuedAt, expiresAt,
    keyId: 'canary-2026-07', signature, signedCommand
  });
  assert.throws(() => parseCommand(`verify ${runId} ${releaseSha} ${digest}`), /rejected/);
  assert.throws(() => parseCommand(signedCommand.replace('canary-2026-07', 'production-2026-07')), /rejected/);
});

test('upload publishes with no-overwrite hard link and removes only its unique partial', async () => fixture(async (root) => {
  const first = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 5, input: input('first') });
  assert.equal(first.idempotent, false);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
  const entries = await fs.readdir(path.dirname(first.archivePath));
  assert.deepEqual(entries.sort(), [ADMISSION_MARKER, `skyjo-runtime-${releaseSha}.tar.gz`].sort());

  const replay = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 5, input: input('other') });
  assert.equal(replay.idempotent, true);
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first', 'same-size replay must never overwrite completed content');
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('tiny') }),
    /conflicts with the declared size/
  );
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
}));

test('an admitted run remains bound to its first completed release SHA', async () => fixture(async (root) => {
  const otherSha = 'b'.repeat(40);
  const first = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 5, input: input('first') });
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha: otherSha, bytes: 6, input: input('second') }),
    /already bound to a different release SHA/
  );
  assert.equal(await fs.readFile(first.archivePath, 'utf8'), 'first');
  await assert.rejects(fs.access(path.join(root, runId, `skyjo-runtime-${otherSha}.tar.gz`)), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(root, runId))).sort(), [
    ADMISSION_MARKER,
    `skyjo-runtime-${releaseSha}.tar.gz`
  ].sort());
}));

test('concurrent different-SHA uploads publish at most one archive per admitted run', async () => fixture(async (root) => {
  const otherSha = 'b'.repeat(40);
  await admitRun(root, runId);
  const attempts = await Promise.allSettled([
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('aaaa') }),
    performUpload({ stageRoot: root, runId, releaseSha: otherSha, bytes: 4, input: input('bbbb') })
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  const archiveNames = (await fs.readdir(path.join(root, runId))).filter((name) => /^skyjo-runtime-.*\.tar\.gz$/.test(name));
  assert.equal(archiveNames.length, 1);
  assert.ok([
    `skyjo-runtime-${releaseSha}.tar.gz`,
    `skyjo-runtime-${otherSha}.tar.gz`
  ].includes(archiveNames[0]));
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
  assert.deepEqual((await fs.readdir(path.dirname(result.archivePath))).sort(), [ADMISSION_MARKER, `skyjo-runtime-${releaseSha}.tar.gz`].sort());
}));

test('failed or short streams leave no completed archive, partial, or lock', async () => fixture(async (root) => {
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 6, input: input('short') }),
    /did not match declared size/
  );
  await assert.rejects(fs.access(path.join(root, runId)), { code: 'ENOENT' });
}));

test('a controller-owned interrupted run consumes a fresh upload without mutating staged bytes', async () => fixture(async (root) => {
  const stage = await admitRun(root, runId);
  const archivePath = path.join(stage, `skyjo-runtime-${releaseSha}.tar.gz`);
  await fs.writeFile(archivePath, 'kept', { mode: 0o400 });
  const stat = await fs.lstat(stage);
  await fs.chmod(stage, 0o711);
  const result = await performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 5,
    input: input('fresh'),
    acceptControllerOwnedRun: true,
    controllerRunContract: { uid: stat.uid, gid: stat.gid, modes: [0o700, 0o711] }
  });
  assert.equal(result.controllerOwned, true);
  assert.equal(result.idempotent, true);
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'kept');
}));

test('post-publication lock-release failure preserves an admitted retryable archive', async () => fixture(async (root) => {
  let syncCalls = 0;
  await assert.rejects(performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 4,
    input: input('safe'),
    uploadLockOptions: {
      releaseSyncDirectory: async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw Object.assign(new Error('injected lock-directory fsync failure'), { code: 'EIO' });
      }
    }
  }), (error) => error instanceof AggregateError &&
    error.errors.some((entry) => /lock release|remains retryable/i.test(entry.message)));
  const stage = path.join(root, runId);
  assert.equal(await fs.readFile(path.join(stage, ADMISSION_MARKER), 'utf8'), `${runId}\n`);
  assert.equal(await fs.readFile(path.join(stage, `skyjo-runtime-${releaseSha}.tar.gz`), 'utf8'), 'safe');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  assert.equal(retry.idempotent, true);
}));

test('admission fsync failure never removes a marker after a same-run contender publishes', async () => fixture(async (root) => {
  let reachedParentSync;
  let releaseParentSync;
  const atParentSync = new Promise((resolve) => { reachedParentSync = resolve; });
  const gate = new Promise((resolve) => { releaseParentSync = resolve; });
  const creator = performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 4,
    input: input('lost'),
    stageRootFsync: async () => {
      reachedParentSync();
      await gate;
      throw Object.assign(new Error('injected admission parent fsync failure'), { code: 'EIO' });
    }
  });
  await atParentSync;
  const contender = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  releaseParentSync();
  await assert.rejects(creator, /could not be removed safely/i);
  assert.equal(await fs.readFile(path.join(root, runId, ADMISSION_MARKER), 'utf8'), `${runId}\n`);
  assert.equal(await fs.readFile(contender.archivePath, 'utf8'), 'safe');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  assert.equal(retry.idempotent, true);
}));

test('an exact empty stale release lock is eventually reclaimable', async () => fixture(async (root) => {
  const stage = await admitRun(root, runId);
  const release = await acquireUploadLock(stage, {
    releaseRmdir: async () => { throw Object.assign(new Error('injected rmdir failure'), { code: 'EIO' }); }
  });
  await assert.rejects(release(), /lock release/i);
  const lock = path.join(stage, '.upload.lock');
  assert.deepEqual(await fs.readdir(lock), []);
  const old = new Date(Date.now() - UPLOAD_LOCK_STALE_MS - 1_000);
  await fs.utimes(lock, old, old);
  const reclaimed = await acquireUploadLock(stage, { now: Date.now(), isProcessAlive: () => false });
  await reclaimed();
  assert.deepEqual(await fs.readdir(stage), [ADMISSION_MARKER]);
}));

test('first upload tolerates only EACCES for the verified 1731 stage parent', { skip: process.platform === 'win32' }, async () => fixture(async (root) => {
  await fs.chmod(root, 0o1731);
  const rootStat = await fs.lstat(root);
  let syncAttempts = 0;
  const result = await performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 4,
    input: input('safe'),
    enforceStageRootContract: true,
    expectedStageRootUid: rootStat.uid,
    expectedStageRootGid: rootStat.gid,
    stageRootFsync: async () => {
      syncAttempts += 1;
      throw Object.assign(new Error('parent cannot be opened for read'), { code: 'EACCES' });
    }
  });
  assert.equal(result.idempotent, false);
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), 'safe');
  assert.equal(syncAttempts, 1);

  await assert.rejects(performUpload({
    stageRoot: root,
    runId: '124-1-canary',
    releaseSha,
    bytes: 1,
    input: input('x'),
    enforceStageRootContract: true,
    expectedStageRootUid: rootStat.uid,
    expectedStageRootGid: rootStat.gid,
    stageRootFsync: async () => { throw Object.assign(new Error('disk error'), { code: 'EIO' }); }
  }), (error) => error.code === 'EIO');
  await assert.rejects(fs.lstat(path.join(root, '124-1-canary')), (error) => error.code === 'ENOENT');
}));

test('directory link-count admission rejects anomalous filesystems', () => {
  assert.equal(admittedDirectoryCountFromLinkCount(2), 0);
  assert.equal(admittedDirectoryCountFromLinkCount(34), 32);
  assert.throws(() => admittedDirectoryCountFromLinkCount(1), /link-count admission/i);
});

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
  const stage = await admitRun(root, runId);
  for (let index = 0; index <= MAX_PARTIALS_CLEANED_PER_UPLOAD; index += 1) {
    await fs.writeFile(path.join(stage, `.upload-${releaseSha}-${index + 1}-${String(index).padStart(32, '0')}.part`), 'x');
  }
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 1, input: input('x') }),
    /too many abandoned uploads/
  );
  assert.equal((await fs.readdir(stage)).filter((name) => name.endsWith('.part')).length, MAX_PARTIALS_CLEANED_PER_UPLOAD + 1);
}));

test('global staging quota bounds orphaned archives while existing runs remain retryable', async () => fixture(async (root) => {
  for (let index = 0; index < MAX_STAGED_RUNS; index += 1) {
    await admitRun(root, `${index + 1}-1-canary`);
  }
  await assert.rejects(
    performUpload({ stageRoot: root, runId: `${MAX_STAGED_RUNS + 1}-1-canary`, releaseSha, bytes: 1, input: input('x') }),
    (error) => error.exitCode === 75 && /quota is full/i.test(error.message)
  );
  const existingRun = '1-1-canary';
  const result = await performUpload({ stageRoot: root, runId: existingRun, releaseSha, bytes: 1, input: input('x') });
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), 'x');
  assert.equal((await fs.readdir(root)).length, MAX_STAGED_RUNS);
}));

test('an unadmitted same-run contender cannot bypass a full quota', { skip: process.platform === 'win32' }, async () => fixture(async (root) => {
  for (let index = 0; index < MAX_STAGED_RUNS; index += 1) await admitRun(root, `${index + 1}-1-canary`);
  const contested = `${MAX_STAGED_RUNS + 1}-1-canary`;
  const attempts = await Promise.allSettled([
    performUpload({ stageRoot: root, runId: contested, releaseSha, bytes: 1, input: input('a') }),
    performUpload({ stageRoot: root, runId: contested, releaseSha, bytes: 1, input: input('b') })
  ]);
  assert.equal(attempts.every((attempt) => attempt.status === 'rejected'), true);
  assert.equal((await fs.readdir(root)).length, MAX_STAGED_RUNS);
  await assert.rejects(fs.lstat(path.join(root, contested)), (error) => error.code === 'ENOENT');
}));

test('64 concurrent distinct admissions converge to at most 32 durable run roots', { skip: process.platform === 'win32' }, async () => fixture(async (root) => {
  const attempts = await Promise.allSettled(Array.from({ length: 64 }, (_, index) => performUpload({
    stageRoot: root,
    runId: `${1000 + index}-1-canary`,
    releaseSha,
    bytes: 1,
    input: input('x')
  })));
  const admitted = attempts.filter((attempt) => attempt.status === 'fulfilled');
  assert.ok(admitted.length > 0 && admitted.length <= MAX_STAGED_RUNS);
  assert.ok((await fs.readdir(root)).length <= MAX_STAGED_RUNS);
  const retry = await performUpload({
    stageRoot: root,
    runId: path.basename(path.dirname(admitted[0].value.archivePath)),
    releaseSha,
    bytes: 1,
    input: input('x')
  });
  assert.equal(retry.idempotent, true);
}));

test('stale empty unadmitted runs are reclaimed but never treated as admitted', async () => fixture(async (root) => {
  const staleRun = '777-1-canary';
  const stale = path.join(root, staleRun);
  await fs.mkdir(stale, { mode: 0o700 });
  const old = new Date(Date.now() - 16 * 60 * 1000);
  await fs.utimes(stale, old, old);
  await assert.rejects(
    performUpload({ stageRoot: root, runId: staleRun, releaseSha, bytes: 1, input: input('x') }),
    /admission is incomplete/i
  );
  await assert.rejects(fs.lstat(stale), (error) => error.code === 'ENOENT');
  const retry = await performUpload({ stageRoot: root, runId: staleRun, releaseSha, bytes: 1, input: input('x') });
  assert.equal(retry.idempotent, false);
}));
