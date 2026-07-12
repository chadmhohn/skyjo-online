#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fullShaPattern = /^[a-f0-9]{40}$/;

export function parseCodeRollbackResult(value, { failedReleaseSha } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error('Rollback controller output must be one bounded JSON line.');
  }
  let result;
  try { result = JSON.parse(value); }
  catch { throw new Error('Rollback controller output is not valid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== 'legacy,rolledBackTo' || typeof result.legacy !== 'boolean') {
    throw new Error('Rollback controller output has an invalid shape.');
  }
  if (JSON.stringify({ rolledBackTo: result.rolledBackTo, legacy: result.legacy }) !== value) {
    throw new Error('Rollback controller output is not canonical JSON.');
  }
  if (failedReleaseSha !== undefined && !fullShaPattern.test(failedReleaseSha)) throw new Error('Failed release SHA is invalid.');
  if (result.legacy) {
    if (result.rolledBackTo !== 'legacy') throw new Error('Legacy rollback output is inconsistent.');
    return { legacy: true, rolledBackTo: 'legacy' };
  }
  if (!fullShaPattern.test(result.rolledBackTo || '')) throw new Error('Rollback target SHA is invalid.');
  if (failedReleaseSha !== undefined && result.rolledBackTo === failedReleaseSha) {
    throw new Error('Rollback did not move away from the failed release.');
  }
  return { legacy: false, rolledBackTo: result.rolledBackTo };
}

async function readStdin(maxBytes = 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Rollback controller output exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseCliArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--failed-release-sha' || !fullShaPattern.test(argv[1] || '')) {
    throw new Error('Usage: parse-code-rollback-result.mjs --failed-release-sha <40-char-sha>');
  }
  return argv[1];
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  try {
    const failedReleaseSha = parseCliArguments(process.argv.slice(2));
    const result = parseCodeRollbackResult((await readStdin()).replace(/\r?\n$/, ''), { failedReleaseSha });
    process.stdout.write(`${result.legacy ? 'legacy' : result.rolledBackTo}\n`);
  } catch {
    process.stderr.write('Rollback controller result validation failed.\n');
    process.exitCode = 1;
  }
}
