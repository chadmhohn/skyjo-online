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
    expect(publicApiErrorResponse(controlled)).toEqual({ status: 400, message: 'Push subscription is invalid.' });

    const internalMessage = '<script>SQLITE_CONSTRAINT secrets/internal/path</script>';
    const unknown = publicApiErrorResponse(new Error(internalMessage));
    expect(unknown).toEqual({ status: 500, message: 'Request failed.' });
    expect(JSON.stringify(unknown)).not.toContain(internalMessage);
    expect(() => new PublicApiError('__proto__')).toThrow(/unknown public API error code/i);
  });
});
