import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { validateDeploymentControllerResult } from '../../scripts/validate-deployment-controller-result.mjs';
import { parseCodeRollbackResult } from '../../scripts/parse-code-rollback-result.mjs';
import {
  classifyStartedControllerState,
  completeStartedRollbackRecovery,
  recoverUnpersistedControllerResult,
  verifyRunningProduction
} from '../release-controller.mjs';

const sha = 'a'.repeat(40);
const recovered = 'b'.repeat(40);
const tag = 'v0.1.1';

test('verify, promote, and rollback require exact canonical completion envelopes', () => {
  assert.deepEqual(validateDeploymentControllerResult(`{"verified":"${sha}","activated":false}`, {
    mode: 'verify', releaseSha: sha, tag: '-'
  }), { verified: sha, activated: false });
  assert.deepEqual(validateDeploymentControllerResult(`{"promoted":"${sha}","tag":"${tag}","backup":"20260712T010203Z-pre-${sha}"}`, {
    mode: 'promote', releaseSha: sha, tag
  }), { promoted: sha, tag, backup: `20260712T010203Z-pre-${sha}` });
  assert.deepEqual(validateDeploymentControllerResult(`{"rolledBackTo":"${recovered}","legacy":false}`, {
    mode: 'rollback', releaseSha: sha, tag
  }), { rolledBackTo: recovered, legacy: false });
});

test('rollback validator CLI preserves the downstream canonical key order', () => {
  const inputLine = `{"rolledBackTo":"${recovered}","legacy":false}\n`;
  const validator = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'validate-deployment-controller-result.mjs');
  const execution = spawnSync(process.execPath, [validator, '--mode', 'rollback', '--release-sha', sha, '--tag', tag], {
    input: inputLine,
    encoding: 'utf8'
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, inputLine);
  assert.deepEqual(parseCodeRollbackResult(execution.stdout.trimEnd(), { failedReleaseSha: sha }), {
    legacy: false,
    rolledBackTo: recovered
  });
});

test('empty, malformed, reordered, extra, and mismatched results fail closed', () => {
  for (const value of [
    '', '{}', `{"verified":"${sha}","activated":true}`,
    `{"activated":false,"verified":"${sha}"}`,
    `{"verified":"${'c'.repeat(40)}","activated":false}`,
    `{"verified":"${sha}","activated":false,"extra":true}`,
    `{"verified":"${sha}","activated":false}\ncompleted`
  ]) assert.throws(() => validateDeploymentControllerResult(value, { mode: 'verify', releaseSha: sha, tag: '-' }));

  for (const value of [
    `{"promoted":"${sha}","tag":"${tag}"}`,
    `{"promoted":"${sha}","tag":"${tag}","idempotent":false}`,
    `{"promoted":"${sha}","tag":"${tag}","backup":"not-a-backup"}`,
    `{"promoted":"${'c'.repeat(40)}","tag":"${tag}","idempotent":true}`
  ]) assert.throws(() => validateDeploymentControllerResult(value, { mode: 'promote', releaseSha: sha, tag }));
});

test('completion recovery never rolls back an idempotent promotion', async () => {
  const fields = {
    command: 'promote', releaseSha: sha, tag, runId: '123-1-production'
  };
  const calls = [];
  await recoverUnpersistedControllerResult(fields, { promoted: sha, tag, idempotent: true }, {
    reconcile: async () => calls.push('prove-current'),
    readReleaseLink: async () => { calls.push('read-link'); return sha; },
    rollback: async () => calls.push('rollback')
  });
  assert.deepEqual(calls, ['prove-current']);
});

test('completion recovery rolls back only a newly activated promotion', async () => {
  const fields = {
    command: 'promote', releaseSha: sha, tag, runId: '123-1-production'
  };
  const calls = [];
  await recoverUnpersistedControllerResult(fields, {
    promoted: sha, tag, backup: `20260712T010203Z-pre-${sha}`
  }, {
    readReleaseLink: async (linkPath) => {
      calls.push(linkPath.endsWith('current') ? 'read-current' : 'read-previous');
      return linkPath.endsWith('current') ? `/releases/${sha}` : `/releases/${recovered}`;
    },
    rollback: async (current, previous) => calls.push(`rollback:${current}:${previous}`)
  });
  assert.deepEqual(calls, [
    'read-current',
    'read-previous',
    `rollback:/releases/${sha}:/releases/${recovered}`
  ]);
});

test('started operation classifier distinguishes pre-swap, committed, recovered, and ambiguous states', () => {
  const promote = { command: 'promote', releaseSha: sha };
  assert.equal(classifyStartedControllerState(promote, { currentSha: recovered, previousSha: recovered, stagePresent: true }), 'execute');
  assert.equal(classifyStartedControllerState(promote, { currentSha: recovered, previousSha: recovered, stagePresent: false }), 'reupload');
  assert.equal(classifyStartedControllerState(promote, { currentSha: sha, previousSha: recovered, stagePresent: false }), 'complete');
  assert.equal(classifyStartedControllerState(promote, { currentSha: recovered, previousSha: sha, stagePresent: true }), 'manual');

  const rollback = { command: 'rollback', releaseSha: sha };
  assert.equal(classifyStartedControllerState(rollback, { currentSha: sha, previousSha: recovered }), 'execute');
  assert.equal(classifyStartedControllerState(rollback, { currentSha: recovered, previousSha: sha }), 'complete');
  assert.equal(classifyStartedControllerState(rollback, { currentSha: recovered, previousSha: recovered }), 'repair-complete');
  assert.equal(classifyStartedControllerState(rollback, { currentSha: recovered, previousSha: 'c'.repeat(40) }), 'manual');
});

test('started rollback repairs the failed-release anchor before proving the recovered service', async () => {
  const failedRelease = `/releases/${sha}`;
  const current = `/releases/${recovered}`;
  const fields = {
    command: 'rollback',
    releaseSha: sha,
    artifactSha256: 'c'.repeat(64),
    tag,
    runId: '123-1-production'
  };
  const calls = [];
  const outcome = await completeStartedRollbackRecovery(fields, {
    current,
    failedRelease,
    repairPrevious: true
  }, {
    readReleaseMetadata: async (release) => {
      calls.push(`metadata:${release}`);
      return { artifactSha256: fields.artifactSha256, tag };
    },
    loadReleaseIdentity: async (release, expectedSha) => {
      calls.push(`identity:${release}:${expectedSha}`);
    },
    validateAnchor: async (release) => {
      calls.push(`anchor:${release}`);
      return { legacy: false, releaseSha: recovered };
    },
    replacePrevious: async (release) => {
      calls.push(`replace:${release}`);
    },
    startProduction: async () => {
      calls.push('start');
    },
    verifyProduction: async (release, identity, runId) => {
      calls.push(`verify:${release}:${identity.releaseSha}:${runId}`);
    }
  });

  assert.deepEqual(outcome, {
    kind: 'complete',
    result: { rolledBackTo: recovered, legacy: false }
  });
  assert.deepEqual(calls, [
    `metadata:${failedRelease}`,
    `identity:${failedRelease}:${sha}`,
    `anchor:${current}`,
    `replace:${failedRelease}`,
    'start',
    `verify:${current}:${recovered}:${fields.runId}`
  ]);
});

test('fresh promotion revives an unchanged current service left stopped by prior SIGKILL or OOM', async () => {
  const release = `/releases/${recovered}`;
  const identity = { releaseSha: recovered, legacy: false };
  const calls = [];
  let serviceState = 'stopped';
  await verifyRunningProduction(release, identity, '456-1-production', {
    startProduction: async () => {
      calls.push('start-current');
      assert.equal(serviceState, 'stopped');
      serviceState = 'running';
    },
    waitUntilReady: async (baseUrl, releaseSha) => {
      calls.push('ready');
      assert.equal(serviceState, 'running');
      assert.equal(baseUrl, 'http://127.0.0.1:4180');
      assert.equal(releaseSha, recovered);
    },
    runSmoke: async (actualRelease, actualIdentity, runId) => {
      calls.push('full-proof');
      assert.equal(serviceState, 'running');
      assert.equal(actualRelease, release);
      assert.equal(actualIdentity, identity);
      assert.equal(runId, '456-1-production');
    }
  });
  assert.deepEqual(calls, ['start-current', 'ready', 'full-proof']);
});
