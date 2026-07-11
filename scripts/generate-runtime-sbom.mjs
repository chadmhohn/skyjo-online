import path from 'node:path';
import {
  artifactNames,
  assertFullReleaseSha,
  generateRuntimeSbom
} from './runtime-artifact-lib.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

const projectRoot = path.resolve(valueAfter('--project-root') || process.cwd());
const releaseSha = assertFullReleaseSha(valueAfter('--release-sha') || process.env.SKYJO_RELEASE_SHA || process.env.GITHUB_SHA);
const outputDirectory = path.resolve(projectRoot, valueAfter('--output-dir') || process.env.SKYJO_ARTIFACT_DIR || 'release');
const outputPath = path.join(outputDirectory, artifactNames(releaseSha).sbomName);
await generateRuntimeSbom({ projectRoot, outputPath });
console.log(JSON.stringify({ releaseSha, sbomPath: outputPath }));
