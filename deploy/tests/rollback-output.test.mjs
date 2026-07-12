import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodeRollbackResult } from '../../scripts/parse-code-rollback-result.mjs';

const failed = 'a'.repeat(40);
const recovered = 'b'.repeat(40);

test('rollback output identifies exact legacy and recovered-release targets', () => {
  assert.deepEqual(parseCodeRollbackResult('{"rolledBackTo":"legacy","legacy":true}', { failedReleaseSha: failed }), {
    legacy: true,
    rolledBackTo: 'legacy'
  });
  assert.deepEqual(parseCodeRollbackResult(`{"rolledBackTo":"${recovered}","legacy":false}`, { failedReleaseSha: failed }), {
    legacy: false,
    rolledBackTo: recovered
  });
});

test('rollback output rejects ambiguity, unexpected fields, and the failed release', () => {
  for (const value of [
    '', '{}', '[]', '{"rolledBackTo":"legacy","legacy":false}',
    '{"rolledBackTo":"legacy","legacy":true,"status":"ok"}',
    `{"rolledBackTo":"${failed}","legacy":false}`,
    `{"rolledBackTo":"${recovered}","legacy":"false"}`,
    `{"legacy":false,"rolledBackTo":"${recovered}"}`,
    `{"rolledBackTo":"${recovered}","legacy":false,"legacy":false}`,
    `{"rolledBackTo":"${recovered}","legacy":false}\ncompleted`,
    'not-json'
  ]) {
    assert.throws(() => parseCodeRollbackResult(value, { failedReleaseSha: failed }), /rollback/i);
  }
});
