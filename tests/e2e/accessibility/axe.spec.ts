import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((violation) =>
    violation.impact === 'serious' || violation.impact === 'critical'
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test('home page has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Skyjo' })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test('solo table has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 60);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test('eight-player centered table has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 70);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await settings
    .getByRole('group', { name: 'Choose AI opponent count' })
    .getByRole('button', { name: '7', exact: true })
    .click();
  await expectNoBlockingViolations(page);
  await page.waitForTimeout(250);
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8');
  await expectNoBlockingViolations(page);
});

test('saved-game choice has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 76);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('skyjo-pwa', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction('soloSessions');
              const records = transaction.objectStore('soloSessions').count();
              records.onerror = () => reject(records.error);
              records.onsuccess = () => {
                resolve(records.result);
                database.close();
              };
            };
          })
      )
    )
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Continue your solo game?' })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test('multiplayer lobby and waiting room have no serious or critical Axe violations', async ({ context, page, skyjoServer }) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const signup = await context.request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email: `axe-${suffix}@example.test`,
      displayName: 'Axe Tester',
      password: 'axe-test-password',
      confirmPassword: 'axe-test-password'
    }
  });
  expect(signup.status()).toBe(201);
  await page.goto(`${skyjoServer.baseURL}/lobby`);
  await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
  await expectNoBlockingViolations(page);

  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.locator('.skyjo-room-code')).toBeVisible();
  await expectNoBlockingViolations(page);
});
