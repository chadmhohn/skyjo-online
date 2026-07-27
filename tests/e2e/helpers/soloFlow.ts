import type { Page } from '@playwright/test';
import { expect } from '../fixtures';

export type SoloDifficulty = 'easy' | 'medium' | 'hard' | 'ultra' | 'mixed';

export type SoloSetupOptions = {
  difficulty?: SoloDifficulty;
  opponents?: number;
};

async function waitForSoloScreen(page: Page) {
  const loading = page.getByTestId('solo-storage-loading');
  const readyScreen = page.locator(
    '[data-testid="solo-launcher"], [data-testid="solo-game-setup"], [data-testid="game-table"]'
  );
  await expect(loading.or(readyScreen).first()).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(readyScreen.first()).toBeVisible();
}

export async function configureSoloSetup(page: Page, options: SoloSetupOptions = {}) {
  const opponents = options.opponents ?? 1;
  const difficulty = options.difficulty ?? 'medium';
  if (!Number.isInteger(opponents) || opponents < 1 || opponents > 7) {
    throw new Error(`Solo opponents must be an integer from 1 through 7; received ${opponents}.`);
  }

  const setup = page.getByTestId('solo-game-setup');
  await expect(setup).toBeVisible();
  const count = setup.locator('.skyjo-opponent-count strong');
  const current = Number.parseInt((await count.textContent()) ?? '', 10);
  if (!Number.isInteger(current)) throw new Error('Could not read the current solo opponent count.');
  const buttonName = opponents > current ? 'Increase AI opponents' : 'Decrease AI opponents';
  for (let index = 0; index < Math.abs(opponents - current); index += 1) {
    await setup.getByRole('button', { name: buttonName }).click();
  }
  await expect(count).toHaveText(String(opponents));
  await setup.locator(`input[name="solo-difficulty"][value="${difficulty}"]`).check();
}

export async function finishSoloSetup(page: Page) {
  const setup = page.getByTestId('solo-game-setup');
  const review = setup.getByRole('button', { name: 'Review & Start' });
  if (await review.isVisible()) {
    await review.click();
    const replacement = page.getByRole('dialog', { name: /Replace your saved game/i });
    await expect(replacement).toBeVisible();
    await replacement.getByRole('button', { name: 'Replace saved game & start' }).click();
  } else {
    await setup.getByRole('button', { name: 'Start Solo Game' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();
}

export async function startFreshSoloGame(page: Page, baseURL: string, options: SoloSetupOptions = {}) {
  await page.goto(`${baseURL}/single-player`);
  await waitForSoloScreen(page);
  const launcher = page.getByTestId('solo-launcher');
  if (await launcher.isVisible()) {
    await launcher.getByRole('button', { name: 'Set Up New Game' }).click();
  }
  await configureSoloSetup(page, options);
  await finishSoloSetup(page);
}

export async function continueSavedSoloGame(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/single-player`);
  await waitForSoloScreen(page);
  const launcher = page.getByTestId('solo-launcher');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Continue Solo' }).click();
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
}

export async function openOrStartSoloGame(page: Page, baseURL: string, options: SoloSetupOptions = {}) {
  await page.goto(`${baseURL}/single-player`);
  await waitForSoloScreen(page);
  const launcher = page.getByTestId('solo-launcher');
  if (await launcher.isVisible()) {
    await launcher.getByRole('button', { name: 'Continue Solo' }).click();
  } else if (await page.getByTestId('solo-game-setup').isVisible()) {
    await configureSoloSetup(page, options);
    await finishSoloSetup(page);
  }
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
}
