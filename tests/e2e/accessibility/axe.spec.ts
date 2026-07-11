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
