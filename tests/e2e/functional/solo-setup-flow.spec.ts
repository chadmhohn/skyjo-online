import type { Page } from '@playwright/test';
import { soloGameOverDecisionState } from '../../helpers/soloGameState';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import { configureSoloSetup, finishSoloSetup, startFreshSoloGame } from '../helpers/soloFlow';

type StoredSoloRecord = {
  aiOpponentCount: number;
  aiSetup: { aiOpponentCount: number; difficulty: string; playerDifficulties?: Record<string, string>; strategyVersion?: number };
  gameId: string;
  ownerKey: string;
  schemaVersion: number;
  setup: { aiOpponentCount: number; difficulty: string; playerDifficulties?: Record<string, string> };
  state: { phase: string; players: Array<{ grid: Array<{ faceUp: boolean }> }> };
  updatedAt: number;
};

async function readSoloRecords(page: Page, ownerKey = 'guest'): Promise<StoredSoloRecord[]> {
  return page.evaluate((owner) => new Promise((resolve, reject) => {
    const request = indexedDB.open('skyjo-pwa', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const records = database.transaction('soloSessions').objectStore('soloSessions').index('byOwner').getAll(owner);
      records.onerror = () => reject(records.error);
      records.onsuccess = () => {
        resolve(records.result as StoredSoloRecord[]);
        database.close();
      };
    };
  }), ownerKey);
}

async function putSoloRecord(page: Page, record: unknown) {
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('skyjo-pwa', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('soloSessions', 'readwrite');
      const store = transaction.objectStore('soloSessions');
      store.clear();
      store.put(value);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    };
  }), record);
}

async function mixedBadges(page: Page) {
  const opponents = page.locator('[data-player-role="opponent"]');
  await expect(opponents).toHaveCount(3);
  return opponents.evaluateAll((boards) => boards.map((board) => ({
    difficulty: board.querySelector('.skyjo-ai-difficulty-badge')?.textContent?.trim() || '',
    playerId: board.getAttribute('data-player-id') || ''
  })));
}

async function expectFocusedDifficultyAboveFooter(page: Page) {
  const geometry = await page.evaluate(() => {
    const focused = document.activeElement?.closest<HTMLElement>('.skyjo-difficulty-option');
    const footer = document.querySelector<HTMLElement>('.skyjo-solo-flow-actions');
    if (!focused || !footer) throw new Error('Focused difficulty geometry anchors were unavailable.');
    return { focused: focused.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON() };
  });
  expect(geometry.focused.bottom).toBeLessThanOrEqual(geometry.footer.top + 0.5);
}

async function reachSoloGameOver(page: Page, baseURL: string, gameId: string) {
  const fixture = soloGameOverDecisionState();
  await page.goto(`${baseURL}/single-player`);
  await expect(page.locator('[data-testid="solo-launcher"], [data-testid="solo-game-setup"], [data-testid="game-table"]').first()).toBeVisible();
  await expect(page.getByTestId('solo-storage-loading')).toHaveCount(0);
  await page.goto(`${baseURL}/healthz`);
  await putSoloRecord(page, {
    aiOpponentCount: 1,
    aiSetup: { aiOpponentCount: 1, difficulty: 'hard', strategyVersion: 1 },
    gameId,
    ownerKey: 'guest',
    schemaVersion: 1,
    setup: { aiOpponentCount: 1, difficulty: 'hard' },
    state: fixture.state,
    updatedAt: Date.now()
  });
  await page.goto(`${baseURL}/single-player`);
  await page.getByRole('button', { name: 'Continue Solo' }).click();
  if (fixture.move.action === 'reveal') {
    await page.getByRole('button', { name: 'Discard + reveal drawn card' }).click();
  }
  await page.getByTestId('local-board').locator(`[data-card-index="${fixture.move.index ?? 0}"]`).click();
  await expect(page.getByRole('button', { name: 'Play again with same setup' })).toBeVisible();
}

test('direct solo setup creates nothing before Start and supports bounded keyboard setup', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 164);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);

  const setup = page.getByTestId('solo-game-setup');
  await expect(setup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your solo table' })).toBeFocused();
  await expect(page.getByRole('radio', { name: /Medium/ })).toBeChecked();
  await expect(setup.getByText(/Selected/).locator('..')).toContainText('1 bot · Medium');
  expect(await readSoloRecords(page)).toEqual([]);

  const decrease = page.getByRole('button', { name: 'Decrease AI opponents' });
  const increase = page.getByRole('button', { name: 'Increase AI opponents' });
  await expect(decrease).toBeDisabled();
  for (let count = 1; count < 7; count += 1) await increase.click();
  await expect(increase).toBeDisabled();
  await expect(page.locator('.skyjo-opponent-count strong')).toHaveText('7');

  const medium = page.getByRole('radio', { name: /Medium/ });
  await medium.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /^Hard/ })).toBeChecked();
  await expectFocusedDifficultyAboveFooter(page);
  expect(await readSoloRecords(page)).toEqual([]);

  await finishSoloSetup(page);
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8');
  await expect.poll(async () => (await readSoloRecords(page))[0]?.aiSetup).toMatchObject({
    aiOpponentCount: 7,
    difficulty: 'hard'
  });
});

test('Home Continue and New intents are one-shot across real reloads', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 165);
  await startFreshSoloGame(page, skyjoServer.baseURL, { difficulty: 'ultra', opponents: 2 });
  const original = (await readSoloRecords(page))[0];
  expect(original).toBeTruthy();

  await page.getByRole('link', { name: 'Back to home' }).click();
  const continueLink = page.getByRole('link', { name: /Continue Solo/ });
  await expect(continueLink).toContainText('2 AI opponents · Ultra Hard');
  await continueLink.click();
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('solo-launcher')).toBeVisible();

  await page.getByRole('button', { name: 'Back Home' }).click();
  await page.getByRole('link', { name: /New Solo Game/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up your solo table' })).toBeVisible();
  await expect(page.locator('[aria-label="Protected saved game"]')).toContainText('Ultra Hard');
  expect((await readSoloRecords(page))[0]).toEqual(original);

  await page.reload();
  await expect(page.getByTestId('solo-launcher')).toBeVisible();
  expect((await readSoloRecords(page))[0]).toEqual(original);
});

test('active setup is read-only and every setup dismissal preserves the exact save', async ({ page, skyjoServer }) => {
  test.setTimeout(60_000);
  await installSeededBrowserRuntime(page, 166);
  await startFreshSoloGame(page, skyjoServer.baseURL);
  await page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).first().click();
  await expect.poll(async () => (await readSoloRecords(page))[0]?.state.players[0]?.grid.filter((card) => card.faceUp).length).toBe(1);
  const original = (await readSoloRecords(page))[0];

  const openSetup = async () => {
    await page.getByRole('button', { name: 'Open game settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Game' }).click();
    await expect(settings.getByText('Current game: 1 AI opponent')).toBeVisible();
    await expect(settings.getByText('Difficulty: Medium')).toBeVisible();
    await expect(settings.getByRole('radio')).toHaveCount(0);
    await expect(settings.getByRole('group', { name: 'Choose AI opponent count' })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Set up another game…' }).click();
    await expect(page.getByRole('heading', { name: 'Set up your solo table' })).toBeFocused();
    await configureSoloSetup(page, { difficulty: 'easy', opponents: 2 });
  };

  await openSetup();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();
  expect((await readSoloRecords(page))[0]).toEqual(original);

  await openSetup();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();
  expect((await readSoloRecords(page))[0]).toEqual(original);

  await openSetup();
  await page.getByRole('button', { name: 'Back to Game' }).click();
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();
  expect((await readSoloRecords(page))[0]).toEqual(original);

  await openSetup();
  await page.getByRole('button', { name: 'Review & Start' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace your saved game?' });
  await expect(dialog).toContainText('Current saved game');
  await expect(dialog).toContainText('New game');
  await expect(dialog).toContainText('2 AI opponents · Easy');
  await expect(dialog.getByRole('button', { name: 'Keep Current Game' })).toBeFocused();
  await page.locator('[data-modal-overlay]').click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review & Start' })).toBeFocused();

  await page.getByRole('button', { name: 'Review & Start' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review & Start' })).toBeFocused();

  await page.getByRole('button', { name: 'Review & Start' }).click();
  await dialog.getByRole('button', { name: 'Keep Current Game' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review & Start' })).toBeFocused();
  expect((await readSoloRecords(page))[0]).toEqual(original);
});

test('Mixed badges survive reload with assignments bound to player IDs', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 167);
  await startFreshSoloGame(page, skyjoServer.baseURL, { difficulty: 'mixed', opponents: 3 });
  const beforeReload = await mixedBadges(page);
  expect(beforeReload.every(({ difficulty, playerId }) => difficulty.endsWith(' AI') && playerId)).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Continue Solo' }).click();
  expect(await mixedBadges(page)).toEqual(beforeReload);
});

test('game-over actions keep same-setup replay and setup changes distinct', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 168);
  await reachSoloGameOver(page, skyjoServer.baseURL, '44444444-4444-4444-8444-444444444444');
  await page.getByRole('button', { name: 'Play again with same setup' }).click();
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect.poll(async () => (await readSoloRecords(page))[0]?.aiSetup).toMatchObject({
    aiOpponentCount: 1,
    difficulty: 'hard'
  });

  await reachSoloGameOver(page, skyjoServer.baseURL, '55555555-5555-4555-8555-555555555555');
  await page.getByRole('button', { name: 'Change setup' }).click();
  await expect(page.getByRole('button', { name: 'Back to Scores' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Solo Game' })).toBeVisible();
  await expect(page.locator('[aria-label="Protected saved game"]')).toHaveCount(0);
  await configureSoloSetup(page, { difficulty: 'easy', opponents: 2 });
  await finishSoloSetup(page);
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '3');
  await expect.poll(async () => (await readSoloRecords(page))[0]?.aiSetup).toMatchObject({
    aiOpponentCount: 2,
    difficulty: 'easy'
  });
  expect((await readSoloRecords(page))[0]?.setup).toMatchObject({
    aiOpponentCount: 2,
    difficulty: 'hard'
  });
});
