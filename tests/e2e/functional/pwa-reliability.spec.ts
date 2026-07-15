import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const safeCachedPath = /^(?:\/offline\.html|\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;
type TestPwaWorkerVariant = 'A' | 'B' | 'C' | 'D';
type TestPwaWorkerIdentity = {
  variant: TestPwaWorkerVariant;
  buildNonce: string;
  instanceNonce: string;
};
type TestPwaActivationBarrierStatus = {
  arrivals: TestPwaWorkerVariant[];
  pending: TestPwaWorkerVariant[];
  poisoned: boolean;
  released: TestPwaWorkerVariant[];
  workers: TestPwaWorkerIdentity[];
};
type TestPwaSuccessorHarness = {
  variants: TestPwaWorkerVariant[];
  workers: ServiceWorker[];
};

async function waitForServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return registration.scope;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Service worker did not claim the page.')), 10_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    return registration.scope;
  });
}

async function serviceWorkerLifecycle(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const controller = navigator.serviceWorker.controller;
    return {
      active: registration?.active?.state ?? null,
      controller: controller?.state ?? null,
      controllerIsActive: Boolean(registration?.active && controller === registration.active),
      installing: registration?.installing?.state ?? null,
      waiting: registration?.waiting?.state ?? null
    };
  }).catch(() => null);
}

async function expectActiveWorker(page: Page) {
  await expect.poll(() => serviceWorkerLifecycle(page), {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000]
  }).toEqual({
    active: 'activated',
    controller: 'activated',
    controllerIsActive: true,
    installing: null,
    waiting: null
  });
}

async function expectProtectedObserverControlledByActiveWorker(page: Page) {
  await expect.poll(() => serviceWorkerLifecycle(page), {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000]
  }).toMatchObject({
    active: 'activated',
    controller: 'activated',
    controllerIsActive: true
  });
}

async function expectWaitingWorker(page: Page) {
  await expect.poll(() => serviceWorkerLifecycle(page), {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000]
  }).toEqual({
    active: 'activated',
    controller: 'activated',
    controllerIsActive: true,
    installing: null,
    waiting: 'installed'
  });
}

async function expectSessionStorageNumber(page: Page, key: string, expected: number) {
  await expect.poll(() => page.evaluate((storageKey) => {
    const value = sessionStorage.getItem(storageKey);
    return value === null ? null : Number(value);
  }, key).catch(() => null), {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000]
  }).toBe(expected);
}

async function activeControllerIdentity(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const active = registration?.active || null;
    const controller = navigator.serviceWorker.controller;
    if (!active || !controller || active !== controller) {
      return { controllerIsActive: false, identity: null };
    }
    const identity = await new Promise<TestPwaWorkerIdentity>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error('Timed out requesting the active test worker identity.'));
      }, 2_000);
      channel.port1.onmessage = (event: MessageEvent<TestPwaWorkerIdentity>) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data);
      };
      active.postMessage({ type: 'SKYJO_TEST_WORKER_IDENTITY' }, [channel.port2]);
    });
    return { controllerIsActive: true, identity };
  });
}

async function setWorkerVariant(
  context: BrowserContext,
  baseURL: string,
  variant: TestPwaWorkerVariant,
  buildNonce?: string
) {
  await context.addCookies([
    {
      name: 'skyjo_sw_test_variant',
      value: variant,
      url: baseURL,
      sameSite: 'Lax'
    },
    ...(buildNonce ? [{
      name: 'skyjo_sw_test_worker_nonce',
      value: buildNonce,
      url: baseURL,
      sameSite: 'Lax' as const
    }] : [])
  ]);
}

function testPwaActivationBarrierUrl(baseURL: string, action: string) {
  return `${baseURL}/__test/pwa-activation/${action}`;
}

async function testPwaActivationBarrierStatus(
  context: BrowserContext,
  baseURL: string,
  token: string
): Promise<TestPwaActivationBarrierStatus | null> {
  const response = await context.request.get(
    `${testPwaActivationBarrierUrl(baseURL, 'status')}?token=${encodeURIComponent(token)}`
  );
  if (response.status() === 404) return null;
  if (!response.ok()) throw new Error(`Activation barrier status failed with ${response.status()}.`);
  return response.json() as Promise<TestPwaActivationBarrierStatus>;
}

async function expectTestPwaActivationArrivals(
  context: BrowserContext,
  baseURL: string,
  token: string,
  arrivals: TestPwaWorkerVariant[]
) {
  const response = await context.request.get(
    `${testPwaActivationBarrierUrl(baseURL, 'wait-arrivals')}?token=${encodeURIComponent(token)}&count=${arrivals.length}`,
    { timeout: 9_000 }
  );
  if (!response.ok()) {
    throw new Error(
      `Activation barrier arrival proof failed with ${response.status()}: ${await response.text()}`
    );
  }
  const status = await response.json() as TestPwaActivationBarrierStatus;
  expect(status.arrivals).toEqual(arrivals);
  return status;
}

async function initializeTestPwaActivationBarrier(
  context: BrowserContext,
  baseURL: string,
  token: string,
  workers: Array<{ variant: 'B' | 'C' | 'D'; buildNonce: string }>
) {
  const response = await context.request.post(testPwaActivationBarrierUrl(baseURL, 'init'), {
    data: { token, workers }
  });
  if (!response.ok()) throw new Error(`Activation barrier initialization failed with ${response.status()}.`);
  return response.json() as Promise<TestPwaActivationBarrierStatus>;
}

async function releaseTestPwaActivation(
  context: BrowserContext,
  baseURL: string,
  token: string,
  variant: TestPwaWorkerVariant
) {
  const response = await context.request.post(testPwaActivationBarrierUrl(baseURL, 'release'), {
    data: { token, variant }
  });
  if (!response.ok()) throw new Error(`Activation barrier release failed with ${response.status()}.`);
  return response.json() as Promise<TestPwaActivationBarrierStatus>;
}

async function cleanupTestPwaActivationBarrier(context: BrowserContext, baseURL: string, token: string) {
  const response = await context.request.post(testPwaActivationBarrierUrl(baseURL, 'cleanup'), {
    data: { token }
  });
  if (!response.ok()) throw new Error(`Activation barrier cleanup failed with ${response.status()}.`);
  const status = await context.request.get(
    `${testPwaActivationBarrierUrl(baseURL, 'status')}?token=${encodeURIComponent(token)}`
  );
  if (status.status() !== 404) {
    throw new Error(`Activation barrier cleanup verification returned ${status.status()}.`);
  }
}

async function installTestPwaSuccessor(page: Page, variant: 'C' | 'D', buildNonce: string) {
  return page.evaluate(async ({ nextVariant, nextBuildNonce }) => {
    const registration = await navigator.serviceWorker.ready;
    const harnessWindow = window as typeof window & {
      __skyjoSuccessorHarness?: TestPwaSuccessorHarness;
    };
    const harness = harnessWindow.__skyjoSuccessorHarness;
    if (!harness) throw new Error('Successor harness was not ready.');
    const priorWorkers = [...harness.workers];
    document.cookie = `skyjo_sw_test_variant=${nextVariant}; Path=/; SameSite=Lax`;
    document.cookie = `skyjo_sw_test_worker_nonce=${nextBuildNonce}; Path=/; SameSite=Lax`;
    let discoveredWorker: ServiceWorker | null = null;
    let timeout: number | null = null;
    let onUpdateFound: (() => void) | null = null;
    let onStateChange: (() => void) | null = null;
    let settled = false;
    const cleanup = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      if (onUpdateFound) registration.removeEventListener('updatefound', onUpdateFound);
      if (discoveredWorker && onStateChange) {
        discoveredWorker.removeEventListener('statechange', onStateChange);
      }
    };
    const installed = new Promise<ServiceWorker>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        const worker = discoveredWorker;
        cleanup();
        if (error) reject(error);
        else if (worker) resolve(worker);
        else reject(new Error(`Worker ${nextVariant} was not discovered.`));
      };
      onStateChange = () => {
        if (discoveredWorker?.state === 'installed') finish();
        else if (discoveredWorker?.state === 'redundant') {
          finish(new Error(`Worker ${nextVariant} became redundant before installation.`));
        }
      };
      timeout = window.setTimeout(() => {
        finish(new Error(`Timed out waiting for worker ${nextVariant} to install.`));
      }, 2_000);
      onUpdateFound = () => {
        const worker = registration.installing;
        if (!worker || discoveredWorker) return;
        discoveredWorker = worker;
        if (onUpdateFound) registration.removeEventListener('updatefound', onUpdateFound);
        worker.addEventListener('statechange', onStateChange as () => void);
        onStateChange?.();
      };
      registration.addEventListener('updatefound', onUpdateFound);
    });
    let worker: ServiceWorker;
    try {
      const update = registration.update();
      [, worker] = await Promise.all([update, installed]);
    } finally {
      cleanup();
    }
    if (priorWorkers.includes(worker)) {
      throw new Error(`Worker ${nextVariant} reused an earlier object identity.`);
    }
    harness.variants.push(nextVariant);
    harness.workers.push(worker);
    return { state: worker.state, variant: nextVariant };
  }, { nextVariant: variant, nextBuildNonce: buildNonce });
}

async function setNetworkUnavailable(
  context: BrowserContext,
  baseURL: string,
  injectedFault: boolean,
  unavailable: boolean
) {
  if (!injectedFault) {
    await context.setOffline(unavailable);
    return;
  }
  await context.addCookies([{
    name: 'skyjo_pwa_test_network_fault',
    value: unavailable ? 'drop' : 'allow',
    url: baseURL,
    sameSite: 'Lax'
  }]);
}

test('a fresh credentialless install caches only the data-free offline solo allowlist', async ({ browser, skyjoServer }, testInfo) => {
  const injectedNetworkFault = testInfo.project.name.startsWith('webkit');
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    await page.goto(`${skyjoServer.baseURL}/login`);
    await page.evaluate(async () => {
      const legacyOnline = await caches.open('skyjo-online-v5');
      const legacyStatic = await caches.open('skyjo-static-v5');
      const poisonedCurrent = await caches.open('skyjo-pwa-v2-poisoned');
      await legacyOnline.put('/api/account/me', new Response('{"email":"poison@example.test"}', {
        headers: { 'Content-Type': 'application/json' }
      }));
      await legacyStatic.put('/invite/poisoned-token', new Response('<p>secret invite</p>', {
        headers: { 'Content-Type': 'text/html' }
      }));
      await poisonedCurrent.put('/assets/fake-12345678.js', new Response('<p>not javascript</p>', {
        headers: { 'Content-Type': 'text/html' }
      }));
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    });
    await waitForServiceWorkerControl(page);

    const cacheEvidence = await page.evaluate(async () => {
      const keys = await caches.keys();
      const entries: Array<{ cache: string; path: string; body: string; contentType: string }> = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const pathname = new URL(request.url).pathname;
          const textual = pathname.endsWith('.html') || pathname.endsWith('.webmanifest');
          entries.push({
            cache: key,
            path: pathname,
            body: textual && response ? await response.text() : '',
            contentType: response?.headers.get('content-type') || ''
          });
        }
      }
      return { keys, entries };
    });
    expect(cacheEvidence.keys.some((key) => key.startsWith('skyjo-online-v') || key.startsWith('skyjo-static-v'))).toBe(false);
    expect(cacheEvidence.keys.filter((key) => key.startsWith('skyjo-pwa-v2-'))).toHaveLength(1);
    expect(cacheEvidence.entries.length).toBeGreaterThan(4);
    expect(cacheEvidence.entries.some((entry) => entry.path.endsWith('.mp3'))).toBe(false);
    for (const entry of cacheEvidence.entries) {
      expect(entry.cache).toMatch(/^skyjo-pwa-v2-/);
      expect(entry.path).toMatch(safeCachedPath);
      expect(entry.body).not.toMatch(/poison@example|secret invite|set-cookie|invite-code/i);
      if (entry.path.endsWith('.js')) expect(entry.contentType).toMatch(/javascript/);
      if (entry.path.endsWith('.css')) expect(entry.contentType).toMatch(/^text\/css/);
    }

    const sanitizedExactPath = await page.evaluate(async () => {
      const key = (await caches.keys()).find((candidate) => candidate.startsWith('skyjo-pwa-v2-'));
      if (!key) throw new Error('Current PWA cache was not found.');
      const cache = await caches.open(key);
      const scriptRequest = (await cache.keys()).find((request) => new URL(request.url).pathname.endsWith('.js'));
      if (!scriptRequest) throw new Error('Current PWA script entry was not found.');
      await cache.put(scriptRequest, new Response('<p>synthetic poisoned html</p>', {
        headers: { 'Content-Type': 'text/html' }
      }));
      await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => reject(new Error('Cache sanitizer timed out.')), 5_000);
        channel.port1.onmessage = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        navigator.serviceWorker.controller?.postMessage({ type: 'SKYJO_SANITIZE_CACHE' }, [channel.port2]);
      });
      if (await cache.match(scriptRequest)) throw new Error('Synthetic poisoned response survived sanitation.');
      const pathname = new URL(scriptRequest.url).pathname;
      const refreshed = await fetch(pathname);
      if (!refreshed.ok || !/javascript/.test(refreshed.headers.get('content-type') || '')) {
        throw new Error('Sanitized script could not be safely repopulated.');
      }
      return pathname;
    });
    expect(sanitizedExactPath).toMatch(/^\/assets\/.*\.js$/);

    await page.close();
    const offlineStart = await context.newPage();
    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
    const offlineResponse = await offlineStart.goto(`${skyjoServer.baseURL}/`, { waitUntil: 'domcontentloaded' });
    expect(offlineResponse?.headers()['content-security-policy']).toContain("form-action 'self'");
    expect(offlineResponse?.headers()['content-security-policy']).not.toContain("'unsafe-inline'");
    await expect(offlineStart.getByRole('heading', { name: 'Skyjo' })).toBeVisible();
    await offlineStart.getByRole('link', { name: 'Single Player' }).click();
    await expect(offlineStart).toHaveURL(`${skyjoServer.baseURL}/single-player`);
    await expect(offlineStart.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    await expect.poll(() => offlineStart.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('skyjo-pwa', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const request = database.transaction('soloSessions').objectStore('soloSessions').index('byOwner').count('guest');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      database.close();
      return count;
    })).toBe(1);
    await offlineStart.close();

    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false);
    const offlineDeepLink = await context.newPage();
    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
    await offlineDeepLink.goto(`${skyjoServer.baseURL}/single-player`, { waitUntil: 'domcontentloaded' });
    await expect(offlineDeepLink.getByRole('dialog', { name: 'Continue your solo game?' })).toBeVisible();
    await offlineDeepLink.getByRole('button', { name: 'Continue Game' }).click();
    await expect(offlineDeepLink.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    await offlineDeepLink.close();
    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false);
    const sensitiveNavigation = await context.newPage();
    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
    const sensitiveUrl = `${skyjoServer.baseURL}/?invite=must-not-use-offline-shell`;
    if (injectedNetworkFault) {
      const sensitiveResponse = await sensitiveNavigation.goto(sensitiveUrl, { waitUntil: 'domcontentloaded' });
      expect(sensitiveResponse?.status()).toBe(503);
      expect(sensitiveResponse?.headers()['cache-control']).toBe('no-store');
      await expect(sensitiveNavigation.getByRole('heading', { name: 'Skyjo' })).toHaveCount(0);
    } else {
      await expect(sensitiveNavigation.goto(sensitiveUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 5_000
      })).rejects.toThrow();
    }
  } finally {
    await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false).catch(() => undefined);
    await context.close();
  }
});

test('a cold offline solo restore stays partitioned across owner A, owner B, and guest', async ({ context, page, skyjoServer }, testInfo) => {
  const injectedNetworkFault = testInfo.project.name.startsWith('webkit');
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = 'offline-owner-password';
  const signupA = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `offline-owner-a-${suffix}@example.test`,
      displayName: 'Offline Owner A',
      password,
      confirmPassword: password
    }
  });
  expect(signupA.status()).toBe(201);
  const ownerA = (await signupA.json()).user as { id: string };
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await waitForServiceWorkerControl(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('skyjo:last-confirmed-solo-owner'))).toBe(ownerA.id);
  await expect.poll(() => page.evaluate(async (ownerId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('skyjo-pwa', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = database.transaction('soloSessions').objectStore('soloSessions').index('byOwner').count(`account:${ownerId}`);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    database.close();
    return count;
  }, ownerA.id)).toBe(1);
  await page.close();

  const ownerAOffline = await context.newPage();
  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
  await ownerAOffline.goto(`${skyjoServer.baseURL}/single-player`, { waitUntil: 'domcontentloaded' });
  await expect(ownerAOffline.getByRole('dialog', { name: 'Continue your solo game?' })).toBeVisible();
  expect(await ownerAOffline.evaluate(async () => fetch('/api/account/me').then(
    (response) => response.ok ? 'live' : 'offline',
    () => 'offline'
  ))).toBe('offline');
  await ownerAOffline.close();

  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false);
  expect((await context.request.post(`${skyjoServer.baseURL}/api/account/logout`)).status()).toBe(200);
  const signupB = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `offline-owner-b-${suffix}@example.test`,
      displayName: 'Offline Owner B',
      password,
      confirmPassword: password
    }
  });
  expect(signupB.status()).toBe(201);
  const ownerB = (await signupB.json()).user as { id: string };
  const ownerBOnline = await context.newPage();
  await ownerBOnline.goto(`${skyjoServer.baseURL}/`);
  await expect(ownerBOnline.getByText('Signed in as Offline Owner B')).toBeVisible();
  await expect.poll(() => ownerBOnline.evaluate(() => localStorage.getItem('skyjo:last-confirmed-solo-owner'))).toBe(ownerB.id);
  await ownerBOnline.close();
  const ownerBOffline = await context.newPage();
  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
  await ownerBOffline.goto(`${skyjoServer.baseURL}/single-player`, { waitUntil: 'domcontentloaded' });
  await expect(ownerBOffline.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect(ownerBOffline.getByRole('dialog', { name: 'Continue your solo game?' })).toHaveCount(0);
  await ownerBOffline.close();

  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false);
  expect((await context.request.post(`${skyjoServer.baseURL}/api/account/logout`)).status()).toBe(200);
  const guestOnline = await context.newPage();
  await guestOnline.goto(`${skyjoServer.baseURL}/`);
  await expect(guestOnline.getByText('Sign in to save stats and play multiplayer.')).toBeVisible();
  await expect.poll(() => guestOnline.evaluate(() => localStorage.getItem('skyjo:last-confirmed-solo-owner'))).toBeNull();
  await guestOnline.close();
  const guestOffline = await context.newPage();
  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, true);
  await guestOffline.goto(`${skyjoServer.baseURL}/single-player`, { waitUntil: 'domcontentloaded' });
  await expect(guestOffline.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect(guestOffline.getByRole('dialog', { name: 'Continue your solo game?' })).toHaveCount(0);
  await setNetworkUnavailable(context, skyjoServer.baseURL, injectedNetworkFault, false);
});

test('a changed worker defers on solo and lobby routes, then applies once from a safe route', async ({ context, page, skyjoServer }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const signup = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `pwa-update-${suffix}@example.test`,
      displayName: 'PWA Update Player',
      password: 'pwa-update-password',
      confirmPassword: 'pwa-update-password'
    }
  });
  expect(signup.status()).toBe(201);
  await page.addInitScript(() => {
    const loads = Number(sessionStorage.getItem('skyjo-test-page-loads') || '0') + 1;
    sessionStorage.setItem('skyjo-test-page-loads', String(loads));
  });
  await setWorkerVariant(context, skyjoServer.baseURL, 'A');
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await waitForServiceWorkerControl(page);
  await expectActiveWorker(page);

  await setWorkerVariant(context, skyjoServer.baseURL, 'B');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await expectWaitingWorker(page);
  await expect(page.getByTestId('pwa-update-banner')).toContainText('Game protected');
  await expect(page.getByRole('button', { name: 'Update now' })).toHaveCount(0);

  await page.goto(`${skyjoServer.baseURL}/lobby`);
  await expect(page.getByTestId('pwa-update-banner')).toContainText('Game protected');
  await expect(page.getByRole('button', { name: 'Update now' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create Room' }).click();
  const tableChat = page.getByRole('button', { name: /Table Chat/ });
  await expect(tableChat).toBeVisible();
  await tableChat.click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expectWaitingWorker(page);

  await page.goto(`${skyjoServer.baseURL}/`);
  const loadsBeforeApply = Number(await page.evaluate(() => sessionStorage.getItem('skyjo-test-page-loads')));
  const appliedReload = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Update now' }).click();
  await appliedReload;
  await expectActiveWorker(page);
  await expectSessionStorageNumber(page, 'skyjo-test-page-loads', loadsBeforeApply + 1);
  await page.waitForTimeout(750);
  await expectSessionStorageNumber(page, 'skyjo-test-page-loads', loadsBeforeApply + 1);
});

test('test-only activation barrier rejects an unseen successor identity and poisons the run', async ({ context, skyjoServer }) => {
  const token = randomUUID();
  const workers = (['B', 'C', 'D'] as const).map((variant) => ({
    variant,
    buildNonce: randomUUID()
  }));
  try {
    const duplicateBuildNonce = randomUUID();
    const duplicateIdentityInit = await context.request.post(
      testPwaActivationBarrierUrl(skyjoServer.baseURL, 'init'),
      {
        data: {
          token: randomUUID(),
          workers: (['B', 'C', 'D'] as const).map((variant) => ({
            variant,
            buildNonce: duplicateBuildNonce
          }))
        }
      }
    );
    expect(duplicateIdentityInit.status()).toBe(400);
    await expect(initializeTestPwaActivationBarrier(
      context,
      skyjoServer.baseURL,
      token,
      workers
    )).resolves.toMatchObject({ poisoned: false, workers: [] });
    const unseenArrival = await context.request.post(
      testPwaActivationBarrierUrl(skyjoServer.baseURL, 'arrive'),
      {
        data: {
          token,
          variant: 'B',
          buildNonce: randomUUID(),
          instanceNonce: 'a'.repeat(32)
        }
      }
    );
    expect(unseenArrival.status()).toBe(409);
    await expect(testPwaActivationBarrierStatus(
      context,
      skyjoServer.baseURL,
      token
    )).resolves.toEqual({
      arrivals: [],
      pending: [],
      poisoned: true,
      released: [],
      workers: []
    });
  } finally {
    await cleanupTestPwaActivationBarrier(context, skyjoServer.baseURL, token);
  }
});

test('cross-tab activation never reloads a protected game and preserves one safe reload prompt', async ({ context, page, skyjoServer }) => {
  const activationBarrierToken = randomUUID();
  const workerBuildNonces = {
    A: randomUUID(),
    B: randomUUID(),
    C: randomUUID(),
    D: randomUUID()
  } satisfies Record<TestPwaWorkerVariant, string>;
  const expectedSuccessors = (['B', 'C', 'D'] as const).map((variant) => ({
    variant,
    buildNonce: workerBuildNonces[variant]
  }));
  await context.addCookies([{
    name: 'skyjo_sw_test_activation_barrier',
    value: activationBarrierToken,
    url: skyjoServer.baseURL,
    sameSite: 'Lax'
  }]);

  try {
    await expect(initializeTestPwaActivationBarrier(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      expectedSuccessors
    )).resolves.toEqual({
      arrivals: [],
      pending: [],
      poisoned: false,
      released: [],
      workers: []
    });
    await page.addInitScript(() => {
      const loads = Number(sessionStorage.getItem('skyjo-cross-tab-loads') || '0') + 1;
      sessionStorage.setItem('skyjo-cross-tab-loads', String(loads));
    });
    await setWorkerVariant(context, skyjoServer.baseURL, 'A', workerBuildNonces.A);
    await page.goto(`${skyjoServer.baseURL}/single-player`);
    await waitForServiceWorkerControl(page);
    await expectActiveWorker(page);
    const protectedLoads = Number(await page.evaluate(() => sessionStorage.getItem('skyjo-cross-tab-loads')));

    const updater = await context.newPage();
    await updater.addInitScript(() => {
      const loads = Number(sessionStorage.getItem('skyjo-updater-loads') || '0') + 1;
      sessionStorage.setItem('skyjo-updater-loads', String(loads));
    });
    await updater.goto(`${skyjoServer.baseURL}/`);
    await setWorkerVariant(context, skyjoServer.baseURL, 'B', workerBuildNonces.B);
    await updater.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await expectWaitingWorker(updater);
    const updaterLoads = Number(await updater.evaluate(() => sessionStorage.getItem('skyjo-updater-loads')));

    // WebKit may suspend the protected background page, so the foreground
    // updater retains exact worker objects while the test server gates activation.
    await updater.bringToFront();
    const successorHarnessReady = await updater.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const initialTarget = registration.waiting;
      if (!initialTarget) throw new Error('Initial update target was not waiting.');
      const harnessWindow = window as typeof window & {
        __skyjoSuccessorHarness?: TestPwaSuccessorHarness;
      };
      if (harnessWindow.__skyjoSuccessorHarness) {
        throw new Error('Successor harness was already installed.');
      }
      harnessWindow.__skyjoSuccessorHarness = {
        variants: ['B'],
        workers: [initialTarget]
      };
      return {
        marker: 'skyjo-successor-harness-ready',
        targetState: initialTarget.state,
        workerCount: 1
      };
    });
    expect(successorHarnessReady).toEqual({
      marker: 'skyjo-successor-harness-ready',
      targetState: 'installed',
      workerCount: 1
    });

    const updateButton = updater.getByRole('button', { name: 'Update now' });
    await updateButton.evaluate((button: HTMLButtonElement) => button.click());
    await expect(updater.getByRole('button', { name: 'Updating...' })).toBeDisabled();

    await expectTestPwaActivationArrivals(context, skyjoServer.baseURL, activationBarrierToken, ['B']);
    await expect(installTestPwaSuccessor(updater, 'C', workerBuildNonces.C)).resolves.toEqual({ state: 'installed', variant: 'C' });
    const releasedB = await releaseTestPwaActivation(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      'B'
    );
    expect(releasedB).toMatchObject({
      arrivals: ['B'],
      pending: [],
      poisoned: false,
      released: ['B']
    });

    await expectTestPwaActivationArrivals(context, skyjoServer.baseURL, activationBarrierToken, ['B', 'C']);
    await expect(installTestPwaSuccessor(updater, 'D', workerBuildNonces.D)).resolves.toEqual({ state: 'installed', variant: 'D' });
    const releasedC = await releaseTestPwaActivation(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      'C'
    );
    expect(releasedC).toMatchObject({
      arrivals: ['B', 'C'],
      pending: [],
      poisoned: false,
      released: ['B', 'C']
    });

    await expectTestPwaActivationArrivals(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      ['B', 'C', 'D']
    );
    const activationStatus = await testPwaActivationBarrierStatus(
      context,
      skyjoServer.baseURL,
      activationBarrierToken
    );
    expect(activationStatus).not.toBeNull();
    expect(activationStatus?.workers.map(({ variant, buildNonce }) => ({ variant, buildNonce }))).toEqual(
      expectedSuccessors
    );
    expect(new Set(activationStatus?.workers.map(({ instanceNonce }) => instanceNonce)).size).toBe(3);
    const releasedWorkerD = activationStatus?.workers.find(({ variant }) => variant === 'D');
    expect(releasedWorkerD).toBeDefined();
    const identityEvidence = await updater.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __skyjoSuccessorHarness?: TestPwaSuccessorHarness;
      };
      const harness = harnessWindow.__skyjoSuccessorHarness;
      if (!harness) throw new Error('Successor harness disappeared before identity validation.');
      const [workerB, workerC, workerD] = harness.workers;
      return {
        heldSuccessorState: workerD?.state ?? null,
        successorCIsDistinct: Boolean(workerB && workerC && workerC !== workerB),
        successorDIsDistinct: Boolean(
          workerB && workerC && workerD && workerD !== workerB && workerD !== workerC
        ),
        variants: harness.variants,
        workerCount: harness.workers.length
      };
    });
    const harnessCleanupComplete = await updater.evaluate(() => {
      const harnessWindow = window as typeof window & {
        __skyjoSuccessorHarness?: TestPwaSuccessorHarness;
      };
      delete harnessWindow.__skyjoSuccessorHarness;
      return !('__skyjoSuccessorHarness' in harnessWindow);
    });
    const updaterLoadsBeforeFinalRelease = Number(
      await updater.evaluate(() => sessionStorage.getItem('skyjo-updater-loads'))
    );
    expect({
      activationStatus,
      harnessCleanupComplete,
      updaterLoadsBeforeFinalRelease,
      ...identityEvidence
    }).toEqual({
      activationStatus: {
        arrivals: ['B', 'C', 'D'],
        pending: ['D'],
        poisoned: false,
        released: ['B', 'C'],
        workers: activationStatus?.workers
      },
      heldSuccessorState: 'activating',
      harnessCleanupComplete: true,
      successorCIsDistinct: true,
      successorDIsDistinct: true,
      updaterLoadsBeforeFinalRelease: updaterLoads,
      variants: ['B', 'C', 'D'],
      workerCount: 3
    });

    const updaterReload = updater.waitForNavigation({ waitUntil: 'domcontentloaded' });
    const releasedD = await releaseTestPwaActivation(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      'D'
    );
    expect(releasedD).toMatchObject({
      arrivals: ['B', 'C', 'D'],
      pending: [],
      poisoned: false,
      released: ['B', 'C', 'D']
    });
    await updaterReload;
    // Keep the activating tab strict: every queued successor must be drained,
    // and the released D identity must be the exact active controller.
    await expectActiveWorker(updater);
    const finalControllerIdentity = await activeControllerIdentity(updater);
    expect(finalControllerIdentity).toMatchObject({
      controllerIsActive: true,
      identity: {
        variant: 'D',
        buildNonce: releasedWorkerD?.buildNonce
      }
    });
    expect(finalControllerIdentity.identity?.instanceNonce).toMatch(/^[a-f0-9]{32}$/);
    await expect(updater.getByTestId('pwa-update-banner')).toHaveCount(0);
    await expect(updater.getByRole('button', { name: /Updating|Update now|Reload now/ })).toHaveCount(0);
    await expectSessionStorageNumber(updater, 'skyjo-updater-loads', updaterLoads + 1);
    await updater.waitForTimeout(750);
    await expectSessionStorageNumber(updater, 'skyjo-updater-loads', updaterLoads + 1);

    // WebKit can retain an observer-local installing/waiting reference after the
    // newly activated worker already controls this protected tab. That successor
    // must not weaken any of the protected-game reload and action invariants below.
    await expectProtectedObserverControlledByActiveWorker(page);
    expect(await page.evaluate(() => Number(sessionStorage.getItem('skyjo-cross-tab-loads')))).toBe(protectedLoads);
    await expect(page.getByTestId('pwa-update-banner')).toContainText('Game protected');
    await expect(page.getByRole('button', { name: /Reload now|Update now/ })).toHaveCount(0);

    await page.getByRole('link', { name: 'Back to home' }).click();
    await expect(page.getByRole('button', { name: 'Reload now' })).toBeVisible();
    const loadsBeforeReload = Number(await page.evaluate(() => sessionStorage.getItem('skyjo-cross-tab-loads')));
    const protectedReload = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Reload now' }).click();
    await protectedReload;
    await expectSessionStorageNumber(page, 'skyjo-cross-tab-loads', loadsBeforeReload + 1);
    await page.waitForTimeout(750);
    await expectSessionStorageNumber(page, 'skyjo-cross-tab-loads', loadsBeforeReload + 1);
  } finally {
    await cleanupTestPwaActivationBarrier(context, skyjoServer.baseURL, activationBarrierToken);
  }
});
