import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOMS_FILE,
  MAX_PERSISTED_COMMAND_RECEIPTS,
  MAX_PERSISTED_IDENTIFIER_LENGTH,
  MAX_PERSISTED_RESET_ALIASES,
  ROOMS_FILE_FORMAT,
  ROOMS_FILE_VERSION,
  ROOMS_PROTOCOL_VERSION,
  SUPPORTED_ROOMS_PROTOCOL_VERSIONS,
  ROOM_STALE_MS,
  RoomPersistenceFormatError,
  atomicWriteJson,
  isUnsupportedDirectorySyncError,
  loadRoomsFromDisk,
  loadRoomsSnapshotFromDisk,
  normalizeRoomsDocument,
  parseRoomsDocument,
  reconcileCompletedRoomJournals,
  resolveRoomsFilePath,
  saveRoomsToDisk,
  serializeRooms
} from '../../../server-room-persistence.mjs';
import { createAccountStore } from '../../../server-account-store.mjs';
import { createPersistenceHealthTracker } from '../../../server-persistence-health.mjs';
import {
  createMultiplayerGame,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from '../../../src/game';
import { createRoomSnapshot } from '../../../src/protocolV2';
import { isMultiplayerRoomSnapshot } from '../../../src/roomConnection';
import { createSeededRandom } from '../../../src/runtime';
import type { GameState } from '../../../src/types';

const fixedNow = Date.parse('2026-07-11T12:00:00Z');
const resetActionDigest = createHash('sha256').update(JSON.stringify({ type: 'reset-room' })).digest('hex');
const resetCommandId = '10000000-0000-4000-8000-000000000001';

function ordinaryCommandReceipt(index: number) {
  const revision = index + 2;
  return {
    commandId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    playerId: 'host-1',
    expectedRevision: revision - 1,
    revision,
    actionDigest: 'b'.repeat(64)
  };
}

function room(updatedAt = fixedNow, code = 'ABCDE') {
  return {
    code,
    hostId: 'host-1',
    players: [
      { id: 'host-1', userId: 'user-1', name: 'Ada', connected: true, host: true },
      { id: 'player-2', userId: 'user-2', name: 'Grace', connected: true, host: false }
    ],
    chatMessages: [
      {
        id: 'chat-1',
        playerId: 'host-1',
        playerName: 'Ada',
        text: 'Ready for the next round?',
        createdAt: fixedNow
      }
    ],
    readyForNextRoundPlayerIds: [] as string[],
    state: null as GameState | null,
    status: 'waiting' as 'waiting' | 'playing' | 'finished',
    updatedAt,
    completedGameId: 'game-1' as string | null,
    gameSessionId: 'session-1' as string | null,
    revision: 0,
    recentCommandIds: [] as Array<{
      commandId: string;
      playerId: string;
      expectedRevision: number;
      revision: number;
      actionDigest: string;
    }>,
    resetAliases: [] as Array<{ fromCode: string; commandId: string; playerId: string; expiresAt: number }>,
    clients: new Set([{ readyState: 1 }])
  };
}

function gameRoster() {
  return [
    { id: 'host-1', name: 'Ada' },
    { id: 'player-2', name: 'Grace' }
  ];
}

function finishOpening(initial: GameState): GameState {
  let state = initial;
  while (state.phase === 'opening-reveal') {
    const player = state.players[state.currentPlayerIndex];
    const cardIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (cardIndex < 0) throw new Error('Fixture could not find an opening card.');
    state = revealOpeningCard(state, cardIndex);
  }
  return state;
}

function activeBlindDrawState(): GameState {
  const opened = finishOpening(createMultiplayerGame(gameRoster(), 1, null, createSeededRandom(0x51a7e)));
  const state = drawBlind(opened, createSeededRandom(0xb11d));
  if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
    throw new Error('Fixture did not produce an active blind draw.');
  }
  return state;
}

function completedState(gameOver: boolean): GameState {
  const seed = gameOver ? 1 : 0x600d;
  const opened = finishOpening(createMultiplayerGame(gameRoster(), 1, null, createSeededRandom(seed)));
  const activeIndex = opened.currentPlayerIndex;
  const closerIndex = (activeIndex + 1) % opened.players.length;
  const blindDraw = drawBlind(opened, createSeededRandom(gameOver ? 0xabc : 0xf1a1));
  const finalTurn = {
    ...blindDraw,
    roundCloserId: blindDraw.players[closerIndex].id,
    finalTurnPlayerIds: [blindDraw.players[activeIndex].id]
  };
  const cardIndex = finalTurn.players[activeIndex].grid.findIndex((card) => !card.removed);
  const completed = replaceCard(finalTurn, cardIndex);
  const expectedPhase = gameOver ? 'game-over' : 'round-over';
  if (completed.phase !== expectedPhase) {
    throw new Error(`Fixture produced ${completed.phase}, expected ${expectedPhase}.`);
  }
  return completed;
}

function roomWithState(state: GameState, status: 'playing' | 'finished' = 'playing') {
  const value = room();
  value.state = state;
  value.status = status;
  return value;
}

function roomWithResetAlias(updatedAt = fixedNow, code = 'FGHIJ', fromCode = 'ABCDE') {
  const value = room(updatedAt, code);
  value.revision = 1;
  value.recentCommandIds = [{
    commandId: resetCommandId,
    playerId: 'host-1',
    expectedRevision: 0,
    revision: 1,
    actionDigest: resetActionDigest
  }];
  value.resetAliases = [{
    fromCode,
    commandId: resetCommandId,
    playerId: 'host-1',
    expiresAt: fixedNow + 60_000
  }];
  return value;
}

describe('room persistence', () => {
  let tempDir = '';
  let roomsFile = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-room-test-'));
    roomsFile = path.join(tempDir, 'rooms.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves production paths without sharing state between tests', () => {
    expect(resolveRoomsFilePath({})).toBe(path.resolve(DEFAULT_ROOMS_FILE));
    expect(resolveRoomsFilePath({ SKYJO_ROOMS_FILE: roomsFile })).toBe(roomsFile);
  });

  it('uses one explicit runtime-readable protocol compatibility set', () => {
    expect(SUPPORTED_ROOMS_PROTOCOL_VERSIONS).toContain(ROOMS_PROTOCOL_VERSION);
    expect(new Set(SUPPORTED_ROOMS_PROTOCOL_VERSIONS).size).toBe(SUPPORTED_ROOMS_PROTOCOL_VERSIONS.length);
    expect(SUPPORTED_ROOMS_PROTOCOL_VERSIONS.every((version: number) => Number.isSafeInteger(version) && version > 0)).toBe(true);
  });

  it('writes the v2 envelope and atomically restores socket-free rooms offline', async () => {
    const value = room();
    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow + 1);
    expect(serialized).toEqual(expect.objectContaining({
      format: ROOMS_FILE_FORMAT,
      version: ROOMS_FILE_VERSION,
      protocolVersion: ROOMS_PROTOCOL_VERSION,
      savedAt: fixedNow + 1
    }));
    expect(Object.keys(serialized)).toEqual(['format', 'version', 'protocolVersion', 'savedAt', 'rooms']);
    expect(serialized.rooms[0]).not.toHaveProperty('clients');
    expect(serialized.rooms[0].readyForNextRoundPlayerIds).toEqual([]);

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const saved = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
    expect(saved).toEqual(expect.objectContaining({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: 1
    }));
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const snapshot = await loadRoomsSnapshotFromDisk(roomsFile, {
      now: fixedNow + 1000,
      staleMs: ROOM_STALE_MS
    });
    expect(snapshot).toEqual(expect.objectContaining({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: 1,
      legacy: true,
      missing: false
    }));
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0].clients.size).toBe(0);
    expect(snapshot.rooms[0].players.every((player: { connected: boolean }) => !player.connected)).toBe(true);
    expect(snapshot.rooms[0]).toMatchObject({
      code: 'ABCDE',
      completedGameId: 'game-1',
      gameSessionId: 'session-1'
    });

    const compatibleRooms = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1000 });
    expect(compatibleRooms.map((restoredRoom: { code: string }) => restoredRoom.code)).toEqual(['ABCDE']);
  });

  it.each([
    ['active blind draw', () => activeBlindDrawState(), 'playing' as const],
    ['round over', () => completedState(false), 'playing' as const],
    ['game over', () => completedState(true), 'finished' as const]
  ])('round-trips a strict v0.1.1 %s state', async (_label, createState, status) => {
    const state = createState();
    const value = roomWithState(state, status);
    if (state.phase === 'round-over') value.readyForNextRoundPlayerIds = ['host-1'];

    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow);
    expect(serialized.rooms[0].state).toEqual(state);
    expect(serialized.rooms[0].state).not.toBe(state);

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const restored = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1 });

    expect(restored[0].state).toEqual(state);
    expect(restored[0].state).not.toBe(state);
    expect(restored[0].status).toBe(status);
    expect(restored[0].readyForNextRoundPlayerIds).toEqual(value.readyForNextRoundPlayerIds);
  });

  it('deterministically backfills missing active session ids without assigning one to waiting rooms', () => {
    const active = roomWithState(activeBlindDrawState(), 'playing');
    const missingSession = serializeRooms(new Map([[active.code, active]]), fixedNow);
    delete (missingSession.rooms[0] as { gameSessionId?: unknown }).gameSessionId;
    for (const persistedPlayer of missingSession.rooms[0].players) {
      delete (persistedPlayer as { joinedAt?: unknown }).joinedAt;
    }

    const first = normalizeRoomsDocument(structuredClone(missingSession), { now: fixedNow + 1, pruneStale: false });
    const second = normalizeRoomsDocument(structuredClone(missingSession), { now: fixedNow + 1, pruneStale: false });
    const changedRuntimeState = structuredClone(missingSession);
    changedRuntimeState.rooms[0].updatedAt += 1;
    changedRuntimeState.rooms[0].status = 'finished';
    changedRuntimeState.rooms[0].state = completedState(true);
    const changedRuntime = normalizeRoomsDocument(changedRuntimeState, { now: fixedNow + 1, pruneStale: false });
    const changedIdentity = structuredClone(missingSession);
    changedIdentity.rooms[0].players[1].userId = 'different-account';
    const changedRoom = normalizeRoomsDocument(changedIdentity, { now: fixedNow + 1, pruneStale: false });

    expect(first.legacy).toBe(true);
    expect(first.rooms[0].gameSessionId).toMatch(/^legacy-[a-f0-9]{64}$/);
    expect(first.rooms[0].gameSessionId).toHaveLength('legacy-'.length + 64);
    expect(first.rooms[0].gameSessionId).toBe(second.rooms[0].gameSessionId);
    expect(changedRuntime.rooms[0].gameSessionId).toBe(first.rooms[0].gameSessionId);
    expect(changedRoom.rooms[0].gameSessionId).not.toBe(first.rooms[0].gameSessionId);

    const finished = roomWithState(completedState(true), 'finished');
    const missingFinishedSession = serializeRooms(new Map([[finished.code, finished]]), fixedNow);
    delete (missingFinishedSession.rooms[0] as { gameSessionId?: unknown }).gameSessionId;
    const normalizedFinished = normalizeRoomsDocument(missingFinishedSession, { now: fixedNow + 1, pruneStale: false });
    expect(normalizedFinished.legacy).toBe(true);
    expect(normalizedFinished.rooms[0].gameSessionId).toBe(first.rooms[0].gameSessionId);

    const waiting = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    delete (waiting.rooms[0] as { gameSessionId?: unknown }).gameSessionId;
    const normalizedWaiting = normalizeRoomsDocument(waiting, { now: fixedNow + 1, pruneStale: false });
    expect(normalizedWaiting.legacy).toBe(true);
    expect(normalizedWaiting.rooms[0].gameSessionId).toBeNull();
  });

  it('marks a backfilled session for rewrite and restores it as current persistence', async () => {
    const active = roomWithState(activeBlindDrawState(), 'playing');
    const missingSession = serializeRooms(new Map([[active.code, active]]), fixedNow);
    delete (missingSession.rooms[0] as { gameSessionId?: unknown }).gameSessionId;
    await fs.writeFile(roomsFile, JSON.stringify(missingSession), 'utf8');

    const backfilled = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow + 1 });
    const gameSessionId = backfilled.rooms[0].gameSessionId;
    expect(backfilled).toMatchObject({ legacy: true, missing: false });
    expect(gameSessionId).toMatch(/^legacy-[a-f0-9]{64}$/);

    const restoredRoomMap = new Map(
      backfilled.rooms.map((restoredRoom: { code: string }) => [restoredRoom.code, restoredRoom])
    );
    await saveRoomsToDisk(restoredRoomMap, roomsFile);
    const rewritten = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
    expect(rewritten.rooms[0].gameSessionId).toBe(gameSessionId);

    const current = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow + 2 });
    expect(current).toMatchObject({ legacy: false, missing: false });
    expect(current.rooms[0].gameSessionId).toBe(gameSessionId);
  });

  it('recovers an exact SQLite terminal journal before accepting a stale pre-final room', async () => {
    const active = roomWithState(activeBlindDrawState(), 'playing');
    active.completedGameId = null;
    active.gameSessionId = 'crash-session';
    active.revision = 12;
    const preFinalDocument = serializeRooms(new Map([[active.code, active]]), fixedNow);
    const terminalState = completedState(true);
    const store = await createAccountStore({
      filePath: path.join(tempDir, 'completion-journal.sqlite'),
      now: () => fixedNow + 100
    });

    try {
      const game = store.recordCompletedGame({
        mode: 'multi',
        state: terminalState,
        roomCode: active.code,
        playerAccounts: {},
        sourceKey: 'multi:crash-session'
      });
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM games').get().count).toBe(1);

      const restored = normalizeRoomsDocument(preFinalDocument, {
        now: fixedNow + 101,
        pruneStale: false
      }).rooms[0];
      const restoredRooms = new Map([[restored.code, restored]]);
      const reconciled = reconcileCompletedRoomJournals(
        restoredRooms,
        (sourceKey: string) => store.getCompletedGameJournalBySourceKey(sourceKey)
      );

      expect(reconciled).toBe(1);
      expect(restored).toMatchObject({
        completedGameId: game.id,
        gameSessionId: 'crash-session',
        readyForNextRoundPlayerIds: [],
        revision: 13,
        status: 'finished',
        updatedAt: fixedNow + 100
      });
      expect(restored.state).toEqual(terminalState);
      expect(reconcileCompletedRoomJournals(
        restoredRooms,
        (sourceKey: string) => store.getCompletedGameJournalBySourceKey(sourceKey)
      )).toBe(0);
      expect(restored.revision).toBe(13);

      await saveRoomsToDisk(restoredRooms, roomsFile);
      const afterRestart = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow + 101 });
      expect(afterRestart.rooms[0]).toMatchObject({
        completedGameId: game.id,
        revision: 13,
        status: 'finished'
      });
      expect(afterRestart.rooms[0].state).toEqual(terminalState);

      const duplicate = store.recordCompletedGame({
        mode: 'multi',
        state: completedState(true),
        roomCode: active.code,
        playerAccounts: {},
        sourceKey: 'multi:crash-session'
      });
      expect(duplicate.id).toBe(game.id);
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM games').get().count).toBe(1);
    } finally {
      store.close();
    }
  });

  it('rejects mismatched or corrupt completion journals without mutating the source room', () => {
    const active = roomWithState(activeBlindDrawState(), 'playing');
    active.completedGameId = null;
    active.gameSessionId = 'crash-session';
    active.revision = 12;
    const activeRooms = new Map([[active.code, active]]);
    const before = serializeRooms(activeRooms, fixedNow);
    const baseJournal = {
      id: 'game-from-db',
      sourceKey: 'multi:crash-session',
      roomCode: active.code,
      completedAt: fixedNow + 100,
      finishedByAi: false,
      state: completedState(true)
    };

    expect(() => reconcileCompletedRoomJournals(
      activeRooms,
      () => ({ ...baseJournal, roomCode: 'ZZZZZ' })
    )).toThrow(/identity does not match/i);
    expect(serializeRooms(activeRooms, fixedNow)).toEqual(before);

    expect(() => reconcileCompletedRoomJournals(
      activeRooms,
      () => ({ ...baseJournal, state: active.state })
    )).toThrow(/journal state is invalid/i);
    expect(serializeRooms(activeRooms, fixedNow)).toEqual(before);

    const corruptSecondRoom = roomWithState(activeBlindDrawState(), 'playing');
    corruptSecondRoom.code = 'FGHIJ';
    corruptSecondRoom.completedGameId = null;
    corruptSecondRoom.gameSessionId = 'corrupt-session';
    corruptSecondRoom.revision = 4;
    const twoRooms = new Map([
      [active.code, active],
      [corruptSecondRoom.code, corruptSecondRoom]
    ]);
    const beforeTwoRooms = serializeRooms(twoRooms, fixedNow);
    expect(() => reconcileCompletedRoomJournals(twoRooms, (sourceKey: string) =>
      sourceKey === 'multi:crash-session'
        ? baseJournal
        : {
            ...baseJournal,
            id: 'second-game-from-db',
            sourceKey: 'multi:corrupt-session',
            roomCode: 'WRONG'
          }
    )).toThrow(/identity does not match/i);
    expect(serializeRooms(twoRooms, fixedNow)).toEqual(beforeTwoRooms);
  });

  it('preserves a completed room revision, readiness, and timestamp when its journal already matches', () => {
    const finished = roomWithState(completedState(true), 'finished');
    finished.completedGameId = 'journal-game';
    finished.gameSessionId = 'finished-session';
    finished.readyForNextRoundPlayerIds = ['host-1'];
    finished.revision = 22;
    finished.updatedAt = fixedNow + 500;
    const normalized = normalizeRoomsDocument(
      serializeRooms(new Map([[finished.code, finished]]), fixedNow + 500),
      { now: fixedNow + 500, pruneStale: false }
    ).rooms[0];
    normalized.state = Object.fromEntries(
      Object.entries(normalized.state as GameState).reverse()
    ) as GameState;
    normalized.state.players = normalized.state.players.map((item: GameState['players'][number]) =>
      Object.fromEntries(Object.entries(item).reverse()) as typeof item
    );
    const normalizedRooms = new Map([[normalized.code, normalized]]);
    const before = serializeRooms(normalizedRooms, fixedNow + 500);

    expect(reconcileCompletedRoomJournals(normalizedRooms, () => ({
      id: 'journal-game',
      sourceKey: 'multi:finished-session',
      roomCode: normalized.code,
      completedAt: fixedNow + 100,
      finishedByAi: false,
      state: normalized.state
    }))).toBe(0);

    expect(serializeRooms(normalizedRooms, fixedNow + 500)).toEqual(before);
    expect(normalized).toMatchObject({
      readyForNextRoundPlayerIds: ['host-1'],
      revision: 22,
      updatedAt: fixedNow + 500
    });
  });

  it('preserves historical chat names after a room player is renamed', async () => {
    const value = room();
    value.players[0].name = 'Ada Lovelace';

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const [restored] = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1 });

    expect(restored.players[0].name).toBe('Ada Lovelace');
    expect(restored.chatMessages[0]).toMatchObject({ playerId: 'host-1', playerName: 'Ada' });
  });

  it('keeps distinct maximum-length identifiers exact instead of truncating them into a collision', () => {
    const prefix = 'p'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH - 1);
    const firstId = `${prefix}1`;
    const secondId = `${prefix}2`;
    const value = room();
    value.hostId = firstId;
    value.players[0].id = firstId;
    value.players[1].id = secondId;
    value.chatMessages[0].id = `${'c'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH - 1)}1`;
    value.chatMessages[0].playerId = firstId;

    const restored = normalizeRoomsDocument(
      serializeRooms(new Map([[value.code, value]]), fixedNow),
      { now: fixedNow }
    ).rooms[0];
    const snapshot = createRoomSnapshot(restored, firstId);

    expect(snapshot.players.map((player) => player.id)).toEqual([firstId, secondId]);
    expect(new Set(snapshot.players.map((player) => player.id)).size).toBe(2);
    expect(snapshot.hostId).toBe(firstId);
    expect(snapshot.chatMessages[0].playerId).toBe(firstId);
    expect(isMultiplayerRoomSnapshot(snapshot, value.code)).toBe(true);
  });

  it('composes every persisted identifier boundary and rejects oversized runtime identities', () => {
    const value = room();
    const hostId = 'h'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    const guestId = 'p'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    value.hostId = hostId;
    value.players[0].id = hostId;
    value.players[0].userId = 'u'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    value.players[0].name = 'N'.repeat(64);
    value.players[1].id = guestId;
    value.players[1].userId = 'v'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    value.chatMessages[0].id = 'c'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    value.chatMessages[0].playerId = hostId;
    value.completedGameId = 'g'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);
    value.gameSessionId = 's'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH);

    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow);
    const restored = normalizeRoomsDocument(serialized, { now: fixedNow }).rooms[0];
    expect(restored).toMatchObject({
      hostId,
      completedGameId: value.completedGameId,
      gameSessionId: value.gameSessionId,
      players: [
        { id: hostId, userId: value.players[0].userId, name: 'N'.repeat(24) },
        { id: guestId, userId: value.players[1].userId }
      ],
      chatMessages: [{ id: value.chatMessages[0].id, playerId: hostId }]
    });

    const oversized = 'x'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
    const corruptions: Array<(candidate: ReturnType<typeof room>) => void> = [
      (candidate) => {
        candidate.players[0].id = oversized;
        candidate.hostId = oversized;
        candidate.chatMessages[0].playerId = oversized;
      },
      (candidate) => { candidate.players[0].userId = oversized; },
      (candidate) => { candidate.chatMessages[0].id = oversized; },
      (candidate) => { candidate.completedGameId = oversized; },
      (candidate) => { candidate.gameSessionId = oversized; }
    ];
    for (const corrupt of corruptions) {
      const candidate = room();
      corrupt(candidate);
      expect(() => serializeRooms(new Map([[candidate.code, candidate]]), fixedNow)).toThrow(/invalid/i);
    }

    const tooManyPlayers = room();
    tooManyPlayers.players = Array.from({ length: 9 }, (_, index) => ({
      ...tooManyPlayers.players[0],
      id: `player-${index}`,
      host: index === 0
    }));
    tooManyPlayers.hostId = tooManyPlayers.players[0].id;
    tooManyPlayers.chatMessages = [];
    expect(() => serializeRooms(new Map([[tooManyPlayers.code, tooManyPlayers]]), fixedNow)).toThrow(/one and eight players/i);
  });

  it('restores private state before applying player-specific snapshot redaction', async () => {
    const state = activeBlindDrawState();
    const value = roomWithState(state);
    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const [restored] = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1 });
    const activePlayerId = state.players[state.currentPlayerIndex].id;
    const otherPlayerId = state.players.find((player) => player.id !== activePlayerId)?.id;
    if (!otherPlayerId || !state.drawnCard) throw new Error('Fixture is missing player-specific hidden state.');

    const activeSnapshot = createRoomSnapshot(restored, activePlayerId);
    const otherSnapshot = createRoomSnapshot(restored, otherPlayerId);

    expect(activeSnapshot.state?.drawnCard?.value).toBe(state.drawnCard.value);
    expect(otherSnapshot.state?.drawnCard).toBeNull();
    expect(otherSnapshot.state?.hasDrawnCard).toBe(true);
    expect(otherSnapshot.state?.drawPileCount).toBe(state.drawPile.length);
    expect(JSON.stringify(otherSnapshot)).not.toContain(state.drawnCard.id);
    expect(JSON.stringify(otherSnapshot)).not.toMatch(/card-\d+--?\d+/);
    expect(otherSnapshot.state?.players.flatMap((player) => player.grid)
      .filter((card) => !card.faceUp)
      .every((card) => card.value === null)).toBe(true);
  });

  it('round-trips exact private reset aliases and defaults legacy rooms to an empty lineage', async () => {
    const value = roomWithResetAlias();
    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const restored = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1 });
    expect(restored[0].resetAliases).toEqual(value.resetAliases);
    expect(restored[0].recentCommandIds).toEqual(value.recentCommandIds);

    const legacy = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    delete (legacy.rooms[0] as { resetAliases?: unknown }).resetAliases;
    delete (legacy.rooms[0] as { recentCommandIds?: unknown }).recentCommandIds;
    delete (legacy.rooms[0] as { revision?: unknown }).revision;
    legacy.rooms[0].roomVersion = 1;
    expect(normalizeRoomsDocument(legacy, { now: fixedNow + 1 }).rooms[0]).toMatchObject({
      revision: 0,
      recentCommandIds: [],
      resetAliases: []
    });
  });

  it('pins an expired reset receipt while pruning high-churn unpinned receipts to the total cap', async () => {
    const value = roomWithResetAlias();
    const unpinnedReceipts = Array.from(
      { length: MAX_PERSISTED_COMMAND_RECEIPTS },
      (_, index) => ordinaryCommandReceipt(index)
    );
    value.revision = unpinnedReceipts.at(-1)?.revision || 1;
    value.recentCommandIds = [value.recentCommandIds[0], ...unpinnedReceipts];
    value.resetAliases[0].expiresAt = fixedNow - 1;
    expect(value.recentCommandIds).toHaveLength(MAX_PERSISTED_COMMAND_RECEIPTS + 1);

    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow);
    const serializedRoom = serialized.rooms[0];
    expect(serializedRoom.recentCommandIds).toHaveLength(MAX_PERSISTED_COMMAND_RECEIPTS);
    expect(serializedRoom.recentCommandIds.map((receipt: { commandId: string }) => receipt.commandId)).toEqual([
      resetCommandId,
      ...unpinnedReceipts.slice(1).map((receipt) => receipt.commandId)
    ]);
    expect(serializedRoom.resetAliases).toEqual(value.resetAliases);

    const normalized = normalizeRoomsDocument(serialized, { now: fixedNow }).rooms[0];
    expect(normalized.recentCommandIds).toEqual(serializedRoom.recentCommandIds);
    expect(normalized.resetAliases).toEqual(value.resetAliases);

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const [restored] = await loadRoomsFromDisk(roomsFile, { now: fixedNow });
    expect(restored.recentCommandIds).toEqual(serializedRoom.recentCommandIds);
    expect(restored.resetAliases).toEqual(value.resetAliases);
  });

  it('rejects an already-persisted document containing 129 command receipts', async () => {
    const value = roomWithResetAlias();
    const firstWindow = Array.from(
      { length: MAX_PERSISTED_COMMAND_RECEIPTS - 1 },
      (_, index) => ordinaryCommandReceipt(index)
    );
    value.revision = firstWindow.at(-1)?.revision || 1;
    value.recentCommandIds = [value.recentCommandIds[0], ...firstWindow];
    const persisted = serializeRooms(new Map([[value.code, value]]), fixedNow);
    expect(persisted.rooms[0].recentCommandIds).toHaveLength(MAX_PERSISTED_COMMAND_RECEIPTS);

    const overflowReceipt = ordinaryCommandReceipt(MAX_PERSISTED_COMMAND_RECEIPTS - 1);
    persisted.rooms[0].revision = overflowReceipt.revision;
    persisted.rooms[0].recentCommandIds.push(overflowReceipt);
    expect(() => normalizeRoomsDocument(persisted, { now: fixedNow })).toThrow(/too many command receipts/i);

    await fs.writeFile(roomsFile, JSON.stringify(persisted), 'utf8');
    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toThrow(/too many command receipts/i);
  });

  it('accepts finite past aliases, enforces bounds, and rejects malformed or unlinked aliases', () => {
    const valid = serializeRooms(new Map([['FGHIJ', roomWithResetAlias()]]), fixedNow);
    const past = structuredClone(valid);
    past.rooms[0].resetAliases[0].expiresAt = fixedNow - 1;
    expect(normalizeRoomsDocument(past, { now: fixedNow })).toMatchObject({
      rooms: [{ resetAliases: [{ expiresAt: fixedNow - 1 }] }]
    });

    const corruptions = [
      (document: typeof valid) => { document.rooms[0].resetAliases = {} as never; },
      (document: typeof valid) => {
        document.rooms[0].resetAliases = Array.from(
          { length: MAX_PERSISTED_RESET_ALIASES + 1 },
          () => document.rooms[0].resetAliases[0]
        );
      },
      (document: typeof valid) => { (document.rooms[0].resetAliases[0] as unknown as Record<string, unknown>).extra = true; },
      (document: typeof valid) => { document.rooms[0].resetAliases[0].fromCode = 'bad'; },
      (document: typeof valid) => { document.rooms[0].resetAliases[0].fromCode = 'FGHIJ'; },
      (document: typeof valid) => { document.rooms[0].resetAliases[0].commandId = 'not-a-uuid'; },
      (document: typeof valid) => { document.rooms[0].resetAliases[0].playerId = 'missing-seat'; },
      (document: typeof valid) => { document.rooms[0].resetAliases[0].expiresAt = Number.NaN; },
      (document: typeof valid) => { document.rooms[0].recentCommandIds = []; },
      (document: typeof valid) => { document.rooms[0].recentCommandIds[0].actionDigest = 'a'.repeat(64); }
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(valid);
      corrupt(candidate);
      expect(() => normalizeRoomsDocument(candidate, { now: fixedNow })).toThrow(/reset alias/i);
    }

    const tooManyAtRuntime = roomWithResetAlias();
    tooManyAtRuntime.resetAliases = Array.from(
      { length: MAX_PERSISTED_RESET_ALIASES + 1 },
      () => tooManyAtRuntime.resetAliases[0]
    );
    expect(() => serializeRooms(new Map([[tooManyAtRuntime.code, tooManyAtRuntime]]), fixedNow)).toThrow(
      /too many reset aliases/i
    );
  });

  it('rejects duplicate alias identity and live alias collisions across the room document', () => {
    const duplicate = serializeRooms(new Map([['FGHIJ', roomWithResetAlias()]]), fixedNow);
    duplicate.rooms[0].resetAliases.push({ ...duplicate.rooms[0].resetAliases[0] });
    expect(() => normalizeRoomsDocument(duplicate, { now: fixedNow })).toThrow(/duplicate reset alias/i);

    const duplicateCommand = structuredClone(duplicate);
    duplicateCommand.rooms[0].resetAliases[1].fromCode = 'ZZZZZ';
    expect(() => normalizeRoomsDocument(duplicateCommand, { now: fixedNow })).toThrow(/duplicate reset alias commands/i);

    const collisionWithRoom = serializeRooms(new Map([
      ['ABCDE', room(fixedNow, 'ABCDE')],
      ['FGHIJ', roomWithResetAlias()]
    ]), fixedNow);
    expect(() => normalizeRoomsDocument(collisionWithRoom, { now: fixedNow })).toThrow(/collides with active room code/i);

    const second = roomWithResetAlias(fixedNow, 'KLMNO');
    const duplicateAcrossRooms = serializeRooms(new Map([
      ['FGHIJ', roomWithResetAlias()],
      ['KLMNO', second]
    ]), fixedNow);
    expect(() => normalizeRoomsDocument(duplicateAcrossRooms, { now: fixedNow })).toThrow(/duplicate live reset alias/i);
  });

  it.each([
    ['top-level array', (rooms: unknown[]) => rooms],
    ['unversioned object', (rooms: unknown[]) => ({ rooms })],
    ['v1 envelope', (rooms: unknown[]) => ({ version: 1, savedAt: fixedNow, rooms })]
  ])('reads the legacy %s contract for an upgrade rewrite', async (_name, envelope) => {
    const current = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    await fs.writeFile(roomsFile, JSON.stringify(envelope(current.rooms)), 'utf8');

    const snapshot = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow + 1 });

    expect(snapshot).toEqual(expect.objectContaining({
      legacy: true,
      missing: false,
      protocolVersion: 1
    }));
    expect(snapshot.rooms).toHaveLength(1);
  });

  it('treats only a missing file or valid stale rooms as an empty collection', async () => {
    const missing = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow });
    expect(missing).toEqual(expect.objectContaining({ missing: true, rooms: [] }));
    expect(await loadRoomsFromDisk(roomsFile, { now: fixedNow })).toEqual([]);

    await saveRoomsToDisk(new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]), roomsFile);
    const stale = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow, staleMs: ROOM_STALE_MS });
    expect(stale).toEqual(expect.objectContaining({ missing: false, rooms: [] }));
  });

  it('fully validates stale rooms before pruning and preserves rejected source bytes', async () => {
    const staleCorrupt = serializeRooms(
      new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]),
      fixedNow
    );
    staleCorrupt.rooms[0].chatMessages = [null as never];
    const contents = `${JSON.stringify(staleCorrupt)}\n`;
    await fs.writeFile(roomsFile, contents, 'utf8');

    await expect(loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow, staleMs: ROOM_STALE_MS })).rejects.toThrow(
      /invalid chat message/i
    );
    expect(await fs.readFile(roomsFile, 'utf8')).toBe(contents);

    const validStale = serializeRooms(new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]), fixedNow);
    expect(normalizeRoomsDocument(validStale, { pruneStale: false }).rooms).toHaveLength(1);
    expect(normalizeRoomsDocument(validStale, { now: fixedNow, staleMs: ROOM_STALE_MS }).rooms).toEqual([]);
  });

  it('preserves exact source bytes when deep persisted game state is rejected', async () => {
    const value = roomWithState(activeBlindDrawState());
    const document = serializeRooms(new Map([[value.code, value]]), fixedNow);
    const state = document.rooms[0].state as GameState;
    state.players[0].grid[1].id = state.players[0].grid[0].id;
    const contents = `  ${JSON.stringify(document)}\r\n`;
    await fs.writeFile(roomsFile, contents, 'utf8');

    await expect(loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow })).rejects.toThrow(/invalid game state/i);
    expect(await fs.readFile(roomsFile, 'utf8')).toBe(contents);
  });

  it.each([
    ['invalid JSON', '{"rooms":', 'INVALID_ROOMS_JSON'],
    ['a non-document root', JSON.stringify('rooms'), 'INVALID_ROOMS_FILE'],
    ['an unversioned malformed envelope', JSON.stringify({ rooms: {} }), 'INVALID_ROOMS_FILE'],
    ['a future version', JSON.stringify({ format: 'skyjo-rooms', version: 3, protocolVersion: 1, rooms: [] }), 'UNSUPPORTED_ROOMS_VERSION'],
    ['a future protocol', JSON.stringify({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: Math.max(...SUPPORTED_ROOMS_PROTOCOL_VERSIONS) + 1,
      rooms: []
    }), 'UNSUPPORTED_ROOMS_PROTOCOL'],
    ['a v2 envelope without savedAt', JSON.stringify({ format: 'skyjo-rooms', version: 2, protocolVersion: 1, rooms: [] }), 'INVALID_ROOMS_FILE'],
    ['a wrong format marker', JSON.stringify({ format: 'other', version: 2, protocolVersion: 1, rooms: [] }), 'INVALID_ROOMS_FORMAT']
  ])('rejects %s without replacing the source file', async (_name, contents, code) => {
    await fs.writeFile(roomsFile, contents, 'utf8');

    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toMatchObject({
      name: 'RoomPersistenceFormatError',
      code
    });
    expect(await fs.readFile(roomsFile, 'utf8')).toBe(contents);
  });

  it('rejects malformed and duplicate room state instead of silently returning less data', async () => {
    const valid = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    const malformed = structuredClone(valid);
    malformed.rooms[0].players = [];
    await fs.writeFile(roomsFile, JSON.stringify(malformed), 'utf8');
    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toBeInstanceOf(RoomPersistenceFormatError);

    const duplicated = serializeRooms(
      new Map([
        ['first', room(fixedNow, 'ABCDE')],
        ['second', room(fixedNow, 'FGHIJ')]
      ]),
      fixedNow
    );
    duplicated.rooms[1].code = 'ABCDE';
    await fs.writeFile(roomsFile, JSON.stringify(duplicated), 'utf8');
    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toThrow(/duplicate room code/i);
  });

  it.each([
    ['a non-object player', (value: ReturnType<typeof room>) => { value.players[0] = null as never; }],
    ['a player without an id', (value: ReturnType<typeof room>) => { value.players[0].id = ''; }],
    ['an overlong player id', (value: ReturnType<typeof room>) => {
      const id = 'p'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
      value.players[0].id = id;
      value.hostId = id;
      value.chatMessages[0].playerId = id;
    }],
    ['duplicate player ids', (value: ReturnType<typeof room>) => { value.players[1].id = value.players[0].id; }],
    ['a non-string player name', (value: ReturnType<typeof room>) => { value.players[0].name = 42 as never; }],
    ['an empty player name', (value: ReturnType<typeof room>) => { value.players[0].name = ''; }],
    ['a non-string user id', (value: ReturnType<typeof room>) => { value.players[0].userId = 42 as never; }],
    ['an overlong user id', (value: ReturnType<typeof room>) => {
      value.players[0].userId = 'u'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
    }],
    ['a non-boolean connection state', (value: ReturnType<typeof room>) => { value.players[0].connected = 'yes' as never; }],
    ['a non-boolean host state', (value: ReturnType<typeof room>) => { value.players[0].host = 'yes' as never; }],
    ['a host outside the player list', (value: ReturnType<typeof room>) => { value.hostId = 'missing'; }],
    ['non-array chat', (value: ReturnType<typeof room>) => { value.chatMessages = {} as never; }],
    ['a non-object chat message', (value: ReturnType<typeof room>) => { value.chatMessages = [null as never]; }],
    ['an overlong chat id', (value: ReturnType<typeof room>) => {
      value.chatMessages[0].id = 'c'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
    }],
    ['a non-string chat player name', (value: ReturnType<typeof room>) => { value.chatMessages[0].playerName = 42 as never; }],
    ['an invalid chat timestamp', (value: ReturnType<typeof room>) => { value.chatMessages[0].createdAt = 'now' as never; }],
    ['a malformed chat message', (value: ReturnType<typeof room>) => { value.chatMessages[0].text = ''; }],
    ['an orphan chat author', (value: ReturnType<typeof room>) => { value.chatMessages[0].playerId = 'missing-seat'; }],
    ['non-array ready ids', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = {} as never; }],
    ['a non-string ready id', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = [42 as never]; }],
    ['an unknown ready id', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = ['missing-seat']; }],
    ['a noncanonical ready id', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = [' host-1']; }],
    ['duplicate ready ids', (value: ReturnType<typeof room>) => {
      value.readyForNextRoundPlayerIds = ['host-1', 'host-1'];
    }],
    ['non-object game state', (value: ReturnType<typeof room>) => { value.state = [] as never; }],
    ['waiting room with game state', (value: ReturnType<typeof room>) => { value.state = activeBlindDrawState(); }],
    ['playing room without game state', (value: ReturnType<typeof room>) => { value.status = 'playing'; }],
    ['playing room with corrupt game state', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
      value.state = activeBlindDrawState();
      value.state.players[0].grid[1].id = value.state.players[0].grid[0].id;
    }],
    ['active game with a ready player', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
      value.state = activeBlindDrawState();
      value.readyForNextRoundPlayerIds = ['host-1'];
    }],
    ['finished room with round-over state', (value: ReturnType<typeof room>) => {
      value.status = 'finished';
      value.state = completedState(false);
    }],
    ['playing room with game-over state', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
      value.state = completedState(true);
    }],
    ['a non-numeric update time', (value: ReturnType<typeof room>) => { value.updatedAt = 'now' as never; }],
    ['a non-string completed game id', (value: ReturnType<typeof room>) => { value.completedGameId = 1 as never; }],
    ['an overlong completed game id', (value: ReturnType<typeof room>) => {
      value.completedGameId = 'g'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
    }],
    ['a non-string game session id', (value: ReturnType<typeof room>) => { value.gameSessionId = 1 as never; }],
    ['an overlong game session id', (value: ReturnType<typeof room>) => {
      value.gameSessionId = 's'.repeat(MAX_PERSISTED_IDENTIFIER_LENGTH + 1);
    }]
  ])('rejects persisted room corruption: %s', async (_name, corrupt) => {
    const value = room();
    corrupt(value);
    const envelope = {
      format: ROOMS_FILE_FORMAT,
      version: ROOMS_FILE_VERSION,
      protocolVersion: ROOMS_PROTOCOL_VERSION,
      savedAt: fixedNow,
      rooms: [value]
    };
    await fs.writeFile(roomsFile, JSON.stringify(envelope), 'utf8');

    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toBeInstanceOf(RoomPersistenceFormatError);
  });

  it.each([
    ['duplicate ready ids', (value: ReturnType<typeof room>) => {
      value.readyForNextRoundPlayerIds = ['host-1', 'host-1'];
    }],
    ['an unknown ready id', (value: ReturnType<typeof room>) => {
      value.readyForNextRoundPlayerIds = ['missing-seat'];
    }],
    ['a noncanonical ready id', (value: ReturnType<typeof room>) => {
      value.readyForNextRoundPlayerIds = ['host-1 '];
    }],
    ['an orphan chat author', (value: ReturnType<typeof room>) => {
      value.chatMessages[0].playerId = 'missing-seat';
    }],
    ['waiting state', (value: ReturnType<typeof room>) => {
      value.state = activeBlindDrawState();
    }],
    ['missing playing state', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
    }],
    ['corrupt playing state', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
      value.state = activeBlindDrawState();
      value.state.drawPile[0].faceUp = true;
    }],
    ['active readiness', (value: ReturnType<typeof room>) => {
      value.status = 'playing';
      value.state = activeBlindDrawState();
      value.readyForNextRoundPlayerIds = ['host-1'];
    }]
  ])('rejects invalid runtime serialization: %s', (_label, corrupt) => {
    const value = room();
    corrupt(value);
    expect(() => serializeRooms(new Map([[value.code, value]]), fixedNow)).toThrow(RoomPersistenceFormatError);
  });

  it('validates strict parser metadata before any file access is involved', () => {
    expect(parseRoomsDocument([])).toEqual(expect.objectContaining({ version: 0, legacy: true }));
    expect(() => parseRoomsDocument({ format: 'skyjo-rooms', rooms: [] })).toThrow(/missing a version/i);
    expect(() => parseRoomsDocument({ version: 0, rooms: [] })).toThrow(/positive integer/i);
    expect(() => serializeRooms(new Map(), Number.NaN)).toThrow(/savedAt/i);
  });

  it('classifies directory fsync portability errors independently of the host platform', () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      expect(isUnsupportedDirectorySyncError('win32', { code })).toBe(true);
      expect(isUnsupportedDirectorySyncError('linux', { code })).toBe(false);
    }
    expect(isUnsupportedDirectorySyncError('win32', { code: 'EIO' })).toBe(false);
    expect(isUnsupportedDirectorySyncError('darwin', { code: 'EINVAL' })).toBe(false);
    expect(isUnsupportedDirectorySyncError('win32', null)).toBe(false);
    expect(isUnsupportedDirectorySyncError('win32', { code: 22 })).toBe(false);
  });

  it('rejects invalid load clocks and propagates non-missing read errors', async () => {
    await expect(loadRoomsSnapshotFromDisk(roomsFile, { now: Number.NaN })).rejects.toThrow(/now and staleMs/i);
    await expect(loadRoomsSnapshotFromDisk(tempDir, { now: fixedNow })).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('surfaces atomic rename failures while preserving the previous file and cleaning the temp file', async () => {
    const original = { generation: 'old', rooms: [1, 2, 3] };
    const replacement = { generation: 'new', rooms: [4, 5, 6] };
    await fs.writeFile(roomsFile, JSON.stringify(original), 'utf8');
    const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameError);

    await expect(atomicWriteJson(roomsFile, replacement)).rejects.toBe(renameError);

    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual(original);
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces non-portability directory fsync failures after leaving a complete new file', async () => {
    const originalOpen = fs.open.bind(fs);
    const directorySyncError = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(tempDir)) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(directorySyncError);
      }
      return handle;
    });
    await fs.writeFile(roomsFile, JSON.stringify({ generation: 'old' }), 'utf8');

    await expect(atomicWriteJson(roomsFile, { generation: 'new' })).rejects.toBe(directorySyncError);

    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual({ generation: 'new' });
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('records health success only after the final durability step', async () => {
    const originalOpen = fs.open.bind(fs);
    const directorySyncError = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(tempDir)) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(directorySyncError);
      }
      return handle;
    });
    const tracker = createPersistenceHealthTracker({ clock: () => fixedNow });

    await expect(tracker.track(() => atomicWriteJson(roomsFile, { durable: true }))).rejects.toBe(directorySyncError);

    expect(tracker.probe()).toEqual(expect.objectContaining({
      status: 'error',
      lastSuccessAt: null,
      failureCode: 'EIO'
    }));
    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual({ durable: true });
  });

  it('anchors restored disconnects to startup time and rewrites the lifecycle backfill once', () => {
    const runtimeRoom = room();
    const liveDocument = serializeRooms(new Map([[runtimeRoom.code, runtimeRoom]]), fixedNow);
    const first = normalizeRoomsDocument(liveDocument, { now: fixedNow + 500, pruneStale: false });
    expect(first.legacy).toBe(true);
    expect(first.rooms[0].players).toEqual(expect.arrayContaining([
      expect.objectContaining({ connected: false, disconnectedAt: fixedNow + 500 })
    ]));

    const rewritten = serializeRooms(new Map([[first.rooms[0].code, first.rooms[0]]]), fixedNow + 500);
    const second = normalizeRoomsDocument(rewritten, { now: fixedNow + 900, pruneStale: false });
    expect(second.legacy).toBe(false);
    expect(second.rooms[0].players[0].disconnectedAt).toBe(fixedNow + 500);
    expect(second.rooms[0].finishedByAi).toBe(false);

    const missingAnchor = structuredClone(rewritten);
    missingAnchor.rooms[0].players[0].disconnectedAt = null;
    const anchored = normalizeRoomsDocument(missingAnchor, { now: fixedNow + 1_200, pruneStale: false });
    expect(anchored.legacy).toBe(true);
    expect(anchored.rooms[0].players[0]).toMatchObject({ disconnectedAt: fixedNow + 1_200 });
  });

  it('rejects an AI controller in a waiting-room persistence document', () => {
    const waiting = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    waiting.rooms[0].players[0].controller = 'ai';
    expect(() => normalizeRoomsDocument(waiting, { now: fixedNow, pruneStale: false })).toThrow(/waiting room.*AI-controlled/i);
  });
});
