import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DeploymentAuthorizationError,
  beginAuthorizationUse,
  canonicalAuthorizationPayload,
  loadAuthorizationPublicKey,
  parseSignedDeploymentCommand,
  signDeploymentAuthorization,
  verifyDeploymentAuthorization
} from '../deployment-authorization-lib.mjs';
import { createSignedAuthorization } from '../sign-deployment-authorization.mjs';

const now = 1_800_000_000;
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const canary = crypto.generateKeyPairSync('ed25519');
const production = crypto.generateKeyPairSync('ed25519');

function fields(overrides = {}) {
  return {
    role: 'canary',
    command: 'verify',
    runId: '123-1-canary',
    releaseSha: sha,
    artifactSha256: digest,
    tag: '-',
    issuedAt: now,
    expiresAt: now + 300,
    keyId: 'canary-2026-07',
    ...overrides
  };
}

function sign(value, key = canary.privateKey) {
  return signDeploymentAuthorization(value, key, { nowSeconds: now });
}

test('canonical payload is fixed ASCII with one final LF', () => {
  const payload = canonicalAuthorizationPayload(fields(), { nowSeconds: now });
  assert.equal(payload.endsWith('\n'), true);
  assert.equal(payload.endsWith('\n\n'), false);
  assert.match(payload, /^domain=skyjo-online-deployment-authorization\/v1\nrepository=chadmhohn\/skyjo-online\n/);
  assert.equal(Buffer.byteLength(payload, 'ascii'), payload.length);
});

test('lane-specific Ed25519 keys verify only their allowed actions', async () => {
  const keyring = new Map([
    ['canary-2026-07', { role: 'canary', publicKey: canary.publicKey }],
    ['production-2026-07', { role: 'production', publicKey: production.publicKey }]
  ]);
  const canaryFields = fields();
  assert.equal((await verifyDeploymentAuthorization({ fields: canaryFields, signature: sign(canaryFields), keyring, nowSeconds: now })).fields.command, 'verify');
  const productionFields = fields({
    role: 'production', command: 'promote', runId: '123-1-production', tag: 'v0.1.1', keyId: 'production-2026-07'
  });
  const signature = signDeploymentAuthorization(productionFields, production.privateKey, { nowSeconds: now });
  assert.equal((await verifyDeploymentAuthorization({ fields: productionFields, signature, keyring, nowSeconds: now })).fields.role, 'production');
  const rollbackFields = { ...productionFields, command: 'rollback' };
  const rollbackSignature = signDeploymentAuthorization(rollbackFields, production.privateKey, { nowSeconds: now });
  assert.equal((await verifyDeploymentAuthorization({ fields: rollbackFields, signature: rollbackSignature, keyring, nowSeconds: now })).fields.command, 'rollback');
  await assert.rejects(
    verifyDeploymentAuthorization({ fields: canaryFields, signature: sign(canaryFields), keyring: new Map([['canary-2026-07', { role: 'production', publicKey: canary.publicKey }]]), nowSeconds: now }),
    /not trusted/
  );
});

test('every signed field mutation is rejected', async () => {
  const original = fields();
  const signature = sign(original);
  const keyring = { 'canary-2026-07': { role: 'canary', publicKey: canary.publicKey } };
  const mutations = [
    { releaseSha: 'c'.repeat(40) }, { artifactSha256: 'd'.repeat(64) }, { runId: '124-1-canary' },
    { issuedAt: now + 1 }, { expiresAt: now + 301 }
  ];
  for (const mutation of mutations) {
    await assert.rejects(verifyDeploymentAuthorization({ fields: fields(mutation), signature, keyring, nowSeconds: now }), DeploymentAuthorizationError);
  }
  for (const invalid of [
    fields({ role: 'production' }), fields({ command: 'promote' }), fields({ tag: 'v0.1.1' }), fields({ keyId: 'production-2026-07' })
  ]) {
    await assert.rejects(verifyDeploymentAuthorization({ fields: invalid, signature, keyring, nowSeconds: now }), DeploymentAuthorizationError);
  }
});

test('freshness, lifetime, signature encoding, and command whitespace fail closed', async () => {
  const value = fields();
  const signature = sign(value);
  const keyring = { 'canary-2026-07': { role: 'canary', publicKey: canary.publicKey } };
  await assert.rejects(verifyDeploymentAuthorization({ fields: value, signature, keyring, nowSeconds: now + 300 }), /expired/);
  await assert.rejects(verifyDeploymentAuthorization({ fields: fields({ issuedAt: now + 61, expiresAt: now + 300 }), signature, keyring, nowSeconds: now }), /not yet/);
  await assert.rejects(verifyDeploymentAuthorization({ fields: fields({ expiresAt: now + 601 }), signature, keyring, nowSeconds: now }), /lifetime/);
  await assert.rejects(verifyDeploymentAuthorization({ fields: value, signature: `${signature.slice(0, -1)}+`, keyring, nowSeconds: now }), /signature/);
  await assert.rejects(verifyDeploymentAuthorization({ fields: value, signature: `${signature.slice(0, -1)}${signature.at(-1) === 'A' ? 'B' : 'A'}`, keyring, nowSeconds: now }), DeploymentAuthorizationError);
  await assert.rejects(verifyDeploymentAuthorization({ fields: fields({ keyId: 'canary-revoked' }), signature, keyring, nowSeconds: now }), /not trusted/);
  const command = `verify ${value.runId} ${value.releaseSha} ${value.artifactSha256} - ${value.issuedAt} ${value.expiresAt} ${value.keyId} ${signature}`;
  assert.equal(parseSignedDeploymentCommand(command, { nowSeconds: now }).fields.command, 'verify');
  for (const malformed of [` ${command}`, `${command} `, command.replace('verify ', 'verify  '), `${command}\n`, command.replace('verify', 'verif\té')]) {
    assert.throws(() => parseSignedDeploymentCommand(malformed, { nowSeconds: now }), DeploymentAuthorizationError);
  }
  for (const malformed of [`${command}\0`, command.split(' ').slice(0, -1).join(' '), `${command}${'x'.repeat(513)}`]) {
    assert.throws(() => parseSignedDeploymentCommand(malformed, { nowSeconds: now }), DeploymentAuthorizationError);
  }
});

test('public key files require safe ownership and permissions', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-auth-key-'));
  try {
    const keyPath = path.join(root, 'canary.pem');
    await fs.writeFile(keyPath, canary.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const uid = process.getuid?.();
    assert.equal((await loadAuthorizationPublicKey(keyPath, { expectedUid: uid })).asymmetricKeyType, 'ed25519');
    if (process.platform !== 'win32') {
      await fs.chmod(keyPath, 0o666);
      await assert.rejects(loadAuthorizationPublicKey(keyPath, { expectedUid: uid }), DeploymentAuthorizationError);
    } else context.diagnostic('POSIX mode rejection is exercised in Linux CI.');

    const symlinkPath = path.join(root, 'linked.pem');
    try {
      await fs.symlink(keyPath, symlinkPath, 'file');
      await assert.rejects(loadAuthorizationPublicKey(symlinkPath, { expectedUid: uid }), DeploymentAuthorizationError);
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      context.diagnostic('Public-key symlink rejection is exercised in Linux CI.');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('signer reads a safe Ed25519 private key and rejects the wrong key type', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-auth-signer-'));
  try {
    const privatePath = path.join(root, 'canary-private.pem');
    await fs.writeFile(privatePath, canary.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const result = await createSignedAuthorization([
      '--role', 'canary', '--command', 'verify', '--run-id', '555-1-canary',
      '--release-sha', sha, '--artifact-sha256', digest, '--tag', '-',
      '--key-id', 'canary-2026-07', '--private-key', privatePath, '--lifetime-seconds', '300'
    ], { nowSeconds: now, expectedUid: process.getuid?.() });
    assert.equal(result.signature.length, 86);
    await verifyDeploymentAuthorization({
      fields: fields({ runId: '555-1-canary', issuedAt: result.issuedAt, expiresAt: result.expiresAt }),
      signature: result.signature,
      keyring: { 'canary-2026-07': { role: 'canary', publicKey: canary.publicKey } },
      nowSeconds: now
    });

    const rsaPath = path.join(root, 'rsa-private.pem');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await fs.writeFile(rsaPath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await assert.rejects(createSignedAuthorization([
      '--role', 'canary', '--command', 'verify', '--run-id', '555-2-canary',
      '--release-sha', sha, '--artifact-sha256', digest, '--tag', '-',
      '--key-id', 'canary-2026-07', '--private-key', rsaPath
    ], { nowSeconds: now, expectedUid: process.getuid?.() }), DeploymentAuthorizationError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('replay ledger consumes once and a new run attempt is independent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-auth-ledger-'));
  try {
    if (process.platform !== 'win32') await fs.chmod(root, 0o700);
    const value = fields();
    const payloadSha256 = crypto.createHash('sha256').update(canonicalAuthorizationPayload(value, { nowSeconds: now }), 'ascii').digest('hex');
    const first = await beginAuthorizationUse({ ledgerRoot: root, fields: value, payloadSha256, nowSeconds: now, expectedUid: process.getuid?.() });
    await assert.rejects(beginAuthorizationUse({ ledgerRoot: root, fields: value, payloadSha256, nowSeconds: now, expectedUid: process.getuid?.() }), /already consumed/);
    await assert.rejects(beginAuthorizationUse({
      ledgerRoot: root,
      fields: fields({ artifactSha256: 'c'.repeat(64) }),
      payloadSha256: crypto.createHash('sha256').update('conflict').digest('hex'),
      nowSeconds: now,
      expectedUid: process.getuid?.()
    }), /already consumed/);
    await first.complete();
    await assert.rejects(first.fail(), /already finalized/);
    assert.equal(JSON.parse(await fs.readFile(first.recordPath, 'utf8')).status, 'completed');
    const retry = await beginAuthorizationUse({
      ledgerRoot: root,
      fields: fields({ runId: '123-2-canary' }),
      payloadSha256: crypto.createHash('sha256').update('retry').digest('hex'),
      nowSeconds: now,
      expectedUid: process.getuid?.()
    });
    await retry.fail();
    assert.equal(JSON.parse(await fs.readFile(retry.recordPath, 'utf8')).status, 'failed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('replay ledger rejects unsafe roots and concurrent consumption has one winner', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-auth-ledger-race-'));
  const root = path.join(parent, 'ledger');
  await fs.mkdir(root, { mode: 0o700 });
  try {
    const value = fields({ runId: '987-1-canary' });
    const payloadSha256 = crypto.createHash('sha256').update(canonicalAuthorizationPayload(value, { nowSeconds: now }), 'ascii').digest('hex');
    const attempts = await Promise.allSettled([
      beginAuthorizationUse({ ledgerRoot: root, fields: value, payloadSha256, nowSeconds: now, expectedUid: process.getuid?.() }),
      beginAuthorizationUse({ ledgerRoot: root, fields: value, payloadSha256, nowSeconds: now, expectedUid: process.getuid?.() })
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    await attempts.find((attempt) => attempt.status === 'fulfilled').value.complete();

    if (process.platform !== 'win32') {
      const unsafe = path.join(parent, 'unsafe');
      await fs.mkdir(unsafe, { mode: 0o755 });
      await assert.rejects(beginAuthorizationUse({
        ledgerRoot: unsafe,
        fields: fields({ runId: '987-2-canary' }),
        payloadSha256,
        nowSeconds: now,
        expectedUid: process.getuid?.()
      }), DeploymentAuthorizationError);
    } else context.diagnostic('Unsafe POSIX ledger mode is exercised in Linux CI.');

    const link = path.join(parent, 'ledger-link');
    try {
      await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(beginAuthorizationUse({
        ledgerRoot: link,
        fields: fields({ runId: '987-3-canary' }),
        payloadSha256,
        nowSeconds: now,
        expectedUid: process.getuid?.()
      }), DeploymentAuthorizationError);
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      context.diagnostic('Ledger symlink rejection is exercised in Linux CI.');
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
