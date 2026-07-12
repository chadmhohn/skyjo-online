#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodeRollbackResult } from './parse-code-rollback-result.mjs';

const fullShaPattern = /^[a-f0-9]{40}$/;
const releaseTagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

function parseCanonicalObject(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error('Controller result must be one bounded JSON line.');
  }
  let result;
  try { result = JSON.parse(value); }
  catch { throw new Error('Controller result is not valid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Controller result is not an object.');
  return result;
}

export function validateDeploymentControllerResult(value, { mode, releaseSha, tag }) {
  if (!fullShaPattern.test(releaseSha || '')) throw new Error('Expected release SHA is invalid.');
  const result = parseCanonicalObject(value);
  if (mode === 'verify') {
    const canonical = JSON.stringify({ verified: releaseSha, activated: false });
    if (tag !== '-' || value !== canonical) throw new Error('Verify controller result does not match the requested release.');
    return { verified: releaseSha, activated: false };
  }
  if (mode === 'promote') {
    if (!releaseTagPattern.test(tag || '') || result.promoted !== releaseSha || result.tag !== tag) {
      throw new Error('Promotion controller result does not match the requested release and tag.');
    }
    const normalBackup = typeof result.backup === 'string' &&
      new RegExp(`^[0-9]{8}T[0-9]{6}Z-pre-${releaseSha}$`).test(result.backup) &&
      value === JSON.stringify({ promoted: releaseSha, tag, backup: result.backup });
    const idempotent = result.idempotent === true &&
      value === JSON.stringify({ promoted: releaseSha, tag, idempotent: true });
    if (!normalBackup && !idempotent) throw new Error('Promotion controller result has an invalid completion envelope.');
    return normalBackup
      ? { promoted: releaseSha, tag, backup: result.backup }
      : { promoted: releaseSha, tag, idempotent: true };
  }
  if (mode === 'rollback') {
    if (!releaseTagPattern.test(tag || '')) throw new Error('Rollback release tag is invalid.');
    const rollback = parseCodeRollbackResult(value, { failedReleaseSha: releaseSha });
    return { rolledBackTo: rollback.rolledBackTo, legacy: rollback.legacy };
  }
  throw new Error('Controller result mode is unsupported.');
}

async function readStdin(maxBytes = 2048) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Controller result exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function parseArguments(argv) {
  if (argv.length !== 6 || argv[0] !== '--mode' || argv[2] !== '--release-sha' || argv[4] !== '--tag') {
    throw new Error('Invalid controller result validator arguments.');
  }
  return { mode: argv[1], releaseSha: argv[3], tag: argv[5] };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  try {
    const expected = parseArguments(process.argv.slice(2));
    const result = validateDeploymentControllerResult(await readStdin(), expected);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Deployment controller result validation failed.\n');
    process.exitCode = 1;
  }
}
