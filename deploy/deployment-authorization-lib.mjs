import crypto from 'node:crypto';
import fsConstants from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUTHORIZATION_DOMAIN = 'skyjo-online-deployment-authorization/v1';
export const AUTHORIZATION_REPOSITORY = 'chadmhohn/skyjo-online';
export const MAX_AUTHORIZATION_LIFETIME_SECONDS = 600;
export const MAX_AUTHORIZATION_COMMAND_BYTES = 512;

const runIdPattern = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(canary|production)$/;
const releaseShaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const releaseTagPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const keyIdPattern = /^(?:canary|production)-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;
const integerPattern = /^(?:0|[1-9][0-9]{0,15})$/;

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

function laneFor(command) {
  if (command === 'verify') return { role: 'canary', suffix: 'canary', tagRequired: false };
  if (command === 'promote' || command === 'rollback') return { role: 'production', suffix: 'production', tagRequired: true };
  reject('INVALID_COMMAND', 'Deployment authorization command is invalid.');
}

export function normalizeAuthorizationFields(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INVALID_AUTHORIZATION');
  const command = requireAscii(value.command, 'Command');
  const lane = laneFor(command);
  const role = requireAscii(value.role, 'Role');
  if (role !== lane.role) reject('ROLE_MISMATCH', 'Deployment authorization role is invalid.');
  const runId = requireAscii(value.runId, 'Run ID');
  const runMatch = runId.match(runIdPattern);
  if (!runMatch || runMatch[1] !== lane.suffix) reject('INVALID_RUN_ID', 'Deployment authorization run ID is invalid.');
  const releaseSha = requireAscii(value.releaseSha, 'Release SHA');
  if (!releaseShaPattern.test(releaseSha)) reject('INVALID_RELEASE_SHA', 'Deployment authorization release SHA is invalid.');
  const artifactSha256 = requireAscii(value.artifactSha256, 'Artifact digest');
  if (!digestPattern.test(artifactSha256)) reject('INVALID_DIGEST', 'Deployment authorization artifact digest is invalid.');
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
  return { role, command, runId, releaseSha, artifactSha256, tag, issuedAt, expiresAt, keyId };
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

export function parseSignedDeploymentCommand(value, options = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_COMMAND_BYTES ||
      !/^[\x20-\x7e]+$/.test(value) || value !== value.trim() || value.includes('  ')) {
    reject('INVALID_COMMAND_LINE', 'Deployment authorization command line is invalid.');
  }
  const tokens = value.split(' ');
  if (tokens.length !== 9) reject('INVALID_COMMAND_LINE', 'Deployment authorization command line is invalid.');
  const [command, runId, releaseSha, artifactSha256, tag, issuedAt, expiresAt, keyId, signature] = tokens;
  const role = laneFor(command).role;
  const fields = normalizeAuthorizationFields({
    role, command, runId, releaseSha, artifactSha256, tag, issuedAt, expiresAt, keyId
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

export async function verifyDeploymentAuthorization({
  fields: rawFields,
  signature,
  keyring,
  nowSeconds,
  expectedUid = 0,
  checkFreshness = true
}) {
  const fields = normalizeAuthorizationFields(rawFields, { nowSeconds, checkFreshness });
  const entry = keyring instanceof Map ? keyring.get(fields.keyId) : keyring?.[fields.keyId];
  if (!entry || entry.role !== fields.role) reject('UNKNOWN_KEY', 'Deployment authorization key is not trusted.');
  const publicKey = entry.publicKey || await loadAuthorizationPublicKey(entry.publicKeyPath, { expectedUid });
  if (publicKey?.asymmetricKeyType !== 'ed25519') reject('INVALID_KEY');
  const payload = canonicalAuthorizationPayload(fields, { nowSeconds, checkFreshness });
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

const MAX_LEDGER_RECORD_BYTES = 8192;
export const MAX_AUTHORIZATION_RESULT_BYTES = 2048;

function canonicalResultJson(result) {
  let json;
  try { json = JSON.stringify(result); }
  catch { reject('INVALID_RESULT', 'Deployment action result is not serializable.'); }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') < 1 ||
      Buffer.byteLength(json, 'utf8') > MAX_AUTHORIZATION_RESULT_BYTES) {
    reject('INVALID_RESULT', 'Deployment action result is not bounded.');
  }
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { reject('INVALID_RESULT'); }
  if (JSON.stringify(parsed) !== json) reject('INVALID_RESULT', 'Deployment action result is not canonical JSON.');
  return json;
}

function recordIdentity(fields, payloadSha256) {
  return {
    role: fields.role,
    command: fields.command,
    runId: fields.runId,
    releaseSha: fields.releaseSha,
    artifactSha256: fields.artifactSha256,
    tag: fields.tag,
    keyId: fields.keyId,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    payloadSha256
  };
}

function parseLedgerRecord(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') < 2 ||
      Buffer.byteLength(text, 'utf8') > MAX_LEDGER_RECORD_BYTES || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    reject('INVALID_LEDGER');
  }
  let record;
  try { record = JSON.parse(text); }
  catch { reject('INVALID_LEDGER'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || `${JSON.stringify(record)}\n` !== text || record.formatVersion !== 2) {
    reject('INVALID_LEDGER');
  }
  const normalizedRecord = normalizeAuthorizationFields(record, { checkFreshness: false });
  if (!digestPattern.test(record.payloadSha256 || '')) reject('INVALID_LEDGER');
  const expectedPayload = canonicalAuthorizationPayload(normalizedRecord, { checkFreshness: false });
  if (crypto.createHash('sha256').update(expectedPayload, 'ascii').digest('hex') !== record.payloadSha256) reject('INVALID_LEDGER');
  if (!Number.isSafeInteger(record.startedAt) || record.startedAt < 0) reject('INVALID_LEDGER');
  const baseKeys = ['formatVersion', 'status', ...Object.keys(recordIdentity(normalizedRecord, record.payloadSha256)), 'startedAt'];
  if (record.status === 'started') {
    if (Object.keys(record).join(',') !== baseKeys.join(',')) reject('INVALID_LEDGER');
    return record;
  }
  if (!Number.isSafeInteger(record.completedAt) || record.completedAt < record.startedAt) reject('INVALID_LEDGER');
  if (record.status === 'failed') {
    if (Object.keys(record).join(',') !== [...baseKeys, 'completedAt'].join(',')) reject('INVALID_LEDGER');
    return record;
  }
  if (record.status === 'completed') {
    let parsedResult;
    try { parsedResult = JSON.parse(record.resultJson); }
    catch { reject('INVALID_LEDGER'); }
    if (Object.keys(record).join(',') !== [...baseKeys, 'resultJson', 'completedAt'].join(',') ||
        typeof record.resultJson !== 'string' || canonicalResultJson(parsedResult) !== record.resultJson) {
      reject('INVALID_LEDGER');
    }
    return record;
  }
  reject('INVALID_LEDGER');
}

async function readLedgerText(recordPath, expectedUid, { missing = false } = {}) {
  let handle;
  try {
    handle = await fs.open(recordPath, fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_LEDGER_RECORD_BYTES ||
        (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600) ||
        (expectedUid !== undefined && stat.uid !== expectedUid)) reject('INVALID_LEDGER');
    return await handle.readFile('utf8');
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return null;
    if (error instanceof DeploymentAuthorizationError) throw error;
    reject('INVALID_LEDGER');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function replaceLedgerRecord(recordPath, expected, next, expectedUid) {
  const current = await readLedgerText(recordPath, expectedUid);
  if (current === next) {
    await syncDirectory(path.dirname(recordPath));
    return;
  }
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

function activeUse({ key, recordPath, started, ownerUid, replaceRecord, resumed = false }) {
  const startedAt = JSON.parse(started).startedAt;
  let state = 'started';
  async function finish(status, result) {
    if (state !== 'started') reject('LEDGER_CONFLICT', 'Deployment authorization ledger is already finalized.');
    const completedAt = Math.max(startedAt, Math.floor(Date.now() / 1000));
    const parsedStarted = JSON.parse(started);
    const nextRecord = status === 'completed'
      ? { ...parsedStarted, status, resultJson: canonicalResultJson(result), completedAt }
      : { ...parsedStarted, status, completedAt };
    const next = `${JSON.stringify(nextRecord)}\n`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await replaceRecord(recordPath, started, next, ownerUid);
        state = status;
        return;
      } catch (error) {
        lastError = error;
        const observed = await readLedgerText(recordPath, ownerUid).catch(() => null);
        if (observed !== started && observed !== next) break;
      }
    }
    throw lastError || new DeploymentAuthorizationError('LEDGER_CONFLICT');
  }
  return {
    key,
    recordPath,
    replayed: false,
    resumed,
    complete: (result) => finish('completed', result),
    fail: () => finish('failed')
  };
}

function existingUse(record, recordText, fields, payloadSha256, nowSeconds, key, recordPath, options) {
  for (const name of ['role', 'command', 'runId', 'releaseSha', 'artifactSha256', 'tag']) {
    if (record[name] !== fields[name]) reject('REPLAY_CONFLICT', 'Deployment authorization conflicts with a consumed operation.');
  }
  const exactAuthorization = record.keyId === fields.keyId && record.issuedAt === fields.issuedAt &&
    record.expiresAt === fields.expiresAt && record.payloadSha256 === payloadSha256;
  if (!exactAuthorization) normalizeAuthorizationFields(fields, { nowSeconds });
  if (record.status === 'completed') {
    return { key, recordPath, replayed: true, result: JSON.parse(record.resultJson) };
  }
  if (record.status === 'failed') reject('PRIOR_FAILED', 'Deployment authorization previously failed and will not be re-executed.');
  if (options.allowStartedRecovery) {
    return activeUse({
      key,
      recordPath,
      started: recordText,
      ownerUid: options.ownerUid,
      replaceRecord: options.replaceRecord,
      resumed: true
    });
  }
  reject('IN_PROGRESS', 'Deployment authorization is already executing; retry the exact request later.');
}

export async function beginAuthorizationUse({
  ledgerRoot,
  fields: rawFields,
  payloadSha256,
  nowSeconds,
  expectedUid,
  replaceRecord = replaceLedgerRecord,
  allowStartedRecovery = false
}) {
  const ownerUid = expectedUid ?? process.getuid?.();
  const fields = normalizeAuthorizationFields(rawFields, { nowSeconds, checkFreshness: false });
  if (!digestPattern.test(payloadSha256 || '')) reject('INVALID_LEDGER');
  const root = await assertSafeLedgerRoot(ledgerRoot, ownerUid);
  const key = replayKey(fields);
  const recordPath = path.join(root, `${key}.json`);
  const existingText = await readLedgerText(recordPath, ownerUid, { missing: true });
  const existingOptions = { allowStartedRecovery, ownerUid, replaceRecord };
  if (existingText !== null) return existingUse(parseLedgerRecord(existingText), existingText, fields, payloadSha256, nowSeconds, key, recordPath, existingOptions);

  // A previously completed exact request may be reconciled after expiry, but a
  // new operation must still be fresh before its one-use record is created.
  normalizeAuthorizationFields(rawFields, { nowSeconds });
  const startedAt = nowSeconds ?? Math.floor(Date.now() / 1000);
  const started = `${JSON.stringify({
    formatVersion: 2,
    status: 'started',
    ...recordIdentity(fields, payloadSha256),
    startedAt
  })}\n`;
  let handle;
  try {
    handle = await fs.open(recordPath, fsConstants.constants.O_CREAT | fsConstants.constants.O_EXCL | fsConstants.constants.O_WRONLY | (fsConstants.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(started, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = await readLedgerText(recordPath, ownerUid);
      return existingUse(parseLedgerRecord(raced), raced, fields, payloadSha256, nowSeconds, key, recordPath, existingOptions);
    }
    if (error instanceof DeploymentAuthorizationError) throw error;
    reject('INVALID_LEDGER');
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(root);
  return activeUse({ key, recordPath, started, ownerUid, replaceRecord });
}
