import { verifyRuntimeArtifact } from './runtime-artifact-lib.mjs';

function requiredValue(flag, environmentName) {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? process.env[environmentName] : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} (or ${environmentName}) is required.`);
  return value;
}

const result = await verifyRuntimeArtifact({
  archivePath: requiredValue('--archive', 'SKYJO_ARTIFACT_PATH'),
  checksumPath: requiredValue('--checksum', 'SKYJO_ARTIFACT_CHECKSUM_PATH'),
  expectedReleaseSha: requiredValue('--release-sha', 'SKYJO_RELEASE_SHA')
});

console.log(JSON.stringify({
  releaseSha: result.releaseSha,
  archivePath: result.archivePath,
  checksumPath: result.checksumPath,
  sha256: result.sha256,
  size: result.size,
  entries: result.entries
}));
