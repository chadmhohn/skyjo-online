import {
  SERVICE_WORKER_BUILD_ID_MARKER,
  bindServiceWorkerIdentity,
  computeServiceWorkerBuildId
} from '../../../scripts/service-worker-build-identity.mjs';

function injectedWorker(revision = 'revision-a', handler = 'handler-a') {
  return [
    `const workerBuildId = '${SERVICE_WORKER_BUILD_ID_MARKER}';`,
    `const handler = '${handler}';`,
    `precacheAndRoute([{ "revision": "${revision}", "url": "/index.html" }]);`,
    "self.addEventListener('push', () => handler);",
    ''
  ].join('\n');
}

describe('service worker build identity binding', () => {
  it('derives one lowercase SHA-256 identity from the exact post-inject output', () => {
    const output = injectedWorker();
    const buildId = computeServiceWorkerBuildId(output);

    expect(buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(computeServiceWorkerBuildId(output)).toBe(buildId);
    expect(computeServiceWorkerBuildId(output.replace(/\n/g, '\r\n'))).toBe(buildId);
  });

  it('changes identity for either injected-manifest or executable-code mutations', () => {
    const baseline = computeServiceWorkerBuildId(injectedWorker());

    expect(computeServiceWorkerBuildId(injectedWorker('revision-b'))).not.toBe(baseline);
    expect(computeServiceWorkerBuildId(injectedWorker('revision-a', 'handler-b'))).not.toBe(baseline);
  });

  it('binds the computed identity into the sole sentinel after normalizing newlines', () => {
    const output = injectedWorker().replace(/\n/g, '\r\n');
    const buildId = computeServiceWorkerBuildId(output);
    const bound = bindServiceWorkerIdentity(output);

    expect(bound).toContain(`const workerBuildId = '${buildId}';`);
    expect(bound).not.toContain(SERVICE_WORKER_BUILD_ID_MARKER);
    expect(bound).not.toContain('\r\n');
  });

  it('rejects missing or duplicate sentinels and non-SHA-256 replacement values', () => {
    const output = injectedWorker();

    expect(() => computeServiceWorkerBuildId('const workerBuildId = "already-bound";')).toThrow(
      'must occur exactly once'
    );
    expect(() => computeServiceWorkerBuildId(`${output}\n// ${SERVICE_WORKER_BUILD_ID_MARKER}`)).toThrow(
      'must occur exactly once'
    );
    expect(() => bindServiceWorkerIdentity(output, 'A'.repeat(64))).toThrow(
      'lowercase SHA-256'
    );
    expect(() => bindServiceWorkerIdentity(output, 'a'.repeat(63))).toThrow(
      'lowercase SHA-256'
    );
  });
});
