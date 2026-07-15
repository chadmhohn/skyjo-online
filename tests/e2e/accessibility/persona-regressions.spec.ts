import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { GameState } from '../../../src/types';
import { soloProgressGameStates } from '../../helpers/soloGameState';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

const minimumTargetSize = 43.99;

async function stageSoloState(page: Page, baseURL: string, state: GameState, stateIndex: number) {
  await page.goto(baseURL);
  await page.evaluate(
    ({ record }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('skyjo-pwa', 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('soloSessions')) {
            const sessions = database.createObjectStore('soloSessions', { keyPath: ['ownerKey', 'gameId'] });
            sessions.createIndex('byOwner', 'ownerKey', { unique: false });
            sessions.createIndex('byOwnerUpdatedAt', ['ownerKey', 'updatedAt'], { unique: false });
          }
          if (!database.objectStoreNames.contains('statsOutbox')) {
            const outbox = database.createObjectStore('statsOutbox', { keyPath: ['ownerKey', 'gameId'] });
            outbox.createIndex('byOwner', 'ownerKey', { unique: false });
            outbox.createIndex('byOwnerNextAttempt', ['ownerKey', 'nextAttemptAt'], { unique: false });
          }
        };
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
  await page.evaluate(
    () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
  );
}

async function setDoubleText(page: Page, enabled: boolean) {
  await page.evaluate((active) => document.documentElement.classList.toggle('skyjo-test-text-scale-200', active), enabled);
  await expect.poll(() => page.evaluate(() => Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)))
    .toBe(enabled ? 32 : 16);
}

async function expectPhoneFocusableContract(
  page: Page,
  state: string,
  options: { progressLabel?: string; normalText: boolean }
) {
  const snapshot = await page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element;
    };
    const rect = (element: HTMLElement) => element.getBoundingClientRect();
    const progress = required('.skyjo-table-band-side-start');
    const band = required('[data-testid="table-center-band"]');
    const controls = required('[data-testid="table-center"]');
    const opponent = required('[data-testid="opponent-rail"]');
    const local = required('[data-testid="local-board"]');
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button, input:not([type="hidden"]), select, summary, textarea, [role="button"], [role="switch"], [role="tab"], [tabindex]'
      )
    ).filter((element) => {
      const bounds = rect(element);
      const style = window.getComputedStyle(element);
      return element.tabIndex >= 0 &&
        !(element as HTMLButtonElement).disabled &&
        !element.closest('[inert]') &&
        !element.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        bounds.width > 0 &&
        bounds.height > 0;
    });
    return {
      bandHeight: rect(band).height,
      boardsDoNotOverlap: rect(opponent).bottom <= rect(band).top + 1 && rect(band).bottom <= rect(local).top + 1,
      controlsContained:
        rect(controls).left >= rect(band).left - 1 &&
        rect(controls).right <= rect(band).right + 1 &&
        rect(controls).top >= rect(band).top - 1 &&
        rect(controls).bottom <= rect(band).bottom + 1,
      focusable: focusable.map((element) => {
        const bounds = rect(element);
        return {
          height: bounds.height,
          label:
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ||
            '',
          tag: element.tagName.toLowerCase(),
          width: bounds.width
        };
      }),
      noHorizontalPageScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
      progress: {
        ariaLabel: progress.getAttribute('aria-label'),
        height: rect(progress).height,
        role: progress.getAttribute('role'),
        tabIndex: progress.getAttribute('tabindex'),
        width: rect(progress).width
      }
    };
  });
  expect(snapshot.boardsDoNotOverlap, `${state} boards should not overlap`).toBe(true);
  expect(snapshot.controlsContained, `${state} center controls should remain contained`).toBe(true);
  expect(snapshot.noHorizontalPageScroll, `${state} should not create page overflow`).toBe(true);
  expect(snapshot.focusable.length, `${state} should expose focusable controls`).toBeGreaterThan(0);
  expect(
    snapshot.focusable.filter((target) => target.width < minimumTargetSize || target.height < minimumTargetSize),
    `${state} contains focus targets smaller than 44 by 44 CSS pixels`
  ).toEqual([]);
  expect(snapshot.focusable.filter((target) => !target.label), `${state} contains unlabeled focus targets`).toEqual([]);
  if (options.normalText) {
    expect(snapshot.bandHeight, `${state} normal phone band should preserve its minimum`).toBeGreaterThanOrEqual(90);
    expect(snapshot.bandHeight, `${state} normal phone band should preserve its maximum`).toBeLessThanOrEqual(110);
  }
  if (options.progressLabel) {
    expect(snapshot.progress).toMatchObject({
      ariaLabel: options.progressLabel,
      role: 'region',
      tabIndex: '0'
    });
    expect(snapshot.progress.width).toBeGreaterThanOrEqual(minimumTargetSize);
    expect(snapshot.progress.height).toBeGreaterThanOrEqual(minimumTargetSize);
  } else {
    expect(snapshot.progress).toMatchObject({ ariaLabel: null, role: null, tabIndex: '-1' });
  }
}

async function expectTabSequence(page: Page, targets: ReturnType<Page['locator']>[]) {
  await targets[0].focus();
  await expect(targets[0]).toBeFocused();
  for (let index = 1; index < targets.length; index += 1) {
    await page.keyboard.press('Tab');
    await expect(targets[index]).toBeFocused();
  }
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 }
]) {
  test(`${viewport.width}x${viewport.height} phone progress semantics stay meaningful through turn and round transitions`, async ({
    page,
    skyjoServer
  }) => {
    test.setTimeout(120_000);
    const states = soloProgressGameStates();
    await installSeededBrowserRuntime(page, viewport.width + 128);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewport);

    const cases = [
      { key: 'opening', state: states.opening, progressLabel: undefined },
      { key: 'choose source', state: states.chooseSource, progressLabel: undefined },
      { key: 'drawn card', state: states.drawnDecision, progressLabel: undefined },
      { key: 'final turn', state: states.finalTurn, progressLabel: 'Final lap status' },
      { key: 'round over', state: states.roundOver, progressLabel: undefined }
    ] as const;

    for (const [caseIndex, scenario] of cases.entries()) {
      await stageSoloState(page, skyjoServer.baseURL, scenario.state, viewport.width * 10 + caseIndex);
      for (const doubleText of [false, true]) {
        await setDoubleText(page, doubleText);
        const label = `${viewport.width}x${viewport.height} ${doubleText ? '200% text' : 'normal text'} ${scenario.key}`;
        await expectPhoneFocusableContract(page, label, {
          progressLabel: scenario.progressLabel,
          normalText: !doubleText
        });
        await expect(page.getByRole('region', { name: 'Opening and final-turn progress' })).toHaveCount(0);

        const guidance = page.getByRole('region', { name: 'Action guidance' });
        if (scenario.key === 'opening') {
          await expect(guidance.getByRole('heading', { level: 2, name: 'Choose two face-down cards' })).toBeVisible();
          await expect(page.locator('.skyjo-opening-tracker')).toHaveCount(0);
          await expectTabSequence(page, [
            guidance,
            page.getByRole('button', { name: /Reveal this opening card/ }).first()
          ]);
        } else if (scenario.key === 'choose source') {
          await expectTabSequence(page, [
            guidance,
            page.getByTestId('table-piles').getByRole('button', { name: /^Deck/ }),
            page.getByTestId('table-piles').getByRole('button', { name: /^Discard/ })
          ]);
        } else if (scenario.key === 'drawn card') {
          const decision = page.getByRole('region', { name: 'Drawn card decision' });
          await expectTabSequence(page, [
            guidance,
            decision,
            decision.getByRole('button', { name: /Place drawn card/ }),
            decision.getByRole('button', { name: /Discard \+ reveal/ })
          ]);
        } else if (scenario.key === 'final turn') {
          const finalLap = page.getByRole('region', { name: 'Final lap status' });
          await expect(finalLap).toHaveCount(1);
          await expect(finalLap.getByText('Final lap active')).toBeVisible();
          await expect(finalLap.getByRole('heading', { name: /went out\./ })).toBeVisible();
          await expectTabSequence(page, [guidance, finalLap]);
        } else {
          const summary = page.getByRole('dialog', { name: 'Round complete.' });
          await expect(summary).toBeVisible();
          await expectTabSequence(page, [
            summary.getByRole('button', { name: 'Minimize' }),
            summary.getByRole('button', { name: 'Next Round' })
          ]);
        }
      }
    }

    const summary = page.getByRole('dialog', { name: 'Round complete.' });
    await summary.getByRole('button', { name: 'Next Round' }).click();
    await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', 'opening-reveal');
    await expect(page.getByRole('region', { name: 'Action guidance' })).toBeFocused();
    await expect(page.locator('.skyjo-table-band-side-start')).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('.skyjo-table-band-side-start')).not.toHaveAttribute('role');
  });
}

async function configureSoloRoster(page: Page, playerCount: number) {
  await page.getByRole('button', { name: 'Open game settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Game' }).click();
  const countButton = settings
    .getByRole('group', { name: 'Choose AI opponent count' })
    .getByRole('button', { name: String(playerCount - 1), exact: true });
  await countButton.click();
  await expect(countButton).toHaveAttribute('aria-pressed', 'true');
  await settings.getByRole('button', { name: 'New Game' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', String(playerCount));
}

async function finishOpeningAndDraw(page: Page) {
  const table = page.getByTestId('shared-game-table');
  const openingCards = page.locator(
    'button[aria-label*="Reveal this opening card"]:visible:not([disabled])'
  );
  await expect(openingCards).toHaveCount(12);
  await openingCards.first().click();
  await expect(openingCards).toHaveCount(11);
  await openingCards.first().click();
  await expect(table).toHaveAttribute('data-phase', 'choose-source', { timeout: 5_000 });

  const deckButton = page.getByTestId('table-piles').locator('button').filter({ hasText: 'Deck' });
  await expect(deckButton).toHaveCount(1);
  await expect(deckButton).toBeEnabled();
  await deckButton.click();
  await expect(table).toHaveAttribute('data-phase', 'choose-replacement');
  await expect(page.locator('.skyjo-drawn-decision')).toBeVisible();
}

async function drawnDecisionSnapshot(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element;
    };
    const rect = (element: HTMLElement) => element.getBoundingClientRect();
    const box = (element: HTMLElement) => {
      const bounds = rect(element);
      return {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width
      };
    };
    const contained = (child: HTMLElement, parent: HTMLElement) => {
      const childRect = rect(child);
      const parentRect = rect(parent);
      return childRect.left >= parentRect.left - 1 && childRect.right <= parentRect.right + 1 &&
        childRect.top >= parentRect.top - 1 && childRect.bottom <= parentRect.bottom + 1;
    };
    const scrollContained = (element: HTMLElement) =>
      element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1;
    const visible = (element: HTMLElement) => {
      const bounds = rect(element);
      return window.getComputedStyle(element).display !== 'none' && bounds.width > 0 && bounds.height > 0;
    };

    const band = required('[data-testid="table-center-band"]');
    const controls = required('[data-testid="table-center"]');
    const opponent = required('[data-testid="opponent-rail"]');
    const region = required('[aria-label="Drawn card decision"]');
    const decision = required('.skyjo-drawn-decision');
    const actionGrid = required('.skyjo-drawn-action-grid');
    const instruction = required('.skyjo-drawn-instruction');
    const drawnCard = required('.skyjo-drawn-card');
    const local = required('[data-testid="local-board"]');
    const buttons = Array.from(actionGrid.querySelectorAll<HTMLElement>('.skyjo-choice-button'));
    const labels = buttons.map((button) => button.querySelector<HTMLElement>('span'));
    const allScrollable = [region, decision, actionGrid, instruction, ...buttons];

    return {
      bandHeight: rect(band).height,
      boardsDoNotOverlap: rect(opponent).bottom <= rect(band).top + 1 && rect(band).bottom <= rect(local).top + 1,
      buttons: buttons.map((button) => ({
        height: rect(button).height,
        width: rect(button).width
      })),
      buttonsContained: buttons.length === 2 && buttons.every((button) => contained(button, actionGrid)),
      cardContained: contained(drawnCard, decision),
      controlsContained: contained(controls, band),
      decisionContained: contained(decision, region),
      decisionBox: box(decision),
      drawnCardVisible: visible(drawnCard),
      instructionContained: contained(instruction, decision),
      instructionText: instruction.textContent?.trim() ?? '',
      instructionVisible: visible(instruction),
      labelsContained: labels.length === 2 && labels.every((label, index) => {
        if (!label) return false;
        return contained(label, buttons[index]);
      }),
      noHorizontalPageScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
      regionContained: contained(region, controls),
      regionBox: box(region),
      scrollContained: allScrollable.every(scrollContained),
      transitionDurations: buttons.map((button) => window.getComputedStyle(button).transitionDuration)
    };
  });
}

async function railSnapshot(page: Page) {
  return page.getByTestId('opponent-rail').evaluate((rail) => {
    const element = rail as HTMLElement;
    const railRect = element.getBoundingClientRect();
    const children = Array.from(element.querySelectorAll<HTMLElement>('[data-player-id]'));
    return {
      childCount: children.length,
      clientWidth: element.clientWidth,
      firstWidth: children[0]?.getBoundingClientRect().width ?? 0,
      overflowX: window.getComputedStyle(element).overflowX,
      overflowY: window.getComputedStyle(element).overflowY,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      visibleIds: children.flatMap((child) => {
        const rect = child.getBoundingClientRect();
        return rect.right > railRect.left + 1 && rect.left < railRect.right - 1
          ? [child.dataset.playerId ?? '']
          : [];
      })
    };
  });
}

async function swipeOpponentRailByTouch(page: Page, session: CDPSession) {
  const rail = page.getByTestId('opponent-rail');
  const box = await rail.boundingBox();
  if (!box) throw new Error('Opponent rail has no touchable bounding box.');
  const snapshot = await railSnapshot(page);
  const distance = Math.max(80, Math.min(snapshot.firstWidth * 0.7, box.width * 0.55));
  const startX = Math.min(box.x + box.width - 12, box.x + distance + 12);
  const endX = startX - distance;
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

const railViewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 }
];

async function stylesheetHrefs(page: Page) {
  return page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.flatMap((link) => {
      const href = (link as HTMLLinkElement).href;
      return href ? [href] : [];
    })
  );
}

async function expectCompiledOpponentOverflow(page: Page) {
  const hrefs = await stylesheetHrefs(page);
  expect(hrefs.length).toBeGreaterThan(0);
  const compiledCss = (
    await Promise.all(
      hrefs.map(async (href) => {
        const response = await page.context().request.get(href);
        expect(response.ok(), `compiled stylesheet should load: ${href}`).toBe(true);
        return response.text();
      })
    )
  ).join('\n').replace(/\s+/g, '');
  const opponentRule = compiledCss.match(/\.skyjo-opponents-board\{([^}]*)\}/)?.[1] ?? '';
  expect(
    opponentRule.includes('overflow:autohidden') ||
      (opponentRule.includes('overflow-x:auto') && opponentRule.includes('overflow-y:hidden')),
    'compiled opponent rule should retain horizontal scrolling and vertical containment'
  ).toBe(true);
  return hrefs;
}

async function expectRailGeometry(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const rail = page.getByTestId('opponent-rail');
  await expect(rail).toBeVisible();
  const snapshot = await railSnapshot(page);
  expect(snapshot.overflowX, `${viewport.width}px rail should compute horizontal overflow`).toBe('auto');
  expect(snapshot.overflowY, `${viewport.width}px rail should contain vertical overflow`).toBe('hidden');
  expect(snapshot.childCount).toBe(7);
  expect(snapshot.scrollWidth).toBeGreaterThan(snapshot.clientWidth + 1);
}

async function expectWheelExposure(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const rail = page.getByTestId('opponent-rail');
  await rail.hover();
  await page.mouse.wheel(-10_000, 0);
  await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeLessThanOrEqual(1);
  let snapshot = await railSnapshot(page);
  const exposed = new Set(snapshot.visibleIds);
  for (let gesture = 0; gesture < 20; gesture += 1) {
    snapshot = await railSnapshot(page);
    const maximum = snapshot.scrollWidth - snapshot.clientWidth;
    if (snapshot.scrollLeft >= maximum - 1) break;
    const before = snapshot.scrollLeft;
    await rail.hover();
    await page.mouse.wheel(Math.max(80, snapshot.firstWidth * 0.7), 0);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(before + 0.5);
    (await railSnapshot(page)).visibleIds.forEach((id) => exposed.add(id));
  }
  snapshot = await railSnapshot(page);
  expect(snapshot.scrollLeft).toBeGreaterThanOrEqual(snapshot.scrollWidth - snapshot.clientWidth - 1);
  snapshot.visibleIds.forEach((id) => exposed.add(id));
  expect([...exposed].filter(Boolean), `${viewport.width}px wheel gestures should expose all seven boards`).toHaveLength(7);
}

async function expectKeyboardExposure(page: Page) {
  await page.setViewportSize(railViewports[0]);
  const guidance = page.getByRole('region', { name: 'Action guidance' });
  const rail = page.getByRole('region', { name: 'Opponent boards' });
  const followingCard = page.getByRole('button', { name: /Reveal this opening card/ }).first();
  await guidance.focus();
  await expect(guidance).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rail).toBeFocused();

  await rail.hover();
  await page.mouse.wheel(-10_000, 0);
  await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeLessThanOrEqual(1);
  await expect(rail).toBeFocused();
  const before = await railSnapshot(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(before.scrollLeft + 0.5);
  let afterArrow = await railSnapshot(page);
  for (let press = 0; press < 20 && afterArrow.visibleIds.every((id) => before.visibleIds.includes(id)); press += 1) {
    const previousScrollLeft = afterArrow.scrollLeft;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(previousScrollLeft + 0.5);
    afterArrow = await railSnapshot(page);
  }
  expect(
    afterArrow.visibleIds.some((id) => id && !before.visibleIds.includes(id)),
    'keyboard scrolling should expose a later opponent board'
  ).toBe(true);

  await page.keyboard.press('Tab');
  await expect(rail).not.toBeFocused();
  await expect(followingCard).toBeFocused();
}

async function expectTouchExposure(page: Page, session: CDPSession, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeLessThanOrEqual(1);
  let snapshot = await railSnapshot(page);
  const exposed = new Set(snapshot.visibleIds);
  for (let gesture = 0; gesture < 20; gesture += 1) {
    snapshot = await railSnapshot(page);
    const maximum = snapshot.scrollWidth - snapshot.clientWidth;
    if (snapshot.scrollLeft >= maximum - 1) break;
    const before = snapshot.scrollLeft;
    await swipeOpponentRailByTouch(page, session);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(before + 0.5);
    (await railSnapshot(page)).visibleIds.forEach((id) => exposed.add(id));
  }
  snapshot = await railSnapshot(page);
  expect(snapshot.scrollLeft, `${viewport.width}px touch swipes should reach the seventh opponent`).toBeGreaterThanOrEqual(
    snapshot.scrollWidth - snapshot.clientWidth - 1
  );
  snapshot.visibleIds.forEach((id) => exposed.add(id));
  expect([...exposed].filter(Boolean), `${viewport.width}px touch swipes should expose all seven boards`).toHaveLength(7);
}

async function expectActionableCardsMeetTarget(page: Page, state: string) {
  const cards = page.locator('button.skyjo-card-selectable:not([disabled])');
  await expect(cards, `${state} should expose all twelve actionable cards`).toHaveCount(12);
  const geometry = await cards.evaluateAll((elements) => {
    const board = document.querySelector<HTMLElement>('[data-testid="local-board"]');
    if (!board) throw new Error('Missing local board.');
    const boardRect = board.getBoundingClientRect();
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        centerHit: hit === element || element.contains(hit),
        contained:
          rect.left >= boardRect.left - 1 &&
          rect.right <= boardRect.right + 1 &&
          rect.top >= boardRect.top - 1 &&
          rect.bottom <= boardRect.bottom + 1,
        height: rect.height,
        width: rect.width
      };
    });
  });
  expect(
    geometry.filter((card) => card.width < minimumTargetSize || card.height < minimumTargetSize),
    `${state} contains enabled cards smaller than 44 by 44 CSS pixels`
  ).toEqual([]);
  expect(geometry.every((card) => card.centerHit && card.contained), `${state} cards should remain hit-testable and contained`).toBe(true);
}

test('compiled opponent rail CSS preserves seven-seat geometry and trusted Chromium gestures', async ({
  browser,
  page,
  skyjoServer
}, testInfo) => {
  test.setTimeout(75_000);
  await installSeededBrowserRuntime(page, 81);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await expect(page.getByTestId('opponent-rail')).not.toHaveAttribute('tabindex');
  await expect(page.getByTestId('local-board')).not.toHaveAttribute('tabindex');
  await configureSoloRoster(page, 8);
  await expect(page.getByTestId('opponent-rail')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('local-board')).not.toHaveAttribute('tabindex');
  await expectCompiledOpponentOverflow(page);
  for (const viewport of railViewports) await expectRailGeometry(page, viewport);
  if (testInfo.project.name !== 'chromium') return;

  await expectKeyboardExposure(page);

  let wheelContext: BrowserContext | undefined;
  try {
    wheelContext = await browser.newContext({
      hasTouch: false,
      isMobile: false,
      serviceWorkers: 'allow',
      viewport: railViewports[0]
    });
    const access = await wheelContext.request.post(`${skyjoServer.baseURL}/login`, {
      form: { next: '/', password: skyjoServer.accessPassword }
    });
    expect(access.ok()).toBe(true);
    const wheelPage = await wheelContext.newPage();
    await installSeededBrowserRuntime(wheelPage, 81);
    await wheelPage.emulateMedia({ reducedMotion: 'reduce' });
    await wheelPage.goto(`${skyjoServer.baseURL}/single-player`);
    await configureSoloRoster(wheelPage, 8);
    await expectCompiledOpponentOverflow(wheelPage);
    for (const viewport of railViewports) {
      await expectRailGeometry(wheelPage, viewport);
      await expectWheelExposure(wheelPage, viewport);
    }
  } finally {
    await wheelContext?.close();
  }

  for (const viewport of railViewports) {
    let touchContext: BrowserContext | undefined;
    let touchSession: CDPSession | undefined;
    try {
      touchContext = await browser.newContext({
        hasTouch: true,
        isMobile: false,
        serviceWorkers: 'allow',
        viewport
      });
      const access = await touchContext.request.post(`${skyjoServer.baseURL}/login`, {
        form: { next: '/', password: skyjoServer.accessPassword }
      });
      expect(access.ok()).toBe(true);
      const touchPage = await touchContext.newPage();
      await installSeededBrowserRuntime(touchPage, 81);
      await touchPage.emulateMedia({ reducedMotion: 'reduce' });
      await touchPage.goto(`${skyjoServer.baseURL}/single-player`);
      await configureSoloRoster(touchPage, 8);
      await expectRailGeometry(touchPage, viewport);
      touchSession = await touchContext.newCDPSession(touchPage);
      await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await expectTouchExposure(touchPage, touchSession, viewport);
    } finally {
      await touchSession?.detach();
      await touchContext?.close();
    }
  }
});

test('non-mobile WebKit keyboard and wheel input match the mobile build', async ({
  browser,
  page,
  skyjoServer
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('webkit'), 'WebKit mobile does not expose mouse wheel input.');
  test.setTimeout(75_000);
  await installSeededBrowserRuntime(page, 84);
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  const primaryStylesheets = await stylesheetHrefs(page);
  let wheelContext: BrowserContext | undefined;
  try {
    wheelContext = await browser.newContext({
      hasTouch: false,
      isMobile: false,
      serviceWorkers: 'allow',
      viewport: railViewports[0]
    });
    const access = await wheelContext.request.post(`${skyjoServer.baseURL}/login`, {
      form: { next: '/', password: skyjoServer.accessPassword }
    });
    expect(access.ok()).toBe(true);
    const wheelPage = await wheelContext.newPage();
    await installSeededBrowserRuntime(wheelPage, 84);
    await wheelPage.emulateMedia({ reducedMotion: 'reduce' });
    await wheelPage.goto(`${skyjoServer.baseURL}/single-player`);
    await configureSoloRoster(wheelPage, 8);
    expect(await stylesheetHrefs(wheelPage)).toEqual(primaryStylesheets);
    await expectCompiledOpponentOverflow(wheelPage);
    await expectKeyboardExposure(wheelPage);
    for (const viewport of railViewports) {
      await expectRailGeometry(wheelPage, viewport);
      await expectWheelExposure(wheelPage, viewport);
    }
  } finally {
    await wheelContext?.close();
  }
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 }
]) {
  test(`${viewport.width}x${viewport.height} normal-text drawn decisions remain fully contained`, async ({
    page,
    skyjoServer
  }) => {
    await installSeededBrowserRuntime(page, viewport.width);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewport);
    await page.goto(`${skyjoServer.baseURL}/single-player`);
    await finishOpeningAndDraw(page);

    const decisionRegion = page.getByRole('region', { name: 'Drawn card decision' });
    const placeChoice = decisionRegion.getByRole('button', { name: /Place drawn card/ });
    const discardChoice = decisionRegion.getByRole('button', { name: /Discard \+ reveal/ });
    await expect(decisionRegion).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Action guidance' })).toBeVisible();
    await expect(placeChoice).toHaveCount(1);
    await expect(discardChoice).toHaveCount(1);
    await expect(page.locator('.skyjo-drawn-instruction')).toBeHidden();

    const snapshot = await drawnDecisionSnapshot(page);
    expect(snapshot.bandHeight).toBeGreaterThanOrEqual(90);
    expect(snapshot.bandHeight).toBeLessThanOrEqual(110);
    expect(snapshot.buttons.every((button) => button.width >= minimumTargetSize && button.height >= minimumTargetSize)).toBe(true);
    expect(snapshot.buttonsContained).toBe(true);
    expect(snapshot.decisionContained, JSON.stringify({ decision: snapshot.decisionBox, region: snapshot.regionBox })).toBe(true);
    expect(snapshot.instructionVisible).toBe(false);
    expect(snapshot.labelsContained).toBe(true);
    expect(snapshot.noHorizontalPageScroll).toBe(true);
    expect(snapshot.regionContained).toBe(true);
    expect(snapshot.scrollContained).toBe(true);

    await placeChoice.focus();
    await expect(placeChoice).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(discardChoice).toBeFocused();
  });
}

test('844x390 drawn decisions replace redundant side guidance with one contained action region', async ({
  page,
  skyjoServer
}) => {
  await installSeededBrowserRuntime(page, 844);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await finishOpeningAndDraw(page);

  const decisionRegion = page.getByRole('region', { name: 'Drawn card decision' });
  const placeChoice = decisionRegion.getByRole('button', { name: /Place drawn card/ });
  const discardChoice = decisionRegion.getByRole('button', { name: /Discard \+ reveal/ });
  await expect(decisionRegion).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Action guidance' })).toHaveCount(0);
  await expect(page.locator('.skyjo-drawn-card')).toBeVisible();
  await expect(page.locator('.skyjo-drawn-instruction')).toBeVisible();
  await expect(page.locator('.skyjo-drawn-instruction')).toContainText('Place selected. Choose a highlighted card.');

  const snapshot = await drawnDecisionSnapshot(page);
  expect(snapshot.boardsDoNotOverlap).toBe(true);
  expect(snapshot.buttons.every((button) => button.width >= minimumTargetSize && button.height >= minimumTargetSize)).toBe(true);
  expect(snapshot.buttonsContained).toBe(true);
  expect(snapshot.cardContained).toBe(true);
  expect(snapshot.controlsContained).toBe(true);
  expect(snapshot.decisionContained).toBe(true);
  expect(snapshot.drawnCardVisible).toBe(true);
  expect(snapshot.instructionContained).toBe(true);
  expect(snapshot.instructionVisible).toBe(true);
  expect(snapshot.labelsContained).toBe(true);
  expect(snapshot.noHorizontalPageScroll).toBe(true);
  expect(snapshot.regionContained).toBe(true);
  expect(snapshot.scrollContained).toBe(true);
  expect(snapshot.transitionDurations.every((duration) => Number.parseFloat(duration) <= 0.001)).toBe(true);

  await decisionRegion.focus();
  await expect(decisionRegion).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(placeChoice).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(discardChoice).toBeFocused();
});

test('844x390 drawn decisions reflow without internal overflow at 200% text', async ({
  page,
  skyjoServer
}) => {
  await installSeededBrowserRuntime(page, 845);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await finishOpeningAndDraw(page);
  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));

  const decisionRegion = page.getByRole('region', { name: 'Drawn card decision' });
  const placeChoice = decisionRegion.getByRole('button', { name: /Place drawn card/ });
  const discardChoice = decisionRegion.getByRole('button', { name: /Discard \+ reveal/ });
  await expect(decisionRegion).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Action guidance' })).toHaveCount(0);
  await expect(page.locator('.skyjo-drawn-card')).toBeVisible();
  await expect(page.locator('.skyjo-drawn-instruction')).toBeVisible();

  await expect.poll(async () => {
    const snapshot = await drawnDecisionSnapshot(page);
    return {
      bandExpanded: snapshot.bandHeight > 150,
      boardsDoNotOverlap: snapshot.boardsDoNotOverlap,
      buttonsContained: snapshot.buttonsContained,
      cardContained: snapshot.cardContained,
      controlsContained: snapshot.controlsContained,
      decisionContained: snapshot.decisionContained,
      instructionContained: snapshot.instructionContained,
      labelsContained: snapshot.labelsContained,
      noHorizontalPageScroll: snapshot.noHorizontalPageScroll,
      regionContained: snapshot.regionContained,
      scrollContained: snapshot.scrollContained,
      targetsMeetMinimum: snapshot.buttons.every(
        (button) => button.width >= minimumTargetSize && button.height >= minimumTargetSize
      )
    };
  }).toEqual({
    bandExpanded: true,
    boardsDoNotOverlap: true,
    buttonsContained: true,
    cardContained: true,
    controlsContained: true,
    decisionContained: true,
    instructionContained: true,
    labelsContained: true,
    noHorizontalPageScroll: true,
    regionContained: true,
    scrollContained: true,
    targetsMeetMinimum: true
  });

  await placeChoice.focus();
  await expect(placeChoice).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(discardChoice).toBeFocused();
});

test('320x568 drawn decisions reflow at 200% text while normal text keeps a compact band', async ({
  page,
  skyjoServer
}) => {
  test.setTimeout(45_000);
  await installSeededBrowserRuntime(page, 82);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  await finishOpeningAndDraw(page);

  const normalBandHeight = await page.getByTestId('table-center-band').evaluate((band) => band.getBoundingClientRect().height);
  expect(normalBandHeight).toBeGreaterThanOrEqual(90);
  expect(normalBandHeight).toBeLessThanOrEqual(110);

  await page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          return element.getBoundingClientRect();
        };
        const opponent = rect('[data-testid="opponent-rail"]');
        const band = rect('[data-testid="table-center-band"]');
        const controls = rect('[data-testid="table-center"]');
        const piles = rect('[data-testid="table-piles"]');
        const decision = rect('.skyjo-drawn-decision');
        const local = rect('[data-testid="local-board"]');
        const choiceElements = Array.from(
          document.querySelectorAll<HTMLElement>('.skyjo-drawn-decision .skyjo-choice-button')
        );
        const choices = choiceElements.map((button) => button.getBoundingClientRect());
        const values = [opponent, band, controls, piles, decision, local, ...choices]
          .flatMap((value) => [value.left, value.top, value.right, value.bottom, value.width, value.height]);
        return {
          bandExpanded: band.height > 110,
          boardsDoNotOverlap: opponent.bottom <= band.top + 1 && band.bottom <= local.top + 1,
          choicesContained: choices.length === 2 && choices.every((choice) =>
            choice.left >= decision.left - 1 && choice.right <= decision.right + 1 &&
            choice.top >= decision.top - 1 && choice.bottom <= decision.bottom + 1 &&
            choice.width >= 43.99 && choice.height >= 43.99
          ),
          choiceLabelsContained: choiceElements.every((button) => {
            const buttonRect = button.getBoundingClientRect();
            const label = button.querySelector<HTMLElement>('span');
            if (!label) return false;
            const labelRect = label.getBoundingClientRect();
            return button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 &&
              labelRect.left >= buttonRect.left - 1 && labelRect.right <= buttonRect.right + 1 &&
              labelRect.top >= buttonRect.top - 1 && labelRect.bottom <= buttonRect.bottom + 1;
          }),
          controlsContained: controls.left >= band.left - 1 && controls.right <= band.right + 1 &&
            controls.top >= band.top - 1 && controls.bottom <= band.bottom + 1,
          decisionContained: decision.left >= controls.left - 1 && decision.right <= controls.right + 1 &&
            decision.top >= controls.top - 1 && decision.bottom <= controls.bottom + 1,
          finite: values.every(Number.isFinite),
          noHorizontalPageScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
          pilesBeforeDecision: piles.bottom <= decision.top + 1,
          rootFontSize: Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
        };
      })
    )
    .toEqual({
      bandExpanded: true,
      boardsDoNotOverlap: true,
      choicesContained: true,
      choiceLabelsContained: true,
      controlsContained: true,
      decisionContained: true,
      finite: true,
      noHorizontalPageScroll: true,
      pilesBeforeDecision: true,
      rootFontSize: 32
    });

  const choiceButtons = await page.locator('.skyjo-drawn-decision .skyjo-choice-button').all();
  expect(choiceButtons).toHaveLength(2);
  for (const button of choiceButtons) {
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport();
  }

  const discardChoice = page.locator('.skyjo-choice-button').filter({ hasText: 'Discard + reveal' });
  const placeChoice = page.locator('.skyjo-choice-button').filter({ hasText: 'Place drawn card' });
  await expect(discardChoice).toHaveCount(1);
  await expect(placeChoice).toHaveCount(1);
  await discardChoice.click();
  await expect(discardChoice).toHaveAttribute('aria-pressed', 'true');
  await placeChoice.click();
  await expect(placeChoice).toHaveAttribute('aria-pressed', 'true');

  const replacementCards = page.locator('button.skyjo-card-selectable:not([disabled])');
  await expect(replacementCards).toHaveCount(12);
  const replacementCard = replacementCards.first();
  await replacementCard.scrollIntoViewIfNeeded();
  await expect(replacementCard).toBeInViewport();
  expect(await replacementCard.evaluate((card) => {
    const rect = card.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width >= 43.99 && rect.height >= 43.99 && (hit === card || card.contains(hit));
  })).toBe(true);
  await replacementCard.click();
  await expect(page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', 'choose-source', { timeout: 5_000 });
});

test('compact desktop opening and replacement cards keep 44px enabled hitboxes', async ({ page, skyjoServer }) => {
  test.setTimeout(30_000);
  await installSeededBrowserRuntime(page, 83);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${skyjoServer.baseURL}/single-player`);

  await expectActionableCardsMeetTarget(page, 'opening');
  await finishOpeningAndDraw(page);
  await expectActionableCardsMeetTarget(page, 'replacement');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('all face-up card gradients meet 4.5:1 at both endpoints and the midpoint', async ({ page, skyjoServer }) => {
  await page.goto(`${skyjoServer.baseURL}/single-player`);
  const results = await page.evaluate(() => {
    type Rgb = [number, number, number];
    const parseRgb = (value: string): Rgb => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Could not parse color: ${value}`);
      return channels as Rgb;
    };
    const luminance = ([red, green, blue]: Rgb) => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const contrast = (first: Rgb, second: Rgb) => {
      const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const classes = [
      'skyjo-card-blue-dark',
      'skyjo-card-blue',
      'skyjo-card-cyan',
      'skyjo-card-green',
      'skyjo-card-gold',
      'skyjo-card-red'
    ];
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-1000px';
    document.body.append(host);
    const measured = classes.map((className) => {
      const card = document.createElement('div');
      card.className = `skyjo-card ${className}`;
      card.textContent = '8';
      host.append(card);
      const style = window.getComputedStyle(card);
      const foreground = parseRgb(style.color);
      const gradientColors = [...style.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)]
        .map((match) => parseRgb(match[1]));
      if (gradientColors.length < 2) throw new Error(`Missing gradient endpoints for ${className}`);
      const [start, end] = gradientColors;
      const midpoint = start.map((channel, index) => (channel + end[index]) / 2) as Rgb;
      return {
        className,
        ratios: [start, midpoint, end].map((background) => contrast(foreground, background))
      };
    });
    host.remove();
    return measured;
  });

  expect(results).toHaveLength(6);
  for (const result of results) {
    expect(Math.min(...result.ratios), `${result.className} should remain WCAG AA across its gradient`).toBeGreaterThanOrEqual(4.5);
  }
});
