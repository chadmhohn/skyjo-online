import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import type { Page } from '@playwright/test';

type Viewport = { width: number; height: number };

type ResponsiveGeometrySnapshot = {
  centerBandCenterY: number;
  centerBandHeight: number;
  centerBandTop: number;
  centerDeltaX: number;
  centerDeltaY: number;
  compactMediaMatches: boolean;
  compactViewportFits: boolean;
  firstSeatCenterDelta: number;
  fontStatus: string;
  headerNoOverlap: boolean;
  headingNotClipped: boolean;
  headingText: string;
  localBottom: number;
  narrowMediaMatches: boolean;
  noOverlap: boolean;
  opponentClientWidth: number;
  opponentOuterGapDelta: number;
  opponentScrollWidth: number;
  opponentTop: number;
  pageScrollWidth: number;
  phoneGuidanceVisible: boolean;
  phoneMediaMatches: boolean;
  pilesCenterX: number;
  playerCount?: string;
  seatWidthSpread: number;
  seatWidths: number[];
  statusOwnRow: boolean;
  tableCenterY: number;
  tableHeight: number;
  tableWidth: number;
  viewportHeight: number;
  viewportWidth: number;
};

type ResponsiveGeometryCriterion = {
  id: string;
  message: string;
  passes: boolean;
};

async function readResponsiveGeometry(page: Page): Promise<ResponsiveGeometrySnapshot> {
  return page.getByTestId('shared-game-table').evaluate((tableElement): ResponsiveGeometrySnapshot => {
    const centerBand = tableElement.querySelector<HTMLElement>('[data-testid="table-center-band"]');
    const opponentRail = tableElement.querySelector<HTMLElement>('[data-testid="opponent-rail"]');
    const localBoard = tableElement.querySelector<HTMLElement>('[data-testid="local-board"]');
    const tablePiles = tableElement.querySelector<HTMLElement>('[data-testid="table-piles"]');
    const heading = document.querySelector<HTMLElement>('.skyjo-game-title');
    const headerControls = document.querySelector<HTMLElement>('.skyjo-header-controls');
    const gameStatus = document.querySelector<HTMLElement>('.skyjo-game-status');
    if (!centerBand || !opponentRail || !localBoard || !tablePiles || !heading || !headerControls) {
      throw new Error('Missing responsive table geometry anchor.');
    }

    const rounded = (value: number) => Math.round(value * 100) / 100;
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect();
      return {
        bottom: rounded(value.bottom),
        height: rounded(value.height),
        left: rounded(value.left),
        right: rounded(value.right),
        top: rounded(value.top),
        width: rounded(value.width)
      };
    };
    const tableRect = rect(tableElement);
    const centerBandRect = rect(centerBand);
    const opponentRect = rect(opponentRail);
    const localRect = rect(localBoard);
    const pilesRect = rect(tablePiles);
    const headingRect = rect(heading);
    const headerControlsRect = rect(headerControls);
    const gameStatusRect = gameStatus ? rect(gameStatus) : null;
    const seats = Array.from(opponentRail.querySelectorAll('[data-player-role="opponent"]')).map(rect);
    const seatWidths = seats.map((seat) => seat.width);
    const firstSeat = seats[0];
    const lastSeat = seats.at(-1);

    return {
      centerBandCenterY: rounded(centerBandRect.top + centerBandRect.height / 2),
      centerBandHeight: centerBandRect.height,
      centerBandTop: centerBandRect.top,
      centerDeltaX: rounded(
        Math.abs(pilesRect.left + pilesRect.width / 2 - (tableRect.left + tableRect.width / 2))
      ),
      centerDeltaY: rounded(
        Math.abs(centerBandRect.top + centerBandRect.height / 2 - (tableRect.top + tableRect.height / 2))
      ),
      compactMediaMatches: window.matchMedia('(min-width: 641px) and (max-height: 900px)').matches,
      compactViewportFits: opponentRect.top >= -0.5 && localRect.bottom <= window.innerHeight + 1,
      firstSeatCenterDelta: firstSeat
        ? rounded(Math.abs(firstSeat.left + firstSeat.width / 2 - (opponentRect.left + opponentRect.width / 2)))
        : 0,
      fontStatus: document.fonts.status,
      headerNoOverlap:
        headingRect.right <= headerControlsRect.left + 0.5 ||
        headingRect.bottom <= headerControlsRect.top + 0.5 ||
        headerControlsRect.bottom <= headingRect.top + 0.5,
      headingNotClipped: heading.scrollWidth <= heading.clientWidth + 1,
      headingText: heading.textContent?.trim() || '',
      localBottom: localRect.bottom,
      narrowMediaMatches: window.matchMedia('(max-width: 900px)').matches,
      noOverlap: opponentRect.bottom <= centerBandRect.top + 0.5 && centerBandRect.bottom <= localRect.top + 0.5,
      opponentClientWidth: opponentRail.clientWidth,
      opponentOuterGapDelta:
        firstSeat && lastSeat
          ? rounded(Math.abs(firstSeat.left - opponentRect.left - (opponentRect.right - lastSeat.right)))
          : 0,
      opponentScrollWidth: opponentRail.scrollWidth,
      opponentTop: opponentRect.top,
      pageScrollWidth: document.documentElement.scrollWidth,
      phoneGuidanceVisible: Boolean(document.querySelector('.skyjo-phone-action-guidance')),
      phoneMediaMatches: window.matchMedia('(max-width: 640px)').matches,
      pilesCenterX: rounded(pilesRect.left + pilesRect.width / 2),
      playerCount: tableElement.dataset.playerCount,
      seatWidthSpread: seatWidths.length > 1 ? rounded(Math.max(...seatWidths) - Math.min(...seatWidths)) : 0,
      seatWidths,
      statusOwnRow:
        !gameStatusRect || gameStatusRect.top >= Math.max(headingRect.bottom, headerControlsRect.bottom) - 0.5,
      tableCenterY: rounded(tableRect.top + tableRect.height / 2),
      tableHeight: tableRect.height,
      tableWidth: tableRect.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
  });
}

function responsiveGeometryCriteria(
  geometry: ResponsiveGeometrySnapshot,
  viewport: Viewport,
  playerCount: number
): ResponsiveGeometryCriterion[] {
  const expectedPhone = viewport.width <= 640;
  const expectedNarrow = viewport.width <= 900;
  const expectedCompact = viewport.width >= 641 && viewport.height <= 900;
  const expectedCenterBandHeight = expectedPhone ? 110 : expectedCompact ? 150 : null;
  const centerTolerance = expectedPhone ? 8 : 16;
  const details = JSON.stringify(geometry);
  const criteria: ResponsiveGeometryCriterion[] = [
    {
      id: 'viewport-width',
      message: `${playerCount} players should settle at ${viewport.width}px wide: ${details}`,
      passes: geometry.viewportWidth === viewport.width
    },
    {
      id: 'viewport-height',
      message: `${playerCount} players should settle at ${viewport.height}px high: ${details}`,
      passes: geometry.viewportHeight === viewport.height
    },
    {
      id: 'phone-media',
      message: `${viewport.width}px phone media state should settle: ${details}`,
      passes: geometry.phoneMediaMatches === expectedPhone
    },
    {
      id: 'narrow-media',
      message: `${viewport.width}px narrow media state should settle: ${details}`,
      passes: geometry.narrowMediaMatches === expectedNarrow
    },
    {
      id: 'compact-media',
      message: `${viewport.width}x${viewport.height} compact media state should settle: ${details}`,
      passes: geometry.compactMediaMatches === expectedCompact
    },
    {
      id: 'phone-guidance',
      message: `${viewport.width}px phone guidance state should settle: ${details}`,
      passes: geometry.phoneGuidanceVisible === expectedPhone
    },
    {
      id: 'player-count',
      message: `${playerCount}-player roster should settle: ${details}`,
      passes: geometry.playerCount === String(playerCount)
    },
    {
      id: 'fonts-loaded',
      message: `fonts should finish loading before geometry is accepted: ${details}`,
      passes: geometry.fontStatus === 'loaded'
    },
    {
      id: 'center-x',
      message: `${playerCount} players at ${viewport.width}px center x should be <= ${centerTolerance}: ${details}`,
      passes: geometry.centerDeltaX <= centerTolerance
    },
    {
      id: 'center-y',
      message: `${playerCount} players at ${viewport.width}px center y should be <= ${centerTolerance}: ${details}`,
      passes: geometry.centerDeltaY <= centerTolerance
    },
    {
      id: 'rail-band-board-overlap',
      message: `${playerCount} players at ${viewport.width}px should not overlap: ${details}`,
      passes: geometry.noOverlap
    },
    {
      id: 'heading-text',
      message: `the game heading should remain intact at ${viewport.width}px: ${details}`,
      passes: geometry.headingText === 'Single Player'
    },
    {
      id: 'heading-clipping',
      message: `the game heading should not clip at ${viewport.width}px: ${details}`,
      passes: geometry.headingNotClipped
    },
    {
      id: 'header-overlap',
      message: `the heading and controls should not overlap at ${viewport.width}px: ${details}`,
      passes: geometry.headerNoOverlap
    },
    {
      id: 'status-row',
      message: `the status should remain on its own row at ${viewport.width}px: ${details}`,
      passes: geometry.statusOwnRow
    },
    {
      id: 'page-containment',
      message: `${playerCount} players at ${viewport.width}px should not cause horizontal page scroll: ${details}`,
      passes: geometry.pageScrollWidth <= geometry.viewportWidth + 1
    },
    {
      id: 'seat-width-symmetry',
      message: `${playerCount} players at ${viewport.width}px should use symmetric seat widths: ${details}`,
      passes: geometry.seatWidthSpread <= 2
    }
  ];

  if (expectedCenterBandHeight !== null) {
    criteria.push({
      id: 'settled-center-band-height',
      message: `${playerCount} players at ${viewport.width}x${viewport.height} should settle to a ${expectedCenterBandHeight}px center band: ${details}`,
      passes: Math.abs(geometry.centerBandHeight - expectedCenterBandHeight) <= 0.05
    });
  }
  if (expectedPhone) {
    criteria.push(
      {
        id: 'phone-center-band-minimum',
        message: `${playerCount} players at ${viewport.width}x${viewport.height} should keep at least a 90px center band: ${details}`,
        passes: geometry.centerBandHeight >= 90
      },
      {
        id: 'phone-center-band-maximum',
        message: `${playerCount} players at ${viewport.width}x${viewport.height} should keep at most a 110px center band: ${details}`,
        passes: geometry.centerBandHeight <= 110
      }
    );
  }
  if (expectedCompact) {
    criteria.push({
      id: 'compact-viewport-fit',
      message: `${playerCount} players at ${viewport.width}x${viewport.height} should fit vertically: ${details}`,
      passes: geometry.compactViewportFits
    });
  }
  if (playerCount === 2) {
    criteria.push({
      id: 'single-opponent-centering',
      message: `the single opponent should remain centered at ${viewport.width}px: ${details}`,
      passes: geometry.firstSeatCenterDelta <= 2
    });
  }
  if (playerCount === 3) {
    criteria.push({
      id: 'opponent-outer-gap-symmetry',
      message: `the opponent outer gaps should remain symmetric at ${viewport.width}px: ${details}`,
      passes: geometry.opponentOuterGapDelta <= 2
    });
  }
  if (playerCount === 8 || (playerCount === 4 && expectedNarrow)) {
    criteria.push({
      id: 'opponent-rail-scroll',
      message: `${playerCount} players at ${viewport.width}px should retain opponent-rail scrolling: ${details}`,
      passes: geometry.opponentScrollWidth > geometry.opponentClientWidth + 1
    });
  }

  return criteria;
}

function assertResponsiveGeometry(geometry: ResponsiveGeometrySnapshot, viewport: Viewport, playerCount: number) {
  for (const criterion of responsiveGeometryCriteria(geometry, viewport, playerCount)) {
    expect(criterion.passes, criterion.message).toBe(true);
  }
}

async function settleResponsiveTable(
  page: Page,
  viewport: Viewport,
  playerCount: number
): Promise<ResponsiveGeometrySnapshot> {
  await page.setViewportSize(viewport);
  const table = page.getByTestId('shared-game-table');
  await expect(table).toHaveAttribute('data-player-count', String(playerCount));
  const requiredStableSamples = 4;
  let lastSample: ResponsiveGeometrySnapshot | undefined;
  let previousSignature = '';
  let stableSamples = 0;

  await expect
    .poll(
      async () => {
        const current = await readResponsiveGeometry(page);
        lastSample = current;
        const criteria = responsiveGeometryCriteria(current, viewport, playerCount);
        const failedCriteria = criteria.filter((criterion) => !criterion.passes).map((criterion) => criterion.id);
        const responsiveGeometryAccepted = failedCriteria.length === 0;
        const signature = JSON.stringify(current);
        stableSamples = responsiveGeometryAccepted
          ? signature === previousSignature
            ? Math.min(stableSamples + 1, requiredStableSamples)
            : 1
          : 0;
        previousSignature = signature;
        return { failedCriteria, responsiveGeometryAccepted, stableSamples, sample: current };
      },
      {
        intervals: [25, 50, 100, 250],
        message: `responsive table should settle at ${viewport.width}x${viewport.height}`,
        timeout: 7_500
      }
    )
    .toMatchObject({
      failedCriteria: [],
      responsiveGeometryAccepted: true,
      stableSamples: requiredStableSamples
    });

  if (!lastSample) throw new Error('Responsive table settlement produced no sample.');
  assertResponsiveGeometry(lastSample, viewport, playerCount);
  return lastSample;
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
  // This test runs two measured eight-player openings; keep their 3s/1s budgets strict while
  // allowing WebKit enough wall-clock headroom for setup and ordinary hover actionability.
  test.setTimeout(60_000);
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

      expect(samples.map((sample) => sample.centerBandHeight)).toEqual([150, 110, 150, 110, 150]);
      expect(samples.map((sample) => sample.phoneMediaMatches)).toEqual([false, true, false, true, false]);
      expect(samples.map((sample) => sample.compactMediaMatches)).toEqual([true, false, true, false, true]);
      expect(samples.map((sample) => sample.phoneGuidanceVisible)).toEqual([false, true, false, true, false]);
      expect(samples.map(({ viewportWidth, viewportHeight }) => [viewportWidth, viewportHeight])).toEqual(
        transitions.map(({ width, height }) => [width, height])
      );
    }
  });
});
