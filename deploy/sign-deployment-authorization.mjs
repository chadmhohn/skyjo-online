#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAuthorizationPrivateKey,
  normalizeAuthorizationFields,
  signDeploymentAuthorization
} from './deployment-authorization-lib.mjs';

function parseArguments(argv) {
  const allowed = new Set([
    '--role', '--command', '--run-id', '--release-sha', '--artifact-sha256', '--tag', '--key-id', '--private-key', '--lifetime-seconds'
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) throw new Error('Invalid deployment authorization signer arguments.');
    values.set(flag, value);
  }
  for (const required of [...allowed].filter((flag) => flag !== '--lifetime-seconds')) {
    if (!values.has(required)) throw new Error('Missing deployment authorization signer argument.');
  }
  const lifetime = Number(values.get('--lifetime-seconds') || 300);
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 600) throw new Error('Invalid deployment authorization lifetime.');
  return { values, lifetime };
}

export async function createSignedAuthorization(argv, options = {}) {
  const { values, lifetime } = parseArguments(argv);
  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fields = normalizeAuthorizationFields({
    role: values.get('--role'),
    command: values.get('--command'),
    runId: values.get('--run-id'),
    releaseSha: values.get('--release-sha'),
    artifactSha256: values.get('--artifact-sha256'),
    tag: values.get('--tag'),
    issuedAt,
    expiresAt: issuedAt + lifetime,
    keyId: values.get('--key-id')
  }, { nowSeconds: issuedAt });
  const privateKey = await loadAuthorizationPrivateKey(values.get('--private-key'), {
    expectedUid: options.expectedUid ?? process.getuid?.()
  });
  return {
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    keyId: fields.keyId,
    signature: signDeploymentAuthorization(fields, privateKey, { nowSeconds: issuedAt })
  };
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  createSignedAuthorization(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write('Deployment authorization signing failed.\n');
      process.exitCode = 1;
    }
  );
}
