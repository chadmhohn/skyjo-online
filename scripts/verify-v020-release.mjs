import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readVerifiedCertificationEvidence } from './certification-lib.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = {
    checksum: path.join(root, 'test-results', 'certification', 'automated.json.sha256'),
    evidence: path.join(root, 'test-results', 'certification', 'automated.json'),
    productionBaseUrl: '',
    releaseSha: '',
    tag: ''
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !['--checksum', '--evidence', '--production-base-url', '--release-sha', '--tag'].includes(name)) {
      throw new Error('Usage: verify-v020-release --release-sha SHA [--evidence FILE --checksum FILE --tag v0.2.0 --production-base-url HTTPS_URL]');
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  options.releaseSha = String(options.releaseSha).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(options.releaseSha)) throw new Error('A full v0.2.0 release SHA is required.');
  if (options.tag && options.tag !== 'v0.2.0') throw new Error('The only accepted release tag is v0.2.0.');
  if (options.productionBaseUrl && !/^https:\/\/[A-Za-z0-9.-]+\/?$/.test(options.productionBaseUrl)) {
    throw new Error('Production verification requires a simple HTTPS origin.');
  }
  return options;
}

async function verifyPublicRelease(baseUrl, releaseSha) {
  const origin = baseUrl.replace(/\/$/, '');
  const [readyResponse, versionResponse] = await Promise.all([
    fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${origin}/version`, { signal: AbortSignal.timeout(10_000) })
  ]);
  if (readyResponse.status !== 200 || versionResponse.status !== 200) throw new Error('Production readiness or version verification failed.');
  const [ready, version] = await Promise.all([readyResponse.json(), versionResponse.json()]);
  if (
    ready.status !== 'ready' ||
    ready.releaseSha !== releaseSha ||
    ready.schemaVersion !== 2 ||
    ready.protocolVersion !== 2 ||
    version.releaseSha !== releaseSha ||
    version.protocolVersion !== 2
  ) {
    throw new Error('Production does not serve the certified v0.2.0 release identity.');
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { stdout: checkoutOutput } = await execFileAsync('git', ['rev-parse', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (checkoutOutput.trim().toLowerCase() !== options.releaseSha) {
    throw new Error('The checked-out source does not match the certified v0.2.0 commit.');
  }
  const { evidence, digest } = await readVerifiedCertificationEvidence(
    path.resolve(options.evidence),
    path.resolve(options.checksum)
  );
  if (evidence.release.sourceSha !== options.releaseSha || evidence.release.version !== '0.2.0') {
    throw new Error('Certification evidence belongs to a different release.');
  }
  const packageDocument = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageDocument.version !== '0.2.0') throw new Error('package.json does not identify v0.2.0.');
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!/^## 0\.2\.0 - 2026-07-13$/m.test(changelog)) throw new Error('The v0.2.0 changelog entry is missing.');
  const releaseIdentity = await loadReleaseIdentity(path.join(root, 'dist'), {
    allowDevelopment: false,
    requireFullSha: true
  });
  if (
    releaseIdentity.releaseSha !== options.releaseSha ||
    releaseIdentity.schemaVersion !== 2 ||
    releaseIdentity.protocolVersion !== 2
  ) {
    throw new Error('Built release identity does not match v0.2.0 certification.');
  }
  if (options.tag) {
    const { stdout } = await execFileAsync('git', ['rev-parse', `${options.tag}^{commit}`], { cwd: root, encoding: 'utf8' });
    if (stdout.trim().toLowerCase() !== options.releaseSha) throw new Error('v0.2.0 does not point to the certified commit.');
  }
  if (options.productionBaseUrl) await verifyPublicRelease(options.productionBaseUrl, options.releaseSha);
  console.log(`Verified v0.2.0 certification ${digest} for ${options.releaseSha}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'v0.2.0 verification failed.');
  process.exitCode = 1;
});
