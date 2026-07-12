import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '../release-controller.mjs';
import {
  authorizeRollback,
  executeActivationTransaction,
  loadVerifiedReleaseIdentity,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_EXTRACTED_BYTES,
  MAX_FILE_BYTES,
  normalizeArchiveEntry,
  REQUIRED_ARCHIVE_ENTRIES,
  readLinkWithin,
  replaceSymlink,
  resolveGithubTag,
  resolveWithin,
  selectReleasePathsToPrune,
  validateArchiveListing,
  validateReleaseTag,
  validateRunId
} from '../release-controller-lib.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const signature = 'A'.repeat(86);
const issuedAt = '1800000000';
const expiresAt = '1800000300';
const required = ['./', ...REQUIRED_ARCHIVE_ENTRIES];
const regularLine = '-rw-r--r-- 0/0 1 2026-07-11 00:00:00 file';

test('deployment identifiers and command lanes are strict', () => {
  assert.equal(validateRunId('123-1-canary'), '123-1-canary');
  assert.equal(validateReleaseTag('v0.2.0'), 'v0.2.0');
  assert.throws(() => validateRunId('../x'), /Invalid/);
  assert.throws(() => validateReleaseTag('latest'), /Invalid/);
  const signedCommand = `verify 123-1-canary ${sha} ${digest} 4096 - ${issuedAt} ${expiresAt} canary-primary ${signature}`;
  assert.deepEqual(parseArguments(['verify', '--authorization-command', signedCommand]), { command: 'verify', signedCommand });
  const uploadCommand = signedCommand.replace(/^verify /, 'upload ');
  assert.deepEqual(parseArguments(['upload', '--authorization-command', uploadCommand]), { command: 'upload', signedCommand: uploadCommand });
  assert.deepEqual(parseArguments(['self-test']), { command: 'self-test' });
  assert.throws(() => parseArguments(['verify']), /signed deployment authorization/i);
  assert.throws(() => parseArguments(['verify', '--authorization-command', signedCommand, 'extra']), /signed deployment authorization/i);
  assert.throws(() => parseArguments(['self-test', '--authorization-command', signedCommand]), /takes no arguments/i);
});

test('path and archive validation reject traversal, links, duplicates, and forbidden secrets', () => {
  assert.deepEqual({ MAX_ARCHIVE_BYTES, MAX_EXTRACTED_BYTES, MAX_FILE_BYTES, MAX_ARCHIVE_ENTRIES }, {
    MAX_ARCHIVE_BYTES: 16 * 1024 * 1024,
    MAX_EXTRACTED_BYTES: 24 * 1024 * 1024,
    MAX_FILE_BYTES: 4 * 1024 * 1024,
    MAX_ARCHIVE_ENTRIES: 4096
  });
  assert.equal(normalizeArchiveEntry('./dist/index.html'), 'dist/index.html');
  assert.throws(() => normalizeArchiveEntry('../secret'), /traversal/);
  assert.throws(() => normalizeArchiveEntry('C:\\secret'), /invalid|absolute/);
  assert.throws(() => normalizeArchiveEntry('.env.production'), /forbidden/);
  assert.throws(() => resolveWithin('/srv/releases', '..', 'etc'), /escapes/);
  const verbose = required.map((entry) => entry === './' ? 'drwxr-xr-x 0/0 0 2026-07-11 00:00:00 ./' : regularLine);
  assert.equal(validateArchiveListing(required, verbose).entries.has('server.mjs'), true);
  const linked = [...verbose];
  linked[1] = 'lrwxrwxrwx 0/0 0 2026-07-11 00:00 release.json -> /etc/passwd';
  assert.throws(() => validateArchiveListing(required, linked), /not a regular file/);
  assert.throws(() => validateArchiveListing([...required, 'server.mjs'], [...verbose, regularLine]), /duplicate/);
  const oversized = [...verbose];
  oversized[1] = `-rw-r--r-- 0/0 ${MAX_FILE_BYTES + 1} 2026-07-11 00:00:00 release.json`;
  assert.throws(() => validateArchiveListing(required, oversized), /too large/);
});

test('root and served release identities must match and verify checksums', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-release-'));
  try {
    const dist = path.join(root, 'dist');
    await fs.mkdir(dist);
    const data = `${JSON.stringify({ formatVersion: 1, releaseSha: sha, buildTimestamp: '2026-07-11T00:00:00.000Z', schemaVersion: 2, protocolVersion: 1 }, null, 2)}\n`;
    const checksum = `${crypto.createHash('sha256').update(data).digest('hex')}  release.json\n`;
    await Promise.all([
      fs.writeFile(path.join(root, 'release.json'), data), fs.writeFile(path.join(root, 'release.json.sha256'), checksum),
      fs.writeFile(path.join(dist, 'release.json'), data), fs.writeFile(path.join(dist, 'release.json.sha256'), checksum)
    ]);
    assert.equal((await loadVerifiedReleaseIdentity(root, sha)).releaseSha, sha);
    await fs.writeFile(path.join(dist, 'release.json'), `${data} `);
    await assert.rejects(loadVerifiedReleaseIdentity(root, sha), /differ/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('release symlink swaps remain within the release store', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-links-'));
  try {
    const releases = path.join(root, 'releases');
    const target = path.join(releases, sha);
    await fs.mkdir(target, { recursive: true });
    const current = path.join(root, 'current');
    await replaceSymlink(current, target);
    assert.equal(await readLinkWithin(current, releases), target);
    await fs.rm(current, { force: true });
    await fs.symlink(path.dirname(root), current, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readLinkWithin(current, releases), /outside|escapes/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('GitHub tag verification follows annotated tags and requires a commit', async () => {
  const responses = [
    { ok: true, json: async () => ({ object: { type: 'tag', sha: 'c'.repeat(40) } }) },
    { ok: true, json: async () => ({ object: { type: 'commit', sha } }) }
  ];
  assert.equal(await resolveGithubTag('v0.2.0', async () => responses.shift()), sha);
  await assert.rejects(resolveGithubTag('v0.2.0', async () => ({ ok: false, status: 503 })), /503/);
});

test('activation failures select restart-before-swap or rollback-after-swap without state restore', async () => {
  const beforeSwap = [];
  await assert.rejects(executeActivationTransaction({
    stop: async () => beforeSwap.push('stop'), prepare: async () => { throw new Error('prepare failed'); },
    swap: async () => beforeSwap.push('swap'), start: async () => beforeSwap.push('start'), verify: async () => {},
    rollback: async () => beforeSwap.push('rollback'), restartPrevious: async () => beforeSwap.push('restart-previous')
  }), (error) => error.message === 'prepare failed' && error.activationRolledBack === false);
  assert.deepEqual(beforeSwap, ['stop', 'restart-previous']);

  const afterSwap = [];
  await assert.rejects(executeActivationTransaction({
    stop: async () => afterSwap.push('stop'), prepare: async () => afterSwap.push('prepare'),
    swap: async () => afterSwap.push('swap'), start: async () => afterSwap.push('start'),
    verify: async () => { throw new Error('smoke failed'); }, rollback: async () => afterSwap.push('rollback'),
    restartPrevious: async () => afterSwap.push('restart-previous')
  }), (error) => error.message === 'smoke failed' && error.activationRolledBack === true);
  assert.deepEqual(afterSwap, ['stop', 'prepare', 'swap', 'start', 'rollback']);
});

test('public rollback authorization is exact and release retention keeps five including both links', () => {
  const metadata = { releaseSha: sha, artifactSha256: digest, artifactBytes: 4096, tag: 'v0.2.0' };
  assert.equal(authorizeRollback({ currentReleaseSha: sha, metadata, requestedReleaseSha: sha, requestedDigest: digest, requestedBytes: 4096, requestedTag: 'v0.2.0' }), true);
  assert.throws(() => authorizeRollback({ currentReleaseSha: sha, metadata, requestedReleaseSha: sha, requestedDigest: 'c'.repeat(64), requestedBytes: 4096, requestedTag: 'v0.2.0' }), /does not match/);
  assert.throws(() => authorizeRollback({ currentReleaseSha: sha, metadata, requestedReleaseSha: sha, requestedDigest: digest, requestedBytes: 4097, requestedTag: 'v0.2.0' }), /does not match/);
  const entries = Array.from({ length: 8 }, (_, index) => ({ path: `/releases/${index}`, mtimeMs: index }));
  assert.deepEqual(selectReleasePathsToPrune(entries, ['/releases/7', '/releases/6'], 5), ['/releases/2', '/releases/1', '/releases/0']);
});

test('operational assets keep the safety contracts explicit', async () => {
  const deploy = path.resolve(import.meta.dirname, '..');
  const [wrapper, bootstrap, service, canary, canarySmoke, productionSmoke, stateProof, stateProofLauncher, controller, sudoers] = await Promise.all([
    fs.readFile(path.join(deploy, 'skyjo-release-controller'), 'utf8'),
    fs.readFile(path.join(deploy, 'bootstrap-skyjo-delivery.sh'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-canary@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-canary-smoke@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-smoke@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-online-state-proof@.service'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-state-proof-launch'), 'utf8'),
    fs.readFile(path.join(deploy, 'release-controller.mjs'), 'utf8'),
    fs.readFile(path.join(deploy, 'skyjo-deploy.sudoers'), 'utf8')
  ]);
  assert.match(wrapper, /flock --exclusive --nonblock/);
  assert.match(bootstrap, /Prepared Skyjo delivery assets\. The live production unit was not replaced/);
  assert.match(bootstrap, /skyjo_install_node_archive/);
  assert.match(bootstrap, /node-v\$NODE_VERSION-linux-x64/);
  assert.match(bootstrap, /Legacy rollback snapshot contains a symbolic link/);
  assert.match(service, /User=skyjo/);
  assert.match(service, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.match(canary, /^User=skyjo-canary$/m);
  assert.match(canary, /EnvironmentFile=\/run\/skyjo-online-canary\/%i\.env/);
  assert.doesNotMatch(canary, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(canary, /^IPAddressDeny=any$/m);
  assert.match(canary, /^IPAddressAllow=localhost$/m);
  assert.doesNotMatch(canary, /^PrivateTmp=true$/m);
  assert.match(canarySmoke, /^User=skyjo-canary$/m);
  assert.doesNotMatch(canarySmoke, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(productionSmoke, /^User=skyjo$/m);
  assert.match(productionSmoke, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.match(stateProof, /^User=skyjo-canary$/m);
  assert.match(stateProof, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.doesNotMatch(stateProof, /^PrivateTmp=true$/m);
  assert.match(stateProofLauncher, /"\$release\/scripts\/backup-state\.mjs"/);
  assert.match(stateProofLauncher, /"\$release\/scripts\/verify-state-backup\.mjs"/);
  assert.match(controller, /SKYJO_VAPID_PRIVATE_KEY=/);
  assert.match(controller, /\['root:skyjo-canary', runDirectory\]/);
  assert.doesNotMatch(controller, /run\(PATHS\.node, \[resolveWithin\(releaseDirectory, 'scripts\//);
  assert.match(sudoers, /^skyjo-deploy .*NOPASSWD: \/usr\/local\/sbin\/skyjo-release-controller \*$/m);
});
