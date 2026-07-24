import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const audioCuePaths = ['/audio/card-flip.mp3', '/audio/card-pickup.mp3', '/audio/card-place.mp3'];
const safeCachedPath = /^(?:\/offline\.html|\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|\/audio\/card-(?:flip|pickup|place)\.mp3|\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;
type TestPwaWorkerVariant = 'A' | 'B' | 'C' | 'D' | 'E';
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

function testWorkerBuildId(buildNonce: string) {
  return createHash('sha256').update(`skyjo-test-worker:${buildNonce}`, 'utf8').digest('hex');
}

async function logicalServiceWorkerSettlement(page: Page, expectedBuildId: string) {
  return page.evaluate(async (expected) => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const controller = navigator.serviceWorker.controller;
    const identify = async (worker: ServiceWorker | null) => {
      if (!worker) return null;
      return new Promise<string | null>((resolve) => {
        const channel = new MessageChannel();
        const requestId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        let settled = false;
        const finish = (buildId: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          channel.port1.onmessage = null;
          channel.port1.close();
          resolve(buildId);
        };
        const timeout = window.setTimeout(() => finish(null), 2_000);
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
              typeof value.buildId === 'string' &&
              /^[a-f0-9]{64}$/.test(value.buildId)
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
    };
    const active = registration?.active || null;
    const waiting = registration?.waiting || null;
    const [activeBuildId, waitingBuildId] = await Promise.all([
      identify(active),
      identify(waiting)
    ]);
    const controllerIsActive = Boolean(active && controller === active);
    const rawSettled = !registration?.installing && !waiting;
    const equivalentWaiting = Boolean(
      waiting?.state === 'installed' &&
      activeBuildId === expected &&
      waitingBuildId === expected
    );
    return {
      active: active?.state ?? null,
      activeBuildId,
      controller: controller?.state ?? null,
      controllerIsActive,
      installing: registration?.installing?.state ?? null,
      logicallySettled: controllerIsActive && (rawSettled || equivalentWaiting),
      waiting: waiting?.state ?? null,
      waitingBuildId
    };
  }, expectedBuildId).catch(() => null);
}

async function expectLogicallySettledWorker(page: Page, expectedBuildId: string) {
  await expect.poll(() => logicalServiceWorkerSettlement(page, expectedBuildId), {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000]
  }).toMatchObject({
    active: 'activated',
    activeBuildId: expectedBuildId,
    controller: 'activated',
    controllerIsActive: true,
    installing: null,
    logicallySettled: true
  });
  const settled = await logicalServiceWorkerSettlement(page, expectedBuildId);
  expect(settled).not.toBeNull();
  expect([null, 'installed']).toContain(settled?.waiting);
  if (settled?.waiting === 'installed') expect(settled.waitingBuildId).toBe(expectedBuildId);
  return settled;
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
  buildNonce: string
) {
  await context.addCookies([
    {
      name: 'skyjo_sw_test_variant',
      value: variant,
      url: baseURL,
      sameSite: 'Lax'
    },
    {
      name: 'skyjo_sw_test_worker_nonce',
      value: buildNonce,
      url: baseURL,
      sameSite: 'Lax'
    }
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

async function startTestPwaActivationBarrier(context: BrowserContext, baseURL: string, token: string) {
  const response = await context.request.post(testPwaActivationBarrierUrl(baseURL, 'start'), {
    data: { token }
  });
  if (!response.ok()) throw new Error(`Activation barrier start failed with ${response.status()}.`);
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

async function switchTestPwaWorkerLeaseToE(
  context: BrowserContext,
  baseURL: string,
  token: string,
  buildNonce: string
) {
  const response = await context.request.post(testPwaActivationBarrierUrl(baseURL, 'lease'), {
    data: { token, variant: 'E', buildNonce }
  });
  if (!response.ok()) throw new Error(`Test worker lease switch failed with ${response.status()}.`);
  return response.json() as Promise<{ variant: 'E'; buildNonce: string }>;
}

async function fetchCookielessTestWorkerSource(baseURL: string) {
  const response = await fetch(`${baseURL}/sw.js`, { headers: { Accept: 'application/javascript' } });
  if (!response.ok) throw new Error(`Cookieless test worker fetch failed with ${response.status}.`);
  return response.text();
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
    const workerSourceResponse = await fetch(`${skyjoServer.baseURL}/sw.js`);
    expect(workerSourceResponse.ok).toBe(true);
    const workerSource = await workerSourceResponse.text();
    const manifestMatch = workerSource.match(/const precacheEntries = (\[[^\n;]+\]);/);
    expect(manifestMatch, 'Generated service worker must expose the injected Workbox manifest.').not.toBeNull();
    const precacheEntries = JSON.parse(manifestMatch?.[1] || '[]') as Array<{ revision?: string | null; url: string }>;
    const audioManifestEntries = precacheEntries
      .map((entry) => ({ ...entry, path: `/${entry.url.replace(/^\/+/, '')}` }))
      .filter((entry) => entry.path.endsWith('.mp3'))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(audioManifestEntries.map((entry) => entry.path)).toEqual([...audioCuePaths].sort());
    for (const entry of audioManifestEntries) {
      expect(entry.revision).toMatch(/^[a-f0-9]{32}$/);
      const builtBytes = await readFile(path.resolve('dist', entry.path.slice(1)));
      expect(entry.revision).toBe(createHash('md5').update(builtBytes).digest('hex'));
    }

    const loginResponse = await page.goto(`${skyjoServer.baseURL}/login`);
    expect(loginResponse?.headers()['content-security-policy']).toContain("media-src 'self' data:");
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
    const cachedAudioPaths = cacheEvidence.entries
      .filter((entry) => entry.path.endsWith('.mp3'))
      .map((entry) => entry.path)
      .sort();
    expect(cachedAudioPaths).toEqual([...audioCuePaths].sort());
    for (const entry of cacheEvidence.entries) {
      expect(entry.cache).toMatch(/^skyjo-pwa-v2-/);
      expect(entry.path).toMatch(safeCachedPath);
      expect(entry.body).not.toMatch(/poison@example|secret invite|set-cookie|invite-code/i);
      if (entry.path.endsWith('.js')) expect(entry.contentType).toMatch(/javascript/);
      if (entry.path.endsWith('.css')) expect(entry.contentType).toMatch(/^text\/css/);
      if (entry.path.endsWith('.mp3')) expect(entry.contentType).toMatch(/^audio\/mpeg/);
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
    expect(offlineResponse?.headers()['content-security-policy']).toContain("media-src 'self' data:");
    expect(offlineResponse?.headers()['content-security-policy']).not.toContain("'unsafe-inline'");
    await expect(offlineStart.getByRole('heading', { name: 'Skyjo' })).toBeVisible();
    const offlineAudioResults = await offlineStart.evaluate(async (paths) => Promise.all(paths.map(async (audioPath) => {
      const response = await fetch(audioPath, {
        credentials: 'omit',
        redirect: 'error'
      });
      const bytes = await response.arrayBuffer();
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const decodedDuration = await new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`Audio metadata timed out for ${audioPath}.`)), 5_000);
        audio.addEventListener('loadedmetadata', () => {
          window.clearTimeout(timeout);
          resolve(audio.duration);
        }, { once: true });
        audio.addEventListener('error', () => {
          window.clearTimeout(timeout);
          reject(new Error(`Audio metadata failed for ${audioPath}.`));
        }, { once: true });
        audio.src = audioPath;
        audio.load();
      }).finally(() => {
        audio.removeAttribute('src');
        audio.load();
      });
      return {
        bytes: bytes.byteLength,
        contentType: response.headers.get('content-type') || '',
        decodedDuration,
        ok: response.ok,
        redirected: response.redirected
      };
    })), cachedAudioPaths);
    for (const result of offlineAudioResults) {
      expect(result).toMatchObject({
        contentType: expect.stringMatching(/^audio\/mpeg/),
        ok: true,
        redirected: false
      });
      expect(result.bytes).toBeGreaterThan(1_000);
      expect(result.decodedDuration).toBeGreaterThan(0.1);
    }
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
  const workerBuildNonces = { A: randomUUID(), B: randomUUID() } as const;
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
  await setWorkerVariant(context, skyjoServer.baseURL, 'A', workerBuildNonces.A);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await waitForServiceWorkerControl(page);
  await expectActiveWorker(page);

  await setWorkerVariant(context, skyjoServer.baseURL, 'B', workerBuildNonces.B);
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

test('test-only activation barrier requires an absolute start and rejects an unseen successor identity', async ({ context, skyjoServer }) => {
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
    const unstartedToken = randomUUID();
    const unstartedWorkers = (['B', 'C', 'D'] as const).map((variant) => ({
      variant,
      buildNonce: randomUUID()
    }));
    try {
      await initializeTestPwaActivationBarrier(
        context,
        skyjoServer.baseURL,
        unstartedToken,
        unstartedWorkers
      );
      const prematureArrival = await context.request.post(
        testPwaActivationBarrierUrl(skyjoServer.baseURL, 'arrive'),
        {
          data: {
            token: unstartedToken,
            variant: 'B',
            buildNonce: unstartedWorkers[0].buildNonce,
            instanceNonce: 'b'.repeat(32)
          }
        }
      );
      expect(prematureArrival.status()).toBe(409);
      await expect(testPwaActivationBarrierStatus(
        context,
        skyjoServer.baseURL,
        unstartedToken
      )).resolves.toMatchObject({ poisoned: true, workers: [] });
    } finally {
      await cleanupTestPwaActivationBarrier(context, skyjoServer.baseURL, unstartedToken);
    }
    await expect(initializeTestPwaActivationBarrier(
      context,
      skyjoServer.baseURL,
      token,
      workers
    )).resolves.toMatchObject({ poisoned: false, workers: [] });
    await expect(startTestPwaActivationBarrier(
      context,
      skyjoServer.baseURL,
      token
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
    D: randomUUID(),
    E: randomUUID()
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
      if (sessionStorage.getItem('skyjo-updater-reprompt-watch') === 'armed') {
        sessionStorage.setItem('skyjo-updater-reprompt-watch', 'watching');
        const elementContainsUpdatePrompt = (element: Element | null) => {
          if (!element) return false;
          const candidates = element.matches('[data-testid="pwa-update-banner"], button')
            ? [element, ...element.querySelectorAll('[data-testid="pwa-update-banner"], button')]
            : [...element.querySelectorAll('[data-testid="pwa-update-banner"], button')];
          return candidates.some((candidate) => (
            candidate.matches('[data-testid="pwa-update-banner"]') ||
            /^(?:Updating\.\.\.|Update now|Reload now)$/.test(candidate.textContent?.trim() || '')
          ));
        };
        const nodeContainsUpdatePrompt = (node: Node) => {
          const element = node instanceof Element ? node : node.parentElement;
          return element ? elementContainsUpdatePrompt(element) : false;
        };
        const recordUpdatePrompt = (records: MutationRecord[] = []) => {
          const mutationContainedPrompt = records.some((record) => (
            [...record.addedNodes].some(nodeContainsUpdatePrompt) ||
            (record.type === 'characterData' && nodeContainsUpdatePrompt(record.target))
          ));
          if (mutationContainedPrompt || elementContainsUpdatePrompt(document.documentElement)) {
            sessionStorage.setItem('skyjo-updater-reprompt-observed', 'true');
          }
        };
        new MutationObserver(recordUpdatePrompt).observe(document, {
          childList: true,
          characterData: true,
          subtree: true
        });
        recordUpdatePrompt();
      }
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

    await expect(startTestPwaActivationBarrier(
      context,
      skyjoServer.baseURL,
      activationBarrierToken
    )).resolves.toEqual({
      arrivals: [],
      pending: [],
      poisoned: false,
      released: [],
      workers: []
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
        heldSuccessorObserverState: workerD?.state ?? null,
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
    expect(['installed', 'activating']).toContain(identityEvidence.heldSuccessorObserverState);
    expect({
      activationStatus,
      harnessCleanupComplete,
      updaterLoadsBeforeFinalRelease,
      successorCIsDistinct: identityEvidence.successorCIsDistinct,
      successorDIsDistinct: identityEvidence.successorDIsDistinct,
      variants: identityEvidence.variants,
      workerCount: identityEvidence.workerCount
    }).toEqual({
      activationStatus: {
        arrivals: ['B', 'C', 'D'],
        pending: ['D'],
        poisoned: false,
        released: ['B', 'C'],
        workers: activationStatus?.workers
      },
      harnessCleanupComplete: true,
      successorCIsDistinct: true,
      successorDIsDistinct: true,
      updaterLoadsBeforeFinalRelease: updaterLoads,
      variants: ['B', 'C', 'D'],
      workerCount: 3
    });

    await updater.evaluate(() => {
      sessionStorage.removeItem('skyjo-updater-reprompt-observed');
      sessionStorage.setItem('skyjo-updater-reprompt-watch', 'armed');
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
    const leasedDSource = await fetchCookielessTestWorkerSource(skyjoServer.baseURL);
    expect(leasedDSource).toContain('const version="D";');
    expect(leasedDSource).toContain(`const workerBuildNonce=${JSON.stringify(workerBuildNonces.D)};`);
    expect(leasedDSource).toContain(
      `const activationBarrierToken=${JSON.stringify(activationBarrierToken)};`
    );
    await updaterReload;
    // Keep the activating tab strict: raw drain and an observer-local same-build
    // D waiter are both settled, but the exact active controller must be D.
    const expectedDBuildId = testWorkerBuildId(workerBuildNonces.D);
    await expectLogicallySettledWorker(updater, expectedDBuildId);
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
    const settledAfterObservationWindow = await expectLogicallySettledWorker(updater, expectedDBuildId);
    await expect(updater.getByTestId('pwa-update-banner')).toHaveCount(0);
    await expect(updater.getByRole('button', { name: /Updating|Update now|Reload now/ })).toHaveCount(0);
    expect(await updater.evaluate(() => ({
      observed: sessionStorage.getItem('skyjo-updater-reprompt-observed'),
      watch: sessionStorage.getItem('skyjo-updater-reprompt-watch')
    }))).toEqual({ observed: null, watch: 'watching' });
    await expectSessionStorageNumber(updater, 'skyjo-updater-loads', updaterLoads + 1);

    await expect(switchTestPwaWorkerLeaseToE(
      context,
      skyjoServer.baseURL,
      activationBarrierToken,
      workerBuildNonces.E
    )).resolves.toEqual({ variant: 'E', buildNonce: workerBuildNonces.E });
    const leasedESource = await fetchCookielessTestWorkerSource(skyjoServer.baseURL);
    expect(leasedESource).toContain('const version="E";');
    expect(leasedESource).toContain(`const workerBuildNonce=${JSON.stringify(workerBuildNonces.E)};`);
    expect(leasedESource).toContain(
      `const activationBarrierToken=${JSON.stringify(activationBarrierToken)};`
    );
    await setWorkerVariant(context, skyjoServer.baseURL, 'E', workerBuildNonces.E);
    await updater.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await expectWaitingWorker(updater);
    await expect(updater.getByRole('button', { name: 'Update now' })).toBeVisible();
    const distinctE = await logicalServiceWorkerSettlement(updater, expectedDBuildId);
    expect(distinctE).toMatchObject({
      activeBuildId: expectedDBuildId,
      controllerIsActive: true,
      logicallySettled: false,
      waiting: 'installed',
      waitingBuildId: testWorkerBuildId(workerBuildNonces.E)
    });
    expect(settledAfterObservationWindow?.activeBuildId).toBe(expectedDBuildId);

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
