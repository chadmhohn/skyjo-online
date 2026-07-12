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

const UPLOAD_LOCK_MODE = 0o700;
const UPLOAD_LOCK_OWNER_MODE = 0o600;
const MAX_UPLOAD_LOCK_OWNER_BYTES = 512;
const READ_NOFOLLOW_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const READ_DIRECTORY_NOFOLLOW_FLAGS = READ_NOFOLLOW_FLAGS | (fs.constants.O_DIRECTORY || 0);

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

function exactUploadLockDirectory(stat, { uid, gid } = {}) {
  return stat?.isDirectory() && !stat.isSymbolicLink() &&
    (uid === undefined || stat.uid === uid) && (gid === undefined || stat.gid === gid) &&
    (process.platform === 'win32' || (stat.mode & 0o7777) === UPLOAD_LOCK_MODE) &&
    Number.isSafeInteger(stat.nlink) && stat.nlink >= 1 &&
    (process.platform === 'win32' || stat.nlink === 2);
}

function exactUploadLockOwner(stat, {
  uid,
  gid,
  size,
  minimumSize = 2,
  maximumSize = MAX_UPLOAD_LOCK_OWNER_BYTES
} = {}) {
  return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (uid === undefined || stat.uid === uid) && (gid === undefined || stat.gid === gid) &&
    (process.platform === 'win32' || (stat.mode & 0o7777) === UPLOAD_LOCK_OWNER_MODE) &&
    Number.isSafeInteger(stat.size) && stat.size >= minimumSize && stat.size <= maximumSize &&
    (size === undefined || stat.size === size);
}

function sameStableFilesystemState(left, right) {
  return sameFilesystemIdentity(left, right) && left.uid === right.uid && left.gid === right.gid &&
    (left.mode & 0o7777) === (right.mode & 0o7777) && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function unsafeUploadLock(message) {
  return commandError(message, 70);
}

async function openVerifiedLockDirectory(lockDirectory, expectedIdentity) {
  let handle;
  try {
    if (process.platform !== 'win32') {
      handle = await fsp.open(lockDirectory, READ_DIRECTORY_NOFOLLOW_FLAGS);
    }
    const handleStat = handle ? await handle.stat() : await fsp.lstat(lockDirectory);
    const pathStat = await fsp.lstat(lockDirectory);
    const expectedUid = process.getuid?.();
    const contract = { uid: expectedUid, gid: expectedUid === undefined ? undefined : handleStat.gid };
    if (!exactUploadLockDirectory(handleStat, contract) || !exactUploadLockDirectory(pathStat, contract) ||
        !sameFilesystemIdentity(handleStat, pathStat) ||
        (expectedIdentity && (!sameStableFilesystemState(expectedIdentity, handleStat) ||
          !sameStableFilesystemState(expectedIdentity, pathStat)))) {
      throw unsafeUploadLock('Upload lock directory identity is unsafe.');
    }
    return { handle, identity: handleStat, contract: { uid: handleStat.uid, gid: handleStat.gid } };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function snapshotVerifiedLockDirectory(lockDirectory, session) {
  const handleStat = session.handle ? await session.handle.stat() : await fsp.lstat(lockDirectory);
  const pathStat = await fsp.lstat(lockDirectory);
  if (!exactUploadLockDirectory(handleStat, session.contract) || !exactUploadLockDirectory(pathStat, session.contract) ||
      !sameFilesystemIdentity(handleStat, pathStat) ||
      !sameFilesystemIdentity(session.identity, handleStat) ||
      !sameFilesystemIdentity(session.identity, pathStat) ||
      !sameStableFilesystemState(handleStat, pathStat)) {
    throw unsafeUploadLock('Upload lock directory identity changed unexpectedly.');
  }
  return handleStat;
}

async function assertVerifiedLockDirectory(lockDirectory, session, expectedState = session.identity) {
  const current = await snapshotVerifiedLockDirectory(lockDirectory, session);
  if (!sameStableFilesystemState(expectedState, current)) {
    throw unsafeUploadLock('Upload lock directory changed unexpectedly.');
  }
  return current;
}

async function openStableOwnerFile(ownerPath, contract, expectedIdentity) {
  let handle;
  try {
    handle = await fsp.open(ownerPath, READ_NOFOLLOW_FLAGS);
    const beforeHandle = await handle.stat();
    const beforePath = await fsp.lstat(ownerPath);
    if (!exactUploadLockOwner(beforeHandle, contract) || !exactUploadLockOwner(beforePath, contract) ||
        !sameFilesystemIdentity(beforeHandle, beforePath) ||
        (expectedIdentity && (!sameStableFilesystemState(expectedIdentity, beforeHandle) ||
          !sameStableFilesystemState(expectedIdentity, beforePath)))) {
      throw unsafeUploadLock('Upload lock owner identity is unsafe.');
    }
    const text = await handle.readFile('utf8');
    const afterHandle = await handle.stat();
    const afterPath = await fsp.lstat(ownerPath);
    if (Buffer.byteLength(text, 'utf8') !== beforeHandle.size ||
        !exactUploadLockOwner(afterHandle, contract) || !exactUploadLockOwner(afterPath, contract) ||
        !sameStableFilesystemState(beforeHandle, afterHandle) ||
        !sameStableFilesystemState(beforeHandle, afterPath)) {
      throw unsafeUploadLock('Upload lock owner changed while it was read.');
    }
    return { handle, identity: beforeHandle, contract, text };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function assertStableOwnerPath(ownerPath, session) {
  const handleStat = await session.handle.stat();
  const pathStat = await fsp.lstat(ownerPath);
  if (!exactUploadLockOwner(handleStat, session.contract) || !exactUploadLockOwner(pathStat, session.contract) ||
      !sameStableFilesystemState(session.identity, handleStat) ||
      !sameStableFilesystemState(session.identity, pathStat)) {
    throw unsafeUploadLock('Upload lock owner identity changed unexpectedly.');
  }
}

async function unlinkVerifiedOwner(ownerPath, session, unlinkOwner = fsp.unlink) {
  await assertStableOwnerPath(ownerPath, session);
  await unlinkOwner(ownerPath);
  const detached = await session.handle.stat();
  if (!sameFilesystemIdentity(session.identity, detached) || detached.nlink !== 0 ||
      detached.uid !== session.identity.uid || detached.gid !== session.identity.gid ||
      (detached.mode & 0o7777) !== (session.identity.mode & 0o7777) ||
      detached.size !== session.identity.size || detached.mtimeMs !== session.identity.mtimeMs) {
    throw unsafeUploadLock('Upload lock owner unlink did not detach the verified inode.');
  }
  const replacement = await fsp.lstat(ownerPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (replacement) throw unsafeUploadLock('Upload lock owner path was recreated during unlink.');
}

async function rmdirVerifiedLock(lockDirectory, session, {
  expectedState,
  beforeRmdir,
  rmdirLock = fsp.rmdir
} = {}) {
  const entries = await fsp.readdir(lockDirectory);
  if (entries.length !== 0) throw unsafeUploadLock('Upload lock directory changed before removal.');
  await beforeRmdir?.({ lockDirectory });
  await assertVerifiedLockDirectory(lockDirectory, session, expectedState);
  if ((await fsp.readdir(lockDirectory)).length !== 0) {
    throw unsafeUploadLock('Upload lock directory changed before removal.');
  }
  await assertVerifiedLockDirectory(lockDirectory, session, expectedState);
  await rmdirLock(lockDirectory);
  if (session.handle) {
    const detached = await session.handle.stat();
    if (!sameFilesystemIdentity(session.identity, detached) || detached.nlink !== 0) {
      throw unsafeUploadLock('Upload lock directory removal did not detach the verified inode.');
    }
  }
  const replacement = await fsp.lstat(lockDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (replacement) throw unsafeUploadLock('Upload lock directory path was recreated during removal.');
}

async function removeDeadUploadLock(lockDirectory, {
  now = Date.now(),
  isProcessAlive = processIsAlive,
  beforeStaleOwnerUnlink,
  beforeStaleLockRmdir,
  staleUnlink = fsp.unlink,
  staleRmdir = fsp.rmdir
} = {}) {
  const ownerPath = resolveWithin(lockDirectory, 'owner.json');
  let lockSession;
  let ownerSession;
  try {
    try {
      lockSession = await openVerifiedLockDirectory(lockDirectory);
    } catch {
      return false;
    }
    try {
      ownerSession = await openStableOwnerFile(ownerPath, lockSession.contract);
    } catch (error) {
      if (error?.code !== 'ENOENT' || now - lockSession.identity.mtimeMs < UPLOAD_LOCK_STALE_MS) return false;
      if ((await fsp.readdir(lockDirectory)).length !== 0) return false;
      await rmdirVerifiedLock(lockDirectory, lockSession, {
        expectedState: lockSession.identity,
        beforeRmdir: beforeStaleLockRmdir,
        rmdirLock: staleRmdir
      });
      await fsyncDirectory(path.dirname(lockDirectory));
      return true;
    }
    let owner;
    try {
      owner = JSON.parse(ownerSession.text);
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 ||
        typeof owner?.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token) ||
        !Number.isSafeInteger(owner?.createdAt) || now - owner.createdAt < UPLOAD_LOCK_STALE_MS || isProcessAlive(owner.pid)) {
      return false;
    }
    await beforeStaleOwnerUnlink?.({ lockDirectory, ownerPath });
    await assertVerifiedLockDirectory(lockDirectory, lockSession);
    await unlinkVerifiedOwner(ownerPath, ownerSession, staleUnlink);
    await fsyncDirectory(lockDirectory);
    await ownerSession.handle.close();
    ownerSession = null;
    const postUnlinkLockState = lockSession.handle ? await lockSession.handle.stat() : await fsp.lstat(lockDirectory);
    const postUnlinkPathState = await fsp.lstat(lockDirectory);
    if (!exactUploadLockDirectory(postUnlinkLockState, lockSession.contract) ||
        !sameFilesystemIdentity(lockSession.identity, postUnlinkLockState) ||
        !sameStableFilesystemState(postUnlinkLockState, postUnlinkPathState)) {
      throw unsafeUploadLock('Upload lock directory changed after owner removal.');
    }
    await rmdirVerifiedLock(lockDirectory, lockSession, {
      expectedState: postUnlinkLockState,
      beforeRmdir: beforeStaleLockRmdir,
      rmdirLock: staleRmdir
    });
    await fsyncDirectory(path.dirname(lockDirectory));
    return true;
  } catch (error) {
    if (error?.exitCode === 70) throw error;
    return false;
  } finally {
    await ownerSession?.handle.close().catch(() => {});
    await lockSession?.handle?.close().catch(() => {});
  }
}

export async function acquireUploadLock(stageDirectory, options = {}) {
  const lockDirectory = resolveWithin(stageDirectory, '.upload.lock');
  const ownerPath = resolveWithin(lockDirectory, 'owner.json');
  const token = crypto.randomBytes(16).toString('hex');
  const createdAt = options.now ?? Date.now();
  const ownerText = `${JSON.stringify({ pid: process.pid, token, createdAt })}\n`;
  let lockIdentity;
  let ownerIdentity;
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await fsp.mkdir(lockDirectory, { mode: UPLOAD_LOCK_MODE });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const removed = attempt === 0 && await removeDeadUploadLock(lockDirectory, { ...options, now: createdAt });
      if (!removed) throw commandError('Another upload is already active for this deployment run.', 75);
    }
  }
  if (!acquired) throw commandError('Another upload is already active for this deployment run.', 75);
  let creationLockSession;
  let createdOwnerIdentity;
  try {
    creationLockSession = await openVerifiedLockDirectory(lockDirectory);
    const handle = await fsp.open(
      ownerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      UPLOAD_LOCK_OWNER_MODE
    );
    try {
      createdOwnerIdentity = await handle.stat();
      if (options.writeOwnerFile) await options.writeOwnerFile(handle, ownerText);
      else await handle.writeFile(ownerText, 'utf8');
      await handle.sync();
    } finally {
      createdOwnerIdentity = await handle.stat().catch(() => createdOwnerIdentity);
      await handle.close();
    }
    await fsyncDirectory(lockDirectory);
    const ownerSession = await openStableOwnerFile(ownerPath, {
      ...creationLockSession.contract,
      size: Buffer.byteLength(ownerText, 'utf8')
    }, createdOwnerIdentity);
    try {
      if (ownerSession.text !== ownerText) throw unsafeUploadLock('Upload lock ownership changed during creation.');
      ownerIdentity = ownerSession.identity;
    } finally {
      await ownerSession.handle.close();
    }
    const currentLockIdentity = await snapshotVerifiedLockDirectory(lockDirectory, creationLockSession);
    creationLockSession.identity = currentLockIdentity;
    lockIdentity = currentLockIdentity;
  } catch (error) {
    const cleanupErrors = [];
    try {
      creationLockSession ||= await openVerifiedLockDirectory(lockDirectory);
      if (createdOwnerIdentity) {
        const cleanupOwner = await openStableOwnerFile(ownerPath, {
          ...creationLockSession.contract,
          minimumSize: 0
        }, createdOwnerIdentity);
        try {
          await unlinkVerifiedOwner(ownerPath, cleanupOwner);
        } finally {
          await cleanupOwner.handle.close().catch(() => {});
        }
        await fsyncDirectory(lockDirectory);
      } else {
        const ownerStillExists = await fsp.lstat(ownerPath).then(() => true, (candidateError) => {
          if (candidateError?.code === 'ENOENT') return false;
          throw candidateError;
        });
        if (ownerStillExists) throw unsafeUploadLock('Unverified upload lock owner remains after creation failure.');
      }
      const cleanupLockState = await snapshotVerifiedLockDirectory(lockDirectory, creationLockSession);
      creationLockSession.identity = cleanupLockState;
      await rmdirVerifiedLock(lockDirectory, creationLockSession, { expectedState: cleanupLockState });
      await fsyncDirectory(stageDirectory);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Upload lock creation failed and cleanup could not be proven safe.', { cause: error });
    }
    throw error;
  } finally {
    await creationLockSession?.handle?.close().catch(() => {});
  }

  let released = false;
  return async () => {
    if (released) return;
    const releaseErrors = [];
    const releaseUnlink = options.releaseUnlink || fsp.unlink;
    const releaseRmdir = options.releaseRmdir || fsp.rmdir;
    const releaseSyncDirectory = options.releaseSyncDirectory || fsyncDirectory;
    let lockSession;
    let ownerSession;
    let ownerRemoved = false;
    try {
      lockSession = await openVerifiedLockDirectory(lockDirectory, lockIdentity);
      ownerSession = await openStableOwnerFile(ownerPath, {
        ...lockSession.contract,
        size: Buffer.byteLength(ownerText, 'utf8')
      }, ownerIdentity);
      if (ownerSession.text !== ownerText) throw unsafeUploadLock('Upload lock ownership changed unexpectedly.');
      await options.beforeReleaseOwnerUnlink?.({ lockDirectory, ownerPath });
      await assertVerifiedLockDirectory(lockDirectory, lockSession, lockIdentity);
      await unlinkVerifiedOwner(ownerPath, ownerSession, releaseUnlink);
      ownerRemoved = true;
    } catch (error) {
      releaseErrors.push(error);
    }
    if (ownerRemoved) {
      try { await releaseSyncDirectory(lockDirectory); }
      catch (error) { releaseErrors.push(error); }
      try { await ownerSession?.handle.close(); ownerSession = null; }
      catch (error) { releaseErrors.push(error); }
      let postUnlinkLockState;
      try {
        postUnlinkLockState = await snapshotVerifiedLockDirectory(lockDirectory, lockSession);
      } catch (error) {
        releaseErrors.push(error);
      }
      if (postUnlinkLockState) {
        try {
          await rmdirVerifiedLock(lockDirectory, lockSession, {
            expectedState: postUnlinkLockState,
            beforeRmdir: options.beforeReleaseLockRmdir,
            rmdirLock: releaseRmdir
          });
        } catch (error) {
          releaseErrors.push(error);
        }
      }
      try { await releaseSyncDirectory(stageDirectory); }
      catch (error) { releaseErrors.push(error); }
    }
    try { await ownerSession?.handle.close(); }
    catch (error) { releaseErrors.push(error); }
    try { await lockSession?.handle?.close(); }
    catch (error) { releaseErrors.push(error); }
    released = releaseErrors.length === 0;
    if (releaseErrors.length > 0) {
      const failure = new AggregateError(releaseErrors, 'Upload lock release did not complete cleanly.', { cause: releaseErrors[0] });
      failure.exitCode = releaseErrors[0]?.exitCode || 70;
      throw failure;
    }
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
  const assertExpectedRun = async () => {
    if (!options.expectedIdentity) return;
    const current = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', options.runContract);
    if (!sameFilesystemIdentity(options.expectedIdentity, current)) {
      throw commandError('Deployment staging directory identity changed during cleanup.', 70);
    }
  };
  await assertExpectedRun();
  const releaseUploadLock = await acquireUploadLock(stageDirectory, options.cleanupUploadLockOptions);
  const failures = [];
  let markerRemoved = false;
  try {
    const assertOnlyCleanupEntries = async () => {
      const entries = await fsp.readdir(stageDirectory);
      const expected = entries.length === 1 && entries[0] === '.upload.lock' ||
        entries.length === 2 && entries.includes('.upload.lock') && entries.includes(ADMISSION_MARKER);
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
  try { await releaseUploadLock(); }
  catch (error) { failures.push(error); }

  if (failures.length === 0) {
    try {
      await options.afterCleanupUploadLockRelease?.();
      await assertExpectedRun();
      if ((await fsp.readdir(stageDirectory)).length !== 0) {
        throw new Error('Admitted run directory changed during cleanup and remains retryable.');
      }
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

async function runWithUploadLock(releaseLock, action) {
  let result;
  let primaryError;
  try { result = await action(); }
  catch (error) { primaryError = error; }
  let releaseError;
  try { await releaseLock(); }
  catch (error) { releaseError = error; }
  if (primaryError && releaseError) {
    throw new AggregateError([primaryError, releaseError], 'Upload operation and per-run lock release both failed.', { cause: primaryError });
  }
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
  afterAdmissionMkdir,
  afterCleanupDirectoryRead,
  afterCleanupUploadLockRelease,
  afterExistingAdmissionRead,
  cleanupUploadLockOptions
}) {
  const stageDirectory = resolveWithin(stageRoot, runId);
  const syncOptions = { contract: stageRootContract, syncDirectory: stageRootFsync };
  const existingOptions = { runContract, controllerRunContract, syncOptions, now, afterExistingAdmissionRead };
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
              runId,
              runContract,
              afterCleanupDirectoryRead,
              afterCleanupUploadLockRelease,
              cleanupUploadLockOptions
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
  afterCleanupDirectoryRead,
  afterCleanupUploadLockRelease,
  afterExistingAdmissionRead,
  cleanupUploadLockOptions,
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
    afterAdmissionMkdir,
    afterCleanupDirectoryRead,
    afterCleanupUploadLockRelease,
    afterExistingAdmissionRead,
    cleanupUploadLockOptions
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
    let releaseLock;
    try {
      releaseLock = await acquireUploadLock(stageDirectory, uploadLockOptions);
    } catch (error) {
      if (!created && error?.code === 'ENOENT') {
        throw commandError('Deployment run disappeared before upload locking; retry admission.', 75);
      }
      throw error;
    }
    return await runWithUploadLock(releaseLock, async () => {
      const currentRun = await assertSafeDirectory(stageDirectory, 'Deployment staging directory', runContract);
      if (!runIdentity || !sameFilesystemIdentity(runIdentity, currentRun)) {
        throw commandError('Deployment run identity changed before upload publication.', 70);
      }
      if (!await readAdmissionMarker(stageDirectory, runId, runContract)) {
        throw commandError('Deployment run admission changed before upload publication.', 75);
      }
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
    });
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
          runId,
          runContract,
          afterCleanupDirectoryRead,
          afterCleanupUploadLockRelease,
          cleanupUploadLockOptions
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
