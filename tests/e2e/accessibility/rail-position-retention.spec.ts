import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import { expect, installSeededBrowserRuntime, test } from '../fixtures';

const phoneViewport = { width: 390, height: 844 };
const retainedPositionTolerance = 1;
const retainedObservationMs = 325;
const finalRetentionCheckpointMs = 1700;
const openingUpdateSchedulingBudgetMs = 100;
const userScrollPauseMs = 1800;

type AuditedGesture = {
  at: number;
  epochMs: number;
  id: number;
  key: string;
  kind: string;
  trusted: boolean;
};

type AuditedRailSample = {
  at: number;
  currentFullyVisible: boolean;
  currentPlayerId: string;
  epochMs: number;
  openingCardCount: number;
  phase: string;
  scrollLeft: number;
};

type RailAudit = {
  checkpoints: Array<AuditedRailSample & { gestureId: number }>;
  gestures: AuditedGesture[];
  scrollEnds: Array<{ at: number; epochMs: number; scrollLeft: number }>;
  scrolls: AuditedRailSample[];
  states: AuditedRailSample[];
};

type RoomFrame = {
  playerId?: string;
  revision?: number;
  room?: {
    revision?: number;
    state?: null | {
      currentPlayerIndex: number;
      players: Array<{ id: string }>;
    };
  };
  type?: string;
};

type MultiplayerClient = {
  context: BrowserContext;
  page: Page;
};

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

async function installRoomFrameAudit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const frames: unknown[] = [];
    class AuditedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            frames.push(JSON.parse(event.data));
          } catch {
            // The room client handles malformed frames; this audit only needs valid snapshots.
          }
        });
      }
    }
    Object.defineProperties(window, {
      __skyjoRailRoomFrames: { configurable: true, value: frames },
      WebSocket: { configurable: true, value: AuditedWebSocket }
    });
  });
}

async function latestRoomFrame(page: Page): Promise<RoomFrame | undefined> {
  return page.evaluate(() => {
    const frames = (window as typeof window & { __skyjoRailRoomFrames?: RoomFrame[] }).__skyjoRailRoomFrames || [];
    return [...frames]
      .reverse()
      .find((frame) => (frame.type === 'snapshot' || frame.type === 'resync' || frame.type === 'ack') && frame.room?.state);
  });
}

async function installRailAudit(page: Page): Promise<void> {
  await page.getByTestId('opponent-rail').evaluate((rail) => {
    const element = rail as HTMLElement;
    const table = element.closest<HTMLElement>('[data-testid="shared-game-table"]');
    if (!table) throw new Error('Shared game table was unavailable for the rail audit.');

    const audit: RailAudit = { checkpoints: [], gestures: [], scrollEnds: [], scrolls: [], states: [] };
    const sample = (): AuditedRailSample => {
      const current = element.querySelector<HTMLElement>('.skyjo-panel-current[data-player-id]');
      const railRect = element.getBoundingClientRect();
      const currentRect = current?.getBoundingClientRect();
      return {
        at: performance.now(),
        currentFullyVisible: Boolean(
          currentRect && currentRect.left >= railRect.left - 1 && currentRect.right <= railRect.right + 1
        ),
        currentPlayerId: current?.dataset.playerId || '',
        epochMs: Date.now(),
        openingCardCount: table.querySelectorAll('button[aria-label*="Reveal this opening card"]:not([disabled])').length,
        phase: table.dataset.phase || '',
        scrollLeft: element.scrollLeft
      };
    };
    let previousStateSignature = '';
    const recordState = () => {
      const next = sample();
      const signature = `${next.phase}|${next.currentPlayerId}|${next.openingCardCount}`;
      if (signature === previousStateSignature) return;
      previousStateSignature = signature;
      audit.states.push(next);
    };
    const recordGesture = (event: Event) => {
      const keyboard = event instanceof KeyboardEvent ? event.key : '';
      if (keyboard && !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(keyboard)) return;
      const gesture: AuditedGesture = {
        at: performance.now(),
        epochMs: Date.now(),
        id: audit.gestures.length,
        key: keyboard,
        kind: event.type,
        trusted: event.isTrusted
      };
      audit.gestures.push(gesture);
      for (const delayMs of [1500, 1550, 1600, 1650, 1700]) {
        window.setTimeout(() => {
          audit.checkpoints.push({ ...sample(), gestureId: gesture.id });
        }, delayMs);
      }
    };

    element.addEventListener('focusin', recordGesture);
    element.addEventListener('keydown', recordGesture);
    element.addEventListener('pointerdown', recordGesture, { passive: true });
    element.addEventListener('touchstart', recordGesture, { passive: true });
    element.addEventListener('wheel', recordGesture, { passive: true });
    element.addEventListener('scroll', () => audit.scrolls.push(sample()), { passive: true });
    element.addEventListener('scrollend', () => {
      audit.scrollEnds.push({ at: performance.now(), epochMs: Date.now(), scrollLeft: element.scrollLeft });
    });
    new MutationObserver(recordState).observe(table, {
      attributeFilter: ['aria-label', 'class', 'data-phase', 'disabled'],
      attributes: true,
      childList: true,
      subtree: true
    });
    recordState();
    Object.defineProperty(window, '__skyjoRailAudit', { configurable: true, value: audit });
  });
}

async function getRailAudit(page: Page): Promise<RailAudit> {
  return page.evaluate(() => {
    const audit = (window as typeof window & { __skyjoRailAudit: RailAudit }).__skyjoRailAudit;
    return {
      checkpoints: [...audit.checkpoints],
      gestures: [...audit.gestures],
      scrollEnds: [...audit.scrollEnds],
      scrolls: [...audit.scrolls],
      states: [...audit.states]
    };
  });
}

async function railSnapshot(page: Page) {
  return page.getByTestId('opponent-rail').evaluate((rail) => {
    const element = rail as HTMLElement;
    const current = element.querySelector<HTMLElement>('.skyjo-panel-current[data-player-id]');
    const railRect = element.getBoundingClientRect();
    const currentRect = current?.getBoundingClientRect();
    return {
      currentOpponentFullyVisible: Boolean(
        currentRect && currentRect.left >= railRect.left - 1 && currentRect.right <= railRect.right + 1
      ),
      currentPlayerId: current?.dataset.playerId || '',
      maximum: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollSnapType: window.getComputedStyle(element).scrollSnapType
    };
  });
}

async function waitForSettledRail(page: Page, gesture: AuditedGesture) {
  return page.getByTestId('opponent-rail').evaluate(async (rail, trustedGesture) => {
    const element = rail as HTMLElement;
    const audit = (window as typeof window & { __skyjoRailAudit: RailAudit }).__skyjoRailAudit;
    const deadline = performance.now() + 2500;
    let previous = element.scrollLeft;
    let stableSamples = 0;
    while (performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 32));
      const current = element.scrollLeft;
      stableSamples = Math.abs(current - previous) <= 0.25 ? stableSamples + 1 : 0;
      const scrollEnd = audit.scrollEnds.find((entry) => entry.at >= trustedGesture.at);
      if (scrollEnd && Math.abs(current - scrollEnd.scrollLeft) <= 0.25) {
        return {
          at: performance.now(),
          mode: 'scrollend',
          scrollLeft: current,
          stableSamples
        };
      }
      if (stableSamples >= 10) {
        return {
          at: performance.now(),
          mode: 'stable-samples',
          scrollLeft: current,
          stableSamples
        };
      }
      previous = current;
    }
    throw new Error(`Opponent rail did not settle after trusted ${trustedGesture.kind} input.`);
  }, gesture);
}

function latestTrustedGesture(audit: RailAudit, kind: string, key = ''): AuditedGesture {
  const gesture = [...audit.gestures]
    .reverse()
    .find((entry) => entry.kind === kind && entry.key === key && entry.trusted);
  expect(gesture, `A trusted ${kind}${key ? ` ${key}` : ''} event should be recorded in-page.`).toBeDefined();
  return gesture as AuditedGesture;
}

async function expectOpeningUpdateObservationBudget(page: Page, gesture: AuditedGesture): Promise<void> {
  const elapsedMs = await page.evaluate((gestureEpochMs) => Date.now() - gestureEpochMs, gesture.epochMs);
  const latestSafeStartMs = finalRetentionCheckpointMs - retainedObservationMs - openingUpdateSchedulingBudgetMs;
  expect(
    elapsedMs,
    `Trusted ${gesture.kind} input must settle by ${latestSafeStartMs} ms after the gesture so the opening update has ` +
      `${openingUpdateSchedulingBudgetMs} ms to render and remains observable for ${retainedObservationMs} ms before ` +
      `the ${finalRetentionCheckpointMs} ms checkpoint inside the ${userScrollPauseMs} ms pause.`
  ).toBeLessThanOrEqual(latestSafeStartMs);
}

function assertUpdateWithinPause(
  gesture: AuditedGesture,
  update: AuditedRailSample,
  retainedPosition: number
): void {
  expect(update.epochMs).toBeGreaterThanOrEqual(gesture.epochMs);
  expect(update.epochMs - gesture.epochMs).toBeLessThan(userScrollPauseMs);
  expect(Math.abs(update.scrollLeft - retainedPosition)).toBeLessThanOrEqual(retainedPositionTolerance);
}

async function expectRetainedThroughCheckpoint(
  page: Page,
  gesture: AuditedGesture,
  update: AuditedRailSample,
  retainedPosition: number,
  settledAt: number
) {
  const isQualifyingCheckpoint = (entry: AuditedRailSample & { gestureId: number }) =>
    entry.gestureId === gesture.id &&
    entry.epochMs - update.epochMs >= retainedObservationMs &&
    entry.epochMs - gesture.epochMs < userScrollPauseMs;
  await expect
    .poll(async () => (await getRailAudit(page)).checkpoints.some(isQualifyingCheckpoint))
    .toBe(true);
  const audit = await getRailAudit(page);
  const checkpoint = audit.checkpoints.find(isQualifyingCheckpoint);
  expect(checkpoint).toBeDefined();
  const retainedCheckpoint = checkpoint as AuditedRailSample & { gestureId: number };
  const scrolls = audit.scrolls.filter(
    (entry) => entry.at >= settledAt && entry.epochMs <= retainedCheckpoint.epochMs
  );
  expect(retainedCheckpoint.epochMs - update.epochMs).toBeGreaterThanOrEqual(retainedObservationMs);
  expect(retainedCheckpoint.epochMs - gesture.epochMs).toBeLessThan(userScrollPauseMs);
  expect(Math.abs(retainedCheckpoint.scrollLeft - retainedPosition)).toBeLessThanOrEqual(retainedPositionTolerance);
  for (const sample of scrolls) {
    expect(Math.abs(sample.scrollLeft - retainedPosition)).toBeLessThanOrEqual(retainedPositionTolerance);
  }
  return retainedCheckpoint;
}

async function openingCards(page: Page) {
  return page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])');
}

async function activateOpeningCardImmediately(page: Page): Promise<void> {
  await page
    .locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])')
    .first()
    .evaluate((card) => (card as HTMLButtonElement).click());
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

async function openMultiplayerClients(
  browser: Browser,
  baseURL: string,
  accessPassword: string,
  suffix: string
): Promise<MultiplayerClient[]> {
  const clients: MultiplayerClient[] = [];
  const createdContexts: BrowserContext[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const context = await browser.newContext({
        isMobile: false,
        serviceWorkers: 'allow',
        viewport: phoneViewport
      });
      createdContexts.push(context);
      await installRoomFrameAudit(context);
      const access = await context.request.post(`${baseURL}/login`, {
        form: { next: '/', password: accessPassword }
      });
      expect(access.ok()).toBe(true);
      const signup = await context.request.post(`${baseURL}/api/account/signup`, {
        data: {
          confirmPassword: 'rail-retention-password',
          displayName: `Rail Seat ${index + 1}`,
          email: `rail-seat-${index + 1}-${suffix}@example.test`,
          password: 'rail-retention-password'
        }
      });
      expect(signup.status()).toBe(201);
      const page = await context.newPage();
      await installSeededBrowserRuntime(page, 127 + index);
      await page.goto(`${baseURL}/lobby`);
      await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
      clients.push({ context, page });
    }
    return clients;
  } catch (error) {
    await Promise.allSettled(createdContexts.map((context) => context.close()));
    throw error;
  }
}

async function clickNextOpeningCard(clients: MultiplayerClient[]): Promise<void> {
  let active: MultiplayerClient | undefined;
  await expect.poll(async () => {
    for (const client of clients) {
      const card = client.page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])').first();
      if (await card.count()) {
        active = client;
        return true;
      }
    }
    return false;
  }).toBe(true);
  if (!active) throw new Error('No multiplayer opening card was actionable.');
  const beforeRevision = (await latestRoomFrame(active.page))?.room?.revision || 0;
  const card = active.page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])').first();
  await card.focus();
  await active.page.keyboard.press('Enter');
  await expect.poll(async () => (await latestRoomFrame(active?.page as Page))?.room?.revision || 0).toBeGreaterThan(beforeRevision);
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

async function endpointThatHidesPlayer(page: Page, playerId: string) {
  return page.getByTestId('opponent-rail').evaluate((rail, expectedPlayerId) => {
    const element = rail as HTMLElement;
    const target = element.querySelector<HTMLElement>(`[data-player-id="${CSS.escape(expectedPlayerId)}"]`);
    if (!target) throw new Error(`Expected opponent ${expectedPlayerId} was absent from the rail.`);
    const maximum = element.scrollWidth - element.clientWidth;
    const targetLeft = target.offsetLeft;
    const targetRight = targetLeft + target.offsetWidth;
    const fullyVisibleAt = (left: number) => targetLeft >= left - 1 && targetRight <= left + element.clientWidth + 1;
    const candidates = [0, maximum].filter((left) => !fullyVisibleAt(left));
    if (!candidates.length) throw new Error(`Opponent ${expectedPlayerId} is fully visible at both rail endpoints.`);
    const targetCenter = targetLeft + target.offsetWidth / 2;
    return candidates.sort((left, right) =>
      Math.abs(right + element.clientWidth / 2 - targetCenter) - Math.abs(left + element.clientWidth / 2 - targetCenter)
    )[0];
  }, playerId);
}

async function wheelRailToEndpoint(
  page: Page,
  endpoint: number
): Promise<{ gesture: AuditedGesture; position: number; settledAt: number }> {
  const rail = page.getByTestId('opponent-rail');
  const initial = await railSnapshot(page);
  if (Math.abs(initial.scrollLeft - endpoint) <= 1) {
    const opposite = endpoint <= 1 ? initial.maximum : 0;
    await rail.hover();
    await page.mouse.wheel(opposite <= 1 ? -10_000 : 10_000, 0);
    await expect.poll(async () => Math.abs((await railSnapshot(page)).scrollLeft - opposite)).toBeLessThanOrEqual(1);
    const oppositeGesture = latestTrustedGesture(await getRailAudit(page), 'wheel');
    await waitForSettledRail(page, oppositeGesture);
  }
  await rail.hover();
  await page.mouse.wheel(endpoint <= 1 ? -10_000 : 10_000, 0);
  await expect.poll(async () => Math.abs((await railSnapshot(page)).scrollLeft - endpoint)).toBeLessThanOrEqual(1);
  const wheelGesture = latestTrustedGesture(await getRailAudit(page), 'wheel');
  const settled = await waitForSettledRail(page, wheelGesture);
  const pauseKey = endpoint <= 1 ? 'Home' : 'End';
  await rail.focus();
  await page.keyboard.press(pauseKey);
  const gesture = latestTrustedGesture(await getRailAudit(page), 'keydown', pauseKey);
  const position = (await railSnapshot(page)).scrollLeft;
  expect(Math.abs(position - endpoint)).toBeLessThanOrEqual(retainedPositionTolerance);
  return { gesture, position, settledAt: settled.at };
}

test('trusted wheel and keyboard gestures retain settled positions across real opening updates', async ({
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
    const cards = await openingCards(page);
    await installRailAudit(page);

    await rail.hover();
    await page.mouse.wheel(224, 0);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(100);
    const wheelGesture = latestTrustedGesture(await getRailAudit(page), 'wheel');
    const wheelSettle = await waitForSettledRail(page, wheelGesture);
    await activateOpeningCardImmediately(page);
    await expect(cards).toHaveCount(11);
    await expect.poll(async () => (await getRailAudit(page)).states.some((entry) => entry.openingCardCount === 11)).toBe(true);
    const wheelUpdate = (await getRailAudit(page)).states.find((entry) => entry.openingCardCount === 11);
    expect(wheelUpdate).toBeDefined();
    assertUpdateWithinPause(wheelGesture, wheelUpdate as AuditedRailSample, wheelSettle.scrollLeft);
    await expectRetainedThroughCheckpoint(
      page,
      wheelGesture,
      wheelUpdate as AuditedRailSample,
      wheelSettle.scrollLeft,
      wheelSettle.at
    );
    expect((await railSnapshot(page)).scrollSnapType).toBe('none');

    await rail.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(wheelSettle.scrollLeft + 1);
    const keyboardGesture = latestTrustedGesture(await getRailAudit(page), 'keydown', 'ArrowRight');
    const keyboardSettle = await waitForSettledRail(page, keyboardGesture);
    await activateOpeningCardImmediately(page);
    await expect.poll(async () => (await getRailAudit(page)).states.some((entry) => entry.currentPlayerId)).toBe(true);
    const keyboardUpdate = (await getRailAudit(page)).states.find(
      (entry) => entry.currentPlayerId && entry.epochMs >= keyboardGesture.epochMs
    );
    expect(keyboardUpdate).toBeDefined();
    assertUpdateWithinPause(keyboardGesture, keyboardUpdate as AuditedRailSample, keyboardSettle.scrollLeft);
    await expectRetainedThroughCheckpoint(
      page,
      keyboardGesture,
      keyboardUpdate as AuditedRailSample,
      keyboardSettle.scrollLeft,
      keyboardSettle.at
    );
  } finally {
    await context?.close();
  }
});

test('trusted touch retains its settled rail position across a real opening update', async ({
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
    await installRailAudit(page);
    session = await context.newCDPSession(page);
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await swipeOpponentRailByTouch(page, session);
    await expect.poll(async () => (await railSnapshot(page)).scrollLeft).toBeGreaterThan(100);
    const gesture = latestTrustedGesture(await getRailAudit(page), 'touchstart');
    const settled = await waitForSettledRail(page, gesture);
    await expectOpeningUpdateObservationBudget(page, gesture);
    const cards = await openingCards(page);
    await activateOpeningCardImmediately(page);
    await expect(cards).toHaveCount(11);
    await expect.poll(async () => (await getRailAudit(page)).states.some((entry) => entry.openingCardCount === 11)).toBe(true);
    const update = (await getRailAudit(page)).states.find((entry) => entry.openingCardCount === 11);
    expect(update).toBeDefined();
    expect(
      (update as AuditedRailSample).epochMs - gesture.epochMs,
      `The opening update must leave ${retainedObservationMs} ms before the final retained-position checkpoint.`
    ).toBeLessThanOrEqual(finalRetentionCheckpointMs - retainedObservationMs);
    assertUpdateWithinPause(gesture, update as AuditedRailSample, settled.scrollLeft);
    await expectRetainedThroughCheckpoint(page, gesture, update as AuditedRailSample, settled.scrollLeft, settled.at);
  } finally {
    await session?.detach();
    await context?.close();
  }
});

test('current-opponent follow resumes after the full gesture pause in a deterministic human room', async ({
  browser,
  skyjoServer
}, testInfo) => {
  test.setTimeout(45_000);
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  const clients: MultiplayerClient[] = [];
  try {
    clients.push(...await openMultiplayerClients(browser, skyjoServer.baseURL, skyjoServer.accessPassword, suffix));
    await clients[0].page.getByRole('button', { name: 'Create Room' }).click();
    await expect(clients[0].page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    const roomCode = await clients[0].page.locator('.skyjo-room-code').innerText();
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].page.getByLabel('Room code').fill(roomCode);
      await clients[index].page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(clients[index].page.locator('.skyjo-room-code')).toHaveText(roomCode);
    }
    await expect(clients[0].page.locator('.skyjo-room-roster li')).toHaveCount(4);
    await clients[0].page.getByRole('button', { name: 'Start Game' }).click();
    await Promise.all(
      clients.map((client) => expect(client.page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '4'))
    );
    for (let index = 0; index < 8; index += 1) await clickNextOpeningCard(clients);
    await Promise.all(
      clients.map((client) => expect(client.page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'opening-reveal'))
    );

    const active = await activeTurnClient(clients);
    const beforeTurn = await latestRoomFrame(active.page);
    const state = beforeTurn?.room?.state;
    if (!state) throw new Error('The active client had no authoritative room state.');
    const localPlayerId = beforeTurn?.playerId || await active.page.evaluate(() => localStorage.getItem('skyjo-player-id') || '');
    const activePlayerId = state.players[state.currentPlayerIndex]?.id;
    expect(activePlayerId).toBe(localPlayerId);
    const expectedNextPlayerId = state.players[(state.currentPlayerIndex + 1) % state.players.length]?.id;
    expect(expectedNextPlayerId).toBeTruthy();

    const deck = active.page.getByRole('button', { name: /^Deck/ }).filter({ visible: true });
    await deck.click();
    await expect(active.page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', 'choose-replacement');
    const replacement = active.page
      .getByRole('button', { name: /Replace with the drawn card/ })
      .filter({ visible: true })
      .first();
    await replacement.click({ trial: true });
    await installRailAudit(active.page);
    const hiddenEndpoint = await endpointThatHidesPlayer(active.page, expectedNextPlayerId);
    const retained = await wheelRailToEndpoint(active.page, hiddenEndpoint);
    const baseline = await railSnapshot(active.page);
    expect(baseline.currentPlayerId).toBe('');

    await replacement.focus();
    await active.page.keyboard.press('Enter');
    await expect.poll(async () => (await railSnapshot(active.page)).currentPlayerId).toBe(expectedNextPlayerId);
    await expect.poll(async () => {
      const frame = await latestRoomFrame(active.page);
      const nextState = frame?.room?.state;
      return nextState?.players[nextState.currentPlayerIndex]?.id || '';
    }).toBe(expectedNextPlayerId);

    const transition = (await getRailAudit(active.page)).states.find(
      (entry) => entry.currentPlayerId === expectedNextPlayerId && entry.epochMs >= retained.gesture.epochMs
    );
    expect(transition).toBeDefined();
    assertUpdateWithinPause(retained.gesture, transition as AuditedRailSample, retained.position);
    expect((transition as AuditedRailSample).currentFullyVisible).toBe(false);
    const preExpiryCheckpoint = await expectRetainedThroughCheckpoint(
      active.page,
      retained.gesture,
      transition as AuditedRailSample,
      retained.position,
      retained.settledAt
    );
    expect(preExpiryCheckpoint.currentPlayerId).toBe(expectedNextPlayerId);
    expect(preExpiryCheckpoint.currentFullyVisible).toBe(false);

    await expect.poll(async () => (await railSnapshot(active.page)).currentOpponentFullyVisible).toBe(true);
    const completedAudit = await getRailAudit(active.page);
    const preExpiryScrolls = completedAudit.scrolls.filter(
      (entry) => entry.at >= retained.settledAt && entry.epochMs < retained.gesture.epochMs + userScrollPauseMs
    );
    for (const sample of preExpiryScrolls) {
      expect(Math.abs(sample.scrollLeft - retained.position)).toBeLessThanOrEqual(retainedPositionTolerance);
    }
    const resumed = completedAudit.scrolls.find(
      (entry) => entry.currentPlayerId === expectedNextPlayerId && entry.currentFullyVisible
    );
    expect(resumed).toBeDefined();
    expect((resumed as AuditedRailSample).epochMs - retained.gesture.epochMs).toBeGreaterThanOrEqual(userScrollPauseMs);
    const finalState = (await latestRoomFrame(active.page))?.room?.state;
    expect(finalState?.players[finalState.currentPlayerIndex]?.id).toBe(expectedNextPlayerId);
  } finally {
    await Promise.all(clients.map((client) => client.context.close()));
  }
});
