import path from 'node:path';
import {
  readAiBenchmarkReleaseVersion,
  readVerifiedAiBenchmarkEvidence,
  resolveAiBenchmarkSourceSha
} from './ai-benchmark-evidence.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

const projectRoot = path.resolve(valueAfter('--project-root') || process.cwd());
const evidencePath = path.resolve(projectRoot, valueAfter('--evidence') || 'test-results/ai/benchmark.json');
const checksumPath = path.resolve(projectRoot, valueAfter('--checksum') || `${evidencePath}.sha256`);
const sourceSha = valueAfter('--source-sha') || await resolveAiBenchmarkSourceSha({ projectRoot });
const releaseVersion = valueAfter('--release-version') || await readAiBenchmarkReleaseVersion(projectRoot);
const strategyVersion = Number(valueAfter('--strategy-version') || 1);
const verified = await readVerifiedAiBenchmarkEvidence(evidencePath, checksumPath, {
  expectedReleaseVersion: releaseVersion,
  expectedSourceSha: sourceSha,
  expectedStrategyVersion: strategyVersion
});

console.log(JSON.stringify({
  digest: verified.digest,
  evidencePath,
  releaseVersion: verified.evidence.releaseVersion,
  sourceSha: verified.evidence.sourceSha,
  strategyVersion: verified.evidence.strategyVersion
}));
