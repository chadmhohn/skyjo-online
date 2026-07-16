import { randomUUID } from 'node:crypto';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { GameState } from '../../../src/types';
import { soloProgressGameStates } from '../../helpers/soloGameState';

type Viewport = { width: number; height: number };

type SoloPhoneVariant = Viewport & {
  label: string;
  textScale?: boolean;
};

type SoloDrawnCardLayoutSnapshot = {
  backContentFits: boolean;
  backMetrics: { clientHeight: number; clientWidth: number; scrollHeight: number; scrollWidth: number };
  backPseudoContent: string;
  band: DOMRectSnapshot;
  decisionButtons: DOMRectSnapshot[];
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
  drawnOpacity: string;
  drawnParentDisplay: string;
  drawnTopmost: boolean;
  drawnVisibility: string;
  gameHeader: DOMRectSnapshot;
  gameStatus: DOMRectSnapshot;
  gameStatusClientHeight: number;
  gameStatusClientWidth: number;
  gameStatusFontSize: number;
  gameStatusOverflowReachable: boolean;
  gameStatusOverflowY: string;
  gameStatusRole: string;
  gameStatusScrollHeight: number;
  gameStatusScrollWidth: number;
  gameStatusText: string;
  guidance: DOMRectSnapshot;
  guidanceTitle: DOMRectSnapshot;
  guidanceTitleContentFits: boolean;
  guidanceTitleText: string;
  guidanceOverflowReachable: boolean;
  guidanceOverflowY: string;
  guidanceText: string;
  headerTargets: DOMRectSnapshot[];
  localBoard: DOMRectSnapshot;
  opponentRail: DOMRectSnapshot;
  sharedTable: DOMRectSnapshot;
  tableShell: DOMRectSnapshot;
  title: DOMRectSnapshot;
  titleContentFits: boolean;
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

const iphone16ProMax = devices['iPhone 16 Pro Max'];
const soloDrawnCardViewports: ReadonlyArray<SoloPhoneVariant> = [
  { label: 'iPhone 16 Pro Max', width: 440, height: 956 },
  { label: 'iPhone 16 Pro Max at 200% text', width: 440, height: 956, textScale: true },
  { label: 'iPhone 16 Pro Max landscape', width: 956, height: 440 },
  { label: 'iPhone 16 Pro Max landscape at 200% text', width: 956, height: 440, textScale: true },
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
  const opponentPicker = settings.getByRole('group', { name: 'Choose AI opponent count' });
  await opponentPicker.getByRole('button', { name: String(playerCount - 1), exact: true }).click();
  await page.waitForTimeout(250);
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseURL}/single-player`);
    await waitForSoloServiceWorkerControl(page);
    if (variant.textScale) {
      await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
      await expect(page.locator('html')).toHaveClass(/skyjo-test-text-scale-200/);
    }
    await expect(page.getByRole('heading', { name: 'Single Player' })).toBeVisible();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
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
  const resume = page.getByRole('dialog', { name: 'Continue your solo game?' });
  await expect(resume).toBeVisible();
  await resume.getByRole('button', { name: 'Continue Game' }).click();
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
    const scrolling = document.scrollingElement;
    if (!scrolling) throw new Error('Document scrolling element was unavailable.');
    const band = required('[data-testid="table-center-band"]');
    const drawnCard = required('.skyjo-drawn-card');
    const back = required('.skyjo-back-link');
    const gameHeader = required('.skyjo-game-header');
    const gameStatus = required('.skyjo-game-status');
    const gameStatusParagraph = required('.skyjo-game-status p');
    const guidance = required('.skyjo-phone-action-guidance');
    const guidanceTitle = required('.skyjo-phone-action-guidance .skyjo-action-guidance-title');
    const tableShell = required('.skyjo-game-table-shell');
    const title = required('.skyjo-game-title');
    const updateBanner = required('[data-testid="pwa-update-banner"]');
    const updateProtected = required('.skyjo-update-deferred');
    const updateStrong = required('[data-testid="pwa-update-banner"] strong');
    const updateContent = Array.from(updateBanner.querySelectorAll<HTMLElement>('strong, span')).filter(
      (element) => window.getComputedStyle(element).display !== 'none'
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

    const gameStatusInitialScrollTop = gameStatus.scrollTop;
    gameStatus.scrollTop = gameStatus.scrollHeight;
    const gameStatusOverflowReachable =
      Math.abs(gameStatus.scrollHeight - gameStatus.clientHeight - gameStatus.scrollTop) <= 1;
    gameStatus.scrollTop = gameStatusInitialScrollTop;
    const guidanceInitialScrollTop = guidance.scrollTop;
    guidance.scrollTop = guidance.scrollHeight;
    const guidanceOverflowReachable = Math.abs(guidance.scrollHeight - guidance.clientHeight - guidance.scrollTop) <= 1;
    guidance.scrollTop = guidanceInitialScrollTop;

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
      decisionButtons: Array.from(
        band.querySelectorAll<HTMLElement>('.skyjo-drawn-decision .skyjo-choice-button')
      ).map(rect),
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
      drawnOpacity: style.opacity,
      drawnParentDisplay: window.getComputedStyle(drawnCard.parentElement as HTMLElement).display,
      drawnTopmost: topmost === drawnCard || Boolean(topmost && drawnCard.contains(topmost)),
      drawnVisibility: style.visibility,
      gameHeader: rect(gameHeader),
      gameStatus: rect(gameStatus),
      gameStatusClientHeight: gameStatus.clientHeight,
      gameStatusClientWidth: gameStatus.clientWidth,
      gameStatusFontSize: Number.parseFloat(window.getComputedStyle(gameStatusParagraph).fontSize),
      gameStatusOverflowReachable,
      gameStatusOverflowY: window.getComputedStyle(gameStatus).overflowY,
      gameStatusRole: gameStatusParagraph.getAttribute('role') || '',
      gameStatusScrollHeight: gameStatus.scrollHeight,
      gameStatusScrollWidth: gameStatus.scrollWidth,
      gameStatusText: gameStatusParagraph.textContent?.trim() || '',
      guidance: rect(guidance),
      guidanceTitle: rect(guidanceTitle),
      guidanceTitleContentFits:
        guidanceTitle.scrollWidth <= guidanceTitle.clientWidth + 1 &&
        guidanceTitle.scrollHeight <= guidanceTitle.clientHeight + 1,
      guidanceTitleText: guidanceTitle.textContent?.trim() || '',
      guidanceOverflowReachable,
      guidanceOverflowY: window.getComputedStyle(guidance).overflowY,
      guidanceText: guidance.textContent?.trim().replace(/\s+/g, ' ') || '',
      headerTargets: Array.from(
        gameHeader.querySelectorAll<HTMLElement>('.skyjo-back-link, .skyjo-header-controls button')
      ).map(rect),
      localBoard: rect(required('[data-testid="local-board"]')),
      opponentRail: rect(required('[data-testid="opponent-rail"]')),
      sharedTable: rect(required('[data-testid="shared-game-table"]')),
      tableShell: rect(tableShell),
      title: rect(title),
      titleContentFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1,
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

function expectPhoneScaledTextOutcome(normal: number, scaled: number, scaledMinimum: number, label: string): void {
  expect(scaled, `${label} should meet its readable 200% effective size`).toBeGreaterThanOrEqual(scaledMinimum);
  expect(scaled + 0.01, `${label} should not shrink at 200% text`).toBeGreaterThanOrEqual(normal);
  expect(
    scaled / normal >= 1.9 || normal >= scaledMinimum - 0.01,
    `${label} should either grow with the doubled root or already be browser-inflated to the target: ${JSON.stringify({ normal, scaled })}`
  ).toBe(true);
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
  expect(snapshot.titleContentFits, `${variant.label} visible title should stay inside its header allocation`).toBe(true);
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
  expect(snapshot.gameStatusOverflowReachable, `${variant.label} bounded status overflow should remain reachable`).toBe(true);
  expect(snapshot.guidanceText, `${variant.label} action guidance should remain available to VoiceOver`).toContain(
    'Drawn card waiting'
  );
  if (variant.width <= 360) {
    expect(snapshot.guidanceOverflowY, `${variant.label} guidance should use bounded internal overflow`).toBe('auto');
    expect(snapshot.guidanceOverflowReachable, `${variant.label} action guidance should remain scroll-reachable`).toBe(true);
  }
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
  expect(snapshot.drawnTopmost, `${variant.label} drawn card should not be visually occluded`).toBe(true);
  expect(rectIsInside(snapshot.band, viewport), `${variant.label} center band should remain in the viewport`).toBe(true);
  expect(rectIsInside(snapshot.drawnCard, snapshot.band), `${variant.label} drawn card should stay in the center band`).toBe(
    true
  );
  expect(rectIsInside(snapshot.drawnCard, viewport), `${variant.label} drawn card should remain in the viewport`).toBe(true);
  expect(
    snapshot.opponentRail.bottom <= snapshot.band.top + 1,
    `${variant.label} opponent rail should not overlap the center band`
  ).toBe(true);
  expect(
    snapshot.band.bottom <= snapshot.localBoard.top + 1,
    `${variant.label} center band should not overlap the local board`
  ).toBe(true);
  expect(snapshot.decisionButtons, `${variant.label} should render both drawn-card decisions`).toHaveLength(2);
  expect(
    snapshot.decisionLabels.map(({ text }) => text),
    `${variant.label} should show unambiguous compact decision copy`
  ).toEqual(['Place', 'Discard']);
  expect(
    snapshot.decisionLabels.every(({ contained }) => contained),
    `${variant.label} compact decision copy should stay inside its hit target`
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
});

test('deferred update and minimized round summary share the fixed phone edge without overlap', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(90_000);
  const variant = { label: 'iPhone 16 Pro Max scoring state', width: 440, height: 956 };
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
    await expect(updateBanner).toContainText('Game protected');

    const geometry = await page.evaluate(() => {
      const required = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element;
      };
      const restoreButton = required('[data-testid="round-summary-restore"]');
      const banner = required('[data-testid="pwa-update-banner"]');
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
        protectedFontSize: Number.parseFloat(getComputedStyle(required('.skyjo-update-deferred')).fontSize),
        restoreHeight: restoreRect.height,
        restoreInViewport: inViewport(restoreRect),
        restoreWidth: restoreRect.width,
        rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        strongFontSize: Number.parseFloat(getComputedStyle(required('.skyjo-update-banner strong')).fontSize)
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
