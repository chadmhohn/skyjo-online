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
const identityType = 'SKYJO_TEST_WORKER_IDENTITY';
const sanitizerType = 'SKYJO_SANITIZE_CACHE';
const workerSourceKinds: WorkerSourceKind[] = ['generated', 'production'];

function generatedTestWorkerSource(
  variant = 'A',
  activationBarrierToken: string | null = null,
  workerBuildNonce: string | null = null
): string {
  const serverSource = fs.readFileSync('server.mjs', 'utf8');
  const start = serverSource.indexOf(
    'function testPwaWorkerSource(variant, activationBarrierToken = null, workerBuildNonce = null) {'
  );
  const end = serverSource.indexOf('\n\nfunction makeRoomCode', start);
  if (start < 0 || end < 0) throw new Error('Generated test worker source builder was not found.');
  const context: { workerSource?: string } = {};
  vm.runInNewContext(
    `${serverSource.slice(start, end)}\nworkerSource = testPwaWorkerSource(${JSON.stringify(variant)}, ${JSON.stringify(activationBarrierToken)}, ${JSON.stringify(workerBuildNonce)});`,
    context
  );
  if (typeof context.workerSource !== 'string') throw new Error('Generated test worker source was not produced.');
  return context.workerSource;
}

function generatedTestBarrierWaiters(now: number) {
  const serverSource = fs.readFileSync('server.mjs', 'utf8');
  const start = serverSource.indexOf('async function waitForTestPwaActivationArrivals(');
  const end = serverSource.indexOf('\n\nfunction sendInvalidTestPwaActivationBarrierResponse', start);
  if (start < 0 || end < 0) throw new Error('Generated test barrier waiters were not found.');
  const context: {
    Date: { now: () => number };
    arrivalWaiter?: (...args: unknown[]) => Promise<string>;
    releaseWaiter?: (...args: unknown[]) => Promise<string>;
  } = { Date: { now: () => now } };
  vm.runInNewContext(
    `${serverSource.slice(start, end)}\narrivalWaiter = waitForTestPwaActivationArrivals; releaseWaiter = waitForTestPwaActivationRelease;`,
    context
  );
  if (!context.arrivalWaiter || !context.releaseWaiter) {
    throw new Error('Generated test barrier waiters were not evaluated.');
  }
  return { arrivalWaiter: context.arrivalWaiter, releaseWaiter: context.releaseWaiter };
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
    crypto: {
      getRandomValues: vi.fn((values: Uint32Array) => {
        values.set([0x01234567, 0x89abcdef, 0x13579bdf, 0x2468ace0]);
        return values;
      })
    },
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

  it('generated successor workers use the scoped activation barrier only when explicitly requested', () => {
    const token = 'barrier_test_token_1234';
    const buildNonce = 'worker_build_nonce_1234';
    const initialSource = generatedTestWorkerSource('A', token, buildNonce);
    const successorSource = generatedTestWorkerSource('B', token, buildNonce);

    expect(initialSource).not.toContain('/__test/pwa-activation/');
    expect(initialSource).not.toContain(token);
    expect(successorSource).toContain(`const activationBarrierToken=${JSON.stringify(token)};`);
    expect(successorSource).toContain("fetch('/__test/pwa-activation/arrive'");
    expect(successorSource).toContain("fetch('/__test/pwa-activation/wait-release?");
    expect(successorSource).toContain('variant: version');
    expect(successorSource).toContain('buildNonce: workerBuildNonce');
    expect(successorSource).toContain('instanceNonce: workerInstanceNonce');
    expect(successorSource).toContain('await waitAtActivationBarrier();');
  });

  it('keeps every generated PWA diagnostic behind both test-only environment gates', () => {
    const serverSource = fs.readFileSync('server.mjs', 'utf8');
    expect(serverSource).toContain(
      "const testPwaVariantsEnabled = process.env.NODE_ENV === 'test' && process.env.SKYJO_TEST_PWA_VARIANTS === 'true';"
    );
    expect(serverSource).toContain("if (testPwaVariantsEnabled && url.pathname === '/sw.js') {");
    expect(serverSource).toContain("if (url.pathname.startsWith('/__test/pwa-activation/')) {");
    expect(serverSource).toContain('if (!testPwaVariantsEnabled) {');
    expect(workerSource('production')).not.toContain(identityType);
    expect(workerSource('production')).not.toContain('/__test/pwa-activation/');
  });

  it('makes the absolute activation deadline win over arrived and released fast paths', async () => {
    const request = {};
    const response = {};
    const overdue = generatedTestBarrierWaiters(101);
    await expect(overdue.arrivalWaiter({
      arrivals: ['B'],
      deadlineAt: 100,
      poisoned: false
    }, 1, request, response)).resolves.toBe('timeout');
    const overdueWorker = { released: true, waitStarted: false };
    await expect(overdue.releaseWaiter({
      deadlineAt: 100,
      poisoned: false
    }, overdueWorker, request, response)).resolves.toBe('timeout');
    expect(overdueWorker.waitStarted).toBe(false);

    const beforeDeadline = generatedTestBarrierWaiters(99);
    await expect(beforeDeadline.arrivalWaiter({
      arrivals: ['B'],
      deadlineAt: 100,
      poisoned: false
    }, 1, request, response)).resolves.toBe('arrived');
    const releasedWorker = { released: true, waitStarted: false };
    await expect(beforeDeadline.releaseWaiter({
      deadlineAt: 100,
      poisoned: false
    }, releasedWorker, request, response)).resolves.toBe('released');
    expect(releasedWorker.waitStarted).toBe(true);

    await expect(beforeDeadline.arrivalWaiter({
      arrivals: ['B'],
      deadlineAt: 100,
      poisoned: true
    }, 1, request, response)).resolves.toBe('poisoned');
    await expect(beforeDeadline.releaseWaiter({
      deadlineAt: 100,
      poisoned: true
    }, { released: true, waitStarted: false }, request, response)).resolves.toBe('poisoned');
  });

  it('generated test workers disclose their exact identity only to an exact-origin message port', async () => {
    const buildNonce = 'worker_build_nonce_5678';
    const postMessage = vi.fn();
    const { handler } = loadMessageHandler('generated');
    await dispatchMessage(handler, {
      data: { type: identityType },
      origin: appOrigin,
      ports: [{ postMessage }],
      source: null
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: identityType,
      variant: 'A',
      buildNonce: null,
      instanceNonce: '0123456789abcdef13579bdf2468ace0'
    });

    for (const origin of ['', 'null', 'https://attacker.example']) {
      const rejectedPost = vi.fn();
      await dispatchMessage(handler, {
        data: { type: identityType },
        origin,
        ports: [{ postMessage: rejectedPost }],
        source: { id: 'untrusted-client' }
      });
      expect(rejectedPost).not.toHaveBeenCalled();
    }

    await dispatchMessage(handler, {
      data: { type: identityType },
      origin: appOrigin,
      ports: [],
      source: { id: 'same-origin-client' }
    });
    expect(workerSource('production')).not.toContain(identityType);
    expect(generatedTestWorkerSource('D', null, buildNonce)).toContain(
      `const workerBuildNonce=${JSON.stringify(buildNonce)};`
    );
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
