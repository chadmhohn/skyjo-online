class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];
  throwOnPost = false;

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  postMessage(message: unknown) {
    if (this.throwOnPost) throw new Error('postMessage failed');
    this.messages.push(message);
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: FakeWorker | null;
  readonly register: ReturnType<typeof vi.fn>;

  constructor(registration: FakeRegistration, controller: FakeWorker | null = new FakeWorker('activated')) {
    super();
    this.controller = controller;
    this.register = vi.fn(async () => registration);
  }
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker');

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
  return module;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalServiceWorker) Object.defineProperty(Navigator.prototype, 'serviceWorker', originalServiceWorker);
});

describe('PWA update coordination', () => {
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
    expect(reload).toHaveBeenCalledTimes(1);
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
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: true
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

  it('observes a worker that was already installing before the updatefound listener was attached', async () => {
    const registration = new FakeRegistration();
    const installing = new FakeWorker('installing');
    registration.installing = installing;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

    installing.transition('installed');
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
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
    expect(module.getPwaUpdateSnapshot().available).toBe(true);
    expect(module.isPwaUpdateDeferredPath('/single-player')).toBe(true);
    expect(module.isPwaUpdateDeferredPath('/lobby')).toBe(true);
    expect(module.isPwaUpdateDeferredPath('/')).toBe(false);
    expect(module.isPwaUpdateDeferredPath('/account')).toBe(false);
  });

  it('transfers activation to at most one superseding waiter', async () => {
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
    expect(secondReplacement.messages).toEqual([]);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
    });
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

  it('fails a missing or throwing waiter closed without leaving a false activating state', async () => {
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
    throwing.throwOnPost = true;
    registration.waiting = throwing;
    registration.installing = throwing;
    registration.dispatchEvent(new Event('updatefound'));
    throwing.dispatchEvent(new Event('statechange'));
    expect(module.activatePwaUpdate()).toBe(false);
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: true,
      activating: false,
      reloadRequired: false
    });
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
