import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateSourcePaths, restoreStateBackup } from '../server-state-backup.mjs';

function usage() {
  return 'Usage: node scripts/restore-state.mjs --backup <directory> --destination <fresh-directory>';
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--backup', '--destination'].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  if (!values.has('--backup') || !values.has('--destination')) throw new Error(usage());
  return {
    backupDirectory: values.get('--backup'),
    destinationDirectory: values.get('--destination')
  };
}

export async function runRestoreStateCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const livePaths = Object.values(resolveStateSourcePaths());
  const result = await restoreStateBackup(parsed.backupDirectory, {
    destinationDirectory: parsed.destinationDirectory,
    livePaths
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRestoreStateCli().catch((error) => {
    process.stderr.write(`State restore failed: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
