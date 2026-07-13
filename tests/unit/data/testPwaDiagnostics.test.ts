import vm from 'node:vm';
import { REQUIRED_ARCHIVE_ENTRIES } from '../../../deploy/release-controller-lib.mjs';
import { RUNTIME_ROOT_FILES } from '../../../scripts/runtime-artifact-security.mjs';
import {
  handleTestPwaDiagnosticRequest,
  sanitizeTestPwaDiagnosticPayload,
  TEST_PWA_DIAGNOSTIC_LOG_TYPE,
  TEST_PWA_DIAGNOSTIC_MAX_BODY_BYTES,
  TEST_PWA_DIAGNOSTIC_PATH,
  testPwaDiagnosticRoute,
  testPwaWorkerSource
} from '../../../server-test-pwa-diagnostics.mjs';

describe('test-only PWA activation diagnostics', () => {
  it('keeps the endpoint unavailable unless the exact test gate, method, and path match', () => {
    expect(testPwaDiagnosticRoute(false, 'POST', TEST_PWA_DIAGNOSTIC_PATH)).toBe('unavailable');
    expect(testPwaDiagnosticRoute(true, 'GET', TEST_PWA_DIAGNOSTIC_PATH)).toBe('unavailable');
    expect(testPwaDiagnosticRoute(true, 'POST', `${TEST_PWA_DIAGNOSTIC_PATH}/extra`)).toBe('not-diagnostic');
    expect(testPwaDiagnosticRoute(true, 'POST', TEST_PWA_DIAGNOSTIC_PATH)).toBe('enabled');
  });

  it('preserves diagnostic distinctions while bounding and redacting untrusted fields', () => {
    expect(sanitizeTestPwaDiagnosticPayload({
      eventOriginState: 'string',
      eventOrigin: 'null',
      source: 'truthy',
      sourceType: 'WindowClient',
      sourceUrlOrigin: 'https://skyjo.example',
      sourceUrlPath: '/lobby?room=SECRET#fragment',
      portsLength: 2,
      cookie: 'must-not-appear',
      query: 'must-not-appear'
    })).toEqual({
      type: TEST_PWA_DIAGNOSTIC_LOG_TYPE,
      eventOriginState: 'string',
      eventOrigin: 'null',
      source: 'truthy',
      sourceType: 'WindowClient',
      sourceUrlOrigin: 'https://skyjo.example',
      sourceUrlPath: '/lobby',
      portsLength: 2
    });

    const sanitized = sanitizeTestPwaDiagnosticPayload({
      eventOriginState: 'secret-state',
      eventOrigin: `https://skyjo.example\n${'x'.repeat(500)}`,
      source: 'secret-source-id',
      sourceType: `WindowClient\n${'x'.repeat(500)}`,
      sourceUrlOrigin: 'https://skyjo.example/private?token=SECRET',
      sourceUrlPath: '/invite/SECRET?token=SECRET#SECRET',
      portsLength: 999,
      secret: 'SECRET'
    });
    expect(sanitized).toEqual({
      type: TEST_PWA_DIAGNOSTIC_LOG_TYPE,
      eventOriginState: 'other',
      eventOrigin: null,
      source: 'undefined',
      sourceType: 'unknown',
      sourceUrlOrigin: 'https://skyjo.example',
      sourceUrlPath: '/invite/:redacted',
      portsLength: 32
    });
    expect(JSON.stringify(sanitized)).not.toContain('SECRET');

    expect(sanitizeTestPwaDiagnosticPayload({ eventOriginState: 'undefined' })).toMatchObject({
      eventOriginState: 'undefined',
      eventOrigin: null
    });
    expect(sanitizeTestPwaDiagnosticPayload({ eventOriginState: 'null', eventOrigin: null })).toMatchObject({
      eventOriginState: 'null',
      eventOrigin: null
    });
  });

  it('uses the bounded reader and writes one stable sanitized JSON line before a no-store 204', async () => {
    const req = {};
    const res = {};
    const readJsonBody = vi.fn(async (actualReq: object, maximumBytes: number) => {
      expect(actualReq).toBe(req);
      expect(maximumBytes).toBe(TEST_PWA_DIAGNOSTIC_MAX_BODY_BYTES);
      return {
        eventOriginState: 'string',
        eventOrigin: '',
        source: 'null',
        sourceType: 'object',
        sourceUrlOrigin: null,
        sourceUrlPath: '/stats/games/private-game-id?secret=yes',
        portsLength: 0,
        secret: 'must-not-log'
      };
    });
    const send = vi.fn();
    const log = vi.fn();

    await handleTestPwaDiagnosticRequest(req, res, { readJsonBody, send, log });

    expect(readJsonBody).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toEqual({
      type: TEST_PWA_DIAGNOSTIC_LOG_TYPE,
      eventOriginState: 'string',
      eventOrigin: '',
      source: 'null',
      sourceType: 'object',
      sourceUrlOrigin: null,
      sourceUrlPath: '/stats/games/:redacted',
      portsLength: 0
    });
    expect(send).toHaveBeenCalledWith(res, 204, '', { 'Cache-Control': 'no-store' });
  });

  it('does not log or respond when the bounded body reader rejects an oversized payload', async () => {
    const error = new Error('request too large');
    const readJsonBody = vi.fn(async (_req: object, maximumBytes: number) => {
      expect(maximumBytes).toBe(4096);
      throw error;
    });
    const send = vi.fn();
    const log = vi.fn();

    await expect(handleTestPwaDiagnosticRequest({}, {}, { readJsonBody, send, log })).rejects.toBe(error);
    expect(log).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('emits the same-origin beacon before the trust guard without coupling skipWaiting to beacon success', async () => {
    const source = testPwaWorkerSource('B');
    const activationIndex = source.indexOf("const isActivation = event.data?.type === 'SKYJO_ACTIVATE_UPDATE';");
    const beaconIndex = source.indexOf(`fetch(self.__skyjoTestPwaDiagnosticPath`);
    const trustGuardIndex = source.indexOf('if (event.origin !== self.location.origin) {');
    expect(activationIndex).toBeGreaterThan(-1);
    expect(beaconIndex).toBeGreaterThan(activationIndex);
    expect(trustGuardIndex).toBeGreaterThan(beaconIndex);
    expect(source).toContain("credentials: 'omit'");
    expect(source).toContain("referrerPolicy: 'no-referrer'");

    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const skipWaiting = vi.fn(async () => undefined);
    const fetch = vi.fn(async (...requestArguments: [string, Record<string, unknown>]) => {
      void requestArguments;
      throw new Error('diagnostic unavailable');
    });
    const self = {
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler),
      clients: { claim: vi.fn(async () => undefined) },
      location: { origin: 'https://skyjo.example' },
      skipWaiting
    };
    vm.runInNewContext(source, { fetch, self, URL });
    const message = handlers.get('message');
    expect(message).toBeDefined();
    const pending: Array<Promise<unknown>> = [];
    message?.({
      data: { type: 'SKYJO_ACTIVATE_UPDATE' },
      origin: 'https://skyjo.example',
      ports: [],
      source: { url: 'https://skyjo.example/lobby?room=SECRET#fragment' },
      waitUntil: (promise: Promise<unknown>) => pending.push(Promise.resolve(promise))
    });
    await Promise.all(pending);

    expect(skipWaiting).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, request] = fetch.mock.calls[0];
    expect(JSON.parse((request as { body: string }).body)).toMatchObject({
      eventOriginState: 'string',
      eventOrigin: 'https://skyjo.example',
      source: 'truthy',
      sourceType: 'Object',
      sourceUrlOrigin: 'https://skyjo.example',
      sourceUrlPath: '/lobby',
      portsLength: 0
    });

    const dispatchUntrustedOrigin = async (origin: unknown) => {
      const additionalPending: Array<Promise<unknown>> = [];
      message?.({
        data: { type: 'SKYJO_ACTIVATE_UPDATE' },
        origin,
        ports: [],
        source: null,
        waitUntil: (promise: Promise<unknown>) => additionalPending.push(Promise.resolve(promise))
      });
      await Promise.all(additionalPending);
      const [, additionalRequest] = fetch.mock.calls.at(-1) as [string, { body: string }];
      return JSON.parse(additionalRequest.body) as Record<string, unknown>;
    };
    const undefinedOrigin = await dispatchUntrustedOrigin(undefined);
    expect(undefinedOrigin).toMatchObject({ eventOriginState: 'undefined', source: 'null' });
    expect(undefinedOrigin).not.toHaveProperty('eventOrigin');
    const nullOrigin = await dispatchUntrustedOrigin(null);
    expect(nullOrigin).toMatchObject({ eventOriginState: 'null', eventOrigin: null, source: 'null' });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('packages the statically imported diagnostic module in both artifact allowlists', () => {
    expect(RUNTIME_ROOT_FILES).toContain('server-test-pwa-diagnostics.mjs');
    expect(REQUIRED_ARCHIVE_ENTRIES.has('server-test-pwa-diagnostics.mjs')).toBe(true);
  });
});
