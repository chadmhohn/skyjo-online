import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCanaryLifecycle } from '../release-controller.mjs';

const executionStages = [
  'prepareEnvironment',
  'startServer',
  'waitUntilReady',
  'runAuthenticatedSmoke',
  'runStateProof',
  'verifySourceSnapshot'
];
const cleanupStages = ['stopServer', 'resetUnits', 'removeEnvironment'];

function operations({ failAt, cleanupFailure } = {}) {
  const calls = [];
  const primary = new Error(`injected ${failAt || 'none'} failure`);
  const cleanup = new Error(`injected ${cleanupFailure || 'none'} cleanup failure`);
  const result = { calls, primary, cleanup };
  for (const name of executionStages) {
    result[name] = async () => {
      calls.push(name);
      if (name === failAt) throw primary;
    };
  }
  for (const name of cleanupStages) {
    result[name] = async () => {
      calls.push(name);
      if (name === cleanupFailure) throw cleanup;
    };
  }
  return result;
}

test('every injected canary failure stops, resets, and removes its environment', async () => {
  for (const failAt of executionStages) {
    const fixture = operations({ failAt });
    await assert.rejects(executeCanaryLifecycle(fixture), (error) => error === fixture.primary);
    assert.deepEqual(fixture.calls, [
      ...executionStages.slice(0, executionStages.indexOf(failAt) + 1),
      ...cleanupStages
    ]);
  }
});

test('successful canaries clean up and cleanup failures remain explicit', async () => {
  const successful = operations();
  await executeCanaryLifecycle(successful);
  assert.deepEqual(successful.calls, [...executionStages, ...cleanupStages]);

  const failedAndDirty = operations({ failAt: 'runAuthenticatedSmoke', cleanupFailure: 'stopServer' });
  await assert.rejects(executeCanaryLifecycle(failedAndDirty), (error) => {
    assert.equal(error, failedAndDirty.primary);
    assert.deepEqual(error.canaryCleanupErrors, [failedAndDirty.cleanup]);
    assert.equal(error.canaryCleanupErrors[0].canaryCleanupStage, 'stop-server');
    assert.equal(error.preserveRunRoot, true);
    return true;
  });
  assert.deepEqual(failedAndDirty.calls.slice(-3), cleanupStages);

  const passedButDirty = operations({ cleanupFailure: 'removeEnvironment' });
  await assert.rejects(executeCanaryLifecycle(passedButDirty), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [passedButDirty.cleanup]);
    return true;
  });
});
