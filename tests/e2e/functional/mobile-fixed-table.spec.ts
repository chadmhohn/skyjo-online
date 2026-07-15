import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { devices, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

type PortraitVariant = {
  boardScroll?: boolean;
  height: number;
  label: string;
  stagePwaUpdate?: boolean;
  standalone?: boolean;
  textScale?: boolean;
  width: number;
};

const iphonePortraits: ReadonlyArray<PortraitVariant> = [
  { label: 'Safari compact', width: 440, height: 763, stagePwaUpdate: true },
  { label: 'standalone PWA', width: 440, height: 956, standalone: true },
  { label: 'reported display zoom', width: 430, height: 932 },
  { label: 'small phone', width: 320, height: 568, boardScroll: true },
  { label: 'iPhone Pro Max at 200% text', width: 440, height: 763, textScale: true },
  { label: 'iPhone Pro Max landscape', width: 956, height: 440, boardScroll: true }
] as const;
const iphone16ProMax = devices['iPhone 16 Pro Max'];
const pixelTolerance = 1;
const minimumTargetSize = 44;
const targetRoundingTolerance = 0.01;

async function expectNoBlockingAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((violation) =>
    violation.impact === 'serious' || violation.impact === 'critical'
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

type MultiplayerClient = {
  context: BrowserContext;
  page: Page;
};

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type LayoutItem = {
  label: string;
  rect: Rect;
};

type ActiveLayoutSnapshot = {
  band: Rect;
  controls: Rect;
  centerControls: LayoutItem[];
  centerContentFits: boolean;
  centerVisuals: LayoutItem[];
  document: {
    clientHeight: number;
    clientWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
    scrollWidth: number;
  };
  drawnCard: Rect;
  localCardCount: number;
  localCardsContained: boolean;
  localBoard: Rect;
  opponentCardCount: number;
  opponentCardsContained: boolean;
  opponentRail: Rect;
  table: Rect;
  toolbar: Rect;
  toolbarContentFits: boolean;
  toolbarItems: LayoutItem[];
  viewport: { height: number; width: number };
};

async function setWorkerVariant(
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

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return registration.scope;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Service worker did not claim the page.')), 10_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    return registration.scope;
  });
}

async function expectWaitingWorker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration?.waiting?.state ?? null;
  }), { timeout: 15_000, intervals: [100, 250, 500, 1_000] }).toBe('installed');
}

function safeSuffix(value: string): string {
  return value.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

async function openMultiplayerClients(
  browser: Browser,
  baseURL: string,
  accessPassword: string,
  suffix: string,
  portrait: PortraitVariant,
  playerCount = 2
): Promise<MultiplayerClient[]> {
  const clients: MultiplayerClient[] = [];
  try {
    for (let index = 0; index < playerCount; index += 1) {
      const context = await browser.newContext({
        deviceScaleFactor: iphone16ProMax.deviceScaleFactor,
        hasTouch: iphone16ProMax.hasTouch,
        isMobile: iphone16ProMax.isMobile,
        screen: portrait,
        serviceWorkers: 'allow',
        userAgent: iphone16ProMax.userAgent,
        viewport: portrait
      });
      if (portrait.standalone) {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
        });
      }
      const access = await context.request.post(`${baseURL}/login`, {
        form: { next: '/', password: accessPassword }
      });
      expect(access.ok()).toBe(true);
      const signup = await context.request.post(`${baseURL}/api/account/signup`, {
        data: {
          confirmPassword: 'mobile-fixed-table-password',
          displayName: `Mobile Seat ${index + 1}`,
          email: `mobile-fixed-${index + 1}-${suffix}@example.test`,
          password: 'mobile-fixed-table-password'
        }
      });
      expect(signup.status()).toBe(201);
      if (portrait.stagePwaUpdate && index < 2) await setWorkerVariant(context, baseURL, 'A', randomUUID());
      const page = await context.newPage();
      await installSeededBrowserRuntime(page, 138 + index);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${baseURL}/lobby`);
      if (portrait.stagePwaUpdate) await waitForServiceWorkerControl(page);
      if (portrait.textScale) {
        await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
        await expect(page.locator('html')).toHaveClass(/skyjo-test-text-scale-200/);
      }
      await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
      clients.push({ context, page });
    }
    return clients;
  } catch (error) {
    await Promise.allSettled(clients.map(({ context }) => context.close()));
    throw error;
  }
}

async function clickNextOpeningCard(clients: MultiplayerClient[]): Promise<void> {
  let activePage: Page | undefined;
  await expect.poll(async () => {
    for (const client of clients) {
      const card = client.page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])').first();
      if (await card.count()) {
        activePage = client.page;
        return true;
      }
    }
    return false;
  }).toBe(true);
  if (!activePage) throw new Error('No multiplayer opening card was actionable.');
  const actionable = activePage.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])');
  const beforeCount = await actionable.count();
  await actionable.first().click();
  await expect.poll(() => actionable.count()).toBeLessThan(beforeCount);
}

async function activeTurnClient(clients: MultiplayerClient[]): Promise<MultiplayerClient> {
  let active: MultiplayerClient | undefined;
  await expect.poll(async () => {
    for (const client of clients) {
      const deck = client.page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
      if (await deck.isEnabled().catch(() => false)) {
        active = client;
        return true;
      }
    }
    return false;
  }).toBe(true);
  if (!active) throw new Error('No multiplayer client had the active turn.');
  return active;
}

async function expectMinimumTarget(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have measurable geometry`).not.toBeNull();
  expect((box?.width ?? 0) + targetRoundingTolerance, `${label} should be at least 44px wide`).toBeGreaterThanOrEqual(
    minimumTargetSize
  );
  expect((box?.height ?? 0) + targetRoundingTolerance, `${label} should be at least 44px high`).toBeGreaterThanOrEqual(
    minimumTargetSize
  );
}

async function readActiveLayout(page: Page): Promise<ActiveLayoutSnapshot> {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing active mobile layout anchor: ${selector}`);
      return element;
    };
    const rect = (element: Element): Rect => {
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
    const localBoard = required('[data-testid="local-board"]');
    const opponentRail = required('[data-testid="opponent-rail"]');
    const band = required('[data-testid="table-center-band"]');
    const toolbar = required('[data-testid="active-room-toolbar"]');
    const visibleItems = (root: HTMLElement, selector: string) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector))
        .filter((element) => {
          const value = element.getBoundingClientRect();
          return value.width > 0 && value.height > 0 && window.getComputedStyle(element).visibility !== 'hidden';
        })
        .map((element, index) => ({
          label: element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || `item ${index + 1}`,
          rect: rect(element)
        }));
    const viewportContains = (value: DOMRect) =>
      value.left >= -1 && value.top >= -1 && value.right <= window.innerWidth + 1 && value.bottom <= window.innerHeight + 1;
    const regionContainsCards = (region: HTMLElement) => {
      const regionRect = region.getBoundingClientRect();
      return Array.from(region.querySelectorAll<HTMLElement>('.skyjo-player-card-cell')).every((card) => {
        const cardRect = card.getBoundingClientRect();
        return (
          cardRect.left >= regionRect.left - 1 &&
          cardRect.right <= regionRect.right + 1 &&
          cardRect.top >= regionRect.top - 1 &&
          cardRect.bottom <= regionRect.bottom + 1 &&
          viewportContains(cardRect)
        );
      });
    };
    return {
      band: rect(band),
      centerControls: visibleItems(band, '.skyjo-chat-dock-button, .skyjo-pile-button, .skyjo-choice-button'),
      // The 44px pile labels intentionally ellipsize; parent geometry and the full accessible controls are asserted below.
      centerContentFits: Array.from(
        band.querySelectorAll<HTMLElement>(
          '.skyjo-chat-dock-button, .skyjo-table-card, .skyjo-drawn-card, .skyjo-choice-button'
        )
      ).every((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1),
      centerVisuals: visibleItems(band, '.skyjo-chat-dock-button, .skyjo-table-card, .skyjo-drawn-card, .skyjo-choice-button'),
      controls: rect(required('[data-testid="table-center"]')),
      document: {
        clientHeight: scrolling.clientHeight,
        clientWidth: scrolling.clientWidth,
        scrollHeight: scrolling.scrollHeight,
        scrollLeft: scrolling.scrollLeft,
        scrollTop: scrolling.scrollTop,
        scrollWidth: scrolling.scrollWidth
      },
      drawnCard: rect(required('.skyjo-drawn-card')),
      localBoard: rect(localBoard),
      localCardCount: localBoard.querySelectorAll('.skyjo-player-card-cell').length,
      localCardsContained: regionContainsCards(localBoard),
      opponentCardCount: opponentRail.querySelectorAll('.skyjo-player-card-cell').length,
      opponentCardsContained: regionContainsCards(opponentRail),
      opponentRail: rect(opponentRail),
      table: rect(required('[data-testid="shared-game-table"]')),
      toolbar: rect(toolbar),
      toolbarContentFits: Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > .skyjo-back-link, :scope > .skyjo-active-room-identity, :scope > button')
      ).every((element) =>
        element.scrollHeight <= element.clientHeight + 1 &&
        (element.matches('.skyjo-active-room-identity') || element.scrollWidth <= element.clientWidth + 1)
      ),
      toolbarItems: visibleItems(
        toolbar,
        ':scope > .skyjo-back-link, :scope > .skyjo-active-room-identity, :scope > button'
      ),
      viewport: { height: window.innerHeight, width: window.innerWidth }
    };
  });
}

function isInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.left >= outer.left - pixelTolerance &&
    inner.right <= outer.right + pixelTolerance &&
    inner.top >= outer.top - pixelTolerance &&
    inner.bottom <= outer.bottom + pixelTolerance
  );
}

function doNotOverlap(items: LayoutItem[]): boolean {
  return items.every((item, index) =>
    items.slice(index + 1).every((other) =>
      item.rect.right <= other.rect.left + pixelTolerance ||
      other.rect.right <= item.rect.left + pixelTolerance ||
      item.rect.bottom <= other.rect.top + pixelTolerance ||
      other.rect.bottom <= item.rect.top + pixelTolerance
    )
  );
}

function expectInsideViewport(rect: Rect, snapshot: ActiveLayoutSnapshot, label: string): void {
  expect(rect.left, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(-pixelTolerance);
  expect(rect.top, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(-pixelTolerance);
  expect(rect.right, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    snapshot.viewport.width + pixelTolerance
  );
  expect(rect.bottom, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    snapshot.viewport.height + pixelTolerance
  );
}

function expectFixedActiveLayout(
  snapshot: ActiveLayoutSnapshot,
  portrait: PortraitVariant,
  expectedOpponentCardCount = 12
): void {
  expect(snapshot.viewport).toEqual({ width: portrait.width, height: portrait.height });
  expect(snapshot.document.scrollTop).toBe(0);
  expect(snapshot.document.scrollLeft).toBe(0);
  expect(snapshot.document.scrollHeight).toBeLessThanOrEqual(snapshot.document.clientHeight + pixelTolerance);
  expect(snapshot.document.scrollWidth).toBeLessThanOrEqual(snapshot.document.clientWidth + pixelTolerance);
  expect(snapshot.toolbar.height).toBeLessThanOrEqual(52 + pixelTolerance);
  expect(snapshot.toolbarContentFits, 'toolbar children should not clip at the active text scale').toBe(true);
  expect(doNotOverlap(snapshot.toolbarItems), 'toolbar children should not overlap').toBe(true);
  for (const item of snapshot.toolbarItems) {
    expect(isInside(item.rect, snapshot.toolbar), `${item.label} should stay inside the toolbar`).toBe(true);
  }
  expect(
    snapshot.toolbar.bottom <= snapshot.table.top + pixelTolerance,
    'compact room toolbar should not overlap the shared game table'
  ).toBe(true);

  for (const [label, rect] of [
    ['compact room toolbar', snapshot.toolbar],
    ['shared game table', snapshot.table],
    ['opponent rail', snapshot.opponentRail],
    ['center band', snapshot.band],
    ['center controls', snapshot.controls],
    ['drawn card', snapshot.drawnCard],
    ['local board', snapshot.localBoard]
  ] as const) {
    expectInsideViewport(rect, snapshot, label);
  }

  expect(snapshot.drawnCard.width).toBeGreaterThan(0);
  expect(snapshot.drawnCard.height).toBeGreaterThan(0);
  expect(snapshot.centerContentFits, 'center-band cards and action controls should not clip').toBe(true);
  expect(doNotOverlap(snapshot.centerControls), 'center-band controls should not overlap').toBe(true);
  expect(doNotOverlap(snapshot.centerVisuals), 'center-band cards and actions should not overlap').toBe(true);
  for (const item of [...snapshot.centerControls, ...snapshot.centerVisuals]) {
    expect(isInside(item.rect, snapshot.band), `${item.label} should stay inside the center band`).toBe(true);
  }
  expect(snapshot.localCardCount).toBe(12);
  expect(snapshot.opponentCardCount).toBe(expectedOpponentCardCount);
  if (!portrait.textScale && !portrait.boardScroll) {
    expect(snapshot.localCardsContained, 'all twelve local cards should remain visible inside the local board').toBe(true);
    if (expectedOpponentCardCount === 12) {
      expect(snapshot.opponentCardsContained, 'all twelve opponent cards should remain visible inside the opponent rail').toBe(true);
    }
  }
  expect(isInside(snapshot.drawnCard, snapshot.band), 'drawn card should be fully inside the center band').toBe(true);
  expect(isInside(snapshot.controls, snapshot.band), 'center controls should be fully inside the center band').toBe(true);
  expect(
    snapshot.opponentRail.bottom <= snapshot.band.top + pixelTolerance,
    'opponent rail should not overlap the center band'
  ).toBe(true);
  expect(
    snapshot.band.bottom <= snapshot.localBoard.top + pixelTolerance,
    'center band should not overlap the local board'
  ).toBe(true);
}

function fixedActiveLayoutCriteria(
  snapshot: ActiveLayoutSnapshot,
  portrait: PortraitVariant
) {
  const viewportRect: Rect = {
    bottom: snapshot.viewport.height,
    height: snapshot.viewport.height,
    left: 0,
    right: snapshot.viewport.width,
    top: 0,
    width: snapshot.viewport.width
  };
  return {
    boardsDoNotOverlapBand:
      snapshot.opponentRail.bottom <= snapshot.band.top + pixelTolerance &&
      snapshot.band.bottom <= snapshot.localBoard.top + pixelTolerance,
    controlsInsideBand: isInside(snapshot.controls, snapshot.band),
    centerChildrenContained:
      snapshot.centerContentFits &&
      snapshot.centerControls.every((item) => isInside(item.rect, snapshot.band)) &&
      snapshot.centerVisuals.every((item) => isInside(item.rect, snapshot.band)),
    centerChildrenDoNotOverlap:
      doNotOverlap(snapshot.centerControls) && doNotOverlap(snapshot.centerVisuals),
    documentFits:
      snapshot.document.scrollTop === 0 &&
      snapshot.document.scrollLeft === 0 &&
      snapshot.document.scrollHeight <= snapshot.document.clientHeight + pixelTolerance &&
      snapshot.document.scrollWidth <= snapshot.document.clientWidth + pixelTolerance,
    drawnCardInsideBand:
      snapshot.drawnCard.width > 0 && snapshot.drawnCard.height > 0 && isInside(snapshot.drawnCard, snapshot.band),
    fullBoardsContained:
      snapshot.localCardCount === 12 &&
      (portrait.textScale || portrait.boardScroll || snapshot.localCardsContained) &&
      snapshot.opponentCardCount >= 12 &&
      (snapshot.opponentCardCount > 12 || portrait.textScale || portrait.boardScroll || snapshot.opponentCardsContained),
    keyRegionsInsideViewport: [
      snapshot.toolbar,
      snapshot.table,
      snapshot.opponentRail,
      snapshot.band,
      snapshot.controls,
      snapshot.drawnCard,
      snapshot.localBoard
    ].every((rect) => isInside(rect, viewportRect)),
    toolbarDoesNotOverlapTable: snapshot.toolbar.bottom <= snapshot.table.top + pixelTolerance,
    toolbarCompact: snapshot.toolbar.height <= 52 + pixelTolerance,
    toolbarChildrenContained:
      snapshot.toolbarContentFits && snapshot.toolbarItems.every((item) => isInside(item.rect, snapshot.toolbar)),
    toolbarChildrenDoNotOverlap: doNotOverlap(snapshot.toolbarItems),
    viewportSettled:
      snapshot.viewport.width === portrait.width && snapshot.viewport.height === portrait.height
  };
}

async function expectBoardsReachableByInternalScroll(page: Page, includeOpponent = true): Promise<void> {
  const selectors = includeOpponent
    ? ['[data-testid="opponent-rail"]', '[data-testid="local-board"]']
    : ['[data-testid="local-board"]'];
  for (const selector of selectors) {
    const board = page.locator(selector);
    await expect(board).toHaveAttribute('role', 'region');
    await expect(board).toHaveAttribute('tabindex', '0');
    await board.evaluate((element) => {
      element.scrollTop = 0;
    });
    await board.focus();
    for (let step = 0; step < 12; step += 1) await board.press('ArrowDown');
    await expect.poll(() => board.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const reachability = await board.evaluate((element) => {
      const board = element as HTMLElement;
      const cards = [...board.querySelectorAll<HTMLElement>('.skyjo-player-card-cell')];
      const playerGrid = board.querySelector<HTMLElement>('.skyjo-player-grid');
      const boardRect = board.getBoundingClientRect();
      const lastCardRect = cards[cards.length - 1]?.getBoundingClientRect();
      const boardStyle = window.getComputedStyle(board);
      const playerGridStyle = playerGrid ? window.getComputedStyle(playerGrid) : null;
      return {
        rootClassName: document.documentElement.className,
        scrollContainerSelectorMatches: board.matches(
          '.skyjo-active-phone-shell .skyjo-player-board-grid'
        ),
        cardCount: cards.length,
        lastCardReachable: Boolean(
          lastCardRect && lastCardRect.top >= boardRect.top - 1 && lastCardRect.bottom <= boardRect.bottom + 1
        ),
        overflow: boardStyle.overflow,
        overflowY: boardStyle.overflowY,
        scrollable: board.scrollHeight > board.clientHeight + 1,
        scrollTop: board.scrollTop,
        clientHeight: board.clientHeight,
        scrollHeight: board.scrollHeight,
        playerGridHeight: playerGridStyle?.height,
        playerGridOverflow: playerGridStyle?.overflow,
        playerGridScrollHeight: playerGrid?.scrollHeight
      };
    });
    expect(reachability, JSON.stringify(reachability)).toMatchObject({
      cardCount: 12,
      lastCardReachable: true,
      overflowY: 'auto',
      scrollable: true
    });
    expect(reachability.scrollTop).toBeGreaterThan(0);
    await board.evaluate((element) => {
      element.scrollTop = 0;
    });
  }
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? -1)).toBe(0);
}

async function expectOpponentRailReachableByHorizontalScroll(page: Page): Promise<void> {
  const rail = page.getByTestId('opponent-rail');
  await rail.focus();
  await rail.press('End');
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const reachability = await rail.evaluate((element) => {
    const rail = element as HTMLElement;
    const opponents = [...rail.querySelectorAll<HTMLElement>('[data-player-id]')];
    const railRect = rail.getBoundingClientRect();
    const lastRect = opponents[opponents.length - 1]?.getBoundingClientRect();
    return {
      lastOpponentReachable: Boolean(
        lastRect && lastRect.left >= railRect.left - 1 && lastRect.right <= railRect.right + 1
      ),
      opponentCount: opponents.length,
      overflowX: window.getComputedStyle(rail).overflowX,
      scrollLeft: rail.scrollLeft,
      scrollWidth: rail.scrollWidth,
      clientWidth: rail.clientWidth
    };
  });
  expect(reachability, JSON.stringify(reachability)).toMatchObject({
    lastOpponentReachable: true,
    opponentCount: 7,
    overflowX: 'auto'
  });
  expect(reachability.scrollWidth).toBeGreaterThan(reachability.clientWidth);
  expect(reachability.scrollLeft).toBeGreaterThan(0);
  await rail.evaluate((element) => {
    element.scrollLeft = 0;
  });
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? -1)).toBe(0);
}

function expectRectStable(before: Rect, after: Rect, label: string): void {
  for (const key of ['bottom', 'height', 'left', 'right', 'top', 'width'] as const) {
    expect(Math.abs(after[key] - before[key]), `${label} ${key} should remain stable`).toBeLessThanOrEqual(
      pixelTolerance
    );
  }
}

async function expectRoomOptionsInternalScroll(
  page: Page,
  roomOptionsDialog: Locator,
  optionsBody: Locator
): Promise<void> {
  const header = roomOptionsDialog.locator('.skyjo-room-options-header');
  const headerBeforeScroll = await header.boundingBox();
  const optionsScrollState = await optionsBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop
  }));
  expect(optionsScrollState.scrollHeight).toBeGreaterThan(optionsScrollState.clientHeight);
  expect(optionsScrollState.scrollTop).toBe(0);
  const lastRosterRow = roomOptionsDialog.locator('.skyjo-room-roster li').last();
  await lastRosterRow.scrollIntoViewIfNeeded();
  await expect.poll(() => optionsBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(lastRosterRow).toBeInViewport();
  const headerAfterScroll = await header.boundingBox();
  expect(headerBeforeScroll).not.toBeNull();
  expect(headerAfterScroll).not.toBeNull();
  expectRectStable(
    {
      bottom: (headerBeforeScroll?.y ?? 0) + (headerBeforeScroll?.height ?? 0),
      height: headerBeforeScroll?.height ?? 0,
      left: headerBeforeScroll?.x ?? 0,
      right: (headerBeforeScroll?.x ?? 0) + (headerBeforeScroll?.width ?? 0),
      top: headerBeforeScroll?.y ?? 0,
      width: headerBeforeScroll?.width ?? 0
    },
    {
      bottom: (headerAfterScroll?.y ?? 0) + (headerAfterScroll?.height ?? 0),
      height: headerAfterScroll?.height ?? 0,
      left: headerAfterScroll?.x ?? 0,
      right: (headerAfterScroll?.x ?? 0) + (headerAfterScroll?.width ?? 0),
      top: headerAfterScroll?.y ?? 0,
      width: headerAfterScroll?.width ?? 0
    },
    'room options header while body scrolls'
  );
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? -1)).toBe(0);
}

async function expectActiveDocumentLocked(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const root = document.getElementById('root');
    const scrolling = document.scrollingElement;
    return {
      bodyOverflow: window.getComputedStyle(document.body).overflow,
      bodyOverscroll: window.getComputedStyle(document.body).getPropertyValue('overscroll-behavior'),
      clientHeight: scrolling?.clientHeight ?? 0,
      clientWidth: scrolling?.clientWidth ?? 0,
      htmlOverflow: window.getComputedStyle(document.documentElement).overflow,
      rootOverflow: root ? window.getComputedStyle(root).overflow : '',
      scrollHeight: scrolling?.scrollHeight ?? 0,
      scrollLeft: scrolling?.scrollLeft ?? -1,
      scrollTop: scrolling?.scrollTop ?? -1,
      scrollWidth: scrolling?.scrollWidth ?? 0
    };
  });
  expect(state).toMatchObject({
    bodyOverflow: 'hidden',
    htmlOverflow: 'hidden',
    rootOverflow: 'hidden',
    scrollLeft: 0,
    scrollTop: 0
  });
  if (state.bodyOverscroll) expect(state.bodyOverscroll).toBe('none');
  expect(state.scrollHeight).toBeLessThanOrEqual(state.clientHeight + pixelTolerance);
  expect(state.scrollWidth).toBeLessThanOrEqual(state.clientWidth + pixelTolerance);
}

for (const portrait of iphonePortraits) test(`issue #138 keeps the ${portrait.label} ${portrait.width}x${portrait.height} table fixed`, async ({
  browser,
  skyjoServer
}, testInfo) => {
  test.skip(
    !['chromium', 'webkit-phone'].includes(testInfo.project.name),
    'Custom iPhone contexts run once per browser engine.'
  );
  test.setTimeout(90_000);
  const suffix = safeSuffix(`${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`);
  const playerCount = 2;
  const clients: MultiplayerClient[] = [];
  try {
    clients.push(
      ...(await openMultiplayerClients(
        browser,
        skyjoServer.baseURL,
        skyjoServer.accessPassword,
        suffix,
        portrait,
        playerCount
      ))
    );

    await clients[0].page.getByRole('button', { name: 'Create Room' }).click();
    await expect(clients[0].page.getByTestId('connection-status')).toHaveAttribute(
      'data-connection-state',
      'connected'
    );
    const roomCode = await clients[0].page.locator('.skyjo-room-code').innerText();
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].page.getByLabel('Room code').fill(roomCode);
      await clients[index].page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(clients[index].page.locator('.skyjo-room-code')).toHaveText(roomCode);
    }
    await expect(clients[0].page.locator('.skyjo-room-roster li')).toHaveCount(playerCount);

    await clients[0].page.getByRole('button', { name: 'Start Game' }).click();
    await Promise.all(
      clients.map(({ page }) =>
        expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount))
      )
    );
    await Promise.all(clients.map(({ page }) => expectActiveDocumentLocked(page)));
    if (portrait.standalone) {
      await expect.poll(() => clients[0].page.evaluate(() => Boolean(
        (navigator as Navigator & { standalone?: boolean }).standalone
      ))).toBe(true);
    }
    for (let index = 0; index < playerCount * 2; index += 1) await clickNextOpeningCard(clients);
    await Promise.all(
      clients.map(({ page }) =>
        expect(page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'opening-reveal')
      )
    );

    const active = await activeTurnClient(clients);
    const deckButton = active.page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
    await deckButton.focus();
    await expect(deckButton).toBeFocused();
    await deckButton.press('Enter');
    await expect(active.page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', 'choose-replacement');
    const drawnCard = active.page.locator('.skyjo-drawn-card');
    await expect(drawnCard).toBeVisible();
    await expect(active.page.getByRole('button', { name: 'Place drawn card' })).toBeFocused();
    const drawnValue = (await drawnCard.innerText()).trim();
    const announcedDrawnValue = drawnValue.startsWith('-') ? `minus ${drawnValue.slice(1)}` : drawnValue;
    await expect(active.page.getByTestId('turn-announcer')).toContainText(`You drew ${announcedDrawnValue}.`);
    const drawnCardPresentation = await drawnCard.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const style = window.getComputedStyle(element);
      return {
        centerVisible: center === element || element.contains(center),
        opacity: Number(style.opacity),
        visibility: style.visibility
      };
    });
    expect(drawnCardPresentation).toEqual({ centerVisible: true, opacity: 1, visibility: 'visible' });
    await expect.poll(async () => fixedActiveLayoutCriteria(await readActiveLayout(active.page), portrait)).toEqual({
      boardsDoNotOverlapBand: true,
      centerChildrenContained: true,
      centerChildrenDoNotOverlap: true,
      controlsInsideBand: true,
      documentFits: true,
      drawnCardInsideBand: true,
      fullBoardsContained: true,
      keyRegionsInsideViewport: true,
      toolbarDoesNotOverlapTable: true,
      toolbarCompact: true,
      toolbarChildrenContained: true,
      toolbarChildrenDoNotOverlap: true,
      viewportSettled: true
    });
    const beforeChat = await readActiveLayout(active.page);
    expectFixedActiveLayout(beforeChat, portrait, (playerCount - 1) * 12);
    if (portrait.textScale || portrait.boardScroll) {
      await expectBoardsReachableByInternalScroll(active.page, playerCount === 2);
    }
    if (playerCount > 2) await expectOpponentRailReachableByHorizontalScroll(active.page);
    const deferredUpdateBanner = active.page.getByTestId('pwa-update-banner');
    if (portrait.stagePwaUpdate) {
      await setWorkerVariant(active.context, skyjoServer.baseURL, 'B', randomUUID());
      await active.page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
      });
      await expectWaitingWorker(active.page);
      await expect(deferredUpdateBanner).toHaveCount(1);
      await expect(deferredUpdateBanner).toBeHidden();
      await expect(active.page.getByTestId('active-room-toolbar')).toContainText('Update ready');
      await expect(active.page.getByRole('status').filter({ hasText: 'Skyjo update ready' })).toBeAttached();
    }
    await testInfo.attach(`issue-138-${portrait.width}x${portrait.height}-drawn-card`, {
      body: await active.page.screenshot({ fullPage: false }),
      contentType: 'image/png'
    });

    const toolbar = active.page.getByTestId('active-room-toolbar');
    await expectMinimumTarget(toolbar.getByRole('link', { name: /Back/i }), 'Back control');
    await expectMinimumTarget(toolbar.getByRole('button', { name: /^Share room / }), 'Share control');
    await expectMinimumTarget(toolbar.getByRole('button', { name: 'Open room options' }), 'room options control');
    await expectMinimumTarget(toolbar.getByRole('button', { name: 'Open game settings' }), 'settings control');

    const center = active.page.getByTestId('table-center-band');
    const chatTrigger = center.getByRole('button', { name: /^Open table chat/i });
    await expect(chatTrigger).toHaveClass(/skyjo-chat-dock-button/);
    await expectMinimumTarget(chatTrigger, 'table chat trigger');
    const chatTriggerBox = await chatTrigger.boundingBox();
    expect(chatTriggerBox).not.toBeNull();
    expect(
      isInside(
        {
          bottom: (chatTriggerBox?.y ?? 0) + (chatTriggerBox?.height ?? 0),
          height: chatTriggerBox?.height ?? 0,
          left: chatTriggerBox?.x ?? 0,
          right: (chatTriggerBox?.x ?? 0) + (chatTriggerBox?.width ?? 0),
          top: chatTriggerBox?.y ?? 0,
          width: chatTriggerBox?.width ?? 0
        },
        beforeChat.band
      ),
      'chat trigger should remain inside the center band'
    ).toBe(true);
    const centerTargets = await center.locator('button:visible').all();
    expect(centerTargets.length, 'center band should expose deck, discard, two choices, and chat').toBeGreaterThanOrEqual(5);
    for (const [index, control] of centerTargets.entries()) {
      await expectMinimumTarget(control, `center-band control ${index + 1}`);
    }
    if (portrait.label === 'Safari compact') await expectNoBlockingAxeViolations(active.page);

    await chatTrigger.click();
    const dialog = active.page.getByRole('dialog', { name: /Table chat/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const overlay = active.page.locator('.skyjo-chat-overlay');
    await expect(overlay).toBeVisible();
    expect(await overlay.evaluate((element) => window.getComputedStyle(element).position)).toBe('fixed');
    await expect(dialog).toHaveClass(/skyjo-chat-dialog/);
    if (portrait.label === 'Safari compact') await expectNoBlockingAxeViolations(active.page);

    for (const [label, control] of [
      ['chat close control', dialog.getByRole('button', { name: /Close table chat/i })],
      ['chat message field', dialog.getByRole('textbox', { name: 'Message' })],
      ['chat send control', dialog.getByRole('button', { name: 'Send' })]
    ] as const) {
      await expectMinimumTarget(control, label);
    }
    const messageField = dialog.getByRole('textbox', { name: 'Message' });
    await messageField.focus();
    await expect(messageField).toBeFocused();
    expect(
      await dialog.getByRole('log', { name: 'Table chat messages' }).evaluate((element) =>
        window.getComputedStyle(element).overflowY
      )
    ).toBe('auto');

    const openChat = await readActiveLayout(active.page);
    expectFixedActiveLayout(openChat, portrait, (playerCount - 1) * 12);
    expect(openChat.document).toEqual(beforeChat.document);
    expectRectStable(beforeChat.table, openChat.table, 'shared table');
    expectRectStable(beforeChat.opponentRail, openChat.opponentRail, 'opponent rail');
    expectRectStable(beforeChat.band, openChat.band, 'center band');
    expectRectStable(beforeChat.localBoard, openChat.localBoard, 'local board');
    expectRectStable(beforeChat.drawnCard, openChat.drawnCard, 'drawn card');

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expectInsideViewport(
      {
        bottom: (dialogBox?.y ?? 0) + (dialogBox?.height ?? 0),
        height: dialogBox?.height ?? 0,
        left: dialogBox?.x ?? 0,
        right: (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0),
        top: dialogBox?.y ?? 0,
        width: dialogBox?.width ?? 0
      },
      openChat,
      'table chat dialog'
    );

    await dialog.getByRole('button', { name: /Close table chat/i }).click();
    await expect(dialog).toBeHidden();
    await expect(chatTrigger).toBeFocused();
    const afterChat = await readActiveLayout(active.page);
    expectFixedActiveLayout(afterChat, portrait, (playerCount - 1) * 12);
    expect(afterChat.document).toEqual(beforeChat.document);
    expectRectStable(beforeChat.table, afterChat.table, 'shared table after chat close');
    expectRectStable(beforeChat.opponentRail, afterChat.opponentRail, 'opponent rail after chat close');
    expectRectStable(beforeChat.band, afterChat.band, 'center band after chat close');
    expectRectStable(beforeChat.localBoard, afterChat.localBoard, 'local board after chat close');
    expectRectStable(beforeChat.drawnCard, afterChat.drawnCard, 'drawn card after chat close');

    const roomOptionsTrigger = toolbar.getByRole('button', { name: 'Open room options' });
    const beforeOptions = await readActiveLayout(active.page);
    await roomOptionsTrigger.click();
    const roomOptionsDialog = active.page.getByRole('dialog', { name: new RegExp(`Room ${roomCode}`) });
    await expect(roomOptionsDialog).toBeVisible();
    await expect(roomOptionsDialog).toHaveAttribute('aria-modal', 'true');
    const optionsBody = roomOptionsDialog.locator('.skyjo-room-options-body');
    expect(await optionsBody.evaluate((element) => window.getComputedStyle(element).overflowY)).toBe('auto');
    const optionsBox = await roomOptionsDialog.boundingBox();
    expect(optionsBox).not.toBeNull();
    expectInsideViewport(
      {
        bottom: (optionsBox?.y ?? 0) + (optionsBox?.height ?? 0),
        height: optionsBox?.height ?? 0,
        left: optionsBox?.x ?? 0,
        right: (optionsBox?.x ?? 0) + (optionsBox?.width ?? 0),
        top: optionsBox?.y ?? 0,
        width: optionsBox?.width ?? 0
      },
      beforeOptions,
      'room options dialog'
    );
    await expectMinimumTarget(roomOptionsDialog.getByRole('button', { name: 'Close room options' }), 'room options close');
    await expectMinimumTarget(roomOptionsDialog.getByRole('button', { name: 'Share' }), 'room options share');
    const resetRoom = roomOptionsDialog.getByRole('button', { name: 'Reset Room' });
    if (await resetRoom.count()) await expectMinimumTarget(resetRoom, 'room options reset');
    const optionsClose = roomOptionsDialog.getByRole('button', { name: 'Close room options' });
    await expect(optionsClose).toBeFocused();
    await active.page.keyboard.press('Shift+Tab');
    expect(await roomOptionsDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await active.page.keyboard.press('Tab');
    await expect(optionsClose).toBeFocused();
    if (portrait.label === 'Safari compact') await expectNoBlockingAxeViolations(active.page);
    await active.page.keyboard.press('Escape');
    await expect(roomOptionsDialog).toBeHidden();
    await expect(roomOptionsTrigger).toBeFocused();
    const afterOptions = await readActiveLayout(active.page);
    expect(afterOptions.document).toEqual(beforeOptions.document);
    expectRectStable(beforeOptions.table, afterOptions.table, 'shared table after room options');
    expectRectStable(beforeOptions.band, afterOptions.band, 'center band after room options');
  } finally {
    await Promise.allSettled(clients.map(({ context }) => context.close()));
  }
});

test('issue #138 keeps eight-player room options internally scrollable at 200% text', async ({
  browser,
  skyjoServer
}, testInfo) => {
  test.skip(
    !['chromium', 'webkit-phone'].includes(testInfo.project.name),
    'Custom iPhone contexts run once per browser engine.'
  );
  test.setTimeout(120_000);
  const portrait: PortraitVariant = {
    label: 'iPhone Pro Max at 200% text',
    width: 440,
    height: 763,
    textScale: true
  };
  const suffix = safeSuffix(`${testInfo.project.name}-eight-player-${testInfo.workerIndex}-${Date.now()}`);
  const clients: MultiplayerClient[] = [];
  try {
    clients.push(...await openMultiplayerClients(
      browser,
      skyjoServer.baseURL,
      skyjoServer.accessPassword,
      suffix,
      portrait,
      8
    ));
    const host = clients[0];
    await host.page.getByRole('button', { name: 'Create Room' }).click();
    await expect(host.page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    const roomCode = await host.page.locator('.skyjo-room-code').innerText();
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].page.getByLabel('Room code').fill(roomCode);
      await clients[index].page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(clients[index].page.locator('.skyjo-room-code')).toHaveText(roomCode);
    }
    await expect(host.page.locator('.skyjo-room-roster li')).toHaveCount(8);
    await host.page.getByRole('button', { name: 'Start Game' }).click();
    await expect(host.page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8');
    await expectActiveDocumentLocked(host.page);
    await expectOpponentRailReachableByHorizontalScroll(host.page);

    const table = host.page.getByTestId('shared-game-table');
    const tableBefore = await table.boundingBox();
    const trigger = host.page.getByRole('button', { name: 'Open room options' });
    await trigger.click();
    const dialog = host.page.getByRole('dialog', { name: new RegExp(`Room ${roomCode}`) });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = dialog.getByRole('button', { name: 'Close room options' });
    await expect(close).toBeFocused();
    await host.page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await host.page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expectRoomOptionsInternalScroll(host.page, dialog, dialog.locator('.skyjo-room-options-body'));

    await host.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    const tableAfter = await table.boundingBox();
    expect(tableBefore).not.toBeNull();
    expect(tableAfter).not.toBeNull();
    expect(Math.abs((tableAfter?.x ?? 0) - (tableBefore?.x ?? 0))).toBeLessThanOrEqual(pixelTolerance);
    expect(Math.abs((tableAfter?.y ?? 0) - (tableBefore?.y ?? 0))).toBeLessThanOrEqual(pixelTolerance);
    await expectActiveDocumentLocked(host.page);
  } finally {
    await Promise.allSettled(clients.map(({ context }) => context.close()));
  }
});
