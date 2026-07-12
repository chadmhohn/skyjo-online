import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCodeRollbackTransaction } from '../release-controller-lib.mjs';

function operations({ fail = '' } = {}) {
  const calls = [];
  const operation = (name) => async () => {
    calls.push(name);
    if (fail === name) throw new Error(`${name} failed`);
  };
  return {
    calls,
    value: {
      stop: operation('stop'),
      prepare: operation('prepare'),
      restoreCurrent: operation('restore-current'),
      recordFailed: operation('record-failed'),
      startRecovered: operation('start-recovered'),
      restoreOriginalLinks: operation('restore-original-links'),
      restartFailed: operation('restart-failed')
    }
  };
}

test('code rollback records the failed release and verifies the recovered release', async () => {
  const fixture = operations();
  assert.deepEqual(await executeCodeRollbackTransaction(fixture.value), { status: 'rolled-back' });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'restore-current', 'record-failed', 'start-recovered']);
});

for (const [failure, expectedCalls] of [
  ['stop', ['stop', 'restart-failed']],
  ['prepare', ['stop', 'prepare', 'restart-failed']],
  ['restore-current', ['stop', 'prepare', 'restore-current', 'restart-failed']]
]) {
  test(`${failure} failure restarts and reverifies the unchanged failed release`, async () => {
    const fixture = operations({ fail: failure });
    await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
      assert.equal(error.deploymentStatus, 'rollback-failed');
      assert.equal(error.rollbackStage, failure);
      assert.equal(error.serviceRecovered, true);
      return true;
    });
    assert.deepEqual(fixture.calls, expectedCalls);
  });
}

test('failed previous-link recording reports failure after recovered code is verified', async () => {
  const fixture = operations({ fail: 'record-failed' });
  await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.rollbackStage, 'record-failed');
    assert.equal(error.serviceRecovered, true);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'restore-current', 'record-failed', 'start-recovered']);
});

test('an uncertain current-link durability failure restores both original links', async () => {
  const fixture = operations();
  fixture.value.restoreCurrent = async () => {
    fixture.calls.push('restore-current');
    throw Object.assign(new Error('parent fsync failed'), { linkMayHaveChanged: true });
  };
  await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.rollbackStage, 'restore-current');
    assert.equal(error.serviceRecovered, true);
    return true;
  });
  assert.deepEqual(fixture.calls, [
    'stop', 'prepare', 'restore-current',
    'stop', 'restore-original-links', 'restart-failed'
  ]);
});

test('recovered-release start failure restores both original links and reverifies the failed release', async () => {
  const fixture = operations({ fail: 'start-recovered' });
  await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.rollbackStage, 'start-recovered');
    assert.equal(error.serviceRecovered, true);
    return true;
  });
  assert.deepEqual(fixture.calls, [
    'stop', 'prepare', 'restore-current', 'record-failed', 'start-recovered',
    'stop', 'restore-original-links', 'restart-failed'
  ]);
});

test('original-link restoration failure remains explicit even when the failed service recovers', async () => {
  const fixture = operations();
  fixture.value.startRecovered = async () => { fixture.calls.push('start-recovered'); throw new Error('start failed'); };
  fixture.value.restoreOriginalLinks = async () => { fixture.calls.push('restore-original-links'); throw new Error('previous link failed'); };
  await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.rollbackStage, 'start-recovered');
    assert.equal(error.serviceRecovered, true);
    assert.ok(error.cause instanceof AggregateError);
    return true;
  });
  assert.deepEqual(fixture.calls.slice(-3), ['stop', 'restore-original-links', 'restart-failed']);
});

test('failed-release restart failure never claims service recovery', async () => {
  const fixture = operations();
  fixture.value.startRecovered = async () => { fixture.calls.push('start-recovered'); throw new Error('start failed'); };
  fixture.value.restartFailed = async () => { fixture.calls.push('restart-failed'); throw new Error('restart failed'); };
  await assert.rejects(executeCodeRollbackTransaction(fixture.value), (error) => {
    assert.equal(error.deploymentStatus, 'rollback-failed');
    assert.equal(error.rollbackStage, 'start-recovered');
    assert.equal(error.serviceRecovered, false);
    assert.ok(error.cause instanceof AggregateError);
    return true;
  });
});
