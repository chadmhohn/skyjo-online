import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';

type WireAudit = {
  dropped: string[];
  inbound: string[];
  outbound: string[];
};

type PersistedRoom = {
  code: string;
  completedGameId: string | null;
  players: Array<{ id: string; userId?: string }>;
  state: null | {
    drawnCard: null | PersistedCard;
    drawPile: PersistedCard[];
    discardPile: PersistedCard[];
    players: Array<{ grid: PersistedCard[] }>;
  };
  revision: number;
  recentCommandIds: Array<{ commandId: string }>;
  resetAliases: Array<{ commandId: string; fromCode: string; playerId: string }>;
  status: 'finished' | 'playing' | 'waiting';
};

type PersistedCard = {
  faceUp: boolean;
  id: string;
  removed: boolean;
  value: number;
};

type PublicFrame = {
  commandId?: string;
  protocolVersion?: number;
  reason?: string;
  revision?: number;
  room?: {
    code: string;
    revision: number;
    state: null | {
      discardPile: { count: number; top: null | PublicCard };
      drawPileCount: number;
      drawnCard: null | PublicCard;
      hasDrawnCard: boolean;
      log: string[];
      players: Array<{ grid: PublicCard[] }>;
    };
  };
  type?: string;
};

type PublicCard = {
  faceUp: boolean;
  id: string;
  removed: boolean;
  value: number | null;
};

const RESET_RECOVERY_STORAGE_KEY = 'skyjo-reset-recovery';

async function installWireAudit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const audit = {
      dropped: [] as string[],
      inbound: [] as string[],
      outbound: [] as string[],
      resetCommandId: ''
    };

    class AuditedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        this.addEventListener(
          'message',
          (event) => {
            if (typeof event.data !== 'string') return;
            audit.inbound.push(event.data);
            if (!audit.resetCommandId) return;
            try {
              const frame = JSON.parse(event.data) as { commandId?: string; type?: string };
              if (
                frame.commandId === audit.resetCommandId &&
                (frame.type === 'resync' || frame.type === 'ack' || frame.type === 'error')
              ) {
                audit.dropped.push(event.data);
                event.stopImmediatePropagation();
              }
            } catch {
              // Non-JSON server data remains visible to the application and is asserted below.
            }
          },
          { capture: true }
        );
      }

      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === 'string') {
          audit.outbound.push(data);
          try {
            const frame = JSON.parse(data) as { action?: { type?: string }; commandId?: string };
            if (frame.action?.type === 'reset-room' && frame.commandId) {
              audit.resetCommandId = frame.commandId;
            }
          } catch {
            // The server rejects malformed frames; retaining the raw value is enough for the audit.
          }
        }
        super.send(data);
      }
    }

    Object.defineProperties(window, {
      __skyjoNativeWebSocket: { configurable: true, value: NativeWebSocket },
      __skyjoWireAudit: { configurable: true, value: audit },
      WebSocket: { configurable: true, value: AuditedWebSocket }
    });
  });
}

async function createAccount(page: Page, baseURL: string, email: string, displayName: string): Promise<void> {
  await page.goto(`${baseURL}/account?next=/lobby`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Password', { exact: true }).fill('authoritative-secret-123');
  await page.getByLabel('Confirm password').fill('authoritative-secret-123');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: 'Multiplayer Lobby' })).toBeVisible();
}

async function createAuthenticatedContext(
  browserContext: BrowserContext,
  baseURL: string,
  accessPassword: string
): Promise<void> {
  const response = await browserContext.request.post(`${baseURL}/login`, {
    form: { next: '/', password: accessPassword }
  });
  expect(response.ok()).toBe(true);
}

async function getAudit(page: Page): Promise<WireAudit> {
  return page.evaluate(() => {
    const audit = (window as unknown as { __skyjoWireAudit: WireAudit }).__skyjoWireAudit;
    return {
      dropped: [...audit.dropped],
      inbound: [...audit.inbound],
      outbound: [...audit.outbound]
    };
  });
}

function parsedFrames(values: string[]): PublicFrame[] {
  return values.flatMap((value) => {
    try {
      return [JSON.parse(value) as PublicFrame];
    } catch {
      return [];
    }
  });
}

function latestRoomFrame(audit: WireAudit): PublicFrame {
  const frame = parsedFrames(audit.inbound)
    .filter((candidate) => (candidate.type === 'snapshot' || candidate.type === 'resync') && candidate.room)
    .at(-1);
  if (!frame) throw new Error('No synchronized room frame was captured.');
  return frame;
}

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

function assertPublicRoomFrames(audit: WireAudit): void {
  const frames = parsedFrames(audit.inbound).filter(
    (frame) => (frame.type === 'snapshot' || frame.type === 'resync') && frame.room
  );
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.protocolVersion).toBe(2);
    const keys = collectKeys(frame.room);
    for (const privateKey of [
      'clients',
      'drawPile',
      'gameSessionId',
      'recentCommandIds',
      'resetAliases',
      'userId'
    ]) {
      expect(keys.has(privateKey), `${privateKey} leaked in a public room frame`).toBe(false);
    }
    const state = frame.room?.state;
    if (!state) continue;
    expect(Number.isSafeInteger(state.drawPileCount)).toBe(true);
    for (const [playerIndex, player] of state.players.entries()) {
      for (const [cardIndex, card] of player.grid.entries()) {
        expect(card.id).toBe(`grid-${playerIndex}-${cardIndex}`);
        if (!card.faceUp && !card.removed) expect(card.value).toBeNull();
      }
    }
    expect(state.log.some((entry) => / drew a -?\d+\.$/.test(entry))).toBe(false);
  }
}

function assertAuthoritativeOutbound(audit: WireAudit): void {
  const frames = parsedFrames(audit.outbound);
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.type).not.toBe('update-state');
    expect(collectKeys(frame).has('state')).toBe(false);
    if (frame.type === 'command' || frame.type === 'create-room' || frame.type === 'join-room') {
      expect(frame.protocolVersion).toBe(2);
    }
  }
}

async function clickNextOpeningCard(pages: Page[]): Promise<void> {
  const enabledSelector = 'button[aria-label$="face-down. Reveal this opening card."]:visible:not([disabled])';
  await expect
    .poll(async () => {
      const counts = await Promise.all(pages.map((page) => page.locator(enabledSelector).count()));
      return counts.reduce((total, count) => total + count, 0);
    })
    .toBeGreaterThan(0);
  for (const page of pages) {
    const card = page.locator(enabledSelector).first();
    if ((await card.count()) > 0) {
      await card.click();
      return;
    }
  }
  throw new Error('No player had an enabled opening card.');
}

async function pageWithEnabledDeck(pages: Page[]): Promise<Page> {
  const enabledDeck = (page: Page) =>
    page.locator('button.skyjo-pile-button:visible:not([disabled])').filter({ hasText: 'Deck' }).first();
  await expect
    .poll(async () => {
      const counts = await Promise.all(pages.map((page) => enabledDeck(page).count()));
      return counts.reduce((total, count) => total + count, 0);
    })
    .toBe(1);
  const page = (await enabledDeck(pages[0]).count()) > 0 ? pages[0] : pages[1];
  await enabledDeck(page).click();
  return page;
}

async function readRooms(dataDir: string): Promise<PersistedRoom[]> {
  const value = JSON.parse(await fs.readFile(path.join(dataDir, 'rooms.json'), 'utf8')) as {
    rooms?: PersistedRoom[];
  };
  return value.rooms || [];
}

async function waitForPersistedRoom(
  dataDir: string,
  predicate: (room: PersistedRoom) => boolean
): Promise<PersistedRoom> {
  let match: PersistedRoom | undefined;
  await expect
    .poll(
      async () => {
        try {
          match = (await readRooms(dataDir)).find(predicate);
          return Boolean(match);
        } catch {
          return false;
        }
      },
      { timeout: 7_500 }
    )
    .toBe(true);
  if (!match) throw new Error('The expected room was not persisted.');
  return match;
}

async function browserEvidence(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const storageEntries = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) || '';
        return [key, storage.getItem(key)];
      });
    const cacheEntries: Array<{ body: string; url: string }> = [];
    if ('caches' in window) {
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          cacheEntries.push({ body: response ? await response.clone().text() : '', url: request.url });
        }
      }
    }
    const databaseEntries: Array<{ database: string; records: unknown[]; store: string }> = [];
    if (typeof indexedDB.databases === 'function') {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        try {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(info.name as string);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
          });
          for (const store of Array.from(database.objectStoreNames)) {
            const records = await new Promise<unknown[]>((resolve, reject) => {
              const request = database.transaction(store, 'readonly').objectStore(store).getAll();
              request.onerror = () => reject(request.error);
              request.onsuccess = () => resolve(request.result);
            });
            databaseEntries.push({ database: info.name, records, store });
          }
          database.close();
        } catch {
          databaseEntries.push({ database: info.name, records: ['unreadable'], store: '' });
        }
      }
    }
    return JSON.stringify({
      cacheEntries,
      databaseEntries,
      html: document.documentElement.outerHTML,
      localStorage: storageEntries(localStorage),
      sessionStorage: storageEntries(sessionStorage)
    });
  });
}

async function sendLegacyFrameFromSameSeat(
  page: Page,
  input: { code: string; name: string; playerId: string }
): Promise<PublicFrame[]> {
  return page.evaluate(async ({ code, name, playerId }) => {
    const NativeWebSocket = (
      window as unknown as { __skyjoNativeWebSocket: typeof WebSocket }
    ).__skyjoNativeWebSocket;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new NativeWebSocket(`${protocol}//${window.location.host}/rooms`);
    const frames: PublicFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      let legacySent = false;
      const timeout = window.setTimeout(() => reject(new Error('Legacy frame test timed out.')), 7_500);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'join-room', protocolVersion: 2, code, name, playerId }));
      });
      socket.addEventListener('error', () => reject(new Error('Legacy frame socket failed.')));
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data) as PublicFrame;
        frames.push(frame);
        if (!legacySent && (frame.type === 'snapshot' || frame.type === 'resync')) {
          legacySent = true;
          socket.send(
            JSON.stringify({
              type: 'update-state',
              state: { forgedSentinel: 'FORGED_WHOLE_STATE_SENTINEL' }
            })
          );
          return;
        }
        if (frame.type === 'upgrade-required') {
          window.setTimeout(() => {
            window.clearTimeout(timeout);
            socket.close();
            resolve();
          }, 100);
        }
      });
    });
    return frames;
  }, input);
}

test('protocol v2 keeps private multiplayer state out of wire frames, DOM, storage, cache, and logs', async ({
  browser,
  page,
  skyjoServer
}, testInfo) => {
  test.setTimeout(60_000);
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  const hostConsole: string[] = [];
  const guestConsole: string[] = [];
  page.on('console', (message) => hostConsole.push(message.text()));
  await installWireAudit(page);
  await createAccount(page, skyjoServer.baseURL, `wire-host-${suffix}@example.test`, 'Wire Host');
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  const roomCode = await page.locator('.skyjo-room-code').innerText();
  const hostPlayerId = await page.evaluate(() => localStorage.getItem('skyjo-player-id') || '');

  const guestContext = await browser.newContext();
  try {
    await createAuthenticatedContext(guestContext, skyjoServer.baseURL, skyjoServer.accessPassword);
    const guestPage = await guestContext.newPage();
    guestPage.on('console', (message) => guestConsole.push(message.text()));
    await installWireAudit(guestPage);
    await createAccount(guestPage, skyjoServer.baseURL, `wire-guest-${suffix}@example.test`, 'Wire Guest');
    await guestPage.getByLabel('Room code').fill(roomCode);
    await guestPage.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(guestPage.locator('.skyjo-room-code')).toHaveText(roomCode);
    await expect(page.locator('.skyjo-room-roster')).toContainText('Wire Guest');
    const guestPlayerId = await guestPage.evaluate(() => localStorage.getItem('skyjo-player-id') || '');

    await page.getByRole('button', { name: 'Start Game' }).click();
    for (let index = 0; index < 4; index += 1) await clickNextOpeningCard([page, guestPage]);
    const drawerPage = await pageWithEnabledDeck([page, guestPage]);
    const opponentPage = drawerPage === page ? guestPage : page;
    await expect(opponentPage.locator('.skyjo-drawn-decision:visible')).toHaveCount(0);
    await expect.poll(async () => latestRoomFrame(await getAudit(opponentPage)).room?.state?.hasDrawnCard).toBe(true);

    const persisted = await waitForPersistedRoom(
      skyjoServer.dataDir,
      (room) => room.code === roomCode && Boolean(room.state?.drawnCard)
    );
    if (!persisted.state?.drawnCard) throw new Error('Persisted blind draw was missing.');
    const privateCardIds = [
      ...persisted.state.players.flatMap((player) => player.grid.map((card) => card.id)),
      ...persisted.state.drawPile.map((card) => card.id),
      ...persisted.state.discardPile.map((card) => card.id),
      persisted.state.drawnCard.id
    ];
    expect(privateCardIds).toHaveLength(150);
    expect(new Set(privateCardIds).size).toBe(150);

    const hostAudit = await getAudit(page);
    const guestAudit = await getAudit(guestPage);
    assertPublicRoomFrames(hostAudit);
    assertPublicRoomFrames(guestAudit);
    assertAuthoritativeOutbound(hostAudit);
    assertAuthoritativeOutbound(guestAudit);

    const drawerFrame = latestRoomFrame(await getAudit(drawerPage));
    const opponentFrame = latestRoomFrame(await getAudit(opponentPage));
    expect(drawerFrame.room?.state?.drawnCard?.value).toBe(persisted.state.drawnCard.value);
    expect(opponentFrame.room?.state).toMatchObject({ drawnCard: null, hasDrawnCard: true });
    const privateHiddenCoordinates = persisted.state.players.flatMap((player, playerIndex) =>
      player.grid.flatMap((card, cardIndex) =>
        !card.faceUp && !card.removed ? [{ cardIndex, playerIndex }] : []
      )
    );
    expect(privateHiddenCoordinates.length).toBeGreaterThan(0);
    for (const frame of [drawerFrame, opponentFrame]) {
      for (const { cardIndex, playerIndex } of privateHiddenCoordinates) {
        expect(frame.room?.state?.players[playerIndex].grid[cardIndex]).toMatchObject({
          faceUp: false,
          removed: false,
          value: null
        });
      }
    }

    const hostEvidence = JSON.stringify({
      audit: hostAudit,
      browser: await browserEvidence(page),
      console: hostConsole
    });
    const guestEvidence = JSON.stringify({
      audit: guestAudit,
      browser: await browserEvidence(guestPage),
      console: guestConsole
    });
    for (const privateCardId of privateCardIds) {
      expect(hostEvidence).not.toContain(privateCardId);
      expect(guestEvidence).not.toContain(privateCardId);
    }
    const hostUserId = persisted.players.find((player) => player.id === hostPlayerId)?.userId;
    const guestUserId = persisted.players.find((player) => player.id === guestPlayerId)?.userId;
    if (guestUserId) expect(hostEvidence).not.toContain(guestUserId);
    if (hostUserId) expect(guestEvidence).not.toContain(hostUserId);

    const beforeLegacyRevision = latestRoomFrame(await getAudit(page)).room?.revision;
    const legacyFrames = await sendLegacyFrameFromSameSeat(page, {
      code: roomCode,
      name: 'Wire Host',
      playerId: hostPlayerId
    });
    expect(legacyFrames.filter((frame) => frame.type === 'upgrade-required')).toHaveLength(1);
    expect(legacyFrames.some((frame) => frame.type === 'ack')).toBe(false);
    await expect.poll(async () => latestRoomFrame(await getAudit(page)).room?.revision).toBe(beforeLegacyRevision);
    const afterLegacy = await waitForPersistedRoom(skyjoServer.dataDir, (room) => room.code === roomCode);
    expect(afterLegacy.revision).toBe(beforeLegacyRevision);
    expect(afterLegacy.state).toEqual(persisted.state);
    expect(afterLegacy.recentCommandIds).toEqual(persisted.recentCommandIds);
    expect(afterLegacy.status).toBe(persisted.status);
    expect(afterLegacy.completedGameId).toBe(persisted.completedGameId);
    expect(JSON.stringify(afterLegacy)).not.toContain('FORGED_WHOLE_STATE_SENTINEL');
  } finally {
    await guestContext.close();
  }
});

test('a reset survives dropped resync and ack frames, then recovers the same seat after a hard reload', async ({
  page,
  skyjoServer
}, testInfo) => {
  test.setTimeout(45_000);
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
  await installWireAudit(page);
  await createAccount(page, skyjoServer.baseURL, `reset-host-${suffix}@example.test`, 'Reset Host');
  await page.getByRole('button', { name: 'Create Room' }).click();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  const oldCode = await page.locator('.skyjo-room-code').innerText();
  const playerId = await page.evaluate(() => localStorage.getItem('skyjo-player-id') || '');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset Room' }).click();
  let recoveryHint = '';
  await expect
    .poll(async () => {
      recoveryHint = await page.evaluate((key) => localStorage.getItem(key) || '', RESET_RECOVERY_STORAGE_KEY);
      return recoveryHint;
    })
    .not.toBe('');
  const parsedHint = JSON.parse(recoveryHint) as {
    commandId: string;
    expectedRevision: number;
    fromCode: string;
    playerId: string;
  };
  expect(parsedHint).toMatchObject({ expectedRevision: 0, fromCode: oldCode, playerId });

  const resetRoom = await waitForPersistedRoom(
    skyjoServer.dataDir,
    (room) =>
      room.code !== oldCode &&
      room.resetAliases.some(
        (alias) =>
          alias.fromCode === oldCode && alias.commandId === parsedHint.commandId && alias.playerId === playerId
      )
  );
  expect(resetRoom.revision).toBe(1);
  await expect(page.locator('.skyjo-room-code')).toHaveText(oldCode);
  const beforeReloadAudit = await getAudit(page);
  expect(parsedFrames(beforeReloadAudit.dropped).map((frame) => frame.type).sort()).toEqual(['ack', 'resync']);

  await page.reload();
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  await expect(page.locator('.skyjo-room-code')).toHaveText(resetRoom.code);
  expect(await page.evaluate(() => localStorage.getItem('skyjo-player-id'))).toBe(playerId);
  expect(await page.evaluate((key) => localStorage.getItem(key), RESET_RECOVERY_STORAGE_KEY)).toBeNull();

  const afterReloadAudit = await getAudit(page);
  const recoveryFrame = parsedFrames(afterReloadAudit.inbound).find(
    (frame) => frame.type === 'resync' && frame.reason === 'room-reset'
  );
  expect(recoveryFrame).toMatchObject({
    commandId: parsedHint.commandId,
    protocolVersion: 2,
    reason: 'room-reset',
    revision: 1,
    room: { code: resetRoom.code, revision: 1 },
    type: 'resync'
  });
  const outbound = parsedFrames(afterReloadAudit.outbound);
  expect(outbound).toContainEqual(
    expect.objectContaining({
      code: oldCode,
      playerId,
      protocolVersion: 2,
      recoveryCommandId: parsedHint.commandId,
      type: 'join-room'
    })
  );
  expect(outbound.some((frame) => frame.type === 'command' && JSON.stringify(frame).includes('reset-room'))).toBe(false);

  const persistedAfterRecovery = await waitForPersistedRoom(
    skyjoServer.dataDir,
    (room) => room.code === resetRoom.code
  );
  expect(persistedAfterRecovery.revision).toBe(1);
  expect(
    persistedAfterRecovery.recentCommandIds.filter((receipt) => receipt.commandId === parsedHint.commandId)
  ).toHaveLength(1);
});
