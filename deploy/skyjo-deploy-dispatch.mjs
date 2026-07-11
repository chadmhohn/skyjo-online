#!/opt/skyjo-online/node/bin/node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  DIGEST_PATTERN,
  MAX_ARCHIVE_BYTES,
  RELEASE_SHA_PATTERN,
  RELEASE_TAG_PATTERN,
  RUN_ID_PATTERN,
  resolveWithin
} from './release-controller-lib.mjs';

const stageRoot = '/var/tmp/skyjo-deploy';
const originalCommand = process.env.SSH_ORIGINAL_COMMAND || '';

function reject(message = 'Deployment command rejected.') {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

function parseCommand(value) {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) reject();
  const parts = value.trim().split(/ +/);
  const [command, runId, releaseSha, fourth, fifth] = parts;
  if (!RUN_ID_PATTERN.test(runId || '') || !RELEASE_SHA_PATTERN.test(releaseSha || '')) reject();
  if (command === 'upload' && parts.length === 4 && /^(?:[1-9][0-9]{0,9})$/.test(fourth || '')) {
    const bytes = Number(fourth);
    if (bytes <= MAX_ARCHIVE_BYTES) return { command, runId, releaseSha, bytes };
  }
  if (command === 'verify' && parts.length === 4 && DIGEST_PATTERN.test(fourth || '') && runId.endsWith('-canary')) {
    return { command, runId, releaseSha, digest: fourth };
  }
  if ((command === 'promote' || command === 'rollback') && parts.length === 5 && DIGEST_PATTERN.test(fourth || '') && RELEASE_TAG_PATTERN.test(fifth || '') && runId.endsWith('-production')) {
    return { command, runId, releaseSha, digest: fourth, tag: fifth };
  }
  reject();
}

async function assertSafeStageRoot() {
  const stat = await fsp.lstat(stageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject('Deployment staging root is unsafe.');
}

async function upload({ runId, releaseSha, bytes }) {
  await assertSafeStageRoot();
  const stageDirectory = resolveWithin(stageRoot, runId);
  await fsp.mkdir(stageDirectory, { mode: 0o700, recursive: true });
  const stageStat = await fsp.lstat(stageDirectory);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) reject('Deployment staging directory is unsafe.');
  const archivePath = resolveWithin(stageDirectory, `skyjo-runtime-${releaseSha}.tar.gz`);
  const partialPath = resolveWithin(stageDirectory, `.${releaseSha}.part`);
  let handle;
  try {
    await fsp.rm(partialPath, { force: true });
    handle = await fsp.open(partialPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    let received = 0;
    for await (const chunk of process.stdin) {
      received += chunk.length;
      if (received > bytes || received > MAX_ARCHIVE_BYTES) throw new Error('Upload exceeded declared size.');
      await handle.write(chunk);
    }
    await handle.sync();
    if (received !== bytes) throw new Error('Upload did not match declared size.');
    await handle.close();
    handle = null;
    await fsp.rename(partialPath, archivePath);
    process.stdout.write(`uploaded ${runId} ${releaseSha} ${received}\n`);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function controller(parsed) {
  const argumentsList = [parsed.command, '--run-id', parsed.runId, '--release-sha', parsed.releaseSha];
  if (parsed.digest) argumentsList.push('--artifact-sha256', parsed.digest);
  if (parsed.tag) argumentsList.push('--tag', parsed.tag);
  const child = spawn('/usr/bin/sudo', ['--non-interactive', '/usr/local/sbin/skyjo-release-controller', ...argumentsList], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }
  });
  const status = await new Promise((resolve, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolve(signal ? 70 : (code ?? 70)));
  });
  process.exit(status);
}

try {
  const parsed = parseCommand(originalCommand);
  if (parsed.command === 'upload') await upload(parsed);
  else await controller(parsed);
} catch (error) {
  process.stderr.write(`Deployment command failed: ${error?.message || 'unknown error'}\n`);
  process.exit(70);
}
