import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { configureSoloSetup, finishSoloSetup, startFreshSoloGame } from '../helpers/soloFlow';

const viewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1440, height: 900 }
] as const;

const soloFlowViewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 }
] as const;

async function configureSoloRoster(page: Page, playerCount: number) {
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await settings.getByRole('button', { name: 'Set up another game…' }).click();
  await configureSoloSetup(page, { opponents: playerCount - 1 });
  await finishSoloSetup(page);
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

test('single-player table matches canonical responsive baselines', async ({ page, skyjoServer }) => {
  test.setTimeout(90_000);
  test.skip(
    process.platform !== 'linux' && process.env.SKYJO_UPDATE_VISUALS !== '1',
    'Canonical pixel baselines run on ubuntu-24.04; set SKYJO_UPDATE_VISUALS=1 only to refresh them deliberately.'
  );
  await installSeededBrowserRuntime(page, 60);

  await startFreshSoloGame(page, skyjoServer.baseURL);

  for (const playerCount of [2, 4, 8]) {
    await configureSoloRoster(page, playerCount);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const name =
        playerCount === 2
          ? `single-player-${viewport.width}x${viewport.height}.png`
          : `single-player-${playerCount}p-${viewport.width}x${viewport.height}.png`;
      await expect.soft(page, `${playerCount} players at ${viewport.width}x${viewport.height}`).toHaveScreenshot(name, {
        fullPage: true
      });
    }
  }
});

test('saved-aware Home, launcher, and solo setup match canonical responsive baselines', async ({ page, skyjoServer }) => {
  test.setTimeout(60_000);
  test.skip(
    process.platform !== 'linux' && process.env.SKYJO_UPDATE_VISUALS !== '1',
    'Canonical pixel baselines run on ubuntu-24.04; set SKYJO_UPDATE_VISUALS=1 only to refresh them deliberately.'
  );
  await installSeededBrowserRuntime(page, 164);
  await page.clock.setFixedTime(new Date('2026-07-12T12:00:00.000Z'));

  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('link', { name: /^Start Solo Game/ })).toBeVisible();
  for (const viewport of soloFlowViewports) {
    await page.setViewportSize(viewport);
    await expect.soft(page, `fresh Home at ${viewport.width}x${viewport.height}`).toHaveScreenshot(
      `home-fresh-${viewport.width}x${viewport.height}.png`,
      { fullPage: true }
    );
  }

  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await configureSoloSetup(page, { difficulty: 'mixed', opponents: 3 });
  for (const viewport of soloFlowViewports) {
    await page.setViewportSize(viewport);
    await expect.soft(page, `fresh setup at ${viewport.width}x${viewport.height}`).toHaveScreenshot(
      `solo-setup-${viewport.width}x${viewport.height}.png`,
      { fullPage: true }
    );
  }

  await finishSoloSetup(page);
  await page.getByRole('link', { name: 'Back to home' }).click();
  for (const viewport of soloFlowViewports) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('link', { name: /Continue Solo/ })).toBeVisible();
    await expect.soft(page, `saved-aware Home at ${viewport.width}x${viewport.height}`).toHaveScreenshot(
      `home-saved-${viewport.width}x${viewport.height}.png`,
      {
        fullPage: true,
        mask: [page.locator('.skyjo-home-action-meta').filter({ hasText: /^Saved / })],
        maskColor: '#f5e6c8'
      }
    );
  }

  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByTestId('solo-launcher')).toBeVisible();
  for (const viewport of soloFlowViewports) {
    await page.setViewportSize(viewport);
    await expect.soft(page, `saved launcher at ${viewport.width}x${viewport.height}`).toHaveScreenshot(
      `solo-launcher-${viewport.width}x${viewport.height}.png`,
      {
        fullPage: true,
        mask: [page.locator('.skyjo-saved-session-card > span').last()],
        maskColor: '#10251f'
      }
    );
  }
});
