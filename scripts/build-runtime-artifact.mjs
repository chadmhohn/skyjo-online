import path from 'node:path';
import { buildRuntimeArtifact } from './runtime-artifact-lib.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

const projectRoot = path.resolve(valueAfter('--project-root') || process.cwd());
const outputDirectory = path.resolve(projectRoot, valueAfter('--output-dir') || process.env.SKYJO_ARTIFACT_DIR || 'release');
const releaseSha = valueAfter('--release-sha') || process.env.SKYJO_RELEASE_SHA || process.env.GITHUB_SHA;

const result = await buildRuntimeArtifact({ projectRoot, outputDirectory, releaseSha });
console.log(JSON.stringify({
  releaseSha: result.releaseSha,
  archivePath: result.archivePath,
  checksumPath: result.checksumPath,
  sbomPath: result.sbomPath,
  sha256: result.sha256,
  size: result.size,
  entries: result.entries
}));
