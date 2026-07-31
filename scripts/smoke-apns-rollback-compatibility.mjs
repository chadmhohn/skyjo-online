import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApnsRollbackProof } from '../server-apns-rollback-proof.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';

if (process.argv.slice(2).length !== 0) {
  throw new Error('Usage: smoke-apns-rollback-compatibility.mjs');
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const releaseIdentity = await loadReleaseIdentity(path.join(projectRoot, 'dist'), {
  allowDevelopment: false,
  requireFullSha: true
});

await runApnsRollbackProof({ expectedReleaseSha: releaseIdentity.releaseSha });
