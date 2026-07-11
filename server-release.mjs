import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_FORMAT_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 2;
export const PREVIOUS_SCHEMA_VERSION = 1;
export const CURRENT_PROTOCOL_VERSION = 1;
export const RELEASE_FILE_NAME = 'release.json';
export const RELEASE_CHECKSUM_FILE_NAME = 'release.json.sha256';

const sha256Pattern = /^[a-f0-9]{64}$/;
const releaseShaPattern = /^(?:development|[a-f0-9]{7,64})$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInteger(value, label, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`Invalid ${label}.`);
  return value;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function validateReleaseIdentity(value, options = {}) {
  if (!isRecord(value)) throw new Error('Invalid release identity.');
  const allowedSchemaVersions = options.allowedSchemaVersions || [CURRENT_SCHEMA_VERSION];
  const allowedProtocolVersions = options.allowedProtocolVersions || [CURRENT_PROTOCOL_VERSION];
  const formatVersion = assertInteger(value.formatVersion, 'release format version');
  if (formatVersion !== RELEASE_FORMAT_VERSION) throw new Error('Unsupported release format version.');

  const releaseSha = typeof value.releaseSha === 'string' ? value.releaseSha.trim().toLowerCase() : '';
  if (!releaseShaPattern.test(releaseSha)) throw new Error('Invalid release SHA.');
  if (releaseSha === 'development' && options.allowDevelopment === false) throw new Error('Development release identity is not allowed.');
  if (options.requireFullSha === true && !/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error('A full release SHA is required.');

  const parsedTimestamp = typeof value.buildTimestamp === 'string' ? Date.parse(value.buildTimestamp) : Number.NaN;
  if (!Number.isFinite(parsedTimestamp)) throw new Error('Invalid build timestamp.');
  const buildTimestamp = new Date(parsedTimestamp).toISOString();
  if (buildTimestamp !== value.buildTimestamp) throw new Error('Build timestamp must use canonical ISO format.');

  const schemaVersion = assertInteger(value.schemaVersion, 'schema version');
  if (!allowedSchemaVersions.includes(schemaVersion)) throw new Error('Unsupported schema version.');
  const protocolVersion = assertInteger(value.protocolVersion, 'protocol version');
  if (!allowedProtocolVersions.includes(protocolVersion)) throw new Error('Unsupported protocol version.');

  return {
    formatVersion,
    releaseSha,
    buildTimestamp,
    schemaVersion,
    protocolVersion
  };
}

export function parseReleaseChecksum(value) {
  const match = typeof value === 'string' ? value.match(/^([a-f0-9]{64})  release\.json\r?\n$/) : null;
  if (!match || !sha256Pattern.test(match[1])) throw new Error('Invalid release checksum file.');
  return match[1];
}

export async function writeReleaseIdentity(distDirectory, value) {
  const identity = validateReleaseIdentity(value);
  const data = `${JSON.stringify(identity, null, 2)}\n`;
  const checksum = sha256(data);
  await fs.mkdir(distDirectory, { recursive: true });
  await fs.writeFile(path.join(distDirectory, RELEASE_FILE_NAME), data, { encoding: 'utf8', mode: 0o644 });
  await fs.writeFile(
    path.join(distDirectory, RELEASE_CHECKSUM_FILE_NAME),
    `${checksum}  ${RELEASE_FILE_NAME}\n`,
    { encoding: 'utf8', mode: 0o644 }
  );
  return identity;
}

export async function loadReleaseIdentity(distDirectory, options = {}) {
  const releasePath = path.join(distDirectory, RELEASE_FILE_NAME);
  const checksumPath = path.join(distDirectory, RELEASE_CHECKSUM_FILE_NAME);
  const [data, checksumData] = await Promise.all([
    fs.readFile(releasePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedChecksum = parseReleaseChecksum(checksumData);
  const actualChecksum = sha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(expectedChecksum), Buffer.from(actualChecksum))) {
    throw new Error('Release identity checksum mismatch.');
  }
  return validateReleaseIdentity(JSON.parse(data), options);
}
