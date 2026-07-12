import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDeploymentControllerResult } from '../../scripts/validate-deployment-controller-result.mjs';

const sha = 'a'.repeat(40);
const recovered = 'b'.repeat(40);
const tag = 'v0.1.1';

test('verify and promotion results require exact canonical completion envelopes', () => {
  assert.deepEqual(validateDeploymentControllerResult(`{"verified":"${sha}","activated":false}`, {
    mode: 'verify', releaseSha: sha, tag: '-'
  }), { verified: sha, activated: false });
  assert.deepEqual(validateDeploymentControllerResult(`{"promoted":"${sha}","tag":"${tag}","backup":"20260712T010203Z-pre-${sha}"}`, {
    mode: 'promote', releaseSha: sha, tag
  }), { promoted: sha, tag, backup: `20260712T010203Z-pre-${sha}` });
  assert.deepEqual(validateDeploymentControllerResult(`{"promoted":"${sha}","tag":"${tag}","idempotent":true}`, {
    mode: 'promote', releaseSha: sha, tag
  }), { promoted: sha, tag, idempotent: true });
});

test('empty, malformed, ambiguous, and mismatched completion results fail closed', () => {
  for (const value of [
    '', '{}', `{"verified":"${sha}","activated":true}`,
    `{"activated":false,"verified":"${sha}"}`,
    `{"verified":"${'c'.repeat(40)}","activated":false}`,
    `{"verified":"${sha}","activated":false,"extra":true}`,
    `{"verified":"${sha}","activated":false}\ncompleted`
  ]) {
    assert.throws(() => validateDeploymentControllerResult(value, { mode: 'verify', releaseSha: sha, tag: '-' }), /controller|verify/i);
  }
  for (const value of [
    `{"promoted":"${sha}","tag":"${tag}"}`,
    `{"promoted":"${sha}","tag":"${tag}","idempotent":false}`,
    `{"promoted":"${sha}","tag":"${tag}","backup":"not-a-backup"}`,
    `{"promoted":"${'c'.repeat(40)}","tag":"${tag}","idempotent":true}`
  ]) {
    assert.throws(() => validateDeploymentControllerResult(value, { mode: 'promote', releaseSha: sha, tag }), /promotion|controller/i);
  }
});

test('rollback validation remains strict and identifies the recovered target', () => {
  assert.deepEqual(validateDeploymentControllerResult(`{"rolledBackTo":"${recovered}","legacy":false}`, {
    mode: 'rollback', releaseSha: sha, tag
  }), { rolledBackTo: recovered, legacy: false });
});
