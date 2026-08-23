import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { classifyCredentiallessRequest, type CredentiallessRequestRejection } from '../../helpers/credentiallessRequestPolicy';

const safeCachedPath = /^(?:\/offline\.html|\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)|\/audio\/card-(?:flip|pickup|place)\.mp3|\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg))$/;

test.use({ screenshot: 'off', serviceWorkers: 'allow', trace: 'off', video: 'off' });

function productionIdentity() {
  const configuredBaseURL = String(process.env.SKYJO_PUBLIC_PWA_BASE_URL || '').trim();
  const releaseSha = String(process.env.SKYJO_EXPECTED_RELEASE_SHA || '').trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(configuredBaseURL);
  } catch {
    throw new Error('Public PWA smoke requires a simple HTTPS production origin.');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Public PWA smoke requires a simple HTTPS production origin.');
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
    throw new Error('Public PWA smoke requires an exact release SHA.');
  }
  return { baseURL: url.origin, releaseSha };
}

async function waitForServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller === registration.active) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Service worker control timed out.')), 15_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  });
}

async function guestSessionFingerprint(page: Page) {
  return page.evaluate(async () => new Promise<{ gameId: string; state: string }>((resolve, reject) => {
    const open = indexedDB.open('skyjo-pwa', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const query = database.transaction('soloSessions').objectStore('soloSessions').index('byOwner').getAll('guest');
      query.onerror = () => reject(query.error);
      query.onsuccess = () => {
        const records = query.result;
        database.close();
        if (records.length !== 1) {
          reject(new Error('Expected one disposable guest solo session.'));
          return;
        }
        resolve({ gameId: String(records[0].gameId), state: JSON.stringify(records[0].state) });
      };
    };
  }));
}

async function assertCredentiallessContext(context: BrowserContext) {
  if ((await context.cookies()).length !== 0) throw new Error('Credentialless PWA smoke created a cookie.');
}

async function assertSafeCaches(page: Page) {
  const result = await page.evaluate(async () => {
    const keys = await caches.keys();
    const entries: Array<{ cache: string; path: string; search: string; setCookie: string | null }> = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const url = new URL(request.url);
        entries.push({
          cache: key,
          path: url.pathname,
          search: url.search,
          setCookie: response?.headers.get('set-cookie') ?? null
        });
      }
    }
    return { entries, keys };
  });
  if (result.keys.length !== 1 || !result.keys[0].startsWith('skyjo-pwa-v2-')) {
    throw new Error('Production PWA cache identity is not the single current release cache.');
  }
  if (result.entries.length < 5) throw new Error('Production PWA precache is unexpectedly empty.');
  for (const entry of result.entries) {
    if (
      entry.cache !== result.keys[0] ||
      entry.search !== '' ||
      entry.setCookie !== null ||
      !safeCachedPath.test(entry.path)
    ) {
      throw new Error('Production PWA cache contains a non-public or stateful response.');
    }
  }
}

test('exact production release cold-launches and restores a disposable guest solo game offline', async ({ browser, request }) => {
  test.setTimeout(60_000);
  const { baseURL, releaseSha } = productionIdentity();
  const [readyResponse, versionResponse] = await Promise.all([
    request.get(`${baseURL}/readyz`),
    request.get(`${baseURL}/version`)
  ]);
  if (!readyResponse.ok() || !versionResponse.ok()) throw new Error('Public release identity endpoints are unavailable.');
  const [ready, version] = await Promise.all([readyResponse.json(), versionResponse.json()]);
  if (
    ready.status !== 'ready' ||
    ready.releaseSha !== releaseSha ||
    ready.schemaVersion !== 2 ||
    ready.protocolVersion !== 2 ||
    version.releaseSha !== releaseSha ||
    version.protocolVersion !== 2
  ) {
    throw new Error('Public PWA smoke reached a different release identity.');
  }

  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const rejectedRequests = new Set<CredentiallessRequestRejection>();
  context.on('request', (browserRequest) => {
    const decision = classifyCredentiallessRequest({
      baseOrigin: baseURL,
      method: browserRequest.method(),
      resourceType: browserRequest.resourceType(),
      url: browserRequest.url()
    });
    if (!decision.allowed) rejectedRequests.add(decision.reason);
  });
  try {
    const bootstrap = await context.newPage();
    const login = await bootstrap.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    if (login?.status() !== 200) throw new Error('Credentialless PWA bootstrap page is unavailable.');
    await bootstrap.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    });
    await waitForServiceWorkerControl(bootstrap);
    await assertCredentiallessContext(context);
    await assertSafeCaches(bootstrap);
    await bootstrap.close();

    await context.setOffline(true);
    const offlineStart = await context.newPage();
    await offlineStart.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(offlineStart.getByRole('heading', { name: 'Flipvale' })).toBeVisible();
    await offlineStart.getByRole('link', { name: /^Start Solo Game/ }).click();
    await expect(offlineStart.getByTestId('solo-game-setup')).toBeVisible();
    await offlineStart.getByRole('button', { name: 'Start Solo Game' }).click();
    await expect(offlineStart.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    await expect.poll(async () => guestSessionFingerprint(offlineStart).then(() => true, () => false)).toBe(true);
    const beforeClose = await guestSessionFingerprint(offlineStart);
    await offlineStart.close();

    const restored = await context.newPage();
    await restored.goto(`${baseURL}/single-player`, { waitUntil: 'domcontentloaded' });
    await expect(restored.getByTestId('solo-launcher')).toBeVisible();
    const beforeContinue = await guestSessionFingerprint(restored);
    if (beforeContinue.gameId !== beforeClose.gameId || beforeContinue.state !== beforeClose.state) {
      throw new Error('Offline cold launch did not preserve the disposable solo session.');
    }
    await restored.getByRole('button', { name: 'Continue Solo' }).click();
    await expect(restored.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    const afterContinue = await guestSessionFingerprint(restored);
    if (afterContinue.gameId !== beforeClose.gameId || afterContinue.state !== beforeClose.state) {
      throw new Error('Offline Continue did not restore the exact disposable solo session.');
    }
    await assertSafeCaches(restored);
    await assertCredentiallessContext(context);
    if (rejectedRequests.size !== 0) {
      throw new Error(
        `Credentialless PWA smoke attempted a rejected request (${[...rejectedRequests].sort().join(', ')}).`
      );
    }
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await context.close();
  }
});
