import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUTHORIZATION_DOMAIN = 'skyjo-online-deployment-authorization/v2';
export const AUTHORIZATION_REPOSITORY = 'chadmhohn/skyjo-online';
export const MAX_AUTHORIZATION_LIFETIME_SECONDS = 600;
export const MAX_AUTHORIZATION_COMMAND_BYTES = 512;
export const MAX_AUTHORIZED_ARTIFACT_BYTES = 16 * 1024 * 1024;

const runIdPattern = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(canary|production)$/;
const releaseShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const releaseTagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const keyIdPattern = /^(?:canary|production)-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const integerPattern = /^(?:0|[1-9][0-9]{0,15})$/;
const positiveIntegerPattern = /^[1-9][0-9]{0,15}$/;

export class DeploymentAuthorizationError extends Error {
  constructor(code, message = 'Deployment authorization rejected.') {
    super(message);
    this.name = 'DeploymentAuthorizationError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new DeploymentAuthorizationError(code, message);
}

function requireAscii(value, label) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) reject('INVALID_FIELD', `${label} is invalid.`);
  return value;
}

function parseEpoch(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) reject('INVALID_TIME', `${label} is invalid.`);
    return value;
  }
  if (typeof value !== 'string' || !integerPattern.test(value)) reject('INVALID_TIME', `${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) reject('INVALID_TIME', `${label} is invalid.`);
  return parsed;
}

function laneFor(command, runId) {
  if (command === 'upload') {
    const runMatch = typeof runId === 'string' ? runId.match(runIdPattern) : null;
    if (!runMatch) reject('INVALID_RUN_ID', 'Deployment authorization run ID is invalid.');
    return { role: runMatch[1], suffix: runMatch[1], tagRequired: runMatch[1] === 'production' };
  }
  if (command === 'verify') return { role: 'canary', suffix: 'canary', tagRequired: false };
  if (command === 'promote' || command === 'rollback') return { role: 'production', suffix: 'production', tagRequired: true };
  reject('INVALID_COMMAND', 'Deployment authorization command is invalid.');
}

export function normalizeAuthorizationFields(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INVALID_AUTHORIZATION');
  const command = requireAscii(value.command, 'Command');
  const runId = requireAscii(value.runId, 'Run ID');
  const lane = laneFor(command, runId);
  const role = requireAscii(value.role, 'Role');
  if (role !== lane.role) reject('ROLE_MISMATCH', 'Deployment authorization role is invalid.');
  const runMatch = runId.match(runIdPattern);
  if (!runMatch || runMatch[1] !== lane.suffix) reject('INVALID_RUN_ID', 'Deployment authorization run ID is invalid.');
  const releaseSha = requireAscii(value.releaseSha, 'Release SHA');
  if (!releaseShaPattern.test(releaseSha)) reject('INVALID_RELEASE_SHA', 'Deployment authorization release SHA is invalid.');
  const artifactSha256 = requireAscii(value.artifactSha256, 'Artifact digest');
  if (!digestPattern.test(artifactSha256)) reject('INVALID_DIGEST', 'Deployment authorization artifact digest is invalid.');
  const artifactBytesValue = typeof value.artifactBytes === 'number' ? String(value.artifactBytes) : value.artifactBytes;
  if (typeof artifactBytesValue !== 'string' || !positiveIntegerPattern.test(artifactBytesValue)) {
    reject('INVALID_ARTIFACT_SIZE', 'Deployment authorization artifact size is invalid.');
  }
  const artifactBytes = Number(artifactBytesValue);
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes > MAX_AUTHORIZED_ARTIFACT_BYTES) {
    reject('INVALID_ARTIFACT_SIZE', 'Deployment authorization artifact size is invalid.');
  }
  const tag = requireAscii(value.tag, 'Tag');
  if ((lane.tagRequired && !releaseTagPattern.test(tag)) || (!lane.tagRequired && tag !== '-')) {
    reject('INVALID_TAG', 'Deployment authorization tag is invalid.');
  }
  const keyId = requireAscii(value.keyId, 'Key ID');
  if (keyId.length > 64 || !keyIdPattern.test(keyId) || !keyId.startsWith(`${role}-`)) reject('INVALID_KEY_ID', 'Deployment authorization key ID is invalid.');
  const issuedAt = parseEpoch(value.issuedAt, 'Issued-at time');
  const expiresAt = parseEpoch(value.expiresAt, 'Expiry time');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_SECONDS) {
    reject('INVALID_LIFETIME', 'Deployment authorization lifetime is invalid.');
  }
  if (options.checkFreshness !== false) {
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) reject('INVALID_CLOCK');
    if (issuedAt > nowSeconds + 60) reject('NOT_YET_VALID', 'Deployment authorization is not yet valid.');
    if (expiresAt <= nowSeconds) reject('EXPIRED', 'Deployment authorization has expired.');
  }
  return { role, command, runId, releaseSha, artifactSha256, artifactBytes, tag, issuedAt, expiresAt, keyId };
}

export function canonicalAuthorizationPayload(value, options = {}) {
  const fields = normalizeAuthorizationFields(value, options);
  return [
    `domain=${AUTHORIZATION_DOMAIN}`,
    `repository=${AUTHORIZATION_REPOSITORY}`,
    `role=${fields.role}`,
    `command=${fields.command}`,
    `run_id=${fields.runId}`,
    `release_sha=${fields.releaseSha}`,
    `artifact_sha256=${fields.artifactSha256}`,
    `artifact_bytes=${fields.artifactBytes}`,
    `tag=${fields.tag}`,
    `issued_at=${fields.issuedAt}`,
    `expires_at=${fields.expiresAt}`,
    `key_id=${fields.keyId}`,
    ''
  ].join('\n');
}

export function parseAuthorizationSignature(value) {
  if (typeof value !== 'string' || !signaturePattern.test(value)) reject('INVALID_SIGNATURE', 'Deployment authorization signature is invalid.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== 64 || decoded.toString('base64url') !== value) reject('INVALID_SIGNATURE', 'Deployment authorization signature is invalid.');
  return decoded;
}

export function formatSignedDeploymentCommand(value, signature, options = {}) {
  const fields = normalizeAuthorizationFields(value, options);
  parseAuthorizationSignature(signature);
  return [
    fields.command,
    fields.runId,
    fields.releaseSha,
    fields.artifactSha256,
    fields.artifactBytes,
    fields.tag,
    fields.issuedAt,
    fields.expiresAt,
    fields.keyId,
    signature
  ].join(' ');
}

export function parseSignedDeploymentCommand(value, options = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_COMMAND_BYTES ||
      !/^[\x20-\x7e]+$/.test(value) || value !== value.trim() || value.includes('  ')) {
    reject('INVALID_COMMAND_LINE', 'Deployment authorization command line is invalid.');
  }
  const tokens = value.split(' ');
  if (tokens.length !== 10) reject('INVALID_COMMAND_LINE', 'Deployment authorization command line is invalid.');
  const [command, runId, releaseSha, artifactSha256, artifactBytes, tag, issuedAt, expiresAt, keyId, signature] = tokens;
  const role = laneFor(command, runId).role;
  const fields = normalizeAuthorizationFields({
    role, command, runId, releaseSha, artifactSha256, artifactBytes, tag, issuedAt, expiresAt, keyId
  }, options);
  parseAuthorizationSignature(signature);
  return { fields, signature };
}

async function readKeyFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) reject('INVALID_KEY');
  const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(filePath, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8192) reject('INVALID_KEY');
    const expectedUid = options.expectedUid ?? (process.platform === 'linux' ? 0 : undefined);
    if (expectedUid !== undefined && stat.uid !== expectedUid) reject('INVALID_KEY');
    if (process.platform !== 'win32' && options.enforceMode !== false && (stat.mode & 0o022) !== 0) reject('INVALID_KEY');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof DeploymentAuthorizationError) throw error;
    reject('INVALID_KEY');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadAuthorizationPublicKey(filePath, options = {}) {
  const pem = await readKeyFile(filePath, options);
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch {
    reject('INVALID_KEY');
  }
  if (key.asymmetricKeyType !== 'ed25519') reject('INVALID_KEY');
  return key;
}

export function authorizationPublicKeyFingerprint(publicKey) {
  if (publicKey?.asymmetricKeyType !== 'ed25519') reject('INVALID_KEY');
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

export async function loadAuthorizationPrivateKey(filePath, options = {}) {
  const pem = await readKeyFile(filePath, { ...options, expectedUid: options.expectedUid ?? process.getuid?.() });
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    reject('INVALID_KEY');
  }
  if (key.asymmetricKeyType !== 'ed25519') reject('INVALID_KEY');
  return key;
}

export function signDeploymentAuthorization(value, privateKey, options = {}) {
  const payload = canonicalAuthorizationPayload(value, options);
  return crypto.sign(null, Buffer.from(payload, 'ascii'), privateKey).toString('base64url');
}

export async function verifyDeploymentAuthorization({ fields: rawFields, signature, keyring, nowSeconds, expectedUid = 0 }) {
  const fields = normalizeAuthorizationFields(rawFields, { nowSeconds });
  const entry = keyring instanceof Map ? keyring.get(fields.keyId) : keyring?.[fields.keyId];
  if (!entry || entry.role !== fields.role) reject('UNKNOWN_KEY', 'Deployment authorization key is not trusted.');
  const publicKey = entry.publicKey || await loadAuthorizationPublicKey(entry.publicKeyPath, { expectedUid });
  if (publicKey?.asymmetricKeyType !== 'ed25519') reject('INVALID_KEY');
  const payload = canonicalAuthorizationPayload(fields, { nowSeconds });
  const valid = crypto.verify(null, Buffer.from(payload, 'ascii'), publicKey, parseAuthorizationSignature(signature));
  if (!valid) reject('BAD_SIGNATURE', 'Deployment authorization signature did not verify.');
  return { fields, payloadSha256: crypto.createHash('sha256').update(payload, 'ascii').digest('hex') };
}

function replayKey(fields) {
  return crypto.createHash('sha256').update(fields.role).update('\0').update(fields.command).update('\0').update(fields.runId).digest('hex');
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertSafeLedgerRoot(ledgerRoot, expectedUid) {
  const resolved = path.resolve(ledgerRoot);
  if (resolved === path.parse(resolved).root) reject('INVALID_LEDGER');
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const component = await fs.lstat(current).catch(() => null);
    if (!component || component.isSymbolicLink()) reject('INVALID_LEDGER');
  }
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      (expectedUid !== undefined && stat.uid !== expectedUid)) {
    reject('INVALID_LEDGER');
  }
  return resolved;
}

async function replaceLedgerRecord(recordPath, expected, next) {
  const current = await fs.readFile(recordPath, 'utf8');
  if (current !== expected) reject('LEDGER_CONFLICT', 'Deployment authorization ledger changed unexpectedly.');
  const temporary = `${recordPath}.next-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, recordPath);
    await syncDirectory(path.dirname(recordPath));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readCompletedReplay(recordPath, payloadSha256, expectedUid) {
  let handle;
  try {
    handle = await fs.open(recordPath, fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || (expectedUid !== undefined && stat.uid !== expectedUid) ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return false;
    const record = JSON.parse(await handle.readFile('utf8'));
    return record?.formatVersion === 1 && record.status === 'completed' && record.payloadSha256 === payloadSha256;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function beginAuthorizationUse({ ledgerRoot, fields: rawFields, payloadSha256, nowSeconds, expectedUid, allowExactCompletedReplay = false }) {
  const fields = normalizeAuthorizationFields(rawFields, { nowSeconds });
  if (!digestPattern.test(payloadSha256 || '')) reject('INVALID_LEDGER');
  const root = await assertSafeLedgerRoot(ledgerRoot, expectedUid ?? process.getuid?.());
  const key = replayKey(fields);
  const recordPath = path.join(root, `${key}.json`);
  const started = `${JSON.stringify({
    formatVersion: 1,
    status: 'started',
    role: fields.role,
    command: fields.command,
    runId: fields.runId,
    releaseSha: fields.releaseSha,
    artifactSha256: fields.artifactSha256,
    artifactBytes: fields.artifactBytes,
    tag: fields.tag,
    keyId: fields.keyId,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    payloadSha256,
    startedAt: nowSeconds ?? Math.floor(Date.now() / 1000)
  })}\n`;
  let handle;
  try {
    handle = await fs.open(recordPath, fsConstants.constants.O_CREAT | fsConstants.constants.O_EXCL | fsConstants.constants.O_WRONLY | (fsConstants.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(started, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      if (allowExactCompletedReplay && await readCompletedReplay(recordPath, payloadSha256, expectedUid ?? process.getuid?.())) {
        return {
          key,
          recordPath,
          replayed: true,
          complete: async () => {},
          fail: async () => {}
        };
      }
      reject('REPLAY', 'Deployment authorization was already consumed.');
    }
    if (error instanceof DeploymentAuthorizationError) throw error;
    reject('INVALID_LEDGER');
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(root);
  let state = 'started';
  async function finish(status) {
    if (state !== 'started') reject('LEDGER_CONFLICT', 'Deployment authorization ledger is already finalized.');
    const completedAt = Math.floor(Date.now() / 1000);
    const next = `${JSON.stringify({ ...JSON.parse(started), status, completedAt })}\n`;
    await replaceLedgerRecord(recordPath, started, next);
    state = status;
  }
  return {
    key,
    recordPath,
    replayed: false,
    complete: () => finish('completed'),
    fail: () => finish('failed')
  };
}
