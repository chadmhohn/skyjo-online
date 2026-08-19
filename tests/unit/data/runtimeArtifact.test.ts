import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  artifactNames,
  assertFullReleaseSha,
  deriveRuntimeInventory,
  isAllowedRuntimePath,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_FILE_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  normalizeArchivePath,
  parseTarArchive,
  pruneForbiddenRuntimePaths,
  readBoundedRegularFile,
  REQUIRED_ARCHIVE_FILES,
  validateRuntimeEntries,
  verifyRuntimeArtifact
} from '../../../scripts/runtime-artifact-lib.mjs';
import { CURRENT_PROTOCOL_VERSION, sha256 } from '../../../server-release.mjs';

const releaseSha = '0123456789abcdef0123456789abcdef01234567';
const releaseIdentity = {
  formatVersion: 1,
  releaseSha,
  buildTimestamp: '2026-07-11T12:00:00.000Z',
  schemaVersion: 2,
  protocolVersion: CURRENT_PROTOCOL_VERSION
};
const releaseData = Buffer.from(`${JSON.stringify(releaseIdentity, null, 2)}\n`);
const releaseChecksum = Buffer.from(`${sha256(releaseData)}  release.json\n`);
const packageData = Buffer.from(JSON.stringify({
  name: 'skyjo-online',
  version: '0.1.0',
  private: true,
  type: 'module',
  dependencies: {
    react: '18.3.1',
    'react-dom': '18.3.1',
    'react-router-dom': '6.30.4',
    'web-push': '3.6.7',
    ws: '8.21.0'
  }
}));
const lockedPackages = [
  ['react', '18.3.1'],
  ['react-dom', '18.3.1'],
  ['react-router-dom', '6.30.4'],
  ['web-push', '3.6.7'],
  ['ws', '8.21.0']
] as const;
const lockData = Buffer.from(JSON.stringify({
  name: 'skyjo-online',
  version: '0.1.0',
  lockfileVersion: 3,
  packages: Object.fromEntries([
    ['', {
      name: 'skyjo-online',
      version: '0.1.0',
      dependencies: Object.fromEntries(lockedPackages)
    }],
    ...lockedPackages.map(([name, version]) => [`node_modules/${name}`, { version }])
  ])
}));
const sbomData = Buffer.from(JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  metadata: {
    component: {
      type: 'application',
      name: 'skyjo-online',
      version: '0.1.0',
      properties: [{ name: 'skyjo:releaseSha', value: releaseSha }]
    }
  },
  components: lockedPackages.map(([name, version]) => ({ type: 'library', name, version }))
}));

type TarEntry = {
  rawPath: string;
  typeFlag: string;
  size: number;
  linkName: string;
  data: Buffer;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
};

type SbomFixture = {
  bomFormat: string;
  specVersion: string;
  metadata: {
    component: {
      version: string;
      properties: Array<{ name: string; value: string }>;
    };
  };
  components: Array<{ type?: string; name?: string; version?: string }>;
};

function fixtureEntries(): TarEntry[] {
  const archiveFiles = [
    ...REQUIRED_ARCHIVE_FILES,
    ...lockedPackages.map(([name]) => `node_modules/${name}/package.json`)
  ];
  return archiveFiles.map((rawPath: string) => {
    let data = Buffer.from(`fixture:${rawPath}`);
    if (rawPath === 'release.json' || rawPath === 'dist/release.json') data = releaseData;
    if (rawPath === 'release.json.sha256' || rawPath === 'dist/release.json.sha256') data = releaseChecksum;
    if (rawPath === 'package.json') data = packageData;
    if (rawPath === 'package-lock.json') data = lockData;
    if (rawPath === 'skyjo-runtime.cdx.json') data = sbomData;
    const lockedPackage = lockedPackages.find(([name]) => rawPath === `node_modules/${name}/package.json`);
    if (lockedPackage) data = Buffer.from(JSON.stringify({ name: lockedPackage[0], version: lockedPackage[1] }));
    return {
      rawPath,
      typeFlag: '0',
      size: data.length,
      linkName: '',
      data,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: Date.parse(releaseIdentity.buildTimestamp) / 1000
    };
  });
}

function writeOctal(header: Buffer, offset: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(text, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarHeader(entry: TarEntry) {
  const header = Buffer.alloc(512);
  header.write(entry.rawPath, 0, 100, 'utf8');
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, entry.uid);
  writeOctal(header, 116, 8, entry.gid);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, entry.mtime);
  header.fill(0x20, 148, 156);
  header[156] = entry.typeFlag.charCodeAt(0);
  if (entry.linkName) header.write(entry.linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'binary');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createTar(entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeValidArtifactFixture(directory: string) {
  const names = artifactNames(releaseSha);
  const archivePath = path.join(directory, names.archiveName);
  const checksumPath = path.join(directory, names.checksumName);
  const archive = gzipSync(createTar(fixtureEntries()), { level: 9 });
  await fs.writeFile(archivePath, archive);
  await fs.writeFile(checksumPath, `${sha256(archive)}  ${names.archiveName}\n`);
  return { names, archivePath, checksumPath };
}

function replaceFile(entries: TarEntry[], rawPath: string, data: Buffer) {
  const index = entries.findIndex((entry) => entry.rawPath === rawPath);
  entries[index] = { ...entries[index], data, size: data.length };
  return entries;
}

function withSbomMutation(mutator: (sbom: SbomFixture) => void) {
  const entries = fixtureEntries();
  const sbom = JSON.parse(sbomData.toString('utf8')) as SbomFixture;
  mutator(sbom);
  return replaceFile(entries, 'skyjo-runtime.cdx.json', Buffer.from(JSON.stringify(sbom)));
}

describe('runtime artifact safety contract', () => {
  test('requires an exact lowercase commit SHA and SHA-addressed filenames', () => {
    expect(assertFullReleaseSha(releaseSha.toUpperCase())).toBe(releaseSha);
    expect(() => assertFullReleaseSha('abc1234')).toThrow('full lowercase 40-character');
    expect(artifactNames(releaseSha)).toEqual({
      archiveName: `skyjo-runtime-${releaseSha}.tar.gz`,
      checksumName: `skyjo-runtime-${releaseSha}.tar.gz.sha256`,
      sbomName: `skyjo-runtime-${releaseSha}.cdx.json`
    });
  });

  test.each([
    '../escape',
    'dist/../escape',
    '/etc/passwd',
    'C:/Windows/System32',
    'dist\\index.html',
    'dist//index.html',
    'dist/./index.html',
    '././dist/index.html'
  ])('rejects unsafe archive path %s', (unsafePath) => {
    expect(() => normalizeArchivePath(unsafePath)).toThrow();
  });

  test('normalizes canonical root and directory spellings without broadening the allowlist', () => {
    expect(normalizeArchivePath('./dist/')).toBe('dist');
    expect(() => normalizeArchivePath('././dist/')).toThrow('traversal or ambiguous');
    expect(normalizeArchivePath('.', { allowRoot: true })).toBe('');
    expect(() => normalizeArchivePath('.')).toThrow('archive root');
    expect(() => normalizeArchivePath('')).toThrow('empty path');
    expect(() => normalizeArchivePath('dist/evil\u0000name')).toThrow('control characters');
    expect(() => normalizeArchivePath('node_modules/minimist/bad\tname')).toThrow('control characters');
    expect(() => normalizeArchivePath('node_modules/minimist/bad\u007fname')).toThrow('control characters');
    expect(isAllowedRuntimePath('.', true)).toBe(true);
    expect(isAllowedRuntimePath('dist', true)).toBe(true);
    expect(isAllowedRuntimePath('server.mjs', true)).toBe(false);
    expect(isAllowedRuntimePath('scripts', true)).toBe(true);
  });

  test.each([
    'node_modules/minimist/.github/FUNDING.yml',
    'node_modules/minimist/.GitHub/workflow.yml',
    'node_modules/minimist/.git/config',
    'node_modules/minimist/.GIT/config',
    'node_modules/minimist/.env',
    'node_modules/minimist/.env.production',
    'node_modules/minimist/.ENV.local',
    'node_modules/minimist/.envrc',
    'node_modules/minimist/.EnViRoNmEnT'
  ])('rejects forbidden SCM and environment path %s', (forbiddenPath) => {
    expect(() => normalizeArchivePath(forbiddenPath)).toThrow('forbidden SCM or environment');
    expect(() => isAllowedRuntimePath(forbiddenPath)).toThrow('forbidden SCM or environment');
  });

  test('keeps non-secret package dotfiles coherent with the deployment allowlist', () => {
    expect(normalizeArchivePath('node_modules/minimist/.gitignore')).toBe('node_modules/minimist/.gitignore');
    expect(normalizeArchivePath('node_modules/minimist/.npmignore')).toBe('node_modules/minimist/.npmignore');
    expect(normalizeArchivePath('node_modules/minimist/.github-actions/config.yml')).toBe('node_modules/minimist/.github-actions/config.yml');
    expect(isAllowedRuntimePath('node_modules/minimist/.gitignore')).toBe(true);
    expect(isAllowedRuntimePath('node_modules/minimist/.npmignore')).toBe(true);
    expect(isAllowedRuntimePath('node_modules/minimist/.github-actions/config.yml')).toBe(true);
  });

  test('allows only compiled output, production dependencies, metadata, and exact runtime scripts', () => {
    expect(REQUIRED_ARCHIVE_FILES).toContain('server-apns.mjs');
    expect(REQUIRED_ARCHIVE_FILES).toContain('server-apns-rollback-proof.mjs');
    expect(REQUIRED_ARCHIVE_FILES).not.toContain('scripts/smoke-apns-rollback-compatibility.mjs');
    expect(isAllowedRuntimePath('./dist/assets/app.js')).toBe(true);
    expect(isAllowedRuntimePath('node_modules/ws/index.js')).toBe(true);
    expect(isAllowedRuntimePath('server-game-state-validation.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-apns.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-apns-rollback-proof.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-invite-codes.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-room-invites.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-push.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-unicode.mjs')).toBe(true);
    expect(isAllowedRuntimePath('server-unicode.d.mts')).toBe(false);
    expect(isAllowedRuntimePath('scripts/smoke-apns-rollback-compatibility.mjs')).toBe(false);
    expect(isAllowedRuntimePath('scripts/smoke-deployed.mjs')).toBe(true);
    expect(isAllowedRuntimePath('scripts/smoke-chat.mjs')).toBe(false);
    expect(isAllowedRuntimePath('src/game.ts')).toBe(false);
    expect(isAllowedRuntimePath('tests/unit/data/foo.test.ts')).toBe(false);
    expect(() => isAllowedRuntimePath('.env')).toThrow('forbidden SCM or environment');
  });

  test('deterministically prunes forbidden dependency metadata before packaging', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-runtime-prune-'));
    const nodeModulesRoot = path.join(root, 'node_modules');
    const packageRoot = path.join(nodeModulesRoot, 'minimist');
    const forbidden = [
      '.github/FUNDING.yml',
      '.git/config',
      '.env',
      '.env.production',
      '.envrc',
      '.EnViRoNmEnT'
    ];
    const allowed = ['.gitignore', '.npmignore', '.github-actions/config.yml', 'index.js'];
    try {
      for (const relativePath of [...forbidden, ...allowed]) {
        const filePath = path.join(packageRoot, ...relativePath.split('/'));
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, relativePath);
      }
      const firstPartyForbidden = path.join(root, 'dist', '.github', 'workflow.yml');
      await fs.mkdir(path.dirname(firstPartyForbidden), { recursive: true });
      await fs.writeFile(firstPartyForbidden, 'must fail validation rather than be pruned');
      const removed = await pruneForbiddenRuntimePaths(nodeModulesRoot);
      const expectedRemoved = [
        'minimist/.env',
        'minimist/.env.production',
        'minimist/.envrc',
        'minimist/.EnViRoNmEnT',
        'minimist/.git',
        'minimist/.github'
      ].sort((left, right) => left.localeCompare(right, 'en'));
      expect(removed).toEqual(expectedRemoved);
      for (const relativePath of forbidden) {
        await expect(fs.lstat(path.join(packageRoot, ...relativePath.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      for (const relativePath of allowed) {
        await expect(fs.readFile(path.join(packageRoot, ...relativePath.split('/')), 'utf8')).resolves.toBe(relativePath);
      }
      await expect(fs.readFile(firstPartyForbidden, 'utf8')).resolves.toBe('must fail validation rather than be pruned');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    'node_modules/minimist/.github/FUNDING.yml',
    'node_modules/minimist/.git/config',
    'node_modules/minimist/.env.production',
    'dist/.github/workflow.yml'
  ])('rejects forbidden packaged entry %s before inventory validation', (rawPath) => {
    const entries = fixtureEntries();
    const data = Buffer.from('forbidden');
    entries.push({ ...entries[0], rawPath, data, size: data.length });
    expect(() => validateRuntimeEntries(entries, releaseSha)).toThrow('forbidden SCM or environment');
  });

  test('validates the complete allowlisted runtime and byte-identical release identities', () => {
    const result = validateRuntimeEntries(fixtureEntries(), releaseSha);
    expect(result.releaseIdentity.releaseSha).toBe(releaseSha);
    expect(result.files.has('server-apns.mjs')).toBe(true);
    expect(result.files.has('server-apns-rollback-proof.mjs')).toBe(true);
    expect(result.files.has('server-game-state-validation.mjs')).toBe(true);
    expect(result.files.has('server-invite-codes.mjs')).toBe(true);
    expect(result.files.has('server-room-invites.mjs')).toBe(true);
    expect(result.files.has('server-push.mjs')).toBe(true);
    expect(result.files.has('server-unicode.mjs')).toBe(true);
    expect(result.files.has('server-unicode.d.mts')).toBe(false);
    expect(result.files.has('server-dist/protocolV2.js')).toBe(true);
    expect(result.files.has('server-dist/serverProtocolV2.js')).toBe(true);
    expect(result.files.has('server-dist/serverRealtime.js')).toBe(true);
    expect(result.files.has('src/game.ts')).toBe(false);
  });

  test('derives the exact non-dev package name and version inventory from package-lock', () => {
    const inventory = deriveRuntimeInventory(packageData, lockData);
    expect(inventory.root).toEqual({ name: 'skyjo-online', version: '0.1.0' });
    expect(inventory.packages.map(({ name, version }: { name: string; version: string }) => `${name}@${version}`)).toEqual([
      'react@18.3.1',
      'react-dom@18.3.1',
      'react-router-dom@6.30.4',
      'web-push@3.6.7',
      'ws@8.21.0'
    ]);
  });

  test('rejects malformed package metadata, lock roots, dependency drift, and empty runtime inventories', () => {
    expect(() => deriveRuntimeInventory(Buffer.from('{'), lockData)).toThrow('not valid JSON');
    expect(() => deriveRuntimeInventory(Buffer.from('{}'), lockData)).toThrow('metadata is invalid');
    const lock = JSON.parse(lockData.toString('utf8'));
    expect(() => deriveRuntimeInventory(packageData, Buffer.from('{}'))).toThrow('lock root');
    const drift = structuredClone(lock);
    drift.packages[''].dependencies.ws = '0.0.0';
    expect(() => deriveRuntimeInventory(packageData, Buffer.from(JSON.stringify(drift)))).toThrow('dependencies do not match');
    const empty = structuredClone(lock);
    for (const key of Object.keys(empty.packages)) if (key) delete empty.packages[key];
    expect(() => deriveRuntimeInventory(packageData, Buffer.from(JSON.stringify(empty)))).toThrow('inventory is empty');
    const filtered = structuredClone(lock);
    filtered.packages['node_modules/dev-only'] = { version: '1.0.0', dev: true };
    filtered.packages['node_modules/optional-only'] = { version: '1.0.0', optional: true };
    expect(deriveRuntimeInventory(packageData, Buffer.from(JSON.stringify(filtered))).packages).toHaveLength(5);
  });

  test('rejects duplicate paths, links, dev dependencies, and identity mismatches', () => {
    const duplicate = fixtureEntries();
    duplicate.push({ ...duplicate[0] });
    expect(() => validateRuntimeEntries(duplicate, releaseSha)).toThrow('duplicate path');

    const link = fixtureEntries();
    link[0] = { ...link[0], typeFlag: '2', linkName: '../../etc/passwd' };
    expect(() => validateRuntimeEntries(link, releaseSha)).toThrow('forbidden symlink');

    const falsifiedSbom = fixtureEntries();
    const sbomIndex = falsifiedSbom.findIndex((entry) => entry.rawPath === 'skyjo-runtime.cdx.json');
    falsifiedSbom[sbomIndex] = {
      ...falsifiedSbom[sbomIndex],
      data: Buffer.from(JSON.stringify({
        ...JSON.parse(sbomData.toString('utf8')),
        components: [
          ...JSON.parse(sbomData.toString('utf8')).components,
          { type: 'library', name: 'vitest', version: '4.1.10' }
        ]
      }))
    };
    falsifiedSbom[sbomIndex].size = falsifiedSbom[sbomIndex].data.length;
    expect(() => validateRuntimeEntries(falsifiedSbom, releaseSha)).toThrow('does not exactly match');

    const extraPackage = fixtureEntries();
    const evilData = Buffer.from(JSON.stringify({ name: 'evil', version: '1.0.0' }));
    extraPackage.push({
      rawPath: 'node_modules/evil/package.json',
      typeFlag: '0',
      size: evilData.length,
      linkName: '',
      data: evilData,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: Date.parse(releaseIdentity.buildTimestamp) / 1000
    });
    expect(() => validateRuntimeEntries(extraPackage, releaseSha)).toThrow('absent from package-lock inventory');

    const nestedExtra = fixtureEntries();
    const nestedData = Buffer.from('malicious');
    nestedExtra.push({
      ...nestedExtra[0],
      rawPath: 'node_modules/ws/node_modules/evil/index.js',
      data: nestedData,
      size: nestedData.length
    });
    expect(() => validateRuntimeEntries(nestedExtra, releaseSha)).toThrow('absent from package-lock inventory');

    expect(() => validateRuntimeEntries(fixtureEntries(), 'ffffffffffffffffffffffffffffffffffffffff')).toThrow('does not match');
  });

  test('rejects falsified root binding, component versions, invalid components, and installed manifests', () => {
    expect(() => validateRuntimeEntries(withSbomMutation((sbom) => { sbom.metadata.component.version = '9.9.9'; }), releaseSha)).toThrow('root component');
    expect(() => validateRuntimeEntries(withSbomMutation((sbom) => { sbom.metadata.component.properties = []; }), releaseSha)).toThrow('not bound');
    expect(() => validateRuntimeEntries(withSbomMutation((sbom) => { sbom.components[0].version = '0.0.0'; }), releaseSha)).toThrow('does not exactly match');
    expect(() => validateRuntimeEntries(withSbomMutation((sbom) => { sbom.components[0] = { name: 'react' }; }), releaseSha)).toThrow('invalid component');
    expect(() => validateRuntimeEntries(withSbomMutation((sbom) => { sbom.bomFormat = 'SPDX'; }), releaseSha)).toThrow('CycloneDX');

    const wrongManifest = fixtureEntries();
    replaceFile(wrongManifest, 'node_modules/ws/package.json', Buffer.from(JSON.stringify({ name: 'ws', version: '0.0.0' })));
    expect(() => validateRuntimeEntries(wrongManifest, releaseSha)).toThrow('does not match package-lock');
    const missingManifest = fixtureEntries().filter((entry) => entry.rawPath !== 'node_modules/ws/package.json');
    expect(() => validateRuntimeEntries(missingManifest, releaseSha)).toThrow('missing locked package manifest');
  });

  test.each([
    ['1', 'forbidden hardlink'],
    ['2', 'forbidden symlink'],
    ['3', 'forbidden special entry']
  ])('rejects tar entry type %s', (typeFlag, message) => {
    const entries = fixtureEntries();
    entries[0] = { ...entries[0], typeFlag };
    expect(() => validateRuntimeEntries(entries, releaseSha)).toThrow(message);
  });

  test('rejects link targets, disallowed files, missing files, checksum drift, and identity drift', () => {
    const linkTarget = fixtureEntries();
    linkTarget[0] = { ...linkTarget[0], linkName: 'target' };
    expect(() => validateRuntimeEntries(linkTarget, releaseSha)).toThrow('link target');
    const disallowed = fixtureEntries();
    disallowed.push({ ...disallowed[0], rawPath: 'src/secret.ts' });
    expect(() => validateRuntimeEntries(disallowed, releaseSha)).toThrow('not allowlisted');
    expect(() => validateRuntimeEntries(fixtureEntries().filter((entry) => entry.rawPath !== 'server.mjs'), releaseSha)).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-apns.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-apns-rollback-proof.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-game-state-validation.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-invite-codes.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-room-invites.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(
      fixtureEntries().filter((entry) => entry.rawPath !== 'server-push.mjs'),
      releaseSha
    )).toThrow('missing required');
    expect(() => validateRuntimeEntries(fixtureEntries().filter((entry) => entry.rawPath !== 'server-dist/serverRealtime.js'), releaseSha)).toThrow(
      'missing required'
    );
    expect(() => validateRuntimeEntries(fixtureEntries().filter((entry) => entry.rawPath !== 'server-dist/serverProtocolV2.js'), releaseSha)).toThrow(
      'missing required'
    );
    const retiredProtocol = fixtureEntries();
    retiredProtocol.push({ ...retiredProtocol[0], rawPath: 'server-dist/serverProtocolV1.js' });
    expect(() => validateRuntimeEntries(retiredProtocol, releaseSha)).toThrow('retired protocol-v1');
    const unequalIdentity = replaceFile(fixtureEntries(), 'dist/release.json', Buffer.from('{}'));
    expect(() => validateRuntimeEntries(unequalIdentity, releaseSha)).toThrow('byte-identical');
    const badChecksum = replaceFile(fixtureEntries(), 'release.json.sha256', Buffer.from(`${'0'.repeat(64)}  release.json\n`));
    replaceFile(badChecksum, 'dist/release.json.sha256', Buffer.from(`${'0'.repeat(64)}  release.json\n`));
    expect(() => validateRuntimeEntries(badChecksum, releaseSha)).toThrow('checksum mismatch');
    const malformedIdentity = Buffer.from('{bad json');
    const malformed = replaceFile(fixtureEntries(), 'release.json', malformedIdentity);
    replaceFile(malformed, 'dist/release.json', malformedIdentity);
    const malformedChecksum = Buffer.from(`${sha256(malformedIdentity)}  release.json\n`);
    replaceFile(malformed, 'release.json.sha256', malformedChecksum);
    replaceFile(malformed, 'dist/release.json.sha256', malformedChecksum);
    expect(() => validateRuntimeEntries(malformed, releaseSha)).toThrow('Invalid runtime release identity');
  });

  test.each([
    'validateMultiplayerStateUpdate',
    'legalMultiplayerStateUpdates',
    'deepEqual',
    'isLegalRecycledDrawUpdate',
    'unorderedCardsEqual',
    'proposedState'
  ])('rejects retired whole-state validation symbol %s from the runtime', (symbol) => {
    const entries = replaceFile(
      fixtureEntries(),
      'server-dist/serverValidation.js',
      Buffer.from(`export function ${symbol}() { return true; }\n`)
    );
    expect(() => validateRuntimeEntries(entries, releaseSha)).toThrow(
      `retired whole-state validation symbol: ${symbol}`
    );
  });

  test('scans every first-party compiled server module for retired whole-state validation code', () => {
    const entries = replaceFile(
      fixtureEntries(),
      'server-dist/serverProtocolV2.js',
      Buffer.from('export const proposedState = {}\n')
    );
    expect(() => validateRuntimeEntries(entries, releaseSha)).toThrow(
      'retired whole-state validation symbol: proposedState'
    );
  });

  test('rejects oversized entries and noncanonical owner, mode, or mtime metadata', () => {
    const oversized = fixtureEntries();
    oversized[0] = { ...oversized[0], size: MAX_FILE_BYTES + 1 };
    expect(() => validateRuntimeEntries(oversized, releaseSha)).toThrow('invalid size');

    for (const change of [
      { uid: 1000 },
      { gid: 1000 },
      { mode: 0o666 },
      { mtime: 1 }
    ]) {
      const entries = fixtureEntries();
      entries[0] = { ...entries[0], ...change };
      expect(() => validateRuntimeEntries(entries, releaseSha)).toThrow('noncanonical metadata');
    }
  });

  test('parses checksum-verified ustar entries and rejects a corrupt header', () => {
    const tar = createTar(fixtureEntries());
    const parsed = parseTarArchive(tar);
    expect(parsed).toHaveLength(fixtureEntries().length);
    expect(parsed[0].data.length).toBe(parsed[0].size);
    const corrupt = Buffer.from(tar);
    corrupt[0] ^= 1;
    expect(() => parseTarArchive(corrupt)).toThrow('checksum mismatch');
  });

  test('rejects malformed tar lengths, missing markers, and non-ustar headers', () => {
    expect(() => parseTarArchive(Buffer.alloc(0))).toThrow('Invalid tar archive length');
    expect(() => parseTarArchive(Buffer.alloc(513))).toThrow('Invalid tar archive length');
    const withoutEnd = createTar(fixtureEntries()).subarray(0, -1024);
    expect(() => parseTarArchive(withoutEnd)).toThrow('missing the two-block');
    const nonUstar = Buffer.from(createTar(fixtureEntries()));
    nonUstar.fill(0, 257, 263);
    nonUstar.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of nonUstar.subarray(0, 512)) checksum += byte;
    nonUstar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    nonUstar[154] = 0;
    nonUstar[155] = 0x20;
    expect(() => parseTarArchive(nonUstar)).toThrow('ustar');
  });

  test('enforces expanded, per-file, and entry-count resource ceilings before validation', () => {
    expect(() => parseTarArchive(Buffer.alloc(MAX_UNCOMPRESSED_BYTES + 512))).toThrow('Invalid tar archive length');
    const oversizedData = Buffer.alloc(MAX_FILE_BYTES + 1);
    const oversizedEntry = { ...fixtureEntries()[0], data: oversizedData, size: oversizedData.length };
    expect(() => parseTarArchive(createTar([oversizedEntry]))).toThrow('per-file limit');
    const empty = { ...fixtureEntries()[0], data: Buffer.alloc(0), size: 0 };
    const tooMany = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, index) => ({ ...empty, rawPath: `dist/${index}` }));
    expect(() => parseTarArchive(createTar(tooMany))).toThrow('too many entries');
    expect(() => validateRuntimeEntries(Array(MAX_ARCHIVE_ENTRIES + 1).fill(empty), releaseSha)).toThrow('invalid entry count');
  });

  test.skipIf(typeof fsConstants.O_NOFOLLOW !== 'number')(
    'captures a bounded regular file through exactly one O_NOFOLLOW descriptor',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-bounded-file-test-'));
      const filePath = path.join(directory, 'published.cdx.json');
      try {
        await fs.writeFile(filePath, 'published sbom');
        const openSpy = vi.spyOn(fs, 'open');
        const captured = await readBoundedRegularFile(filePath, {
          label: 'Published runtime SBOM',
          maxBytes: 64
        });
        expect(captured.equals(Buffer.from('published sbom'))).toBe(true);
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(Number(openSpy.mock.calls[0][1]) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(typeof fsConstants.O_NOFOLLOW !== 'number')(
    'rejects linked, non-file, empty, and oversized bounded-file inputs',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-bounded-file-input-test-'));
      const targetPath = path.join(directory, 'target.json');
      const linkedPath = path.join(directory, 'linked.json');
      const emptyPath = path.join(directory, 'empty.json');
      const oversizedPath = path.join(directory, 'oversized.json');
      try {
        await fs.writeFile(targetPath, '{}');
        await fs.symlink(path.basename(targetPath), linkedPath, 'file');
        await fs.writeFile(emptyPath, '');
        await fs.writeFile(oversizedPath, 'oversized');
        await expect(readBoundedRegularFile(linkedPath, { label: 'Published runtime SBOM' }))
          .rejects.toThrow('cannot be a symbolic link');
        await expect(readBoundedRegularFile(directory, { label: 'Published runtime SBOM' }))
          .rejects.toThrow('must be a regular file');
        await expect(readBoundedRegularFile(emptyPath, { label: 'Published runtime SBOM' }))
          .rejects.toThrow('size is outside the allowed range');
        await expect(readBoundedRegularFile(oversizedPath, { label: 'Published runtime SBOM', maxBytes: 4 }))
          .rejects.toThrow('size is outside the allowed range');
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(typeof fsConstants.O_NOFOLLOW !== 'number')(
    'fails closed when the bounded pathname is replaced during its descriptor read',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-bounded-file-swap-test-'));
      const filePath = path.join(directory, 'published.cdx.json');
      const replacementPath = path.join(directory, 'replacement.cdx.json');
      try {
        await fs.writeFile(filePath, 'trusted sbom');
        await fs.writeFile(replacementPath, 'untrusted replacement');
        const originalOpen = fs.open.bind(fs);
        let replaced = false;
        vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (path.resolve(String(args[0])) === filePath) {
            const originalReadFile = handle.readFile.bind(handle);
            vi.spyOn(handle, 'readFile').mockImplementationOnce(async () => {
              const data = await originalReadFile();
              await fs.rename(filePath, `${filePath}.opened`);
              await fs.copyFile(replacementPath, filePath);
              replaced = true;
              return data;
            });
          }
          return handle;
        });
        await expect(readBoundedRegularFile(filePath, {
          label: 'Published runtime SBOM',
          maxBytes: 64
        })).rejects.toThrow('changed during validation');
        expect(replaced).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );

  test('rejects a compressed artifact above its measured-runtime ceiling before reading it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-limit-test-'));
    try {
      const names = artifactNames(releaseSha);
      const archivePath = path.join(directory, names.archiveName);
      const checksumPath = path.join(directory, names.checksumName);
      await fs.writeFile(archivePath, Buffer.alloc(1));
      await fs.truncate(archivePath, MAX_ARCHIVE_BYTES + 1);
      await fs.writeFile(checksumPath, `${'0'.repeat(64)}  ${names.archiveName}\n`);
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha })).rejects.toThrow('size is outside');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('verifies gzip, sidecar hash, archive filename, allowlist, and embedded release SHA together', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-test-'));
    try {
      const names = artifactNames(releaseSha);
      const archivePath = path.join(directory, names.archiveName);
      const checksumPath = path.join(directory, names.checksumName);
      const archive = gzipSync(createTar(fixtureEntries()), { level: 9 });
      await fs.writeFile(archivePath, archive);
      await fs.writeFile(checksumPath, `${sha256(archive)}  ${names.archiveName}\n`);
      const result = await verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha });
      expect(result.releaseSha).toBe(releaseSha);
      expect(result.entries).toBe(fixtureEntries().length);

      await fs.writeFile(checksumPath, `${'0'.repeat(64)}  ${names.archiveName}\n`);
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha })).rejects.toThrow('checksum mismatch');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32').each([
    'archive',
    'checksum'
  ] as const)('rejects a symbolic-link %s without following it', async (linkTarget) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-symlink-test-'));
    try {
      const { names, archivePath, checksumPath } = await writeValidArtifactFixture(directory);
      const selectedPath = linkTarget === 'archive' ? archivePath : checksumPath;
      const actualPath = `${selectedPath}.actual`;
      await fs.rename(selectedPath, actualPath);
      await fs.symlink(path.basename(actualPath), selectedPath, 'file');
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha }))
        .rejects.toThrow(linkTarget === 'archive' ? 'cannot be a symbolic link' : 'checksum must be a regular file');
      expect(path.basename(archivePath)).toBe(names.archiveName);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    'archive',
    'checksum'
  ] as const)('rejects an adversarial %s pathname replacement after opening', async (replacementTarget) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-replacement-test-'));
    try {
      const { archivePath, checksumPath } = await writeValidArtifactFixture(directory);
      const selectedPath = replacementTarget === 'archive' ? archivePath : checksumPath;
      const replacementPath = path.join(directory, `${replacementTarget}.replacement`);
      await fs.writeFile(replacementPath, 'untrusted replacement');
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (!replaced && path.resolve(String(args[0])) === selectedPath) {
          replaced = true;
          await fs.rename(selectedPath, `${selectedPath}.opened`);
          await fs.copyFile(replacementPath, selectedPath);
        }
        return handle;
      });
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha }))
        .rejects.toThrow(/replaced while it was being opened|changed during validation/);
      expect(replaced).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ['archive', 'before pathname stat'],
    ['archive', 'after pathname stat'],
    ['checksum', 'before pathname stat'],
    ['checksum', 'after pathname stat']
  ] as const)('rejects an in-place %s mutation %s during the final pathname reopen', async (mutationTarget, mutationWindow) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-final-reopen-test-'));
    try {
      const { archivePath, checksumPath } = await writeValidArtifactFixture(directory);
      const selectedPath = mutationTarget === 'archive' ? archivePath : checksumPath;
      const originalOpen = fs.open.bind(fs);
      const originalLstat = fs.lstat.bind(fs);
      let targetOpenCount = 0;
      let finalReopen = false;
      let mutated = false;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (path.resolve(String(args[0])) === selectedPath) {
          targetOpenCount += 1;
          finalReopen = targetOpenCount === 2;
        }
        return handle;
      });
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        if (finalReopen && !mutated && path.resolve(String(args[0])) === selectedPath) {
          if (mutationWindow === 'before pathname stat') await fs.appendFile(selectedPath, 'final-reopen-mutation');
          const pathnameStat = await originalLstat(...args);
          if (mutationWindow === 'after pathname stat') await fs.appendFile(selectedPath, 'final-reopen-mutation');
          mutated = true;
          return pathnameStat;
        }
        return originalLstat(...args);
      });
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha }))
        .rejects.toThrow(`${mutationTarget === 'archive' ? 'Runtime artifact' : 'Runtime artifact checksum'} changed during validation`);
      expect(targetOpenCount).toBe(2);
      expect(mutated).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects descriptor content mutation between its pre-read and post-read fstat checks', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-artifact-mutation-test-'));
    try {
      const { archivePath, checksumPath } = await writeValidArtifactFixture(directory);
      const originalOpen = fs.open.bind(fs);
      let mutated = false;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (path.resolve(String(args[0])) === checksumPath) {
          const originalReadFile = handle.readFile.bind(handle);
          vi.spyOn(handle, 'readFile').mockImplementationOnce(async () => {
            const data = await originalReadFile();
            await fs.appendFile(checksumPath, 'mutation');
            mutated = true;
            return data;
          });
        }
        return handle;
      });
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha }))
        .rejects.toThrow('Runtime artifact checksum changed during validation');
      expect(mutated).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
