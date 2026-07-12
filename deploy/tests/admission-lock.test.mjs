import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADMISSION_LOCK_NAME,
  acquireAdmissionLock,
  combineAdmissionLockErrors,
  isAdmissionLockConflict
} from '../admission-lock.mjs';
import { invokeDirectController } from '../release-controller.mjs';

async function fixture(callback) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-admission-lock-'));
  const root = path.join(fixtureRoot, 'stage');
  const lockParent = path.join(fixtureRoot, 'lock-parent');
  const lockPath = path.join(lockParent, ADMISSION_LOCK_NAME);
  try {
    await fs.mkdir(root, { mode: 0o700 });
    await fs.mkdir(lockParent, { mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(root, 0o700);
      await fs.chmod(lockParent, 0o700);
    }
    await fs.writeFile(lockPath, '', { mode: 0o640, flag: 'wx' });
    if (process.platform !== 'win32') await fs.chmod(lockPath, 0o640);
    const rootStat = await fs.lstat(root);
    const lockParentStat = await fs.lstat(lockParent);
    const lockStat = await fs.lstat(lockPath);
    await callback({
      root,
      lockPath,
      stageRootContract: { uid: rootStat.uid, gid: rootStat.gid, mode: rootStat.mode & 0o7777 },
      lockParentContract: { uid: lockParentStat.uid, gid: lockParentStat.gid, mode: lockParentStat.mode & 0o7777 },
      lockContract: { uid: lockStat.uid, gid: lockStat.gid, mode: 0o640 }
    });
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

test('the persistent lock validates exact file and root contracts without replacing its inode', async () => fixture(async (options) => {
  const before = await fs.lstat(options.lockPath);
  let runnerCalls = 0;
  const admission = await acquireAdmissionLock(options.root, {
    ...options,
    lockRunner: async (_handle, { conflictExitCode }) => {
      runnerCalls += 1;
      assert.equal(conflictExitCode, 75);
    }
  });
  await admission.assertHeld();
  await admission.release();
  const after = await fs.lstat(options.lockPath);
  assert.equal(runnerCalls, 1);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, 0);
}));

test('missing, writable, nonempty, multiply-linked, foreign-contract, and symlink locks fail closed', async (context) => fixture(async (options) => {
  await fs.rm(options.lockPath);
  await assert.rejects(acquireAdmissionLock(options.root, options), /ENOENT|no such file/i);
  await fs.writeFile(options.lockPath, '', { mode: 0o640, flag: 'wx' });
  if (process.platform !== 'win32') await fs.chmod(options.lockPath, 0o660);
  if (process.platform !== 'win32') {
    await assert.rejects(acquireAdmissionLock(options.root, options), /unsafe/);
    await fs.chmod(options.lockPath, 0o644);
    await assert.rejects(acquireAdmissionLock(options.root, options), /unsafe/);
    await fs.chmod(options.lockPath, 0o640);
  }
  await fs.writeFile(options.lockPath, 'x');
  await assert.rejects(acquireAdmissionLock(options.root, options), /unsafe/);
  await fs.truncate(options.lockPath, 0);
  const hardLink = `${options.lockPath}.hardlink`;
  await fs.link(options.lockPath, hardLink);
  await assert.rejects(acquireAdmissionLock(options.root, options), /unsafe/);
  await fs.unlink(hardLink);
  await assert.rejects(acquireAdmissionLock(options.root, {
    ...options,
    lockContract: { ...options.lockContract, uid: options.lockContract.uid + 1 }
  }), /unsafe/);
  await assert.rejects(acquireAdmissionLock(options.root, {
    ...options,
    lockContract: { ...options.lockContract, gid: options.lockContract.gid + 1 }
  }), /unsafe/);
  if (process.platform !== 'win32') {
    const original = `${options.lockPath}.original`;
    await fs.rename(options.lockPath, original);
    await fs.symlink(original, options.lockPath);
    await assert.rejects(acquireAdmissionLock(options.root, options));
    assert.equal((await fs.lstat(original)).size, 0);
  } else context.diagnostic('O_NOFOLLOW admission-lock symlink rejection is exercised in Linux CI.');
}));

test('stage-root drift between contract capture and acquisition fails closed', { skip: process.platform === 'win32' }, async () => fixture(async (options) => {
  await fs.chmod(options.root, 0o755);
  await assert.rejects(acquireAdmissionLock(options.root, options), /staging root/);
}));

test('lock-parent mode drift and symlink substitution fail before the file is opened', { skip: process.platform === 'win32' }, async () => fixture(async (options) => {
  const lockParent = path.dirname(options.lockPath);
  await fs.chmod(lockParent, 0o755);
  await assert.rejects(acquireAdmissionLock(options.root, options), /lock parent/);
  await fs.chmod(lockParent, options.lockParentContract.mode);
  const originalParent = `${lockParent}.original`;
  await fs.rename(lockParent, originalParent);
  await fs.symlink(originalParent, lockParent, 'dir');
  await assert.rejects(acquireAdmissionLock(options.root, options), /lock parent|unsafe component/);
}));

test('path substitution during acquisition never accepts or removes the replacement inode', { skip: process.platform === 'win32' }, async () => fixture(async (options) => {
  const original = `${options.lockPath}.original`;
  await assert.rejects(acquireAdmissionLock(options.root, {
    ...options,
    lockRunner: async () => {
      await fs.rename(options.lockPath, original);
      await fs.writeFile(options.lockPath, '', { mode: 0o640, flag: 'wx' });
      await fs.chmod(options.lockPath, 0o640);
    }
  }), /identity changed/);
  const [oldStat, replacementStat] = await Promise.all([fs.lstat(original), fs.lstat(options.lockPath)]);
  assert.notEqual(oldStat.ino, replacementStat.ino);
  assert.equal(oldStat.size, 0);
  assert.equal(replacementStat.size, 0);
}));

test('inherited-FD flock remains held after the helper exits and honors lane conflict codes', { skip: process.platform !== 'linux' }, async () => fixture(async (options) => {
  assert.equal(isAdmissionLockConflict({ exitCode: 73 }, 73), false);
  const first = await acquireAdmissionLock(options.root, options);
  await assert.rejects(acquireAdmissionLock(options.root, options), (error) =>
    error.exitCode === 75 && isAdmissionLockConflict(error, 75) && !isAdmissionLockConflict(error, 73));
  let controllerConflict;
  await assert.rejects(acquireAdmissionLock(options.root, { ...options, conflictExitCode: 73 }), (error) => {
    controllerConflict = error;
    return error.exitCode === 73 && isAdmissionLockConflict(error, 73);
  });
  const previousExitCode = process.exitCode;
  try {
    for (const command of ['verify', 'promote', 'rollback']) {
      process.exitCode = undefined;
      await invokeDirectController(
        async () => { throw controllerConflict; },
        ['node', 'release-controller.mjs', command],
        { setIntervalImpl: () => ({ ref() {} }), clearIntervalImpl() {} }
      );
      assert.equal(process.exitCode, 73);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
  await first.release();
  const afterRelease = await acquireAdmissionLock(options.root, options);
  await afterRelease.release();
}));

test('identity failure during release still closes the inherited FD for the replacement contender', { skip: process.platform !== 'linux' }, async () => fixture(async (options) => {
  const admission = await acquireAdmissionLock(options.root, options);
  const original = `${options.lockPath}.original`;
  await fs.rename(options.lockPath, original);
  await fs.writeFile(options.lockPath, '', { mode: 0o640, flag: 'wx' });
  await fs.chmod(options.lockPath, 0o640);
  await assert.rejects(admission.release(), /identity changed/);
  const contender = await acquireAdmissionLock(options.root, options);
  await contender.release();
}));

test('a visible close failure never reports successful release', async () => fixture(async (options) => {
  const closeError = Object.assign(new Error('injected admission close failure'), { code: 'EIO' });
  const admission = await acquireAdmissionLock(options.root, {
    ...options,
    lockRunner: async () => {},
    closeLock: async (handle) => {
      await handle.close();
      throw closeError;
    }
  });
  await assert.rejects(admission.release(), (error) => error === closeError);
  const retry = await acquireAdmissionLock(options.root, { ...options, lockRunner: async () => {} });
  await retry.release();
}));

test('identity and close failures aggregate and acquisition cleanup never masks its primary error', async () => fixture(async (options) => {
  const identityCloseError = new Error('identity close failed');
  let identityHandle;
  const admission = await acquireAdmissionLock(options.root, {
    ...options,
    lockRunner: async () => {},
    closeLock: async (handle) => {
      identityHandle = handle;
      throw identityCloseError;
    }
  });
  const original = `${options.lockPath}.identity-original`;
  await fs.rename(options.lockPath, original);
  await fs.writeFile(options.lockPath, '', { mode: 0o640, flag: 'wx' });
  if (process.platform !== 'win32') await fs.chmod(options.lockPath, 0o640);
  await assert.rejects(admission.release(), (error) => error instanceof AggregateError &&
    error.errors[1] === identityCloseError && /identity changed/.test(error.errors[0].message));
  await identityHandle.close();

  const primary = new Error('injected flock helper failure');
  const cleanup = new Error('injected acquisition close failure');
  let acquisitionHandle;
  await assert.rejects(acquireAdmissionLock(options.root, {
    ...options,
    lockRunner: async (handle) => { acquisitionHandle = handle; throw primary; },
    closeLock: async () => { throw cleanup; }
  }), (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
  await acquisitionHandle.close();
}));

test('nested admission release evidence and deployment metadata survive combination without property collisions', () => {
  const innerRelease = new Error('inner release');
  const primary = Object.assign(new Error('primary'), { exitCode: 75, deploymentStatus: 'failed' });
  Object.defineProperty(primary, 'admissionLockReleaseError', { value: innerRelease, configurable: false });
  const outerRelease = new Error('outer release');
  const combined = combineAdmissionLockErrors(primary, outerRelease, 'combined');
  assert.equal(combined.exitCode, 75);
  assert.equal(combined.deploymentStatus, 'failed');
  assert.equal(combined.admissionLockReleaseError, outerRelease);
  assert.deepEqual(combined.admissionLockReleaseErrors, [innerRelease, outerRelease]);
  assert.equal(Object.isFrozen(combined.admissionLockReleaseErrors), true);
});
