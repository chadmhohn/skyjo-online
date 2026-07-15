import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { SERVICE_WORKER_BUILD_ID_MARKER } from '../../../scripts/service-worker-build-identity.mjs';

type WorkerMessage = {
  data: { type: string; requestId?: unknown; version?: unknown };
  origin: string;
  ports?: Array<{
    close?: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }>;
  source: object | null;
};

type WorkerMessageHandler = (event: WorkerMessage & { waitUntil: (promise: Promise<unknown>) => void }) => void;
type WorkerSourceKind = 'generated' | 'production';
type TimerCallback = () => void;
type TestPwaWorkerBarrier = {
  arrivals: string[];
  deadlineAt: number | null;
  expectedWorkerBuildNonces: Map<string, string>;
  poisoned: boolean;
  releases: string[];
  step: number;
  token: string;
  workers: Map<string, { buildNonce: string; released: boolean }>;
};
type TestPwaWorkerLease = {
  activationBarrierToken: string;
  token: string;
  variant: string;
  workerBuildNonce: string;
};
type TestPwaWorkerRequest = {
  activationBarrierToken?: string | null;
  kind: 'error' | 'worker';
  status?: number;
  variant?: string;
  workerBuildNonce?: string;
} | null;

const appOrigin = 'https://skyjo.example';
const activationType = 'SKYJO_ACTIVATE_UPDATE';
const buildIdentityRequestType = 'SKYJO_GET_BUILD_ID';
const buildIdentityResponseType = 'SKYJO_BUILD_ID';
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
  const context: { crypto: typeof crypto; workerSource?: string } = { crypto };
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

function testPwaWorkerBarrierFixture(
  token = 'activation_barrier_token_1234',
  phase: 'before-d-release' | 'after-d-release' = 'before-d-release'
): TestPwaWorkerBarrier {
  const buildNonces = new Map([
    ['B', 'worker_build_nonce_b'],
    ['C', 'worker_build_nonce_c'],
    ['D', 'worker_build_nonce_d']
  ]);
  const dReleased = phase === 'after-d-release';
  return {
    arrivals: ['B', 'C', 'D'],
    deadlineAt: 200,
    expectedWorkerBuildNonces: buildNonces,
    poisoned: false,
    releases: dReleased ? ['B', 'C', 'D'] : ['B', 'C'],
    step: dReleased ? 6 : 5,
    token,
    workers: new Map([...buildNonces].map(([variant, buildNonce]) => [
      variant,
      { buildNonce, released: variant !== 'D' || dReleased }
    ]))
  };
}

function generatedTestPwaWorkerLease(now = 100) {
  const serverSource = fs.readFileSync('server.mjs', 'utf8');
  const start = serverSource.indexOf('function validTestPwaActivationBarrierToken(');
  const end = serverSource.indexOf('\n\nfunction testPwaExpectedWorkerBuildNonces', start);
  if (start < 0 || end < 0) throw new Error('Generated test worker lease functions were not found.');
  type TestTimer = { callback: TimerCallback; cleared: boolean; delay: number; unref: () => void };
  const timers: TestTimer[] = [];
  let currentTime = now;
  const context: {
    Date: { now: () => number };
    arm?: (token: string, barrier: TestPwaWorkerBarrier) => TestPwaWorkerLease | null;
    clear?: (token?: string | null) => boolean;
    clearTimeout: (timer: TestTimer) => void;
    current?: () => TestPwaWorkerLease | null;
    request?: (cookies: Map<string, string>, barriers: Map<string, unknown>) => TestPwaWorkerRequest;
    setTimeout: (callback: TimerCallback, delay: number) => TestTimer;
    switchToE?: (
      token: string,
      buildNonce: string,
      barrier?: TestPwaWorkerBarrier | null
    ) => TestPwaWorkerLease | null;
  } = {
    Date: { now: () => currentTime },
    clearTimeout: (timer) => { timer.cleared = true; },
    setTimeout: (callback, delay) => {
      const timer = { callback, cleared: false, delay, unref: () => {} };
      timers.push(timer);
      return timer;
    }
  };
  vm.runInNewContext(
    `const testPwaWorkerLeaseLifetimeMs = 30000;
let testPwaWorkerLease = null;
${serverSource.slice(start, end)}
arm = armTestPwaWorkerLeaseForReleasedD;
clear = clearTestPwaWorkerLease;
current = activeTestPwaWorkerLease;
request = testPwaWorkerRequest;
switchToE = switchTestPwaWorkerLeaseToE;`,
    context
  );
  if (!context.arm || !context.clear || !context.current || !context.request || !context.switchToE) {
    throw new Error('Generated test worker lease functions were not evaluated.');
  }
  return {
    arm: context.arm,
    clear: context.clear,
    current: context.current,
    request: (cookies: Map<string, string>, barriers = new Map<string, unknown>()) => (
      context.request?.(cookies, barriers) ?? null
    ),
    setNow: (value: number) => { currentTime = value; },
    switchToE: context.switchToE,
    timers
  };
}

function workerSource(kind: WorkerSourceKind): string {
  return kind === 'generated'
    ? generatedTestWorkerSource()
    : fs.readFileSync('src/service-worker.js', 'utf8');
}

function buildIdentityFixture(kind: WorkerSourceKind, buildNonce = 'worker_build_nonce_identity') {
  if (kind === 'generated') {
    return {
      buildId: crypto
        .createHash('sha256')
        .update(`skyjo-test-worker:${buildNonce}`, 'utf8')
        .digest('hex'),
      source: generatedTestWorkerSource('D', null, buildNonce)
    };
  }
  const buildId = 'b'.repeat(64);
  return {
    buildId,
    source: workerSource('production').replace(SERVICE_WORKER_BUILD_ID_MARKER, buildId)
  };
}

function loadMessageHandler(
  kind: WorkerSourceKind = 'production',
  options: {
    onTimerScheduled?: (delay: number) => void;
    skipWaiting?: () => Promise<unknown>;
    source?: string;
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
  const source = options.source || workerSource(kind);
  vm.runInNewContext(source, { caches, self, setTimeout: scheduleTimer });
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
    expect(serverSource).toContain("url.pathname === '/__test/pwa-activation/lease'");
    expect(serverSource).toContain(
      'const workerRequest = testPwaWorkerRequest(cookies, testPwaActivationBarriers);'
    );
    expect(workerSource('production')).not.toContain(identityType);
    expect(workerSource('production')).not.toContain('/__test/pwa-activation/');
  });

  it('arms an exclusive D lease only at the exact validated pre-release transition', () => {
    const token = 'activation_barrier_token_1234';
    const wrongOwner = generatedTestPwaWorkerLease();
    expect(wrongOwner.arm(
      'activation_barrier_token_5678',
      testPwaWorkerBarrierFixture(token)
    )).toBeNull();
    const harness = generatedTestPwaWorkerLease();
    const barrier = testPwaWorkerBarrierFixture(token);
    const lease = harness.arm(token, barrier);

    expect(lease).toMatchObject({
      activationBarrierToken: token,
      token,
      variant: 'D',
      workerBuildNonce: 'worker_build_nonce_d'
    });
    const dRequest = harness.request(
      new Map([['unrelated_cookie', 'allowed']]),
      new Map([[token, barrier]])
    );
    expect(dRequest).toEqual({
      activationBarrierToken: token,
      kind: 'worker',
      variant: 'D',
      workerBuildNonce: 'worker_build_nonce_d'
    });
    expect(generatedTestWorkerSource(
      dRequest?.variant,
      dRequest?.activationBarrierToken,
      dRequest?.workerBuildNonce
    )).toBe(generatedTestWorkerSource('D', token, 'worker_build_nonce_d'));

    const secondToken = 'activation_barrier_token_5678';
    expect(harness.arm(secondToken, testPwaWorkerBarrierFixture(secondToken))).toBeNull();
    expect(harness.current()).toMatchObject({ token, variant: 'D' });
  });

  it.each([
    ['poisoned', (barrier: TestPwaWorkerBarrier) => { barrier.poisoned = true; }],
    ['unstarted', (barrier: TestPwaWorkerBarrier) => { barrier.deadlineAt = null; }],
    ['incomplete step', (barrier: TestPwaWorkerBarrier) => { barrier.step = 4; }],
    ['incomplete arrivals', (barrier: TestPwaWorkerBarrier) => { barrier.arrivals.pop(); }],
    ['incomplete releases', (barrier: TestPwaWorkerBarrier) => { barrier.releases.pop(); }],
    ['premature D release', (barrier: TestPwaWorkerBarrier) => {
      const worker = barrier.workers.get('D');
      if (worker) worker.released = true;
    }],
    ['mismatched D nonce', (barrier: TestPwaWorkerBarrier) => {
      const worker = barrier.workers.get('D');
      if (worker) worker.buildNonce = 'unexpected_build_nonce_d';
    }]
  ])('rejects %s activation state before arming D', (_label, mutate) => {
    const token = 'activation_barrier_token_1234';
    const barrier = testPwaWorkerBarrierFixture(token);
    mutate(barrier);
    const harness = generatedTestPwaWorkerLease();
    expect(harness.arm(token, barrier)).toBeNull();
    expect(harness.current()).toBeNull();
  });

  it('switches D to distinct E before requests and keeps both cookieless sources byte-identical', () => {
    const token = 'activation_barrier_token_1234';
    const harness = generatedTestPwaWorkerLease();
    harness.arm(token, testPwaWorkerBarrierFixture(token));
    const dRequest = harness.request(new Map());
    expect(dRequest).toMatchObject({ variant: 'D', workerBuildNonce: 'worker_build_nonce_d' });
    expect(generatedTestWorkerSource(
      dRequest?.variant,
      dRequest?.activationBarrierToken,
      dRequest?.workerBuildNonce
    )).toBe(generatedTestWorkerSource('D', token, 'worker_build_nonce_d'));

    // The activation barrier may already have reached its 7.5s expiry; its
    // independently owned lease remains sufficient for the D-to-E handoff.
    const lease = harness.switchToE(token, 'worker_build_nonce_e', null);
    expect(lease).toMatchObject({ token, variant: 'E', workerBuildNonce: 'worker_build_nonce_e' });
    const eRequest = harness.request(new Map());
    expect(eRequest).toEqual({
      activationBarrierToken: token,
      kind: 'worker',
      variant: 'E',
      workerBuildNonce: 'worker_build_nonce_e'
    });
    expect(generatedTestWorkerSource(
      eRequest?.variant,
      eRequest?.activationBarrierToken,
      eRequest?.workerBuildNonce
    )).toBe(generatedTestWorkerSource('E', token, 'worker_build_nonce_e'));
    expect(harness.switchToE(
      token,
      'worker_build_nonce_e',
      testPwaWorkerBarrierFixture(token, 'after-d-release')
    )).toBe(lease);
    expect(harness.switchToE(token, 'worker_build_nonce_d')).toBeNull();
    expect(harness.switchToE('activation_barrier_token_5678', 'other_worker_nonce_e')).toBeNull();
    expect(harness.clear(token)).toBe(true);
    expect(harness.request(new Map())).toBeNull();
  });

  it.each([
    ['poisoned', (barrier: TestPwaWorkerBarrier) => { barrier.poisoned = true; }],
    ['incomplete', (barrier: TestPwaWorkerBarrier) => { barrier.step = 5; }],
    ['unreleased D', (barrier: TestPwaWorkerBarrier) => {
      const worker = barrier.workers.get('D');
      if (worker) worker.released = false;
    }],
    ['mismatched D identity', (barrier: TestPwaWorkerBarrier) => {
      const worker = barrier.workers.get('D');
      if (worker) worker.buildNonce = 'unexpected_build_nonce_d';
    }]
  ])('rejects an E switch against a %s barrier', (_label, mutate) => {
    const token = 'activation_barrier_token_1234';
    const harness = generatedTestPwaWorkerLease();
    harness.arm(token, testPwaWorkerBarrierFixture(token));
    const barrier = testPwaWorkerBarrierFixture(token, 'after-d-release');
    mutate(barrier);
    expect(harness.switchToE(token, 'worker_build_nonce_e', barrier)).toBeNull();
    expect(harness.current()).toBeNull();
  });

  it('fails closed for partial, invalid, and lease-mismatched routing tuples', () => {
    const token = 'activation_barrier_token_1234';
    const noLease = generatedTestPwaWorkerLease();
    expect(noLease.request(new Map())).toBeNull();
    expect(noLease.request(new Map([
      ['skyjo_sw_test_variant', 'A'],
      ['skyjo_sw_test_worker_nonce', 'worker_build_nonce_a']
    ]))).toEqual({
      activationBarrierToken: null,
      kind: 'worker',
      variant: 'A',
      workerBuildNonce: 'worker_build_nonce_a'
    });
    expect(noLease.request(new Map([['skyjo_sw_test_variant', 'A']]))).toEqual({ kind: 'error', status: 400 });

    const harness = generatedTestPwaWorkerLease();
    harness.arm(token, testPwaWorkerBarrierFixture(token));
    expect(harness.request(new Map([
      ['skyjo_sw_test_variant', 'D'],
      ['skyjo_sw_test_worker_nonce', 'worker_build_nonce_d']
    ]))).toEqual({ kind: 'error', status: 409 });
    expect(harness.request(new Map([
      ['skyjo_sw_test_variant', 'E'],
      ['skyjo_sw_test_activation_barrier', token],
      ['skyjo_sw_test_worker_nonce', 'worker_build_nonce_e']
    ]))).toEqual({ kind: 'error', status: 409 });
  });

  it('fails cookieless routing closed until every pre-lease barrier is cleaned up', () => {
    const token = 'activation_barrier_token_1234';
    const harness = generatedTestPwaWorkerLease();
    const barrier = testPwaWorkerBarrierFixture(token);
    const barriers = new Map<string, unknown>([[token, barrier]]);

    expect(harness.request(new Map(), barriers)).toEqual({ kind: 'error', status: 409 });
    expect(harness.request(new Map([
      ['skyjo_sw_test_variant', 'A'],
      ['skyjo_sw_test_worker_nonce', 'worker_build_nonce_a']
    ]), barriers)).toEqual({
      activationBarrierToken: null,
      kind: 'worker',
      variant: 'A',
      workerBuildNonce: 'worker_build_nonce_a'
    });
    barrier.poisoned = true;
    expect(harness.request(new Map(), barriers)).toEqual({ kind: 'error', status: 409 });
    barriers.set('activation_barrier_token_5678', testPwaWorkerBarrierFixture(
      'activation_barrier_token_5678'
    ));
    expect(harness.request(new Map(), barriers)).toEqual({ kind: 'error', status: 409 });

    barriers.clear();
    expect(harness.request(new Map(), barriers)).toBeNull();
  });

  it('clears leases idempotently by owner or independent expiry', () => {
    const token = 'activation_barrier_token_1234';
    const harness = generatedTestPwaWorkerLease();
    harness.arm(token, testPwaWorkerBarrierFixture(token));
    expect(harness.clear('activation_barrier_token_5678')).toBe(false);
    expect(harness.clear(token)).toBe(true);
    expect(harness.clear(token)).toBe(false);

    harness.arm(token, testPwaWorkerBarrierFixture(token));
    const expiry = harness.timers.at(-1);
    expect(expiry?.delay).toBe(30_000);
    expiry?.callback();
    expect(harness.current()).toBeNull();
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

  it.each(workerSourceKinds)(
    '%s worker returns its durable build identity through the versioned null-source port contract',
    async (kind) => {
      const requestId = 'request-123';
      const fixture = buildIdentityFixture(kind);
      for (const source of [null, { id: 'same-origin-client' }]) {
        const postMessage = vi.fn();
        const close = vi.fn();
        const { handler } = loadMessageHandler(kind, { source: fixture.source });
        await dispatchMessage(handler, {
          data: { type: buildIdentityRequestType, version: 1, requestId },
          origin: appOrigin,
          ports: [{ close, postMessage }],
          source
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({
          type: buildIdentityResponseType,
          version: 1,
          requestId,
          buildId: fixture.buildId
        });
        expect(close).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each(workerSourceKinds)(
    '%s worker rejects malformed, unversioned, cross-origin, and non-single-port build identity requests',
    async (kind) => {
      const fixture = buildIdentityFixture(kind);
      const invalidRequests = [
        { data: { type: buildIdentityRequestType, version: 1, requestId: 'request-123' }, origin: '' },
        {
          data: { type: buildIdentityRequestType, version: 1, requestId: 'request-123' },
          origin: 'https://attacker.example'
        },
        { data: { type: buildIdentityRequestType, version: 2, requestId: 'request-123' }, origin: appOrigin },
        { data: { type: buildIdentityRequestType, version: 1 }, origin: appOrigin },
        { data: { type: buildIdentityRequestType, version: 1, requestId: 'x' }, origin: appOrigin }
      ];

      for (const request of invalidRequests) {
        const postMessage = vi.fn();
        const close = vi.fn();
        const { handler } = loadMessageHandler(kind, { source: fixture.source });
        await dispatchMessage(handler, {
          ...request,
          ports: [{ close, postMessage }],
          source: null
        });
        expect(postMessage).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      }

      for (const ports of [[], [
        { close: vi.fn(), postMessage: vi.fn() },
        { close: vi.fn(), postMessage: vi.fn() }
      ]]) {
        const { handler } = loadMessageHandler(kind, { source: fixture.source });
        await dispatchMessage(handler, {
          data: { type: buildIdentityRequestType, version: 1, requestId: 'request-123' },
          origin: appOrigin,
          ports,
          source: null
        });
        for (const port of ports) {
          expect(port.postMessage).not.toHaveBeenCalled();
          expect(port.close).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('derives generated worker build identity only from the stable build nonce', async () => {
    const nonce = 'stable_build_nonce';
    const first = buildIdentityFixture('generated', nonce);
    const repeated = buildIdentityFixture('generated', nonce);
    const changed = buildIdentityFixture('generated', 'changed_build_nonce');

    expect(repeated.buildId).toBe(first.buildId);
    expect(changed.buildId).not.toBe(first.buildId);
    expect(first.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.source).toContain(`const workerBuildId=${JSON.stringify(first.buildId)};`);

    const responses: unknown[] = [];
    for (const fixture of [first, repeated, changed]) {
      const { handler } = loadMessageHandler('generated', { source: fixture.source });
      await dispatchMessage(handler, {
        data: { type: buildIdentityRequestType, version: 1, requestId: 'request-456' },
        origin: appOrigin,
        ports: [{ close: vi.fn(), postMessage: vi.fn((value) => responses.push(value)) }],
        source: null
      });
    }
    expect(responses).toEqual([
      expect.objectContaining({ buildId: first.buildId }),
      expect.objectContaining({ buildId: first.buildId }),
      expect.objectContaining({ buildId: changed.buildId })
    ]);
    expect(responses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceNonce: expect.anything() })
    ]));
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
