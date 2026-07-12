import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertGithubCommitOnMain,
  executeActivationTransaction,
  resolveGithubTag,
  verifyGithubCommitIsOnMain
} from '../release-controller-lib.mjs';

const releaseSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const tagObjectSha = 'c'.repeat(40);

function response(value, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => value };
}

function validComparison(overrides = {}) {
  return {
    status: 'ahead',
    ahead_by: 7,
    behind_by: 0,
    total_commits: 7,
    base_commit: { sha: releaseSha },
    merge_base_commit: { sha: releaseSha },
    ...overrides
  };
}

test('tag resolution validates every GitHub object and bounds annotated-tag traversal', async () => {
  const requests = [];
  const values = [
    { object: { type: 'tag', sha: tagObjectSha } },
    { object: { type: 'commit', sha: releaseSha } }
  ];
  assert.equal(await resolveGithubTag('v0.2.0', async (url, options) => {
    requests.push({ url, options });
    return response(values.shift());
  }), releaseSha);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
  assert.ok(requests.every(({ options }) => options.headers['X-GitHub-Api-Version'] === '2022-11-28'));

  await assert.rejects(resolveGithubTag('v0.2.0', async () => response({ object: { type: 'commit', sha: 'short' } })), /invalid Git object/);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => response({ object: { type: 'blob', sha: releaseSha } })), /invalid Git object/);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => response({ object: { type: 'tag', sha: tagObjectSha } })), /does not resolve to a commit/);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => response({}, { ok: false, status: 503 })), /503/);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => { throw new Error('timeout'); }), (error) => error.message === 'GitHub tag verification request failed.' && error.cause?.message === 'timeout');
  await assert.rejects(resolveGithubTag('v0.2.0', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), /invalid JSON/);
});

test('public-main ancestry accepts only exact merge-base ahead or identical semantics', async () => {
  const ahead = await assertGithubCommitOnMain(releaseSha, async (url, options) => {
    assert.match(url, new RegExp(`/compare/${releaseSha}\\.\\.\\.main$`));
    assert.ok(options.signal instanceof AbortSignal);
    return response(validComparison());
  });
  assert.deepEqual(ahead, { releaseSha, status: 'ahead', commitsAhead: 7 });

  const identical = await verifyGithubCommitIsOnMain(releaseSha, async () => response(validComparison({
    status: 'identical', ahead_by: 0, total_commits: 0
  })));
  assert.equal(identical.status, 'identical');

  for (const comparison of [
    validComparison({ status: 'behind', ahead_by: 0, behind_by: 1 }),
    validComparison({ status: 'diverged', behind_by: 1 }),
    validComparison({ merge_base_commit: { sha: otherSha } }),
    validComparison({ base_commit: { sha: otherSha } }),
    validComparison({ status: 'ahead', ahead_by: 0 }),
    validComparison({ status: 'identical', ahead_by: 1 }),
    validComparison({ status: 'identical', behind_by: 1 }),
    validComparison({ total_commits: -1 }),
    validComparison({ ahead_by: '7' }),
    { status: 'ahead' }
  ]) {
    await assert.rejects(assertGithubCommitOnMain(releaseSha, async () => response(comparison)), /ancestry|merge base|commit counts|commit identities|ancestor/);
  }
});

function operations(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      stop: async () => calls.push('stop'),
      prepare: async () => calls.push('prepare'),
      swap: async () => calls.push('swap'),
      start: async () => calls.push('start'),
      verify: async () => calls.push('verify'),
      rollback: async () => calls.push('rollback'),
      restartPrevious: async () => calls.push('restartPrevious'),
      ...overrides(calls)
    }
  };
}

test('pre-swap activation failure reports a proven previous-service restart', async () => {
  const activation = new Error('prepare failed');
  const fixture = operations((calls) => ({ prepare: async () => { calls.push('prepare'); throw activation; } }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) => {
    assert.equal(error.message, 'prepare failed');
    assert.equal(error.cause, activation);
    assert.equal(error.activationError, activation);
    assert.equal(error.activationPhase, 'prepare');
    assert.equal(error.activationRolledBack, false);
    assert.equal(error.rollbackFailed, false);
    assert.equal(error.previousRestarted, true);
    assert.equal(error.restartPreviousFailed, false);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'restartPrevious']);
});

test('post-swap activation failure reports successful automatic code rollback', async () => {
  const activation = new Error('verification failed');
  const fixture = operations((calls) => ({ verify: async () => { calls.push('verify'); throw activation; } }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) => {
    assert.equal(error.activationPhase, 'verify');
    assert.equal(error.activationRolledBack, true);
    assert.equal(error.rollbackFailed, false);
    assert.equal(error.previousRestarted, false);
    assert.equal(error.activationError, activation);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'swap', 'start', 'verify', 'rollback']);
});

test('a swap that marks a changed link rolls back when its durability proof fails', async () => {
  const activation = new Error('link parent fsync failed');
  const fixture = operations((calls) => ({
    swap: async (markLinksChanged) => {
      calls.push('swap');
      markLinksChanged();
      throw activation;
    }
  }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) => {
    assert.equal(error.activationPhase, 'swap');
    assert.equal(error.activationRolledBack, true);
    assert.equal(error.previousRestarted, false);
    assert.equal(error.activationError, activation);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'swap', 'rollback']);
});

test('an uncertainty-tagged swap error rolls back instead of restarting unchecked links', async () => {
  const activation = Object.assign(new Error('rename acknowledgement lost'), { linkMayHaveChanged: true });
  const fixture = operations((calls) => ({
    swap: async () => { calls.push('swap'); throw activation; }
  }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) =>
    error.activationPhase === 'swap' && error.activationRolledBack === true && error.previousRestarted === false);
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'swap', 'rollback']);
});

test('a proven pre-mutation swap failure may restart the unchanged previous release', async () => {
  const activation = new Error('temporary link creation failed');
  const fixture = operations((calls) => ({
    swap: async () => { calls.push('swap'); throw activation; }
  }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) =>
    error.activationPhase === 'swap' && error.activationRolledBack === false && error.previousRestarted === true);
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'swap', 'restartPrevious']);
});

test('rollback failure preserves both errors and never attempts a misleading restart', async () => {
  const activation = new Error('start failed');
  const rollback = new Error('rollback smoke failed');
  const fixture = operations((calls) => ({
    start: async () => { calls.push('start'); throw activation; },
    rollback: async () => { calls.push('rollback'); throw rollback; }
  }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [activation, rollback]);
    assert.equal(error.activationError, activation);
    assert.equal(error.rollbackError, rollback);
    assert.equal(error.activationPhase, 'start');
    assert.equal(error.activationRolledBack, false);
    assert.equal(error.rollbackFailed, true);
    assert.equal(error.previousRestarted, false);
    assert.equal(error.restartPreviousFailed, false);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'prepare', 'swap', 'start', 'rollback']);
});

test('pre-swap restart failure remains distinct from rollback failure', async () => {
  const activation = new Error('stop failed');
  const restart = new Error('previous start failed');
  const fixture = operations((calls) => ({
    stop: async () => { calls.push('stop'); throw activation; },
    restartPrevious: async () => { calls.push('restartPrevious'); throw restart; }
  }));
  await assert.rejects(executeActivationTransaction(fixture.value), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [activation, restart]);
    assert.equal(error.activationPhase, 'stop');
    assert.equal(error.activationRolledBack, false);
    assert.equal(error.rollbackFailed, false);
    assert.equal(error.previousRestarted, false);
    assert.equal(error.restartPreviousFailed, true);
    assert.equal(error.restartError, restart);
    return true;
  });
  assert.deepEqual(fixture.calls, ['stop', 'restartPrevious']);
});
