import {
  createUniqueRandomCode,
  PublicApiError,
  publicApiErrorResponse
} from '../../../server-account-store.mjs';

describe('server security helpers', () => {
  it('generates fixed-length codes from an injected bounded random source', () => {
    const maximums: number[] = [];
    const indexes = [0, 1, 2, 3, 4, 5, 6];
    const code = createUniqueRandomCode({
      alphabet: 'ABCDEFGH',
      length: 7,
      randomInt: (maximum: number) => {
        maximums.push(maximum);
        return indexes.shift();
      }
    });

    expect(code).toBe('ABCDEFG');
    expect(maximums).toEqual([8, 8, 8, 8, 8, 8, 8]);
  });

  it('retries collisions deterministically and returns the first free code', () => {
    const indexes = [0, 0, 1, 2];
    const examined: string[] = [];
    const code = createUniqueRandomCode({
      alphabet: 'ABC',
      length: 2,
      isTaken: (candidate: string) => {
        examined.push(candidate);
        return candidate === 'AA';
      },
      randomInt: () => indexes.shift(),
      maxAttempts: 2
    });

    expect(code).toBe('BC');
    expect(examined).toEqual(['AA', 'BC']);
  });

  it('fails closed when the bounded collision budget is exhausted', () => {
    expect(() =>
      createUniqueRandomCode({
        alphabet: 'AB',
        length: 2,
        isTaken: () => true,
        randomInt: () => 0,
        maxAttempts: 2
      })
    ).toThrowError(expect.objectContaining({ name: 'PublicApiError', code: 'CODE_ALLOCATION_FAILED' }));
  });

  it('rejects malformed generator contracts instead of weakening randomness', () => {
    expect(() => createUniqueRandomCode({ alphabet: 'AA', length: 2 })).toThrow(/unique characters/i);
    expect(() => createUniqueRandomCode({ alphabet: 'AB', length: 0 })).toThrow(/length/i);
    expect(() => createUniqueRandomCode({ alphabet: 'AB', length: 2, isTaken: null })).toThrow(/callbacks/i);
    expect(() => createUniqueRandomCode({ alphabet: 'AB', length: 2, maxAttempts: 0 })).toThrow(/attempt limit/i);
    expect(() => createUniqueRandomCode({ alphabet: 'AB', length: 2, randomInt: () => 2 })).toThrow(/random source/i);
  });

  it('only exposes enumerated public errors and genericizes unknown exceptions', () => {
    const controlled = new PublicApiError('INVALID_PUSH_SUBSCRIPTION');
    expect(publicApiErrorResponse(controlled)).toEqual({
      status: 400,
      code: 'INVALID_PUSH_SUBSCRIPTION',
      message: 'Push subscription is invalid.'
    });

    const internalMessage = '<script>SQLITE_CONSTRAINT secrets/internal/path</script>';
    const unknown = publicApiErrorResponse(new Error(internalMessage));
    expect(unknown).toEqual({ status: 500, code: 'REQUEST_FAILED', message: 'Request failed.' });
    expect(JSON.stringify(unknown)).not.toContain(internalMessage);
    expect(() => new PublicApiError('__proto__')).toThrow(/unknown public API error code/i);
  });

  it('publishes sanitized stats upgrade, account-change, and completion-time errors', () => {
    expect(publicApiErrorResponse(new PublicApiError('STATS_CLIENT_UPGRADE_REQUIRED'))).toEqual({
      status: 426,
      code: 'STATS_CLIENT_UPGRADE_REQUIRED',
      message: 'Update Skyjo before syncing saved game stats.'
    });
    expect(publicApiErrorResponse(new PublicApiError('ACCOUNT_SESSION_CHANGED'))).toEqual({
      status: 409,
      code: 'ACCOUNT_SESSION_CHANGED',
      message: 'Account changed. Sign in again before syncing this game.'
    });
    expect(publicApiErrorResponse(new PublicApiError('INVALID_COMPLETED_AT'))).toEqual({
      status: 400,
      code: 'INVALID_COMPLETED_AT',
      message: 'Game completion time is invalid.'
    });
  });

  it('publishes stable access-session contract errors', () => {
    expect(publicApiErrorResponse(new PublicApiError('ACCESS_AUTHENTICATION_FAILED'))).toEqual({
      status: 401,
      code: 'ACCESS_AUTHENTICATION_FAILED',
      message: 'Authentication failed.'
    });
    expect(publicApiErrorResponse(new PublicApiError('INVALID_REQUEST'))).toEqual({
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Request did not match the expected contract.'
    });
    expect(publicApiErrorResponse(new PublicApiError('UNSUPPORTED_MEDIA_TYPE'))).toEqual({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type must be application/json.'
    });
    expect(publicApiErrorResponse(new PublicApiError('METHOD_NOT_ALLOWED'))).toEqual({
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.'
    });
  });
});
