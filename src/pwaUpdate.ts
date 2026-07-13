export type PwaUpdateSnapshot = Readonly<{
  available: boolean;
  activating: boolean;
  reloadRequired: boolean;
}>;

const listeners = new Set<() => void>();
let snapshot: PwaUpdateSnapshot = Object.freeze({ available: false, activating: false, reloadRequired: false });
let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let activationRequested = false;
let reloadStarted = false;
let registrationStarted = false;
let activationWatchdog: number | null = null;
let controllerKnown = false;

function publish(next: PwaUpdateSnapshot) {
  if (
    snapshot.available === next.available &&
    snapshot.activating === next.activating &&
    snapshot.reloadRequired === next.reloadRequired
  ) return;
  snapshot = Object.freeze(next);
  for (const listener of listeners) listener();
}

function rememberWaiting(worker: ServiceWorker | null) {
  if (!worker || worker.state === 'redundant') return;
  waitingWorker = worker;
  publish({ available: true, activating: activationRequested, reloadRequired: snapshot.reloadRequired });
}

function observeInstalling(worker: ServiceWorker | null) {
  if (!worker) return;
  const inspect = () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) rememberWaiting(worker);
    if (worker.state === 'redundant' && waitingWorker === worker) {
      const shouldTransferActivation = activationRequested;
      if (activationWatchdog !== null) window.clearTimeout(activationWatchdog);
      activationWatchdog = null;
      activationRequested = false;
      waitingWorker = null;
      if (snapshot.reloadRequired) return;
      const replacement = registration?.waiting || null;
      if (replacement && replacement.state !== 'redundant') {
        rememberWaiting(replacement);
        observeInstalling(replacement);
        if (shouldTransferActivation) activatePwaUpdate();
      }
      else publish({ available: false, activating: false, reloadRequired: false });
    }
  };
  inspect();
  worker.addEventListener('statechange', inspect);
}

function observeRegistration(nextRegistration: ServiceWorkerRegistration) {
  registration = nextRegistration;
  if (nextRegistration.waiting) {
    rememberWaiting(nextRegistration.waiting);
    observeInstalling(nextRegistration.waiting);
  }
  observeInstalling(nextRegistration.installing);
  nextRegistration.addEventListener('updatefound', () => observeInstalling(nextRegistration.installing));
}

function reloadOnce() {
  if (reloadStarted) return;
  reloadStarted = true;
  window.location.reload();
}

export function getPwaUpdateSnapshot(): PwaUpdateSnapshot {
  return snapshot;
}

export function subscribeToPwaUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerPwaUpdates(): void {
  if (registrationStarted || !('serviceWorker' in navigator)) return;
  registrationStarted = true;
  controllerKnown = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (activationWatchdog !== null) window.clearTimeout(activationWatchdog);
    activationWatchdog = null;
    waitingWorker = null;
    if (!controllerKnown && !activationRequested) {
      controllerKnown = true;
      return;
    }
    controllerKnown = true;
    if (activationRequested) {
      reloadOnce();
      return;
    }
    publish({ available: true, activating: false, reloadRequired: true });
  });
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(observeRegistration)
      .catch(() => undefined);
  }, { once: true });
}

export function activatePwaUpdate(): boolean {
  if (snapshot.reloadRequired) {
    reloadOnce();
    return true;
  }
  const liveWaiting = registration?.waiting || null;
  const worker = liveWaiting && liveWaiting.state !== 'redundant'
    ? liveWaiting
    : waitingWorker?.state === 'installed'
      ? waitingWorker
      : null;
  if (!worker || activationRequested) {
    if (!worker) {
      waitingWorker = null;
      publish({ available: false, activating: false, reloadRequired: false });
    }
    return false;
  }
  activationRequested = true;
  waitingWorker = worker;
  publish({ available: true, activating: true, reloadRequired: false });
  try {
    worker.postMessage({ type: 'SKYJO_ACTIVATE_UPDATE' });
  } catch {
    activationRequested = false;
    waitingWorker = null;
    publish({ available: Boolean(registration?.waiting), activating: false, reloadRequired: false });
    return false;
  }
  activationWatchdog = window.setTimeout(() => {
    if (!activationRequested || reloadStarted) return;
    activationRequested = false;
    const replacement = registration?.waiting || null;
    waitingWorker = replacement?.state === 'installed' ? replacement : null;
    publish({ available: Boolean(waitingWorker), activating: false, reloadRequired: false });
  }, 8_000);
  return true;
}

export function isPwaUpdateDeferredPath(pathname: string): boolean {
  return pathname === '/single-player' || pathname === '/lobby';
}
