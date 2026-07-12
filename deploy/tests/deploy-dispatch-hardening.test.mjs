import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ADMISSION_LOCK_NAME,
  ADMISSION_MARKER,
  acquireAdmissionLock,
  admissionLockLocationForStage,
  admittedDirectoryCountFromLinkCount,
  DEFAULT_STAGE_ROOT,
  MAX_PARTIALS_CLEANED_PER_UPLOAD,
  MAX_STAGED_RUNS,
  parseCommand,
  performUpload,
  UPLOAD_INPUT_TIMEOUT_MS
} from '../skyjo-deploy-dispatch.mjs';

const releaseSha = 'a'.repeat(40);
const runId = '123-1-canary';
const admissionChild = fileURLToPath(new URL('./fixtures/admission-upload-child.mjs', import.meta.url));
const dispatcherPath = fileURLToPath(new URL('../skyjo-deploy-dispatch.mjs', import.meta.url));

async function prepareStageRoot(root) {
  if (process.platform !== 'win32') await fs.chmod(root, 0o700);
  const admissionLock = path.join(root, ADMISSION_LOCK_NAME);
  await fs.writeFile(admissionLock, '', { mode: 0o640, flag: 'wx' });
  if (process.platform !== 'win32') {
    await fs.chmod(admissionLock, 0o640);
    assert.equal((await fs.lstat(admissionLock)).mode & 0o777, 0o640);
  }
  return root;
}

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-dispatch-'));
  try {
    await prepareStageRoot(root);
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

async function stagedRunCount(root) {
  return (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
}

async function acquireTestAdmission(root, options = {}) {
  const [rootStat, lockStat] = await Promise.all([
    fs.lstat(root),
    fs.lstat(path.join(root, ADMISSION_LOCK_NAME))
  ]);
  return acquireAdmissionLock(root, {
    stageRootContract: { uid: rootStat.uid, gid: rootStat.gid, mode: rootStat.mode & 0o7777 },
    lockPath: path.join(root, ADMISSION_LOCK_NAME),
    lockParentContract: { uid: rootStat.uid, gid: rootStat.gid, mode: rootStat.mode & 0o7777 },
    lockContract: { uid: lockStat.uid, gid: lockStat.gid, mode: 0o640 },
    ...options
  });
}

function spawnAdmissionChild(args) {
  const child = spawn(process.execPath, [admissionChild, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    // `exit` can precede the final pipe data event. `close` is emitted only
    // after the child and all stdio handles close, so collected evidence is complete.
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test('forced-command grammar remains strict', () => {
  assert.deepEqual(parseCommand(`upload ${runId} ${releaseSha} 4`), { command: 'upload', runId, releaseSha, bytes: 4 });
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 0`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4 extra`), /rejected/);
  assert.throws(() => parseCommand(`upload ${runId} ${releaseSha} 4\nrollback`), /rejected/);
});

test('the forced upload path acquires one inherited FD before reservation and has no pathname owner lock', async () => {
  const source = await fs.readFile(dispatcherPath, 'utf8');
  const performStart = source.indexOf('export async function performUpload');
  const performEnd = source.indexOf('\nasync function runController', performStart);
  const performSource = source.slice(performStart, performEnd);
  assert.equal((performSource.match(/acquireAdmissionLock\(/g) || []).length, 1);
  assert.ok(performSource.indexOf('const admission = await acquireAdmissionLock') < performSource.indexOf('await reserveRunDirectory'));
  assert.doesNotMatch(source, /acquireUploadLock|UPLOAD_LOCK_STALE_MS|owner\.json|\.upload\.lock|releaseUnlink|releaseRmdir/);
  assert.match(performSource, /await admission\.assertHeld\(\);[\s\S]*receiveExactly[\s\S]*await admission\.assertHeld\(\);/);

  const cleanupStart = source.indexOf('async function removeEmptyCreatedRun');
  const cleanupEnd = source.indexOf('\nasync function reserveExistingRun', cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupSource, /typeof options\.assertAdmissionHeld !== 'function'/);
  assert.ok((cleanupSource.match(/await assertExpectedRun\(\);/g) || []).length >= 3);
});

test('only the exact Linux production stage selects the external admission lock', () => {
  assert.deepEqual(admissionLockLocationForStage(DEFAULT_STAGE_ROOT, 'linux'), {
    production: true,
    lockPath: '/var/lib/skyjo-deploy/.admission.lock'
  });
  assert.deepEqual(admissionLockLocationForStage(`${DEFAULT_STAGE_ROOT}${path.sep}.`, 'linux'), {
    production: true,
    lockPath: '/var/lib/skyjo-deploy/.admission.lock'
  });
  const custom = path.resolve(os.tmpdir(), 'isolated-stage');
  assert.deepEqual(admissionLockLocationForStage(custom, 'linux'), {
    production: false,
    lockPath: path.join(custom, ADMISSION_LOCK_NAME)
  });
  assert.deepEqual(admissionLockLocationForStage(DEFAULT_STAGE_ROOT, 'win32'), {
    production: false,
    lockPath: path.join(DEFAULT_STAGE_ROOT, ADMISSION_LOCK_NAME)
  });
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

test('the inherited admission FD permits at most one concurrent archive publisher', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
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

test('the inherited admission FD stays held across input and rejects a contender nonblocking', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
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
    (error) => error.exitCode === 75 && /admission is already active/.test(error.message)
  );
  releaseInput();
  const result = await first;
  assert.equal(await fs.readFile(result.archivePath, 'utf8'), 'abcd');
  assert.deepEqual((await fs.readdir(path.dirname(result.archivePath))).sort(), [ADMISSION_MARKER, `skyjo-runtime-${releaseSha}.tar.gz`].sort());
  assert.equal((await fs.readdir(path.dirname(result.archivePath))).some((name) => name.includes('upload.lock')), false);
}));

test('failed or short streams leave no completed archive, partial, or lock', async () => fixture(async (root) => {
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 6, input: input('short') }),
    /did not match declared size/
  );
  await assert.rejects(fs.access(path.join(root, runId)), { code: 'ENOENT' });
}));

test('a stalled upload times out deterministically, releases the admission FD, and remains retryable', async () => fixture(async (root) => {
  let destroyed = false;
  const stalled = {
    destroy() { destroyed = true; },
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); }
  };
  await assert.rejects(performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 1,
    input: stalled,
    uploadInputTimeoutMs: 25
  }), (error) => error.exitCode === 75 && error.message === 'Upload input timed out.');
  assert.equal(destroyed, true);
  await assert.rejects(fs.lstat(path.join(root, runId)), (error) => error.code === 'ENOENT');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 1, input: input('x') });
  assert.equal(await fs.readFile(retry.archivePath, 'utf8'), 'x');
  assert.equal(UPLOAD_INPUT_TIMEOUT_MS, 15 * 60 * 1000);
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

test('post-publication admission-FD close failure preserves an admitted retryable archive', async () => fixture(async (root) => {
  let closeCalls = 0;
  await assert.rejects(performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 4,
    input: input('safe'),
    admissionLockOptions: {
      closeLock: async (handle) => {
        closeCalls += 1;
        await handle.close();
        if (closeCalls === 1) throw Object.assign(new Error('injected upload admission-FD close failure'), { code: 'EIO' });
      }
    }
  }), /injected upload admission-FD close failure/);
  const stage = path.join(root, runId);
  assert.equal(await fs.readFile(path.join(stage, ADMISSION_MARKER), 'utf8'), `${runId}\n`);
  assert.equal(await fs.readFile(path.join(stage, `skyjo-runtime-${releaseSha}.tar.gz`), 'utf8'), 'safe');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  assert.equal(retry.idempotent, true);
  assert.equal(closeCalls, 1);
}));

test('admission fsync failure stays isolated while the global FD rejects a same-run contender', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
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
  await assert.rejects(
    performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') }),
    (error) => error.exitCode === 75 && /admission is already active/i.test(error.message)
  );
  releaseParentSync();
  await assert.rejects(creator, /injected admission parent fsync failure/i);
  await assert.rejects(fs.lstat(path.join(root, runId)), (error) => error.code === 'ENOENT');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  assert.equal(await fs.readFile(retry.archivePath, 'utf8'), 'safe');
}));

test('same-run upload starting during cleanup cannot bypass the held global admission FD', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
  const stage = path.join(root, runId);
  let parentSyncCalls = 0;
  let cleanupReadCalls = 0;
  const creator = performUpload({
    stageRoot: root,
    runId,
    releaseSha,
    bytes: 4,
    input: input('lost'),
    stageRootFsync: async () => {
      parentSyncCalls += 1;
      if (parentSyncCalls === 1) {
        throw Object.assign(new Error('injected admission parent fsync failure'), { code: 'EIO' });
      }
    },
    afterCleanupDirectoryRead: async () => {
      cleanupReadCalls += 1;
      assert.equal(await fs.readFile(path.join(stage, ADMISSION_MARKER), 'utf8'), `${runId}\n`);
      await assert.rejects(
        performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('race') }),
        (error) => error.exitCode === 75 && /admission is already active/i.test(error.message)
      );
      assert.equal(await fs.readFile(path.join(stage, ADMISSION_MARKER), 'utf8'), `${runId}\n`);
    }
  });
  await assert.rejects(creator, /injected admission parent fsync failure/);
  assert.equal(cleanupReadCalls, 1);
  await assert.rejects(fs.lstat(stage), (error) => error.code === 'ENOENT');
  const retry = await performUpload({ stageRoot: root, runId, releaseSha, bytes: 4, input: input('safe') });
  assert.equal(await fs.readFile(retry.archivePath, 'utf8'), 'safe');
}));

test('a post-rmdir staging-parent fsync failure never recreates the removed run', async () => fixture(async (root) => {
  const failedRunId = '784-1-canary';
  const stage = path.join(root, failedRunId);
  let parentSyncCalls = 0;
  await assert.rejects(performUpload({
    stageRoot: root,
    runId: failedRunId,
    releaseSha,
    bytes: 2,
    input: input('x'),
    stageRootFsync: async () => {
      parentSyncCalls += 1;
      if (parentSyncCalls === 2) {
        throw Object.assign(new Error('injected post-rmdir parent fsync failure'), { code: 'EIO' });
      }
    }
  }), /could not be removed|post-rmdir parent fsync failure/i);
  assert.equal(parentSyncCalls, 2);
  await assert.rejects(fs.lstat(stage), (error) => error.code === 'ENOENT');
  const retry = await performUpload({ stageRoot: root, runId: failedRunId, releaseSha, bytes: 1, input: input('x') });
  assert.equal(await fs.readFile(retry.archivePath, 'utf8'), 'x');
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
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause?.code, 'EIO');
    assert.deepEqual(error.errors.map((entry) => entry.code), ['EIO', 'EIO']);
    return true;
  });
  await assert.rejects(fs.lstat(path.join(root, '124-1-canary')), (error) => error.code === 'ENOENT');
}));

test('directory link-count admission rejects anomalous filesystems', () => {
  assert.equal(admittedDirectoryCountFromLinkCount(2), 0);
  assert.equal(admittedDirectoryCountFromLinkCount(34), 32);
  assert.throws(() => admittedDirectoryCountFromLinkCount(1), /link-count admission/i);
});

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
  assert.equal(await stagedRunCount(root), MAX_STAGED_RUNS);
}));

test('an unadmitted same-run contender cannot bypass a full quota', { skip: process.platform === 'win32' }, async () => fixture(async (root) => {
  for (let index = 0; index < MAX_STAGED_RUNS; index += 1) await admitRun(root, `${index + 1}-1-canary`);
  const contested = `${MAX_STAGED_RUNS + 1}-1-canary`;
  const attempts = await Promise.allSettled([
    performUpload({ stageRoot: root, runId: contested, releaseSha, bytes: 1, input: input('a') }),
    performUpload({ stageRoot: root, runId: contested, releaseSha, bytes: 1, input: input('b') })
  ]);
  assert.equal(attempts.every((attempt) => attempt.status === 'rejected'), true);
  assert.equal(await stagedRunCount(root), MAX_STAGED_RUNS);
  await assert.rejects(fs.lstat(path.join(root, contested)), (error) => error.code === 'ENOENT');
}));

test('thirty 64-way bursts always retain at least one and at most 32 durable admissions', {
  skip: process.platform === 'win32',
  timeout: 120_000
}, async () => fixture(async (root) => {
  for (let round = 0; round < 30; round += 1) {
    const roundRoot = path.join(root, `round-${round}`);
    await fs.mkdir(roundRoot, { mode: 0o700 });
    await prepareStageRoot(roundRoot);
    const attempts = await Promise.allSettled(Array.from({ length: 64 }, (_, index) => performUpload({
      stageRoot: roundRoot,
      runId: `${1000 + index}-1-canary`,
      releaseSha,
      bytes: 1,
      input: input('x')
    })));
    const admitted = attempts.filter((attempt) => attempt.status === 'fulfilled');
    assert.ok(admitted.length > 0 && admitted.length <= MAX_STAGED_RUNS, `round ${round} admitted ${admitted.length}`);
    assert.ok(await stagedRunCount(roundRoot) <= MAX_STAGED_RUNS);
    const retry = await performUpload({
      stageRoot: roundRoot,
      runId: path.basename(path.dirname(admitted[0].value.archivePath)),
      releaseSha,
      bytes: 1,
      input: input('x')
    });
    assert.equal(retry.idempotent, true);
  }
}));

test('a 64-process barrier schedule that previously produced zero winners now admits exactly one', {
  skip: process.platform !== 'linux',
  timeout: 120_000
}, async () => fixture(async (root) => {
  const gateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-admission-barrier-'));
  const releasePath = path.join(gateRoot, 'release');
  const settled = new Set();
  let workers = [];
  try {
    workers = Array.from({ length: 64 }, (_, index) => {
      const readyPath = path.join(gateRoot, `${index}.ready`);
      const worker = spawnAdmissionChild([root, `${2000 + index}-1-canary`, releaseSha, readyPath, releasePath]);
      worker.result = worker.done.finally(() => { settled.add(index); });
      return worker;
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ready = new Set((await fs.readdir(gateRoot)).filter((name) => name.endsWith('.ready')).map((name) => Number(name.split('.')[0])));
      const accounted = new Set([...ready, ...settled]);
      if (accounted.size === workers.length) break;
      await delay(10);
    }
    const finalReady = new Set((await fs.readdir(gateRoot)).filter((name) => name.endsWith('.ready')).map((name) => Number(name.split('.')[0])));
    assert.equal(new Set([...finalReady, ...settled]).size, 64, 'all children must reach the barrier or fail nonblocking before release');
    await fs.writeFile(releasePath, 'release\n', { flag: 'wx', mode: 0o600 });
    const results = await Promise.all(workers.map((worker) => worker.result));
    assert.equal(results.filter((result) => result.code === 0).length, 1);
    assert.equal(results.every((result) => result.code === 0 || result.code === 75), true);
    for (const result of results.filter((entry) => entry.code === 75)) {
      assert.deepEqual(JSON.parse(result.stderr), {
        ok: false,
        message: 'Another deployment admission is already active.',
        exitCode: 75
      });
    }
    assert.equal(await stagedRunCount(root), 1);
  } finally {
    await fs.writeFile(releasePath, 'release\n', { flag: 'a' }).catch(() => {});
    await Promise.race([
      Promise.allSettled(workers.map((worker) => worker.result)),
      delay(5_000)
    ]);
    for (const [index, worker] of workers.entries()) {
      if (!settled.has(index)) worker.child.kill('SIGKILL');
    }
    await Promise.race([
      Promise.allSettled(workers.map((worker) => worker.done)),
      delay(5_000)
    ]);
    await fs.rm(gateRoot, { recursive: true, force: true });
  }
}));

test('SIGKILL releases the inherited admission flock without stale-owner recovery', {
  skip: process.platform !== 'linux',
  timeout: 60_000
}, async () => fixture(async (root) => {
  const gateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-admission-crash-'));
  let holder;
  let holderSettled = false;
  try {
    const readyPath = path.join(gateRoot, 'holder.ready');
    const releasePath = path.join(gateRoot, 'never-release');
    holder = spawnAdmissionChild([root, '3000-1-canary', releaseSha, readyPath, releasePath]);
    holder.done.finally(() => { holderSettled = true; });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { await fs.access(readyPath); break; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await delay(10);
    }
    await fs.access(readyPath);
    holder.child.kill('SIGKILL');
    const killed = await holder.done;
    assert.equal(killed.signal, 'SIGKILL');
    const recovered = await performUpload({
      stageRoot: root,
      runId: '3001-1-canary',
      releaseSha,
      bytes: 1,
      input: input('x')
    });
    assert.equal(await fs.readFile(recovered.archivePath, 'utf8'), 'x');
  } finally {
    if (holder && !holderSettled) holder.child.kill('SIGKILL');
    if (holder) await Promise.race([holder.done.catch(() => {}), delay(5_000)]);
    await fs.rm(gateRoot, { recursive: true, force: true });
  }
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

test('stale top-level cleanup never bypasses a busy admission lock', { skip: process.platform !== 'linux' }, async () => fixture(async (root) => {
  const staleRun = '778-1-canary';
  const stale = path.join(root, staleRun);
  await fs.mkdir(stale, { mode: 0o700 });
  const old = new Date(Date.now() - 16 * 60 * 1000);
  await fs.utimes(stale, old, old);
  const holder = await acquireTestAdmission(root);
  await assert.rejects(
    performUpload({ stageRoot: root, runId: staleRun, releaseSha, bytes: 1, input: input('x') }),
    (error) => error.exitCode === 75 && /admission is already active/.test(error.message)
  );
  assert.equal((await fs.lstat(stale)).isDirectory(), true);
  await holder.release();
  await assert.rejects(
    performUpload({ stageRoot: root, runId: staleRun, releaseSha, bytes: 1, input: input('x') }),
    /admission is incomplete/i
  );
  await assert.rejects(fs.lstat(stale), (error) => error.code === 'ENOENT');
}));

test('post-upload failure cleans the admitted run before releasing its held global lock', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
  let inputStarted;
  let releaseInput;
  const started = new Promise((resolve) => { inputStarted = resolve; });
  const gate = new Promise((resolve) => { releaseInput = resolve; });
  async function* shortInput() {
    inputStarted();
    await gate;
    yield Buffer.from('x');
  }
  const failed = performUpload({ stageRoot: root, runId: '779-1-canary', releaseSha, bytes: 2, input: shortInput() });
  await started;
  await assert.rejects(
    acquireTestAdmission(root),
    (error) => error.exitCode === 75 && /admission is already active/.test(error.message)
  );
  releaseInput();
  await assert.rejects(failed, /did not match declared size/);
  const stage = path.join(root, '779-1-canary');
  await assert.rejects(fs.lstat(stage), (error) => error.code === 'ENOENT');
  const holder = await acquireTestAdmission(root);
  await holder.release();
  const retry = await performUpload({ stageRoot: root, runId: '779-1-canary', releaseSha, bytes: 1, input: input('x') });
  assert.equal(await fs.readFile(retry.archivePath, 'utf8'), 'x');
}));
