const buildIds = new WeakMap<ServiceWorker, string>();
let sequence = 0;

function requestWorkerBuildId(worker: ServiceWorker): Promise<string | null> {
  const cached = buildIds.get(worker);
  if (cached) return Promise.resolve(cached);
  const requestId = `r-${++sequence}`;
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') return resolve(null);
    const channel = new MessageChannel();
    let settled = false;
    const finish = (buildId: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close();
      if (buildId) buildIds.set(worker, buildId);
      resolve(buildId);
    };
    const timeout = window.setTimeout(() => finish(null), 750);
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      const value = data as Record<string, unknown> | null;
      finish(
        value?.type === 'SKYJO_BUILD_ID' &&
          value.version === 1 &&
          value.requestId === requestId &&
          typeof value.buildId === 'string' &&
          /^[a-f0-9]{64}$/.test(value.buildId)
          ? value.buildId
          : null
      );
    };
    channel.port1.start();
    try {
      worker.postMessage({ type: 'SKYJO_GET_BUILD_ID', version: 1, requestId }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(null);
    }
  });
}

export default async function workersShareBuild(first: ServiceWorker, second: ServiceWorker): Promise<boolean> {
  const [firstId, secondId] = await Promise.all([
    requestWorkerBuildId(first), requestWorkerBuildId(second)
  ]);
  return firstId !== null && firstId === secondId;
}
