import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CERTIFICATION_RELEASE_VERSION,
  assertRecoveryTraceMatchesCertification,
  assertRssStageEvidenceMatchesCertification,
  readVerifiedCertificationEvidence,
  readVerifiedRecoveryTraceEvidence,
  readVerifiedRssStageEvidence
} from './certification-lib.mjs';
import { loadReleaseIdentity } from '../server-release.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseTag = `v${CERTIFICATION_RELEASE_VERSION}`;
const releaseChangelogHeading = `## ${CERTIFICATION_RELEASE_VERSION} - 2026-07-24`;

function parseArguments(argv) {
  const options = {
    checksum: path.join(root, 'test-results', 'certification', 'automated.json.sha256'),
    evidence: path.join(root, 'test-results', 'certification', 'automated.json'),
    productionBaseUrl: '',
    recoveryChecksum: path.join(root, 'test-results', 'certification', 'recovery-trials.json.sha256'),
    recoveryEvidence: path.join(root, 'test-results', 'certification', 'recovery-trials.json'),
    releaseSha: '',
    rssChecksum: path.join(root, 'test-results', 'certification', 'rss-stages.json.sha256'),
    rssEvidence: path.join(root, 'test-results', 'certification', 'rss-stages.json'),
    tag: ''
  };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || ![
      '--checksum',
      '--evidence',
      '--production-base-url',
      '--recovery-checksum',
      '--recovery-evidence',
      '--release-sha',
      '--rss-checksum',
      '--rss-evidence',
      '--tag'
    ].includes(name)) {
      throw new Error(`Usage: verify-v020-release --release-sha SHA [--evidence FILE --checksum FILE --recovery-evidence FILE --recovery-checksum FILE --rss-evidence FILE --rss-checksum FILE --tag ${releaseTag} --production-base-url HTTPS_URL]`);
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  options.releaseSha = String(options.releaseSha).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(options.releaseSha)) {
    throw new Error(`A full ${releaseTag} release SHA is required.`);
  }
  if (options.tag && options.tag !== releaseTag) {
    throw new Error(`The only accepted release tag is ${releaseTag}.`);
  }
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
    throw new Error(`Production does not serve the certified ${releaseTag} release identity.`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { stdout: checkoutOutput } = await execFileAsync('git', ['rev-parse', 'HEAD^{commit}'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (checkoutOutput.trim().toLowerCase() !== options.releaseSha) {
    throw new Error(`The checked-out source does not match the certified ${releaseTag} commit.`);
  }
  const [{ evidence, digest }, { evidence: recoveryEvidence }, { evidence: rssEvidence }] = await Promise.all([
    readVerifiedCertificationEvidence(path.resolve(options.evidence), path.resolve(options.checksum)),
    readVerifiedRecoveryTraceEvidence(
      path.resolve(options.recoveryEvidence),
      path.resolve(options.recoveryChecksum)
    ),
    readVerifiedRssStageEvidence(path.resolve(options.rssEvidence), path.resolve(options.rssChecksum))
  ]);
  if (
    evidence.release.sourceSha !== options.releaseSha ||
    evidence.release.version !== CERTIFICATION_RELEASE_VERSION
  ) {
    throw new Error('Certification evidence belongs to a different release.');
  }
  assertRecoveryTraceMatchesCertification(evidence, recoveryEvidence);
  assertRssStageEvidenceMatchesCertification(evidence, rssEvidence);
  const packageDocument = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageDocument.version !== CERTIFICATION_RELEASE_VERSION) {
    throw new Error(`package.json does not identify ${releaseTag}.`);
  }
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.split(/\r?\n/).includes(releaseChangelogHeading)) {
    throw new Error(`The ${releaseTag} changelog entry is missing.`);
  }
  const releaseIdentity = await loadReleaseIdentity(path.join(root, 'dist'), {
    allowDevelopment: false,
    requireFullSha: true
  });
  if (
    releaseIdentity.releaseSha !== options.releaseSha ||
    releaseIdentity.schemaVersion !== 2 ||
    releaseIdentity.protocolVersion !== 2
  ) {
    throw new Error(`Built release identity does not match ${releaseTag} certification.`);
  }
  if (options.tag) {
    const { stdout } = await execFileAsync('git', ['rev-parse', `${options.tag}^{commit}`], { cwd: root, encoding: 'utf8' });
    if (stdout.trim().toLowerCase() !== options.releaseSha) {
      throw new Error(`${releaseTag} does not point to the certified commit.`);
    }
  }
  if (options.productionBaseUrl) await verifyPublicRelease(options.productionBaseUrl, options.releaseSha);
  console.log(`Verified ${releaseTag} certification ${digest} for ${options.releaseSha}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : `${releaseTag} verification failed.`);
  process.exitCode = 1;
});
