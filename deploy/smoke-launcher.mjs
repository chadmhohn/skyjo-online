#!/opt/skyjo-online/node/bin/node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stagePattern = /^\/var\/tmp\/skyjo-deploy\/[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(?:canary|production)\/release$/;
const immutablePattern = /^\/srv\/skyjo-online\/releases\/[a-f0-9]{40}$/;

export async function validateSmokeReleaseDirectory(value) {
  if (typeof value !== 'string' || (!stagePattern.test(value) && !immutablePattern.test(value))) {
    throw new Error('Smoke release directory is outside the deployment roots.');
  }
  const resolved = path.resolve(value);
  const real = await fs.realpath(resolved);
  if (real !== resolved) throw new Error('Smoke release directory must not be a symlink.');
  const directory = await fs.lstat(real);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Smoke release path is not a safe directory.');
  for (const required of ['release.json', 'scripts/smoke-deployed.mjs']) {
    const stat = await fs.lstat(path.join(real, required));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Smoke runtime file is unsafe: ${required}`);
  }
  return real;
}

export async function main() {
  const releaseDirectory = await validateSmokeReleaseDirectory(process.env.SKYJO_CANARY_RELEASE_DIR);
  const smokeScript = path.join(releaseDirectory, 'scripts', 'smoke-deployed.mjs');
  const child = spawn(process.execPath, [smokeScript], {
    cwd: releaseDirectory,
    env: process.env,
    stdio: 'inherit'
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) throw new Error(`Smoke process was terminated by ${result.signal}.`);
  if (result.code !== 0) process.exitCode = result.code ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Deployment smoke refused: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
