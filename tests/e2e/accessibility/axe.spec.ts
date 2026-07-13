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
  await page.waitForTimeout(250);
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8');
  await expectNoBlockingViolations(page);
});
