import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupRun,
  executeWithRequiredRunCleanup,
  proveClaimedRunDirectory
} from '../release-controller.mjs';

async function fixture(callback) {
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-run-cleanup-'));
  const runId = '123-1-canary';
  const workDirectory = path.join(stageRoot, runId);
  await fs.mkdir(path.join(workDirectory, 'release'), { recursive: true });
  await fs.writeFile(path.join(workDirectory, 'artifact.tar.gz'), 'artifact');
  const stat = await fs.lstat(workDirectory);
  const expectedIdentity = {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777
  };
  try {
    await callback({ stageRoot, runId, workDirectory, expectedIdentity });
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

function cleanupWithin(stageRoot, runId, workDirectory, expectedIdentity) {
  return () => cleanupRun(runId, workDirectory, { stageRoot, expectedIdentity });
}

test('a successful verify-style action removes the entire deployment run', async () => fixture(async ({ stageRoot, runId, workDirectory, expectedIdentity }) => {
  const result = await executeWithRequiredRunCleanup({
    cleanup: cleanupWithin(stageRoot, runId, workDirectory, expectedIdentity),
    action: async () => {
      await fs.mkdir(path.join(workDirectory, 'snapshot'));
      await fs.writeFile(path.join(workDirectory, 'snapshot', 'manifest.json'), '{}');
      return { verified: 'a'.repeat(40), activated: false };
    }
  });
  assert.deepEqual(result, { verified: 'a'.repeat(40), activated: false });
  await assert.rejects(fs.lstat(workDirectory), (error) => error.code === 'ENOENT');
}));

test('post-claim archive validation failures remain primary and remove the exact run', async () => fixture(async ({ stageRoot, runId, workDirectory, expectedIdentity }) => {
  const primary = new Error('injected archive allowlist failure');
  await assert.rejects(executeWithRequiredRunCleanup({
    cleanup: cleanupWithin(stageRoot, runId, workDirectory, expectedIdentity),
    action: async () => { throw primary; }
  }), (error) => error === primary);
  await assert.rejects(fs.lstat(workDirectory), (error) => error.code === 'ENOENT');
}));

test('successful post-claim preparation retains its run for the outer action cleanup', async () => fixture(async ({ workDirectory }) => {
  let cleanupCalls = 0;
  const result = await executeWithRequiredRunCleanup({
    cleanupOnSuccess: false,
    cleanup: async () => { cleanupCalls += 1; },
    action: async () => ({ candidate: path.join(workDirectory, 'release') })
  });
  assert.deepEqual(result, { candidate: path.join(workDirectory, 'release') });
  assert.equal(cleanupCalls, 0);
  assert.equal((await fs.lstat(workDirectory)).isDirectory(), true);
}));

test('a substituted post-claim run never reaches recursive removal', async () => fixture(async ({ stageRoot, runId, workDirectory, expectedIdentity }) => {
  let removeCalls = 0;
  const driftedIdentity = { ...expectedIdentity, ino: expectedIdentity.ino + 4096 };
  await assert.rejects(cleanupRun(runId, workDirectory, {
    stageRoot,
    expectedIdentity: driftedIdentity,
    remove: async () => { removeCalls += 1; }
  }), /ino changed before cleanup/);
  assert.equal(removeCalls, 0);
  assert.equal((await fs.lstat(workDirectory)).isDirectory(), true);
}));

test('post-claim preparation and identity-safe cleanup failures preserve both errors', async () => fixture(async ({ stageRoot, runId, workDirectory, expectedIdentity }) => {
  const primary = new Error('injected candidate materialization failure');
  const driftedIdentity = { ...expectedIdentity, dev: expectedIdentity.dev + 1 };
  await assert.rejects(executeWithRequiredRunCleanup({
    action: async () => { throw primary; },
    cleanup: () => cleanupRun(runId, workDirectory, { stageRoot, expectedIdentity: driftedIdentity })
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.deploymentActionError, primary);
    assert.equal(error.deploymentCleanupError, error.runCleanupError);
    assert.match(error.deploymentCleanupError.message, /dev changed before cleanup/);
    return true;
  });
  assert.equal((await fs.lstat(workDirectory)).isDirectory(), true);
}));

test('claimed run proof binds the no-follow handle to the exact path identity', async () => {
  const stat = {
    dev: 11,
    ino: 22,
    uid: 0,
    gid: 0,
    mode: 0o040711,
    isDirectory: () => true,
    isSymbolicLink: () => false
  };
  let closed = 0;
  const identity = await proveClaimedRunDirectory('/safe/run', {
    openFile: async () => ({ stat: async () => stat, close: async () => { closed += 1; } }),
    inspect: async () => ({ ...stat }),
    requireRootOwnership: true
  });
  assert.deepEqual(identity, { dev: 11, ino: 22, uid: 0, gid: 0, mode: 0o711 });
  assert.equal(closed, 1);

  await assert.rejects(proveClaimedRunDirectory('/replaced/run', {
    openFile: async () => ({ stat: async () => stat, close: async () => {} }),
    inspect: async () => ({ ...stat, ino: 23 }),
    requireRootOwnership: true
  }), /identity is unsafe/);
});

test('cleanup failures aggregate visibly without losing action recovery or uncertainty flags', async () => fixture(async () => {
  const primary = new Error('injected action failure');
  Object.defineProperty(primary, 'deploymentStatus', { value: 'rollback-failed', enumerable: true });
  Object.defineProperty(primary, 'linkMayHaveChanged', { value: true, enumerable: true });
  Object.defineProperty(primary, 'activationRolledBack', { value: false, enumerable: false });
  const cleanup = new Error('injected cleanup failure');
  await assert.rejects(executeWithRequiredRunCleanup({
    action: async () => { throw primary; },
    cleanup: async () => { throw cleanup; }
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.deploymentActionError, primary);
    assert.equal(error.deploymentCleanupError, cleanup);
    assert.equal(error.runCleanupError, cleanup);
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.linkMayHaveChanged, true);
    assert.equal(error.activationRolledBack, false);
    return true;
  });
}));

test('cleanup proves ENOENT after removal and rejects visible residue or path drift', async () => fixture(async ({ stageRoot, runId, workDirectory, expectedIdentity }) => {
  let removeCalls = 0;
  let inspectCalls = 0;
  await assert.rejects(cleanupRun(runId, workDirectory, {
    stageRoot,
    expectedIdentity,
    remove: async () => { removeCalls += 1; },
    inspect: async () => {
      inspectCalls += 1;
      return inspectCalls === 1
        ? await fs.lstat(workDirectory)
        : { isDirectory: () => true };
    }
  }), /remains after cleanup/);
  assert.equal(removeCalls, 1);

  await assert.rejects(cleanupRun(runId, path.join(stageRoot, 'different-run'), {
    stageRoot,
    remove: async () => assert.fail('unexpected path reached removal')
  }), /unexpected deployment path/);
}));
