import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStateBackup } from '../server-state-backup.mjs';

function usage() {
  return 'Usage: node scripts/verify-state-backup.mjs --backup <directory>';
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--backup' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error(usage());
  }
  return { backupDirectory: argv[1] };
}

export async function runVerifyStateBackupCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await verifyStateBackup(parsed.backupDirectory);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runVerifyStateBackupCli().catch((error) => {
    process.stderr.write(`State backup verification failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
