import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserContext, Page } from '@playwright/test';
import {
  CERTIFICATION_LIMITS,
  CERTIFICATION_PERSONA_PROFILES,
  PERSONA_EVIDENCE_FORMAT_VERSION,
  validateEightClientPersonaEvidence,
  writeEightClientPersonaEvidence
} from '../../../scripts/certification-lib.mjs';
import {
  createPropagationArrivalTracker,
  summarizePropagationSamples,
  type PropagationProbe
} from '../../helpers/propagationArrival';
import { expect, test } from '../fixtures';

type PersonaFrame = {
  playerId?: string;
  protocolVersion?: number;
  revision?: number;
  room?: {
    chatMessages?: Array<{ text?: string }>;
    revision?: number;
    state?: null | {
      currentPlayerIndex: number;
      drawPile?: unknown;
      drawPileCount: number;
      drawnCard: null | { value: number | null };
      players: Array<{ id: string; grid: Array<{ faceUp: boolean; removed: boolean; value: number | null }> }>;
    };
  };
  type?: string;
};

type PersonaClient = {
  context: BrowserContext;
  index: number;
  page: Page;
  profile: string;
};

type PropagationTracker = ReturnType<typeof createPropagationArrivalTracker>;

const profiles = [
  { profile: 'desktop-keyboard', viewport: { width: 1440, height: 900 } },
  { profile: 'desktop-pointer', viewport: { width: 1280, height: 800 } },
  { profile: 'phone-touch', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { profile: 'phone-reduced-motion', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const },
  { profile: 'tablet-portrait', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
  { profile: 'tablet-landscape', viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true },
  { profile: 'text-200-keyboard', viewport: { width: 390, height: 844 } },
  { profile: 'background-reconnect', viewport: { width: 1024, height: 768 } }
];

function collectKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    output.add(key);
    collectKeys(item, output);
  }
  return output;
}

async function installFrameAudit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const frames: unknown[] = [];
    class PersonaWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            frames.push(JSON.parse(event.data));
          } catch {
            frames.push({ type: 'invalid-json' });
          }
        });
      }
    }
    Object.defineProperty(window, '__skyjoPersonaFrames', { configurable: true, value: frames });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: PersonaWebSocket });
  });
}

async function installPropagationSendRoute(
  context: BrowserContext,
  profile: string,
  tracker: PropagationTracker,
  runtimeFailures: string[]
): Promise<void> {
  await context.routeWebSocket(/\/rooms(?:\?.*)?$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((payload) => {
      const serialized = typeof payload === 'string' ? payload : payload.toString('utf8');
      try {
        tracker.recordSentFrame(JSON.parse(serialized), performance.now());
      } catch {
        runtimeFailures.push(`${profile}:invalid-sent-propagation-frame`);
        tracker.failAll(new Error('A sent propagation WebSocket frame was not valid JSON.'));
      }
      server.send(payload);
    });
  });
}

function installPropagationObserver(
  client: PersonaClient,
  tracker: PropagationTracker,
  runtimeFailures: string[]
): void {
  client.page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const serialized = typeof payload === 'string' ? payload : payload.toString('utf8');
      try {
        tracker.recordFrame(client.index, JSON.parse(serialized) as PersonaFrame, performance.now());
      } catch {
        runtimeFailures.push(`${client.profile}:invalid-propagation-frame`);
        tracker.failAll(new Error('A propagation WebSocket frame was not valid JSON.'));
      }
    });
  });
}

async function completePropagationProbe(
  probe: PropagationProbe,
  action: () => Promise<void>,
  label: string
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} did not send and reach all eight clients within five seconds.`)), 5_000);
  });
  try {
    const actionPromise = action();
    void actionPromise.catch(() => {});
    await Promise.race([actionPromise, timeoutPromise]);
    return await Promise.race([probe.promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    probe.cancel();
  }
}

async function commonRevision(tracker: PropagationTracker): Promise<number> {
  await expect.poll(() => tracker.commonRevision() ?? -1, { timeout: 5_000 }).toBeGreaterThanOrEqual(0);
  const revision = tracker.commonRevision();
  if (revision === null) throw new Error('Eight-client revision convergence was lost.');
  return revision;
}

async function authenticateClient(
  client: PersonaClient,
  baseURL: string,
  accessPassword: string,
  seat: number
): Promise<void> {
  const access = await client.context.request.post(`${baseURL}/login`, {
    form: { next: '/', password: accessPassword }
  });
  expect(access.ok()).toBe(true);
  const signup = await client.context.request.post(`${baseURL}/api/account/signup`, {
    data: {
      email: `persona-seat-${seat}@example.test`,
      displayName: `Cert Seat ${seat}`,
      password: 'persona-certification-password',
      confirmPassword: 'persona-certification-password'
    }
  });
  expect(signup.status()).toBe(201);
  await client.page.goto(`${baseURL}/lobby`);
  await expect(client.page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
  if (client.profile === 'text-200-keyboard') {
    await client.page.evaluate(() => document.documentElement.classList.add('skyjo-test-text-scale-200'));
  }
}

async function revealOpeningCard(
  client: PersonaClient,
  keyboard: boolean,
  tracker: PropagationTracker,
  expectedRevision: number
): Promise<number> {
  const actionable = () => client.page.locator('button[aria-label*="Reveal this opening card"]:visible:not([disabled])').first();
  await expect(actionable()).toBeVisible();
  if (keyboard) {
    await actionable().focus();
    return completePropagationProbe(
      tracker.beginRevision(expectedRevision, 'reveal-opening-card'),
      () => client.page.keyboard.press('Enter'),
      `Opening revision ${expectedRevision}`
    );
  }
  return completePropagationProbe(
    tracker.beginRevision(expectedRevision, 'reveal-opening-card'),
    () => actionable().click(),
    `Opening revision ${expectedRevision}`
  );
}

async function assertPrivacyRedaction(clients: PersonaClient[]): Promise<void> {
  for (const client of clients) {
    const frames = await client.page.evaluate(() => (
      window as typeof window & { __skyjoPersonaFrames?: PersonaFrame[] }
    ).__skyjoPersonaFrames || []);
    const snapshots = frames.filter((frame) => frame.type === 'snapshot' || frame.type === 'resync');
    expect(snapshots.length).toBeGreaterThan(0);
    for (const frame of snapshots) {
      expect(frame.protocolVersion).toBe(2);
      expect(frame.revision).toBe(frame.room?.revision);
      const keys = collectKeys(frame.room);
      for (const forbidden of ['clients', 'drawPile', 'gameSessionId', 'recentCommandIds', 'resetAliases', 'userId']) {
        expect(keys.has(forbidden), `${forbidden} leaked to ${client.profile}`).toBe(false);
      }
      const state = frame.room?.state;
      if (!state) continue;
      expect(Number.isSafeInteger(state.drawPileCount)).toBe(true);
      expect(state.drawPile).toBeUndefined();
      for (const player of state.players) {
        for (const card of player.grid) {
          if (!card.faceUp && !card.removed) expect(card.value).toBeNull();
        }
      }
      if (state.drawnCard?.value !== null && state.drawnCard?.value !== undefined) {
        expect(frame.playerId).toBe(state.players[state.currentPlayerIndex]?.id);
      }
    }
  }
}

async function completeMeasuredReplacementTurn(
  clients: PersonaClient[],
  tracker: PropagationTracker,
  startingRevision: number
): Promise<{ revision: number; samples: [number, number] }> {
  let active: PersonaClient | undefined;
  await expect.poll(async () => {
    for (const client of clients) {
      const deck = client.page.locator('button.skyjo-pile-button:visible:not([disabled])').filter({ hasText: 'Deck' });
      if (await deck.count()) {
        active = client;
        return true;
      }
    }
    return false;
  }).toBe(true);
  if (!active) throw new Error('No keyboard turn was available.');
  const activeClient = active;
  const deck = activeClient.page.locator('button.skyjo-pile-button:visible:not([disabled])').filter({ hasText: 'Deck' }).first();
  await deck.focus();
  const drawRevision = startingRevision + 1;
  const drawSample = await completePropagationProbe(
    tracker.beginRevision(drawRevision, 'draw-blind'),
    () => activeClient.page.keyboard.press('Enter'),
    `Blind-draw revision ${drawRevision}`
  );
  await expect(activeClient.page.getByTestId('shared-game-table')).toHaveAttribute('data-phase', 'choose-replacement');
  const replacement = activeClient.page
    .getByRole('button', { name: /Replace with the drawn card/ })
    .filter({ visible: true })
    .first();
  await expect(replacement).toBeEnabled();
  await replacement.focus();
  const replacementRevision = drawRevision + 1;
  const replacementSample = await completePropagationProbe(
    tracker.beginRevision(replacementRevision, 'replace-card'),
    () => activeClient.page.keyboard.press('Enter'),
    `Replacement revision ${replacementRevision}`
  );
  await expect(activeClient.page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'choose-replacement');
  return { revision: replacementRevision, samples: [drawSample, replacementSample] };
}

async function measureChatPropagation(
  client: PersonaClient,
  tracker: PropagationTracker,
  sampleCount: number
): Promise<number[]> {
  const toggle = client.page.getByRole('button', { name: /Table Chat/ }).first();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const input = client.page.getByRole('textbox', { name: 'Message', exact: true });
  const send = client.page.getByRole('button', { name: 'Send', exact: true });
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const marker = `cert-chat-${String(index + 1).padStart(2, '0')}`;
    await input.fill(marker);
    await expect(send).toBeEnabled();
    samples.push(await completePropagationProbe(
      tracker.beginChat(marker),
      () => send.click(),
      `Chat marker ${index + 1}`
    ));
  }
  return samples;
}

async function geometryAndTargetMetrics(clients: PersonaClient[]) {
  const samples = await Promise.all(clients.map(async (client) => client.page.getByTestId('shared-game-table').evaluate((table) => {
    const band = table.querySelector<HTMLElement>('[data-testid="table-center-band"]');
    const piles = table.querySelector<HTMLElement>('[data-testid="table-piles"]');
    const opponents = table.querySelector<HTMLElement>('[data-testid="opponent-rail"]');
    const local = table.querySelector<HTMLElement>('[data-testid="local-board"]');
    if (!band || !piles || !opponents || !local) throw new Error('Missing certification geometry anchor.');
    const tableRect = table.getBoundingClientRect();
    const bandRect = band.getBoundingClientRect();
    const pilesRect = piles.getBoundingClientRect();
    const opponentRect = opponents.getBoundingClientRect();
    const localRect = local.getBoundingClientRect();
    const tolerance = window.innerWidth <= 640 ? 8 : 16;
    const centered =
      Math.abs(pilesRect.left + pilesRect.width / 2 - (tableRect.left + tableRect.width / 2)) <= tolerance &&
      Math.abs(bandRect.top + bandRect.height / 2 - (tableRect.top + tableRect.height / 2)) <= tolerance &&
      opponentRect.bottom <= bandRect.top + 0.5 &&
      bandRect.bottom <= localRect.top + 0.5;
    const targets = Array.from(document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [role="button"]:not([aria-disabled="true"])'
    )).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    });
    const minimumTargetPx = targets.length
      ? Math.min(...targets.map((element) => {
          const rect = element.getBoundingClientRect();
          return Math.min(rect.width, rect.height);
        }))
      : 0;
    return {
      centered,
      minimumTargetPx: Math.floor(minimumTargetPx * 100) / 100,
      overflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
    };
  })));
  return {
    centered: samples.every((sample) => sample.centered),
    maxHorizontalOverflowPx: Math.max(...samples.map((sample) => sample.overflowPx)),
    minimumTargetPx: Math.min(...samples.map((sample) => sample.minimumTargetPx))
  };
}

test('eight independent clients cover the release persona matrix without state or layout divergence', async ({
  browser,
  skyjoServer
}) => {
  test.setTimeout(120_000);
  const sourceSha = String(process.env.SKYJO_RELEASE_SHA || '').trim().toLowerCase();
  expect(sourceSha).toMatch(/^[a-f0-9]{40}$/);
  const evidenceDestination = path.resolve(
    process.env.SKYJO_CERTIFICATION_PERSONA_EVIDENCE || 'test-results/certification/eight-client-personas.json'
  );
  const clients: PersonaClient[] = [];
  const runtimeFailures: string[] = [];
  const propagationTracker = createPropagationArrivalTracker(profiles.length);

  try {
    for (const profile of profiles) {
      const context = await browser.newContext({
        viewport: profile.viewport,
        hasTouch: profile.hasTouch,
        isMobile: profile.isMobile,
        reducedMotion: profile.reducedMotion
      });
      await installFrameAudit(context);
      await installPropagationSendRoute(context, profile.profile, propagationTracker, runtimeFailures);
      const page = await context.newPage();
      const client = { context, index: clients.length, page, profile: profile.profile };
      installPropagationObserver(client, propagationTracker, runtimeFailures);
      page.on('console', (message) => {
        if (message.type() === 'error') runtimeFailures.push(`${profile.profile}:console-error`);
      });
      page.on('pageerror', () => runtimeFailures.push(`${profile.profile}:page-error`));
      clients.push(client);
    }
    expect(clients.map((client) => client.profile)).toEqual(CERTIFICATION_PERSONA_PROFILES);
    for (let index = 0; index < clients.length; index += 1) {
      await authenticateClient(clients[index], skyjoServer.baseURL, skyjoServer.accessPassword, index + 1);
    }

    await clients[0].page.getByRole('button', { name: 'Create Room' }).click();
    await expect(clients[0].page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    const roomCode = await clients[0].page.locator('.skyjo-room-code').innerText();
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].page.getByLabel('Room code').fill(roomCode);
      await clients[index].page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(clients[index].page.locator('.skyjo-room-code')).toHaveText(roomCode);
    }
    await expect(clients[0].page.locator('.skyjo-room-roster li')).toHaveCount(8);
    await clients[0].page.getByRole('button', { name: 'Start Game' }).click();
    await Promise.all(clients.map((client) => expect(client.page.getByTestId('shared-game-table')).toHaveAttribute('data-player-count', '8')));

    let revision = await commonRevision(propagationTracker);
    const statePropagationMs: number[] = [];
    const openingOrder = [0, 1, 2, 3, 4, 5, 6, 7];
    let openingStartedAt = 0;
    let openingCommand = 0;
    for (const index of openingOrder) {
      for (let reveal = 0; reveal < 2; reveal += 1) {
        openingCommand += 1;
        revision += 1;
        if (openingCommand === CERTIFICATION_LIMITS.personaOpeningReveals) openingStartedAt = Date.now();
        statePropagationMs.push(await revealOpeningCard(
          clients[index],
          index === 0 || index === 6,
          propagationTracker,
          revision
        ));
      }
    }
    expect(openingCommand).toBe(CERTIFICATION_LIMITS.personaOpeningReveals);
    expect(await commonRevision(propagationTracker)).toBe(revision);
    const reducedMotionSettle = (async () => {
      await expect(clients[3].page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'opening-reveal');
      return Date.now() - openingStartedAt;
    })();
    await Promise.all([
      ...clients.map((client) => expect(client.page.getByTestId('shared-game-table')).not.toHaveAttribute('data-phase', 'opening-reveal')),
      reducedMotionSettle
    ]);
    const openingSettleMs = Date.now() - openingStartedAt;
    const reducedMotionSettleMs = await reducedMotionSettle;

    const turn = await completeMeasuredReplacementTurn(clients, propagationTracker, revision);
    revision = turn.revision;
    statePropagationMs.push(...turn.samples);
    expect(await commonRevision(propagationTracker)).toBe(revision);
    expect(statePropagationMs).toHaveLength(CERTIFICATION_LIMITS.personaStatePropagationSamples);
    const chatPropagationMs = await measureChatPropagation(
      clients[0],
      propagationTracker,
      CERTIFICATION_LIMITS.personaChatPropagationSamples
    );
    expect(propagationTracker.pendingCount()).toBe(0);
    propagationTracker.assertHealthy();
    const statePropagation = summarizePropagationSamples(
      statePropagationMs,
      CERTIFICATION_LIMITS.personaStatePropagationSamples
    );
    const chatPropagation = summarizePropagationSamples(
      chatPropagationMs,
      CERTIFICATION_LIMITS.personaChatPropagationSamples
    );
    const reconnectClient = clients[7];
    const originalPlayerId = await reconnectClient.page.evaluate(() => localStorage.getItem('skyjo-player-id'));
    const bannerStartedAt = Date.now();
    await reconnectClient.context.setOffline(true);
    await expect(reconnectClient.page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'offline', { timeout: 500 });
    const reconnectBannerMs = Date.now() - bannerStartedAt;
    const reconnectStartedAt = Date.now();
    await reconnectClient.context.setOffline(false);
    await expect(reconnectClient.page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected', { timeout: 10_000 });
    const reconnectRtoMs = Date.now() - reconnectStartedAt;
    expect(await reconnectClient.page.evaluate(() => localStorage.getItem('skyjo-player-id'))).toBe(originalPlayerId);
    await expect(reconnectClient.page.locator('.skyjo-room-code')).toHaveText(roomCode);

    await assertPrivacyRedaction(clients);
    const geometry = await geometryAndTargetMetrics(clients);
    expect(runtimeFailures).toEqual([]);
    propagationTracker.assertHealthy();

    const evidence = {
      formatVersion: PERSONA_EVIDENCE_FORMAT_VERSION,
      kind: 'skyjo-eight-client-persona',
      release: { version: '0.2.0', sourceSha, protocolVersion: 2 },
      topology: {
        rooms: 1,
        clients: 8,
        openingReveals: CERTIFICATION_LIMITS.personaOpeningReveals,
        statePropagationSamples: statePropagation.count,
        chatPropagationSamples: chatPropagation.count
      },
      profiles: [...CERTIFICATION_PERSONA_PROFILES],
      propagation: {
        chatMs: chatPropagationMs,
        stateMs: statePropagationMs
      },
      measurements: {
        chatPropagationP95Ms: chatPropagation.p95Ms,
        maxHorizontalOverflowPx: geometry.maxHorizontalOverflowPx,
        minimumTargetPx: geometry.minimumTargetPx,
        openingSettleMs,
        reconnectBannerMs,
        reconnectRtoMs,
        reducedMotionSettleMs,
        statePropagationP95Ms: statePropagation.p95Ms
      },
      gates: {
        browserPropagation:
          statePropagation.p95Ms <= CERTIFICATION_LIMITS.personaPropagationP95Ms &&
          chatPropagation.p95Ms <= CERTIFICATION_LIMITS.personaPropagationP95Ms,
        centeredTable: geometry.centered,
        keyboardComplete: true,
        privacyRedaction: true,
        sameSeatReconnect: true
      }
    };
    await writeEightClientPersonaEvidence(evidenceDestination, evidence, { requirePassed: false });
    validateEightClientPersonaEvidence(evidence);
  } finally {
    await Promise.all(clients.map((client) => client.context.close()));
  }
});
