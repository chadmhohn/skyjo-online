import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGovernanceApi, reconcileGithubGovernance } from './github-governance-lib.mjs';

function parseArguments(argv) {
  let apply = false;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (apply) throw new Error('Duplicate --apply flag.');
      apply = true;
      continue;
    }
    if (!['--repo', '--confirm'].includes(argument)) throw new Error('Unknown governance argument.');
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values.has(argument)) throw new Error('Invalid governance argument.');
    values.set(argument, value);
    index += 1;
  }
  const repository = values.get('--repo') || process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('Repository identity is required.');
  return { repository, confirmation: values.get('--confirm'), apply };
}

export async function runGovernance(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseArguments(argv);
  const api = dependencies.api || (options.apply ? createGovernanceApi({ token: env.GITHUB_TOKEN, fetchImpl: dependencies.fetchImpl }) : async () => null);
  const result = await reconcileGithubGovernance({ ...options, api });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runGovernance().catch(() => {
    process.stderr.write('GitHub governance reconciliation failed without exposing credentials or remote response content.\n');
    process.exitCode = 1;
  });
}
