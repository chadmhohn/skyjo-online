import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  certifyTemporaryUnitsClean,
  executeCanaryLifecycle,
  parseCanaryUnitState
} from '../release-controller.mjs';

const serverUnit = 'skyjo-online-canary@123-1-canary.service';
const smokeUnit = 'skyjo-online-canary-smoke@123-1-canary.service';
const productionSmokeUnit = 'skyjo-online-smoke@123-1-production.service';
const legacyProofUnit = 'skyjo-online-legacy-proof@123-1-production.service';
const productionRunId = '1783902382025837200-1-production';

function isolatedCanaryUnits(runId) {
  return [
    `skyjo-online-canary@${runId}.service`,
    `skyjo-online-canary-smoke@${runId}.service`,
    `skyjo-online-state-proof@${runId}.service`
  ];
}

function fragmentFor(unit) {
  if (unit.startsWith('skyjo-online-canary-smoke@')) return '/etc/systemd/system/skyjo-online-canary-smoke@.service';
  if (unit.startsWith('skyjo-online-canary@')) return '/etc/systemd/system/skyjo-online-canary@.service';
  if (unit.startsWith('skyjo-online-state-proof@')) return '/etc/systemd/system/skyjo-online-state-proof@.service';
  if (unit.startsWith('skyjo-online-smoke@')) return '/etc/systemd/system/skyjo-online-smoke@.service';
  if (unit.startsWith('skyjo-online-legacy-proof@')) return '/etc/systemd/system/skyjo-online-legacy-proof@.service';
  throw new Error('unknown test unit');
}

function unitState(unit, overrides = {}) {
  const state = {
    Id: unit,
    LoadState: 'loaded',
    ActiveState: 'inactive',
    SubState: 'dead',
    Result: 'success',
    MainPID: '0',
    ControlPID: '0',
    Job: '',
    FragmentPath: fragmentFor(unit),
    DropInPaths: '',
    CollectMode: 'inactive',
    ...overrides
  };
  return [
    `Id=${state.Id}`,
    `SubState=${state.SubState}`,
    `Result=${state.Result}`,
    `LoadState=${state.LoadState}`,
    `ActiveState=${state.ActiveState}`,
    `MainPID=${state.MainPID}`,
    `ControlPID=${state.ControlPID}`,
    `Job=${state.Job}`,
    `FragmentPath=${state.FragmentPath}`,
    `DropInPaths=${state.DropInPaths}`,
    `CollectMode=${state.CollectMode}`
  ].join('\n') + '\n';
}

function commandKind(args) {
  return [args[0], args.at(-1)];
}

test('a garbage-collected successful instance reloads clean and is never reset', async () => {
  const calls = [];
  const systemctl = async (args) => {
    calls.push(args);
    assert.equal(args[0], 'show');
    return unitState(args.at(-1));
  };
  assert.deepEqual(await certifyTemporaryUnitsClean([serverUnit], { systemctl }), [
    { unit: serverUnit, status: 'clean' }
  ]);
  assert.deepEqual(await certifyTemporaryUnitsClean([serverUnit], { systemctl }), [
    { unit: serverUnit, status: 'clean' }
  ]);
  assert.deepEqual(calls.map(commandKind), [['show', serverUnit], ['show', serverUnit]]);
  assert.deepEqual(parseCanaryUnitState(unitState(serverUnit)), {
    Id: serverUnit, SubState: 'dead', Result: 'success', LoadState: 'loaded', ActiveState: 'inactive',
    MainPID: '0', ControlPID: '0', Job: '',
    FragmentPath: '/etc/systemd/system/skyjo-online-canary@.service',
    DropInPaths: '', CollectMode: 'inactive'
  });
});

test('isolated canary templates accept exact production-lane run IDs through the maximum contract length', async () => {
  for (const runId of [productionRunId, `${'9'.repeat(20)}-${'9'.repeat(6)}-production`]) {
    const units = isolatedCanaryUnits(runId);
    const calls = [];
    assert.deepEqual(await certifyTemporaryUnitsClean(units, {
      systemctl: async (args) => {
        calls.push(args);
        return unitState(args.at(-1));
      }
    }), units.map((unit) => ({ unit, status: 'clean' })));
    assert.deepEqual(calls.map(commandKind), units.map((unit) => ['show', unit]));
  }
});

test('a production-lane canary lifecycle certifies all isolated units before environment removal', async () => {
  const units = isolatedCanaryUnits(productionRunId);
  const calls = [];
  const noOp = (name) => async () => { calls.push(name); };
  await executeCanaryLifecycle({
    prepareEnvironment: noOp('prepareEnvironment'),
    startServer: noOp('startServer'),
    waitUntilReady: noOp('waitUntilReady'),
    runAuthenticatedSmoke: noOp('runAuthenticatedSmoke'),
    runStateProof: noOp('runStateProof'),
    verifySourceSnapshot: noOp('verifySourceSnapshot'),
    stopServer: noOp('stopServer'),
    resetUnits: async () => {
      calls.push('resetUnits');
      await certifyTemporaryUnitsClean(units, {
        systemctl: async (args) => {
          calls.push(`show:${args.at(-1)}`);
          return unitState(args.at(-1));
        }
      });
    },
    removeEnvironment: noOp('removeEnvironment')
  });
  assert.deepEqual(calls, [
    'prepareEnvironment', 'startServer', 'waitUntilReady', 'runAuthenticatedSmoke',
    'runStateProof', 'verifySourceSnapshot', 'stopServer', 'resetUnits',
    ...units.map((unit) => `show:${unit}`), 'removeEnvironment'
  ]);
});

test('duplicate production-lane canary units are rejected before systemctl', async () => {
  const unit = isolatedCanaryUnits(productionRunId)[0];
  let calls = 0;
  await assert.rejects(certifyTemporaryUnitsClean([unit, unit], {
    systemctl: async () => { calls += 1; }
  }), /unit list is invalid/);
  assert.equal(calls, 0);
});

test('an exact failed instance is reset and reinspected but still fails certification', async () => {
  let failed = true;
  let resets = 0;
  const calls = [];
  const systemctl = async (args) => {
    calls.push(args);
    if (args[0] === 'reset-failed') {
      assert.equal(args.at(-1), smokeUnit);
      resets += 1;
      failed = false;
      return '';
    }
    return failed
      ? unitState(smokeUnit, { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code' })
      : unitState(smokeUnit);
  };
  await assert.rejects(certifyTemporaryUnitsClean([smokeUnit], { systemctl }), (error) => {
    assert.equal(error.canaryUnit, smokeUnit);
    assert.equal(error.canaryUnitResetStage, 'unexpected-failed');
    assert.equal(error.canaryUnitState.ActiveState, 'failed');
    assert.equal(error.canaryUnitFinalState.ActiveState, 'inactive');
    assert.equal(error.canaryUnitFinalStateUnsafe, undefined);
    assert.equal(error.preserveRunRoot, undefined);
    return true;
  });
  assert.equal(resets, 1);
  assert.deepEqual(calls.map(commandKind), [
    ['show', smokeUnit], ['reset-failed', smokeUnit], ['show', smokeUnit]
  ]);
  assert.deepEqual(await certifyTemporaryUnitsClean([smokeUnit], { systemctl }), [
    { unit: smokeUnit, status: 'clean' }
  ]);
  assert.equal(resets, 1, 'an idempotent second certification must not reset a clean unit');
});

test('a reset-failed permission error retains unsafe final evidence and does not strand later units', async () => {
  const resetError = new Error('D-Bus reset-failed permission denied');
  const calls = [];
  await assert.rejects(certifyTemporaryUnitsClean([smokeUnit, serverUnit], {
    systemctl: async (args) => {
      calls.push(args);
      const unit = args.at(-1);
      if (args[0] === 'reset-failed') throw resetError;
      if (unit === smokeUnit) {
        return unitState(smokeUnit, { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code' });
      }
      return unitState(serverUnit);
    }
  }), (error) => {
    assert.equal(error.canaryUnit, smokeUnit);
    assert.equal(error.canaryUnitResetStage, 'unexpected-failed');
    assert.equal(error.canaryUnitResetError, resetError);
    assert.equal(error.canaryUnitFinalState.ActiveState, 'failed');
    assert.equal(error.canaryUnitFinalStateUnsafe, true);
    assert.equal(error.preserveRunRoot, true);
    return true;
  });
  assert.deepEqual(calls.map(commandKind), [
    ['show', smokeUnit], ['reset-failed', smokeUnit], ['show', smokeUnit],
    ['show', serverUnit]
  ]);
});

test('identity drift, failed cleanup metadata, and unloaded state are never remediated', async () => {
  for (const unsafe of [
    { Id: 'unrelated.service' },
    { FragmentPath: '/tmp/attacker.service' },
    { DropInPaths: '/etc/systemd/system/override.conf' },
    { CollectMode: 'inactive-or-failed' },
    { LoadState: 'not-found' },
    { Result: 'timeout' }
  ]) {
    const calls = [];
    await assert.rejects(certifyTemporaryUnitsClean([serverUnit], {
      systemctl: async (args) => {
        calls.push(args);
        return unitState(serverUnit, unsafe);
      }
    }), (error) => error.canaryUnit === serverUnit && error.canaryUnitResetStage === 'unsafe-state');
    assert.deepEqual(calls.map(commandKind), [['show', serverUnit]]);
  }
});

test('active, job, and PID residue is stopped by exact unit and still fails certification', async () => {
  for (const residue of [
    { ActiveState: 'active', SubState: 'running' },
    { ActiveState: 'activating', SubState: 'start' },
    { ActiveState: 'deactivating', SubState: 'stop' },
    { MainPID: '42' },
    { ControlPID: '43' },
    { Job: '77 start' }
  ]) {
    let cleaned = false;
    const calls = [];
    await assert.rejects(certifyTemporaryUnitsClean([serverUnit], {
      systemctl: async (args) => {
        calls.push(args);
        if (args[0] === 'stop') {
          assert.equal(args.at(-1), serverUnit);
          cleaned = true;
          return '';
        }
        return cleaned ? unitState(serverUnit) : unitState(serverUnit, residue);
      }
    }), (error) => error.canaryUnit === serverUnit &&
      error.canaryUnitResetStage === 'unexpected-residue' && error.canaryUnitFinalState?.ActiveState === 'inactive');
    assert.deepEqual(calls.map(commandKind), [
      ['show', serverUnit], ['stop', serverUnit], ['show', serverUnit]
    ]);
  }
});

test('a stop permission error retains unsafe final evidence and does not strand later units', async () => {
  const stopError = new Error('D-Bus stop permission denied');
  const calls = [];
  await assert.rejects(certifyTemporaryUnitsClean([serverUnit, smokeUnit], {
    systemctl: async (args) => {
      calls.push(args);
      const unit = args.at(-1);
      if (args[0] === 'stop') throw stopError;
      if (unit === serverUnit) return unitState(serverUnit, { ActiveState: 'active', SubState: 'running', MainPID: '42' });
      return unitState(smokeUnit);
    }
  }), (error) => {
    assert.equal(error.canaryUnit, serverUnit);
    assert.equal(error.canaryUnitResetStage, 'unexpected-residue');
    assert.equal(error.canaryUnitStopError, stopError);
    assert.equal(error.canaryUnitFinalState.ActiveState, 'active');
    assert.equal(error.canaryUnitFinalState.MainPID, '42');
    assert.equal(error.canaryUnitFinalStateUnsafe, true);
    assert.equal(error.preserveRunRoot, true);
    return true;
  });
  assert.deepEqual(calls.map(commandKind), [
    ['show', serverUnit], ['stop', serverUnit], ['show', serverUnit],
    ['show', smokeUnit]
  ]);
});

test('malformed or unavailable state probes fail closed without a reset', async () => {
  const malformed = unitState(serverUnit).replace('CollectMode=inactive\n', '');
  for (const probe of [
    async () => malformed,
    async () => `${unitState(serverUnit)}Result=success\n`,
    async () => `${unitState(serverUnit)}\n`,
    async () => { throw new Error('state probe unavailable'); }
  ]) {
    const calls = [];
    await assert.rejects(certifyTemporaryUnitsClean([serverUnit], {
      systemctl: async (args) => {
        calls.push(args);
        return probe();
      }
    }), (error) => error.canaryUnit === serverUnit && error.canaryUnitResetStage === 'initial-state-probe');
    assert.deepEqual(calls.map(commandKind), [['show', serverUnit]]);
  }
});

test('an unsafe first unit cannot prevent a later exact failed unit reset and all evidence aggregates', async () => {
  let smokeFailed = true;
  let serverResidue = true;
  const calls = [];
  await assert.rejects(certifyTemporaryUnitsClean([serverUnit, smokeUnit], {
    systemctl: async (args) => {
      calls.push(args);
      const unit = args.at(-1);
      if (args[0] === 'reset-failed') {
        assert.equal(unit, smokeUnit);
        smokeFailed = false;
        return '';
      }
      if (args[0] === 'stop') {
        assert.equal(unit, serverUnit);
        serverResidue = false;
        return '';
      }
      if (unit === serverUnit) return serverResidue ? unitState(serverUnit, { MainPID: '99' }) : unitState(serverUnit);
      return smokeFailed
        ? unitState(smokeUnit, { ActiveState: 'failed', SubState: 'failed', Result: 'signal' })
        : unitState(smokeUnit);
    }
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.canaryUnit), [serverUnit, smokeUnit]);
    assert.deepEqual(error.errors.map((item) => item.canaryUnitResetStage), ['unexpected-residue', 'unexpected-failed']);
    return true;
  });
  assert.deepEqual(calls.map(commandKind), [
    ['show', serverUnit], ['stop', serverUnit], ['show', serverUnit],
    ['show', smokeUnit], ['reset-failed', smokeUnit], ['show', smokeUnit]
  ]);
});

test('unrelated failed units are rejected before systemctl and exact-unit command scope is preserved', async () => {
  let calls = 0;
  await assert.rejects(certifyTemporaryUnitsClean(['unrelated-failed-sentinel.service'], {
    systemctl: async () => { calls += 1; }
  }), /unit list is invalid/);
  assert.equal(calls, 0);

  const commandLog = [];
  await certifyTemporaryUnitsClean([productionSmokeUnit], {
    systemctl: async (args) => {
      commandLog.push(args);
      return unitState(productionSmokeUnit);
    }
  });
  assert.equal(commandLog.length, 1);
  assert.equal(commandLog[0][0], 'show');
  assert.equal(commandLog[0].at(-1), productionSmokeUnit);
  assert(commandLog[0].includes('--all'));
  assert(commandLog[0].slice(1, -1).every((argument) =>
    argument === '--no-pager' || argument === '--all' || argument.startsWith('--property=')));

  assert.deepEqual(await certifyTemporaryUnitsClean([legacyProofUnit], {
    systemctl: async (args) => unitState(args.at(-1))
  }), [{ unit: legacyProofUnit, status: 'clean' }]);
  for (const invalidUnit of [
    'skyjo-online-legacy-proof@bootstrap-activation.service',
    'skyjo-online-smoke@123-1-canary.service',
    'skyjo-online-legacy-proof@123-1-canary.service',
    'skyjo-online-canary@123-1-staging.service',
    'skyjo-online-canary-smoke@123-1-production-extra.service',
    'skyjo-online-canary@0-1-canary.service',
    'skyjo-online-smoke@123-0-production.service',
    `skyjo-online-canary@${'1'.repeat(21)}-1-canary.service`,
    `skyjo-online-legacy-proof@1-${'1'.repeat(7)}-production.service`
  ]) {
    await assert.rejects(certifyTemporaryUnitsClean([invalidUnit], {
      systemctl: async () => assert.fail('invalid unit reached the controller certifier')
    }), /unit list is invalid/);
  }
});

test('an unsafe certification remains an explicit cleanup aggregate and later cleanup still runs', async () => {
  const calls = [];
  const noOp = (name) => async () => { calls.push(name); };
  await assert.rejects(executeCanaryLifecycle({
    prepareEnvironment: noOp('prepareEnvironment'),
    startServer: noOp('startServer'),
    waitUntilReady: noOp('waitUntilReady'),
    runAuthenticatedSmoke: noOp('runAuthenticatedSmoke'),
    runStateProof: noOp('runStateProof'),
    verifySourceSnapshot: noOp('verifySourceSnapshot'),
    stopServer: noOp('stopServer'),
    resetUnits: async () => {
      calls.push('resetUnits');
      await certifyTemporaryUnitsClean([serverUnit], {
        systemctl: async () => unitState(serverUnit, { Job: '88 stop' })
      });
    },
    removeEnvironment: noOp('removeEnvironment')
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors[0].canaryCleanupStage, 'reset-units');
    assert.equal(error.errors[0].canaryUnit, serverUnit);
    assert.equal(error.preserveRunRoot, true);
    return true;
  });
  assert.deepEqual(calls.slice(-3), ['stopServer', 'resetUnits', 'removeEnvironment']);
});

test('production smoke cleanup no longer ignores a broad reset-failed failure', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '..', 'release-controller.mjs'), 'utf8');
  assert.doesNotMatch(source, /reset-failed[^\n]*skyjo-online-smoke[^\n]*catch\(\(\) => \{\}\)/);
  assert.match(source, /certifyTemporaryUnitsClean\(\[smokeUnit\]\)/);
  assert.match(source, /certifyTemporaryUnitsClean\(\[unit\]\)/);
  assert.doesNotMatch(source, /reset-failed[^\n]*(?:skyjo-online-smoke|skyjo-online-legacy-proof)[^\n]*catch\(\(\) => \{\}\)/);
});
