import { createPersistenceHealthTracker } from '../../../server-persistence-health.mjs';

describe('persistence health tracker', () => {
  it('starts unknown and records sanitized success state', () => {
    const tracker = createPersistenceHealthTracker({ clock: () => 101 });

    expect(tracker.probe()).toEqual({
      status: 'unknown',
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      failureCode: null
    });
    expect(Object.isFrozen(tracker.probe())).toBe(true);

    expect(tracker.recordSuccess()).toEqual({
      status: 'ok',
      lastAttemptAt: 101,
      lastSuccessAt: 101,
      lastFailureAt: null,
      failureCode: null
    });
  });

  it('retains only a safe failure code and recovers after a later success', () => {
    let now = 200;
    const tracker = createPersistenceHealthTracker({ clock: () => now });
    const sensitiveError = Object.assign(new Error('SQL failed at C:\\secret\\rooms.json'), {
      code: 'SQLITE_BUSY',
      query: 'select secret from users'
    });

    const failed = tracker.recordFailure(sensitiveError);
    expect(failed).toEqual({
      status: 'error',
      lastAttemptAt: 200,
      lastSuccessAt: null,
      lastFailureAt: 200,
      failureCode: 'SQLITE_BUSY'
    });
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(JSON.stringify(failed)).not.toContain('select');

    now = 201;
    expect(tracker.recordSuccess()).toEqual({
      status: 'ok',
      lastAttemptAt: 201,
      lastSuccessAt: 201,
      lastFailureAt: 200,
      failureCode: null
    });
  });

  it('tracks successful operations without changing their result', async () => {
    const tracker = createPersistenceHealthTracker({ clock: () => 300 });

    await expect(tracker.track(async () => 'saved')).resolves.toBe('saved');
    expect(tracker.probe()).toEqual(expect.objectContaining({ status: 'ok', lastSuccessAt: 300 }));
  });

  it('records and rethrows failed operations with a generic code when needed', async () => {
    const tracker = createPersistenceHealthTracker({ clock: () => 400 });
    const error = new Error('private path');

    await expect(tracker.track(async () => {
      throw error;
    })).rejects.toBe(error);
    expect(tracker.probe()).toEqual({
      status: 'error',
      lastAttemptAt: 400,
      lastSuccessAt: null,
      lastFailureAt: 400,
      failureCode: 'PERSISTENCE_ERROR'
    });
  });

  it('rejects invalid clocks, operations, and timestamps', async () => {
    expect(() => createPersistenceHealthTracker({ clock: 1 as unknown as () => number })).toThrow(/clock/i);
    const tracker = createPersistenceHealthTracker({ clock: () => Number.NaN });
    expect(() => tracker.recordSuccess()).toThrow(/timestamp/i);
    expect(() => tracker.recordFailure(new Error('failure'), -1)).toThrow(/timestamp/i);
    await expect(tracker.track(null as unknown as () => Promise<void>)).rejects.toThrow(/operation/i);
  });
});
