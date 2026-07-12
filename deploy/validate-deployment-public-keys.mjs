#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthorizationPublicKey } from './deployment-authorization-lib.mjs';

export const DEPLOYMENT_AUTHORIZATION_KEYS = Object.freeze({
  'canary-2026-07': Object.freeze({
    role: 'canary',
    fingerprint: 'be3e2f90ff827718163c9add11d8c1b539b95109db32e6a0a3ceb41bcd73e26f'
  }),
  'production-2026-07': Object.freeze({
    role: 'production',
    fingerprint: '6320f5bcf311812740996fbe5f022437ddd5e41803669e48000009e4c9d349ba'
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
