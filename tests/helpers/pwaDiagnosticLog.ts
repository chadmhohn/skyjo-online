export const pwaDiagnosticEchoPrefix = 'SKYJO_TEST_PWA_DIAGNOSTIC ';

const diagnosticType = 'skyjo-test-pwa-activation-message';
const diagnosticKeys = [
  'eventOrigin',
  'eventOriginState',
  'portsLength',
  'source',
  'sourceType',
  'sourceUrlOrigin',
  'sourceUrlPath',
  'type'
] as const;
const eventOriginStates = new Set(['string', 'null', 'undefined', 'other']);
const sourceStates = new Set(['null', 'undefined', 'truthy']);
const safeSourcePaths = new Set([
  '/',
  '/:redacted',
  '/account',
  '/admin',
  '/invite/:redacted',
  '/lobby',
  '/login',
  '/single-player',
  '/stats',
  '/stats/games/:redacted',
  '/stats/players/:redacted'
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === diagnosticKeys.length && keys.every((key, index) => key === diagnosticKeys[index]);
}

function isBoundedStringOrNull(value: unknown, maximumLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximumLength && !/[\r\n]/.test(value));
}

function canonicalDiagnostic(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value) || value.type !== diagnosticType) return null;
  if (typeof value.eventOriginState !== 'string' || !eventOriginStates.has(value.eventOriginState)) return null;
  if (!isBoundedStringOrNull(value.eventOrigin, 256)) return null;
  if (typeof value.source !== 'string' || !sourceStates.has(value.source)) return null;
  if (typeof value.sourceType !== 'string' || !/^[A-Za-z][A-Za-z0-9_$.-]{0,63}$/.test(value.sourceType)) return null;
  if (!isBoundedStringOrNull(value.sourceUrlOrigin, 256)) return null;
  if (value.sourceUrlPath !== null && (typeof value.sourceUrlPath !== 'string' || !safeSourcePaths.has(value.sourceUrlPath))) return null;
  if (!Number.isSafeInteger(value.portsLength) || Number(value.portsLength) < 0 || Number(value.portsLength) > 32) return null;

  return JSON.stringify({
    type: diagnosticType,
    eventOriginState: value.eventOriginState,
    eventOrigin: value.eventOrigin,
    source: value.source,
    sourceType: value.sourceType,
    sourceUrlOrigin: value.sourceUrlOrigin,
    sourceUrlPath: value.sourceUrlPath,
    portsLength: value.portsLength
  });
}

export function pwaDiagnosticEchoLines(log: string): string[] {
  const normalized = log.replaceAll('\r\n', '\n');
  const finalNewline = normalized.lastIndexOf('\n');
  if (finalNewline < 0) return [];

  const echoes: string[] = [];
  for (const line of normalized.slice(0, finalNewline).split('\n')) {
    if (!line || line.length > 4096) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const canonical = canonicalDiagnostic(parsed);
    if (canonical) echoes.push(`${pwaDiagnosticEchoPrefix}${canonical}`);
  }
  return echoes;
}
