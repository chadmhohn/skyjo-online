import { randomUUID } from 'node:crypto';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { GameState } from '../../../src/types';
import { soloProgressGameStates } from '../../helpers/soloGameState';
import { configureSoloSetup, finishSoloSetup, startFreshSoloGame } from '../helpers/soloFlow';

type Viewport = { width: number; height: number };

type SoloPhoneVariant = Viewport & {
  label: string;
  safeAreaStress?: boolean;
  textScale?: boolean;
};

type SoloDrawnCardLayoutSnapshot = {
  backContentFits: boolean;
  backMetrics: { clientHeight: number; clientWidth: number; scrollHeight: number; scrollWidth: number };
  backPseudoContent: string;
  band: DOMRectSnapshot;
  decisionButtons: DOMRectSnapshot[];
  decisionHitTargets: boolean[];
  decisionLabels: Array<{ contained: boolean; fontSize: number; text: string }>;
  document: {
    clientHeight: number;
    clientWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
    scrollWidth: number;
  };
  drawnCard: DOMRectSnapshot;
  drawnCardLabel: string;
  drawnCardText: string;
  drawnDisplay: string;
  drawnFontSize: number;
  drawnHitTarget: boolean;
  drawnOpacity: string;
  drawnParentDisplay: string;
  drawnTopmost: boolean;
  drawnTopmostIdentity: string;
  drawnVisibility: string;
  gameHeader: DOMRectSnapshot;
  gameStatus: DOMRectSnapshot;
  gameStatusClientHeight: number;
  gameStatusClientWidth: number;
  gameStatusFontSize: number;
  gameStatusOverflowY: string;
  gameStatusRole: string;
  gameStatusScrollHeight: number;
  gameStatusScrollWidth: number;
  gameStatusText: string;
  guidance: DOMRectSnapshot;
  guidanceInstructionFontSize: number;
  guidanceMaxHeight: string;
  guidanceNoteFontSize: number;
  guidanceTitle: DOMRectSnapshot;
  guidanceTitleContentFits: boolean;
  guidanceTitleFontSize: number;
  guidanceTitleText: string;
  guidanceOverflowY: string;
  guidanceText: string;
  headerTargets: DOMRectSnapshot[];
  localBoard: DOMRectSnapshot;
  localBoardHitTarget: boolean;
  opponentRail: DOMRectSnapshot;
  opponentRailHitTarget: boolean;
  pileTypography: Array<{
    cardContained: boolean;
    cardFontSize: number;
    cardText: string;
    labelContained: boolean;
    labelFontSize: number;
    labelText: string;
  }>;
  pileHitTargets: boolean[];
  sharedTable: DOMRectSnapshot;
  tableCenterColumns: string;
  tableCenterDrawnClass: boolean;
  tableCenterDrawnDecision: string;
  tableShell: DOMRectSnapshot;
  title: DOMRectSnapshot;
  titleContentFits: boolean;
  titleContentMetrics: { clientHeight: number; clientWidth: number; scrollHeight: number; scrollWidth: number };
  titleFontSize: number;
  titleText: string;
  updateBanner: DOMRectSnapshot;
  updateBannerContentFits: boolean;
  updateContentMetrics: Array<{
    clientHeight: number;
    clientWidth: number;
    scrollHeight: number;
    scrollWidth: number;
    text: string;
  }>;
  updateProtectedFontSize: number;
  updateStrongFontSize: number;
  viewport: Viewport;
};

type DOMRectSnapshot = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type SoloPileGeometrySnapshot = {
  band: DOMRectSnapshot;
  buttons: DOMRectSnapshot[];
  documentScroll: { left: number; top: number };
  labels: Array<{ clientWidth: number; fits: boolean; scrollWidth: number; text: string }>;
  midpointDelta: number;
  piles: DOMRectSnapshot;
};

const iphone16ProMax = devices['iPhone 16 Pro Max'];
const soloDrawnCardViewports: ReadonlyArray<SoloPhoneVariant> = [
  { label: 'iPhone 16 Pro Max', width: 440, height: 956 },
  { label: 'iPhone 16 Pro Max at 200% text', width: 440, height: 956, textScale: true },
  { label: 'iPhone 16 Pro Max landscape', width: 956, height: 440 },
  { label: 'iPhone 16 Pro Max landscape at 200% text', width: 956, height: 440, textScale: true },
  {
    label: 'iPhone 16 Pro Max landscape safe-area stress at 200% text',
    width: 956,
    height: 440,
    safeAreaStress: true,
    textScale: true
  },
  { label: 'compact 361px at 200% text', width: 361, height: 780, textScale: true },
  { label: 'compact 374px boundary at 200% text', width: 374, height: 812, textScale: true },
  { label: 'first readable portrait at 200% text', width: 375, height: 812, textScale: true },
  { label: 'standard phone at 200% text', width: 390, height: 844, textScale: true },
  { label: 'large phone at 200% text', width: 430, height: 932, textScale: true },
  { label: 'compact phone floor', width: 320, height: 568 },
  { label: 'compact phone floor at 200% text', width: 320, height: 568, textScale: true }
] as const;

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
  await settings.getByRole('button', { name: 'Set up another game…' }).click();
  await configureSoloSetup(page, { opponents: playerCount - 1 });
  await finishSoloSetup(page);
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

async function setSoloWorkerVariant(
  context: BrowserContext,
  baseURL: string,
  variant: 'A' | 'B',
  buildNonce: string
): Promise<void> {
  await context.addCookies([
    { name: 'skyjo_sw_test_variant', value: variant, url: baseURL, sameSite: 'Lax' },
    { name: 'skyjo_sw_test_worker_nonce', value: buildNonce, url: baseURL, sameSite: 'Lax' }
  ]);
}

async function waitForSoloServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Service worker did not claim the solo page.')), 10_000);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
    });
  });
}

async function stageSoloPwaUpdate(context: BrowserContext, page: Page, baseURL: string): Promise<void> {
  const activeLayout = page.locator('.skyjo-active-game-layout');
  await setSoloWorkerVariant(context, baseURL, 'B', randomUUID());
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          return registration?.waiting?.state ?? null;
        }),
      { intervals: [100, 250, 500, 1_000], timeout: 15_000 }
    )
    .toBe('installed');
  await expect(page.getByTestId('pwa-update-banner')).toContainText('Game protected');
  await expect(page.getByTestId('pwa-update-banner')).toHaveAttribute('aria-atomic', 'true');
  const deferredDetail = page.getByTestId('pwa-update-banner').locator('div > span');
  await expect(deferredDetail).toContainText('After this game.');
  await expect(deferredDetail).not.toHaveCSS('display', 'none');
  await expect(deferredDetail).not.toHaveCSS('visibility', 'hidden');
  await expect(deferredDetail).not.toHaveAttribute('aria-hidden', 'true');
  await expect(activeLayout).toHaveAttribute('data-pwa-update-deferred', 'true');
}

async function forceSoloQuotaWarning(page: Page): Promise<void> {
  await page.evaluate(() => {
    const originalTransaction = IDBDatabase.prototype.transaction;
    Object.defineProperty(IDBDatabase.prototype, 'transaction', {
      configurable: true,
      value: function transaction(
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
      ) {
        const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
        if (mode === 'readwrite' && names.includes('soloSessions')) {
          throw new DOMException('Simulated quota pressure.', 'QuotaExceededError');
        }
        return originalTransaction.call(this, storeNames, mode, options);
      }
    });
  });
}

async function applyLandscapeSafeAreaFixedOffsets(page: Page): Promise<void> {
  const banner = page.getByTestId('pwa-update-banner');
  await banner.evaluate((element) => {
    element.style.setProperty('right', '62px', 'important');
    element.style.setProperty('bottom', '21px', 'important');
    element.style.setProperty('left', '62px', 'important');
    const restore = document.querySelector<HTMLElement>('[data-testid="round-summary-restore"]');
    restore?.style.setProperty('bottom', '69px', 'important');
  });
  await expect.poll(() => banner.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.right, style.bottom, style.left];
  })).toEqual(['62px', '21px', '62px']);
}

async function openSoloPhone(
  browser: Browser,
  baseURL: string,
  accessPassword: string,
  variant: SoloPhoneVariant,
  seed: number
) {
  const viewport = { width: variant.width, height: variant.height };
  const context = await browser.newContext({
    deviceScaleFactor: iphone16ProMax.deviceScaleFactor,
    hasTouch: iphone16ProMax.hasTouch,
    isMobile: iphone16ProMax.isMobile,
    screen: viewport,
    serviceWorkers: 'allow',
    userAgent: iphone16ProMax.userAgent,
    viewport
  });
  try {
    await setSoloWorkerVariant(context, baseURL, 'A', randomUUID());
    const access = await context.request.post(`${baseURL}/login`, {
      form: { next: '/', password: accessPassword }
    });
    expect(access.ok(), `Test access login returned ${access.status()}: ${await access.text()}`).toBe(true);
    const page = await context.newPage();
    await installSeededBrowserRuntime(page, seed);
    if (variant.textScale) {
      await page.addInitScript(() => {
        // Model iOS text size before startup; late root scaling can leave WebKit with mixed rem used values.
        const applyTextScale = () => {
          if (!document.documentElement) return false;
          document.documentElement.classList.add('skyjo-test-text-scale-200');
          return true;
        };
        if (!applyTextScale()) {
          const observer = new MutationObserver(() => {
            if (applyTextScale()) observer.disconnect();
          });
          observer.observe(document, { childList: true });
        }
      });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseURL}/single-player`);
    await waitForSoloServiceWorkerControl(page);
    if (variant.textScale) {
      await expect(page.locator('html')).toHaveClass(/skyjo-test-text-scale-200/);
    }
    await configureSoloSetup(page);
    await finishSoloSetup(page);
    if (variant.safeAreaStress) {
      await page.locator('main.skyjo-surface').evaluate((main) => {
        main.style.setProperty('padding-top', '4px', 'important');
        main.style.setProperty('padding-right', '62px', 'important');
        main.style.setProperty('padding-bottom', '21px', 'important');
        main.style.setProperty('padding-left', '62px', 'important');
      });
      await expect.poll(() => page.locator('main.skyjo-surface').evaluate((main) => {
        const style = getComputedStyle(main);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
      })).toEqual(['4px', '62px', '21px', '62px']);
    }
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function readSoloPileGeometry(page: Page): Promise<SoloPileGeometrySnapshot> {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing solo phone pile geometry anchor: ${selector}`);
      return element;
    };
    const rect = (element: Element): DOMRectSnapshot => {
      const value = element.getBoundingClientRect();
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width
      };
    };
    const band = required('[data-testid="table-center-band"]');
    const piles = required('[data-testid="table-piles"]');
    const buttons = Array.from(piles.querySelectorAll<HTMLElement>('.skyjo-pile-button'));
    const bandRect = band.getBoundingClientRect();
    const pileRect = piles.getBoundingClientRect();
    const scrolling = document.scrollingElement;
    if (!scrolling) throw new Error('Document scrolling element was unavailable.');

    return {
      band: rect(band),
      buttons: buttons.map(rect),
      documentScroll: { left: scrolling.scrollLeft, top: scrolling.scrollTop },
      labels: buttons.map((button) => {
        const label = button.querySelector<HTMLElement>('.skyjo-kicker');
        if (!label) throw new Error('Solo pile label was unavailable.');
        const labelRect = label.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        const textRect = range.getBoundingClientRect();
        return {
          clientWidth: label.clientWidth,
          fits:
            label.scrollWidth <= label.clientWidth + 1 &&
            textRect.left >= labelRect.left - 1 &&
            textRect.right <= labelRect.right + 1 &&
            textRect.top >= labelRect.top - 1 &&
            textRect.bottom <= labelRect.bottom + 1,
          scrollWidth: label.scrollWidth,
          text: label.textContent?.trim() ?? ''
        };
      }),
      midpointDelta: Math.abs(
        pileRect.left + pileRect.width / 2 - (bandRect.left + bandRect.width / 2)
      ),
      piles: rect(piles)
    };
  });
}

async function stageSoloPhoneState(page: Page, baseURL: string, state: GameState, stateIndex: number): Promise<void> {
  await page.goto(baseURL);
  await page.evaluate(
    ({ record }) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('skyjo-pwa', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('soloSessions', 'readwrite');
        const store = transaction.objectStore('soloSessions');
        store.clear();
        store.put(record);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      };
    }),
    {
      record: {
        ownerKey: 'guest',
        gameId: `00000000-0000-4000-8000-${String(stateIndex).padStart(12, '0')}`,
        schemaVersion: 1,
        state,
        aiOpponentCount: 1,
        updatedAt: Date.now() + stateIndex
      }
    }
  );
  await page.goto(`${baseURL}/single-player`);
  const launcher = page.getByTestId('solo-launcher');
  await expect(launcher).toBeVisible();
  await launcher.getByRole('button', { name: 'Continue Solo' }).click();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', state.phase);
}

async function readSoloDrawnCardLayout(page: Page): Promise<SoloDrawnCardLayoutSnapshot> {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing solo drawn-card layout anchor: ${selector}`);
      return element;
    };
    const rect = (element: Element): DOMRectSnapshot => {
      const value = element.getBoundingClientRect();
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width
      };
    };
    const insetPointsHit = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      const inset = Math.min(4, value.width / 4, value.height / 4);
      return [
        [value.left + inset, value.top + inset],
        [value.right - inset, value.top + inset],
        [value.left + value.width / 2, value.top + value.height / 2],
        [value.left + inset, value.bottom - inset],
        [value.right - inset, value.bottom - inset]
      ].every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || Boolean(hit && element.contains(hit));
      });
    };
    const scrolling = document.scrollingElement;
    if (!scrolling) throw new Error('Document scrolling element was unavailable.');
    const band = required('[data-testid="table-center-band"]');
    const drawnCard = required('.skyjo-drawn-card');
    const back = required('.skyjo-back-link');
    const gameHeader = required('.skyjo-game-header');
    const gameStatus = required('.skyjo-game-status');
    const gameStatusParagraph = required('.skyjo-game-status p');
    const guidance = required('.skyjo-phone-action-guidance');
    const guidanceInstruction = required('.skyjo-phone-action-guidance .skyjo-action-guidance-instruction');
    const guidanceNote = required('.skyjo-phone-action-guidance .skyjo-disabled-note');
    const guidanceTitle = required('.skyjo-phone-action-guidance .skyjo-action-guidance-title');
    const tableShell = required('.skyjo-game-table-shell');
    const tableCenter = required('[data-testid="table-center"]');
    const title = required('.skyjo-game-title');
    const updateBanner = required('[data-testid="pwa-update-banner"]');
    const updateProtected = required('.skyjo-update-deferred');
    const updateStrong = required('[data-testid="pwa-update-banner"] strong');
    const updateContent = Array.from(updateBanner.querySelectorAll<HTMLElement>('strong, .skyjo-update-deferred')).filter(
      (element) => window.getComputedStyle(element).display !== 'none'
    );
    const pileButtons = Array.from(
      required('[data-testid="table-piles"]').querySelectorAll<HTMLButtonElement>('.skyjo-pile-button')
    );
    const drawnRect = drawnCard.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      drawnRect.left + drawnRect.width / 2,
      drawnRect.top + drawnRect.height / 2
    );
    const style = window.getComputedStyle(drawnCard);
    const decisionLabels = Array.from(
      band.querySelectorAll<HTMLElement>('.skyjo-drawn-decision .skyjo-choice-label-compact')
    ).filter((element) => window.getComputedStyle(element).display !== 'none');
    const decisionButtons = Array.from(
      band.querySelectorAll<HTMLElement>('.skyjo-drawn-decision .skyjo-choice-button')
    );
    const localBoard = required('[data-testid="local-board"]');
    const opponentRail = required('[data-testid="opponent-rail"]');

    return {
      backContentFits: back.scrollWidth <= back.clientWidth + 1 && back.scrollHeight <= back.clientHeight + 1,
      backMetrics: {
        clientHeight: back.clientHeight,
        clientWidth: back.clientWidth,
        scrollHeight: back.scrollHeight,
        scrollWidth: back.scrollWidth
      },
      backPseudoContent: window.getComputedStyle(back, '::before').content,
      band: rect(band),
      decisionButtons: decisionButtons.map(rect),
      decisionHitTargets: decisionButtons.map(insetPointsHit),
      decisionLabels: decisionLabels.map((label) => {
        const labelRect = label.getBoundingClientRect();
        const buttonRect = label.closest('button')?.getBoundingClientRect();
        return {
          contained: Boolean(
            buttonRect &&
              labelRect.left >= buttonRect.left - 1 &&
              labelRect.right <= buttonRect.right + 1 &&
              labelRect.top >= buttonRect.top - 1 &&
              labelRect.bottom <= buttonRect.bottom + 1
          ),
          fontSize: Number.parseFloat(window.getComputedStyle(label).fontSize),
          text: label.textContent?.trim() || ''
        };
      }),
      document: {
        clientHeight: scrolling.clientHeight,
        clientWidth: scrolling.clientWidth,
        scrollHeight: scrolling.scrollHeight,
        scrollLeft: scrolling.scrollLeft,
        scrollTop: scrolling.scrollTop,
        scrollWidth: scrolling.scrollWidth
      },
      drawnCard: rect(drawnCard),
      drawnCardLabel: drawnCard.getAttribute('aria-label') || '',
      drawnCardText: drawnCard.textContent?.trim() || '',
      drawnDisplay: style.display,
      drawnFontSize: Number.parseFloat(style.fontSize),
      drawnHitTarget: insetPointsHit(drawnCard),
      drawnOpacity: style.opacity,
      drawnParentDisplay: window.getComputedStyle(drawnCard.parentElement as HTMLElement).display,
      drawnTopmost: topmost === drawnCard || Boolean(topmost && drawnCard.contains(topmost)),
      drawnTopmostIdentity: topmost instanceof HTMLElement
        ? `${topmost.tagName}.${topmost.className}#${topmost.id}`
        : String(topmost),
      drawnVisibility: style.visibility,
      gameHeader: rect(gameHeader),
      gameStatus: rect(gameStatus),
      gameStatusClientHeight: gameStatus.clientHeight,
      gameStatusClientWidth: gameStatus.clientWidth,
      gameStatusFontSize: Number.parseFloat(window.getComputedStyle(gameStatusParagraph).fontSize),
      gameStatusOverflowY: window.getComputedStyle(gameStatus).overflowY,
      gameStatusRole: gameStatusParagraph.getAttribute('role') || '',
      gameStatusScrollHeight: gameStatus.scrollHeight,
      gameStatusScrollWidth: gameStatus.scrollWidth,
      gameStatusText: gameStatusParagraph.textContent?.trim() || '',
      guidance: rect(guidance),
      guidanceInstructionFontSize: Number.parseFloat(window.getComputedStyle(guidanceInstruction).fontSize),
      guidanceMaxHeight: window.getComputedStyle(guidance).maxHeight,
      guidanceNoteFontSize: Number.parseFloat(window.getComputedStyle(guidanceNote).fontSize),
      guidanceTitle: rect(guidanceTitle),
      guidanceTitleContentFits:
        guidanceTitle.scrollWidth <= guidanceTitle.clientWidth + 1 &&
        guidanceTitle.scrollHeight <= guidanceTitle.clientHeight + 1,
      guidanceTitleText: guidanceTitle.textContent?.trim() || '',
      guidanceTitleFontSize: Number.parseFloat(window.getComputedStyle(guidanceTitle).fontSize),
      guidanceOverflowY: window.getComputedStyle(guidance).overflowY,
      guidanceText: guidance.textContent?.trim().replace(/\s+/g, ' ') || '',
      headerTargets: Array.from(
        gameHeader.querySelectorAll<HTMLElement>('.skyjo-back-link, .skyjo-header-controls button')
      ).map(rect),
      localBoard: rect(localBoard),
      localBoardHitTarget: insetPointsHit(localBoard),
      opponentRail: rect(opponentRail),
      opponentRailHitTarget: insetPointsHit(opponentRail),
      pileTypography: pileButtons.map((button) => {
        const buttonRect = button.getBoundingClientRect();
        const card = button.querySelector<HTMLElement>('.skyjo-table-card');
        const label = button.querySelector<HTMLElement>('.skyjo-kicker');
        if (!card || !label) throw new Error('Missing visible pile typography.');
        const cardRect = card.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const contained = (child: DOMRect) =>
          child.left >= buttonRect.left - 1 &&
          child.right <= buttonRect.right + 1 &&
          child.top >= buttonRect.top - 1 &&
          child.bottom <= buttonRect.bottom + 1;
        return {
          cardContained: contained(cardRect) && card.scrollWidth <= card.clientWidth + 1,
          cardFontSize: Number.parseFloat(window.getComputedStyle(card).fontSize),
          cardText: card.textContent?.trim() || '',
          labelContained: contained(labelRect),
          labelFontSize: Number.parseFloat(window.getComputedStyle(label).fontSize),
          labelText: label.textContent?.trim() || ''
        };
      }),
      pileHitTargets: pileButtons.map(insetPointsHit),
      sharedTable: rect(required('[data-testid="shared-game-table"]')),
      tableCenterColumns: window.getComputedStyle(tableCenter).gridTemplateColumns,
      tableCenterDrawnClass: tableCenter.classList.contains('skyjo-table-controls-drawn'),
      tableCenterDrawnDecision: tableCenter.getAttribute('data-drawn-decision') || '',
      tableShell: rect(tableShell),
      title: rect(title),
      titleContentFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1,
      titleContentMetrics: {
        clientHeight: title.clientHeight,
        clientWidth: title.clientWidth,
        scrollHeight: title.scrollHeight,
        scrollWidth: title.scrollWidth
      },
      titleFontSize: Number.parseFloat(window.getComputedStyle(title).fontSize),
      titleText: title.textContent?.trim() || '',
      updateBanner: rect(updateBanner),
      updateBannerContentFits: updateContent.every((element) => {
        const bannerRect = updateBanner.getBoundingClientRect();
        const contentRect = element.getBoundingClientRect();
        return (
          element.scrollWidth <= element.clientWidth + 1 &&
          contentRect.left >= bannerRect.left - 1 &&
          contentRect.right <= bannerRect.right + 1 &&
          contentRect.top >= bannerRect.top - 1 &&
          contentRect.bottom <= bannerRect.bottom + 1
        );
      }),
      updateContentMetrics: updateContent.map((element) => ({
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        text: element.textContent?.trim() || ''
      })),
      updateProtectedFontSize: Number.parseFloat(window.getComputedStyle(updateProtected).fontSize),
      updateStrongFontSize: Number.parseFloat(window.getComputedStyle(updateStrong).fontSize),
      viewport: { height: window.innerHeight, width: window.innerWidth }
    };
  });
}

function rectIsInside(inner: DOMRectSnapshot, outer: DOMRectSnapshot, tolerance = 1): boolean {
  return (
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}

function rectsOverlap(first: DOMRectSnapshot, second: DOMRectSnapshot, tolerance = 1): boolean {
  return !(
    first.right <= second.left + tolerance ||
    second.right <= first.left + tolerance ||
    first.bottom <= second.top + tolerance ||
    second.bottom <= first.top + tolerance
  );
}

function expectSoloPileGeometry(snapshot: SoloPileGeometrySnapshot, expectedLabels: string[]): void {
  expect(snapshot.documentScroll).toEqual({ left: 0, top: 0 });
  expect(snapshot.labels.map(({ text }) => text)).toEqual(expectedLabels);
  expect(
    snapshot.labels.every(({ fits }) => fits),
    `phone pile labels should render in full: ${JSON.stringify(snapshot.labels)}`
  ).toBe(true);
  expect(snapshot.buttons).toHaveLength(2);
  for (const [index, button] of snapshot.buttons.entries()) {
    expect(button.width + 0.01, `solo pile ${index + 1} should be at least 44px wide`).toBeGreaterThanOrEqual(44);
    expect(button.height + 0.01, `solo pile ${index + 1} should be at least 44px high`).toBeGreaterThanOrEqual(44);
    expect(rectIsInside(button, snapshot.band), `solo pile ${index + 1} should stay inside the center band`).toBe(true);
  }
  expect(snapshot.midpointDelta, 'solo piles should remain centered in the phone band').toBeLessThanOrEqual(8);
}

function expectSoloPileGeometryStable(
  before: SoloPileGeometrySnapshot,
  after: SoloPileGeometrySnapshot,
  label: string
): void {
  const expectRectStable = (reference: DOMRectSnapshot, candidate: DOMRectSnapshot, rectLabel: string) => {
    for (const key of ['bottom', 'height', 'left', 'right', 'top', 'width'] as const) {
      expect(Math.abs(candidate[key] - reference[key]), `${rectLabel} ${key} should remain stable`).toBeLessThanOrEqual(1);
    }
  };
  expectRectStable(before.piles, after.piles, `${label} pile group`);
  expect(after.buttons).toHaveLength(before.buttons.length);
  for (const [index, button] of after.buttons.entries()) {
    expectRectStable(before.buttons[index], button, `${label} pile ${index + 1}`);
  }
}

function expectPhoneScaledTextOutcome(normal: number, scaled: number, scaledMinimum: number, label: string): void {
  expect(scaled, `${label} should meet its readable 200% effective size`).toBeGreaterThanOrEqual(scaledMinimum);
  expect(scaled + 0.01, `${label} should not shrink at 200% text`).toBeGreaterThanOrEqual(normal);
  expect(
    scaled / normal >= 1.9 || normal >= scaledMinimum - 0.01,
    `${label} should either grow with the doubled root or already be browser-inflated to the target: ${JSON.stringify({ normal, scaled })}`
  ).toBe(true);
}

async function expectKeyboardReachableRegionEnd(
  page: Page,
  regionSelector: string,
  finalContentSelector: string,
  label: string
): Promise<void> {
  const region = page.locator(regionSelector);
  await expect(region, `${label} should be a keyboard-focusable region`).toHaveAttribute('tabindex', '0');
  await region.focus();
  await expect(region).toBeFocused();
  const focusIndicator = await region.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return [style.outlineStyle, Number.parseFloat(style.outlineWidth), style.boxShadow !== 'none'];
  }) as [string, number, boolean];
  expect(focusIndicator[0], `${label} should retain a solid authored focus indicator`).toBe('solid');
  expect(focusIndicator[1], `${label} focus indicator should be at least 2px`).toBeGreaterThanOrEqual(2);
  expect(focusIndicator[2], `${label} should retain its inset high-contrast ring`).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  const maximum = await region.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(maximum, `${label} should have real internal overflow at the compact 200% floor`).toBeGreaterThan(1);
  await page.keyboard.press('PageDown');
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() =>
    region.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))
  ).toBeLessThanOrEqual(1);
  const endIsExposed = await page.locator(finalContentSelector).evaluate((content, selector) => {
    const region = document.querySelector<HTMLElement>(selector);
    if (!region) return false;
    const regionRect = region.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return contentRect.bottom <= regionRect.bottom + 1 && contentRect.bottom > regionRect.top + 1;
  }, regionSelector);
  expect(endIsExposed, `${label} End should expose its final content line`).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => ({ left: window.scrollX, top: window.scrollY }))).toEqual({ left: 0, top: 0 });
}

function expectedDeferredGuidanceMaxHeight(variant: SoloPhoneVariant): number {
  if (variant.height < variant.width) return 44;
  if (variant.width <= 374) return 64;
  if (variant.width <= 389) return 88;
  return 120;
}

function expectSoloDrawnCardLayout(snapshot: SoloDrawnCardLayoutSnapshot, variant: SoloPhoneVariant): void {
  const viewport: DOMRectSnapshot = {
    bottom: variant.height,
    height: variant.height,
    left: 0,
    right: variant.width,
    top: 0,
    width: variant.width
  };
  expect(snapshot.viewport, `${variant.label} viewport should settle`).toEqual({
    height: variant.height,
    width: variant.width
  });
  expect(snapshot.document.scrollTop, `${variant.label} should not scroll vertically`).toBe(0);
  expect(snapshot.document.scrollLeft, `${variant.label} should not scroll horizontally`).toBe(0);
  expect(snapshot.document.scrollHeight, `${variant.label} document should fit vertically`).toBeLessThanOrEqual(
    snapshot.document.clientHeight + 1
  );
  expect(snapshot.document.scrollWidth, `${variant.label} document should fit horizontally`).toBeLessThanOrEqual(
    snapshot.document.clientWidth + 1
  );
  for (const [label, region] of [
    ['game header', snapshot.gameHeader],
    ['game status', snapshot.gameStatus],
    ['action guidance', snapshot.guidance],
    ['shared table', snapshot.sharedTable],
    ['table shell', snapshot.tableShell],
    ['update banner', snapshot.updateBanner]
  ] as const) {
    expect(rectIsInside(region, viewport), `${variant.label} ${label} should remain in the viewport`).toBe(true);
  }
  expect(rectIsInside(snapshot.title, snapshot.gameHeader), `${variant.label} title should stay inside the header`).toBe(true);
  expect(snapshot.backPseudoContent, `${variant.label} Back should use its contained icon`).toContain('<');
  expect(
    snapshot.backContentFits,
    `${variant.label} Back icon should stay inside its 44px target: ${JSON.stringify(snapshot.backMetrics)}`
  ).toBe(true);
  expect(snapshot.titleText, `${variant.label} heading should retain its full accessible and visible name`).toBe('Single Player');
  expect(
    snapshot.titleContentFits,
    `${variant.label} visible title should stay inside its header allocation: ${JSON.stringify(snapshot.titleContentMetrics)}`
  ).toBe(true);
  expect(rectIsInside(snapshot.guidanceTitle, snapshot.guidance), `${variant.label} guidance title should stay in its region`).toBe(
    true
  );
  expect(snapshot.guidanceTitleText, `${variant.label} should render the complete action-guidance heading`).toBe(
    'Drawn card waiting'
  );
  expect(snapshot.guidanceTitleContentFits, `${variant.label} guidance title should not clip or overflow`).toBe(true);
  expect(rectIsInside(snapshot.gameStatus, snapshot.gameHeader), `${variant.label} status should stay inside the header`).toBe(
    true
  );
  expect(snapshot.gameStatusOverflowY, `${variant.label} status should have bounded internal overflow`).toBe('auto');
  expect(snapshot.gameStatusRole, `${variant.label} persistence warning should remain a VoiceOver status`).toBe('status');
  expect(snapshot.gameStatusText, `${variant.label} persistence warning text should remain in the accessibility tree`).toBe(
    'This device is low on storage. You can keep playing, but this game may not restore after closing Skyjo.'
  );
  expect(snapshot.gameStatusScrollWidth, `${variant.label} status text should wrap without horizontal clipping`).toBeLessThanOrEqual(
    snapshot.gameStatusClientWidth + 1
  );
  expect(snapshot.guidanceText, `${variant.label} action guidance should remain available to VoiceOver`).toContain(
    'Drawn card waiting'
  );
  if (variant.width <= 374) {
    expect(snapshot.guidanceOverflowY, `${variant.label} guidance should use bounded internal overflow`).toBe('auto');
  }
  expect(
    Number.parseFloat(snapshot.guidanceMaxHeight),
    `${variant.label} guidance should use the deterministic breakpoint height`
  ).toBeCloseTo(expectedDeferredGuidanceMaxHeight(variant), 2);
  expect(snapshot.headerTargets, `${variant.label} should retain Back and Settings controls`).toHaveLength(2);
  for (const [index, target] of snapshot.headerTargets.entries()) {
    expect(target.width + 0.01, `${variant.label} header target ${index + 1} should be at least 44px wide`).toBeGreaterThanOrEqual(
      44
    );
    expect(
      target.height + 0.01,
      `${variant.label} header target ${index + 1} should be at least 44px high`
    ).toBeGreaterThanOrEqual(44);
    expect(rectIsInside(target, snapshot.gameHeader), `${variant.label} header target ${index + 1} should stay in the header`).toBe(
      true
    );
  }
  expect(
    snapshot.gameHeader.bottom <= snapshot.tableShell.top + 1,
    `${variant.label} header and live status should not overlap the table shell`
  ).toBe(true);
  expect(
    snapshot.guidance.bottom <= snapshot.sharedTable.top + 1,
    `${variant.label} action guidance should not overlap the shared table`
  ).toBe(true);
  expect(
    snapshot.tableShell.bottom <= snapshot.updateBanner.top + 1,
    `${variant.label} deferred update banner should not overlap the table`
  ).toBe(true);
  expect(
    snapshot.updateBannerContentFits,
    `${variant.label} deferred update copy should not clip: ${JSON.stringify(snapshot.updateContentMetrics)}`
  ).toBe(true);
  expect(snapshot.drawnParentDisplay, `${variant.label} drawn-card wrapper should participate in layout`).toBe('flex');
  expect(snapshot.drawnDisplay, `${variant.label} drawn card should render`).not.toBe('none');
  expect(snapshot.drawnVisibility, `${variant.label} drawn card should be visible`).toBe('visible');
  expect(Number(snapshot.drawnOpacity), `${variant.label} drawn card should be opaque`).toBeGreaterThan(0);
  expect(snapshot.drawnCard.width, `${variant.label} drawn card should have width`).toBeGreaterThan(0);
  expect(snapshot.drawnCard.height, `${variant.label} drawn card should have height`).toBeGreaterThan(0);
  expect(snapshot.drawnCardText, `${variant.label} should show the private drawn value`).toMatch(/^-?\d+$/);
  expect(snapshot.drawnCardLabel, `${variant.label} should expose the drawn-card label`).toMatch(/^Drawn card -?\d+$/);
  expect(snapshot.drawnHitTarget, `${variant.label} drawn card should remain fully hit-testable`).toBe(true);
  expect(
    snapshot.drawnTopmost,
    `${variant.label} drawn card should not be visually occluded; topmost=${snapshot.drawnTopmostIdentity}`
  ).toBe(true);
  expect(rectIsInside(snapshot.band, viewport), `${variant.label} center band should remain in the viewport`).toBe(true);
  expect(rectIsInside(snapshot.drawnCard, snapshot.band), `${variant.label} drawn card should stay in the center band`).toBe(
    true
  );
  expect(rectIsInside(snapshot.drawnCard, viewport), `${variant.label} drawn card should remain in the viewport`).toBe(true);
  expect(
    snapshot.opponentRail.bottom <= snapshot.band.top + 1,
    `${variant.label} opponent rail should not overlap the center band`
  ).toBe(true);
  expect(snapshot.opponentRailHitTarget, `${variant.label} opponent rail should remain fully hit-testable`).toBe(true);
  expect(
    snapshot.band.bottom <= snapshot.localBoard.top + 1,
    `${variant.label} center band should not overlap the local board`
  ).toBe(true);
  expect(snapshot.localBoardHitTarget, `${variant.label} local board should remain fully hit-testable`).toBe(true);
  expect(snapshot.pileTypography, `${variant.label} should render both visible pile labels and cards`).toHaveLength(2);
  expect(snapshot.pileHitTargets.every(Boolean), `${variant.label} both pile controls should remain fully hit-testable`).toBe(true);
  expect(snapshot.pileTypography.map(({ labelText }) => labelText), `${variant.label} pile names should remain complete`).toEqual([
    'Deck',
    'Discard'
  ]);
  expect(snapshot.pileTypography[0]?.cardText, `${variant.label} deck face should remain visibly identified`).toBe('SKYJO');
  expect(snapshot.pileTypography[1]?.cardText, `${variant.label} discard value should remain visible`).toMatch(/^-?\d+$/);
  expect(
    snapshot.pileTypography.every(({ cardContained, labelContained }) => cardContained && labelContained),
    `${variant.label} visible pile typography should remain inside its button: ${JSON.stringify(snapshot.pileTypography)}`
  ).toBe(true);
  expect(snapshot.decisionButtons, `${variant.label} should render both drawn-card decisions`).toHaveLength(2);
  expect(
    snapshot.decisionHitTargets.every(Boolean),
    `${variant.label} both decision targets should remain fully hit-testable`
  ).toBe(true);
  expect(
    snapshot.tableCenterDrawnDecision,
    `${variant.label} center should expose drawn-decision state; columns=${snapshot.tableCenterColumns}`
  ).toBe('true');
  expect(
    snapshot.tableCenterDrawnClass,
    `${variant.label} center should apply the drawn-decision layout class; columns=${snapshot.tableCenterColumns}`
  ).toBe(true);
  expect(
    snapshot.decisionLabels.map(({ text }) => text),
    `${variant.label} should show unambiguous compact decision copy`
  ).toEqual(['Place', 'Discard']);
  expect(
    snapshot.decisionLabels.every(({ contained }) => contained),
    `${variant.label} compact decision copy should stay inside its hit target: ${JSON.stringify({
      columns: snapshot.tableCenterColumns,
      decisionButtons: snapshot.decisionButtons,
      decisionLabels: snapshot.decisionLabels,
      drawnClass: snapshot.tableCenterDrawnClass,
      drawnDecision: snapshot.tableCenterDrawnDecision
    })}`
  ).toBe(true);
  for (const [index, button] of snapshot.decisionButtons.entries()) {
    expect(button.width + 0.01, `${variant.label} decision ${index + 1} should be at least 44px wide`).toBeGreaterThanOrEqual(
      44
    );
    expect(
      button.height + 0.01,
      `${variant.label} decision ${index + 1} should be at least 44px high`
    ).toBeGreaterThanOrEqual(44);
    expect(rectIsInside(button, snapshot.band), `${variant.label} decision ${index + 1} should stay in the center band`).toBe(
      true
    );
    expect(rectIsInside(button, viewport), `${variant.label} decision ${index + 1} should stay in the viewport`).toBe(true);
    expect(
      rectsOverlap(snapshot.drawnCard, button),
      `${variant.label} drawn card should not overlap decision ${index + 1}`
    ).toBe(false);
  }
  expect(
    rectsOverlap(snapshot.decisionButtons[0], snapshot.decisionButtons[1]),
    `${variant.label} decision hit targets should not overlap`
  ).toBe(false);
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
  await startFreshSoloGame(page, skyjoServer.baseURL);

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
  await startFreshSoloGame(page, skyjoServer.baseURL);

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
  const placeDecision = page.getByRole('button', { name: 'Place drawn card', exact: true });
  await expect(placeDecision, 'drawing from a focused deck should move focus into the decision controls').toBeFocused();
  await expect(page.getByTestId('turn-announcer')).toContainText(/You drew (?:minus )?\d+\. Place mode selected\./);

  const replacement = page.getByRole('button', { name: /Replace with the drawn card/ }).filter({ visible: true }).first();
  await replacement.focus();
  await expect(replacement).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /Replace with the drawn card/ }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();

  await expect(deck).toBeEnabled({ timeout: 15_000 });
  await expect(table).toHaveAttribute('data-phase', 'choose-source');
  await expect(page.getByTestId('turn-announcer')).toContainText('Your turn. Choose the discard pile or draw blind from the deck.');
});

test('phone piles stay centered and fixed through solo source, draw, and AI phases', async ({
  browser,
  skyjoServer
}, testInfo) => {
  test.skip(
    !['chromium', 'webkit-phone'].includes(testInfo.project.name),
    'The custom iPhone context runs once per browser engine.'
  );
  test.setTimeout(60_000);
  const variant = { label: 'iPhone 16 Pro Max', width: 440, height: 956 };
  const { context, page } = await openSoloPhone(
    browser,
    skyjoServer.baseURL,
    skyjoServer.accessPassword,
    variant,
    205
  );

  try {
    const table = page.getByTestId('shared-game-table');
    const openingCards = page
      .getByRole('button', { name: /face-down\. Reveal this opening card/ })
      .filter({ visible: true });
    for (let reveal = 0; reveal < 2; reveal += 1) await openingCards.first().click();
    await expect(table).not.toHaveAttribute('data-phase', 'opening-reveal', { timeout: 5_000 });

    const piles = page.getByTestId('table-piles');
    const deck = piles.getByRole('button', { name: /^Deck/ });
    await expect(deck).toBeEnabled({ timeout: 15_000 });
    const idle = await readSoloPileGeometry(page);
    expectSoloPileGeometry(idle, ['Deck', 'Discard']);

    await piles.getByRole('button', { name: /^Discard/ }).click();
    await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
    const selectedDiscard = await readSoloPileGeometry(page);
    expectSoloPileGeometry(selectedDiscard, ['Deck', 'Undo']);
    expectSoloPileGeometryStable(idle, selectedDiscard, 'discard selection');

    await piles.getByRole('button', { name: 'Put the discard card back.' }).click();
    await expect(table).toHaveAttribute('data-phase', 'choose-source');
    const canceledDiscard = await readSoloPileGeometry(page);
    expectSoloPileGeometry(canceledDiscard, ['Deck', 'Discard']);
    expectSoloPileGeometryStable(idle, canceledDiscard, 'discard cancellation');

    await deck.click();
    await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
    const drawnPlace = await readSoloPileGeometry(page);
    expectSoloPileGeometry(drawnPlace, ['Deck', 'Discard']);
    expectSoloPileGeometryStable(idle, drawnPlace, 'blind draw');

    const discardDecision = page.getByRole('button', { name: 'Discard + reveal drawn card', exact: true });
    await discardDecision.click();
    await expect(discardDecision).toHaveAttribute('aria-pressed', 'true');
    const drawnDiscard = await readSoloPileGeometry(page);
    expectSoloPileGeometry(drawnDiscard, ['Deck', 'Discard']);
    expectSoloPileGeometryStable(idle, drawnDiscard, 'drawn discard mode');

    await page
      .getByRole('button', { name: /Reveal after discarding the drawn card/ })
      .filter({ visible: true })
      .first()
      .click();
    const aiTurn = await readSoloPileGeometry(page);
    expectSoloPileGeometry(aiTurn, ['Deck', 'Discard']);
    expectSoloPileGeometryStable(idle, aiTurn, 'AI turn');

    await expect(deck).toBeEnabled({ timeout: 20_000 });
    await expect(table).toHaveAttribute('data-phase', 'choose-source');
    const returned = await readSoloPileGeometry(page);
    expectSoloPileGeometry(returned, ['Deck', 'Discard']);
    expectSoloPileGeometryStable(idle, returned, 'returned local turn');
  } finally {
    await context.close();
  }
});

test('solo drawn-card decisions stay visible and fixed across the supported phone floor', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(180_000);
  const fontSamples = new Map<string, SoloDrawnCardLayoutSnapshot>();

  for (const [index, variant] of soloDrawnCardViewports.entries()) {
    const { context, page } = await openSoloPhone(
      browser,
      skyjoServer.baseURL,
      skyjoServer.accessPassword,
      variant,
      144 + index
    );
    try {
      await forceSoloQuotaWarning(page);
      const table = page.getByTestId('shared-game-table');
      const openingCards = page
        .getByRole('button', { name: /face-down\. Reveal this opening card/ })
        .filter({ visible: true });
      for (let reveal = 0; reveal < 2; reveal += 1) {
        const nextCard = openingCards.first();
        await expect(nextCard, `${variant.label} opening card ${reveal + 1} should be actionable`).toBeEnabled();
        await nextCard.focus();
        await expect(nextCard).toBeFocused();
        await page.keyboard.press('Enter');
      }
      await expect(
        page.getByText(
          'This device is low on storage. You can keep playing, but this game may not restore after closing Skyjo.'
        )
      ).toBeVisible();
      await expect(table).not.toHaveAttribute('data-phase', 'opening-reveal', { timeout: 5_000 });

      const deck = page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
      await expect(deck, `${variant.label} deck should become actionable`).toBeEnabled({ timeout: 15_000 });
      await deck.focus();
      await expect(deck).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
      await stageSoloPwaUpdate(context, page, skyjoServer.baseURL);
      if (variant.safeAreaStress) await applyLandscapeSafeAreaFixedOffsets(page);

      const drawnCard = page.getByRole('img', { name: /^Drawn card -?\d+$/ });
      const placeDecision = page.getByRole('button', { name: 'Place drawn card', exact: true });
      const discardDecision = page.getByRole('button', { name: 'Discard + reveal drawn card', exact: true });
      await expect(drawnCard, `${variant.label} should visibly render the private drawn value`).toBeVisible();
      await expect(placeDecision).toBeVisible();
      await expect(discardDecision).toBeVisible();
      await expect(placeDecision, `${variant.label} keyboard draw should hand focus to Place`).toBeFocused();
      const placeSnapshot = await readSoloDrawnCardLayout(page);
      fontSamples.set(variant.label, placeSnapshot);
      expectSoloDrawnCardLayout(placeSnapshot, variant);

      if (variant.width === 320 && variant.textScale) {
        await expectKeyboardReachableRegionEnd(
          page,
          '.skyjo-game-status',
          '.skyjo-game-status p:last-child',
          `${variant.label} game status`
        );
        await expectKeyboardReachableRegionEnd(
          page,
          '.skyjo-phone-action-guidance',
          '.skyjo-phone-action-guidance .skyjo-disabled-note',
          `${variant.label} action guidance`
        );
      }

      await discardDecision.focus();
      await expect(discardDecision).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(discardDecision).toHaveAttribute('aria-pressed', 'true');
      await expect(discardDecision, `${variant.label} discard-and-reveal selection should retain focus`).toBeFocused();
      await expect(drawnCard, `${variant.label} should retain the value in discard-and-reveal mode`).toBeVisible();
      expectSoloDrawnCardLayout(await readSoloDrawnCardLayout(page), variant);
    } finally {
      await context.close();
    }
  }

  const normal = fontSamples.get('iPhone 16 Pro Max');
  const scaled = fontSamples.get('iPhone 16 Pro Max at 200% text');
  expect(normal, 'normal iPhone font sample should be recorded').toBeDefined();
  expect(scaled, '200% iPhone font sample should be recorded').toBeDefined();
  expectPhoneScaledTextOutcome(normal?.gameStatusFontSize ?? 0, scaled?.gameStatusFontSize ?? 0, 22, 'Game status');
  expectPhoneScaledTextOutcome(normal?.titleFontSize ?? 0, scaled?.titleFontSize ?? 0, 28, 'Single Player heading');
  expectPhoneScaledTextOutcome(
    normal?.guidanceInstructionFontSize ?? 0,
    scaled?.guidanceInstructionFontSize ?? 0,
    22,
    'Guidance instruction'
  );
  expectPhoneScaledTextOutcome(
    normal?.guidanceNoteFontSize ?? 0,
    scaled?.guidanceNoteFontSize ?? 0,
    22,
    'Guidance disabled note'
  );
  expectPhoneScaledTextOutcome(
    normal?.guidanceTitleFontSize ?? 0,
    scaled?.guidanceTitleFontSize ?? 0,
    25.5,
    'Guidance heading'
  );
  expectPhoneScaledTextOutcome(normal?.updateStrongFontSize ?? 0, scaled?.updateStrongFontSize ?? 0, 28, 'Update heading');
  expectPhoneScaledTextOutcome(
    normal?.updateProtectedFontSize ?? 0,
    scaled?.updateProtectedFontSize ?? 0,
    23,
    'Protected-game update copy'
  );
  expectPhoneScaledTextOutcome(
    normal?.decisionLabels[0]?.fontSize ?? 0,
    scaled?.decisionLabels[0]?.fontSize ?? 0,
    20,
    'Decision label'
  );
  expectPhoneScaledTextOutcome(normal?.drawnFontSize ?? 0, scaled?.drawnFontSize ?? 0, 32, 'Drawn value');
  expectPhoneScaledTextOutcome(
    normal?.pileTypography[0]?.labelFontSize ?? 0,
    scaled?.pileTypography[0]?.labelFontSize ?? 0,
    16,
    'Deck label'
  );
  expectPhoneScaledTextOutcome(
    normal?.pileTypography[1]?.labelFontSize ?? 0,
    scaled?.pileTypography[1]?.labelFontSize ?? 0,
    16,
    'Discard label'
  );
  expectPhoneScaledTextOutcome(
    normal?.pileTypography[0]?.cardFontSize ?? 0,
    scaled?.pileTypography[0]?.cardFontSize ?? 0,
    14,
    'Deck face label'
  );
  expectPhoneScaledTextOutcome(
    normal?.pileTypography[1]?.cardFontSize ?? 0,
    scaled?.pileTypography[1]?.cardFontSize ?? 0,
    32,
    'Discard value'
  );
});

test('deferred guidance survives same-page rotation and width changes without hiding the drawn decision', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(90_000);
  const portrait: SoloPhoneVariant = {
    label: 'iPhone 16 Pro Max portrait before rotation at 200% text',
    width: 440,
    height: 956,
    textScale: true
  };
  const landscape: SoloPhoneVariant = {
    label: 'iPhone 16 Pro Max landscape after rotation at 200% text',
    width: 956,
    height: 440,
    textScale: true
  };
  const portraitAfterRotation: SoloPhoneVariant = {
    ...portrait,
    label: 'iPhone 16 Pro Max portrait after rotation at 200% text'
  };
  const compactBoundary: SoloPhoneVariant = {
    label: '374px compact boundary after live resize at 200% text',
    width: 374,
    height: 812,
    textScale: true
  };
  const standardBoundary: SoloPhoneVariant = {
    label: '390px standard boundary after live resize at 200% text',
    width: 390,
    height: 844,
    textScale: true
  };
  const { context, page } = await openSoloPhone(
    browser,
    skyjoServer.baseURL,
    skyjoServer.accessPassword,
    portrait,
    152
  );

  try {
    await forceSoloQuotaWarning(page);
    const table = page.getByTestId('shared-game-table');
    const openingCards = page
      .getByRole('button', { name: /face-down\. Reveal this opening card/ })
      .filter({ visible: true });
    for (let reveal = 0; reveal < 2; reveal += 1) {
      const nextCard = openingCards.first();
      await expect(nextCard).toBeEnabled();
      await nextCard.focus();
      await page.keyboard.press('Enter');
    }
    await expect(
      page.getByText(
        'This device is low on storage. You can keep playing, but this game may not restore after closing Skyjo.'
      )
    ).toBeVisible();
    await expect(table).not.toHaveAttribute('data-phase', 'opening-reveal', { timeout: 5_000 });

    const deck = page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
    await expect(deck).toBeEnabled({ timeout: 15_000 });
    await deck.focus();
    await page.keyboard.press('Enter');
    await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
    await stageSoloPwaUpdate(context, page, skyjoServer.baseURL);

    const placeDecision = page.getByRole('button', { name: 'Place drawn card', exact: true });
    await expect(placeDecision).toBeFocused();

    for (const [index, variant] of [
      portrait,
      landscape,
      portraitAfterRotation,
      compactBoundary,
      standardBoundary
    ].entries()) {
      if (index > 0) await page.setViewportSize({ width: variant.width, height: variant.height });
      await expect
        .poll(() => page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })))
        .toEqual({ height: variant.height, width: variant.width });
      await expect
        .poll(() =>
          page.locator('.skyjo-phone-action-guidance').evaluate((element) =>
            Number.parseFloat(window.getComputedStyle(element).maxHeight)
          )
        )
        .toBe(expectedDeferredGuidanceMaxHeight(variant));
      await expect(placeDecision, `${variant.label} should preserve the pending keyboard decision`).toBeFocused();
      expectSoloDrawnCardLayout(await readSoloDrawnCardLayout(page), variant);
    }
  } finally {
    await context.close();
  }
});

test('deferred update and minimized round summary share the fixed phone edge without overlap', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(90_000);
  const variant = { label: 'compact phone scoring state', width: 320, height: 568 };
  const { context, page } = await openSoloPhone(
    browser,
    skyjoServer.baseURL,
    skyjoServer.accessPassword,
    variant,
    151
  );
  try {
    await stageSoloPhoneState(page, skyjoServer.baseURL, soloProgressGameStates().roundOver, 151);
    const summary = page.getByRole('dialog');
    const summaryTitle = page.getByRole('heading', { name: 'Round complete.' });
    await expect(summary).toBeVisible();
    await expect(summaryTitle).toBeFocused();

    await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
    await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);
    await stageSoloPwaUpdate(context, page, skyjoServer.baseURL);

    const minimize = summary.getByRole('button', { name: 'Minimize' });
    await minimize.focus();
    await expect(minimize).toBeFocused();
    await page.keyboard.press('Enter');

    const restore = page.getByTestId('round-summary-restore');
    const updateBanner = page.getByTestId('pwa-update-banner');
    await expect(restore).toBeVisible();
    await expect(restore).toBeFocused();
    await expect.poll(() => restore.evaluate((element) => element.style.bottom)).toBe('var(--u)');
    await expect(updateBanner).toContainText('Game protected');

    const geometry = await updateBanner.evaluate((banner) => {
      if (!banner.isConnected || !banner.matches('[data-testid="pwa-update-banner"]')) {
        throw new Error('Update banner detached before geometry capture.');
      }
      const required = (selector: string, root: ParentNode = document) => {
        const element = root.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element;
      };
      const restoreButton = required('[data-testid="round-summary-restore"]');
      const deferred = required('.skyjo-update-deferred', banner);
      const strong = required('strong', banner);
      const bannerContent = Array.from(banner.querySelectorAll<HTMLElement>('strong, .skyjo-update-deferred'))
        .filter((element) => getComputedStyle(element).display !== 'none');
      const restoreRect = restoreButton.getBoundingClientRect();
      const bannerRect = banner.getBoundingClientRect();
      const inViewport = (rect: DOMRect) =>
        rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      return {
        bannerContentFits: bannerContent.every((element) => {
          const rect = element.getBoundingClientRect();
          return element.scrollWidth <= element.clientWidth + 1 &&
            rect.left >= bannerRect.left - 1 && rect.right <= bannerRect.right + 1 &&
            rect.top >= bannerRect.top - 1 && rect.bottom <= bannerRect.bottom + 1;
        }),
        bannerInViewport: inViewport(bannerRect),
        documentFixed:
          document.documentElement.scrollTop === 0 &&
          document.documentElement.scrollLeft === 0 &&
          document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1 &&
          document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        noOverlap: restoreRect.bottom <= bannerRect.top + 1,
        protectedFontSize: Number.parseFloat(getComputedStyle(deferred).fontSize),
        restoreHeight: restoreRect.height,
        restoreInViewport: inViewport(restoreRect),
        restoreWidth: restoreRect.width,
        rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        strongFontSize: Number.parseFloat(getComputedStyle(strong).fontSize)
      };
    });
    expect(geometry).toMatchObject({
      bannerContentFits: true,
      bannerInViewport: true,
      documentFixed: true,
      noOverlap: true,
      restoreInViewport: true,
      rootFontSize: 32
    });
    expect(geometry.restoreHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.restoreHeight).toBeLessThanOrEqual(160);
    expect(geometry.restoreWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.strongFontSize).toBeGreaterThanOrEqual(28);
    expect(geometry.protectedFontSize).toBeGreaterThanOrEqual(23);

    await page.keyboard.press('Enter');
    await expect(summary).toBeVisible();
    await expect(summaryTitle).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(restore).toBeVisible();
    await expect(restore).toBeFocused();
  } finally {
    await context.close();
  }
});

test('solo progress survives refresh and a service-worker update without auto-discarding', async ({ page, skyjoServer }) => {
  await installSeededBrowserRuntime(page, 68);
  await startFreshSoloGame(page, skyjoServer.baseURL);
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
  await expect(page.getByTestId('solo-launcher')).toBeVisible();
  await page.getByRole('button', { name: 'Continue Solo' }).click();
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
    await startFreshSoloGame(page, skyjoServer.baseURL);
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
  await startFreshSoloGame(page, skyjoServer.baseURL);
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
  // This matrix performs 16 strict responsive-table settlements. Shared Linux
  // WebKit can cross 90 seconds without any individual 7.5-second gate failing.
  test.setTimeout(120_000);
  await installSeededBrowserRuntime(page, 70);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await startFreshSoloGame(page, skyjoServer.baseURL);

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
    // This exercises 20 serial viewport settlements. Linux WebKit can begin the
    // twentieth settlement just before 90 seconds under CI load, so retain each
    // strict 7.5-second gate while allowing the full matrix to finish.
    test.setTimeout(120_000);
    await installSeededBrowserRuntime(page, 72);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startFreshSoloGame(page, skyjoServer.baseURL);

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
