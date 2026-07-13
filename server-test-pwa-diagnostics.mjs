export const TEST_PWA_DIAGNOSTIC_PATH = '/__test/pwa-activation-message';
export const TEST_PWA_DIAGNOSTIC_MAX_BODY_BYTES = 4096;
export const TEST_PWA_DIAGNOSTIC_LOG_TYPE = 'skyjo-test-pwa-activation-message';

const maxOriginLength = 256;
const maxPathLength = 256;
const maxSourceTypeLength = 64;
const eventOriginStates = new Set(['string', 'null', 'undefined', 'other']);
const sourcePresences = new Set(['null', 'undefined', 'truthy']);
const fixedApplicationPaths = new Set([
  '/',
  '/account',
  '/admin',
  '/lobby',
  '/login',
  '/single-player',
  '/stats'
]);

function boundedText(value, maximumLength) {
  if (typeof value !== 'string') return null;
  return Array.from(value.slice(0, maximumLength), (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127 ? '\ufffd' : character;
  }).join('');
}

function sanitizedOrigin(value) {
  const candidate = boundedText(value, maxOriginLength);
  if (candidate === '' || candidate === 'null') return candidate;
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.origin === candidate ? candidate : parsed.origin.slice(0, maxOriginLength);
  } catch {
    return null;
  }
}

function sanitizedPath(value) {
  const candidate = boundedText(value, maxPathLength);
  if (!candidate || !candidate.startsWith('/')) return null;
  const pathname = candidate.split(/[?#]/, 1)[0];
  if (/^\/invite(?:\/|$)/.test(pathname)) return '/invite/:redacted';
  if (/^\/stats\/games(?:\/|$)/.test(pathname)) return '/stats/games/:redacted';
  if (/^\/stats\/players(?:\/|$)/.test(pathname)) return '/stats/players/:redacted';
  return fixedApplicationPaths.has(pathname) ? pathname : '/:redacted';
}

export function testPwaDiagnosticRoute(enabled, method, pathname) {
  if (pathname !== TEST_PWA_DIAGNOSTIC_PATH) return 'not-diagnostic';
  return enabled === true && method === 'POST' ? 'enabled' : 'unavailable';
}

export function sanitizeTestPwaDiagnosticPayload(value) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const eventOriginState = eventOriginStates.has(payload.eventOriginState) ? payload.eventOriginState : 'other';
  const source = sourcePresences.has(payload.source) ? payload.source : 'undefined';
  const sourceTypeCandidate = boundedText(payload.sourceType, maxSourceTypeLength);
  const sourceType = sourceTypeCandidate && /^[A-Za-z][A-Za-z0-9_$.-]*$/.test(sourceTypeCandidate)
    ? sourceTypeCandidate
    : 'unknown';
  const portsLength = Number.isSafeInteger(payload.portsLength)
    ? Math.min(32, Math.max(0, payload.portsLength))
    : 0;

  return {
    type: TEST_PWA_DIAGNOSTIC_LOG_TYPE,
    eventOriginState,
    eventOrigin: sanitizedOrigin(payload.eventOrigin),
    source,
    sourceType,
    sourceUrlOrigin: sanitizedOrigin(payload.sourceUrlOrigin),
    sourceUrlPath: sanitizedPath(payload.sourceUrlPath),
    portsLength
  };
}

export async function handleTestPwaDiagnosticRequest(req, res, { readJsonBody, send, log }) {
  const body = await readJsonBody(req, TEST_PWA_DIAGNOSTIC_MAX_BODY_BYTES);
  const line = JSON.stringify(sanitizeTestPwaDiagnosticPayload(body));
  log(line);
  send(res, 204, '', { 'Cache-Control': 'no-store' });
}

export function testPwaWorkerSource(variant) {
  return `const version=${JSON.stringify(variant)};
self.__skyjoTestPwaDiagnosticPath=${JSON.stringify(TEST_PWA_DIAGNOSTIC_PATH)};
self.addEventListener('install', () => {});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const isActivation = event.data?.type === 'SKYJO_ACTIVATE_UPDATE';
  if (isActivation) {
    try {
      const source = event.source;
      let sourceType = typeof source;
      let sourceUrlOrigin = null;
      let sourceUrlPath = null;
      try {
        if (source?.constructor?.name) sourceType = String(source.constructor.name);
        if (typeof source?.url === 'string') {
          const sourceUrl = new URL(source.url);
          sourceUrlOrigin = sourceUrl.origin;
          sourceUrlPath = sourceUrl.pathname;
        }
      } catch {}
      const diagnostic = fetch(self.__skyjoTestPwaDiagnosticPath, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        referrerPolicy: 'no-referrer',
        body: JSON.stringify({
          eventOriginState: typeof event.origin === 'string'
            ? 'string'
            : event.origin === null
              ? 'null'
              : event.origin === undefined
                ? 'undefined'
                : 'other',
          eventOrigin: event.origin,
          source: source === null ? 'null' : source === undefined ? 'undefined' : 'truthy',
          sourceType,
          sourceUrlOrigin,
          sourceUrlPath,
          portsLength: event.ports?.length ?? 0
        })
      }).then(() => undefined, () => undefined);
      try { event.waitUntil(diagnostic); } catch {}
    } catch {}
  }
  if (event.origin !== self.location.origin) {
    const isWebKitNullSourceActivation = isActivation && event.origin === '' && event.source === null;
    if (!isWebKitNullSourceActivation) return;
  }
  if (isActivation) {
    event.waitUntil(self.skipWaiting());
    return;
  }
});\n`;
}
