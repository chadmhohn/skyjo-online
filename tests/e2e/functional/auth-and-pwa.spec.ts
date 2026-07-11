import { expect, test } from '../fixtures';

test('home, account signup, and authenticated account shell work together', async ({ page, skyjoServer }) => {
  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Skyjo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Single Player' })).toBeVisible();

  await page.goto(`${skyjoServer.baseURL}/account?next=/account`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill('playwright@example.test');
  await page.getByLabel('Display name').fill('Playwright Player');
  await page.getByLabel('Password', { exact: true }).fill('playwright-secret-123');
  await page.getByLabel('Confirm password').fill('playwright-secret-123');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Playwright Player')).toBeVisible();
});

test('manifest and service worker assets are release-build reachable', async ({ request, skyjoServer }) => {
  const manifest = await request.get(`${skyjoServer.baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const payload = await manifest.json();
  expect(payload).toMatchObject({
    name: expect.any(String),
    display: 'standalone'
  });
  expect(payload.icons.length).toBeGreaterThanOrEqual(2);

  const serviceWorker = await request.get(`${skyjoServer.baseURL}/sw.js`);
  expect(serviceWorker.ok()).toBe(true);
  expect(await serviceWorker.text()).toContain("addEventListener('push'");
});
