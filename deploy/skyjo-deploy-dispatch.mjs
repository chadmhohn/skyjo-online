#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSignedDeploymentCommand } from './deployment-authorization-lib.mjs';
import {
  DIGEST_PATTERN,
  MAX_ARCHIVE_BYTES,
  RELEASE_SHA_PATTERN,
  RUN_ID_PATTERN,
  resolveWithin
} from './release-controller-lib.mjs';

export const DEFAULT_STAGE_ROOT = '/var/tmp/skyjo-deploy';
export const UPLOAD_LOCK_STALE_MS = 15 * 60 * 1000;
export const MAX_STAGE_DIRECTORY_ENTRIES = 128;
export const MAX_PARTIALS_CLEANED_PER_UPLOAD = 32;

function commandError(message = 'Deployment command rejected.', exitCode = 64) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export function parseCommand(value) {
  if (typeof value !== 'string' || value.length > 512 || value.trim() !== value || /[\0\n\r\t]/.test(value) || value.includes('  ')) {
    throw commandError();
  }
  try {
    const { fields, signature } = parseSignedDeploymentCommand(value);
    if (fields.artifactBytes > MAX_ARCHIVE_BYTES) throw commandError();
    return {
      command: fields.command,
      runId: fields.runId,
      releaseSha: fields.releaseSha,
      digest: fields.artifactSha256,
      bytes: fields.artifactBytes,
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

async function assertSafeDirectory(directory, description) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw commandError(`${description} is unsafe.`, 70);
}

async function assertSafeStageRoot(stageRoot, contract) {
  await assertSafeDirectory(stageRoot, 'Deployment staging root');
  const stat = await fsp.lstat(stageRoot);
  if (contract) {
    if (stat.uid !== contract.uid || stat.gid !== contract.gid ||
        (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o1731)) {
      throw commandError('Deployment staging root does not match its non-enumerable ownership contract.', 70);
    }
  }
  return stat;
}

async function fsyncCreatedStageParent(stageRoot, { contract, syncDirectory = fsyncDirectory } = {}) {
  try {
    await syncDirectory(stageRoot);
  } catch (error) {
    if (error?.code !== 'EACCES' || !contract) throw error;
    // The deployment identity intentionally has write+execute but no read on
    // the exact 1731 parent. Revalidate after mkdir before accepting that one
    // expected durability limitation; every other error remains fatal.
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
  try {
    const lockStat = await fsp.lstat(lockDirectory);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return false;
    ownerStat = await fsp.lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return false;
    ownerText = await fsp.readFile(ownerPath, 'utf8');
    owner = JSON.parse(ownerText);
  } catch {
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
    await fsp.unlink(ownerPath);
    await fsyncDirectory(lockDirectory);
    await fsp.rmdir(lockDirectory);
    await fsyncDirectory(stageDirectory);
    released = true;
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

async function sha256RegularFile(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deployment archive is unsafe.');
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
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

export async function performUpload({
  stageRoot = DEFAULT_STAGE_ROOT,
  runId,
  releaseSha,
  digest,
  bytes,
  input = process.stdin,
  enforceStageRootContract = process.platform === 'linux' && path.resolve(stageRoot) === path.resolve(DEFAULT_STAGE_ROOT),
  expectedStageRootUid = 0,
  expectedStageRootGid = process.getgid?.(),
  stageRootFsync = fsyncDirectory
}) {
  if (!RUN_ID_PATTERN.test(runId || '') || !RELEASE_SHA_PATTERN.test(releaseSha || '') ||
      !DIGEST_PATTERN.test(digest || '') || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARCHIVE_BYTES) throw commandError();
  const stageRootContract = enforceStageRootContract
    ? { uid: expectedStageRootUid, gid: expectedStageRootGid }
    : undefined;
  if (stageRootContract && (!Number.isSafeInteger(stageRootContract.uid) || !Number.isSafeInteger(stageRootContract.gid))) {
    throw commandError('Deployment staging ownership contract is unavailable.', 70);
  }
  await assertSafeStageRoot(stageRoot, stageRootContract);
  const stageDirectory = resolveWithin(stageRoot, runId);
  const created = await fsp.mkdir(stageDirectory, { mode: 0o700, recursive: false }).then(() => true).catch((error) => {
    if (error.code === 'EEXIST') return false;
    throw error;
  });
  if (created) {
    try {
      await fsyncCreatedStageParent(stageRoot, { contract: stageRootContract, syncDirectory: stageRootFsync });
    } catch (error) {
      await fsp.rmdir(stageDirectory).catch(() => {});
      throw error;
    }
  }
  await assertSafeDirectory(stageDirectory, 'Deployment staging directory');
  const releaseLock = await acquireUploadLock(stageDirectory);
  try {
    await cleanupAbandonedPartials(stageDirectory);
    const archivePath = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
    const completedSize = await existingArchiveSize(archivePath);
    if (completedSize !== null) {
      if (completedSize !== bytes) throw new Error('Completed deployment archive conflicts with the declared size.');
      if (await sha256RegularFile(archivePath) !== digest) throw new Error('Completed deployment archive conflicts with the approved digest.');
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
      if (await sha256RegularFile(partialPath) !== digest) throw new Error('Upload does not match the approved digest.');
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

export async function dispatch({
  originalCommand = process.env.SSH_ORIGINAL_COMMAND || '',
  stageRoot = DEFAULT_STAGE_ROOT,
  input = process.stdin,
  runControllerImpl = runController,
  performUploadImpl = performUpload
} = {}) {
  const parsed = parseCommand(originalCommand);
  if (parsed.command === 'upload') {
    const authorizationStatus = await runControllerImpl(parsed);
    if (authorizationStatus !== 0) return authorizationStatus;
    const result = await performUploadImpl({ stageRoot, ...parsed, input });
    process.stdout.write(`uploaded ${parsed.runId} ${parsed.releaseSha} ${result.received}${result.idempotent ? ' idempotent' : ''}\n`);
    return 0;
  }
  return runControllerImpl(parsed);
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
