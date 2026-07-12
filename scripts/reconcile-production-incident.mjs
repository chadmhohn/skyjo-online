import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubApi, reconcileProductionIncident } from './production-incident-lib.mjs';

export async function runIncidentReconciliation(env = process.env, dependencies = {}) {
  const resultPath = path.resolve(String(env.SKYJO_MONITOR_RESULT || ''));
  if (!env.SKYJO_MONITOR_RESULT || path.basename(resultPath) !== 'skyjo-readiness-result.json') {
    throw new Error('Trusted monitor result path is missing or invalid.');
  }
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const api = dependencies.api || createGithubApi({ token: env.GITHUB_TOKEN, fetchImpl: dependencies.fetchImpl });
  const outcome = await reconcileProductionIncident({
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    result,
    source: env.SKYJO_INCIDENT_SOURCE || 'readiness',
    api
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runIncidentReconciliation().catch(() => {
    process.stderr.write('Production incident reconciliation failed without exposing remote or monitor details.\n');
    process.exitCode = 1;
  });
}
