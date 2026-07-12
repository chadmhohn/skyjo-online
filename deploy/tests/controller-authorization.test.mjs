import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signDeploymentAuthorization } from '../deployment-authorization-lib.mjs';
import { executeAuthorizedControllerAction, executeWithRunCleanup } from '../release-controller.mjs';

const nowSeconds = 1_800_000_000;
const keyId = 'canary-primary';
const keyPair = crypto.generateKeyPairSync('ed25519');

function authorization() {
  const fields = {
    role: 'canary',
    command: 'verify',
    runId: '123-1-canary',
    releaseSha: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    artifactBytes: 4096,
    tag: '-',
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 300,
    keyId
  };
  const signature = signDeploymentAuthorization(fields, keyPair.privateKey, { nowSeconds });
  return {
    fields,
    signedCommand: `verify ${fields.runId} ${fields.releaseSha} ${fields.artifactSha256} ${fields.artifactBytes} - ${fields.issuedAt} ${fields.expiresAt} ${fields.keyId} ${signature}`
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

test('ordinary action failures terminalize the authorization ledger', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const primary = new Error('injected action failure');
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]),
    ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    action: async () => { throw primary; }
  }), (error) => error === primary);
  const records = await fs.readdir(ledgerRoot);
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(ledgerRoot, records[0]), 'utf8')).status, 'failed');
}));

test('run cleanup failures terminalize the authorization ledger', async () => ledgerFixture(async (ledgerRoot) => {
  const { signedCommand } = authorization();
  const cleanup = new Error('injected cleanup failure');
  await assert.rejects(executeAuthorizedControllerAction({
    expectedCommand: 'verify', signedCommand,
    keyring: new Map([[keyId, { role: 'canary', publicKey: keyPair.publicKey }]]),
    ledgerRoot, nowSeconds, expectedUid: process.getuid?.(),
    action: () => executeWithRunCleanup({
      runId: '123-1-canary',
      workDirectory: '/var/tmp/skyjo-deploy/123-1-canary',
      action: async () => ({ verified: 'a'.repeat(40), activated: false }),
      cleanup: async () => { throw cleanup; }
    })
  }), (error) => error === cleanup);
  const records = await fs.readdir(ledgerRoot);
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(ledgerRoot, records[0]), 'utf8')).status, 'failed');
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
