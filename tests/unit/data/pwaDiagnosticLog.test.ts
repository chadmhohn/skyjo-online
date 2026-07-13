import {
  pwaDiagnosticEchoLines,
  pwaDiagnosticEchoPrefix
} from '../../helpers/pwaDiagnosticLog';

function diagnostic(overrides: Record<string, unknown> = {}) {
  return {
    type: 'skyjo-test-pwa-activation-message',
    eventOriginState: 'string',
    eventOrigin: 'https://skyjo.example',
    source: 'truthy',
    sourceType: 'WindowClient',
    sourceUrlOrigin: 'https://skyjo.example',
    sourceUrlPath: '/lobby',
    portsLength: 0,
    ...overrides
  };
}

describe('hosted PWA diagnostic log echo', () => {
  it('parses every complete diagnostic JSON line and emits deterministic canonical lines', () => {
    const line = JSON.stringify(diagnostic());
    const secondLine = JSON.stringify(diagnostic({
      eventOriginState: 'undefined',
      eventOrigin: null,
      source: 'null',
      sourceType: 'object',
      sourceUrlOrigin: null,
      sourceUrlPath: null
    }));
    expect(pwaDiagnosticEchoLines(`startup\r\n${line}\r\n${secondLine}\r\nshutdown\r\n`)).toEqual([
      `${pwaDiagnosticEchoPrefix}${line}`,
      `${pwaDiagnosticEchoPrefix}${secondLine}`
    ]);
  });

  it('never echoes raw, partial, wrong-type, extra-field, or dynamic-path matches', () => {
    const rawMatch = 'warning skyjo-test-pwa-activation-message SECRET';
    const partial = JSON.stringify(diagnostic({ eventOriginState: 'undefined', eventOrigin: null }));
    const wrongType = JSON.stringify(diagnostic({ type: 'other' }));
    const extraSecret = JSON.stringify({ ...diagnostic(), secret: 'SECRET' });
    const dynamicPath = JSON.stringify(diagnostic({ sourceUrlPath: '/invite/SECRET' }));
    const valid = JSON.stringify(diagnostic({
      eventOriginState: 'undefined',
      eventOrigin: null,
      source: 'null',
      sourceType: 'object',
      sourceUrlOrigin: null,
      sourceUrlPath: null
    }));

    expect(pwaDiagnosticEchoLines([
      rawMatch,
      wrongType,
      extraSecret,
      dynamicPath,
      valid,
      partial
    ].join('\n'))).toEqual([`${pwaDiagnosticEchoPrefix}${valid}`]);
  });
});
