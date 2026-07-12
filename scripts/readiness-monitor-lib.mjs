import fs from 'node:fs/promises';
import path from 'node:path';

const failureClasses = new Set([
  'timeout',
  'network',
  'http',
  'invalid-json',
  'invalid-contract',
  'not-ready',
  'internal'
]);

const checkNames = ['database', 'roomState', 'lastPersist'];
const shaPattern = /^[a-f0-9]{40}$/;

function monitorError(failureClass) {
  const error = new Error('Readiness probe failed.');
  error.failureClass = failureClass;
  return error;
}

export function normalizeMonitorBaseUrl(value, monitor) {
  if (monitor !== 'local' && monitor !== 'public') throw new Error('Monitor must be local or public.');
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('Monitor base URL is invalid.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Monitor base URL cannot contain credentials, a query, or a fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('Monitor base URL cannot contain a path.');
  if (monitor === 'local') {
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '4180') {
      throw new Error('Local monitoring is restricted to the production loopback endpoint.');
    }
  } else if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.port) {
    throw new Error('Public monitoring requires an HTTPS origin without a custom port.');
  }
  parsed.pathname = '/';
  return parsed.toString().replace(/\/$/, '');
}

export function validateReadinessPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw monitorError('invalid-contract');
  if (value.status !== 'ready') throw monitorError('not-ready');
  if (!shaPattern.test(value.releaseSha)) throw monitorError('invalid-contract');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw monitorError('invalid-contract');
  if (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) throw monitorError('invalid-contract');
  if (!value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) throw monitorError('invalid-contract');
  if (checkNames.some((name) => value.checks[name] !== 'ok')) throw monitorError('not-ready');
  return {
    releaseSha: value.releaseSha,
    schemaVersion: value.schemaVersion,
    protocolVersion: value.protocolVersion
  };
}

async function oneProbe(url, timeoutMs, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw monitorError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network');
  }
  if (response.status !== 200) {
    const error = monitorError('http');
    error.httpStatus = Number.isInteger(response.status) ? response.status : null;
    throw error;
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw monitorError('network');
  }
  if (Buffer.byteLength(text, 'utf8') > 8192) throw monitorError('invalid-contract');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw monitorError('invalid-json');
  }
  return validateReadinessPayload(payload);
}

export async function probeReadiness(options) {
  const monitor = options.monitor;
  const baseUrl = normalizeMonitorBaseUrl(options.baseUrl, monitor);
  const attempts = Number(options.attempts ?? 1);
  const timeoutMs = Number(options.timeoutMs ?? 10_000);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('Probe attempts must be between 1 and 5.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('Probe timeout must be between 100 and 30000 milliseconds.');
  const now = options.now || (() => new Date());
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const fetchImpl = options.fetchImpl || fetch;
  let lastFailure = { failureClass: 'internal', httpStatus: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const identity = await oneProbe(`${baseUrl}/readyz`, timeoutMs, fetchImpl);
      return {
        formatVersion: 1,
        monitor,
        status: 'healthy',
        checkedAt: now().toISOString(),
        attempts: attempt,
        failureClass: null,
        httpStatus: 200,
        ...identity
      };
    } catch (error) {
      lastFailure = {
        failureClass: failureClasses.has(error?.failureClass) ? error.failureClass : 'internal',
        httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null
      };
      if (attempt < attempts) await sleep(Math.min(1000 * attempt, 2000));
    }
  }
  return {
    formatVersion: 1,
    monitor,
    status: 'unhealthy',
    checkedAt: now().toISOString(),
    attempts,
    failureClass: lastFailure.failureClass,
    httpStatus: lastFailure.httpStatus,
    releaseSha: null,
    schemaVersion: null,
    protocolVersion: null
  };
}

export function normalizeMonitorResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.formatVersion !== 1) {
    throw new Error('Monitor result is invalid.');
  }
  if (value.monitor !== 'local' && value.monitor !== 'public') throw new Error('Monitor result source is invalid.');
  if (value.status !== 'healthy' && value.status !== 'unhealthy') throw new Error('Monitor result status is invalid.');
  const checkedAt = new Date(value.checkedAt);
  if (Number.isNaN(checkedAt.getTime()) || checkedAt.toISOString() !== value.checkedAt) throw new Error('Monitor timestamp is invalid.');
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 1 || value.attempts > 5) throw new Error('Monitor attempt count is invalid.');
  if (value.status === 'healthy') {
    if (
      value.failureClass !== null || value.httpStatus !== 200 || !shaPattern.test(value.releaseSha) ||
      !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 ||
      !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1
    ) {
      throw new Error('Healthy monitor result is inconsistent.');
    }
  } else if (!failureClasses.has(value.failureClass) || (value.httpStatus !== null && !Number.isInteger(value.httpStatus))) {
    throw new Error('Unhealthy monitor result is inconsistent.');
  }
  return {
    formatVersion: 1,
    monitor: value.monitor,
    status: value.status,
    checkedAt: checkedAt.toISOString(),
    attempts: value.attempts,
    failureClass: value.failureClass,
    httpStatus: value.httpStatus,
    releaseSha: value.status === 'healthy' ? value.releaseSha : null,
    schemaVersion: value.status === 'healthy' ? value.schemaVersion : null,
    protocolVersion: value.status === 'healthy' ? value.protocolVersion : null
  };
}

export async function writeMonitorResult(outputPath, result) {
  const normalized = normalizeMonitorResult(result);
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, resolved);
    await fs.chmod(resolved, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return normalized;
}
