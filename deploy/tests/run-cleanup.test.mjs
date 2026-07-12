import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupRun, executeWithRequiredRunCleanup } from '../release-controller.mjs';

async function fixture(callback) {
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-run-cleanup-'));
  const runId = '123-1-canary';
  const workDirectory = path.join(stageRoot, runId);
  await fs.mkdir(path.join(workDirectory, 'release'), { recursive: true });
  await fs.writeFile(path.join(workDirectory, 'artifact.tar.gz'), 'artifact');
  try {
    await callback({ stageRoot, runId, workDirectory });
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

function cleanupWithin(stageRoot, runId, workDirectory) {
  return () => cleanupRun(runId, workDirectory, { stageRoot });
}

test('a successful verify-style action removes the entire deployment run', async () => fixture(async ({ stageRoot, runId, workDirectory }) => {
  const result = await executeWithRequiredRunCleanup({
    cleanup: cleanupWithin(stageRoot, runId, workDirectory),
    action: async () => {
      await fs.mkdir(path.join(workDirectory, 'snapshot'));
      await fs.writeFile(path.join(workDirectory, 'snapshot', 'manifest.json'), '{}');
      return { verified: 'a'.repeat(40), activated: false };
    }
  });
  assert.deepEqual(result, { verified: 'a'.repeat(40), activated: false });
  await assert.rejects(fs.lstat(workDirectory), (error) => error.code === 'ENOENT');
}));

test('action failures remain primary while cleanup still removes all residue', async () => fixture(async ({ stageRoot, runId, workDirectory }) => {
  const primary = new Error('injected action failure');
  await assert.rejects(executeWithRequiredRunCleanup({
    cleanup: cleanupWithin(stageRoot, runId, workDirectory),
    action: async () => { throw primary; }
  }), (error) => error === primary);
  await assert.rejects(fs.lstat(workDirectory), (error) => error.code === 'ENOENT');
}));

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

test('cleanup proves ENOENT after removal and rejects visible residue or path drift', async () => fixture(async ({ stageRoot, runId, workDirectory }) => {
  let removeCalls = 0;
  await assert.rejects(cleanupRun(runId, workDirectory, {
    stageRoot,
    remove: async () => { removeCalls += 1; },
    inspect: async () => ({ isDirectory: () => true })
  }), /remains after cleanup/);
  assert.equal(removeCalls, 1);

  await assert.rejects(cleanupRun(runId, path.join(stageRoot, 'different-run'), {
    stageRoot,
    remove: async () => assert.fail('unexpected path reached removal')
  }), /unexpected deployment path/);
}));
