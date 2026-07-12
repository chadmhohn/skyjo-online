import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStageClaimOwnership } from '../release-controller.mjs';

const deploy = { deployUid: 1001, deployGid: 1001 };
const uploaded = {
  stageUid: 1001, stageGid: 1001, stageMode: 0o700,
  markerUid: 1001, markerGid: 1001, markerMode: 0o400,
  archiveUid: 1001, archiveGid: 1001, archiveMode: 0o600
};

test('every ownership transition boundary remains resumable', () => {
  const states = [
    ['uploaded', uploaded],
    ['legacy marker-first crash', { ...uploaded, markerUid: 0, markerGid: 0 }],
    ['stage chowned before chmod', { ...uploaded, stageUid: 0, stageGid: 0 }],
    ['stage chmod before marker claim', { ...uploaded, stageUid: 0, stageGid: 0, stageMode: 0o711 }],
    ['marker claimed before archive claim', {
      ...uploaded, stageUid: 0, stageGid: 0, stageMode: 0o711, markerUid: 0, markerGid: 0
    }],
    ['archive chowned before chmod', {
      ...uploaded, stageUid: 0, stageGid: 0, stageMode: 0o711,
      markerUid: 0, markerGid: 0, archiveUid: 0, archiveGid: 0
    }],
    ['claimed', {
      ...uploaded, stageUid: 0, stageGid: 0, stageMode: 0o711,
      markerUid: 0, markerGid: 0, archiveUid: 0, archiveGid: 0, archiveMode: 0o400
    }]
  ];
  for (const [name, state] of states) {
    assert.doesNotThrow(() => classifyStageClaimOwnership(state, deploy), name);
  }
  assert.equal(classifyStageClaimOwnership(states[0][1], deploy), 'uploaded');
  assert.equal(classifyStageClaimOwnership(states.at(-1)[1], deploy), 'claimed');
});

test('untrusted owners and writable claim artifacts fail closed', () => {
  for (const state of [
    { ...uploaded, stageUid: 2002 },
    { ...uploaded, stageMode: 0o777 },
    { ...uploaded, markerMode: 0o600 },
    { ...uploaded, archiveUid: 2002 },
    { ...uploaded, archiveMode: 0o666 }
  ]) assert.throws(() => classifyStageClaimOwnership(state, deploy), /unsafe/i);
});
