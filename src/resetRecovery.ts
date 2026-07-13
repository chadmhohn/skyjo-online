export type ResetRecoveryHint = {
  fromCode: string;
  playerId: string;
  commandId: string;
  expectedRevision: number;
};

export const RESET_RECOVERY_STORAGE_KEY = 'skyjo-reset-recovery';
export const RESET_RECOVERY_MAX_SERIALIZED_LENGTH = 512;

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function normalizeResetRecoveryHint(value: unknown): ResetRecoveryHint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['commandId', 'expectedRevision', 'fromCode', 'playerId'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (typeof record.fromCode !== 'string' || !/^[A-Z0-9]{5}$/.test(record.fromCode)) return null;
  if (typeof record.playerId !== 'string' || !uuidPattern.test(record.playerId)) return null;
  if (typeof record.commandId !== 'string' || !uuidPattern.test(record.commandId)) return null;
  if (
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 0 ||
    Number(record.expectedRevision) >= Number.MAX_SAFE_INTEGER
  ) return null;
  return {
    fromCode: record.fromCode,
    playerId: record.playerId,
    commandId: record.commandId,
    expectedRevision: Number(record.expectedRevision)
  };
}

export function parseResetRecoveryHint(raw: string | null): ResetRecoveryHint | null {
  if (raw === null || raw.length === 0 || raw.length > RESET_RECOVERY_MAX_SERIALIZED_LENGTH) return null;
  try {
    return normalizeResetRecoveryHint(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeResetRecoveryHint(value: ResetRecoveryHint): string {
  const normalized = normalizeResetRecoveryHint(value);
  if (!normalized) throw new TypeError('Invalid reset recovery hint.');
  return JSON.stringify(normalized);
}
