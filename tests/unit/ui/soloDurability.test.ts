import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import type { RandomSource } from '../../../src/runtime';
import {
  closeSoloDatabaseForTests,
  createStatsOutboxCoordinator,
  enqueueCompletedGame,
  flushStatsOutbox,
  isCompatibleSoloGameState,
  listStatsOutbox,
  loadSoloSession,
  resetSoloDatabaseForTests,
  saveSoloSession,
  soloDatabaseName,
  soloDatabaseVersion,
  soloOwnerKey,
  soloSessionStoreName,
  statsOutboxStoreName
} from '../../../src/soloDurability';
import type { Card, GameState } from '../../../src/types';
import { completedSoloGameState } from '../../helpers/soloGameState';

const gameA = '11111111-1111-4111-8111-111111111111';
const gameB = '22222222-2222-4222-8222-222222222222';
const gameC = '33333333-3333-4333-8333-333333333333';

function activeState(): GameState {
  return startFreshGame({ aiOpponentCount: 1, random: () => 0.25 });
}

function completedState(): GameState {
  return completedSoloGameState(1, () => 0.25);
}

function chooseSourceState(): GameState {
  let state = activeState();
  while (state.phase === 'opening-reveal') {
    const player = state.players[state.currentPlayerIndex];
    const cardIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    state = revealOpeningCard(state, cardIndex);
  }
  return state;
}

function playAutomatedStep(state: GameState, random: RandomSource): GameState {
  if (state.phase === 'game-over') return state;
  if (state.phase === 'round-over') return startNextRound(state, random);
  const player = state.players[state.currentPlayerIndex];
  if (state.phase === 'opening-reveal') {
    return revealOpeningCard(state, player.grid.findIndex((card) => !card.faceUp && !card.removed));
  }
  const move = getBestAiMove(state);
  if (state.phase === 'choose-source') {
    return move.action === 'discard' ? chooseDiscard(state) : drawBlind(state, random);
  }
  if (move.action === 'reveal') return discardDrawnAndReveal(state, move.index ?? 0);
  return replaceCard(state, move.index ?? 0);
}

interface AutomatedTraceEvidence {
  reachedGameOver: boolean;
  sawActiveCopyOfRemovedCard: boolean;
  sawDuplicateRemovedShadow: boolean;
  sawTerminalScoringClear: boolean;
}

function runAutomatedGame(seed: number, aiOpponentCount: number): AutomatedTraceEvidence {
  const random = createSeededRandom(seed);
  let state = startFreshGame({ aiOpponentCount, random });
  const evidence: AutomatedTraceEvidence = {
    reachedGameOver: false,
    sawActiveCopyOfRemovedCard: false,
    sawDuplicateRemovedShadow: false,
    sawTerminalScoringClear: false
  };

  for (let step = 0; step < 5_000; step += 1) {
    expect(isCompatibleSoloGameState(state), `seed ${seed}, ${aiOpponentCount} AIs, step ${step}`).toBe(true);
    const removedCards = state.players.flatMap((player) => player.grid.filter((card) => card.removed));
    const removedCounts = new Map<string, number>();
    for (const card of removedCards) removedCounts.set(card.id, (removedCounts.get(card.id) || 0) + 1);
    const activeCards = [
      ...state.drawPile,
      ...state.discardPile,
      ...(state.drawnCard ? [state.drawnCard] : []),
      ...state.players.flatMap((player) => player.grid.filter((card) => !card.removed))
    ];
    const activeIds = new Set(activeCards.map((card) => card.id));
    evidence.sawActiveCopyOfRemovedCard ||= removedCards.some((card) => activeIds.has(card.id));
    evidence.sawDuplicateRemovedShadow ||= [...removedCounts.values()].some((count) => count > 1);
    evidence.sawTerminalScoringClear ||=
      (state.phase === 'round-over' || state.phase === 'game-over') && activeCards.length < 150;

    if (state.phase === 'game-over') {
      evidence.reachedGameOver = true;
      return evidence;
    }
    state = playAutomatedStep(state, random);
  }

  throw new Error(`Seed ${seed} with ${aiOpponentCount} AIs did not finish within 5,000 atomic actions.`);
}

function finalTurnState(): GameState {
  const random = createSeededRandom(1);
  let state = startFreshGame({ aiOpponentCount: 1, random });
  for (let step = 0; step < 1_000; step += 1) {
    if (state.roundCloserId && state.phase !== 'round-over' && state.phase !== 'game-over') return state;
    state = playAutomatedStep(state, random);
  }
  throw new Error('The deterministic game did not reach a final turn.');
}

function tiedLowestRoundOverState(): GameState {
  const state = activeState();
  const allCards = [...state.players.flatMap((player) => player.grid), ...state.drawPile, ...state.discardPile];
  const humanGrid: Card[] = [];
  const aiGrid: Card[] = [];
  const selectedIds = new Set<string>();
  for (let value = 1; value <= 6; value += 1) {
    const cards = allCards.filter((card) => card.value === value && !selectedIds.has(card.id)).slice(0, 4);
    humanGrid.push(...cards.slice(0, 2));
    aiGrid.push(...cards.slice(2));
    cards.forEach((card) => selectedIds.add(card.id));
  }
  const remaining = allCards.filter((card) => !selectedIds.has(card.id));
  const players = state.players.map((player) => {
    const grid = (player.kind === 'human' ? humanGrid : aiGrid).map((card) => ({ ...card, faceUp: true, removed: false }));
    const rawScore = grid.reduce((total, card) => total + card.value, 0);
    const roundScore = player.kind === 'human' ? rawScore * 2 : rawScore;
    return { ...player, grid, roundScore, totalScore: roundScore };
  });
  const closer = players.find((player) => player.kind === 'human')!;
  return {
    ...state,
    players,
    drawPile: remaining.slice(1).map((card) => ({ ...card, faceUp: false, removed: false })),
    discardPile: [{ ...remaining[0], faceUp: true, removed: false }],
    phase: 'round-over',
    selectedSource: null,
    drawnCard: null,
    winnerId: null,
    nextStarterId: closer.id,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: Object.fromEntries(players.map((player) => [player.id, 2])),
    roundHistory: [
      {
        round: 1,
        closerId: closer.id,
        scores: players.map((player) => ({
          playerId: player.id,
          name: player.name,
          roundScore: player.roundScore,
          totalScore: player.totalScore
        }))
      }
    ]
  };
}

function tiedLowestGameOverState(): GameState {
  const state = completedState();
  const tiedTotal = 500;
  const previousScores = state.players.map((player) => {
    const previousTotal = tiedTotal - player.roundScore;
    return {
      playerId: player.id,
      name: player.name,
      roundScore: previousTotal,
      totalScore: previousTotal
    };
  });
  const players = state.players.map((player) => ({ ...player, totalScore: tiedTotal }));
  const latestScores = players.map((player) => ({
    playerId: player.id,
    name: player.name,
    roundScore: player.roundScore,
    totalScore: tiedTotal
  }));
  return {
    ...state,
    round: 2,
    players,
    winnerId: players[0].id,
    roundHistory: [
      { round: 1, closerId: state.nextStarterId!, scores: previousScores },
      { round: 2, closerId: state.nextStarterId!, scores: latestScores }
    ]
  };
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(soloDatabaseName, soloDatabaseVersion);
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
  });
}

async function putRaw(storeName: string, value: unknown): Promise<void> {
  const database = await openRawDatabase();
  try {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function rawRecordsForOwner(storeName: string, ownerKey: string): Promise<unknown[]> {
  const database = await openRawDatabase();
  try {
    const transaction = database.transaction(storeName, 'readonly');
    const completion = transactionDone(transaction);
    const request = transaction.objectStore(storeName).index('byOwner').getAll(ownerKey);
    const records = await new Promise<unknown[]>((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result as unknown[]), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    await completion;
    return records;
  } finally {
    database.close();
  }
}

describe('solo snapshot compatibility', () => {
  it('accepts legal opening, source, replacement, final-turn, and terminal snapshots', () => {
    const source = chooseSourceState();
    const blind = drawBlind(source, () => 0.25);
    const hiddenIndex = blind.players[blind.currentPlayerIndex].grid.findIndex((card) => !card.faceUp && !card.removed);
    const states = {
      opening: activeState(),
      source,
      discardSelection: chooseDiscard(source),
      blind,
      replace: replaceCard(blind, 0),
      reveal: discardDrawnAndReveal(blind, hiddenIndex),
      finalTurn: finalTurnState(),
      tiedRound: tiedLowestRoundOverState(),
      completed: completedState()
    };
    for (const [name, state] of Object.entries(states)) {
      expect(isCompatibleSoloGameState(state), name).toBe(true);
    }
  });

  it('rejects incoherent phase tuples, opening counts, final turns, and terminal metadata', () => {
    const source = chooseSourceState();
    const blindWithoutCard = { ...drawBlind(source), drawnCard: null };
    const discardWithCard = chooseDiscard(source);
    const [movedCard, ...remainingDraw] = discardWithCard.drawPile;
    const discardWithDrawnCard = {
      ...discardWithCard,
      drawPile: remainingDraw,
      drawnCard: { ...movedCard, faceUp: true }
    };
    const [discardTop] = source.discardPile;
    const emptyDiscard = {
      ...source,
      drawPile: [{ ...discardTop, faceUp: false }, ...source.drawPile],
      discardPile: []
    };
    const openingSelected = { ...activeState(), selectedSource: 'discard' as const };
    const openingCountMismatch = {
      ...activeState(),
      openingRevealCounts: { ...activeState().openingRevealCounts, human: 1 }
    };
    const openingWrongTurn = { ...activeState(), currentPlayerIndex: 1 };
    const badFinalTurn = { ...finalTurnState(), finalTurnPlayerIds: [] };
    const terminalFaceDown = completedState();
    terminalFaceDown.players[0].grid[0].faceUp = false;
    const wrongWinner = { ...completedState(), winnerId: 'ai-1' };
    const badHistory = completedState();
    badHistory.roundHistory[0].round = 2;
    const wrongTerminalCloser = completedState();
    wrongTerminalCloser.roundHistory[0].closerId = 'ai-1';

    expect(
      [
        blindWithoutCard,
        discardWithDrawnCard,
        emptyDiscard,
        openingSelected,
        openingCountMismatch,
        openingWrongTurn,
        badFinalTurn,
        terminalFaceDown,
        wrongWinner,
        badHistory,
        wrongTerminalCloser
      ].every((state) => !isCompatibleSoloGameState(state))
    ).toBe(true);
  });

  it('rejects missing, duplicated, and non-canonical physical cards', () => {
    const missing = activeState();
    missing.drawPile.pop();
    const duplicate = activeState();
    duplicate.drawPile[0] = { ...duplicate.drawPile[1] };
    const mismatchedId = activeState();
    mismatchedId.drawPile[0].id = 'card-0-12';
    expect([missing, duplicate, mismatchedId].every((state) => !isCompatibleSoloGameState(state))).toBe(true);
  });

  it('rejects impossible removed columns and post-opening knowledge states', () => {
    const loneRemoved = chooseSourceState();
    const loneRemovedPlayer = loneRemoved.players[0];
    const hiddenIndex = loneRemovedPlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
    const clearedCard = loneRemovedPlayer.grid[hiddenIndex];
    loneRemovedPlayer.grid[hiddenIndex] = { ...clearedCard, faceUp: true, removed: true };
    loneRemoved.discardPile = [{ ...clearedCard, faceUp: true, removed: false }, ...loneRemoved.discardPile];

    const zeroKnown = chooseSourceState();
    zeroKnown.players = zeroKnown.players.map((player) => ({
      ...player,
      grid: player.grid.map((card) => ({ ...card, faceUp: false, removed: false })),
      roundScore: 0
    }));

    const fullyKnownWithoutCloser = chooseSourceState();
    fullyKnownWithoutCloser.players = fullyKnownWithoutCloser.players.map((player) => {
      const grid = player.grid.map((card) => ({ ...card, faceUp: true, removed: false }));
      return { ...player, grid, roundScore: grid.reduce((total, card) => total + card.value, 0) };
    });

    expect(isCompatibleSoloGameState(loneRemoved)).toBe(false);
    expect(isCompatibleSoloGameState(zeroKnown)).toBe(false);
    expect(isCompatibleSoloGameState(fullyKnownWithoutCloser)).toBe(false);
  });

  it('fails closed on malformed top-level, roster, and history fields', () => {
    const base = activeState();
    const tooManyPlayers = [...base.players, ...Array.from({ length: 7 }, (_, index) => ({ ...base.players[1], id: `extra-${index}` }))];
    const invalidCard = { ...base.drawPile[0], value: 1.5 };
    const invalidRoundHistory = [{ round: 0, closerId: '', scores: null }];
    const duplicatePlayers = base.players.map((player, index) => ({ ...player, id: index === 1 ? base.players[0].id : player.id }));
    const allAiPlayers = base.players.map((player) => ({ ...player, kind: 'ai' as const }));
    const allHumanPlayers = base.players.map((player) => ({ ...player, kind: 'human' as const }));
    const malformed: unknown[] = [
      null,
      { ...base, players: [] },
      { ...base, players: tooManyPlayers },
      { ...base, drawPile: null },
      { ...base, drawPile: [invalidCard, ...base.drawPile.slice(1)] },
      { ...base, discardPile: null },
      { ...base, currentPlayerIndex: -1 },
      { ...base, currentPlayerIndex: base.players.length },
      { ...base, phase: 'playing' },
      { ...base, selectedSource: 'deck' },
      { ...base, drawnCard: { id: 'bad' } },
      { ...base, round: 0 },
      { ...base, log: null },
      { ...base, log: Array<string>(9).fill('too much') },
      { ...base, log: [3] },
      { ...base, winnerId: 3 },
      { ...base, nextStarterId: 3 },
      { ...base, roundCloserId: 3 },
      { ...base, finalTurnPlayerIds: null },
      { ...base, finalTurnPlayerIds: [3] },
      { ...base, openingRevealCounts: null },
      { ...base, roundHistory: null },
      { ...base, roundHistory: invalidRoundHistory },
      { ...base, players: duplicatePlayers },
      { ...base, players: allAiPlayers },
      { ...base, players: allHumanPlayers },
      { ...base, winnerId: 'missing-player' },
      { ...base, nextStarterId: 'missing-player' },
      { ...base, roundCloserId: 'missing-player' },
      { ...base, finalTurnPlayerIds: ['missing-player'] }
    ];
    expect(malformed.every((state) => !isCompatibleSoloGameState(state))).toBe(true);
  });

  it('applies the strict-lowest closer rule when the closer ties the lowest opponent', () => {
    const tied = tiedLowestRoundOverState();
    const closer = tied.players.find((player) => player.id === tied.nextStarterId)!;
    const opponent = tied.players.find((player) => player.id !== closer.id)!;
    expect(closer.roundScore).toBe(opponent.roundScore * 2);
    expect(isCompatibleSoloGameState(tied)).toBe(true);
    closer.roundScore = opponent.roundScore;
    closer.totalScore = opponent.totalScore;
    tied.roundHistory[0].scores.find((score) => score.playerId === closer.id)!.roundScore = opponent.roundScore;
    tied.roundHistory[0].scores.find((score) => score.playerId === closer.id)!.totalScore = opponent.totalScore;
    expect(isCompatibleSoloGameState(tied)).toBe(false);
  });

  it('requires a tied game-over winner to be the first lowest player in roster order', () => {
    const tied = tiedLowestGameOverState();
    expect(isCompatibleSoloGameState(tied)).toBe(true);
    tied.winnerId = tied.players[1].id;
    expect(isCompatibleSoloGameState(tied)).toBe(false);
  });

  it('accepts complete seeded AI traces including card reuse and terminal-only column clears', () => {
    const recycledCardTrace = runAutomatedGame(1, 2);
    expect(recycledCardTrace).toMatchObject({ reachedGameOver: true, sawActiveCopyOfRemovedCard: true });

    const terminalClearTrace = runAutomatedGame(13, 2);
    expect(terminalClearTrace).toMatchObject({ reachedGameOver: true, sawTerminalScoringClear: true });

    const repeatedClearTrace = runAutomatedGame(9, 3);
    expect(repeatedClearTrace).toMatchObject({ reachedGameOver: true, sawDuplicateRemovedShadow: true });
  });

  it('accepts every snapshot in deterministic legal games across the full solo roster range', () => {
    for (let aiOpponentCount = 1; aiOpponentCount <= 7; aiOpponentCount += 1) {
      let state = startFreshGame({ aiOpponentCount, random: () => 0.37 });
      for (let step = 0; step < 800 && state.phase !== 'game-over'; step += 1) {
        expect(isCompatibleSoloGameState(state)).toBe(true);
        if (state.phase === 'round-over') {
          state = startNextRound(state, () => 0.41);
          continue;
        }
        const player = state.players[state.currentPlayerIndex];
        if (state.phase === 'opening-reveal') {
          state = revealOpeningCard(state, player.grid.findIndex((card) => !card.faceUp && !card.removed));
          continue;
        }
        if (state.phase === 'choose-source') {
          state = step % 3 === 0 ? chooseDiscard(state) : drawBlind(state, () => 0.43);
          continue;
        }
        const replaceIndex = player.grid.findIndex((card) => !card.removed);
        const revealIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
        state =
          state.selectedSource === 'draw' && step % 2 === 0 && revealIndex >= 0
            ? discardDrawnAndReveal(state, revealIndex)
            : replaceCard(state, replaceIndex);
      }
      expect(isCompatibleSoloGameState(state)).toBe(true);
    }
  });
});

describe('solo IndexedDB durability', () => {
  it('creates the v1 stores with composite owner keys and restores only the active owner', async () => {
    const guestState = activeState();
    const accountState = activeState();
    expect(await saveSoloSession('guest', gameA, guestState, 1, () => 10)).toBeNull();
    expect(await saveSoloSession(soloOwnerKey('alice'), gameB, accountState, 1, () => 20)).toBeNull();

    expect((await loadSoloSession('guest')).session).toMatchObject({ ownerKey: 'guest', gameId: gameA, updatedAt: 10 });
    expect((await loadSoloSession(soloOwnerKey('alice'))).session).toMatchObject({
      ownerKey: 'account:alice',
      gameId: gameB,
      state: { round: 1 }
    });
    expect((await loadSoloSession(soloOwnerKey('bob'))).session).toBeNull();

    const database = await openRawDatabase();
    expect(database.version).toBe(1);
    expect([...database.objectStoreNames]).toEqual([soloSessionStoreName, statsOutboxStoreName]);
    const sessionTransaction = database.transaction(soloSessionStoreName);
    expect(sessionTransaction.objectStore(soloSessionStoreName).keyPath).toEqual(['ownerKey', 'gameId']);
    expect([...sessionTransaction.objectStore(soloSessionStoreName).indexNames]).toEqual(['byOwner', 'byOwnerUpdatedAt']);
    const outboxTransaction = database.transaction(statsOutboxStoreName);
    expect(outboxTransaction.objectStore(statsOutboxStoreName).keyPath).toEqual(['ownerKey', 'gameId']);
    expect([...outboxTransaction.objectStore(statsOutboxStoreName).indexNames]).toEqual([
      'byOwner',
      'byOwnerNextAttempt'
    ]);
    database.close();
  });

  it('quarantines only the newest corrupt or incompatible session and preserves an older valid record', async () => {
    const ownerKey = soloOwnerKey('alice');
    await saveSoloSession(ownerKey, gameA, activeState(), 1, () => 10);
    await putRaw(soloSessionStoreName, {
      ownerKey,
      gameId: gameB,
      schemaVersion: 99,
      state: { phase: 'choose-source' },
      aiOpponentCount: 1,
      updatedAt: 20
    });

    const recovered = await loadSoloSession(ownerKey);
    expect(recovered.session?.gameId).toBe(gameA);
    expect(recovered.warning).toMatchObject({ kind: 'recovered' });
    const valid = await loadSoloSession(ownerKey);
    expect(valid.session?.gameId).toBe(gameA);
    expect(valid.warning).toBeNull();
  });

  it('removes an all-corrupt session set without claiming a usable game was recovered', async () => {
    const ownerKey = soloOwnerKey('alice');
    await loadSoloSession(ownerKey);
    await putRaw(soloSessionStoreName, {
      ownerKey,
      gameId: gameA,
      schemaVersion: 99,
      state: { phase: 'choose-source' },
      aiOpponentCount: 1,
      updatedAt: 20
    });
    const result = await loadSoloSession(ownerKey);
    expect(result.session).toBeNull();
    expect(result.warning).toMatchObject({ kind: 'recovered' });
    expect(result.warning?.message).not.toMatch(/usable game was recovered/i);
    expect(await rawRecordsForOwner(soloSessionStoreName, ownerKey)).toEqual([]);
  });

  it('refuses a session whose stored AI count does not match its roster', async () => {
    const warning = await saveSoloSession(soloOwnerKey('alice'), gameA, activeState(), 2, () => 10);
    expect(warning).toMatchObject({ kind: 'unavailable' });
    expect((await loadSoloSession(soloOwnerKey('alice'))).session).toBeNull();
  });

  it('warns on quota and private-mode failures without rejecting gameplay operations', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    const quota = await saveSoloSession('guest', gameA, activeState(), 1);
    expect(quota).toMatchObject({ kind: 'quota' });
    put.mockRestore();

    await resetSoloDatabaseForTests();
    const realIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: () => { throw new DOMException('Private mode', 'SecurityError'); } }
    });
    const unavailable = await loadSoloSession('guest');
    expect(unavailable).toMatchObject({ session: null, warning: { kind: 'unavailable' } });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: realIndexedDb });
  });

  it('closes a database handle that succeeds after an already-rejected blocked open', async () => {
    await resetSoloDatabaseForTests();
    const realIndexedDb = globalThis.indexedDB;
    const close = vi.fn();
    const request = new EventTarget() as IDBOpenDBRequest;
    Object.defineProperty(request, 'result', { configurable: true, value: { close } });
    Object.defineProperty(request, 'error', { configurable: true, value: null });
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          window.setTimeout(() => {
            request.dispatchEvent(new Event('blocked'));
            window.setTimeout(() => request.dispatchEvent(new Event('success')), 0);
          }, 0);
          return request;
        }
      }
    });
    try {
      expect(await loadSoloSession(soloOwnerKey('alice'))).toMatchObject({
        session: null,
        warning: { kind: 'unavailable' }
      });
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: realIndexedDb });
    }
  });

  it('survives a database close/reopen that models a service-worker application update', async () => {
    await saveSoloSession('guest', gameA, activeState(), 1, () => 100);
    await enqueueCompletedGame('guest', gameB, completedState(), () => 101);
    await closeSoloDatabaseForTests();

    expect((await loadSoloSession('guest')).session?.gameId).toBe(gameA);
    expect(await listStatsOutbox('guest')).toEqual([]);
  });
});

describe('solo stats outbox', () => {
  it('keeps equal-score games distinct by UUID and makes duplicate enqueue idempotent', async () => {
    const ownerKey = soloOwnerKey('alice');
    const equalScores = completedState();
    await enqueueCompletedGame(ownerKey, gameA, equalScores, () => 10);
    await enqueueCompletedGame(ownerKey, gameB, equalScores, () => 20);
    await flushStatsOutbox({
      ownerKey,
      now: () => 30,
      deliver: async () => {
        throw new Error('offline');
      }
    });
    await enqueueCompletedGame(ownerKey, gameA, equalScores, () => 40);

    const queued = await listStatsOutbox(ownerKey);
    expect(queued.map((record) => record.gameId)).toEqual([gameA, gameB]);
    expect(queued[0]).toMatchObject({ attempts: 1, createdAt: 10, lastError: 'offline' });
  });

  it('retries a bounded batch after offline failure and treats duplicate server success as delivered', async () => {
    const ownerKey = soloOwnerKey('alice');
    for (const gameId of [gameA, gameB, gameC, '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']) {
      await enqueueCompletedGame(ownerKey, gameId, completedState(), () => 10);
    }
    const offline = vi.fn(async () => {
      throw new TypeError('Network unavailable');
    });
    const first = await flushStatsOutbox({ ownerKey, deliver: offline, force: true, now: () => 20 });
    expect(first).toMatchObject({ attempted: 1, delivered: 0, pending: 5 });
    expect(offline).toHaveBeenCalledTimes(1);

    const serverGame = { id: 'same-server-game' };
    const online = vi.fn(async () => serverGame);
    const second = await flushStatsOutbox({ ownerKey, deliver: online, force: true, now: () => 30 });
    expect(second).toMatchObject({ attempted: 4, delivered: 4, pending: 1 });
    const third = await flushStatsOutbox({ ownerKey, deliver: online, force: true, now: () => 40 });
    expect(third).toMatchObject({ attempted: 1, delivered: 1, pending: 0 });
    expect(online).toHaveBeenCalledTimes(5);
  });

  it('retries a transport AbortError unless the owning coordinator signal was actually aborted', async () => {
    const ownerKey = soloOwnerKey('alice');
    await enqueueCompletedGame(ownerKey, gameA, completedState(), () => 10);
    const activeSignal = new AbortController();
    const transportAbort = await flushStatsOutbox({
      ownerKey,
      signal: activeSignal.signal,
      force: true,
      now: () => 20,
      deliver: async () => {
        throw new DOMException('WebKit cancelled the request', 'AbortError');
      }
    });
    expect(transportAbort).toMatchObject({ attempted: 1, delivered: 0, pending: 1, aborted: false });
    expect(await listStatsOutbox(ownerKey)).toMatchObject([
      { gameId: gameA, attempts: 1, lastError: 'Stats delivery failed.' }
    ]);

    const ownerAbort = new AbortController();
    const cancelled = await flushStatsOutbox({
      ownerKey,
      signal: ownerAbort.signal,
      force: true,
      now: () => 30,
      deliver: async () => {
        ownerAbort.abort();
        throw new DOMException('Owner changed', 'AbortError');
      }
    });
    expect(cancelled).toMatchObject({ attempted: 1, delivered: 0, pending: 1, aborted: true });
    expect(await listStatsOutbox(ownerKey)).toMatchObject([{ gameId: gameA, attempts: 1 }]);
  });

  it('preserves strict FIFO order and never lets a newer game overtake a failed head record', async () => {
    const ownerKey = soloOwnerKey('alice');
    await enqueueCompletedGame(ownerKey, gameA, completedState(), () => 10);
    await enqueueCompletedGame(ownerKey, gameB, completedState(), () => 20);
    await enqueueCompletedGame(ownerKey, gameC, completedState(), () => 30);
    const calls: Array<{ gameId: string; createdAt: number }> = [];
    const failHead = vi.fn(async (record: { gameId: string; createdAt: number }) => {
      calls.push({ gameId: record.gameId, createdAt: record.createdAt });
      throw new Error('offline');
    });

    expect(await flushStatsOutbox({ ownerKey, deliver: failHead, force: true, now: () => 40 })).toMatchObject({
      attempted: 1,
      delivered: 0,
      pending: 3
    });
    expect(calls).toEqual([{ gameId: gameA, createdAt: 10 }]);
    expect(
      await flushStatsOutbox({ ownerKey, deliver: vi.fn(), force: false, now: () => 40 })
    ).toMatchObject({ attempted: 0, delivered: 0, pending: 3 });

    const delivered: Array<{ gameId: string; createdAt: number }> = [];
    expect(
      await flushStatsOutbox({
        ownerKey,
        deliver: async (record) => delivered.push({ gameId: record.gameId, createdAt: record.createdAt }),
        force: true,
        now: () => 50
      })
    ).toMatchObject({ attempted: 3, delivered: 3, pending: 0 });
    expect(delivered).toEqual([
      { gameId: gameA, createdAt: 10 },
      { gameId: gameB, createdAt: 20 },
      { gameId: gameC, createdAt: 30 }
    ]);
  });

  it('stops after a later record fails and resumes from that record on the next flush', async () => {
    const ownerKey = soloOwnerKey('alice');
    for (const [gameId, createdAt] of [
      [gameA, 10],
      [gameB, 20],
      [gameC, 30]
    ] as const) {
      await enqueueCompletedGame(ownerKey, gameId, completedState(), () => createdAt);
    }
    const firstCalls: string[] = [];
    await flushStatsOutbox({
      ownerKey,
      force: true,
      now: () => 40,
      deliver: async (record) => {
        firstCalls.push(record.gameId);
        if (record.gameId === gameB) throw new Error('temporary');
      }
    });
    expect(firstCalls).toEqual([gameA, gameB]);
    expect((await listStatsOutbox(ownerKey)).map((record) => record.gameId)).toEqual([gameB, gameC]);

    const retryCalls: string[] = [];
    await flushStatsOutbox({
      ownerKey,
      force: true,
      now: () => 50,
      deliver: async (record) => retryCalls.push(record.gameId)
    });
    expect(retryCalls).toEqual([gameB, gameC]);
  });

  it('orders equal timestamps by game UUID for deterministic delivery', async () => {
    const ownerKey = soloOwnerKey('alice');
    await enqueueCompletedGame(ownerKey, gameC, completedState(), () => 10);
    await enqueueCompletedGame(ownerKey, gameA, completedState(), () => 10);
    await enqueueCompletedGame(ownerKey, gameB, completedState(), () => 10);
    expect((await listStatsOutbox(ownerKey)).map((record) => record.gameId)).toEqual([gameA, gameB, gameC]);
  });

  it('atomically replaces a malformed same-key record before the completed session can be removed', async () => {
    const ownerKey = soloOwnerKey('alice');
    await listStatsOutbox(ownerKey);
    await putRaw(statsOutboxStoreName, {
      ownerKey,
      gameId: gameA,
      schemaVersion: 1,
      state: { phase: 'game-over' },
      attempts: 0,
      createdAt: 10,
      updatedAt: 10,
      nextAttemptAt: 10,
      lastError: ''
    });
    expect(await enqueueCompletedGame(ownerKey, gameA, completedState(), () => 20)).toBeNull();
    expect(await listStatsOutbox(ownerKey)).toMatchObject([
      { ownerKey, gameId: gameA, createdAt: 20, state: { phase: 'game-over' } }
    ]);
  });

  it('quarantines poison timestamps before delivery so they cannot retry a server 400 forever', async () => {
    const ownerKey = soloOwnerKey('alice');
    await listStatsOutbox(ownerKey);
    await putRaw(statsOutboxStoreName, {
      ownerKey,
      gameId: gameA,
      schemaVersion: 1,
      state: completedState(),
      attempts: 0,
      createdAt: 1.5,
      updatedAt: 10,
      nextAttemptAt: 10,
      lastError: ''
    });
    expect(await listStatsOutbox(ownerKey)).toEqual([]);
    expect(await rawRecordsForOwner(statsOutboxStoreName, ownerKey)).toEqual([]);
  });

  it('does not delete a valid same-key replacement queued by another tab during quarantine', async () => {
    const ownerKey = soloOwnerKey('alice');
    await listStatsOutbox(ownerKey);
    await putRaw(statsOutboxStoreName, {
      ownerKey,
      gameId: gameA,
      schemaVersion: 1,
      state: completedState(),
      attempts: 0,
      createdAt: 0,
      updatedAt: 10,
      nextAttemptAt: 10,
      lastError: ''
    });
    const validReplacement = {
      ownerKey,
      gameId: gameA,
      schemaVersion: 1,
      state: completedState(),
      attempts: 0,
      createdAt: 20,
      updatedAt: 20,
      nextAttemptAt: 20,
      lastError: ''
    };
    const originalDelete = IDBObjectStore.prototype.delete;
    let replacementWrite: Promise<void> | null = null;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange
    ) {
      const request = originalDelete.call(this, key);
      if (this.name === statsOutboxStoreName && !replacementWrite) {
        replacementWrite = putRaw(statsOutboxStoreName, validReplacement);
      }
      return request;
    });

    try {
      expect(await listStatsOutbox(ownerKey)).toEqual([]);
      await vi.waitFor(() => expect(replacementWrite).not.toBeNull());
      await replacementWrite!;
    } finally {
      deletion.mockRestore();
    }
    expect(await listStatsOutbox(ownerKey)).toMatchObject([{ gameId: gameA, createdAt: 20 }]);
  });

  it('caps guest completions at one, never submits them under an account, and prunes them on the next guest launch', async () => {
    await enqueueCompletedGame('guest', gameA, completedState());
    await enqueueCompletedGame('guest', gameC, completedState());
    await enqueueCompletedGame(soloOwnerKey('alice'), gameB, completedState());
    const delivered: string[] = [];
    const result = await flushStatsOutbox({
      ownerKey: soloOwnerKey('alice'),
      force: true,
      deliver: async (record) => delivered.push(record.gameId)
    });
    expect(result.delivered).toBe(1);
    expect(delivered).toEqual([gameB]);
    expect((await listStatsOutbox('guest')).map((record) => record.gameId)).toEqual([gameC]);
    const guestDeliver = vi.fn();
    expect(await flushStatsOutbox({ ownerKey: 'guest', force: true, deliver: guestDeliver })).toMatchObject({
      attempted: 0,
      delivered: 0,
      pending: 1
    });
    expect(guestDeliver).not.toHaveBeenCalled();
    await loadSoloSession('guest');
    expect(await listStatsOutbox('guest')).toEqual([]);
  });

  it('is single-flight and fences an account switch while a delivery is in progress', async () => {
    const alice = soloOwnerKey('alice');
    const bob = soloOwnerKey('bob');
    await enqueueCompletedGame(alice, gameA, completedState());
    await enqueueCompletedGame(bob, gameB, completedState());
    let releaseAlice: (() => void) | undefined;
    const delivered: Array<{ ownerKey: string; gameId: string }> = [];
    const coordinator = createStatsOutboxCoordinator(
      (record, signal) =>
        new Promise<void>((resolve, reject) => {
          if (record.ownerKey === alice) {
            releaseAlice = resolve;
            signal.addEventListener('abort', () => reject(new DOMException('Owner changed', 'AbortError')), { once: true });
            return;
          }
          delivered.push({ ownerKey: record.ownerKey, gameId: record.gameId });
          resolve();
        })
    );

    coordinator.setOwner(alice);
    const first = coordinator.flush(true);
    const duplicateTrigger = coordinator.flush(true);
    expect(duplicateTrigger).toBe(first);
    await vi.waitFor(() => expect(releaseAlice).toBeTypeOf('function'));
    coordinator.setOwner(bob);
    const switched = coordinator.flush(true);
    releaseAlice?.();
    await switched;

    expect(delivered).toEqual([{ ownerKey: bob, gameId: gameB }]);
    expect((await listStatsOutbox(alice)).map((record) => record.gameId)).toEqual([gameA]);
    expect(await listStatsOutbox(bob)).toEqual([]);
    coordinator.dispose();
  });

  it('drains a force trigger queued while the current single-flight run settles', async () => {
    const ownerKey = soloOwnerKey('alice');
    const future = Date.now() + 60_000;
    await enqueueCompletedGame(ownerKey, gameA, completedState(), () => future);
    const delivered: string[] = [];
    const coordinator = createStatsOutboxCoordinator(async (record) => {
      delivered.push(record.gameId);
    });
    coordinator.setOwner(ownerKey);

    const initial = coordinator.flush(false);
    const settleTrigger = Promise.resolve().then(() => coordinator.flush(true));
    await Promise.all([initial, settleTrigger]);

    expect(delivered).toEqual([gameA]);
    expect(await listStatsOutbox(ownerKey)).toEqual([]);
    coordinator.dispose();
  });
});
