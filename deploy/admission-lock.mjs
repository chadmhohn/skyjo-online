import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ADMISSION_LOCK_NAME = '.admission.lock';
export const ADMISSION_LOCK_PATH = '/var/lib/skyjo-deploy/.admission.lock';
const admissionLockConflictMarker = Symbol('skyjoAdmissionLockConflict');

function lockError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export function sameFilesystemIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

export function isAdmissionLockConflict(error, expectedExitCode = 73) {
  return error?.exitCode === expectedExitCode && error?.[admissionLockConflictMarker] === true;
}

export function combineAdmissionLockErrors(primary, releaseError, message) {
  const combined = new AggregateError([primary, releaseError], message, { cause: primary });
  for (const key of Reflect.ownKeys(primary)) {
    if (key === admissionLockConflictMarker || ['stack', 'message', 'name', 'cause', 'errors', 'admissionLockReleaseError', 'admissionLockReleaseErrors'].includes(key) || Object.hasOwn(combined, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(primary, key);
    if (descriptor) Object.defineProperty(combined, key, descriptor);
  }
  const earlier = Array.isArray(primary?.admissionLockReleaseErrors)
    ? primary.admissionLockReleaseErrors
    : primary?.admissionLockReleaseError
      ? [primary.admissionLockReleaseError]
      : [];
  const releaseErrors = Object.freeze([...earlier, releaseError]);
  Object.defineProperty(combined, 'admissionLockReleaseError', { value: releaseError, enumerable: false });
  Object.defineProperty(combined, 'admissionLockReleaseErrors', { value: releaseErrors, enumerable: false });
  return combined;
}

function exactAdmissionLockIdentity(stat, contract) {
  return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0 &&
    stat.uid === contract.uid && stat.gid === contract.gid &&
    (process.platform === 'win32' || (stat.mode & 0o7777) === contract.mode);
}

async function assertExactStageRoot(stageRoot, contract) {
  const stat = await fsp.lstat(stageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== contract.uid || stat.gid !== contract.gid ||
      (process.platform !== 'win32' && (stat.mode & 0o7777) !== contract.mode) ||
      !Number.isSafeInteger(stat.nlink) || (process.platform !== 'win32' && stat.nlink < 2)) {
    throw lockError('Deployment staging root does not match its ownership contract.', 70);
  }
}

async function assertExactLockParent(lockPath, contract) {
  const parent = path.dirname(path.resolve(lockPath));
  const stat = await fsp.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== contract.uid || stat.gid !== contract.gid ||
      (process.platform !== 'win32' && (stat.mode & 0o7777) !== contract.mode)) {
    throw lockError('Deployment admission lock parent does not match its ownership contract.', 70);
  }
  let current = path.parse(parent).root;
  for (const segment of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const component = await fsp.lstat(current);
    if (!component.isDirectory() || component.isSymbolicLink()) {
      throw lockError('Deployment admission lock path contains an unsafe component.', 70);
    }
  }
  if (path.resolve(lockPath) === ADMISSION_LOCK_PATH) {
    for (const trusted of ['/', '/var', '/var/lib', '/var/lib/skyjo-deploy']) {
      const trustedStat = await fsp.lstat(trusted);
      if (!trustedStat.isDirectory() || trustedStat.isSymbolicLink() || trustedStat.uid !== 0 || trustedStat.gid !== 0 ||
          (trustedStat.mode & 0o7777) !== 0o755) {
        throw lockError(`Deployment admission lock trust path is unsafe: ${trusted}`, 70);
      }
    }
  }
  return parent;
}

async function runInheritedFlock(handle, { conflictExitCode }) {
  if (process.platform === 'win32') {
    // Production is Linux-only. Windows unit tests inject filesystem contracts,
    // while Linux CI owns the inherited-FD and cross-process lock proofs.
    return;
  }
  const exit = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code', String(conflictExitCode),
      '3'
    ], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (exit.signal || exit.code !== 0) {
    if (!exit.signal && exit.code === conflictExitCode) {
      const error = lockError('Another deployment admission is already active.', conflictExitCode);
      Object.defineProperty(error, admissionLockConflictMarker, { value: true, enumerable: false, configurable: false, writable: false });
      throw error;
    }
    throw lockError('Deployment admission lock could not be acquired.', 70);
  }
}

export async function acquireAdmissionLock(stageRoot, {
  stageRootContract,
  lockPath = ADMISSION_LOCK_PATH,
  lockParentContract,
  lockContract,
  conflictExitCode = 75,
  lockRunner = runInheritedFlock,
  closeLock = (handle) => handle.close()
} = {}) {
  if (!Number.isSafeInteger(stageRootContract?.uid) || !Number.isSafeInteger(stageRootContract?.gid) ||
      !Number.isSafeInteger(stageRootContract?.mode) ||
      !Number.isSafeInteger(lockParentContract?.uid) || !Number.isSafeInteger(lockParentContract?.gid) ||
      !Number.isSafeInteger(lockParentContract?.mode) ||
      !Number.isSafeInteger(lockContract?.uid) || !Number.isSafeInteger(lockContract?.gid) || lockContract?.mode !== 0o640 ||
      !Number.isSafeInteger(conflictExitCode) || conflictExitCode < 1 || conflictExitCode > 125) {
    throw lockError('Deployment admission lock ownership contract is unavailable.', 70);
  }
  await assertExactStageRoot(stageRoot, stageRootContract);
  const resolvedLockPath = path.resolve(lockPath);
  const lockParent = await assertExactLockParent(resolvedLockPath, lockParentContract);
  if (path.basename(resolvedLockPath) !== ADMISSION_LOCK_NAME || path.dirname(resolvedLockPath) !== lockParent) {
    throw lockError('Deployment admission lock path is invalid.', 70);
  }
  let handle;
  try {
    handle = await fsp.open(resolvedLockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const lockedIdentity = await handle.stat();
    const pathIdentity = await fsp.lstat(resolvedLockPath);
    if (!exactAdmissionLockIdentity(lockedIdentity, lockContract) ||
        !exactAdmissionLockIdentity(pathIdentity, lockContract) ||
        !sameFilesystemIdentity(lockedIdentity, pathIdentity)) {
      throw lockError('Deployment admission lock is unsafe.', 70);
    }
    await lockRunner(handle, { conflictExitCode });

    async function assertHeld() {
      await assertExactStageRoot(stageRoot, stageRootContract);
      await assertExactLockParent(resolvedLockPath, lockParentContract);
      const currentHandle = await handle.stat();
      const currentPath = await fsp.lstat(resolvedLockPath);
      if (!exactAdmissionLockIdentity(currentHandle, lockContract) ||
          !exactAdmissionLockIdentity(currentPath, lockContract) ||
          !sameFilesystemIdentity(lockedIdentity, currentHandle) ||
          !sameFilesystemIdentity(lockedIdentity, currentPath)) {
        throw lockError('Deployment admission lock identity changed unexpectedly.', 70);
      }
    }
    await assertHeld();
    let released = false;
    return {
      lockPath: resolvedLockPath,
      assertHeld,
      release: async () => {
        if (released) return;
        let identityError;
        try { await assertHeld(); }
        catch (error) { identityError = error; }
        let closeError;
        try {
          await closeLock(handle);
          released = true;
        } catch (error) {
          closeError = error;
        }
        if (identityError && closeError) {
          throw new AggregateError([identityError, closeError], 'Deployment admission lock identity changed and its file handle did not close.', { cause: identityError });
        }
        if (identityError) throw identityError;
        if (closeError) throw closeError;
      }
    };
  } catch (error) {
    if (handle) {
      try { await closeLock(handle); }
      catch (closeError) {
        throw new AggregateError([error, closeError], 'Deployment admission lock failed and its file handle did not close.', { cause: error });
      }
    }
    throw error;
  }
}
