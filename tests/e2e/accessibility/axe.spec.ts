import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import { finishSoloSetup, startFreshSoloGame } from '../helpers/soloFlow';

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((violation) =>
    violation.impact === 'serious' || violation.impact === 'critical'
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test('home page has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Flipvale' })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test('solo table has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 60);
  await page.setViewportSize({ width: 320, height: 568 });
  await startFreshSoloGame(page, skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)))
    .toBe(32);
  const opponentRail = page.getByRole('region', { name: 'Opponent boards' });
  const activeOpponent = opponentRail.locator(':scope > [data-vertical-scroll-active="true"]');
  await expect(activeOpponent).toHaveCount(1);
  await expect(opponentRail).not.toHaveAttribute('tabindex');
  await expect(activeOpponent).toHaveAttribute('tabindex', '0');
  await expect(activeOpponent).toHaveCSS('overflow-y', 'auto');
  await expect(page.getByRole('region', { name: 'Your board' })).toHaveAttribute('tabindex', '0');
  await expectNoBlockingViolations(page);
});

test('eight-player centered table has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 70);
  await page.setViewportSize({ width: 320, height: 568 });
  await startFreshSoloGame(page, skyjoServer.baseURL, { opponents: 7 });
  await expectNoBlockingViolations(page);
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8');
  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)))
    .toBe(32);
  const opponentRail = page.getByRole('region', { name: 'Opponent boards' });
  const activeOpponent = opponentRail.locator(':scope > [data-vertical-scroll-active="true"]');
  const inactiveOpponents = opponentRail.locator(
    ':scope > [data-player-role="opponent"]:not([data-vertical-scroll-active="true"])'
  );
  await expect(opponentRail).toHaveAttribute('tabindex', '0');
  await expect(activeOpponent).toHaveCount(1);
  await expect(activeOpponent).toHaveAttribute('tabindex', '0');
  await expect(activeOpponent).toHaveCSS('overflow-y', 'auto');
  expect(await activeOpponent.evaluate((board) => board.scrollHeight - board.clientHeight)).toBeGreaterThan(1);
  await expect(inactiveOpponents).toHaveCount(6);
  expect(await inactiveOpponents.evaluateAll((boards) =>
    boards.every((board) => board.getAttribute('tabindex') === '-1')
  )).toBe(true);
  expect(await inactiveOpponents.evaluateAll((boards) =>
    boards.every((board) => window.getComputedStyle(board).overflowY === 'hidden')
  )).toBe(true);
  await expect(page.getByRole('region', { name: 'Your board' })).toHaveAttribute('tabindex', '0');
  await expect(
    page.locator(
      '[data-testid="opponent-rail"][tabindex="0"], ' +
      '[data-testid="opponent-rail"] > [data-player-role="opponent"][tabindex="0"], ' +
      '[data-testid="local-board"][tabindex="0"]'
    )
  ).toHaveCount(3);
  await expectNoBlockingViolations(page);
});

test('three-player compact table exposes both visible opponent boards without Axe violations', async ({
  page,
  skyjoServer
}) => {
  await installSeededBrowserRuntime(page, 71);
  await page.setViewportSize({ width: 320, height: 568 });
  await startFreshSoloGame(page, skyjoServer.baseURL, { opponents: 2 });
  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)))
    .toBe(32);

  const guidance = page.getByRole('region', { name: 'Action guidance' });
  const opponentRail = page.getByRole('region', { name: 'Opponent boards' });
  const opponentBoards = opponentRail.locator(':scope > [data-vertical-scroll-active="true"]');
  const localBoard = page.getByRole('region', { name: 'Your board' });
  await expect(opponentRail).not.toHaveAttribute('tabindex');
  await expect(opponentBoards).toHaveCount(2);
  expect(await opponentBoards.evaluateAll((boards) => boards.every((board) =>
    board.getAttribute('tabindex') === '0' &&
    getComputedStyle(board).overflowY === 'auto' &&
    board.scrollHeight > board.clientHeight + 1
  ))).toBe(true);
  await guidance.focus();
  for (const board of await opponentBoards.all()) {
    await page.keyboard.press('Tab');
    await expect(board).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => board.evaluate((element) =>
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)
    )).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press('Tab');
  await expect(localBoard).toBeFocused();
  await expectNoBlockingViolations(page);
});

test('saved-game choice has no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 76);
  await startFreshSoloGame(page, skyjoServer.baseURL);
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
  await expect(page.getByTestId('solo-launcher')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your solo table is waiting' })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test('solo setup and replacement review have no serious or critical Axe violations', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 77);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByTestId('solo-game-setup')).toBeVisible();
  await expectNoBlockingViolations(page);
  await finishSoloSetup(page);

  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await settings.getByRole('button', { name: /Set up another game/ }).click();
  await expect(page.getByTestId('solo-game-setup')).toBeVisible();
  await page.getByRole('button', { name: 'Review & Start' }).click();
  await expect(page.getByRole('dialog', { name: 'Replace your saved game?' })).toBeVisible();
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
