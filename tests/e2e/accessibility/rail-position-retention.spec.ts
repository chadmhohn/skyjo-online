import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

const phoneViewport = { width: 390, height: 844 };
const retainedPositionTolerance = 1;

async function configureSoloRoster(page: Page, playerCount: number) {
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  await settings
    .getByRole('group', { name: 'Choose AI opponent count' })
    .getByRole('button', { name: String(playerCount - 1), exact: true })
    .click();
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

async function openSoloPage(browser: Browser, baseURL: string, accessPassword: string, hasTouch = false) {
  const context = await browser.newContext({
    hasTouch,
    isMobile: false,
    serviceWorkers: 'allow',
    viewport: phoneViewport
  });
  const access = await context.request.post(`${baseURL}/login`, {
    form: { next: '/', password: accessPassword }
  });
  expect(access.ok()).toBe(true);
  const page = await context.newPage();
  await installSeededBrowserRuntime(page, 127);
  await page.goto(`${baseURL}/single-player`);
  await configureSoloRoster(page, 8);
  return { context, page };
}

async function railSnapshot(page: Page) {
  return page.getByTestId('opponent-rail').evaluate((rail) => {
    const element = rail as HTMLElement;
    const current = element.querySelector<HTMLElement>('.skyjo-panel-current');
    const railRect = element.getBoundingClientRect();
    const currentRect = current?.getBoundingClientRect();
    return {
      currentOpponentFullyVisible: Boolean(
        currentRect && currentRect.left >= railRect.left - 1 && currentRect.right <= railRect.right + 1
      ),
      maximum: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollSnapType: window.getComputedStyle(element).scrollSnapType
    };
  });
}

async function waitForStableRail(page: Page) {
  let previous = (await railSnapshot(page)).scrollLeft;
  let stableSamples = 0;
  for (let sample = 0; sample < 12; sample += 1) {
    await page.waitForTimeout(32);
    const current = (await railSnapshot(page)).scrollLeft;
    stableSamples = Math.abs(current - previous) <= 0.25 ? stableSamples + 1 : 0;
    if (stableSamples >= 2) return current;
    previous = current;
  }
  throw new Error('Opponent rail did not settle after trusted keyboard input.');
}

function expectRetained(before: number, after: number) {
  expect(Math.abs(after - before)).toBeLessThanOrEqual(retainedPositionTolerance);
}

async function openingCards(page: Page) {
  return page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])');
}

async function swipeOpponentRailByTouch(page: Page, session: CDPSession) {
  const rail = page.getByTestId('opponent-rail');
  const box = await rail.boundingBox();
  if (!box) throw new Error('Opponent rail has no touchable bounding box.');
  const startX = box.x + box.width - 16;
  const endX = box.x + 72;
  const y = box.y + box.height / 2;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startX, y }]
  });
  for (let step = 1; step <= 4; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX + ((endX - startX) * step) / 4, y }]
    });
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('trusted rail gestures retain opening and turn positions, then current-opponent follow resumes', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(45_000);
  let context: BrowserContext | undefined;
  try {
    const opened = await openSoloPage(browser, skyjoServer.baseURL, skyjoServer.accessPassword);
    context = opened.context;
    const { page } = opened;
    const rail = page.getByTestId('opponent-rail');
    const table = page.getByTestId('shared-game-table');

    await rail.hover();
    await page.mouse.wheel(224, 0);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(100);
    const openingPosition = (await railSnapshot(page)).scrollLeft;
    const cards = await openingCards(page);
    await cards.first().click();
    await expect(cards).toHaveCount(11);
    await page.waitForTimeout(325);
    expectRetained(openingPosition, (await railSnapshot(page)).scrollLeft);
    expect((await railSnapshot(page)).scrollSnapType).toBe('none');

    await rail.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(openingPosition + 1);
    const keyboardPosition = await waitForStableRail(page);
    await cards.first().click();
    await page.waitForTimeout(325);
    expectRetained(keyboardPosition, (await railSnapshot(page)).scrollLeft);
    await expect(table).not.toHaveAttribute('data-phase', 'opening-reveal');
    const deck = page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
    await expect(deck).toBeEnabled();
    await deck.click();
    await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
    const replacement = page.getByRole('button', { name: /Replace with the drawn card/ }).filter({ visible: true }).first();
    await replacement.click();
    await expect.poll(async () => rail.locator('.skyjo-panel-current').count()).toBe(1);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeLessThan(keyboardPosition - 1);

    await rail.hover();
    await page.mouse.wheel(10_000, 0);
    await expect.poll(async () => {
      const snapshot = await railSnapshot(page);
      return snapshot.maximum - snapshot.scrollLeft;
    }).toBeLessThanOrEqual(1);
    const turnPosition = (await railSnapshot(page)).scrollLeft;
    const phaseBeforeAiUpdate = await table.getAttribute('data-phase');
    await expect.poll(async () => table.getAttribute('data-phase')).not.toBe(phaseBeforeAiUpdate);
    expectRetained(turnPosition, (await railSnapshot(page)).scrollLeft);
    expect((await railSnapshot(page)).currentOpponentFullyVisible).toBe(false);

    await expect.poll(async () => (await railSnapshot(page)).currentOpponentFullyVisible).toBe(true);
  } finally {
    await context?.close();
  }
});

test('trusted touch retains the chosen rail position across a real opening update', async ({
  browser,
  skyjoServer
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'CDP touch dispatch is Chromium-only.');
  let context: BrowserContext | undefined;
  let session: CDPSession | undefined;
  try {
    const opened = await openSoloPage(browser, skyjoServer.baseURL, skyjoServer.accessPassword, true);
    context = opened.context;
    const { page } = opened;
    session = await context.newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await swipeOpponentRailByTouch(page, session);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(100);
    const before = (await railSnapshot(page)).scrollLeft;
    const cards = await openingCards(page);
    await cards.first().click();
    await expect(cards).toHaveCount(11);
    await page.waitForTimeout(325);
    expectRetained(before, (await railSnapshot(page)).scrollLeft);
  } finally {
    await session?.detach();
    await context?.close();
  }
});
