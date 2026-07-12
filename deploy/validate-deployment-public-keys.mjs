#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthorizationPublicKey } from './deployment-authorization-lib.mjs';

export const DEPLOYMENT_AUTHORIZATION_KEYS = Object.freeze({
  'canary-2026-07': Object.freeze({
    role: 'canary',
    fingerprint: 'e8ba15e37fe810cf70942b27ddbd13957377acc312617e886283582d5ee01875'
  }),
  'production-2026-07': Object.freeze({
    role: 'production',
    fingerprint: '75f645a8397923f62418d5109cb5b85c3475afa458bbdfc4789194e7aa15a1d6'
  })
});

export function publicKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

export async function validateDeploymentPublicKeys({ canaryPath, productionPath, expectedUid }) {
  const [canaryKey, productionKey] = await Promise.all([
    loadAuthorizationPublicKey(canaryPath, { expectedUid }),
    loadAuthorizationPublicKey(productionPath, { expectedUid })
  ]);
  const fingerprints = {
    canary: publicKeyFingerprint(canaryKey),
    production: publicKeyFingerprint(productionKey)
  };
  if (
    fingerprints.canary !== DEPLOYMENT_AUTHORIZATION_KEYS['canary-2026-07'].fingerprint ||
    fingerprints.production !== DEPLOYMENT_AUTHORIZATION_KEYS['production-2026-07'].fingerprint ||
    fingerprints.canary === fingerprints.production
  ) {
    throw new Error('Deployment authorization public keys do not match the pinned lane keyring.');
  }
  return fingerprints;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  validateDeploymentPublicKeys({ canaryPath: process.argv[2], productionPath: process.argv[3], expectedUid: process.getuid?.() }).then(
    (fingerprints) => process.stdout.write(`${JSON.stringify(fingerprints)}\n`),
    () => {
      process.stderr.write('Deployment authorization public-key validation failed.\n');
      process.exitCode = 1;
    }
  );
}
