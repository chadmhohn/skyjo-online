import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signDeploymentAuthorization } from '../deployment-authorization-lib.mjs';
import {
  executeAuthorizedControllerAction,
  executeWithRequiredRunCleanup,
  verifyRunningProduction
} from '../release-controller.mjs';
import { replaceSymlink } from '../release-controller-lib.mjs';

const nowSeconds = 1_800_000_000;
const keyId = 'canary-2026-07';
const keyPair = crypto.generateKeyPairSync('ed25519');

function trustedTestOperations(overrides = {}) {
  if (process.platform === 'win32') return overrides;
  return { trustedUid: process.getuid(), trustedGid: process.getgid(), ...overrides };
}

function authorization() {
  const fields = {
    role: 'canary',
    command: 'verify',
    runId: '123-1-canary',
    releaseSha: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    tag: '-',
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 300,
    keyId
  };
  const signature = signDeploymentAuthorization(fields, keyPair.privateKey, { nowSeconds });
  return {
    fields,
    signedCommand: `verify ${fields.runId} ${fields.releaseSha} ${fields.artifactSha256} - ${fields.issuedAt} ${fields.expiresAt} ${fields.keyId} ${signature}`
  };
}

async function ledgerFixture(callback) {
  const ledgerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-controller-auth-'));
  try {
    if (process.platform !== 'win32') await fs.chmod(ledgerRoot, 0o700);
    await callback(ledgerRoot);
  } finally {
    await fs.rm(ledgerRoot, { recursive: true, force: true });
  }
}

test('signature verification and one-use ledger start precede every authorized action', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  let recordPath;
  const result = await executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    action: async (fields) => {
      const records = await fs.readdir(ledgerRoot);
      assert.equal(records.length, 1, 'the replay record must exist before action code runs');
      recordPath = path.join(ledgerRoot, records[0]);
      assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).status, 'started');
      return fields.releaseSha;
    }
  });
  assert.equal(result, 'a'.repeat(40));
  assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).status, 'completed');
}));

test('ledger completion cannot precede the live-link parent durability proof', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-ledger-link-order-'));
  const calls = [];
  try {
    const target = path.join(releaseRoot, 'releases', 'a'.repeat(40));
    const current = path.join(releaseRoot, 'current');
    await fs.mkdir(target, { recursive: true });
    await executeAuthorizedControllerAction({
      expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
      beginAuthorization: async () => ({
        replayed: false,
        complete: async () => calls.push('ledger-complete'),
        fail: async () => calls.push('ledger-fail')
      }),
      action: async (fields) => {
        calls.push('action');
        await replaceSymlink(current, target, trustedTestOperations({
          syncParent: async () => calls.push('link-parent-sync')
        }));
        return { verified: fields.releaseSha, activated: false };
      }
    });
    assert.deepEqual(calls, ['action', 'link-parent-sync', 'ledger-complete']);
  } finally {
    await fs.rm(releaseRoot, { recursive: true, force: true });
  }
}));

test('link durability failure finalizes authorization as failed, never completed', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-ledger-link-failure-'));
  const calls = [];
  try {
    const target = path.join(releaseRoot, 'releases', 'a'.repeat(40));
    const current = path.join(releaseRoot, 'current');
    await fs.mkdir(target, { recursive: true });
    await assert.rejects(executeAuthorizedControllerAction({
      expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
      beginAuthorization: async () => ({
        replayed: false,
        complete: async () => calls.push('ledger-complete'),
        fail: async () => calls.push('ledger-fail')
      }),
      action: async () => {
        calls.push('action');
        await replaceSymlink(current, target, trustedTestOperations({
          syncParent: async () => { calls.push('link-parent-sync'); throw new Error('persistent fsync failure'); }
        }));
      }
    }), (error) => error.linkMayHaveChanged === true);
    assert.deepEqual(calls, ['action', 'link-parent-sync', 'ledger-fail']);
  } finally {
    await fs.rm(releaseRoot, { recursive: true, force: true });
  }
}));

test('current-service restart failure prevents proof and ledger completion', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  const calls = [];
  const restartError = new Error('prior SIGKILL left a service that cannot restart');
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    beginAuthorization: async () => ({
      replayed: false,
      complete: async () => calls.push('ledger-complete'),
      fail: async () => calls.push('ledger-fail')
    }),
    action: async (fields) => verifyRunningProduction('/releases/current', {
      releaseSha: fields.releaseSha,
      legacy: false
    }, fields.runId, {
      startProduction: async () => { calls.push('start-current'); throw restartError; },
      waitUntilReady: async () => assert.fail('readiness ran after restart failure'),
      runSmoke: async () => assert.fail('smoke ran after restart failure')
    })
  }), (error) => error === restartError);
  assert.deepEqual(calls, ['start-current', 'ledger-fail']);
}));

test('an exact completed authorization replay returns the durable result without re-executing', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  let executions = 0;
  const action = async () => {
    executions += 1;
    return { verified: 'a'.repeat(40), activated: false };
  };
  const first = await executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds, expectedUid: process.getuid?.(), action
  });
  const replay = await executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds: nowSeconds + 301,
    expectedUid: process.getuid?.(), action,
    reconcileReplay: async (fields, result) => {
      assert.equal(fields.releaseSha, 'a'.repeat(40));
      assert.deepEqual(result, first);
    }
  });
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
  const [record] = await fs.readdir(ledgerRoot);
  const journal = JSON.parse(await fs.readFile(path.join(ledgerRoot, record), 'utf8'));
  assert.equal(journal.formatVersion, 2);
  assert.equal(journal.status, 'completed');
  assert.equal(journal.resultJson, JSON.stringify(first));
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand, keyring, ledgerRoot, nowSeconds: nowSeconds + 302,
    expectedUid: process.getuid?.(), action,
    reconcileReplay: async () => { throw new Error('cached result no longer matches runtime'); }
  }), /no longer matches runtime/);
  assert.equal(executions, 1);
}));

test('a fresh workflow authorization reconciles the same operation but mismatched artifacts fail closed', async () => ledgerFixture(async (ledgerRoot) => {
  const first = authorization();
  const keyring = new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]);
  await executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand: first.signedCommand, keyring, ledgerRoot, nowSeconds,
    expectedUid: process.getuid?.(), action: async () => ({ verified: first.fields.releaseSha, activated: false })
  });
  const changedFields = { ...first.fields, issuedAt: nowSeconds + 1, expiresAt: nowSeconds + 301 };
  const changedSignature = signDeploymentAuthorization(changedFields, keyPair.privateKey, { nowSeconds: nowSeconds + 1 });
  const changedCommand = `verify ${changedFields.runId} ${changedFields.releaseSha} ${changedFields.artifactSha256} - ${changedFields.issuedAt} ${changedFields.expiresAt} ${changedFields.keyId} ${changedSignature}`;
  const reconciled = await executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand: changedCommand, keyring, ledgerRoot, nowSeconds: nowSeconds + 1,
    expectedUid: process.getuid?.(), action: async () => assert.fail('fresh reconciliation re-executed')
  });
  assert.deepEqual(reconciled, { verified: first.fields.releaseSha, activated: false });

  const conflictingFields = { ...changedFields, artifactSha256: 'c'.repeat(64) };
  const conflictingSignature = signDeploymentAuthorization(conflictingFields, keyPair.privateKey, { nowSeconds: nowSeconds + 1 });
  const conflictingCommand = `verify ${conflictingFields.runId} ${conflictingFields.releaseSha} ${conflictingFields.artifactSha256} - ${conflictingFields.issuedAt} ${conflictingFields.expiresAt} ${conflictingFields.keyId} ${conflictingSignature}`;
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand: conflictingCommand, keyring, ledgerRoot, nowSeconds: nowSeconds + 1,
    expectedUid: process.getuid?.(), action: async () => assert.fail('conflicting replay executed')
  }), /conflicts/i);
}));

test('invalid signatures never execute action code or create a replay record', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const wrong = crypto.generateKeyPairSync('ed25519');
  let executed = false;
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: wrong.publicKey }]]),
    ledgerRoot, nowSeconds, expectedUid: process.getuid?.(), action: async () => { executed = true; }
  }), /signature/i);
  assert.equal(executed, false);
  assert.deepEqual(await fs.readdir(ledgerRoot), []);
}));

test('ledger finalization failure never masks the primary deployment error', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const primary = new Error('primary deployment failure');
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]),
    ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    action: async () => {
      await fs.rm(ledgerRoot, { recursive: true, force: true });
      throw primary;
    }
  }), (error) => error === primary && error.authorizationLedgerError instanceof Error);
}));

test('required cleanup failure finalizes authorization as failed rather than completed', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const cleanupError = new Error('run root could not be removed');
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]),
    ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    action: () => executeWithRequiredRunCleanup({
      action: async () => ({ verified: true }),
      cleanup: async () => { throw cleanupError; }
    })
  }), (error) => error === cleanupError);
  const [record] = await fs.readdir(ledgerRoot);
  assert.equal(JSON.parse(await fs.readFile(path.join(ledgerRoot, record), 'utf8')).status, 'failed');
}));

test('persistent post-action journal failure reconciles, recovers, and never reports success', async () => {
  const { signedCommand } = authorization();
  const calls = [];
  let actionCount = 0;
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify',
    signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]),
    nowSeconds,
    expectedUid: process.getuid?.(),
    beginAuthorization: async () => ({
      replayed: false,
      complete: async () => { calls.push('complete'); throw new Error('persistent journal failure'); },
      fail: async () => { calls.push('fail'); }
    }),
    action: async () => {
      actionCount += 1;
      return { verified: 'a'.repeat(40), activated: false };
    },
    reconcileCompletion: async () => { calls.push('reconcile'); },
    recoverCompletionFailure: async () => { calls.push('recover'); }
  }), (error) => error.deploymentActionCompleted === true && /journal failure/.test(error.message));
  assert.equal(actionCount, 1);
  assert.deepEqual(calls, ['complete', 'reconcile', 'complete', 'recover', 'fail']);
});

test('failed promotion compensation is surfaced as rollback-failed manual recovery', async () => {
  const base = authorization();
  const fields = {
    ...base.fields,
    role: 'production',
    command: 'promote',
    runId: '123-1-production',
    tag: 'v0.1.1',
    keyId: 'production-2026-07'
  };
  const productionKey = crypto.generateKeyPairSync('ed25519');
  const signature = signDeploymentAuthorization(fields, productionKey.privateKey, { nowSeconds });
  const signedCommand = `promote ${fields.runId} ${fields.releaseSha} ${fields.artifactSha256} ${fields.tag} ${fields.issuedAt} ${fields.expiresAt} ${fields.keyId} ${signature}`;
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'promote',
    signedCommand,
    keyring: new Map([[fields.keyId, { role: 'production', publicKey: productionKey.publicKey }]]),
    nowSeconds,
    expectedUid: process.getuid?.(),
    beginAuthorization: async () => ({
      replayed: false,
      complete: async () => { throw new Error('persistent journal failure'); },
      fail: async () => {}
    }),
    action: async () => ({ promoted: fields.releaseSha, tag: fields.tag, backup: `20260712T010203Z-pre-${fields.releaseSha}` }),
    reconcileCompletion: async () => {},
    recoverCompletionFailure: async () => { throw new Error('automatic compensation failed'); }
  }), (error) => error.deploymentStatus === 'rollback-failed' && error.deploymentActionCompleted === true && /compensation failed/.test(error.message));
});
