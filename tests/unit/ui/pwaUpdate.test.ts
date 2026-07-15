type IdentityBehavior = 'valid' | 'malformed' | 'silent' | 'throw' | 'deferred';

class MemoryMessagePort extends EventTarget {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  private closed = false;
  peer: MemoryMessagePort | null = null;

  postMessage(data: unknown) {
    const recipient = this.peer;
    queueMicrotask(() => {
      if (!recipient || recipient.closed) return;
      const event = new MessageEvent('message', { data });
      recipient.onmessage?.(event);
      recipient.dispatchEvent(event);
    });
  }

  start() {}

  close() {
    this.closed = true;
  }
}

class MemoryMessageChannel {
  readonly port1 = new MemoryMessagePort();
  readonly port2 = new MemoryMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

let fakeBuildSequence = 0;

function nextFakeBuildId() {
  fakeBuildSequence += 1;
  return fakeBuildSequence.toString(16).padStart(64, '0');
}

class FakeWorker extends EventTarget {
  readonly buildId: string;
  identityBehavior: IdentityBehavior = 'valid';
  identityPostCalls = 0;
  identityReplyCalls = 0;
  readonly deferredIdentityReplies: Array<() => void> = [];
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];
  postCalls = 0;
  postFailuresRemaining = 0;
  throwOnPost = false;

  constructor(state: ServiceWorkerState, buildId = nextFakeBuildId()) {
    super();
    this.state = state;
    this.buildId = buildId;
  }

  postMessage(message: unknown, transfer?: Transferable[]) {
    const value = message as { type?: unknown; version?: unknown; requestId?: unknown } | null;
    if (value?.type === 'SKYJO_GET_BUILD_ID') {
      this.identityPostCalls += 1;
      const port = transfer?.[0] as MessagePort | undefined;
      if (this.identityBehavior === 'throw') {
        port?.close();
        throw new Error('identity postMessage failed');
      }
      if (this.identityBehavior === 'silent') {
        port?.close();
        return;
      }
      if (!port) return;
      const reply = () => {
        this.identityReplyCalls += 1;
        try {
          port.postMessage(this.identityBehavior === 'malformed'
            ? { type: 'SKYJO_BUILD_ID', version: 1, requestId: value.requestId, buildId: 'invalid' }
            : {
                type: 'SKYJO_BUILD_ID',
                version: value.version,
                requestId: value.requestId,
                buildId: this.buildId
              });
        } finally {
          port.close();
        }
      };
      if (this.identityBehavior === 'deferred') this.deferredIdentityReplies.push(reply);
      else queueMicrotask(reply);
      return;
    }
    this.postCalls += 1;
    if (this.throwOnPost || this.postFailuresRemaining > 0) {
      if (this.postFailuresRemaining > 0) this.postFailuresRemaining -= 1;
      throw new Error('postMessage failed');
    }
    this.messages.push(message);
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  releaseIdentity() {
    this.deferredIdentityReplies.shift()?.();
  }
}

class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  readonly update = vi.fn(async () => this);
}

class FakeServiceWorkerContainer extends EventTarget {
  readonly registration: FakeRegistration;
  private controllerValue: FakeWorker | null = null;
  readonly register: ReturnType<typeof vi.fn>;

  constructor(registration: FakeRegistration, controller: FakeWorker | null = new FakeWorker('activated')) {
    super();
    this.registration = registration;
    this.controller = controller;
    this.register = vi.fn(async () => registration);
  }

  get controller() {
    return this.controllerValue;
  }

  set controller(worker: FakeWorker | null) {
    this.controllerValue = worker;
    this.registration.active = worker;
  }
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker');
const originalMessageChannel = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');

beforeEach(() => {
  Object.defineProperty(globalThis, 'MessageChannel', {
    configurable: true,
    value: MemoryMessageChannel,
    writable: true
  });
});

function installContainer(container: FakeServiceWorkerContainer) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container
  });
}

async function beginRegistration(container: FakeServiceWorkerContainer, reload = vi.fn()) {
  installContainer(container);
  const module = await import('../../../src/pwaUpdate');
  module.registerPwaUpdates(reload);
  window.dispatchEvent(new Event('load'));
  await vi.waitFor(() => expect(container.register).toHaveBeenCalledTimes(1));
  const registration = container.registration;
  const candidate = registration.waiting?.state === 'installed'
    ? registration.waiting
    : registration.installing?.state === 'installed'
      ? registration.installing
      : null;
  const active = registration.active;
  if (
    candidate &&
    active &&
    active === container.controller &&
    candidate.identityBehavior === 'valid' &&
    active.identityBehavior === 'valid'
  ) {
    await vi.waitFor(() => expect(candidate.identityPostCalls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(candidate.identityReplyCalls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(module.getPwaUpdateSnapshot().available).toBe(candidate.buildId !== active.buildId));
  }
  return module;
}

afterEach(() => {
  fakeBuildSequence = 0;
  vi.resetModules();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalServiceWorker) Object.defineProperty(Navigator.prototype, 'serviceWorker', originalServiceWorker);
  Reflect.deleteProperty(globalThis, 'MessageChannel');
  if (originalMessageChannel) Object.defineProperty(globalThis, 'MessageChannel', originalMessageChannel);
});

describe('PWA update coordination', () => {
  it('suppresses an installed wrapper with the same durable build ID as the active controller', async () => {
    const buildId = 'd'.repeat(64);
    const registration = new FakeRegistration();
    const active = new FakeWorker('activated', buildId);
    const equivalentWaiting = new FakeWorker('installed', buildId);
    registration.waiting = equivalentWaiting;
    const container = new FakeServiceWorkerContainer(registration, active);
    const module = await beginRegistration(container);

    expect(active).not.toBe(equivalentWaiting);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: false,
      activating: false,
      reloadRequired: false
    });
    expect(module.activatePwaUpdate()).toBe(false);
    expect(equivalentWaiting.messages).toEqual([]);
    expect(registration.waiting).toBe(equivalentWaiting);
  });

  it.each([
    ['malformed response', 'malformed'],
    ['identity timeout', 'silent'],
    ['postMessage error', 'throw']
  ] as const)('fails %s closed and shows the installed update', async (_label, behavior) => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed', 'e'.repeat(64));
    waiting.identityBehavior = behavior;
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(
      registration,
      new FakeWorker('activated', 'd'.repeat(64))
    );
    const module = await beginRegistration(container);

    await vi.waitFor(() => {
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
    }, { timeout: 2_000 });
    expect(waiting.identityPostCalls).toBe(1);
    expect(waiting.messages).toEqual([]);
  });

  it('ignores a late same-build D classification after a distinct E waiter replaces it', async () => {
    const activeBuildId = 'd'.repeat(64);
    const registration = new FakeRegistration();
    const active = new FakeWorker('activated', activeBuildId);
    const staleD = new FakeWorker('installed', activeBuildId);
    staleD.identityBehavior = 'deferred';
    registration.waiting = staleD;
    const container = new FakeServiceWorkerContainer(registration, active);
    const module = await beginRegistration(container);
    await vi.waitFor(() => expect(staleD.identityPostCalls).toBe(1));

    const replacementE = new FakeWorker('installed', 'e'.repeat(64));
    registration.waiting = replacementE;
    staleD.transition('redundant');
    staleD.releaseIdentity();
    await vi.waitFor(() => expect(module.getPwaUpdateSnapshot().available).toBe(true));
    expect(replacementE.identityPostCalls).toBe(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
    });
    expect(registration.waiting).toBe(replacementE);
    expect(replacementE.messages).toEqual([]);
  });

  it('fails a persistent active/controller mismatch closed without requeueing identity work', async () => {
    const registration = new FakeRegistration();
    const controller = new FakeWorker('activated', 'c'.repeat(64));
    const mismatchedActive = new FakeWorker('activated', 'a'.repeat(64));
    const waiting = new FakeWorker('installed', 'e'.repeat(64));
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration, controller);
    registration.active = mismatchedActive;
    const module = await beginRegistration(container);

    await vi.waitFor(() => expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(waiting.identityPostCalls).toBe(0);
    expect(mismatchedActive.identityPostCalls).toBe(0);
    expect(waiting.messages).toEqual([]);
  });

  it('waits for the exact activating controller before reloading exactly once', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    waiting.transition('activating');
    registration.waiting = null;
    container.controller = waiting;
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: true,
      reloadRequired: false
    });

    waiting.transition('activated');
    waiting.dispatchEvent(new Event('statechange'));
    container.dispatchEvent(new Event('controllerchange'));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it('refreshes delayed registration state before authorizing the second quiet-window reload', async () => {
    const registration = new FakeRegistration();
    const baseline = new FakeWorker('activated');
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration, baseline);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    registration.update.mockImplementationOnce(async () => {
      registration.active = waiting;
      return registration;
    });

    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      registration.active = baseline;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');

      await vi.advanceTimersByTimeAsync(249);
      expect(registration.update).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(registration.active).toBe(waiting);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(249);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a cross-tab prompt only after the exact controller activates', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    const changes = vi.fn();
    module.subscribeToPwaUpdates(changes);

    const controller = new FakeWorker('activating');
    container.controller = controller;
    container.dispatchEvent(new Event('controllerchange'));
    expect(changes).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(false);

    controller.transition('activated');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });
  });

  it('ends an expired attempt non-actionably and prompts only after passive terminal activation', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));

      await vi.advanceTimersByTimeAsync(8_001);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: false,
        activating: false,
        reloadRequired: false
      });
      expect(reload).not.toHaveBeenCalled();

      waiting.transition('activated');
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale and redundant controllers', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    const changes = vi.fn();
    module.subscribeToPwaUpdates(changes);

    const stale = new FakeWorker('activating');
    container.controller = stale;
    container.dispatchEvent(new Event('controllerchange'));
    const redundant = new FakeWorker('redundant');
    container.controller = redundant;
    container.dispatchEvent(new Event('controllerchange'));
    stale.transition('activated');

    expect(changes).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: false,
      activating: false,
      reloadRequired: false
    });
  });

  it('keeps the first uncontrolled claim silent until and after terminal activation', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration, null);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    const changes = vi.fn();
    module.subscribeToPwaUpdates(changes);

    const firstController = new FakeWorker('activating');
    container.controller = firstController;
    container.dispatchEvent(new Event('controllerchange'));
    expect(changes).not.toHaveBeenCalled();
    firstController.transition('activated');

    expect(changes).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: false,
      activating: false,
      reloadRequired: false
    });
  });

  it('defers an own activation that reaches a protected route before terminal activation', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    waiting.transition('activating');
    registration.waiting = null;
    container.controller = waiting;
    container.dispatchEvent(new Event('controllerchange'));
    window.history.pushState(null, '', '/single-player');
    waiting.transition('activated');

    expect(reload).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });
    });
  });

  it('never authorizes an unrelated controller with an own activation attempt', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    const unrelated = new FakeWorker('activating');
    container.controller = unrelated;
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(false);
    unrelated.transition('activated');

    expect(reload).not.toHaveBeenCalled();
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });
  });

  it('keeps the absolute deadline armed when an external controller interrupts terminal quiet', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');

      const external = new FakeWorker('activating');
      container.controller = external;
      container.dispatchEvent(new Event('controllerchange'));
      await vi.advanceTimersByTimeAsync(250);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);

      await vi.advanceTimersByTimeAsync(7_750);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: false,
        activating: false,
        reloadRequired: false
      });

      const promptChanges = vi.fn();
      module.subscribeToPwaUpdates(promptChanges);
      external.transition('activated');
      expect(reload).not.toHaveBeenCalled();
      expect(promptChanges).toHaveBeenCalledTimes(1);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });

      external.dispatchEvent(new Event('statechange'));
      container.dispatchEvent(new Event('controllerchange'));
      expect(promptChanges).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale timer callbacks and owns exactly one live timer until the attempt clears', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    const callbacks = new Map<number, () => void>();
    const liveTimers = new Set<number>();
    let nextTimer = 100;
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      const timer = ++nextTimer;
      callbacks.set(timer, typeof handler === 'function' ? () => handler() : () => undefined);
      liveTimers.add(timer);
      return timer;
    }) as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation((timer) => {
      if (typeof timer === 'number') liveTimers.delete(timer);
    });

    expect(module.activatePwaUpdate()).toBe(true);
    const [absoluteDeadline] = [...liveTimers];
    expect(liveTimers.size).toBe(1);

    waiting.transition('activating');
    registration.waiting = null;
    container.controller = waiting;
    container.dispatchEvent(new Event('controllerchange'));
    waiting.transition('activated');
    const [quietTimer] = [...liveTimers];
    expect(liveTimers.size).toBe(1);
    expect(quietTimer).not.toBe(absoluteDeadline);

    const successor = new FakeWorker('installing');
    registration.installing = successor;
    registration.dispatchEvent(new Event('updatefound'));
    const [rescheduledDeadline] = [...liveTimers];
    expect(liveTimers.size).toBe(1);
    expect(rescheduledDeadline).not.toBe(quietTimer);

    const staleTimers = [...callbacks.keys()].filter((timer) => !liveTimers.has(timer));
    const schedulesBeforeStaleCallbacks = setTimeoutSpy.mock.calls.length;
    for (const timer of staleTimers) callbacks.get(timer)?.();
    expect(liveTimers).toEqual(new Set([rescheduledDeadline]));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(schedulesBeforeStaleCallbacks);
    expect(module.getPwaUpdateSnapshot().activating).toBe(true);

    const external = new FakeWorker('activated');
    container.controller = external;
    container.dispatchEvent(new Event('controllerchange'));
    expect(liveTimers.size).toBe(0);
    expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(true);

    callbacks.get(rescheduledDeadline)?.();
    expect(liveTimers.size).toBe(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(schedulesBeforeStaleCallbacks);
  });

  it('preserves the original deadline when activation transfers once', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      await vi.advanceTimersByTimeAsync(7_000);
      const replacement = new FakeWorker('installed');
      registration.waiting = replacement;
      first.transition('redundant');
      expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);

      replacement.transition('activating');
      registration.waiting = null;
      container.controller = replacement;
      container.dispatchEvent(new Event('controllerchange'));
      await vi.advanceTimersByTimeAsync(1_001);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: false,
        activating: false,
        reloadRequired: false
      });

      replacement.transition('activated');
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains one distinct installed waiter before reloading after the first target activates', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    expect(first.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    first.transition('activating');
    const replacement = new FakeWorker('installed');
    registration.waiting = replacement;
    container.controller = first;
    container.dispatchEvent(new Event('controllerchange'));
    first.transition('activated');

    expect(reload).not.toHaveBeenCalled();
    expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    expect(module.getPwaUpdateSnapshot().activating).toBe(true);

    replacement.transition('activating');
    registration.waiting = null;
    container.controller = replacement;
    container.dispatchEvent(new Event('controllerchange'));
    replacement.transition('activated');
    replacement.dispatchEvent(new Event('statechange'));
    container.dispatchEvent(new Event('controllerchange'));

    expect(first.messages).toHaveLength(1);
    expect(replacement.messages).toHaveLength(1);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('drains every distinct installed successor before reloading exactly once', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    first.transition('activating');
    const replacement = new FakeWorker('installed');
    registration.waiting = replacement;
    container.controller = first;
    container.dispatchEvent(new Event('controllerchange'));
    first.transition('activated');
    expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);

    replacement.transition('activating');
    const secondReplacement = new FakeWorker('installed');
    registration.waiting = secondReplacement;
    container.controller = replacement;
    container.dispatchEvent(new Event('controllerchange'));
    replacement.transition('activated');

    expect(reload).not.toHaveBeenCalled();
    expect(secondReplacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    expect(module.getPwaUpdateSnapshot().activating).toBe(true);

    secondReplacement.transition('activating');
    registration.waiting = null;
    container.controller = secondReplacement;
    container.dispatchEvent(new Event('controllerchange'));
    secondReplacement.transition('activated');
    secondReplacement.dispatchEvent(new Event('statechange'));
    container.dispatchEvent(new Event('controllerchange'));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(first.messages).toHaveLength(1);
    expect(replacement.messages).toHaveLength(1);
    expect(secondReplacement.messages).toHaveLength(1);
  });

  it('re-enters settlement when updatefound arrives after terminal but before quiet settlement', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      first.transition('activating');
      registration.waiting = null;
      container.controller = first;
      container.dispatchEvent(new Event('controllerchange'));
      first.transition('activated');

      await vi.advanceTimersByTimeAsync(249);
      expect(reload).not.toHaveBeenCalled();
      const successor = new FakeWorker('installing');
      registration.installing = successor;
      registration.dispatchEvent(new Event('updatefound'));
      registration.installing = null;
      registration.waiting = successor;
      successor.transition('installed');

      expect(successor.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);

      successor.transition('activating');
      registration.waiting = null;
      container.controller = successor;
      container.dispatchEvent(new Event('controllerchange'));
      successor.transition('activated');

      await vi.advanceTimersByTimeAsync(249);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(249);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds settlement while a distinct successor activates externally before taking control', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      first.transition('activating');
      registration.waiting = null;
      container.controller = first;
      container.dispatchEvent(new Event('controllerchange'));
      first.transition('activated');

      const successor = new FakeWorker('installing');
      registration.installing = successor;
      registration.dispatchEvent(new Event('updatefound'));
      registration.installing = null;
      successor.transition('installed');
      successor.transition('activating');

      await vi.advanceTimersByTimeAsync(500);
      expect(container.controller).toBe(first);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);

      successor.transition('activated');
      await vi.advanceTimersByTimeAsync(500);
      expect(container.controller).toBe(first);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);

      container.controller = successor;
      container.dispatchEvent(new Event('controllerchange'));
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the absolute deadline win over late successor activity and keeps it retryable', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      await vi.advanceTimersByTimeAsync(7_800);
      registration.waiting = null;
      first.transition('redundant');
      await vi.advanceTimersByTimeAsync(199);

      const successor = new FakeWorker('installing');
      registration.installing = successor;
      registration.dispatchEvent(new Event('updatefound'));
      await vi.advanceTimersByTimeAsync(1);

      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: false,
        activating: false,
        reloadRequired: false
      });

      registration.installing = null;
      registration.waiting = successor;
      successor.transition('installed');
      expect(successor.messages).toEqual([]);
      await vi.waitFor(() => {
        expect(module.getPwaUpdateSnapshot()).toEqual({
          available: true,
          activating: false,
          reloadRequired: false
        });
      });
      expect(module.activatePwaUpdate()).toBe(true);
      expect(successor.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an activated-target replacement actionable at the exact original deadline', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      first.transition('activating');
      const replacement = new FakeWorker('installed');
      registration.waiting = replacement;
      container.controller = first;
      container.dispatchEvent(new Event('controllerchange'));
      vi.setSystemTime(Date.now() + 8_000);
      first.transition('activated');

      expect(reload).not.toHaveBeenCalled();
      expect(replacement.messages).toEqual([]);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
      expect(module.activatePwaUpdate()).toBe(true);
      expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a worker that was already installing before the updatefound listener was attached', async () => {
    const registration = new FakeRegistration();
    const installing = new FakeWorker('installing');
    registration.installing = installing;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    installing.transition('installed');
    await vi.waitFor(() => {
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
    });
  });

  it('observes a future updatefound worker and classifies protected paths conservatively', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    const future = new FakeWorker('installing');
    registration.installing = future;
    registration.dispatchEvent(new Event('updatefound'));
    future.transition('installed');
    await vi.waitFor(() => expect(module.getPwaUpdateSnapshot().available).toBe(true));
    expect(module.isPwaUpdateDeferredPath('/single-player')).toBe(true);
    expect(module.isPwaUpdateDeferredPath('/lobby')).toBe(true);
    expect(module.isPwaUpdateDeferredPath('/')).toBe(false);
    expect(module.isPwaUpdateDeferredPath('/account')).toBe(false);
  });

  it('drains multiple distinct successors when superseded targets become redundant', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    expect(module.activatePwaUpdate()).toBe(true);
    expect(first.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    const replacement = new FakeWorker('installed');
    registration.waiting = replacement;
    first.transition('redundant');
    expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    expect(module.getPwaUpdateSnapshot().activating).toBe(true);

    const secondReplacement = new FakeWorker('installed');
    registration.waiting = secondReplacement;
    replacement.transition('redundant');
    expect(secondReplacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: true,
      reloadRequired: false
    });
  });

  it('does not repost the same installed target when its state is observed repeatedly', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    expect(module.activatePwaUpdate()).toBe(true);
    waiting.dispatchEvent(new Event('statechange'));
    waiting.dispatchEvent(new Event('statechange'));

    expect(waiting.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    expect(module.getPwaUpdateSnapshot().activating).toBe(true);
  });

  it('fails closed under an adversarial cycle back to an earlier target identity', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    // ServiceWorker states are monotonic in browsers. Deliberately resurrecting
    // this fake exercises cycle defense if a buggy wrapper ever re-exposes an
    // earlier identity as an installed waiter.
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);

    expect(module.activatePwaUpdate()).toBe(true);
    const second = new FakeWorker('installed');
    registration.waiting = second;
    first.transition('redundant');
    expect(second.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);

    registration.waiting = first;
    first.transition('installed');
    second.transition('redundant');

    expect(reload).not.toHaveBeenCalled();
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
    });
    expect(module.activatePwaUpdate()).toBe(true);
    expect(first.messages).toHaveLength(2);
  });

  it('does not transfer at the exact original deadline and leaves the replacement retryable', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    registration.waiting = first;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      first.transition('activating');
      const replacement = new FakeWorker('installed');
      registration.waiting = replacement;
      vi.setSystemTime(Date.now() + 8_000);
      first.transition('redundant');
      expect(replacement.messages).toEqual([]);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
      expect(module.activatePwaUpdate()).toBe(true);
      expect(replacement.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a cross-tab reload-required prompt when redundant and controller events race', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    container.controller = new FakeWorker('activated');
    container.dispatchEvent(new Event('controllerchange'));
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });
    registration.waiting = null;
    waiting.transition('redundant');
    container.dispatchEvent(new Event('controllerchange'));
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });
  });

  it('keeps a cross-tab reload prompt through a later installed and redundant waiter', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    container.controller = new FakeWorker('activated');
    container.dispatchEvent(new Event('controllerchange'));
    expect(module.getPwaUpdateSnapshot().reloadRequired).toBe(true);

    const later = new FakeWorker('installing');
    registration.installing = later;
    registration.dispatchEvent(new Event('updatefound'));
    later.transition('installed');
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });

    registration.installing = null;
    registration.waiting = null;
    later.transition('redundant');
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
    });
  });

  it('fails a missing waiter closed and retries a transient post once without re-enabling the action', async () => {
    const registration = new FakeRegistration();
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    expect(module.activatePwaUpdate()).toBe(false);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: false,
      activating: false,
      reloadRequired: false
    });

    const throwing = new FakeWorker('installed');
    throwing.postFailuresRemaining = 1;
    registration.waiting = throwing;
    registration.installing = throwing;
    registration.dispatchEvent(new Event('updatefound'));
    throwing.dispatchEvent(new Event('statechange'));
    await vi.waitFor(() => expect(module.getPwaUpdateSnapshot().available).toBe(true));
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      expect(throwing.postCalls).toBe(1);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: true,
        reloadRequired: false
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(throwing.messages).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(throwing.postCalls).toBe(2);
      expect(throwing.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps activation posting at one retry per target and preserves the waiter for manual retry', async () => {
    const registration = new FakeRegistration();
    const throwing = new FakeWorker('installed');
    throwing.throwOnPost = true;
    registration.waiting = throwing;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      expect(throwing.postCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(throwing.postCalls).toBe(2);
      expect(throwing.messages).toHaveLength(0);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
      throwing.throwOnPost = false;
      expect(module.activatePwaUpdate()).toBe(true);
      expect(throwing.postCalls).toBe(3);
      expect(throwing.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a rejected terminal registration refresh closed without retrying or auto-reloading', async () => {
    const registration = new FakeRegistration();
    registration.update.mockRejectedValueOnce(new Error('transient update failure'));
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');
      await vi.advanceTimersByTimeAsync(250);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never repeats terminal refresh when a stale self waiter survives the second quiet window', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    registration.update.mockImplementationOnce(async () => {
      registration.waiting = waiting;
      return registration;
    });
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');

      await vi.advanceTimersByTimeAsync(499);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registration.update).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the original deadline fail closed when terminal registration refresh never settles', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    registration.update.mockImplementationOnce(() => new Promise<FakeRegistration>(() => {}));
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');

      await vi.advanceTimersByTimeAsync(7_999);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains a waiter revealed by the terminal refresh before the second quiet confirmation', async () => {
    const registration = new FakeRegistration();
    const first = new FakeWorker('installed');
    const successor = new FakeWorker('installed');
    registration.waiting = first;
    registration.update.mockImplementationOnce(async () => {
      registration.waiting = successor;
      return registration;
    });
    const container = new FakeServiceWorkerContainer(registration);
    const reload = vi.fn();
    const module = await beginRegistration(container, reload);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      first.transition('activating');
      registration.waiting = null;
      container.controller = first;
      container.dispatchEvent(new Event('controllerchange'));
      first.transition('activated');

      await vi.advanceTimersByTimeAsync(250);
      expect(successor.messages).toEqual([{ type: 'SKYJO_ACTIVATE_UPDATE' }]);
      expect(reload).not.toHaveBeenCalled();

      successor.transition('activating');
      registration.waiting = null;
      container.controller = successor;
      container.dispatchEvent(new Event('controllerchange'));
      successor.transition('activated');
      await vi.advanceTimersByTimeAsync(499);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(registration.update).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles target state before a queued post retry and never messages a terminal worker', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    waiting.postFailuresRemaining = 1;
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      waiting.transition('activating');
      registration.waiting = null;
      container.controller = waiting;
      container.dispatchEvent(new Event('controllerchange'));
      waiting.transition('activated');
      await vi.advanceTimersByTimeAsync(50);
      expect(waiting.messages).toHaveLength(0);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: true,
        reloadRequired: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers from an activation acknowledgement timeout and keeps the live waiter actionable', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);
    vi.useFakeTimers();
    try {
      expect(module.activatePwaUpdate()).toBe(true);
      expect(module.getPwaUpdateSnapshot().activating).toBe(true);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(module.getPwaUpdateSnapshot()).toEqual({
        available: true,
        activating: false,
        reloadRequired: false
      });
      expect(module.activatePwaUpdate()).toBe(true);
      expect(waiting.messages).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
