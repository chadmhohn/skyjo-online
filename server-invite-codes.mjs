import crypto from 'node:crypto';
import { createUniqueRandomCode, PublicApiError } from './server-account-store.mjs';

export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 7;
export const DEFAULT_INVITE_CODE_MAX_ACTIVE = 32;
export const DEFAULT_INVITE_CODE_MAX_ATTEMPTS = 128;
const inviteLookupDomain = 'skyjo:invite-code-lookup:v1\0';

export function cleanInviteInstallCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized.length !== INVITE_CODE_LENGTH) return '';
  return [...normalized].every((character) => INVITE_CODE_ALPHABET.includes(character)) ? normalized : '';
}

export function hashInviteInstallCode(code, secret) {
  const normalizedCode = cleanInviteInstallCode(code);
  if (normalizedCode.length !== INVITE_CODE_LENGTH) throw new TypeError('Invite code is invalid.');
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('Invite code secret is invalid.');
  return crypto
    .createHmac('sha256', secret)
    .update(inviteLookupDomain)
    .update(normalizedCode)
    .digest('hex');
}

export function createPersistentInviteInstallCode({
  store,
  roomCode,
  roomInstanceId,
  expiresAt,
  secret,
  randomInt = crypto.randomInt,
  maxActive = DEFAULT_INVITE_CODE_MAX_ACTIVE,
  maxAttempts = DEFAULT_INVITE_CODE_MAX_ATTEMPTS
}) {
  if (!store || typeof store.createInviteCode !== 'function') {
    throw new Error('Invite code persistence is unavailable.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4096) {
    throw new TypeError('Invite code attempt limit is invalid.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = createUniqueRandomCode({
      alphabet: INVITE_CODE_ALPHABET,
      length: INVITE_CODE_LENGTH,
      randomInt,
      maxAttempts: 1
    });
    const result = store.createInviteCode({
      codeLookupHash: hashInviteInstallCode(code, secret),
      roomCode,
      roomInstanceId,
      expiresAt,
      maxActive
    });
    if (result.status === 'created') return { code, expiresAt: result.expiresAt };
    if (result.status === 'limit') throw new PublicApiError('INVITE_CODE_LIMIT');
    if (result.status !== 'collision') throw new Error('Invite code persistence returned an invalid result.');
  }

  throw new PublicApiError('CODE_ALLOCATION_FAILED');
}

export function createInviteRedemptionRateLimiter({
  limit = 12,
  windowMs = 5 * 60 * 1000,
  maxKeys = 10_000,
  now = Date.now
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('Rate limit is invalid.');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000) throw new TypeError('Rate window is invalid.');
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000) throw new TypeError('Rate key limit is invalid.');
  if (typeof now !== 'function') throw new TypeError('Rate clock is invalid.');
  const records = new Map();

  function prune(timestamp) {
    for (const [key, record] of records) {
      if (record.startedAt + windowMs <= timestamp) records.delete(key);
    }
  }

  return Object.freeze({
    consume(value) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Rate clock returned an invalid value.');
      prune(timestamp);
      const key = String(value || 'unknown').slice(0, 240);
      let record = records.get(key);
      if (!record) {
        if (records.size >= maxKeys) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
        record = { count: 0, startedAt: timestamp };
        records.set(key, record);
      }
      record.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((record.startedAt + windowMs - timestamp) / 1000));
      return { allowed: record.count <= limit, retryAfterSeconds };
    },
    size() {
      return records.size;
    }
  });
}
