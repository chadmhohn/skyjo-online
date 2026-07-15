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
  pendingInstallers: Set<ServiceWorker>;
  postRetriedTargets: Set<ServiceWorker>;
  postRetryAt: number | null;
  refreshedTargets: Set<ServiceWorker>;
  seenTargets: Set<ServiceWorker>;
  target: ServiceWorker;
  targetStateChange: (() => void) | null;
  terminalController: ServiceWorker | null;
  terminalQuietUntil: number | null;
  terminalReconciliationInFlight: boolean;
  timeout: number | null;
};

type ControllerObservation =
  | { kind: 'initial' }
  | { kind: 'external' }
  | { kind: 'own'; generation: number };

type EquivalentWorkerContext = {
  buildId: string;
  controller: ServiceWorker;
  controllerEpoch: number;
};

const activationTimeoutMs = 8_000;
const activationPostRetryMs = 50;
const workerBuildIdentityTimeoutMs = 750;
// Two short quiet windows surround an explicit registration refresh before a safe reload.
const terminalQuiescenceMs = 250;
const listeners = new Set<() => void>();
const observedInstallingWorkers = new WeakSet<ServiceWorker>();
const workerBuildIds = new WeakMap<ServiceWorker, string>();
const workerBuildIdRequests = new WeakMap<ServiceWorker, Promise<string | null>>();
const workerClassifications = new WeakMap<ServiceWorker, Promise<void>>();
const equivalentWorkerContexts = new WeakMap<ServiceWorker, EquivalentWorkerContext>();
let snapshot: PwaUpdateSnapshot = Object.freeze({ available: false, activating: false, reloadRequired: false });
let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let activationAttempt: ActivationAttempt | null = null;
let activationGeneration = 0;
let reloadStarted = false;
let registrationStarted = false;
let controllerKnown = false;
let knownController: ServiceWorker | null = null;
let controllerEpoch = 0;
let workerIdentityRequestSequence = 0;
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

function validWorkerBuildId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requestWorkerBuildId(worker: ServiceWorker): Promise<string | null> {
  const cached = workerBuildIds.get(worker);
  if (cached) return Promise.resolve(cached);
  const existing = workerBuildIdRequests.get(worker);
  if (existing) return existing;
  const requestId = `${Date.now().toString(36)}-${(++workerIdentityRequestSequence).toString(36)}`;
  const pending = new Promise<string | null>((resolve) => {
    if (typeof MessageChannel !== 'function') {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = (buildId: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close();
      if (buildId) workerBuildIds.set(worker, buildId);
      resolve(buildId);
    };
    const timeout = window.setTimeout(() => finish(null), workerBuildIdentityTimeoutMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as {
        type?: unknown;
        version?: unknown;
        requestId?: unknown;
        buildId?: unknown;
      } | null;
      finish(
        value?.type === 'SKYJO_BUILD_ID' &&
          value.version === 1 &&
          value.requestId === requestId &&
          validWorkerBuildId(value.buildId)
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
  const request = pending.finally(() => workerBuildIdRequests.delete(worker));
  workerBuildIdRequests.set(worker, request);
  return request;
}

function equivalentWorkerContext(worker: ServiceWorker): EquivalentWorkerContext | null {
  const context = equivalentWorkerContexts.get(worker) || null;
  if (
    !context ||
    workerBuildIds.get(worker) !== context.buildId ||
    context.controllerEpoch !== controllerEpoch ||
    navigator.serviceWorker.controller !== context.controller ||
    registration?.active !== context.controller ||
    context.controller.state !== 'activated'
  ) return null;
  return context;
}

function isCurrentRegistrationCandidate(
  candidate: ServiceWorker,
  expectedRegistration: ServiceWorkerRegistration
): boolean {
  return (
    registration === expectedRegistration &&
    candidate.state === 'installed' &&
    (expectedRegistration.waiting === candidate || expectedRegistration.installing === candidate)
  );
}

async function classifyWaitingWorker(
  candidate: ServiceWorker,
  expectedRegistration: ServiceWorkerRegistration,
  expectedControllerEpoch: number
): Promise<boolean> {
  const controller = navigator.serviceWorker.controller;
  const active = expectedRegistration.active;
  const canCompare = Boolean(controller && active === controller && controller.state === 'activated');
  const [activeBuildId, candidateBuildId] = canCompare && controller
    ? await Promise.all([requestWorkerBuildId(controller), requestWorkerBuildId(candidate)])
    : [null, null];
  if (!isCurrentRegistrationCandidate(candidate, expectedRegistration)) return false;
  if (!canCompare) {
    rememberWaiting(candidate);
    return false;
  }
  const unchangedActiveController = (
    controllerEpoch === expectedControllerEpoch &&
    controller !== null &&
    navigator.serviceWorker.controller === controller &&
    expectedRegistration.active === controller &&
    controller.state === 'activated'
  );
  if (
    unchangedActiveController &&
    validWorkerBuildId(activeBuildId) &&
    activeBuildId === candidateBuildId
  ) {
    equivalentWorkerContexts.set(candidate, {
      buildId: activeBuildId,
      controller,
      controllerEpoch: expectedControllerEpoch
    });
    if (waitingWorker === candidate) {
      waitingWorker = null;
      if (!activationAttempt && !snapshot.reloadRequired) {
        publish({ available: false, activating: false, reloadRequired: false });
      }
    }
    return false;
  }
  if (!unchangedActiveController) return true;
  rememberWaiting(candidate);
  return false;
}

function queueWaitingWorkerClassification(worker: ServiceWorker | null) {
  const expectedRegistration = registration;
  if (
    !worker ||
    !expectedRegistration ||
    worker.state !== 'installed' ||
    activationAttempt ||
    equivalentWorkerContext(worker) !== null ||
    workerClassifications.has(worker) ||
    (
      expectedRegistration.waiting !== worker &&
      expectedRegistration.installing !== worker
    )
  ) return;
  const expectedControllerEpoch = controllerEpoch;
  const classification = (async () => {
    let retry = false;
    try {
      retry = await classifyWaitingWorker(worker, expectedRegistration, expectedControllerEpoch);
    } catch {
      if (isCurrentRegistrationCandidate(worker, expectedRegistration)) rememberWaiting(worker);
    } finally {
      workerClassifications.delete(worker);
      if (retry && isCurrentRegistrationCandidate(worker, expectedRegistration)) {
        queueWaitingWorkerClassification(worker);
      } else if (!isCurrentRegistrationCandidate(worker, expectedRegistration)) {
        queueWaitingWorkerClassification(expectedRegistration.waiting);
        queueWaitingWorkerClassification(expectedRegistration.installing);
      }
    }
  })();
  workerClassifications.set(worker, classification);
}

function rememberWaiting(worker: ServiceWorker | null) {
  if (!worker || worker.state === 'redundant' || equivalentWorkerContext(worker)) return;
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

function scheduleActivationTimer(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  if (attempt.timeout !== null) window.clearTimeout(attempt.timeout);
  const nextAt = Math.min(
    attempt.deadline,
    attempt.terminalQuietUntil ?? attempt.deadline,
    attempt.postRetryAt ?? attempt.deadline
  );
  const scheduledTimeout = window.setTimeout(
    () => handleActivationTimer(attempt.generation, scheduledTimeout),
    Math.max(0, nextAt - Date.now())
  );
  attempt.timeout = scheduledTimeout;
}

function cancelTerminalQuiescence(attempt: ActivationAttempt) {
  if (attempt.terminalQuietUntil === null && attempt.terminalController === null) return;
  attempt.terminalQuietUntil = null;
  attempt.terminalController = null;
  scheduleActivationTimer(attempt);
}

function isUnsettledSuccessor(worker: ServiceWorker): boolean {
  return (
    worker.state === 'installing' ||
    worker.state === 'installed' ||
    worker.state === 'activating' ||
    worker.state === 'activated'
  );
}

function beginTerminalQuiescence(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  if (Date.now() >= attempt.deadline) {
    handleActivationDeadline(attempt.generation);
    return;
  }
  if (!attempt.terminalReconciliationInFlight && attempt.terminalQuietUntil === null) {
    attempt.terminalQuietUntil = Math.min(
      attempt.deadline,
      Date.now() + terminalQuiescenceMs
    );
  }
  scheduleActivationTimer(attempt);
}

function trackAttemptInstaller(worker: ServiceWorker | null) {
  const attempt = activationAttempt;
  if (
    !attempt ||
    !worker ||
    worker === attempt.target ||
    !isUnsettledSuccessor(worker)
  ) return;
  const isNew = !attempt.pendingInstallers.has(worker);
  attempt.pendingInstallers.add(worker);
  if (isNew) cancelTerminalQuiescence(attempt);
}

function observeInstalling(worker: ServiceWorker | null) {
  if (!worker) return;
  trackAttemptInstaller(worker);
  if (observedInstallingWorkers.has(worker)) return;
  observedInstallingWorkers.add(worker);
  const inspect = () => {
    const attempt = activationAttempt;
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      if (attempt) rememberWaiting(worker);
      else queueWaitingWorkerClassification(worker);
    }
    if (attempt) {
      if (worker === attempt.target || worker.state === 'redundant') {
        attempt.pendingInstallers.delete(worker);
      } else if (isUnsettledSuccessor(worker)) {
        const isNew = !attempt.pendingInstallers.has(worker);
        attempt.pendingInstallers.add(worker);
        if (isNew) cancelTerminalQuiescence(attempt);
      } else {
        attempt.pendingInstallers.delete(worker);
      }
    }
    if (worker.state === 'redundant' && waitingWorker === worker) {
      if (activationAttempt?.target === worker) return;
      waitingWorker = null;
      if (snapshot.reloadRequired) return;
      const replacement = registration?.waiting || null;
      if (replacement && replacement.state !== 'redundant') {
        observeInstalling(replacement);
      }
      else publish({ available: false, activating: false, reloadRequired: false });
    }
    if (
      attempt &&
      activationAttempt === attempt &&
      worker.state !== 'installing'
    ) reconcileActivationAttempt(attempt);
  };
  inspect();
  worker.addEventListener('statechange', inspect);
}

function observeRegistration(nextRegistration: ServiceWorkerRegistration) {
  registration = nextRegistration;
  if (nextRegistration.waiting) {
    observeInstalling(nextRegistration.waiting);
  }
  observeInstalling(nextRegistration.installing);
  nextRegistration.addEventListener('updatefound', () => {
    const attempt = activationAttempt;
    if (attempt) cancelTerminalQuiescence(attempt);
    observeInstalling(nextRegistration.installing);
    if (attempt && activationAttempt === attempt) reconcileActivationAttempt(attempt);
  });
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

function hasPendingSuccessor(attempt: ActivationAttempt): boolean {
  const liveInstaller = registration?.installing || null;
  if (
    liveInstaller &&
    liveInstaller !== attempt.target &&
    isUnsettledSuccessor(liveInstaller)
  ) {
    const isNew = !attempt.pendingInstallers.has(liveInstaller);
    attempt.pendingInstallers.add(liveInstaller);
    if (isNew) cancelTerminalQuiescence(attempt);
    if (liveInstaller.state === 'installing') observeInstalling(liveInstaller);
  }
  for (const worker of attempt.pendingInstallers) {
    if (
      worker === attempt.target ||
      !isUnsettledSuccessor(worker)
    ) attempt.pendingInstallers.delete(worker);
  }
  return attempt.pendingInstallers.size > 0;
}

function distinctRegistrationSuccessor(attempt: ActivationAttempt): ServiceWorker | null {
  const liveInstaller = registration?.installing || null;
  if (
    liveInstaller &&
    liveInstaller !== attempt.target &&
    isUnsettledSuccessor(liveInstaller)
  ) return liveInstaller;
  const liveWaiter = registration?.waiting || null;
  if (
    liveWaiter &&
    liveWaiter !== attempt.target &&
    isUnsettledSuccessor(liveWaiter)
  ) return liveWaiter;
  return null;
}

function failTerminalSettlement(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  clearActivationAttempt();
  publishReloadRequired();
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
  const replacement = registration?.waiting || null;
  if (replacement && replacement !== worker && replacement.state === 'installed') {
    transferActivationAttempt(attempt);
    return;
  }
  const distinctUnsettled = distinctRegistrationSuccessor(attempt);
  if (distinctUnsettled) {
    cancelTerminalQuiescence(attempt);
    observeInstalling(distinctUnsettled);
    return;
  }
  if (hasPendingSuccessor(attempt)) {
    cancelTerminalQuiescence(attempt);
    return;
  }
  if (attempt.refreshedTargets.has(worker)) {
    if (attempt.terminalController === worker && attempt.terminalQuietUntil !== null) return;
    failTerminalSettlement(attempt);
    return;
  }
  beginTerminalQuiescence(attempt);
}

function completeTerminalSettlement(attempt: ActivationAttempt, worker: ServiceWorker) {
  if (
    activationAttempt !== attempt ||
    attempt.target !== worker ||
    attempt.terminalController !== worker ||
    navigator.serviceWorker.controller !== worker ||
    registration?.active !== worker ||
    worker.state !== 'activated' ||
    registration?.installing !== null ||
    registration?.waiting !== null ||
    hasPendingSuccessor(attempt)
  ) {
    cancelTerminalQuiescence(attempt);
    reconcileActivationAttempt(attempt);
    return;
  }
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

function finishTerminalReconciliation(
  attempt: ActivationAttempt,
  worker: ServiceWorker,
  refreshed: boolean
) {
  if (activationAttempt !== attempt || attempt.target !== worker) return;
  attempt.terminalReconciliationInFlight = false;
  if (Date.now() >= attempt.deadline) {
    handleActivationDeadline(attempt.generation);
    return;
  }
  if (!refreshed) {
    failTerminalSettlement(attempt);
    return;
  }
  attempt.refreshedTargets.add(worker);
  observeInstalling(registration?.installing || null);
  const replacement = registration?.waiting || null;
  if (replacement && replacement !== worker && replacement.state === 'installed') {
    rememberWaiting(replacement);
    observeInstalling(replacement);
    transferActivationAttempt(attempt);
    return;
  }
  const distinctUnsettled = distinctRegistrationSuccessor(attempt);
  if (distinctUnsettled || hasPendingSuccessor(attempt)) {
    if (distinctUnsettled) observeInstalling(distinctUnsettled);
    cancelTerminalQuiescence(attempt);
    return;
  }
  if (
    navigator.serviceWorker.controller !== worker ||
    registration?.active !== worker ||
    worker.state !== 'activated'
  ) {
    attempt.terminalController = null;
    cancelTerminalQuiescence(attempt);
    reconcileActivationAttempt(attempt);
    return;
  }
  attempt.terminalController = worker;
  beginTerminalQuiescence(attempt);
}

function refreshRegistrationBeforeSettlement(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt || attempt.terminalReconciliationInFlight) return;
  const worker = attempt.target;
  const activeRegistration = registration;
  if (!activeRegistration) {
    failTerminalSettlement(attempt);
    return;
  }
  attempt.terminalReconciliationInFlight = true;
  scheduleActivationTimer(attempt);
  void Promise.resolve()
    .then(() => activeRegistration.update())
    .then(
      () => finishTerminalReconciliation(attempt, worker, true),
      () => finishTerminalReconciliation(attempt, worker, false)
    );
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
    attempt.postRetryAt = null;
    scheduleActivationTimer(attempt);
    return true;
  } catch {
    if (Date.now() >= attempt.deadline) {
      handleActivationDeadline(attempt.generation);
      return false;
    }
    if (!attempt.postRetriedTargets.has(attempt.target)) {
      attempt.postRetriedTargets.add(attempt.target);
      attempt.postRetryAt = Math.min(attempt.deadline, Date.now() + activationPostRetryMs);
      scheduleActivationTimer(attempt);
      return true;
    }
    const liveWaiting = registration?.waiting || null;
    const retryableWaiting = liveWaiting?.state === 'installed'
      ? liveWaiting
      : attempt.target.state === 'installed'
        ? attempt.target
        : null;
    clearActivationAttempt();
    waitingWorker = retryableWaiting;
    publish({
      available: Boolean(retryableWaiting) || snapshot.reloadRequired,
      activating: false,
      reloadRequired: snapshot.reloadRequired
    });
    return false;
  }
}

function retryPostActivation(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  attempt.postRetryAt = null;
  const liveWaiting = registration?.waiting || null;
  if (
    liveWaiting &&
    liveWaiting !== attempt.target &&
    liveWaiting.state === 'installed'
  ) {
    transferActivationAttempt(attempt);
    return;
  }
  if (attempt.target.state === 'redundant') {
    transferActivationAttempt(attempt);
    return;
  }
  if (attempt.target.state !== 'installed') {
    reconcileActivationAttempt(attempt);
    scheduleActivationTimer(attempt);
    return;
  }
  postActivation(attempt);
}

function transferActivationAttempt(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  const replacement = registration?.waiting || null;
  const retryableReplacement = (
    replacement &&
    replacement !== attempt.target &&
    replacement.state === 'installed'
  ) ? replacement : null;
  if (Date.now() >= attempt.deadline || (retryableReplacement && attempt.seenTargets.has(retryableReplacement))) {
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
    if (hasPendingSuccessor(attempt)) {
      cancelTerminalQuiescence(attempt);
      return;
    }
    cancelTerminalQuiescence(attempt);
    scheduleActivationTimer(attempt);
    return;
  }
  if (attempt.targetStateChange) attempt.target.removeEventListener('statechange', attempt.targetStateChange);
  attempt.pendingInstallers.delete(retryableReplacement);
  attempt.seenTargets.add(retryableReplacement);
  attempt.postRetryAt = null;
  attempt.terminalController = null;
  attempt.terminalQuietUntil = null;
  attempt.terminalReconciliationInFlight = false;
  attempt.target = retryableReplacement;
  attempt.targetStateChange = null;
  waitingWorker = retryableReplacement;
  observeInstalling(retryableReplacement);
  observeActivationTarget(attempt);
  scheduleActivationTimer(attempt);
  postActivation(attempt);
}

function reconcileActivationAttempt(attempt: ActivationAttempt) {
  if (activationAttempt !== attempt) return;
  if (attempt.target.state === 'redundant') {
    transferActivationAttempt(attempt);
    return;
  }
  if (
    attempt.target.state === 'activated' &&
    navigator.serviceWorker.controller === attempt.target
  ) settleOwnController(attempt.target, attempt.generation);
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
  if (passiveController) {
    observeControllerTerminal(passiveController, { kind: 'external' });
  }
}

function handleActivationTimer(generation: number, scheduledTimeout: number) {
  const attempt = activationAttempt;
  if (
    !attempt ||
    attempt.generation !== generation ||
    attempt.timeout !== scheduledTimeout
  ) return;
  attempt.timeout = null;
  if (Date.now() >= attempt.deadline) {
    handleActivationDeadline(generation);
    return;
  }
  if (
    attempt.postRetryAt !== null &&
    Date.now() >= attempt.postRetryAt
  ) {
    retryPostActivation(attempt);
    return;
  }
  if (
    attempt.terminalQuietUntil !== null &&
    Date.now() >= attempt.terminalQuietUntil
  ) {
    attempt.terminalQuietUntil = null;
    if (attempt.terminalController) {
      completeTerminalSettlement(attempt, attempt.terminalController);
    } else {
      refreshRegistrationBeforeSettlement(attempt);
    }
    if (activationAttempt === attempt && attempt.timeout === null) {
      scheduleActivationTimer(attempt);
    }
    return;
  }
  scheduleActivationTimer(attempt);
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
  if (knownController) void requestWorkerBuildId(knownController);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadStarted) return;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    if (controllerKnown && controller === knownController) return;
    const initialControl = !controllerKnown;
    controllerEpoch += 1;
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
  const registrationWaiting = registration?.waiting || null;
  const liveWaiting = (
    registrationWaiting &&
    registrationWaiting.state !== 'redundant' &&
    !equivalentWorkerContext(registrationWaiting) &&
    !workerClassifications.has(registrationWaiting)
  ) ? registrationWaiting : null;
  const worker = liveWaiting
    ? liveWaiting
    : waitingWorker?.state === 'installed' &&
        !equivalentWorkerContext(waitingWorker) &&
        !workerClassifications.has(waitingWorker)
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
    pendingInstallers: new Set<ServiceWorker>(),
    postRetriedTargets: new Set<ServiceWorker>(),
    postRetryAt: null,
    refreshedTargets: new Set<ServiceWorker>(),
    seenTargets: new Set<ServiceWorker>([worker]),
    target: worker,
    targetStateChange: null,
    terminalController: null,
    terminalQuietUntil: null,
    terminalReconciliationInFlight: false,
    timeout: null
  };
  activationAttempt = attempt;
  waitingWorker = worker;
  trackAttemptInstaller(registration?.installing || null);
  observeInstalling(registration?.installing || null);
  publish({ available: true, activating: true, reloadRequired: false });
  observeActivationTarget(attempt);
  scheduleActivationTimer(attempt);
  return postActivation(attempt);
}

export function isPwaUpdateDeferredPath(pathname: string): boolean {
  return pathname === '/single-player' || pathname === '/lobby';
}
