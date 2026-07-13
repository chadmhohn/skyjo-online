import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import type { Page } from '@playwright/test';

type Viewport = { width: number; height: number };

type SettledResponsiveLayout = {
  centerBandHeight: number;
  compactMediaMatches: boolean;
  phoneGuidanceVisible: boolean;
  phoneMediaMatches: boolean;
  viewportHeight: number;
  viewportWidth: number;
};

type ResponsiveLayoutSample = SettledResponsiveLayout & {
  fontStatus: string;
  localBottom: number;
  narrowMediaMatches: boolean;
  opponentTop: number;
  pilesCenterX: number;
  playerCount?: string;
  scrollWidth: number;
  tableHeight: number;
  tableWidth: number;
};

async function settleResponsiveTable(
  page: Page,
  viewport: Viewport,
  playerCount: number
): Promise<SettledResponsiveLayout> {
  await page.setViewportSize(viewport);
  const table = page.getByTestId('shared-game-table');
  await expect(table).toHaveAttribute('data-player-count', String(playerCount));
  const expectedPhone = viewport.width <= 640;
  const expectedNarrow = viewport.width <= 900;
  const expectedCompact = viewport.width >= 641 && viewport.height <= 900;
  const expectedCenterBandHeight = expectedPhone ? 100 : expectedCompact ? 150 : null;
  const requiredStableSamples = 4;
  let lastSample: ResponsiveLayoutSample | undefined;
  let previousSignature = '';
  let stableSamples = 0;

  await expect
    .poll(
      async () => {
        const current = await table.evaluate((tableElement): ResponsiveLayoutSample => {
          const centerBand = tableElement.querySelector<HTMLElement>('[data-testid="table-center-band"]');
          const opponentRail = tableElement.querySelector<HTMLElement>('[data-testid="opponent-rail"]');
          const localBoard = tableElement.querySelector<HTMLElement>('[data-testid="local-board"]');
          const tablePiles = tableElement.querySelector<HTMLElement>('[data-testid="table-piles"]');
          if (!centerBand || !opponentRail || !localBoard || !tablePiles) {
            throw new Error('Missing responsive table settlement anchor.');
          }
          const rounded = (value: number) => Math.round(value * 100) / 100;
          const tableRect = tableElement.getBoundingClientRect();
          const centerBandRect = centerBand.getBoundingClientRect();
          const opponentRect = opponentRail.getBoundingClientRect();
          const localRect = localBoard.getBoundingClientRect();
          const pilesRect = tablePiles.getBoundingClientRect();
          return {
            centerBandHeight: rounded(centerBandRect.height),
            compactMediaMatches: window.matchMedia('(min-width: 641px) and (max-height: 900px)').matches,
            fontStatus: document.fonts.status,
            localBottom: rounded(localRect.bottom),
            narrowMediaMatches: window.matchMedia('(max-width: 900px)').matches,
            opponentTop: rounded(opponentRect.top),
            phoneGuidanceVisible: Boolean(document.querySelector('.skyjo-phone-action-guidance')),
            phoneMediaMatches: window.matchMedia('(max-width: 640px)').matches,
            pilesCenterX: rounded(pilesRect.left + pilesRect.width / 2),
            playerCount: tableElement.dataset.playerCount,
            scrollWidth: document.documentElement.scrollWidth,
            tableHeight: rounded(tableRect.height),
            tableWidth: rounded(tableRect.width),
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth
          };
        });
        lastSample = current;
        const responsiveStateMatches =
          current.viewportWidth === viewport.width &&
          current.viewportHeight === viewport.height &&
          current.phoneMediaMatches === expectedPhone &&
          current.narrowMediaMatches === expectedNarrow &&
          current.compactMediaMatches === expectedCompact &&
          current.phoneGuidanceVisible === expectedPhone &&
          current.playerCount === String(playerCount) &&
          current.fontStatus === 'loaded' &&
          (expectedCenterBandHeight === null ||
            Math.abs(current.centerBandHeight - expectedCenterBandHeight) <= 0.05);
        const signature = JSON.stringify(current);
        stableSamples = responsiveStateMatches
          ? signature === previousSignature
            ? Math.min(stableSamples + 1, requiredStableSamples)
            : 1
          : 0;
        previousSignature = signature;
        return { responsiveStateMatches, stableSamples, sample: current };
      },
      {
        intervals: [25, 50, 100, 250],
        message: `responsive table should settle at ${viewport.width}x${viewport.height}`,
        timeout: 7_500
      }
    )
    .toMatchObject({ responsiveStateMatches: true, stableSamples: requiredStableSamples });

  if (!lastSample) throw new Error('Responsive table settlement produced no sample.');
  return {
    centerBandHeight: lastSample.centerBandHeight,
    compactMediaMatches: lastSample.compactMediaMatches,
    phoneGuidanceVisible: lastSample.phoneGuidanceVisible,
    phoneMediaMatches: lastSample.phoneMediaMatches,
    viewportHeight: lastSample.viewportHeight,
    viewportWidth: lastSample.viewportWidth
  };
}

async function configureSoloRoster(page: Page, playerCount: number) {
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  const opponentPicker = settings.getByRole('group', { name: 'Choose AI opponent count' });
  await opponentPicker.getByRole('button', { name: String(playerCount - 1), exact: true }).click();
  await page.waitForTimeout(250);
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

async function finishHumanOpeningAndMeasureAi(page: Page): Promise<number> {
  const openingCards = page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).filter({ visible: true });
  await openingCards.first().click();

  await openingCards.first().evaluate((button) => {
    const table = document.querySelector<HTMLElement>('[data-testid="shared-game-table"]');
    if (!table) throw new Error('Missing shared game table timing anchor.');
    const timing = { startedAt: 0, completedAt: 0 };
    const runtime = window as typeof window & { __skyjoOpeningTiming?: typeof timing };
    runtime.__skyjoOpeningTiming = timing;
    const observer = new MutationObserver(() => {
      if (timing.startedAt > 0 && table.dataset.phase !== 'opening-reveal') {
        timing.completedAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(table, { attributeFilter: ['data-phase'], attributes: true });
    button.addEventListener(
      'click',
      () => {
        timing.startedAt = performance.now();
      },
      { capture: true, once: true }
    );
  });
  await openingCards.first().click();
  await expect(page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'opening-reveal', { timeout: 5_000 });
  return page.evaluate(() => {
    const timing = (
      window as typeof window & { __skyjoOpeningTiming?: { startedAt: number; completedAt: number } }
    ).__skyjoOpeningTiming;
    if (!timing || timing.startedAt <= 0 || timing.completedAt < timing.startedAt) {
      throw new Error('Opening cadence timing markers were not recorded.');
    }
    return timing.completedAt - timing.startedAt;
  });
}

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

  const openingCards = page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).filter({ visible: true });
  await openingCards.first().click();
  await openingCards.first().click();

  const deck = page.getByRole('button', { name: /Deck/ }).filter({ visible: true });
  await expect(deck).toBeEnabled({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});

test('a complete solo turn is keyboard operable and restores actionable controls', async ({ page, skyjoServer }) => {
  test.setTimeout(45_000);
  await installSeededBrowserRuntime(page, 61);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${skyjoServer.baseURL}/single-player`);

  const table = page.getByTestId('shared-game-table');
  const openingCards = page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).filter({ visible: true });
  for (let reveal = 0; reveal < 2; reveal += 1) {
    const nextCard = openingCards.first();
    await nextCard.focus();
    await expect(nextCard).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(table).not.toHaveAttribute('data-phase', 'opening-reveal', { timeout: 5_000 });

  const deck = page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
  await expect(deck).toBeEnabled({ timeout: 15_000 });
  await deck.focus();
  await expect(deck).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(table).toHaveAttribute('data-phase', 'choose-replacement');

  const replacement = page.getByRole('button', { name: /Replace with the drawn card/ }).filter({ visible: true }).first();
  await replacement.focus();
  await expect(replacement).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /Replace with the drawn card/ }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();

  await expect(deck).toBeEnabled({ timeout: 15_000 });
  await expect(table).toHaveAttribute('data-phase', 'choose-source');
});

test('solo progress survives refresh and a service-worker update without auto-discarding', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 68);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  const openingCards = page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).filter({ visible: true });
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
  await expect(page.getByRole('button', { name: /face-down\. Reveal this opening card/ }).filter({ visible: true })).toHaveCount(11);
});

test('repeated responsive captures explicitly start a new durable game', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 60);
  const opponentRosters: string[][] = [];
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${skyjoServer.baseURL}/single-player`);
    const gameTable = page.locator('[data-testid="game-table"]');
    const resumeChoice = page.locator('[data-testid="solo-resume-choice"]');
    await expect(gameTable.or(resumeChoice)).toBeVisible();
    if (await resumeChoice.isVisible()) {
      await page.getByRole('button', { name: 'New Game' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    opponentRosters.push(await page.locator('[data-testid="opponent-rail"] h2').allTextContents());
  }
  expect(opponentRosters[1]).toEqual(opponentRosters[0]);
});

test('eight-player AI opening completes within normal and reduced-motion budgets', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 71);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await configureSoloRoster(page, 8);

  const normalDuration = await finishHumanOpeningAndMeasureAi(page);
  expect(normalDuration).toBeLessThanOrEqual(3_000);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await configureSoloRoster(page, 8);
  const motionSample = page.getByRole('button', { name: 'Open game settings' });
  await motionSample.hover();
  const reducedStyles = await motionSample.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      animationIterationCount: style.animationIterationCount,
      transform: style.transform,
      transitionDuration: style.transitionDuration
    };
  });
  expect(reducedStyles.transform).toBe('none');
  expect(Number.parseFloat(reducedStyles.transitionDuration)).toBeLessThanOrEqual(0.001);
  expect(Number.parseFloat(reducedStyles.animationDuration)).toBeLessThanOrEqual(0.001);
  expect(reducedStyles.animationIterationCount).toBe('1');
  const reducedDuration = await finishHumanOpeningAndMeasureAi(page);
  expect(reducedDuration).toBeLessThanOrEqual(1_000);
});

test('centered table geometry is symmetric, contained, and overlap-free for 2, 3, 4, and 8 players', async ({
  page,
  skyjoServer
}) => {
  test.setTimeout(90_000);
  await installSeededBrowserRuntime(page, 70);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();

  const viewports = [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
    { width: 1440, height: 900 }
  ];

  for (const playerCount of [2, 3, 4, 8]) {
    await configureSoloRoster(page, playerCount);

    for (const viewport of viewports) {
      await settleResponsiveTable(page, viewport, playerCount);
      const geometry = await page.getByTestId('shared-game-table').evaluate((table) => {
        const rect = (element: Element | null) => {
          if (!element) throw new Error('Missing centered-table geometry anchor.');
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height, top: value.top, right: value.right, bottom: value.bottom, left: value.left };
        };
        const opponentRail = table.querySelector('[data-testid="opponent-rail"]');
        const centerBand = table.querySelector('[data-testid="table-center-band"]');
        const tablePiles = table.querySelector('[data-testid="table-piles"]');
        const localBoard = table.querySelector('[data-testid="local-board"]');
        const heading = document.querySelector('.skyjo-game-title') as HTMLElement | null;
        const headerControls = document.querySelector('.skyjo-header-controls');
        const gameStatus = document.querySelector('.skyjo-game-status');
        const seats = Array.from(opponentRail?.querySelectorAll('[data-player-role="opponent"]') || []).map(rect);
        const tableRect = rect(table);
        const opponentRect = rect(opponentRail);
        const centerBandRect = rect(centerBand);
        const pilesRect = rect(tablePiles);
        const localRect = rect(localBoard);
        const headingRect = rect(heading);
        const headerControlsRect = rect(headerControls);
        const gameStatusRect = gameStatus ? rect(gameStatus) : null;
        const firstSeat = seats[0];
        const lastSeat = seats.at(-1);
        return {
          centerDeltaX: Math.abs(pilesRect.left + pilesRect.width / 2 - (tableRect.left + tableRect.width / 2)),
          centerDeltaY: Math.abs(centerBandRect.top + centerBandRect.height / 2 - (tableRect.top + tableRect.height / 2)),
          centerBandHeight: centerBandRect.height,
          compactViewportFits: opponentRect.top >= -0.5 && localRect.bottom <= window.innerHeight + 1,
          localBottom: localRect.bottom,
          opponentTop: opponentRect.top,
          firstSeatCenterDelta: firstSeat
            ? Math.abs(firstSeat.left + firstSeat.width / 2 - (opponentRect.left + opponentRect.width / 2))
            : 0,
          opponentOuterGapDelta:
            firstSeat && lastSeat
              ? Math.abs(firstSeat.left - opponentRect.left - (opponentRect.right - lastSeat.right))
              : 0,
          noOverlap: opponentRect.bottom <= centerBandRect.top + 0.5 && centerBandRect.bottom <= localRect.top + 0.5,
          headingText: heading?.textContent?.trim(),
          headingNotClipped: Boolean(heading && heading.scrollWidth <= heading.clientWidth + 1),
          headerNoOverlap:
            headingRect.right <= headerControlsRect.left + 0.5 ||
            headingRect.bottom <= headerControlsRect.top + 0.5 ||
            headerControlsRect.bottom <= headingRect.top + 0.5,
          statusOwnRow:
            !gameStatusRect || gameStatusRect.top >= Math.max(headingRect.bottom, headerControlsRect.bottom) - 0.5,
          opponentClientWidth: (opponentRail as HTMLElement).clientWidth,
          opponentScrollWidth: (opponentRail as HTMLElement).scrollWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          seatWidths: seats.map((seat) => seat.width),
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth
        };
      });

      const tolerance = viewport.width <= 640 ? 8 : 16;
      expect(geometry.centerDeltaX, `${playerCount} players at ${viewport.width}px center x`).toBeLessThanOrEqual(tolerance);
      expect(geometry.centerDeltaY, `${playerCount} players at ${viewport.width}px center y`).toBeLessThanOrEqual(tolerance);
      expect(geometry.noOverlap, `${playerCount} players at ${viewport.width}px overlap`).toBe(true);
      expect(geometry.headingText).toBe('Single Player');
      expect(geometry.headingNotClipped, `${viewport.width}px heading clipping`).toBe(true);
      expect(geometry.headerNoOverlap, `${viewport.width}px header overlap`).toBe(true);
      expect(geometry.statusOwnRow, `${viewport.width}px status row`).toBe(true);
      expect(geometry.pageScrollWidth, `${playerCount} players at ${viewport.width}px page scroll`).toBeLessThanOrEqual(
        geometry.viewportWidth + 1
      );
      expect(Math.max(...geometry.seatWidths) - Math.min(...geometry.seatWidths)).toBeLessThanOrEqual(2);

      if (viewport.width <= 640) {
        expect(
          geometry.centerBandHeight,
          `${playerCount} players at ${viewport.width}x${viewport.height} center band: ${JSON.stringify(geometry)}`
        ).toBeGreaterThanOrEqual(90);
        expect(
          geometry.centerBandHeight,
          `${playerCount} players at ${viewport.width}x${viewport.height} center band: ${JSON.stringify(geometry)}`
        ).toBeLessThanOrEqual(110);
      }
      if (viewport.width > 640 && viewport.height <= 900) {
        expect(
          geometry.compactViewportFits,
          `${playerCount} players at ${viewport.width}x${viewport.height}: opponentTop=${geometry.opponentTop}, localBottom=${geometry.localBottom}, viewportHeight=${geometry.viewportHeight}`
        ).toBe(true);
      }
      if (playerCount === 2) expect(geometry.firstSeatCenterDelta).toBeLessThanOrEqual(2);
      if (playerCount === 3) expect(geometry.opponentOuterGapDelta).toBeLessThanOrEqual(2);
      if (playerCount === 8 || (playerCount === 4 && viewport.width <= 900)) {
        expect(geometry.opponentScrollWidth).toBeGreaterThan(geometry.opponentClientWidth + 1);
      }
    }
  }
});

test.describe('responsive table settlement stress', () => {
  test.describe.configure({ retries: 0 });

  test('repeated desktop and phone transitions converge for every supported roster', async ({ page, skyjoServer }) => {
    test.setTimeout(90_000);
    await installSeededBrowserRuntime(page, 72);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${skyjoServer.baseURL}/single-player`);
    await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();

    const compactDesktop = { width: 1180, height: 820 };
    const phone = { width: 390, height: 844 };
    const transitions = [compactDesktop, phone, compactDesktop, phone, compactDesktop];

    for (const playerCount of [2, 3, 4, 8]) {
      await configureSoloRoster(page, playerCount);
      const samples = [];
      for (const viewport of transitions) {
        samples.push(await settleResponsiveTable(page, viewport, playerCount));
      }

      expect(samples.map((sample) => sample.centerBandHeight)).toEqual([150, 100, 150, 100, 150]);
      expect(samples.map((sample) => sample.phoneMediaMatches)).toEqual([false, true, false, true, false]);
      expect(samples.map((sample) => sample.compactMediaMatches)).toEqual([true, false, true, false, true]);
      expect(samples.map((sample) => sample.phoneGuidanceVisible)).toEqual([false, true, false, true, false]);
      expect(samples.map(({ viewportWidth, viewportHeight }) => [viewportWidth, viewportHeight])).toEqual(
        transitions.map(({ width, height }) => [width, height])
      );
    }
  });
});
