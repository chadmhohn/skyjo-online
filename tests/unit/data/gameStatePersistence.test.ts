import {
  createMultiplayerGame,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import type { GameState } from '../../../src/types';
import {
  PERSISTED_GAME_STATE_LIMITS,
  PersistedGameStateValidationError,
  normalizePersistedGameState,
  validatePersistedGameState
} from '../../../server-game-state-validation.mjs';

type RoomStatus = 'waiting' | 'playing' | 'finished';
type ValidationContext = {
  rosterPlayerIds: string[];
  roomStatus: RoomStatus;
  readyForNextRoundPlayerIds: string[];
};
type MutableGameState = GameState & Record<string, unknown>;
type InvalidMutation = (state: MutableGameState, context: ValidationContext) => void;

function roster(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`
  }));
}

function finishOpening(initial: GameState): GameState {
  let state = initial;
  while (state.phase === 'opening-reveal') {
    const active = state.players[state.currentPlayerIndex];
    const index = active.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (index < 0) throw new Error('Fixture could not find an opening card.');
    state = revealOpeningCard(state, index);
  }
  return state;
}

function activeBlindDrawFixture(playerCount = 2): GameState {
  const source = finishOpening(createMultiplayerGame(roster(playerCount), 1, null, createSeededRandom(0x51a7e)));
  const state = drawBlind(source, createSeededRandom(0xb11d));
  if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
    throw new Error('Fixture did not produce an active blind draw.');
  }
  return state;
}

function swapMatchingCardsIntoColumn(state: GameState, playerIndex: number): string[] {
  const byValue = new Map<number, typeof state.drawPile>();
  for (const card of state.drawPile) {
    const matches = byValue.get(card.value) ?? [];
    matches.push(card);
    byValue.set(card.value, matches);
  }
  const matching = [...byValue.values()].find((cards) => cards.length >= 3)?.slice(0, 3);
  if (!matching) throw new Error('Fixture could not find three matching physical cards.');

  const targetIndexes = [0, 4, 8];
  const displaced = targetIndexes.map((index) => state.players[playerIndex].grid[index]);
  for (const [index, targetIndex] of targetIndexes.entries()) {
    const physicalCard = matching[index];
    const drawIndex = state.drawPile.findIndex((card) => card.id === physicalCard.id);
    if (drawIndex < 0) throw new Error('Fixture matching card left the draw pile.');
    state.players[playerIndex].grid[targetIndex] = { ...physicalCard, faceUp: false, removed: false };
    state.drawPile[drawIndex] = { ...displaced[index], faceUp: false, removed: false };
  }
  return matching.map((card) => card.id);
}

function scoringFixture(gameOver: boolean): { state: GameState; newlyClearedIds: string[] } {
  const state = finishOpening(createMultiplayerGame(roster(), 1, null, createSeededRandom(0x600d)));
  const activeIndex = state.currentPlayerIndex;
  const closerIndex = (activeIndex + 1) % state.players.length;
  const newlyClearedIds = swapMatchingCardsIntoColumn(state, closerIndex);
  if (gameOver) state.players[closerIndex].totalScore = 100;

  const blindDraw = drawBlind(state, createSeededRandom(0xf1a1));
  const finalTurn = {
    ...blindDraw,
    roundCloserId: blindDraw.players[closerIndex].id,
    finalTurnPlayerIds: [blindDraw.players[activeIndex].id]
  };
  const targetIndex = finalTurn.players[activeIndex].grid.findIndex((card) => !card.removed);
  const completed = replaceCard(finalTurn, targetIndex);
  const expectedPhase = gameOver ? 'game-over' : 'round-over';
  if (completed.phase !== expectedPhase) {
    throw new Error(`Fixture produced ${completed.phase}, expected ${expectedPhase}.`);
  }
  return { state: completed, newlyClearedIds };
}

function contextFor(state: GameState, readyForNextRoundPlayerIds: string[] = []): ValidationContext {
  return {
    rosterPlayerIds: state.players.map((player) => player.id),
    roomStatus: state.phase === 'game-over' ? 'finished' : 'playing',
    readyForNextRoundPlayerIds
  };
}

function mutableClone(state: GameState): MutableGameState {
  return structuredClone(state) as MutableGameState;
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('persisted internal GameState validation', () => {
  it.each([2, 4, 8])('accepts and clones a v0.1.1 active blind-draw state for %i players', (playerCount) => {
    const source = activeBlindDrawFixture(playerCount);
    const normalized = normalizePersistedGameState(source, contextFor(source));

    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
    expect(normalized.players[0]).not.toBe(source.players[0]);
    expect(normalized.players[0].grid[0]).not.toBe(source.players[0].grid[0]);
    expect(normalized.drawPile.map((card: { id: string }) => card.id)).toEqual(source.drawPile.map((card) => card.id));
    expect(normalized.discardPile.map((card: { id: string }) => card.id)).toEqual(source.discardPile.map((card) => card.id));

    const originalValue = source.players[0].grid[0].value;
    normalized.players[0].grid[0].value = originalValue === 12 ? 11 : 12;
    expect(source.players[0].grid[0].value).toBe(originalValue);
    expect(validatePersistedGameState(source, contextFor(source))).toBe(true);
  });

  it.each([
    ['round-over', false] as const,
    ['game-over', true] as const
  ])('accepts a real v0.1.1 %s state with finishRound-only cleared tombstones', (_label, gameOver) => {
    const { state, newlyClearedIds } = scoringFixture(gameOver);
    const readyIds = state.players.slice(0, gameOver ? 2 : 1).map((player) => player.id);
    const normalized = normalizePersistedGameState(state, contextFor(state, readyIds));

    expect(normalized).toEqual(state);
    for (const id of newlyClearedIds) {
      const occurrences = [
        ...normalized.players.flatMap((player: { grid: Array<{ id: string; removed: boolean }> }) => player.grid),
        ...normalized.drawPile,
        ...normalized.discardPile,
        ...(normalized.drawnCard ? [normalized.drawnCard] : [])
      ].filter((card: { id: string }) => card.id === id);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].removed).toBe(true);
    }
  });

  it('accepts opening, final-turn, and legitimately doubled closer lifecycle branches', () => {
    const opening = createMultiplayerGame(roster(), 1, null, createSeededRandom(1));
    expect(normalizePersistedGameState(opening, contextFor(opening))).toEqual(opening);

    const opened = finishOpening(opening);
    const activeIndex = opened.currentPlayerIndex;
    const closerIndex = (activeIndex + 1) % opened.players.length;
    const blindDraw = drawBlind(opened, createSeededRandom(0xabc));
    const finalTurn = {
      ...blindDraw,
      roundCloserId: blindDraw.players[closerIndex].id,
      finalTurnPlayerIds: [blindDraw.players[activeIndex].id]
    };
    expect(normalizePersistedGameState(finalTurn, contextFor(finalTurn))).toEqual(finalTurn);

    const targetIndex = finalTurn.players[activeIndex].grid.findIndex((card) => !card.removed);
    const completed = replaceCard(finalTurn, targetIndex);
    expect(completed.phase).toBe('game-over');
    const closer = completed.players[closerIndex];
    const visibleCloserScore = closer.grid.reduce(
      (total, card) => total + (card.faceUp && !card.removed ? card.value : 0),
      0
    );
    expect(closer.roundScore).toBe(visibleCloserScore * 2);
    expect(normalizePersistedGameState(completed, contextFor(completed))).toEqual(completed);
  });

  const activeMutations: Array<[string, InvalidMutation]> = [
    ['unknown game-state key', (state) => { state.unexpected = true; }],
    ['missing game-state key', (state) => { delete record(state).log; }],
    ['non-array players', (state) => { state.players = {} as never; }],
    ['missing player', (state) => { state.players.pop(); }],
    ['extra player', (state) => { state.players.push(structuredClone(state.players[0])); }],
    ['roster order mismatch', (_state, context) => { context.rosterPlayerIds.reverse(); }],
    ['duplicate player id', (state) => { state.players[1].id = state.players[0].id; }],
    ['unknown player key', (state) => { record(state.players[0]).unexpected = true; }],
    ['missing player key', (state) => { delete record(state.players[0]).kind; }],
    ['oversized player id', (state) => { state.players[0].id = 'p'.repeat(PERSISTED_GAME_STATE_LIMITS.playerIdLength + 1); }],
    ['empty player name', (state) => { state.players[0].name = ''; }],
    ['non-finite score', (state) => { state.players[0].totalScore = Number.POSITIVE_INFINITY; }],
    ['fractional score', (state) => { state.players[0].roundScore += 0.5; }],
    ['wrong visible score', (state) => { state.players[0].roundScore += 1; }],
    ['short grid', (state) => { state.players[0].grid.pop(); }],
    ['long grid', (state) => { state.players[0].grid.push(structuredClone(state.players[0].grid[0])); }],
    ['unknown card key', (state) => { record(state.players[0].grid[0]).unexpected = true; }],
    ['missing card key', (state) => { delete record(state.players[0].grid[0]).faceUp; }],
    ['invalid card value', (state) => { state.players[0].grid[0].value = 13; }],
    ['fractional card value', (state) => { state.players[0].grid[0].value = 1.5; }],
    ['invalid card boolean', (state) => { record(state.players[0].grid[0]).faceUp = 'yes'; }],
    ['oversized card id', (state) => { state.players[0].grid[0].id = 'c'.repeat(PERSISTED_GAME_STATE_LIMITS.cardIdLength + 1); }],
    ['duplicate live card id', (state) => { state.players[0].grid[1].id = state.players[0].grid[0].id; }],
    ['changed physical-card value', (state) => {
      const card = state.players[0].grid[0];
      card.value = card.value === 12 ? 11 : card.value + 1;
    }],
    ['missing physical card', (state) => { state.drawPile.pop(); }],
    ['oversized draw pile', (state) => {
      state.drawPile = Array.from({ length: PERSISTED_GAME_STATE_LIMITS.cards + 1 }, (_, index) => ({
        ...state.drawPile[0],
        id: `overflow-${index}`
      }));
    }],
    ['face-up draw card', (state) => { state.drawPile[0].faceUp = true; }],
    ['face-down discard card', (state) => { state.discardPile[0].faceUp = false; }],
    ['removed drawn card', (state) => { if (state.drawnCard) state.drawnCard.removed = true; }],
    ['invalid current player', (state) => { state.currentPlayerIndex = state.players.length; }],
    ['unknown phase', (state) => { state.phase = 'paused' as never; }],
    ['draw replacement without drawn card', (state) => { state.drawnCard = null; }],
    ['source phase retaining selection', (state) => { state.phase = 'choose-source'; }],
    ['winner during active play', (state) => { state.winnerId = state.players[0].id; }],
    ['foreign winner', (state) => { state.winnerId = 'foreign-player'; }],
    ['foreign closer', (state) => { state.roundCloserId = 'foreign-player'; }],
    ['foreign final-turn player', (state) => { state.finalTurnPlayerIds = ['foreign-player']; }],
    ['duplicate final-turn player', (state) => {
      state.roundCloserId = state.players[0].id;
      state.finalTurnPlayerIds = [state.players[1].id, state.players[1].id];
    }],
    ['unknown opening count', (state) => { record(state.openingRevealCounts).foreign = 2; }],
    ['missing opening count', (state) => { delete record(state.openingRevealCounts)[state.players[0].id]; }],
    ['invalid opening count', (state) => { state.openingRevealCounts[state.players[0].id] = 3; }],
    ['oversized log', (state) => { state.log = Array(PERSISTED_GAME_STATE_LIMITS.logEntries + 1).fill('entry'); }],
    ['oversized log entry', (state) => { state.log = ['x'.repeat(PERSISTED_GAME_STATE_LIMITS.logEntryLength + 1)]; }],
    ['invalid round', (state) => { state.round = 0; }],
    ['unexpected history in round one', (state) => {
      state.roundHistory = [{ round: 1, closerId: state.players[0].id, scores: [] }];
    }],
    ['oversized history', (state) => {
      state.roundHistory = Array.from({ length: PERSISTED_GAME_STATE_LIMITS.historyEntries + 1 }, (_, index) => ({
        round: index + 1,
        closerId: state.players[0].id,
        scores: []
      }));
    }],
    ['waiting status with state', (_state, context) => { context.roomStatus = 'waiting'; }],
    ['finished status with active state', (_state, context) => { context.roomStatus = 'finished'; }],
    ['ready id during active play', (state, context) => { context.readyForNextRoundPlayerIds = [state.players[0].id]; }],
    ['foreign ready id', (_state, context) => { context.readyForNextRoundPlayerIds = ['foreign-player']; }],
    ['duplicate ready id', (state, context) => {
      context.readyForNextRoundPlayerIds = [state.players[0].id, state.players[0].id];
    }]
  ];

  it.each(activeMutations)('rejects active-state mutation: %s', (_label, mutate) => {
    const state = mutableClone(activeBlindDrawFixture());
    const context = contextFor(state);
    mutate(state, context);

    expect(validatePersistedGameState(state, context)).toBe(false);
    expect(() => normalizePersistedGameState(state, context)).toThrow(PersistedGameStateValidationError);
  });

  const scoringMutations: Array<[string, boolean, InvalidMutation]> = [
    ['round-over with finished status', false, (_state, context) => { context.roomStatus = 'finished'; }],
    ['game-over with playing status', true, (_state, context) => { context.roomStatus = 'playing'; }],
    ['missing next starter', false, (state) => { state.nextStarterId = null; }],
    ['next starter differs from closer', false, (state) => {
      state.nextStarterId = state.players.find((player) => player.id !== state.nextStarterId)?.id ?? null;
    }],
    ['round closer remains set', false, (state) => { state.roundCloserId = state.players[0].id; }],
    ['final turns remain', false, (state) => { state.finalTurnPlayerIds = [state.players[0].id]; }],
    ['face-down completed grid card', false, (state) => {
      const card = state.players.flatMap((player) => player.grid).find((candidate) => !candidate.removed);
      if (card) card.faceUp = false;
    }],
    ['history total disagrees', false, (state) => { state.roundHistory[0].scores[0].totalScore += 1; }],
    ['history score order differs', false, (state) => { state.roundHistory[0].scores.reverse(); }],
    ['history closer is foreign', false, (state) => { state.roundHistory[0].closerId = 'foreign-player'; }],
    ['history entry has unknown key', false, (state) => { record(state.roundHistory[0]).unexpected = true; }],
    ['history score has unknown key', false, (state) => { record(state.roundHistory[0].scores[0]).unexpected = true; }],
    ['round-over crosses game threshold', false, (state) => {
      state.players[0].totalScore = 100;
      state.roundHistory[0].scores[0].totalScore = 100;
    }],
    ['game-over missing winner', true, (state) => { state.winnerId = null; }],
    ['game-over wrong winner', true, (state) => {
      state.winnerId = state.players.find((player) => player.id !== state.winnerId)?.id ?? null;
    }],
    ['game-over below threshold', true, (state) => {
      for (const [index, player] of state.players.entries()) {
        player.totalScore = player.roundScore;
        state.roundHistory[0].scores[index].totalScore = player.totalScore;
      }
    }]
  ];

  it.each(scoringMutations)('rejects scoring-state mutation: %s', (_label, gameOver, mutate) => {
    const state = mutableClone(scoringFixture(gameOver).state);
    const context = contextFor(state);
    mutate(state, context);

    expect(validatePersistedGameState(state, context)).toBe(false);
    expect(() => normalizePersistedGameState(state, context)).toThrow(PersistedGameStateValidationError);
  });
});
