export type PwaUpdateSnapshot = Readonly<{
  available: boolean;
  activating: boolean;
  reloadRequired: boolean;
}>;

type ActivationAttempt = {
  autoReloadEligible: boolean;
  baselineController: ServiceWorker | null;
  deadline: number;
  generation: number;
  target: ServiceWorker;
  targetStateChange: (() => void) | null;
  timeout: number | null;
  transferUsed: boolean;
};

type ControllerObservation =
  | { kind: 'initial' }
  | { kind: 'external' }
  | { kind: 'own'; generation: number };

const activationTimeoutMs = 8_000;
const listeners = new Set<() => void>();
let snapshot: PwaUpdateSnapshot = Object.freeze({ available: false, activating: false, reloadRequired: false });
let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let activationAttempt: ActivationAttempt | null = null;
let activationGeneration = 0;
let reloadStarted = false;
let registrationStarted = false;
let controllerKnown = false;
let knownController: ServiceWorker | null = null;
let observedController: ServiceWorker | null = null;
let observedControllerStateChange: (() => void) | null = null;
let reloadPage = () => window.location.reload();

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
  publish({ available: true, activating: Boolean(activationAttempt), reloadRequired: snapshot.reloadRequired });
}

function clearActivationAttempt() {
  const attempt = activationAttempt;
  if (!attempt) return;
  if (attempt.timeout !== null) window.clearTimeout(attempt.timeout);
  if (attempt.targetStateChange) attempt.target.removeEventListener('statechange', attempt.targetStateChange);
  activationAttempt = null;
}

function clearControllerObservation() {
  if (observedController && observedControllerStateChange) {
    observedController.removeEventListener('statechange', observedControllerStateChange);
  }
  observedController = null;
  observedControllerStateChange = null;
}

function observeInstalling(worker: ServiceWorker | null) {
  if (!worker) return;
  const inspect = () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) rememberWaiting(worker);
    if (worker.state === 'redundant' && waitingWorker === worker) {
      if (activationAttempt?.target === worker) return;
      waitingWorker = null;
      if (snapshot.reloadRequired) return;
      const replacement = registration?.waiting || null;
      if (replacement && replacement.state !== 'redundant') {
        rememberWaiting(replacement);
        observeInstalling(replacement);
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
  reloadPage();
}

function publishReloadRequired() {
  waitingWorker = null;
  publish({ available: true, activating: false, reloadRequired: true });
}

function settleOwnController(worker: ServiceWorker, generation: number) {
  const attempt = activationAttempt;
  if (
    !attempt ||
    attempt.generation !== generation ||
    attempt.target !== worker ||
    attempt.baselineController === worker ||
    navigator.serviceWorker.controller !== worker ||
    worker.state !== 'activated'
  ) return;
  const shouldReload = (
    attempt.autoReloadEligible &&
    Date.now() <= attempt.deadline &&
    !snapshot.reloadRequired &&
    !isPwaUpdateDeferredPath(window.location.pathname)
  );
  clearActivationAttempt();
  waitingWorker = null;
  if (shouldReload) reloadOnce();
  else publishReloadRequired();
}

function observeControllerTerminal(worker: ServiceWorker, observation: ControllerObservation) {
  clearControllerObservation();
  if (worker.state === 'redundant') return;
  observedController = worker;
  const inspect = () => {
    if (
      observedController !== worker ||
      navigator.serviceWorker.controller !== worker ||
      worker.state !== 'activated'
    ) return;
    clearControllerObservation();
    if (observation.kind === 'initial' || reloadStarted) return;
    if (observation.kind === 'own') {
      settleOwnController(worker, observation.generation);
      return;
    }
    clearActivationAttempt();
    publishReloadRequired();
  };
  observedControllerStateChange = inspect;
  worker.addEventListener('statechange', inspect);
  inspect();
}

function postActivation(attempt: ActivationAttempt): boolean {
  if (activationAttempt !== attempt) return false;
  try {
    attempt.target.postMessage({ type: 'SKYJO_ACTIVATE_UPDATE' });
    return true;
  } catch {
    const replacement = registration?.waiting || null;
    clearActivationAttempt();
    waitingWorker = replacement?.state === 'installed' ? replacement : null;
    publish({ available: Boolean(waitingWorker), activating: false, reloadRequired: snapshot.reloadRequired });
    return false;
  }
}

function transferActivationAttempt(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  const replacement = registration?.waiting || null;
  const retryableReplacement = (
    replacement &&
    replacement !== attempt.target &&
    replacement.state === 'installed'
  ) ? replacement : null;
  if (attempt.transferUsed || Date.now() >= attempt.deadline) {
    clearActivationAttempt();
    waitingWorker = retryableReplacement;
    publish({
      available: Boolean(retryableReplacement) || snapshot.reloadRequired,
      activating: false,
      reloadRequired: snapshot.reloadRequired
    });
    return;
  }
  if (!retryableReplacement) {
    clearActivationAttempt();
    waitingWorker = null;
    if (!snapshot.reloadRequired) publish({ available: false, activating: false, reloadRequired: false });
    return;
  }
  attempt.transferUsed = true;
  if (attempt.targetStateChange) attempt.target.removeEventListener('statechange', attempt.targetStateChange);
  attempt.target = retryableReplacement;
  attempt.targetStateChange = null;
  waitingWorker = retryableReplacement;
  observeInstalling(retryableReplacement);
  observeActivationTarget(attempt);
  postActivation(attempt);
}

function observeActivationTarget(attempt: ActivationAttempt) {
  const target = attempt.target;
  const inspect = () => {
    if (activationAttempt !== attempt || attempt.target !== target) return;
    if (target.state === 'redundant') {
      transferActivationAttempt(attempt);
      return;
    }
    if (target.state === 'activated' && navigator.serviceWorker.controller === target) {
      observeControllerTerminal(target, { kind: 'own', generation: attempt.generation });
    }
  };
  attempt.targetStateChange = inspect;
  target.addEventListener('statechange', inspect);
  inspect();
}

function handleActivationDeadline(generation: number) {
  const attempt = activationAttempt;
  if (!attempt || attempt.generation !== generation) return;
  const target = attempt.target;
  const passiveController = (
    navigator.serviceWorker.controller === target &&
    target.state !== 'redundant'
  ) ? target : null;
  const liveWaiting = registration?.waiting || null;
  const retryableWaiting = liveWaiting?.state === 'installed' ? liveWaiting : null;
  clearActivationAttempt();
  waitingWorker = retryableWaiting;
  publish({
    available: Boolean(retryableWaiting),
    activating: false,
    reloadRequired: false
  });
  if (passiveController) observeControllerTerminal(passiveController, { kind: 'external' });
}

export function getPwaUpdateSnapshot(): PwaUpdateSnapshot {
  return snapshot;
}

export function subscribeToPwaUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerPwaUpdates(reload: () => void = () => window.location.reload()): void {
  if (registrationStarted || !('serviceWorker' in navigator)) return;
  registrationStarted = true;
  reloadPage = reload;
  knownController = navigator.serviceWorker.controller;
  controllerKnown = Boolean(knownController);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadStarted) return;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    if (controllerKnown && controller === knownController) return;
    const initialControl = !controllerKnown;
    knownController = controller;
    controllerKnown = true;
    if (initialControl && !activationAttempt) {
      observeControllerTerminal(controller, { kind: 'initial' });
      return;
    }
    const attempt = activationAttempt;
    if (attempt && controller === attempt.target && controller !== attempt.baselineController) {
      observeControllerTerminal(controller, { kind: 'own', generation: attempt.generation });
      return;
    }
    if (attempt && controller === attempt.baselineController) return;
    if (attempt) attempt.autoReloadEligible = false;
    observeControllerTerminal(controller, { kind: 'external' });
  });
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(observeRegistration)
      .catch(() => undefined);
  }, { once: true });
}

export function activatePwaUpdate(): boolean {
  if (snapshot.reloadRequired) {
    if (isPwaUpdateDeferredPath(window.location.pathname)) return false;
    reloadOnce();
    return true;
  }
  const liveWaiting = registration?.waiting || null;
  const worker = liveWaiting && liveWaiting.state !== 'redundant'
    ? liveWaiting
    : waitingWorker?.state === 'installed'
      ? waitingWorker
      : null;
  if (!worker || activationAttempt) {
    if (!worker) {
      waitingWorker = null;
      publish({ available: false, activating: false, reloadRequired: false });
    }
    return false;
  }
  const generation = ++activationGeneration;
  const attempt: ActivationAttempt = {
    autoReloadEligible: true,
    baselineController: navigator.serviceWorker.controller,
    deadline: Date.now() + activationTimeoutMs,
    generation,
    target: worker,
    targetStateChange: null,
    timeout: null,
    transferUsed: false
  };
  activationAttempt = attempt;
  waitingWorker = worker;
  publish({ available: true, activating: true, reloadRequired: false });
  observeActivationTarget(attempt);
  attempt.timeout = window.setTimeout(() => handleActivationDeadline(generation), activationTimeoutMs);
  return postActivation(attempt);
}

export function isPwaUpdateDeferredPath(pathname: string): boolean {
  return pathname === '/single-player' || pathname === '/lobby';
}
