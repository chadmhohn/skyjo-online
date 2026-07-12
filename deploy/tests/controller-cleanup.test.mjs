import assert from 'node:assert/strict';
import test from 'node:test';
import { executeWithRequiredRunCleanup } from '../release-controller.mjs';
import { MAX_STAGED_RUNS } from '../skyjo-deploy-dispatch.mjs';

test('successful actions never report success when run-root cleanup fails', async () => {
  for (let attempt = 0; attempt < MAX_STAGED_RUNS + 1; attempt += 1) {
    const cleanupError = new Error(`cleanup failed ${attempt}`);
    await assert.rejects(executeWithRequiredRunCleanup({
      action: async () => ({ verified: true }),
      cleanup: async () => { throw cleanupError; }
    }), (error) => error === cleanupError);
  }
});

test('run-root cleanup failure is visible without losing the primary deployment state', async () => {
  const primary = new Error('candidate failed');
  Object.defineProperty(primary, 'renameMayHaveCommitted', { value: true, enumerable: true });
  const cleanup = new Error('run root remained');
  await assert.rejects(executeWithRequiredRunCleanup({
    action: async () => { throw primary; },
    cleanup: async () => { throw cleanup; }
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.equal(error.deploymentActionError, primary);
    assert.equal(error.deploymentCleanupError, cleanup);
    assert.equal(error.runCleanupError, cleanup);
    assert.equal(error.renameMayHaveCommitted, true);
    return true;
  });
});

test('a failed canary stop preserves its live run root for incident recovery', async () => {
  const primary = new Error('canary server did not stop');
  Object.defineProperty(primary, 'preserveRunRoot', { value: true });
  let cleanupCalled = false;
  await assert.rejects(executeWithRequiredRunCleanup({
    action: async () => { throw primary; },
    cleanup: async () => { cleanupCalled = true; }
  }), (error) => error === primary);
  assert.equal(cleanupCalled, false);
});
