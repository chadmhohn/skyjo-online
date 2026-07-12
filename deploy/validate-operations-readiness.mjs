import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedKeys = [
  'attempts',
  'checkedAt',
  'failureClass',
  'formatVersion',
  'httpStatus',
  'monitor',
  'protocolVersion',
  'releaseSha',
  'schemaVersion',
  'status'
];

export async function validateOperationsReadiness(filePath, expectedReleaseSha, expectedUid, platform = process.platform) {
  if (!/^[a-f0-9]{40}$/.test(expectedReleaseSha || '')) throw new Error('Expected release SHA is invalid.');
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) throw new Error('Expected monitor user identity is invalid.');
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4096) {
    throw new Error('Local readiness evidence is not a bounded regular file.');
  }
  if (platform !== 'win32' && (stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600)) {
    throw new Error('Local readiness evidence ownership or mode is invalid.');
  }
  const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Local readiness evidence is invalid.');
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('Local readiness evidence has an unexpected shape.');
  }
  const checkedAt = new Date(value.checkedAt);
  if (
    value.formatVersion !== 1 || value.monitor !== 'local' || value.status !== 'healthy' ||
    value.attempts !== 1 || value.failureClass !== null || value.httpStatus !== 200 ||
    value.releaseSha !== expectedReleaseSha ||
    !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 ||
    !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1 ||
    Number.isNaN(checkedAt.getTime()) || checkedAt.toISOString() !== value.checkedAt
  ) {
    throw new Error('Local readiness evidence does not match the active release.');
  }
  return { releaseSha: value.releaseSha, checkedAt: value.checkedAt };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [expectedReleaseSha, expectedUid, extra] = process.argv.slice(2);
  if (extra !== undefined || !/^(?:0|[1-9][0-9]*)$/.test(expectedUid || '')) {
    process.stderr.write('Operations readiness validation failed.\n');
    process.exitCode = 1;
  } else {
    try {
      await validateOperationsReadiness(
        '/var/lib/skyjo-monitor/local-readiness.json',
        expectedReleaseSha,
        Number(expectedUid)
      );
    } catch {
      process.stderr.write('Operations readiness validation failed.\n');
      process.exitCode = 1;
    }
  }
}
