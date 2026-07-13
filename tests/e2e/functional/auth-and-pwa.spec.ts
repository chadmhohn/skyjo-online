import { expect, test } from '../fixtures';
import { startFreshGame } from '../../../src/game';
import type { GameState } from '../../../src/types';

function completedSoloState(): GameState {
  const state = startFreshGame({ aiOpponentCount: 1, random: () => 0.35 });
  return {
    ...state,
    phase: 'game-over',
    winnerId: 'human',
    players: state.players.map((player, index) => ({ ...player, roundScore: 9 + index, totalScore: 9 + index }))
  };
}

test('home, account signup, and authenticated account shell work together', async ({ page, skyjoServer }) => {
  await page.goto(skyjoServer.baseURL);
  await expect(page.getByRole('heading', { name: 'Skyjo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Single Player' })).toBeVisible();

  await page.goto(`${skyjoServer.baseURL}/account?next=/account`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill('playwright@example.test');
  await page.getByLabel('Display name').fill('Playwright Player');
  await page.getByLabel('Password', { exact: true }).fill('playwright-secret-123');
  await page.getByLabel('Confirm password').fill('playwright-secret-123');
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByText('Playwright Player')).toBeVisible();
});

test('manifest and service worker assets are release-build reachable', async ({ request, skyjoServer }) => {
  const manifest = await request.get(`${skyjoServer.baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const payload = await manifest.json();
  expect(payload).toMatchObject({
    name: expect.any(String),
    display: 'standalone'
  });
  expect(payload.icons.length).toBeGreaterThanOrEqual(2);

  const serviceWorker = await request.get(`${skyjoServer.baseURL}/sw.js`);
  expect(serviceWorker.ok()).toBe(true);
  expect(await serviceWorker.text()).toContain("addEventListener('push'");
});

test('single-player stats deduplicate one UUID without collapsing an equal-score game', async ({ page, skyjoServer }) => {
  const email = `solo-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const account = await page.context().request.post(`${skyjoServer.baseURL}/api/account/signup`, {
    data: {
      email,
      displayName: 'Solo Durable',
      password: 'durable-password',
      confirmPassword: 'durable-password'
    }
  });
  expect(account.status()).toBe(201);

  const state = completedSoloState();
  const firstGameId = '11111111-1111-4111-8111-111111111111';
  const equalScoreGameId = '22222222-2222-4222-8222-222222222222';
  const first = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: firstGameId }
  });
  const duplicate = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: firstGameId }
  });
  const distinct = await page.context().request.post(`${skyjoServer.baseURL}/api/stats/single-player`, {
    data: { state, clientGameKey: equalScoreGameId }
  });
  const firstPayload = await first.json();
  const duplicatePayload = await duplicate.json();
  const distinctPayload = await distinct.json();

  expect(first.status()).toBe(201);
  expect(duplicate.status()).toBe(201);
  expect(distinct.status()).toBe(201);
  expect(duplicatePayload.game.id).toBe(firstPayload.game.id);
  expect(distinctPayload.game.id).not.toBe(firstPayload.game.id);
});
