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
export const UPLOAD_INPUT_TIMEOUT_MS = 15 * 60 * 1000;
export const UPLOAD_INPUT_CLEANUP_TIMEOUT_MS = 5 * 1000;
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

async function cleanupAbandonedPartials(stageDirectory, assertAdmissionHeld) {
  if (typeof assertAdmissionHeld !== 'function') {
    throw commandError('Deployment admission lock proof is required for partial cleanup.', 70);
  }
  await assertAdmissionHeld();
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
    await assertAdmissionHeld();
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

async function closeFailedUploadInput(input, iterator, cleanupTimeoutMs) {
  try {
    const destroyResult = input.destroy?.();
    destroyResult?.catch?.(() => {});
  } catch {}
  if (typeof iterator.return !== 'function') return;

  let cleanupTimer;
  const cleanup = Promise.resolve()
    .then(() => iterator.return())
    .catch(() => undefined);
  const deadline = new Promise((resolve) => {
    cleanupTimer = setTimeout(resolve, cleanupTimeoutMs);
  });
  try {
    await Promise.race([cleanup, deadline]);
  } finally {
    clearTimeout(cleanupTimer);
    cleanup.catch(() => {});
  }
}

async function receiveExactly(
  input,
  expectedBytes,
  handle,
  timeoutMs = UPLOAD_INPUT_TIMEOUT_MS,
  cleanupTimeoutMs = UPLOAD_INPUT_CLEANUP_TIMEOUT_MS
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UPLOAD_INPUT_TIMEOUT_MS) {
    throw commandError('Upload input timeout is invalid.', 70);
  }
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > UPLOAD_INPUT_CLEANUP_TIMEOUT_MS) {
    throw commandError('Upload input cleanup timeout is invalid.', 70);
  }
  const iterator = input?.[Symbol.asyncIterator]?.();
  if (!iterator) throw commandError('Upload input is unavailable.', 70);
  let received = 0;
  let timeout;
  let successful = false;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(commandError('Upload input timed out.', 75));
    }, timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
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
    successful = true;
    return received;
  } finally {
    clearTimeout(timeout);
    if (!successful) {
      try { await closeFailedUploadInput(input, iterator, cleanupTimeoutMs); }
      catch {}
    }
  }
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

async function createAdmissionMarker(stageDirectory, runId) {
  const markerPath = resolveWithin(stageDirectory, ADMISSION_MARKER);
  const marker = await fsp.open(
    markerPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
    0o400
  );
  try {
    await marker.writeFile(`${runId}\n`, 'utf8');
    await marker.sync();
  } finally {
    await marker.close();
  }
  await fsyncDirectory(stageDirectory);
}

function throwCleanupFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message, { cause: failures[0] });
}

async function removeEmptyCreatedRun(stageRoot, stageDirectory, options) {
  if (typeof options.assertAdmissionHeld !== 'function') {
    throw commandError('Deployment admission lock proof is required for run cleanup.', 70);
  }
  const assertExpectedRun = async () => {
    await options.assertAdmissionHeld();
    if (!options.expectedIdentity) return;
    const current = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', options.runContract);
    if (!sameFilesystemIdentity(options.expectedIdentity, current)) {
      throw commandError('Deployment staging directory identity changed during cleanup.', 70);
    }
  };
  await assertExpectedRun();
  const failures = [];
  let markerRemoved = false;
  try {
    const assertOnlyCleanupEntries = async () => {
      const entries = await fsp.readdir(stageDirectory);
      const expected = entries.length === 0 || entries.length === 1 && entries[0] === ADMISSION_MARKER;
      if (!expected) throw new Error('Admitted run directory is nonempty and remains retryable.');
      return entries;
    };
    await assertExpectedRun();
    await assertOnlyCleanupEntries();
    await options.afterCleanupDirectoryRead?.();
    await assertExpectedRun();
    const entries = await assertOnlyCleanupEntries();
    if (entries.includes(ADMISSION_MARKER)) {
      if (!await readAdmissionMarker(stageDirectory, options.runId, options.runContract)) {
        throw commandError('Deployment run admission marker disappeared during cleanup.', 75);
      }
      await assertExpectedRun();
      await fsp.unlink(resolveWithin(stageDirectory, ADMISSION_MARKER));
      markerRemoved = true;
      await fsyncDirectory(stageDirectory);
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 0) {
    try {
      await assertExpectedRun();
      if ((await fsp.readdir(stageDirectory)).length !== 0) {
        throw new Error('Admitted run directory changed during cleanup and remains retryable.');
      }
      await assertExpectedRun();
      await fsp.rmdir(stageDirectory);
      await fsyncStageParent(stageRoot, options);
      return;
    } catch (error) {
      failures.push(error);
    }
  }

  if (markerRemoved) {
    try {
      if (await pathExists(stageDirectory)) {
        await assertExpectedRun();
        if (!await readAdmissionMarker(stageDirectory, options.runId, options.runContract)) {
          await createAdmissionMarker(stageDirectory, options.runId);
        }
        await assertExpectedRun();
        if (!await readAdmissionMarker(stageDirectory, options.runId, options.runContract)) {
          throw commandError('Deployment run admission marker restoration was not durable.', 70);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  throwCleanupFailures(failures, 'Admitted run cleanup failed and retryable admission recovery was required.');
}

async function reserveExistingRun(stageRoot, stageDirectory, runId, {
  runContract,
  controllerRunContract,
  syncOptions,
  now,
  afterExistingAdmissionRead,
  assertAdmissionHeld,
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
  if (await readAdmissionMarker(stageDirectory, runId, runContract)) {
    await afterExistingAdmissionRead?.();
    return { stageDirectory, created: false, runIdentity: stat };
  }
  if (now - stat.mtimeMs >= UNADMITTED_STALE_MS) {
    const entries = await fsp.readdir(stageDirectory);
    if (entries.length === 0) {
      if (!allowTopLevelCleanup) {
        const error = commandError('Deployment run admission cleanup requires the global admission lock.', 75);
        Object.defineProperty(error, 'requiresAdmissionLock', { value: true, enumerable: false });
        throw error;
      }
      if (typeof assertAdmissionHeld !== 'function') {
        throw commandError('Deployment admission lock proof is required for stale cleanup.', 70);
      }
      await assertAdmissionHeld();
      const current = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
      if (!sameFilesystemIdentity(stat, current) || (await fsp.readdir(stageDirectory)).length !== 0) {
        throw commandError('Deployment run admission changed before stale cleanup.', 70);
      }
      await assertAdmissionHeld();
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
  admission,
  stageRootContract,
  runContract,
  controllerRunContract,
  stageRootFsync = fsyncDirectory,
  now = Date.now(),
  afterAdmissionMkdir,
  afterCleanupDirectoryRead,
  afterExistingAdmissionRead
}) {
  if (!admission || typeof admission.assertHeld !== 'function') {
    throw commandError('Deployment admission lock proof is required for run reservation.', 70);
  }
  await admission.assertHeld();
  const stageDirectory = resolveWithin(stageRoot, runId);
  const syncOptions = { contract: stageRootContract, syncDirectory: stageRootFsync };
  const existingOptions = {
    runContract,
    controllerRunContract,
    syncOptions,
    now,
    afterExistingAdmissionRead,
    assertAdmissionHeld: admission.assertHeld,
    allowTopLevelCleanup: true
  };
  if (await pathExists(stageDirectory)) {
    return reserveExistingRun(stageRoot, stageDirectory, runId, existingOptions);
  }

  const created = await fsp.mkdir(stageDirectory, { mode: 0o700, recursive: false }).then(() => true).catch((error) => {
    if (error.code === 'EEXIST') return false;
    throw error;
  });
  if (!created) return reserveExistingRun(stageRoot, stageDirectory, runId, existingOptions);

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
      if (admittedCount < 1) throw commandError('Deployment staging root lost its candidate directory.', 70);
    }
    if (admittedCount > MAX_STAGED_RUNS) {
      await admission.assertHeld();
      const currentRun = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
      if (!sameFilesystemIdentity(createdRunIdentity, currentRun)) {
        throw commandError('Deployment staging directory identity changed before quota cleanup.', 70);
      }
      await admission.assertHeld();
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
    return { stageDirectory, created: true, runIdentity: createdRunIdentity };
  } catch (error) {
    const remains = await pathExists(stageDirectory);
    if (remains) {
      try {
        if (!createdRunIdentity) throw commandError('Deployment staging directory identity was never established.', 70);
        await removeEmptyCreatedRun(stageRoot, stageDirectory, {
          ...syncOptions,
          expectedIdentity: createdRunIdentity,
          runId,
          runContract,
          afterCleanupDirectoryRead,
          assertAdmissionHeld: admission.assertHeld
        });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Run admission failed and its directory could not be removed safely.', { cause: error });
      }
    }
    throw error;
  }
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
  afterCleanupDirectoryRead,
  afterExistingAdmissionRead,
  uploadInputTimeoutMs = UPLOAD_INPUT_TIMEOUT_MS,
  uploadInputCleanupTimeoutMs = UPLOAD_INPUT_CLEANUP_TIMEOUT_MS,
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
  const admission = await acquireAdmissionLock(stageRoot, {
    ...admissionLockOptions,
    stageRootContract: admissionStageRootContract,
    lockPath: admissionLockPath,
    lockParentContract: admissionLockParentContract,
    lockContract: admissionLockContract
  });
  return runWithAdmissionLock(admission, async () => {
    await admission.assertHeld();
    const { stageDirectory, created, controllerOwned, runIdentity } = await reserveRunDirectory(stageRoot, runId, {
      admission,
      stageRootContract,
      runContract,
      controllerRunContract: acceptControllerOwnedRun ? controllerRunContract : undefined,
      stageRootFsync,
      now,
      afterAdmissionMkdir,
      afterCleanupDirectoryRead,
      afterExistingAdmissionRead
    });
    await admission.assertHeld();
    if (controllerOwned) {
      const received = await receiveExactly(input, bytes, null, uploadInputTimeoutMs, uploadInputCleanupTimeoutMs);
      await admission.assertHeld();
      return {
        received,
        idempotent: true,
        controllerOwned: true,
        archivePath: resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`)
      };
    }
    try {
      const currentRun = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
      if (!runIdentity || !sameFilesystemIdentity(runIdentity, currentRun)) {
        throw commandError('Deployment run identity changed before upload publication.', 70);
      }
      if (!await readAdmissionMarker(stageDirectory, runId, runContract)) {
        throw commandError('Deployment run admission changed before upload publication.', 75);
      }
      await cleanupAbandonedPartials(stageDirectory, admission.assertHeld);
      await assertRunArchiveBinding(stageDirectory, releaseSha);
      const archivePath = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
      const completedSize = await existingArchiveSize(archivePath);
      if (completedSize !== null) {
        if (completedSize !== bytes) throw new Error('Completed deployment archive conflicts with the declared size.');
        const received = await receiveExactly(input, bytes, null, uploadInputTimeoutMs, uploadInputCleanupTimeoutMs);
        await admission.assertHeld();
        return { received, idempotent: true, archivePath };
      }

      const partialPath = resolveWithin(stageDirectory, `.upload-${releaseSha}-${process.pid}-${crypto.randomBytes(16).toString('hex')}.part`);
      let handle;
      try {
        handle = await fsp.open(partialPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        const received = await receiveExactly(input, bytes, handle, uploadInputTimeoutMs, uploadInputCleanupTimeoutMs);
        await handle.sync();
        await handle.close();
        handle = null;
        await admission.assertHeld();
        await fsp.link(partialPath, archivePath);
        await fsyncDirectory(stageDirectory);
        await admission.assertHeld();
        await fsp.unlink(partialPath);
        await fsyncDirectory(stageDirectory);
        await admission.assertHeld();
        return { received, idempotent: false, archivePath };
      } catch (error) {
        await handle?.close().catch(() => {});
        try {
          await admission.assertHeld();
          await fsp.unlink(partialPath);
        } catch {}
        await fsyncDirectory(stageDirectory).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (created) {
        try {
          await removeEmptyCreatedRun(stageRoot, stageDirectory, {
            contract: stageRootContract,
            syncDirectory: stageRootFsync,
            expectedIdentity: runIdentity,
            runId,
            runContract,
            afterCleanupDirectoryRead,
            assertAdmissionHeld: admission.assertHeld
          });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Upload failed and its admitted run directory could not be removed.', { cause: error });
        }
      }
      throw error;
    }
  }, 'Deployment upload and admission-lock release both failed.');
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
