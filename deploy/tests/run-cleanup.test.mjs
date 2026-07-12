import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupRun, executeWithRunCleanup } from '../release-controller.mjs';

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

function cleanupWithin(stageRoot) {
  return (runId, workDirectory) => cleanupRun(runId, workDirectory, { stageRoot });
}

test('a successful verify-style action removes the entire deployment run', async () => fixture(async ({ stageRoot, runId, workDirectory }) => {
  const result = await executeWithRunCleanup({
    runId,
    workDirectory,
    cleanup: cleanupWithin(stageRoot),
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
  await assert.rejects(executeWithRunCleanup({
    runId,
    workDirectory,
    cleanup: cleanupWithin(stageRoot),
    action: async () => { throw primary; }
  }), (error) => error === primary);
  await assert.rejects(fs.lstat(workDirectory), (error) => error.code === 'ENOENT');
}));

test('cleanup failures fail closed and cannot mask an action failure', async () => fixture(async ({ runId, workDirectory }) => {
  const primary = new Error('injected action failure');
  const cleanup = new Error('injected cleanup failure');
  await assert.rejects(executeWithRunCleanup({
    runId,
    workDirectory,
    action: async () => { throw primary; },
    cleanup: async () => { throw cleanup; }
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.deploymentActionError, primary);
    assert.equal(error.deploymentCleanupError, cleanup);
    return true;
  });
}));
