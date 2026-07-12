import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScheduledBackup } from './scheduled-backup-lib.mjs';

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--kind' || !['daily', 'monthly'].includes(argv[1])) {
    throw new Error('Usage: node scripts/run-scheduled-backup.mjs --kind <daily|monthly>');
  }
  return argv[1];
}

export async function runScheduledBackupCli(argv = process.argv.slice(2), options = {}) {
  const result = await runScheduledBackup({ ...options, kind: parseArguments(argv) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runScheduledBackupCli().catch(() => {
    process.stderr.write('Scheduled backup failed without exposing state paths or contents.\n');
    process.exitCode = 1;
  });
}
