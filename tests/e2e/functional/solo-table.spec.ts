import { expect, installSeededBrowserRuntime, test } from '../fixtures';

test('solo opening is playable and exposes stable table geometry anchors', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 60);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();

  const gameTable = page.locator('[data-testid="game-table"]:visible');
  const opponentRail = page.locator('[data-testid="opponent-rail"]:visible');
  const tableCenter = page.locator('[data-testid="table-center"]:visible');
  const localBoard = page.locator('[data-testid="local-board"]:visible');
  await expect(gameTable).toHaveCount(1);
  await expect(opponentRail).toHaveCount(1);
  await expect(tableCenter).toHaveCount(1);
  await expect(localBoard).toHaveCount(1);

  const openingCards = page.getByRole('button', { name: /Reveal opening card/ }).filter({ visible: true });
  await openingCards.first().click();
  await openingCards.first().click();

  const deck = page.getByRole('button', { name: /Deck/ }).filter({ visible: true });
  await expect(deck).toBeEnabled({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});

test('solo progress survives refresh and a service-worker update without auto-discarding', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 68);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  const openingCards = page.getByRole('button', { name: /Reveal opening card/ }).filter({ visible: true });
  await openingCards.first().click();

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
              const records = transaction.objectStore('soloSessions').index('byOwner').getAll('guest');
              records.onerror = () => reject(records.error);
              records.onsuccess = () => {
                const state = records.result[0]?.state;
                const human = state?.players?.find((player: { kind?: string }) => player.kind === 'human');
                resolve(human?.grid?.filter((card: { faceUp?: boolean }) => card.faceUp).length || 0);
                database.close();
              };
            };
          })
      )
    )
    .toBe(1);

  const serviceWorkerUpdated = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    return true;
  });
  expect(serviceWorkerUpdated).toBe(true);

  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Continue your solo game?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue Game' }).click();
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Reveal opening card/ }).filter({ visible: true })).toHaveCount(11);
});
