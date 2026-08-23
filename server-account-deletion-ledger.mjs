import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from './server-room-persistence.mjs';

export const ACCOUNT_DELETION_LEDGER_FORMAT = 'skyjo-account-deletions';
export const ACCOUNT_DELETION_LEDGER_VERSION = 1;

const maximumLedgerBytes = 8 * 1024 * 1024;
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function normalizeUserId(value) {
  const userId = typeof value === 'string' ? value.toLowerCase() : '';
  if (!userIdPattern.test(userId)) throw new Error('Account deletion ledger contains an invalid user identifier.');
  return userId;
}

function normalizeLedger(value) {
  if (!exactKeys(value, ['format', 'version', 'entries']) ||
      value.format !== ACCOUNT_DELETION_LEDGER_FORMAT ||
      value.version !== ACCOUNT_DELETION_LEDGER_VERSION ||
      !Array.isArray(value.entries)) {
    throw new Error('Account deletion ledger has an invalid format.');
  }
  const entries = [];
  const seen = new Set();
  for (const entry of value.entries) {
    if (!exactKeys(entry, ['userId', 'deletedAt'])) {
      throw new Error('Account deletion ledger entry has an invalid shape.');
    }
    const userId = normalizeUserId(entry.userId);
    if (!Number.isSafeInteger(entry.deletedAt) || entry.deletedAt < 0 || seen.has(userId)) {
      throw new Error('Account deletion ledger entry is invalid.');
    }
    seen.add(userId);
    entries.push({ userId, deletedAt: entry.deletedAt });
  }
  return entries.sort((left, right) => left.deletedAt - right.deletedAt || left.userId.localeCompare(right.userId));
}

export function resolveAccountDeletionLedgerPath(env = process.env) {
  const configured = String(env.SKYJO_ACCOUNT_DELETION_LEDGER_FILE || '').trim();
  if (configured) return path.resolve(configured);
  const configuredDatabase = String(env.SKYJO_DB_FILE || '').trim();
  if (configuredDatabase) return path.join(path.dirname(path.resolve(configuredDatabase)), 'account-deletions.json');
  const configuredRooms = String(env.SKYJO_ROOMS_FILE || '').trim();
  if (path.isAbsolute(configuredRooms)) return path.join(path.dirname(configuredRooms), 'account-deletions.json');
  return path.resolve('.data', 'account-deletions.json');
}

export async function loadAccountDeletionLedger(filePath = resolveAccountDeletionLedgerPath(), options = {}) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT' && options.allowMissing !== false) return [];
    if (error?.code === 'ENOENT') throw new Error('Account deletion ledger file is missing.');
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximumLedgerBytes) {
    throw new Error('Account deletion ledger file is invalid.');
  }
  let decoded;
  try {
    decoded = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch {
    throw new Error('Account deletion ledger file is invalid.');
  }
  return normalizeLedger(decoded);
}

export async function createAccountDeletionLedger(options = {}) {
  const filePath = path.resolve(options.filePath || resolveAccountDeletionLedgerPath(options.env));
  const now = options.now || Date.now;
  const exists = await fs.lstat(filePath).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (!exists) {
    await atomicWriteJson(filePath, {
      format: ACCOUNT_DELETION_LEDGER_FORMAT,
      version: ACCOUNT_DELETION_LEDGER_VERSION,
      entries: []
    });
  }
  const entries = new Map((await loadAccountDeletionLedger(filePath, { allowMissing: false })).map((entry) => [entry.userId, entry]));
  let writeQueue = Promise.resolve();

  async function recordDeletion(rawUserId) {
    const userId = normalizeUserId(rawUserId);
    if (entries.has(userId)) return entries.get(userId);
    const deletedAt = now();
    if (!Number.isSafeInteger(deletedAt) || deletedAt < 0) throw new Error('Account deletion timestamp is invalid.');
    const entry = Object.freeze({ userId, deletedAt });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      if (entries.has(userId)) return;
      const nextEntries = [...entries.values(), entry]
        .sort((left, right) => left.deletedAt - right.deletedAt || left.userId.localeCompare(right.userId));
      await atomicWriteJson(filePath, {
        format: ACCOUNT_DELETION_LEDGER_FORMAT,
        version: ACCOUNT_DELETION_LEDGER_VERSION,
        entries: nextEntries
      });
      entries.set(userId, entry);
    });
    await writeQueue;
    return entries.get(userId);
  }

  return Object.freeze({
    filePath,
    entries: () => [...entries.values()].map((entry) => ({ ...entry })),
    recordDeletion
  });
}
