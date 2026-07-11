import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  artifactNames,
  assertFullReleaseSha,
  isAllowedRuntimePath,
  normalizeArchivePath,
  parseTarArchive,
  REQUIRED_ARCHIVE_FILES,
  validateRuntimeEntries,
  verifyRuntimeArtifact
} from '../../../scripts/runtime-artifact-lib.mjs';
import { sha256 } from '../../../server-release.mjs';

const releaseSha = '0123456789abcdef0123456789abcdef01234567';
const releaseIdentity = {
  formatVersion: 1,
  releaseSha,
  buildTimestamp: '2026-07-11T12:00:00.000Z',
  schemaVersion: 2,
  protocolVersion: 1
};
const releaseData = Buffer.from(`${JSON.stringify(releaseIdentity, null, 2)}\n`);
const releaseChecksum = Buffer.from(`${sha256(releaseData)}  release.json\n`);
const packageData = Buffer.from(JSON.stringify({
  name: 'skyjo-online',
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
const sbomData = Buffer.from(JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  metadata: { component: { type: 'application', name: 'skyjo-online', version: '0.1.0' } },
  components: ['react', 'react-dom', 'react-router-dom', 'web-push', 'ws'].map((name) => ({ type: 'library', name, version: '1.0.0' }))
}));

type TarEntry = {
  rawPath: string;
  typeFlag: string;
  size: number;
  linkName: string;
  data: Buffer;
};

function fixtureEntries(): TarEntry[] {
  return REQUIRED_ARCHIVE_FILES.map((rawPath: string) => {
    let data = Buffer.from(`fixture:${rawPath}`);
    if (rawPath === 'release.json' || rawPath === 'dist/release.json') data = releaseData;
    if (rawPath === 'release.json.sha256' || rawPath === 'dist/release.json.sha256') data = releaseChecksum;
    if (rawPath === 'package.json') data = packageData;
    if (rawPath === 'skyjo-runtime.cdx.json') data = sbomData;
    return { rawPath, typeFlag: '0', size: data.length, linkName: '', data };
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
  writeOctal(header, 100, 8, entry.typeFlag === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
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
    'dist/./index.html'
  ])('rejects unsafe archive path %s', (unsafePath) => {
    expect(() => normalizeArchivePath(unsafePath)).toThrow();
  });

  test('allows only compiled output, production dependencies, metadata, and exact runtime scripts', () => {
    expect(isAllowedRuntimePath('./dist/assets/app.js')).toBe(true);
    expect(isAllowedRuntimePath('node_modules/ws/index.js')).toBe(true);
    expect(isAllowedRuntimePath('scripts/smoke-deployed.mjs')).toBe(true);
    expect(isAllowedRuntimePath('scripts/smoke-chat.mjs')).toBe(false);
    expect(isAllowedRuntimePath('src/game.ts')).toBe(false);
    expect(isAllowedRuntimePath('tests/unit/data/foo.test.ts')).toBe(false);
    expect(isAllowedRuntimePath('.env')).toBe(false);
  });

  test('validates the complete allowlisted runtime and byte-identical release identities', () => {
    const result = validateRuntimeEntries(fixtureEntries(), releaseSha);
    expect(result.releaseIdentity.releaseSha).toBe(releaseSha);
    expect(result.files.has('src/game.ts')).toBe(false);
  });

  test('rejects duplicate paths, links, dev dependencies, and identity mismatches', () => {
    const duplicate = fixtureEntries();
    duplicate.push({ ...duplicate[0] });
    expect(() => validateRuntimeEntries(duplicate, releaseSha)).toThrow('duplicate path');

    const link = fixtureEntries();
    link[0] = { ...link[0], typeFlag: '2', linkName: '../../etc/passwd' };
    expect(() => validateRuntimeEntries(link, releaseSha)).toThrow('forbidden symlink');

    const devDependency = fixtureEntries();
    const sbomIndex = devDependency.findIndex((entry) => entry.rawPath === 'skyjo-runtime.cdx.json');
    devDependency[sbomIndex] = {
      ...devDependency[sbomIndex],
      data: Buffer.from(JSON.stringify({
        ...JSON.parse(sbomData.toString('utf8')),
        components: [
          ...JSON.parse(sbomData.toString('utf8')).components,
          { type: 'library', name: 'vitest', version: '4.1.10' }
        ]
      }))
    };
    devDependency[sbomIndex].size = devDependency[sbomIndex].data.length;
    expect(() => validateRuntimeEntries(devDependency, releaseSha)).toThrow('contains dev dependency vitest');

    expect(() => validateRuntimeEntries(fixtureEntries(), 'ffffffffffffffffffffffffffffffffffffffff')).toThrow('does not match');
  });

  test('parses checksum-verified ustar entries and rejects a corrupt header', () => {
    const tar = createTar(fixtureEntries());
    const parsed = parseTarArchive(tar);
    expect(parsed).toHaveLength(REQUIRED_ARCHIVE_FILES.length);
    expect(parsed[0].data.length).toBe(parsed[0].size);
    const corrupt = Buffer.from(tar);
    corrupt[0] ^= 1;
    expect(() => parseTarArchive(corrupt)).toThrow('checksum mismatch');
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
      expect(result.entries).toBe(REQUIRED_ARCHIVE_FILES.length);

      await fs.writeFile(checksumPath, `${'0'.repeat(64)}  ${names.archiveName}\n`);
      await expect(verifyRuntimeArtifact({ archivePath, checksumPath, expectedReleaseSha: releaseSha })).rejects.toThrow('checksum mismatch');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
