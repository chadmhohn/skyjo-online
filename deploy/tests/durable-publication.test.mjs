import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupStaleIncomingDirectories,
  cleanupStaleReleaseLinkTemps,
  MAX_EXTRACTED_BYTES,
  MAX_STALE_INCOMING_DIRECTORIES,
  MAX_STALE_LINK_TEMPS,
  STALE_DEPLOYMENT_ARTIFACT_MS,
  fsyncFilesystemPath,
  proveDurablePublishedDirectory,
  publishImmutableDirectory,
  renameDurably,
  replaceSymlink,
  syncTreeDurably
} from '../release-controller-lib.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const activeRunId = '456-1-production';
const staleRunId = '123-1-production';

function trustedTestOperations(overrides = {}) {
  if (process.platform === 'win32') return overrides;
  return { trustedUid: process.getuid(), trustedGid: process.getgid(), ...overrides };
}

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-durable-release-'));
  try { await callback(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function releaseLayout(root, shas = [sha]) {
  const releases = path.join(root, 'releases');
  await fs.mkdir(releases);
  for (const value of shas) await fs.mkdir(path.join(releases, value));
  return { appRoot: root, releasesRoot: releases };
}

test('release trees sync files before their containing directories', async () => fixture(async (root) => {
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'server.mjs'), 'export {}\n');
  const calls = [];
  await syncTreeDurably(root, {
    syncEntry: async (entryPath, { directory }) => {
      const relative = path.relative(root, entryPath).split(path.sep).join('/') || '.';
      calls.push(`${relative}:${directory ? 'directory' : 'file'}`);
    }
  });
  assert.deepEqual(calls, [
    'nested/server.mjs:file',
    'nested:directory',
    '.:directory'
  ]);
}));

test('the production fsync primitive accepts a real file and directory on Linux', {
  skip: process.platform !== 'linux'
}, async () => fixture(async (root) => {
  const file = path.join(root, 'release.json');
  await fs.writeFile(file, '{}\n');
  await fsyncFilesystemPath(file);
  await fsyncFilesystemPath(root, { directory: true });
}));

test('a parent-sync failure reports that a completed rename may be visible', async () => fixture(async (root) => {
  const source = path.join(root, 'incoming');
  const target = path.join(root, 'target');
  await fs.mkdir(source);
  const syncFailure = new Error('injected parent fsync failure');
  await assert.rejects(renameDurably(source, target, {
    syncParent: async () => { throw syncFailure; }
  }), (error) => error === syncFailure && error.renameMayHaveCommitted === true);
  await fs.access(target);
  await assert.rejects(fs.access(source), { code: 'ENOENT' });
}));

test('immutable publication syncs the tree before rename and then syncs its parent', async () => fixture(async (root) => {
  const incoming = path.join(root, 'incoming');
  const target = path.join(root, 'target');
  await fs.mkdir(incoming);
  await fs.writeFile(path.join(incoming, 'release.json'), '{}\n');
  const calls = [];
  await publishImmutableDirectory(incoming, target, {
    syncTree: async (value) => calls.push(`tree:${path.basename(value)}`),
    syncParent: async (value, { directory }) => calls.push(`parent:${path.basename(value)}:${directory}`)
  });
  assert.deepEqual(calls, ['tree:incoming', `parent:${path.basename(root)}:true`]);
  await fs.access(target);
}));

test('a lost first parent-sync acknowledgement is recovered and a visible target is re-proven before reuse', async () => fixture(async (root) => {
  const incoming = path.join(root, 'incoming');
  const target = path.join(root, 'target');
  await fs.mkdir(incoming);
  await fs.writeFile(path.join(incoming, 'release.json'), '{}\n');
  let publicationSyncs = 0;
  await assert.rejects(publishImmutableDirectory(incoming, target, {
    syncTree: async () => {},
    syncParent: async () => {
      publicationSyncs += 1;
      if (publicationSyncs === 1) throw new Error('injected lost parent-sync acknowledgement');
    }
  }), (error) => error.renameMayHaveCommitted === true);
  assert.equal(publicationSyncs, 2, 'publication recovery must retry the parent sync after a committed rename');
  await fs.access(target);

  const proofCalls = [];
  await proveDurablePublishedDirectory(target, {
    syncTree: async (value) => proofCalls.push(`tree:${value}`),
    syncParent: async (value, { directory }) => proofCalls.push(`parent:${value}:${directory}`)
  });
  assert.deepEqual(proofCalls, [`tree:${target}`, `parent:${root}:true`]);
}));

test('persistent publication parent-sync failure is terminal and cannot reach activation', async () => fixture(async (root) => {
  const incoming = path.join(root, 'incoming');
  const target = path.join(root, 'target');
  await fs.mkdir(incoming);
  let activationReached = false;
  let syncAttempts = 0;
  await assert.rejects((async () => {
    await publishImmutableDirectory(incoming, target, {
      syncTree: async () => {},
      syncParent: async () => {
        syncAttempts += 1;
        throw new Error(`persistent parent sync failure ${syncAttempts}`);
      }
    });
    activationReached = true;
  })(), (error) => error instanceof AggregateError && error.errors[0]?.renameMayHaveCommitted === true);
  assert.equal(syncAttempts, 2);
  assert.equal(activationReached, false);
}));

test('failed publication removes its incoming tree and syncs the deletion', async () => fixture(async (root) => {
  const incoming = path.join(root, 'incoming');
  const target = path.join(root, 'target');
  await fs.mkdir(incoming);
  const primary = new Error('injected tree sync failure');
  const calls = [];
  await assert.rejects(publishImmutableDirectory(incoming, target, {
    syncTree: async () => { throw primary; },
    syncParent: async (value, { directory }) => calls.push(`${value}:${directory}`)
  }), (error) => error === primary);
  await assert.rejects(fs.access(incoming), { code: 'ENOENT' });
  assert.deepEqual(calls, [`${root}:true`]);
}));

test('stale release-link temps are unlinked without following targets and the app root is synced', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const target = path.join(releasesRoot, sha);
  const stale = [
    path.join(root, 'current.next-123-aaaaaaaa'),
    path.join(root, 'previous.next-456-bbbbbbbb')
  ];
  const unrelated = path.join(root, 'unrelated-link');
  for (const entry of [...stale, unrelated]) {
    await fs.symlink(target, entry, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const now = Date.now();
  const old = new Date(now - STALE_DEPLOYMENT_ARTIFACT_MS - 1_000);
  for (const entry of stale) await fs.lutimes(entry, old, old);
  const syncs = [];
  const result = await cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot, now }, trustedTestOperations({
    syncParent: async (value, { directory }) => syncs.push(`${value}:${directory}`)
  }));
  assert.deepEqual(result, { candidates: 2, removed: 2 });
  for (const entry of stale) await assert.rejects(fs.lstat(entry), { code: 'ENOENT' });
  await fs.lstat(unrelated);
  await fs.access(target);
  assert.deepEqual(syncs, [`${root}:true`]);
}));

test('link-temp cleanup rejects malformed lookalikes, unsafe objects, escaped targets, and future clocks', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const target = path.join(releasesRoot, sha);
  const now = Date.now();

  const malformed = path.join(root, 'current.next-not-a-valid-temp');
  await fs.writeFile(malformed, 'keep');
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /Malformed/);
  await fs.rm(malformed);

  const unsafe = path.join(root, 'current.next-123-aaaaaaaa');
  await fs.writeFile(unsafe, 'keep');
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /unsafe/);
  assert.equal(await fs.readFile(unsafe, 'utf8'), 'keep');
  await fs.rm(unsafe);

  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /target is unsafe/);
  await fs.rm(unsafe);
  await fs.access(outside);

  await fs.symlink(target, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
  const future = new Date(now + 61_000);
  await fs.lutimes(unsafe, future, future);
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /future/);
  await fs.lstat(unsafe);
}));

test('link-temp cleanup is bounded before it unlinks any candidate', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const target = path.join(releasesRoot, sha);
  for (let index = 0; index <= MAX_STALE_LINK_TEMPS; index += 1) {
    const prefix = index % 2 === 0 ? 'current' : 'previous';
    const name = `${prefix}.next-${index + 1}-${index.toString(16).padStart(8, '0')}`;
    await fs.symlink(target, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot }, trustedTestOperations()), /Too many/);
  assert.equal((await fs.readdir(root)).filter((name) => name.includes('.next-')).length, MAX_STALE_LINK_TEMPS + 1);
}));

test('link-temp cleanup rejects a drifted releases root before enumeration', async () => fixture(async (root) => {
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const releasesRoot = path.join(root, 'releases');
  await fs.symlink(outside, releasesRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupStaleReleaseLinkTemps({ appRoot: root, releasesRoot }, trustedTestOperations()), /release store is not a real directory/);
  await fs.access(outside);
}));

test('SIGKILL during incoming copy or sync is recovered without deleting the active run', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const staleName = `.incoming-${sha}-${staleRunId}`;
  const activeName = `.incoming-${otherSha}-${activeRunId}`;
  const stale = path.join(releasesRoot, staleName);
  const active = path.join(releasesRoot, activeName);
  await fs.mkdir(path.join(stale, 'partial'), { recursive: true });
  await fs.writeFile(path.join(stale, 'partial', 'server.mjs'), 'half copied\n');
  await fs.mkdir(active);
  await fs.writeFile(path.join(active, 'artifact.tmp'), 'active\n');
  const now = Date.now();
  const old = new Date(now - STALE_DEPLOYMENT_ARTIFACT_MS - 1_000);
  await fs.utimes(stale, old, old);
  await fs.utimes(active, old, old);
  const syncs = [];
  const result = await cleanupStaleIncomingDirectories({
    appRoot: root,
    releasesRoot,
    activeRunId,
    activeReleaseSha: otherSha,
    now
  }, trustedTestOperations({
    syncParent: async (value, { directory }) => syncs.push(`${value}:${directory}`)
  }));
  assert.deepEqual(result, { candidates: 2, removed: 1, activePreserved: true });
  await assert.rejects(fs.access(stale), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(active, 'artifact.tmp'), 'utf8'), 'active\n');
  assert.deepEqual(syncs, [`${releasesRoot}:true`]);
}));

test('partial incoming deletion still syncs the release store and aggregates a sync failure', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const candidate = path.join(releasesRoot, `.incoming-${sha}-${staleRunId}`);
  const first = path.join(candidate, 'a-first.txt');
  const second = path.join(candidate, 'b-second.txt');
  await fs.mkdir(candidate);
  await fs.writeFile(first, 'first\n');
  await fs.writeFile(second, 'second\n');
  const now = Date.now();
  const old = new Date(now - STALE_DEPLOYMENT_ARTIFACT_MS - 1_000);
  await fs.utimes(candidate, old, old);
  const primary = new Error('injected second unlink failure');
  const syncFailure = new Error('injected releases-parent fsync failure');
  const syncs = [];
  let unlinkCalls = 0;

  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot, now }, trustedTestOperations({
    unlink: async (entry) => {
      unlinkCalls += 1;
      if (unlinkCalls === 2) throw primary;
      await fs.unlink(entry);
    },
    syncParent: async (entry, { directory }) => {
      syncs.push(`${entry}:${directory}`);
      throw syncFailure;
    }
  })), (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === syncFailure);

  await assert.rejects(fs.access(first), { code: 'ENOENT' });
  assert.equal(await fs.readFile(second, 'utf8'), 'second\n');
  await fs.access(candidate);
  assert.deepEqual(syncs, [`${releasesRoot}:true`]);
}));

test('incoming cleanup rejects malformed and unsafe candidates without recursive deletion', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const malformed = path.join(releasesRoot, '.incoming-bad');
  await fs.mkdir(malformed);
  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot }, trustedTestOperations()), /Malformed/);
  await fs.rmdir(malformed);

  const exact = path.join(releasesRoot, `.incoming-${sha}-${staleRunId}`);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, exact, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot }, trustedTestOperations()), /unsafe/);
  await fs.access(outside);
}));

test('incoming cleanup rejects an oversized tree before mutating any stale candidate', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const first = path.join(releasesRoot, `.incoming-${sha}-${staleRunId}`);
  const oversized = path.join(releasesRoot, `.incoming-${otherSha}-${staleRunId}`);
  await fs.mkdir(first);
  await fs.writeFile(path.join(first, 'keep.txt'), 'must remain\n');
  await fs.mkdir(oversized);
  await fs.writeFile(path.join(oversized, 'oversized.bin'), '');
  await fs.truncate(path.join(oversized, 'oversized.bin'), MAX_EXTRACTED_BYTES + 1);
  const now = Date.now();
  const old = new Date(now - STALE_DEPLOYMENT_ARTIFACT_MS - 1_000);
  await fs.utimes(first, old, old);
  await fs.utimes(oversized, old, old);

  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /byte limit/);
  assert.equal(await fs.readFile(path.join(first, 'keep.txt'), 'utf8'), 'must remain\n');
  assert.equal((await fs.stat(path.join(oversized, 'oversized.bin'))).size, MAX_EXTRACTED_BYTES + 1);
}));

test('incoming cleanup rejects symlinks before mutating another stale candidate or its outside target', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const first = path.join(releasesRoot, `.incoming-${sha}-${staleRunId}`);
  const anomalous = path.join(releasesRoot, `.incoming-${otherSha}-${staleRunId}`);
  const outside = path.join(root, 'outside-target');
  await fs.mkdir(first);
  await fs.writeFile(path.join(first, 'keep.txt'), 'must remain\n');
  await fs.mkdir(anomalous);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside must remain\n');
  await fs.symlink(outside, path.join(anomalous, 'escaped-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const now = Date.now();
  const old = new Date(now - STALE_DEPLOYMENT_ARTIFACT_MS - 1_000);
  await fs.utimes(first, old, old);
  await fs.utimes(anomalous, old, old);

  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot, now }, trustedTestOperations()), /symbolic link/);
  assert.equal(await fs.readFile(path.join(first, 'keep.txt'), 'utf8'), 'must remain\n');
  await fs.lstat(path.join(anomalous, 'escaped-link'));
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside must remain\n');
}));

test('incoming cleanup candidate count is bounded before removal', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  for (let index = 0; index <= MAX_STALE_INCOMING_DIRECTORIES; index += 1) {
    await fs.mkdir(path.join(releasesRoot, `.incoming-${sha}-${index + 1}-1-production`));
  }
  await assert.rejects(cleanupStaleIncomingDirectories({ appRoot: root, releasesRoot }, trustedTestOperations()), /Too many/);
  assert.equal((await fs.readdir(releasesRoot)).filter((name) => name.startsWith('.incoming-')).length, MAX_STALE_INCOMING_DIRECTORIES + 1);
}));

test('own temporary-link cleanup unlinks and syncs after a pre-rename crash', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const current = path.join(root, 'current');
  const target = path.join(releasesRoot, sha);
  const syncs = [];
  await assert.rejects(replaceSymlink(current, target, trustedTestOperations({
    rename: async () => { throw new Error('injected crash before rename'); },
    syncParent: async (value, { directory }) => syncs.push(`${value}:${directory}`)
  })), /injected crash/);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('current.next-')), false);
  assert.deepEqual(syncs, [`${root}:true`]);
}));

test('own temporary cleanup failure is aggregated without losing link uncertainty', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const current = path.join(root, 'current');
  let renameCalls = 0;
  await assert.rejects(replaceSymlink(current, path.join(releasesRoot, sha), trustedTestOperations({
    rename: async () => {
      renameCalls += 1;
      if (renameCalls === 1) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
      throw new Error('fallback rename failed');
    },
    removeLink: async () => {},
    unlinkTemporary: async () => { throw new Error('temp unlink failed'); }
  })), (error) => error instanceof AggregateError && error.linkMayHaveChanged === true &&
    error.errors.some((entry) => /temp unlink failed/.test(entry.message)));
}));

test('a symlink parent-sync failure is marked as a possibly changed live link', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const target = path.join(releasesRoot, sha);
  const current = path.join(root, 'current');
  await assert.rejects(replaceSymlink(current, target, trustedTestOperations({
    syncParent: async () => { throw new Error('injected link parent fsync failure'); }
  })), (error) => error.linkMayHaveChanged === true && error.renameMayHaveCommitted === true);
  assert.equal(await fs.readlink(current), target);
}));

test('real Windows junction replacement uses the guarded EPERM fallback', {
  skip: process.platform !== 'win32'
}, async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root, [sha, otherSha]);
  const first = path.join(releasesRoot, sha);
  const second = path.join(releasesRoot, otherSha);
  const current = path.join(root, 'current');
  await replaceSymlink(current, first, trustedTestOperations());
  await replaceSymlink(current, second, trustedTestOperations());
  assert.equal(path.resolve(await fs.readlink(current)), path.resolve(second));
}));

test('EPERM never removes a live link outside Windows', {
  skip: process.platform === 'win32'
}, async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  let removeCalls = 0;
  await assert.rejects(replaceSymlink(path.join(root, 'current'), path.join(releasesRoot, sha), trustedTestOperations({
    createSymlink: async () => {},
    rename: async () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
    removeLink: async () => { removeCalls += 1; }
  })), (error) => error.code === 'EPERM' && error.linkMayHaveChanged !== true);
  assert.equal(removeCalls, 0);
}));

test('fallback replacement marks failure after removing the old link as uncertain', async () => fixture(async (root) => {
  const { releasesRoot } = await releaseLayout(root);
  const current = path.join(root, 'current');
  let renameCalls = 0;
  const calls = [];
  await assert.rejects(replaceSymlink(current, path.join(releasesRoot, sha), trustedTestOperations({
    createSymlink: async () => calls.push('create'),
    removeLink: async () => calls.push('remove'),
    rename: async () => {
      renameCalls += 1;
      calls.push(`rename:${renameCalls}`);
      if (renameCalls === 1) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
      throw new Error('injected fallback rename failure');
    }
  })), (error) => error.linkMayHaveChanged === true);
  assert.deepEqual(calls, ['create', 'rename:1', 'remove', 'rename:2']);
}));
