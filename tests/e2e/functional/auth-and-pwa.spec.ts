import { expect, test } from '../fixtures';
import { completedSoloGameState } from '../../helpers/soloGameState';
import { startFreshSoloGame } from '../helpers/soloFlow';

const firstGameId = '11111111-1111-4111-8111-111111111111';
const equalScoreGameId = '22222222-2222-4222-8222-222222222222';

async function ownerRecordCount(
  page: import('@playwright/test').Page,
  storeName: 'soloSessions' | 'statsOutbox',
  ownerKey: string
): Promise<number> {
  return page.evaluate(
    async ({ databaseName, owner, store }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.addEventListener('error', () => reject(request.error), { once: true });
        request.addEventListener(
          'success',
          () => {
            const database = request.result;
            const transaction = database.transaction(store, 'readonly');
            const count = transaction.objectStore(store).index('byOwner').count(owner);
            count.addEventListener('success', () => resolve(count.result), { once: true });
            count.addEventListener('error', () => reject(count.error), { once: true });
            transaction.addEventListener('complete', () => database.close(), { once: true });
          },
          { once: true }
        );
      }),
    { databaseName: 'skyjo-pwa', owner: ownerKey, store: storeName }
  );
}

function statsOutboxCount(page: import('@playwright/test').Page, ownerKey: string): Promise<number> {
  return ownerRecordCount(page, 'statsOutbox', ownerKey);
}

async function statsOutboxAttempts(page: import('@playwright/test').Page, ownerKey: string): Promise<number> {
  return page.evaluate(
    async ({ owner }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('skyjo-pwa', 1);
        request.addEventListener('error', () => reject(request.error), { once: true });
        request.addEventListener(
          'success',
          () => {
            const database = request.result;
            const transaction = database.transaction('statsOutbox', 'readonly');
            const records = transaction.objectStore('statsOutbox').index('byOwner').getAll(owner);
            records.addEventListener('success', () => resolve(Number(records.result[0]?.attempts || 0)), { once: true });
            records.addEventListener('error', () => reject(records.error), { once: true });
            transaction.addEventListener('complete', () => database.close(), { once: true });
          },
          { once: true }
        );
      }),
    { owner: ownerKey }
  );
}

test('home, account signup, safe return paths, and authenticated account shell work together', async ({ page, skyjoServer }) => {
  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Flipvale' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Start Solo Game/ })).toBeVisible();

  await page.goto(`${skyjoServer.baseURL}/account?next=/account`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill('playwright@example.test');
  await page.getByLabel('Display name').fill('Playwright Player');
  await page.getByLabel('Password', { exact: true }).fill('playwright-secret-123');
  await page.getByLabel('Confirm password').fill('playwright-secret-123');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Playwright Player')).toBeVisible();

  expect((await page.context().request.post(`${skyjoServer.baseURL}/api/account/logout`)).status()).toBe(200);
  await page.goto(`${skyjoServer.baseURL}/account?next=${encodeURIComponent('/\\evil.example')}`);
  await page.getByLabel('Email').fill('playwright@example.test');
  await page.getByLabel('Password').fill('playwright-secret-123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(`${skyjoServer.baseURL}/`);
});

test('manifest and service worker assets are release-build reachable', async ({ request, skyjoServer }) => {
  const manifest = await request.get(`${skyjoServer.baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const payload = await manifest.json();
  expect(payload).toMatchObject({
    name: expect.any(String),
    display: 'standalone',
    id: '/',
    scope: '/',
    start_url: '/'
  });
  expect(payload.icons.length).toBeGreaterThanOrEqual(2);

  const appleIcon = await request.get(`${skyjoServer.baseURL}/skyjo-icon-v2-180.png`);
  expect(appleIcon.ok()).toBe(true);
  expect(appleIcon.headers()['content-type']).toMatch(/^image\/png\b/);
  const iconBytes = await appleIcon.body();
  expect(iconBytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(iconBytes.readUInt32BE(16)).toBe(180);
  expect(iconBytes.readUInt32BE(20)).toBe(180);

  const serviceWorker = await request.get(`${skyjoServer.baseURL}/sw.js`);
  expect(serviceWorker.ok()).toBe(true);
  const serviceWorkerSource = await serviceWorker.text();
  expect(serviceWorkerSource).toContain("addEventListener('push'");
  expect(serviceWorkerSource).toContain("addEventListener('notificationclick'");
  expect(serviceWorkerSource).toContain('Navigation request was unavailable.');
  const precachedAudioPaths = [...serviceWorkerSource.matchAll(/"url":"(audio\/[^"]+\.(?:mp3|wav))"/g)]
    .map((match) => `/${match[1]}`)
    .sort();
  expect(precachedAudioPaths).toEqual([
    '/audio/card-flip.wav',
    '/audio/card-pickup.mp3',
    '/audio/card-place.mp3'
  ]);
  expect(serviceWorkerSource).not.toContain('table-ambience.mp3');
  const originGuardIndex = serviceWorkerSource.indexOf('if (event.origin !== self.location.origin) return;');
  const activationIndex = serviceWorkerSource.indexOf('if (isActivation) {');
  const skipWaitingIndex = serviceWorkerSource.indexOf('void self.skipWaiting().catch(() => {});');
  const graceIndex = serviceWorkerSource.indexOf('setTimeout(resolve, skipWaitingGraceMs)');
  const sourceGuardIndex = serviceWorkerSource.indexOf('if (!event.source) return;');
  const sanitizerIndex = serviceWorkerSource.indexOf("event.data?.type === 'SKYJO_SANITIZE_CACHE'");
  expect(originGuardIndex).toBeGreaterThan(-1);
  expect(activationIndex).toBeGreaterThan(originGuardIndex);
  expect(skipWaitingIndex).toBeGreaterThan(-1);
  expect(graceIndex).toBeGreaterThan(skipWaitingIndex);
  expect(sourceGuardIndex).toBeGreaterThan(activationIndex);
  expect(sanitizerIndex).toBeGreaterThan(sourceGuardIndex);
  expect(serviceWorkerSource).not.toContain('waitUntil(self.skipWaiting())');
});

test('single-player stats deduplicate one UUID without collapsing an equal-score game', async ({ page, skyjoServer }) => {
  const email = `solo-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const account = await page.context().request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email,
      displayName: 'Solo Durable',
      password: 'durable-password',
      confirmPassword: 'durable-password'
    }
  });
  expect(account.status()).toBe(201);

  const accountPayload = await account.json();
  const accountUserId = accountPayload.user.id as string;
  const state = completedSoloGameState(1, () => 0.35);
  const completedAt = Date.now() - 60_000;
  const missingExpectedAccount = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: 'missing-expected-account', completedAt }
  });
  const malformedExpectedAccount = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: 'malformed-expected-account', completedAt, expectedAccountUserId: 'not-a-uuid' }
  });
  const changedAccount = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: {
      state,
      clientGameKey: 'changed-account',
      completedAt,
      expectedAccountUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    }
  });
  expect(missingExpectedAccount.status()).toBe(426);
  expect(await missingExpectedAccount.json()).toEqual({
    code: 'STATS_CLIENT_UPGRADE_REQUIRED',
    error: 'Update Flipvale before syncing saved game stats.'
  });
  expect(malformedExpectedAccount.status()).toBe(426);
  expect(changedAccount.status()).toBe(409);

  const first = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: firstGameId, completedAt, expectedAccountUserId: accountUserId }
  });
  const duplicate = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: {
      state,
      clientGameKey: firstGameId,
      completedAt: completedAt - 5_000,
      expectedAccountUserId: accountUserId
    }
  });
  const distinct = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: equalScoreGameId, completedAt, expectedAccountUserId: accountUserId }
  });
  const firstPayload = await first.json();
  const duplicatePayload = await duplicate.json();
  const distinctPayload = await distinct.json();

  expect(first.status()).toBe(201);
  expect(duplicate.status()).toBe(201);
  expect(distinct.status()).toBe(201);
  expect(duplicatePayload.game.id).toBe(firstPayload.game.id);
  expect(duplicatePayload.game.completedAt).toBe(completedAt);
  expect(distinctPayload.game.id).not.toBe(firstPayload.game.id);
});

test('a force-closed solo game restores from the last confirmed account partition when account refresh is offline', async ({
  context,
  page,
  skyjoServer
}) => {
  const email = `offline-solo-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const signup = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email,
      displayName: 'Offline Solo',
      password: 'offline-password',
      confirmPassword: 'offline-password'
    }
  });
  expect(signup.status()).toBe(201);
  const offlineUser = (await signup.json()).user as { id: string };
  await startFreshSoloGame(page, skyjoServer.baseURL);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('skyjo:last-confirmed-solo-owner'))).not.toBeNull();
  await expect.poll(() => ownerRecordCount(page, 'soloSessions', `account:${offlineUser.id}`)).toBe(1);
  await page.close();

  const reopened = await context.newPage();
  await reopened.route('**/api/account/me', (route) => route.abort('internetdisconnected'));
  await reopened.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(reopened.getByTestId('solo-launcher')).toBeVisible();
  await expect(reopened.getByRole('heading', { name: 'Your solo table is waiting' })).toBeVisible();
});

test.describe('stale account handoff', () => {
  test.use({ serviceWorkers: 'block' });

  test('a stale account tab cannot attribute queued stats to the replacement account', async ({
    context,
    page,
    skyjoServer
  }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const emailA = `owner-a-${suffix}@example.test`;
  const emailB = `owner-b-${suffix}@example.test`;
  const password = 'account-switch-password';
  const signupA = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: { email: emailA, displayName: 'Owner A', password, confirmPassword: password }
  });
  expect(signupA.status()).toBe(201);
  const userA = (await signupA.json()).user as { id: string };
  const ownerA = `account:${userA.id}`;

  await startFreshSoloGame(page, skyjoServer.baseURL);
  await page.route('**/api/stats/single-player', (route) => route.abort('internetdisconnected'));
  const completedAt = Date.now() - 30_000;
  const state = completedSoloGameState(1, () => 0.35);
  await page.evaluate(
    async ({ record }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('skyjo-pwa', 1);
        request.addEventListener('error', () => reject(request.error), { once: true });
        request.addEventListener(
          'success',
          () => {
            const database = request.result;
            const transaction = database.transaction('statsOutbox', 'readwrite');
            transaction.objectStore('statsOutbox').put(record);
            transaction.addEventListener('complete', () => {
              database.close();
              resolve();
            });
            transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
          },
          { once: true }
        );
      }),
    {
      record: {
        ownerKey: ownerA,
        gameId: firstGameId,
        schemaVersion: 1,
        state,
        attempts: 0,
        createdAt: completedAt,
        updatedAt: completedAt,
        nextAttemptAt: completedAt,
        lastError: ''
      }
    }
  );
  expect(await statsOutboxCount(page, ownerA)).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => statsOutboxAttempts(page, ownerA)).toBe(1);
  await page.unroute('**/api/stats/single-player');

  const background = await context.newPage();
  await background.bringToFront();
  await page.route('**/api/account/me', (route) => route.abort('internetdisconnected'));
  expect((await context.request.post(`${skyjoServer.baseURL}/api/account/logout`)).status()).toBe(200);
  const signupB = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: { email: emailB, displayName: 'Owner B', password, confirmPassword: password }
  });
  expect(signupB.status()).toBe(201);
  const rejectedDelivery = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/stats/single-player') && response.request().method() === 'POST'
  );
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect((await rejectedDelivery).status()).toBe(409);
  await expect.poll(() => statsOutboxCount(page, ownerA)).toBe(1);
  const summaryB = await context.request.get(`${skyjoServer.baseURL}/api/stats/summary`);
  expect((await summaryB.json()).self.singlePlayerGames).toBe(0);

  await page.unroute('**/api/account/me');
  expect((await context.request.post(`${skyjoServer.baseURL}/api/account/logout`)).status()).toBe(200);
  const loginA = await context.request.post(`${skyjoServer.baseURL}/api/account/login`, {
    data: { email: emailA, password }
  });
  expect(loginA.status()).toBe(200);
  await background.bringToFront();
  const acceptedDelivery = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/stats/single-player') && response.request().method() === 'POST'
  );
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect((await acceptedDelivery).status()).toBe(201);
  await expect.poll(() => statsOutboxCount(page, ownerA)).toBe(0);
  await expect
    .poll(async () => {
      const summary = await context.request.get(`${skyjoServer.baseURL}/api/stats/summary`);
      return (await summary.json()).self.singlePlayerGames as number;
    })
    .toBe(1);
  });
});
