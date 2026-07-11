import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateBackup, resolveStateSourcePaths } from '../server-state-backup.mjs';

function usage() {
  return [
    'Usage: node scripts/backup-state.mjs --output <directory> [options]',
    '',
    'Options:',
    '  --database <file>  SQLite source (defaults to SKYJO_DB_FILE)',
    '  --rooms <file>     Room-state source (defaults to SKYJO_ROOMS_FILE)',
    '  --release <file>   Release identity (defaults to SKYJO_RELEASE_FILE or release.json)',
    '  --help             Show this help'
  ].join('\n');
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!['--output', '--database', '--rooms', '--release'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  return { values };
}

export async function runBackupStateCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const output = parsed.values.get('--output');
  if (!output) throw new Error('--output is required.');
  const defaults = resolveStateSourcePaths();
  const result = await createStateBackup({
    destinationDirectory: output,
    databasePath: parsed.values.get('--database') || defaults.databasePath,
    roomsPath: parsed.values.get('--rooms') || defaults.roomsPath,
    releasePath: parsed.values.get('--release') || defaults.releasePath
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runBackupStateCli().catch((error) => {
    process.stderr.write(`State backup failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
