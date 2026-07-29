import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CERTIFICATION_RELEASE_VERSION } from './certification-lib.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const semanticVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const fullShaPattern = /^[a-f0-9]{40}$/;

function exactVersion(value, label) {
  if (typeof value !== 'string' || !semanticVersionPattern.test(value)) {
    throw new Error(`${label} is not an exact release version.`);
  }
  return value;
}

export function validateReleaseTagMetadata({
  tagRef,
  tagName,
  packageVersion,
  packageLockVersion,
  packageLockRootVersion,
  certificationVersion
}) {
  const version = exactVersion(packageVersion, 'package.json version');
  const expectedTag = `v${version}`;
  if (tagRef !== `refs/tags/${expectedTag}` || tagName !== expectedTag) {
    throw new Error('Release tag does not match package.json version.');
  }
  if (
    exactVersion(packageLockVersion, 'package-lock.json version') !== version ||
    exactVersion(packageLockRootVersion, 'package-lock.json root package version') !== version
  ) {
    throw new Error('package-lock.json release version does not match package.json.');
  }
  if (exactVersion(certificationVersion, 'Certification version') !== version) {
    throw new Error('Certification release version does not match package.json.');
  }
  return expectedTag;
}

async function defaultRunGit(arguments_) {
  const { stdout } = await execFileAsync('git', arguments_, { cwd: root, encoding: 'utf8' });
  return stdout;
}

export async function verifyReleaseTagIdentity({
  tagRef,
  tagName,
  packageDocument,
  packageLock,
  certificationVersion = CERTIFICATION_RELEASE_VERSION,
  runGit = defaultRunGit
}) {
  const expectedTag = validateReleaseTagMetadata({
    tagRef,
    tagName,
    packageVersion: packageDocument?.version,
    packageLockVersion: packageLock?.version,
    packageLockRootVersion: packageLock?.packages?.['']?.version,
    certificationVersion
  });
  const objectType = String(await runGit(['cat-file', '-t', tagRef])).trim();
  if (objectType !== 'tag') throw new Error('Release tag must be an annotated tag object.');

  const tagObject = String(await runGit(['rev-parse', '--verify', `${tagRef}^{tag}`])).trim();
  const taggedCommit = String(await runGit(['rev-parse', '--verify', `${tagRef}^{commit}`])).trim();
  const checkoutCommit = String(await runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!fullShaPattern.test(tagObject) || !fullShaPattern.test(taggedCommit) || !fullShaPattern.test(checkoutCommit)) {
    throw new Error('Release tag object or commit identity is malformed.');
  }
  if (taggedCommit !== checkoutCommit) {
    throw new Error('Release tag does not resolve to the checked-out commit.');
  }
  return Object.freeze({ expectedTag, tagObject, taggedCommit });
}

async function main() {
  if (process.argv.length !== 4) {
    throw new Error('Usage: verify-release-tag-identity <refs/tags/vX.Y.Z> <vX.Y.Z>');
  }
  let packageDocument;
  let packageLock;
  try {
    [packageDocument, packageLock] = await Promise.all([
      fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'package-lock.json'), 'utf8').then(JSON.parse)
    ]);
  } catch {
    throw new Error('Release package metadata is unreadable.');
  }
  const result = await verifyReleaseTagIdentity({
    tagRef: process.argv[2],
    tagName: process.argv[3],
    packageDocument,
    packageLock
  });
  console.log(`Verified annotated ${result.expectedTag} at ${result.taggedCommit}.`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Release tag identity verification failed.');
    process.exitCode = 1;
  });
}
