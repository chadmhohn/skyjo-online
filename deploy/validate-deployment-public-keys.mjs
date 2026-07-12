#!/opt/skyjo-online/node/bin/node

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthorizationPublicKey } from './deployment-authorization-lib.mjs';

export const DEPLOYMENT_AUTHORIZATION_KEYS = Object.freeze({
  'canary-primary': Object.freeze({
    role: 'canary',
    fingerprint: '233552349715bb1b6b2b5c9edb39114d4a325795ce08ae94a48f7f96ddec62c3'
  }),
  'production-primary': Object.freeze({
    role: 'production',
    fingerprint: '3b3ddc163fa6052c079baff53a36cfc0779b1ae953d4d3a515477bd34f036c9a'
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
    fingerprints.canary !== DEPLOYMENT_AUTHORIZATION_KEYS['canary-primary'].fingerprint ||
    fingerprints.production !== DEPLOYMENT_AUTHORIZATION_KEYS['production-primary'].fingerprint ||
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
