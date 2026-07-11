import { expect, installSeededBrowserRuntime, test } from '../fixtures';

const viewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1180, height: 820 },
  { width: 1440, height: 900 }
] as const;

test('single-player table matches canonical responsive baselines', async ({ page, skyjoServer }) => {
  test.skip(
    process.platform !== 'linux' && process.env.SKYJO_UPDATE_VISUALS !== '1',
    'Canonical pixel baselines run on ubuntu-24.04; set SKYJO_UPDATE_VISUALS=1 only to refresh them deliberately.'
  );
  await installSeededBrowserRuntime(page, 60);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`${skyjoServer.baseURL}/single-player`);
    await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    await expect(page).toHaveScreenshot(`single-player-${viewport.width}x${viewport.height}.png`, {
      fullPage: true
    });
  }
});
