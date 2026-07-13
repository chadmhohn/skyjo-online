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

async function beginRegistration(container: FakeServiceWorkerContainer) {
  installContainer(container);
  const module = await import('../../../src/pwaUpdate');
  module.registerPwaUpdates();
  window.dispatchEvent(new Event('load'));
  await vi.waitFor(() => expect(container.register).toHaveBeenCalledTimes(1));
  return module;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  if (originalServiceWorker) Object.defineProperty(Navigator.prototype, 'serviceWorker', originalServiceWorker);
});

describe('PWA update coordination', () => {
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

  it('transfers activation to a superseding waiter and clears immediately when no live waiter remains', async () => {
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

    registration.waiting = null;
    replacement.transition('redundant');
    expect(module.getPwaUpdateSnapshot()).toEqual({
      available: false,
      activating: false,
      reloadRequired: false
    });
  });

  it('preserves a cross-tab reload-required prompt when redundant and controller events race', async () => {
    const registration = new FakeRegistration();
    const waiting = new FakeWorker('installed');
    registration.waiting = waiting;
    const container = new FakeServiceWorkerContainer(registration);
    const module = await beginRegistration(container);

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
