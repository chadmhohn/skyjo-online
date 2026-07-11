import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  loadReleaseIdentity,
  PREVIOUS_SCHEMA_VERSION,
  RELEASE_CHECKSUM_FILE_NAME,
  RELEASE_FILE_NAME,
  RELEASE_FORMAT_VERSION,
  releaseValidationOptionsForEnvironment,
  sha256,
  validateReleaseIdentity,
  writeReleaseIdentity
} from '../../../server-release.mjs';

const fullSha = '0123456789abcdef0123456789abcdef01234567';
const buildTimestamp = '2026-07-11T12:00:00.000Z';

function identity(overrides = {}) {
  return {
    formatVersion: RELEASE_FORMAT_VERSION,
    releaseSha: fullSha,
    buildTimestamp,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    ...overrides
  };
}

async function writeFixture(directory: string, value: ReturnType<typeof identity>) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(path.join(directory, RELEASE_FILE_NAME), data, 'utf8');
  await fs.writeFile(path.join(directory, RELEASE_CHECKSUM_FILE_NAME), `${sha256(data)}  ${RELEASE_FILE_NAME}\n`, 'utf8');
}

describe('release identity', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-release-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes and validates a checksummed current release identity', async () => {
    await writeReleaseIdentity(tempDir, identity());
    await expect(loadReleaseIdentity(tempDir, { requireFullSha: true, allowDevelopment: false })).resolves.toEqual(identity());

    const checksum = await fs.readFile(path.join(tempDir, RELEASE_CHECKSUM_FILE_NAME), 'utf8');
    expect(checksum).toMatch(/^[a-f0-9]{64} {2}release\.json\n$/);
  });

  it('supports the previous schema only when a compatibility reader opts in', async () => {
    await writeFixture(tempDir, identity({ schemaVersion: PREVIOUS_SCHEMA_VERSION }));
    await expect(loadReleaseIdentity(tempDir)).rejects.toThrow(/schema version/i);
    await expect(
      loadReleaseIdentity(tempDir, { allowedSchemaVersions: [PREVIOUS_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION] })
    ).resolves.toMatchObject({ schemaVersion: PREVIOUS_SCHEMA_VERSION });
  });

  it('rejects a protocol mismatch, noncanonical timestamp, and non-production SHA', () => {
    expect(() => validateReleaseIdentity(identity({ protocolVersion: CURRENT_PROTOCOL_VERSION + 1 }))).toThrow(/protocol version/i);
    expect(() => validateReleaseIdentity(identity({ buildTimestamp: '2026-07-11T12:00:00Z' }))).toThrow(/canonical ISO/i);
    expect(() => validateReleaseIdentity(identity({ releaseSha: 'development' }), { allowDevelopment: false })).toThrow(/development/i);
    expect(() => validateReleaseIdentity(identity({ releaseSha: 'abcdef0' }), { requireFullSha: true })).toThrow(/full release SHA/i);
  });

  it('treats an unset or unknown NODE_ENV as production-like', () => {
    expect(releaseValidationOptionsForEnvironment(undefined)).toEqual({ allowDevelopment: false, requireFullSha: true });
    expect(releaseValidationOptionsForEnvironment('production')).toEqual({ allowDevelopment: false, requireFullSha: true });
    expect(releaseValidationOptionsForEnvironment('staging')).toEqual({ allowDevelopment: false, requireFullSha: true });
    expect(releaseValidationOptionsForEnvironment('development')).toEqual({ allowDevelopment: true, requireFullSha: false });
    expect(releaseValidationOptionsForEnvironment('test')).toEqual({ allowDevelopment: true, requireFullSha: false });
  });

  it('rejects modified JSON, malformed checksums, and invalid JSON without leaking data', async () => {
    await writeReleaseIdentity(tempDir, identity());
    await fs.appendFile(path.join(tempDir, RELEASE_FILE_NAME), ' ');
    await expect(loadReleaseIdentity(tempDir)).rejects.toThrow(/checksum mismatch/i);

    await writeReleaseIdentity(tempDir, identity());
    await fs.writeFile(path.join(tempDir, RELEASE_CHECKSUM_FILE_NAME), 'not-a-checksum\n', 'utf8');
    await expect(loadReleaseIdentity(tempDir)).rejects.toThrow(/checksum file/i);

    const invalid = '{not-json}\n';
    await fs.writeFile(path.join(tempDir, RELEASE_FILE_NAME), invalid, 'utf8');
    await fs.writeFile(path.join(tempDir, RELEASE_CHECKSUM_FILE_NAME), `${sha256(invalid)}  ${RELEASE_FILE_NAME}\n`, 'utf8');
    await expect(loadReleaseIdentity(tempDir)).rejects.toThrow();
  });
});
