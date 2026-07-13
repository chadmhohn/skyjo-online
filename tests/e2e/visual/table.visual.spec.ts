import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import type { Page } from '@playwright/test';

const viewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1440, height: 900 }
] as const;

async function configureSoloRoster(page: Page, playerCount: number) {
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await settings
    .getByRole('group', { name: 'Choose AI opponent count' })
    .getByRole('button', { name: String(playerCount - 1), exact: true })
    .click();
  await page.waitForTimeout(250);
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

test('single-player table matches canonical responsive baselines', async ({ page, skyjoServer }) => {
  test.setTimeout(90_000);
  test.skip(
    process.platform !== 'linux' && process.env.SKYJO_UPDATE_VISUALS !== '1',
    'Canonical pixel baselines run on ubuntu-24.04; set SKYJO_UPDATE_VISUALS=1 only to refresh them deliberately.'
  );
  await installSeededBrowserRuntime(page, 60);

  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();

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
