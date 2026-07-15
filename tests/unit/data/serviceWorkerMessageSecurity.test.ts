import fs from 'node:fs';
import vm from 'node:vm';

type WorkerMessage = {
  data: { type: string };
  origin: string;
  ports?: Array<{ postMessage: ReturnType<typeof vi.fn> }>;
  source: object | null;
};

type WorkerMessageHandler = (event: WorkerMessage & { waitUntil: (promise: Promise<unknown>) => void }) => void;
type WorkerSourceKind = 'generated' | 'production';
type TimerCallback = () => void;

const appOrigin = 'https://skyjo.example';
const activationType = 'SKYJO_ACTIVATE_UPDATE';
const sanitizerType = 'SKYJO_SANITIZE_CACHE';
const workerSourceKinds: WorkerSourceKind[] = ['generated', 'production'];

function generatedTestWorkerSource(): string {
  const serverSource = fs.readFileSync('server.mjs', 'utf8');
  const start = serverSource.indexOf('function testPwaWorkerSource(variant) {');
  const end = serverSource.indexOf('\n\nfunction makeRoomCode', start);
  if (start < 0 || end < 0) throw new Error('Generated test worker source builder was not found.');
  const context: { workerSource?: string } = {};
  vm.runInNewContext(`${serverSource.slice(start, end)}\nworkerSource = testPwaWorkerSource('A');`, context);
  if (typeof context.workerSource !== 'string') throw new Error('Generated test worker source was not produced.');
  return context.workerSource;
}

function workerSource(kind: WorkerSourceKind): string {
  return kind === 'generated'
    ? generatedTestWorkerSource()
    : fs.readFileSync('src/service-worker.js', 'utf8');
}

function loadMessageHandler(
  kind: WorkerSourceKind = 'production',
  options: {
    onTimerScheduled?: (delay: number) => void;
    skipWaiting?: () => Promise<unknown>;
  } = {}
) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const skipWaiting = vi.fn(options.skipWaiting || (() => Promise.resolve()));
  const scheduleTimer = (callback: TimerCallback, delay: number) => {
    options.onTimerScheduled?.(delay);
    return setTimeout(callback, delay);
  };
  const cache = {
    delete: vi.fn(() => Promise.resolve(true)),
    keys: vi.fn(() => Promise.resolve([]))
  };
  const caches = {
    open: vi.fn(() => Promise.resolve(cache))
  };
  const self = {
    __WB_MANIFEST: [],
    addEventListener: vi.fn((type: string, handler: (...args: never[]) => unknown) => handlers.set(type, handler)),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    location: { origin: appOrigin },
    skipWaiting
  };
  vm.runInNewContext(workerSource(kind), { caches, self, setTimeout: scheduleTimer });
  const handler = handlers.get('message') as WorkerMessageHandler | undefined;
  if (!handler) throw new Error('Service worker message handler was not registered.');
  return { cache, caches, handler, skipWaiting };
}

function beginDispatch(handler: WorkerMessageHandler, message: WorkerMessage, onWaitUntil?: () => void) {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    onWaitUntil?.();
    pending.push(Promise.resolve(promise));
  });
  handler({ ...message, ports: message.ports || [], waitUntil });
  return { pending, waitUntil };
}

async function dispatchMessage(handler: WorkerMessageHandler, message: WorkerMessage) {
  const { pending, waitUntil } = beginDispatch(handler, message);
  await Promise.all(pending);
  return { waitUntil };
}

describe('service worker message trust boundary', () => {
  it.each(workerSourceKinds)('%s worker uses a caught skip request and an independent 50ms grace', async (kind) => {
    vi.useFakeTimers();
    try {
      for (const outcome of ['pending', 'resolved', 'rejected'] as const) {
        const order: string[] = [];
        const skipWaiting = () => {
          order.push('skip');
          if (outcome === 'resolved') return Promise.resolve();
          if (outcome === 'rejected') return Promise.reject(new Error('skip request rejected'));
          return new Promise<undefined>(() => {});
        };
        const loaded = loadMessageHandler(kind, {
          skipWaiting,
          onTimerScheduled: (delay) => order.push(`timer:${delay}`)
        });
        const { pending, waitUntil } = beginDispatch(loaded.handler, {
          data: { type: activationType },
          origin: appOrigin,
          source: { id: 'same-origin-client' }
        }, () => order.push('waitUntil'));
        expect(loaded.skipWaiting).toHaveBeenCalledTimes(1);
        expect(waitUntil).toHaveBeenCalledTimes(1);
        expect(pending).toHaveLength(1);
        expect(order).toEqual(['skip', 'timer:50', 'waitUntil']);
        expect(loaded.caches.open).not.toHaveBeenCalled();

        let graceSettled = false;
        void pending[0].then(() => { graceSettled = true; });
        await Promise.resolve();
        expect(graceSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(49);
        expect(graceSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending[0];
        expect(graceSettled).toBe(true);
        vi.clearAllTimers();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(workerSourceKinds)('%s worker accepts exact-origin activation with either truthy or null source', async (kind) => {
    for (const source of [{ id: 'same-origin-client' }, null]) {
      const { caches, handler, skipWaiting } = loadMessageHandler(kind);
      const { waitUntil } = await dispatchMessage(handler, {
        data: { type: activationType },
        origin: appOrigin,
        source
      });

      expect(skipWaiting).toHaveBeenCalledTimes(1);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(caches.open).not.toHaveBeenCalled();
    }
  });

  it.each(workerSourceKinds)('%s worker rejects activation from every non-matching origin', (kind) => {
    for (const origin of ['', 'null', 'https://attacker.example']) {
      for (const source of [{ id: 'unexpected-source' }, null]) {
        const scheduled: number[] = [];
        const { caches, handler, skipWaiting } = loadMessageHandler(kind, {
          onTimerScheduled: (delay) => scheduled.push(delay)
        });
        const { pending, waitUntil } = beginDispatch(handler, {
          data: { type: activationType },
          origin,
          source
        });

        expect(skipWaiting).not.toHaveBeenCalled();
        expect(waitUntil).not.toHaveBeenCalled();
        expect(pending).toHaveLength(0);
        expect(scheduled).toHaveLength(0);
        expect(caches.open).not.toHaveBeenCalled();
      }
    }
  });

  it.each(workerSourceKinds)('%s worker never couples waitUntil directly to skipWaiting', (kind) => {
    const source = workerSource(kind);
    expect(source).toContain('const skipWaitingGraceMs = 50;');
    expect(source).toContain('void self.skipWaiting().catch(() => {});');
    expect(source).toContain('setTimeout(resolve, skipWaitingGraceMs)');
    expect(source).not.toContain('waitUntil(self.skipWaiting())');
  });

  it.each([
    { origin: '', source: null },
    { origin: '', source: { id: 'unexpected-source' } },
    { origin: appOrigin, source: null },
    { origin: 'https://attacker.example', source: { id: 'attacker-source' } },
    { origin: 'null', source: { id: 'opaque-source' } }
  ])('rejects sanitizer without both same origin and a source: $origin/$source', async ({ origin, source }) => {
    const postMessage = vi.fn();
    const { caches, handler } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: sanitizerType },
      origin,
      ports: [{ postMessage }],
      source
    });

    expect(caches.open).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('allows same-origin sanitizer when a source is present', async () => {
    const postMessage = vi.fn();
    const { cache, caches, handler } = loadMessageHandler();
    const { waitUntil } = await dispatchMessage(handler, {
      data: { type: sanitizerType },
      origin: appOrigin,
      ports: [{ postMessage }],
      source: { id: 'same-origin-client' }
    });

    expect(caches.open).toHaveBeenCalledTimes(1);
    expect(cache.keys).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('ok');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
