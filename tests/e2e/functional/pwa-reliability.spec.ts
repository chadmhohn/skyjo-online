import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const safeCachedPath = /^(?:\/offline\.html|\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;

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

async function setWorkerVariant(context: BrowserContext, baseURL: string, variant: 'A' | 'B') {
  await context.addCookies([{
    name: 'skyjo_sw_test_variant',
    value: variant,
    url: baseURL,
    sameSite: 'Lax'
  }]);
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

test('cross-tab activation never reloads a protected game and preserves one safe reload prompt', async ({ context, page, skyjoServer }) => {
  await page.addInitScript(() => {
    const loads = Number(sessionStorage.getItem('skyjo-cross-tab-loads') || '0') + 1;
    sessionStorage.setItem('skyjo-cross-tab-loads', String(loads));
  });
  await setWorkerVariant(context, skyjoServer.baseURL, 'A');
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await waitForServiceWorkerControl(page);
  await expectActiveWorker(page);
  const protectedLoads = Number(await page.evaluate(() => sessionStorage.getItem('skyjo-cross-tab-loads')));

  const updater = await context.newPage();
  await updater.goto(`${skyjoServer.baseURL}/`);
  await setWorkerVariant(context, skyjoServer.baseURL, 'B');
  await updater.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await Promise.all([registration.update(), registration.update(), registration.update()]);
  });
  await expectWaitingWorker(updater);
  const updaterReload = updater.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await updater.getByRole('button', { name: 'Update now' }).click();
  await updaterReload;
  // Keep the activating tab strict: a successor here is a genuine second update.
  await expectActiveWorker(updater);

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
});
