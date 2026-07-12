#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_LOCK_NAME,
  ADMISSION_LOCK_PATH,
  acquireAdmissionLock,
  combineAdmissionLockErrors,
  sameFilesystemIdentity
} from './admission-lock.mjs';
import { parseSignedDeploymentCommand } from './deployment-authorization-lib.mjs';
import {
  MAX_ARCHIVE_BYTES,
  RELEASE_SHA_PATTERN,
  RUN_ID_PATTERN,
  resolveWithin
} from './release-controller-lib.mjs';

export const DEFAULT_STAGE_ROOT = '/var/tmp/skyjo-deploy';
export const UPLOAD_LOCK_STALE_MS = 15 * 60 * 1000;
export const MAX_STAGE_DIRECTORY_ENTRIES = 128;
export const MAX_PARTIALS_CLEANED_PER_UPLOAD = 32;
export const MAX_STAGED_RUNS = 32;
export const ADMISSION_MARKER = '.quota-admitted';
export const UNADMITTED_STALE_MS = 15 * 60 * 1000;

export { ADMISSION_LOCK_NAME, acquireAdmissionLock };

export function admittedDirectoryCountFromLinkCount(nlink) {
  if (!Number.isSafeInteger(nlink) || nlink < 2) throw commandError('Deployment staging root does not provide directory link-count admission.', 70);
  return nlink - 2;
}

export function admissionLockLocationForStage(stageRoot, platform = process.platform) {
  const production = platform === 'linux' && path.resolve(stageRoot) === path.resolve(DEFAULT_STAGE_ROOT);
  return {
    production,
    lockPath: production ? ADMISSION_LOCK_PATH : path.join(stageRoot, ADMISSION_LOCK_NAME)
  };
}

function commandError(message = 'Deployment command rejected.', exitCode = 64) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export function parseCommand(value) {
  if (typeof value !== 'string' || value.length > 512 || value.trim() !== value || /[\0\n\r\t]/.test(value) || value.includes('  ')) {
    throw commandError();
  }
  const parts = value.split(' ');
  const [command, runId, releaseSha, fourth] = parts;
  if (command === 'upload') {
    if (!RUN_ID_PATTERN.test(runId || '') || !RELEASE_SHA_PATTERN.test(releaseSha || '') ||
        parts.length !== 4 || !/^(?:[1-9][0-9]{0,9})$/.test(fourth || '')) throw commandError();
    const bytes = Number(fourth);
    if (bytes <= MAX_ARCHIVE_BYTES) return { command, runId, releaseSha, bytes };
    throw commandError();
  }
  try {
    const { fields, signature } = parseSignedDeploymentCommand(value);
    return {
      command: fields.command,
      runId: fields.runId,
      releaseSha: fields.releaseSha,
      digest: fields.artifactSha256,
      tag: fields.tag,
      issuedAt: fields.issuedAt,
      expiresAt: fields.expiresAt,
      keyId: fields.keyId,
      signature,
      signedCommand: value
    };
  } catch {
    throw commandError();
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSafeDirectory(directory, description, contract) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw commandError(`${description} is unsafe.`, 70);
  if (contract && (stat.uid !== contract.uid || stat.gid !== contract.gid ||
      (process.platform !== 'win32' && (stat.mode & 0o7777) !== contract.mode))) {
    throw commandError(`${description} does not match its ownership contract.`, 70);
  }
  return stat;
}

async function assertSafeStageRoot(stageRoot, contract) {
  const stat = await assertSafeDirectory(stageRoot, 'Deployment staging root', contract);
  if (contract) admittedDirectoryCountFromLinkCount(stat.nlink);
  return stat;
}

async function fsyncStageParent(stageRoot, { contract, syncDirectory = fsyncDirectory } = {}) {
  try {
    await syncDirectory(stageRoot);
  } catch (error) {
    if (error?.code !== 'EACCES' || !contract) throw error;
    // Exact mode 1731 deliberately denies directory enumeration/open-for-read
    // to the transport identity. The root controller fsyncs this parent before
    // consuming any staged archive; here we fail closed unless the contract is
    // still exact after the expected EACCES.
    await assertSafeStageRoot(stageRoot, contract);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

async function removeDeadUploadLock(lockDirectory, { now = Date.now(), isProcessAlive = processIsAlive } = {}) {
  const ownerPath = resolveWithin(lockDirectory, 'owner.json');
  let ownerText;
  let owner;
  let ownerStat;
  let lockStat;
  try {
    lockStat = await fsp.lstat(lockDirectory);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return false;
    ownerStat = await fsp.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return false;
    ownerText = await fsp.readFile(ownerPath, 'utf8');
    owner = JSON.parse(ownerText);
  } catch (error) {
    if (error?.code === 'ENOENT' && lockStat && now - lockStat.mtimeMs >= UPLOAD_LOCK_STALE_MS) {
      const entries = await fsp.readdir(lockDirectory).catch(() => null);
      if (entries?.length === 0) {
        await fsp.rmdir(lockDirectory);
        await fsyncDirectory(path.dirname(lockDirectory));
        return true;
      }
    }
    return false;
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 ||
      typeof owner?.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token) ||
      !Number.isSafeInteger(owner?.createdAt) || now - owner.createdAt < UPLOAD_LOCK_STALE_MS || isProcessAlive(owner.pid)) {
    return false;
  }
  const currentText = await fsp.readFile(ownerPath, 'utf8').catch(() => null);
  if (currentText !== ownerText) return false;
  await fsp.unlink(ownerPath);
  await fsyncDirectory(lockDirectory);
  await fsp.rmdir(lockDirectory);
  await fsyncDirectory(path.dirname(lockDirectory));
  return true;
}

export async function acquireUploadLock(stageDirectory, options = {}) {
  const lockDirectory = resolveWithin(stageDirectory, '.upload.lock');
  const ownerPath = resolveWithin(lockDirectory, 'owner.json');
  const token = crypto.randomBytes(16).toString('hex');
  const createdAt = options.now ?? Date.now();
  const ownerText = `${JSON.stringify({ pid: process.pid, token, createdAt })}\n`;
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await fsp.mkdir(lockDirectory, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const removed = attempt === 0 && await removeDeadUploadLock(lockDirectory, {
        now: createdAt,
        isProcessAlive: options.isProcessAlive
      });
      if (!removed) throw commandError('Another upload is already active for this deployment run.', 75);
    }
  }
  if (!acquired) throw commandError('Another upload is already active for this deployment run.', 75);
  try {
    const handle = await fsp.open(ownerPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(ownerText, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(lockDirectory);
  } catch (error) {
    await fsp.unlink(ownerPath).catch(() => {});
    await fsp.rmdir(lockDirectory).catch(() => {});
    await fsyncDirectory(stageDirectory).catch(() => {});
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    const lockStat = await fsp.lstat(lockDirectory).catch(() => null);
    const ownerStat = await fsp.lstat(ownerPath).catch(() => null);
    if (!lockStat?.isDirectory() || lockStat.isSymbolicLink() || !ownerStat?.isFile() || ownerStat.isSymbolicLink()) {
      throw new Error('Upload lock became unsafe before release.');
    }
    const currentOwner = await fsp.readFile(ownerPath, 'utf8').catch(() => null);
    if (currentOwner !== ownerText) throw new Error('Upload lock ownership changed unexpectedly.');
    const releaseErrors = [];
    const releaseUnlink = options.releaseUnlink || fsp.unlink;
    const releaseRmdir = options.releaseRmdir || fsp.rmdir;
    const releaseSyncDirectory = options.releaseSyncDirectory || fsyncDirectory;
    for (const operation of [
      () => releaseUnlink(ownerPath),
      () => releaseSyncDirectory(lockDirectory),
      () => releaseRmdir(lockDirectory),
      () => releaseSyncDirectory(stageDirectory)
    ]) {
      try { await operation(); }
      catch (error) { releaseErrors.push(error); }
    }
    released = releaseErrors.length === 0;
    if (releaseErrors.length > 0) throw new AggregateError(releaseErrors, 'Upload lock release did not complete cleanly.');
  };
}

async function cleanupAbandonedPartials(stageDirectory) {
  const entries = await fsp.readdir(stageDirectory, { withFileTypes: true });
  if (entries.length > MAX_STAGE_DIRECTORY_ENTRIES) throw new Error('Deployment staging directory contains too many entries.');
  const partialNames = entries
    .filter((entry) => entry.isFile() && /^\.upload-[a-f0-9]{40}-[0-9]+-[a-f0-9]{32}\.part$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (partialNames.length > MAX_PARTIALS_CLEANED_PER_UPLOAD) {
    throw new Error('Deployment staging directory contains too many abandoned uploads.');
  }
  for (const name of partialNames) {
    const partialPath = resolveWithin(stageDirectory, name);
    const stat = await fsp.lstat(partialPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deployment staging partial is unsafe.');
    await fsp.unlink(partialPath);
  }
  if (partialNames.length > 0) await fsyncDirectory(stageDirectory);
}

async function assertRunArchiveBinding(stageDirectory, releaseSha) {
  const entries = await fsp.readdir(stageDirectory, { withFileTypes: true });
  if (entries.length > MAX_STAGE_DIRECTORY_ENTRIES) throw new Error('Deployment staging directory contains too many entries.');
  for (const entry of entries) {
    const match = entry.name.match(/^skyjo-runtime-([a-f0-9]{40})\.tar\.gz$/);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Completed deployment archive is unsafe.');
    if (match[1] !== releaseSha) {
      throw new Error('Deployment run is already bound to a different release SHA.');
    }
  }
}

async function existingArchiveSize(archivePath) {
  let stat;
  try {
    stat = await fsp.lstat(archivePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Completed deployment archive is unsafe.');
  return stat.size;
}

async function receiveExactly(input, expectedBytes, handle) {
  let received = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    received += chunk.length;
    if (received > expectedBytes || received > MAX_ARCHIVE_BYTES) throw new Error('Upload exceeded declared size.');
    if (handle) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten < 1) throw new Error('Upload write made no progress.');
        offset += bytesWritten;
      }
    }
  }
  if (received !== expectedBytes) throw new Error('Upload did not match declared size.');
  return received;
}

async function readAdmissionMarker(stageDirectory, runId, contract) {
  const markerPath = resolveWithin(stageDirectory, ADMISSION_MARKER);
  let handle;
  try {
    handle = await fsp.open(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== contract.uid ||
        (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o400) || stat.size !== Buffer.byteLength(`${runId}\n`)) {
      throw commandError('Deployment run admission marker is unsafe.', 70);
    }
    if (await handle.readFile('utf8') !== `${runId}\n`) throw commandError('Deployment run admission marker is invalid.', 70);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeEmptyCreatedRun(stageRoot, stageDirectory, options) {
  const assertExpectedRun = async () => {
    if (!options.expectedIdentity) return;
    const current = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', options.runContract);
    if (!sameFilesystemIdentity(options.expectedIdentity, current)) {
      throw commandError('Deployment staging directory identity changed during cleanup.', 70);
    }
  };
  await assertExpectedRun();
  const entries = await fsp.readdir(stageDirectory);
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== ADMISSION_MARKER)) {
    throw new Error('Admitted run directory is nonempty and remains retryable.');
  }
  await assertExpectedRun();
  if (entries[0] === ADMISSION_MARKER) {
    await fsp.unlink(resolveWithin(stageDirectory, ADMISSION_MARKER));
    await fsyncDirectory(stageDirectory);
  }
  await assertExpectedRun();
  if ((await fsp.readdir(stageDirectory)).length !== 0) {
    throw new Error('Admitted run directory changed during cleanup and remains retryable.');
  }
  await fsp.rmdir(stageDirectory);
  await fsyncStageParent(stageRoot, options);
}

async function reserveExistingRun(stageRoot, stageDirectory, runId, {
  runContract,
  controllerRunContract,
  syncOptions,
  now,
  allowTopLevelCleanup = false
}) {
  const existing = await assertSafeDirectory(stageDirectory, 'Deployment staging directory');
  const existingMode = existing.mode & 0o7777;
  if (controllerRunContract && existing.uid === controllerRunContract.uid && existing.gid === controllerRunContract.gid &&
      (process.platform === 'win32' || controllerRunContract.modes.includes(existingMode))) {
    return { stageDirectory, created: false, controllerOwned: true };
  }
  const stat = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
  const markerStat = await fsp.lstat(resolveWithin(stageDirectory, ADMISSION_MARKER)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (controllerRunContract && markerStat?.isFile() && !markerStat.isSymbolicLink() &&
      markerStat.uid === controllerRunContract.uid && markerStat.gid === controllerRunContract.gid &&
      (process.platform === 'win32' || (markerStat.mode & 0o7777) === 0o400)) {
    return { stageDirectory, created: false, controllerOwned: true };
  }
  if (await readAdmissionMarker(stageDirectory, runId, runContract)) return { stageDirectory, created: false };
  if (now - stat.mtimeMs >= UNADMITTED_STALE_MS) {
    const entries = await fsp.readdir(stageDirectory);
    if (entries.length === 0) {
      if (!allowTopLevelCleanup) {
        const error = commandError('Deployment run admission cleanup requires the global admission lock.', 75);
        Object.defineProperty(error, 'requiresAdmissionLock', { value: true, enumerable: false });
        throw error;
      }
      const current = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
      if (!sameFilesystemIdentity(stat, current) || (await fsp.readdir(stageDirectory)).length !== 0) {
        throw commandError('Deployment run admission changed before stale cleanup.', 70);
      }
      await fsp.rmdir(stageDirectory);
      await fsyncStageParent(stageRoot, syncOptions);
    }
  }
  throw commandError('Deployment run admission is incomplete; retry later.', 75);
}

async function pathExists(candidate) {
  try {
    await fsp.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function runWithAdmissionLock(admission, action, message) {
  let result;
  let primaryError;
  try { result = await action(); }
  catch (error) { primaryError = error; }
  let releaseError;
  try { await admission.release(); }
  catch (error) { releaseError = error; }
  if (primaryError && releaseError) throw combineAdmissionLockErrors(primaryError, releaseError, message);
  if (primaryError) throw primaryError;
  if (releaseError) throw releaseError;
  return result;
}

async function reserveRunDirectory(stageRoot, runId, {
  stageRootContract,
  admissionStageRootContract,
  runContract,
  admissionLockPath,
  admissionLockParentContract,
  admissionLockContract,
  controllerRunContract,
  stageRootFsync = fsyncDirectory,
  now = Date.now(),
  admissionLockOptions = {},
  afterAdmissionMkdir
}) {
  const stageDirectory = resolveWithin(stageRoot, runId);
  const syncOptions = { contract: stageRootContract, syncDirectory: stageRootFsync };
  const existingOptions = { runContract, controllerRunContract, syncOptions, now };
  if (await pathExists(stageDirectory)) {
    try {
      return await reserveExistingRun(stageRoot, stageDirectory, runId, existingOptions);
    } catch (error) {
      if (error?.requiresAdmissionLock !== true) throw error;
      const admission = await acquireAdmissionLock(stageRoot, {
        ...admissionLockOptions,
        stageRootContract: admissionStageRootContract,
        lockPath: admissionLockPath,
        lockParentContract: admissionLockParentContract,
        lockContract: admissionLockContract
      });
      return runWithAdmissionLock(
        admission,
        () => reserveExistingRun(stageRoot, stageDirectory, runId, { ...existingOptions, allowTopLevelCleanup: true }),
        'Stale run cleanup and admission-lock release both failed.'
      );
    }
  }

  const admission = await acquireAdmissionLock(stageRoot, {
    ...admissionLockOptions,
    stageRootContract: admissionStageRootContract,
    lockPath: admissionLockPath,
    lockParentContract: admissionLockParentContract,
    lockContract: admissionLockContract
  });
  let result;
  let admissionError;
  try {
    const created = await fsp.mkdir(stageDirectory, { mode: 0o700, recursive: false }).then(() => true).catch((error) => {
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (!created) {
      result = await reserveExistingRun(stageRoot, stageDirectory, runId, { ...existingOptions, allowTopLevelCleanup: true });
    } else {
      let createdRunIdentity;
      try {
        createdRunIdentity = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
        await afterAdmissionMkdir?.();
        await admission.assertHeld();
        const rootStat = await assertSafeStageRoot(stageRoot, stageRootContract);
        await admission.assertHeld();
        let admittedCount;
        if (process.platform === 'win32' && !stageRootContract) {
          admittedCount = (await fsp.readdir(stageRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
        } else {
          admittedCount = admittedDirectoryCountFromLinkCount(rootStat.nlink);
          if (admittedCount < 1) {
            throw commandError('Deployment staging root lost its candidate directory.', 70);
          }
        }
        if (admittedCount > MAX_STAGED_RUNS) {
          const currentRun = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
          if (!sameFilesystemIdentity(createdRunIdentity, currentRun)) {
            throw commandError('Deployment staging directory identity changed before quota cleanup.', 70);
          }
          await fsp.rmdir(stageDirectory);
          await fsyncStageParent(stageRoot, syncOptions);
          throw commandError('Deployment staging quota is full.', 75);
        }
        await admission.assertHeld();
        const currentRun = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
        if (!sameFilesystemIdentity(createdRunIdentity, currentRun)) {
          throw commandError('Deployment staging directory identity changed before admission.', 70);
        }
        const markerPath = resolveWithin(stageDirectory, ADMISSION_MARKER);
        const marker = await fsp.open(markerPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o400);
        try {
          await marker.writeFile(`${runId}\n`, 'utf8');
          await marker.sync();
        } finally {
          await marker.close();
        }
        await fsyncDirectory(stageDirectory);
        await fsyncStageParent(stageRoot, syncOptions);
        result = { stageDirectory, created: true, runIdentity: createdRunIdentity };
      } catch (error) {
        const remains = await pathExists(stageDirectory);
        if (remains) {
          try {
            if (!createdRunIdentity) throw commandError('Deployment staging directory identity was never established.', 70);
            await removeEmptyCreatedRun(stageRoot, stageDirectory, {
              ...syncOptions,
              expectedIdentity: createdRunIdentity,
              runContract
            });
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Run admission failed and its directory could not be removed safely.', { cause: error });
          }
        }
        throw error;
      }
    }
  } catch (error) {
    admissionError = error;
  }

  return runWithAdmissionLock(admission, async () => {
    if (admissionError) throw admissionError;
    return result;
  }, 'Run admission and admission-lock release both failed.');
}

export async function performUpload({
  stageRoot = DEFAULT_STAGE_ROOT,
  runId,
  releaseSha,
  bytes,
  input = process.stdin,
  enforceStageRootContract = process.platform === 'linux' && path.resolve(stageRoot) === path.resolve(DEFAULT_STAGE_ROOT),
  expectedStageRootUid = 0,
  expectedStageRootGid = process.getgid?.(),
  stageRootFsync = fsyncDirectory,
  now = Date.now(),
  admissionLockOptions = {},
  afterAdmissionMkdir,
  uploadLockOptions = {},
  controllerRunContract = { uid: 0, gid: 0, modes: [0o700, 0o711] },
  acceptControllerOwnedRun = enforceStageRootContract
}) {
  if (!RUN_ID_PATTERN.test(runId || '') || !RELEASE_SHA_PATTERN.test(releaseSha || '') ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARCHIVE_BYTES) throw commandError();
  const admissionLocation = admissionLockLocationForStage(stageRoot);
  const productionStageRoot = admissionLocation.production;
  if (productionStageRoot && !enforceStageRootContract) throw commandError('Production staging requires its exact ownership contract.', 70);
  const stageRootContract = enforceStageRootContract
    ? { uid: expectedStageRootUid, gid: expectedStageRootGid, mode: 0o1731 }
    : undefined;
  if (stageRootContract && (!Number.isSafeInteger(stageRootContract.uid) || !Number.isSafeInteger(stageRootContract.gid))) {
    throw commandError('Deployment staging ownership contract is unavailable.', 70);
  }
  const stageRootStat = await assertSafeStageRoot(stageRoot, stageRootContract);
  const admissionStageRootContract = stageRootContract || {
    uid: stageRootStat.uid,
    gid: stageRootStat.gid,
    mode: stageRootStat.mode & 0o7777
  };
  const runContract = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mode: 0o700 };
  const admissionLockContract = {
    uid: stageRootContract?.uid ?? runContract.uid,
    gid: stageRootContract?.gid ?? runContract.gid,
    mode: 0o640
  };
  const admissionLockPath = admissionLocation.lockPath;
  const admissionLockParentContract = productionStageRoot
    ? { uid: 0, gid: 0, mode: 0o755 }
    : admissionStageRootContract;
  const { stageDirectory, created, controllerOwned, runIdentity } = await reserveRunDirectory(stageRoot, runId, {
    stageRootContract,
    admissionStageRootContract,
    runContract,
    admissionLockPath,
    admissionLockParentContract,
    admissionLockContract,
    controllerRunContract: acceptControllerOwnedRun ? controllerRunContract : undefined,
    stageRootFsync,
    now,
    admissionLockOptions,
    afterAdmissionMkdir
  });
  if (controllerOwned) {
    const received = await receiveExactly(input, bytes, null);
    return {
      received,
      idempotent: true,
      controllerOwned: true,
      archivePath: resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`)
    };
  }
  try {
    const releaseLock = await acquireUploadLock(stageDirectory, uploadLockOptions);
    try {
      await cleanupAbandonedPartials(stageDirectory);
      await assertRunArchiveBinding(stageDirectory, releaseSha);
      const archivePath = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
      const completedSize = await existingArchiveSize(archivePath);
      if (completedSize !== null) {
        if (completedSize !== bytes) throw new Error('Completed deployment archive conflicts with the declared size.');
        const received = await receiveExactly(input, bytes, null);
        return { received, idempotent: true, archivePath };
      }

      const partialPath = resolveWithin(stageDirectory, `.upload-${releaseSha}-${process.pid}-${crypto.randomBytes(16).toString('hex')}.part`);
      let handle;
      try {
        handle = await fsp.open(partialPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        const received = await receiveExactly(input, bytes, handle);
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.link(partialPath, archivePath);
        await fsyncDirectory(stageDirectory);
        await fsp.unlink(partialPath);
        await fsyncDirectory(stageDirectory);
        return { received, idempotent: false, archivePath };
      } catch (error) {
        await handle?.close().catch(() => {});
        await fsp.unlink(partialPath).catch(() => {});
        await fsyncDirectory(stageDirectory).catch(() => {});
        throw error;
      }
    } finally {
      await releaseLock();
    }
  } catch (error) {
    if (created) {
      try {
        const cleanupAdmission = await acquireAdmissionLock(stageRoot, {
          ...admissionLockOptions,
          stageRootContract: admissionStageRootContract,
          lockPath: admissionLockPath,
          lockParentContract: admissionLockParentContract,
          lockContract: admissionLockContract
        });
        await runWithAdmissionLock(cleanupAdmission, () => removeEmptyCreatedRun(stageRoot, stageDirectory, {
          contract: stageRootContract,
          syncDirectory: stageRootFsync,
          expectedIdentity: runIdentity,
          runContract
        }), 'Upload cleanup and admission-lock release both failed.');
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Upload failed and its admitted run directory could not be removed.', { cause: error });
      }
    }
    throw error;
  }
}

async function runController(parsed) {
  const argumentsList = [parsed.command, '--authorization-command', parsed.signedCommand];
  const child = spawn('/usr/bin/sudo', ['--non-interactive', '/usr/local/sbin/skyjo-release-controller', ...argumentsList], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 70 : (code ?? 70)));
  });
}

export async function dispatch({ originalCommand = process.env.SSH_ORIGINAL_COMMAND || '', stageRoot = DEFAULT_STAGE_ROOT, input = process.stdin } = {}) {
  const parsed = parseCommand(originalCommand);
  if (parsed.command === 'upload') {
    const result = await performUpload({ stageRoot, ...parsed, input });
    process.stdout.write(`uploaded ${parsed.runId} ${parsed.releaseSha} ${result.received}${result.idempotent ? ' idempotent' : ''}\n`);
    return 0;
  }
  return runController(parsed);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  try {
    process.exitCode = await dispatch();
  } catch (error) {
    process.stderr.write(`Deployment command failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = error?.exitCode || 70;
  }
}
