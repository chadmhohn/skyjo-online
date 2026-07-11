function normalizeTimestamp(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative finite timestamp`);
  }
  return value;
}

function safeFailureCode(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code.toUpperCase()
    : '';
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PERSISTENCE_ERROR';
}

/**
 * Tracks the outcome of persistence operations without retaining error messages,
 * paths, SQL, room contents, or other data that must not reach readiness output.
 */
export function createPersistenceHealthTracker(options = {}) {
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  let status = 'unknown';
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let failureCode = null;

  function recordSuccess(at = clock()) {
    const timestamp = normalizeTimestamp(at, 'success timestamp');
    status = 'ok';
    lastAttemptAt = timestamp;
    lastSuccessAt = timestamp;
    failureCode = null;
    return probe();
  }

  function recordFailure(error, at = clock()) {
    const timestamp = normalizeTimestamp(at, 'failure timestamp');
    status = 'error';
    lastAttemptAt = timestamp;
    lastFailureAt = timestamp;
    failureCode = safeFailureCode(error);
    return probe();
  }

  function probe() {
    return Object.freeze({
      status,
      lastAttemptAt,
      lastSuccessAt,
      lastFailureAt,
      failureCode
    });
  }

  async function track(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    try {
      const result = await operation();
      recordSuccess();
      return result;
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }

  return Object.freeze({ probe, recordFailure, recordSuccess, track });
}
