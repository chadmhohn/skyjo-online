import { createReadinessResult, createVersionResult } from '../../../server-readiness.mjs';
import { CURRENT_PROTOCOL_VERSION } from '../../../server-release.mjs';

const releaseIdentity = {
  releaseSha: '0123456789abcdef0123456789abcdef01234567',
  buildTimestamp: '2026-07-11T12:00:00.000Z',
  protocolVersion: CURRENT_PROTOCOL_VERSION
};

describe('sanitized public service metadata', () => {
  it('returns the fixed healthy readiness contract', () => {
    expect(
      createReadinessResult({ releaseIdentity, databaseReady: true, roomState: 'ok', lastPersist: true })
    ).toEqual({
      statusCode: 200,
      payload: {
        status: 'ready',
        releaseSha: releaseIdentity.releaseSha,
        schemaVersion: 2,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
      }
    });
  });

  it('maps arbitrary failure objects to fixed enums without reflecting sensitive details', () => {
    const result = createReadinessResult({
      releaseIdentity: null,
      databaseReady: { sql: 'SELECT secret', path: '/private/database' },
      roomState: new Error('private room content'),
      lastPersist: { code: 'EACCES', secret: 'do-not-return' }
    });
    expect(result).toEqual({
      statusCode: 503,
      payload: {
        status: 'not_ready',
        releaseSha: null,
        schemaVersion: 2,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        checks: { database: 'error', roomState: 'error', lastPersist: 'error' }
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|private|EACCES|secret/i);
  });

  it('returns only validated public version fields and a sanitized unavailable response', () => {
    expect(createVersionResult(releaseIdentity)).toEqual({
      statusCode: 200,
      payload: releaseIdentity
    });
    expect(createVersionResult(null)).toEqual({ statusCode: 503, payload: { status: 'unavailable' } });
  });
});
