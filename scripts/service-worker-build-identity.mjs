import crypto from 'node:crypto';

export const SERVICE_WORKER_BUILD_ID_MARKER = '__SKYJO_WORKER_BUILD_ID__';

function markerCount(value) {
  return value.split(SERVICE_WORKER_BUILD_ID_MARKER).length - 1;
}

function generatedTemplate(value) {
  if (typeof value !== 'string' || markerCount(value) !== 1) {
    throw new Error('The generated service-worker build identity marker must occur exactly once.');
  }
  return value.replace(/\r\n/g, '\n');
}

export function computeServiceWorkerBuildId(outputWithMarker) {
  return crypto.createHash('sha256').update(generatedTemplate(outputWithMarker), 'utf8').digest('hex');
}

export function bindServiceWorkerIdentity(outputWithMarker, buildId = computeServiceWorkerBuildId(outputWithMarker)) {
  const output = generatedTemplate(outputWithMarker);
  if (typeof buildId !== 'string' || !/^[a-f0-9]{64}$/.test(buildId)) {
    throw new Error('A lowercase SHA-256 service-worker build ID is required.');
  }
  const bound = output.replace(SERVICE_WORKER_BUILD_ID_MARKER, buildId);
  if (bound.includes(SERVICE_WORKER_BUILD_ID_MARKER)) {
    throw new Error('Generated service-worker identity binding did not complete.');
  }
  return bound;
}
