import {
  cancelDiscardSelection,
  chooseDiscard,
  createGame,
  createGameForPlayers,
  discardDrawnAndReveal,
  drawBlind,
  getBestAiMove,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import type { Card, GameState, Player } from '../../../src/types';

function card(id: string, value: number, faceUp = true, removed = false): Card {
  return { id, value, faceUp, removed };
}

function grid(values: number[], hiddenIndexes: number[] = [], removedIndexes: number[] = []): Card[] {
  return Array.from({ length: 12 }, (_, index) =>
    card(
      `card-${index}-${values[index] ?? 1}`,
      values[index] ?? 1,
      !hiddenIndexes.includes(index),
      removedIndexes.includes(index)
    )
  );
}

function player(
  id: string,
  name: string,
  values: number[],
  options: { hidden?: number[]; removed?: number[]; totalScore?: number; kind?: Player['kind'] } = {}
): Player {
  const playerGrid = grid(values, options.hidden, options.removed);
  return {
    id,
    name,
    kind: options.kind ?? 'human',
    grid: playerGrid,
    totalScore: options.totalScore ?? 0,
    roundScore: playerGrid.reduce(
      (total, item) => total + (item.faceUp && !item.removed ? item.value : 0),
      0
    )
  };
}

function stateWith(players: Player[], overrides: Partial<GameState> = {}): GameState {
  return {
    players,
    drawPile: [card('draw', 2, false)],
    discardPile: [card('discard', 3)],
    currentPlayerIndex: 0,
    phase: 'choose-source',
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: {},
    roundHistory: [],
    ...overrides
  };
}

function replacementState(players: Player[], overrides: Partial<GameState> = {}): GameState {
  return stateWith(players, {
    phase: 'choose-replacement',
    selectedSource: 'draw',
    drawnCard: card('replacement', 0),
    drawPile: [],
    ...overrides
  });
}

describe('round lifecycle and scoring', () => {
  it('normalizes solo rosters and preserves supplied players and scores', () => {
    expect(startFreshGame({ aiOpponentCount: Number.NaN, random: createSeededRandom(1) }).players).toHaveLength(2);
    expect(startFreshGame({ aiOpponentCount: -20, random: createSeededRandom(1) }).players).toHaveLength(2);
    expect(startFreshGame({ aiOpponentCount: 99.8, random: createSeededRandom(1) }).players).toHaveLength(8);

    const existing = [player('human', 'You', Array(12).fill(1), { totalScore: 12 }), player('bot', 'Bot', Array(12).fill(2), { totalScore: 34, kind: 'ai' })];
    const continued = createGame(existing, 3, 'bot', { random: createSeededRandom(2) });
    expect(continued.players.map(({ id, totalScore }) => ({ id, totalScore }))).toEqual([
      { id: 'human', totalScore: 12 },
      { id: 'bot', totalScore: 34 }
    ]);

    const resized = createGame(existing, 2, null, { aiOpponentCount: 1, random: createSeededRandom(3) });
    expect(resized.players[0]).toMatchObject({ id: 'human', totalScore: 12 });
  });

  it('auto-reveals openings, honors a later-round starter, and falls back to the visible-score leader', () => {
    const preferred = createGameForPlayers(
      [{ id: 'ada', name: 'Ada', kind: 'human' }, { id: 'grace', name: 'Grace', kind: 'human' }],
      2,
      'grace',
      true,
      createSeededRandom(4)
    );
    expect(preferred.phase).toBe('choose-source');
    expect(preferred.players[preferred.currentPlayerIndex].id).toBe('grace');
    expect(preferred.players.every((item) => item.grid.filter((item) => item.faceUp).length === 2)).toBe(true);

    const fallback = createGameForPlayers(
      [{ id: 'ada', name: 'Ada', kind: 'human' }, { id: 'grace', name: 'Grace', kind: 'human' }],
      2,
      'missing',
      true,
      () => 0
    );
    const visibleScores = fallback.players.map((item) => item.roundScore);
    expect(visibleScores[fallback.currentPlayerIndex]).toBe(Math.max(...visibleScores));
  });

  it('rejects invalid opening and turn actions without mutating state', () => {
    const opening = createGameForPlayers(
      [{ id: 'ada', name: 'Ada', kind: 'human' }, { id: 'grace', name: 'Grace', kind: 'human' }],
      1,
      null,
      false,
      createSeededRandom(5)
    );
    const active = opening.players[opening.currentPlayerIndex];
    active.grid[0] = { ...active.grid[0], faceUp: true };
    active.grid[1] = { ...active.grid[1], removed: true };
    expect(revealOpeningCard(opening, 0)).toBe(opening);
    expect(revealOpeningCard(opening, 1)).toBe(opening);
    expect(revealOpeningCard(opening, 99)).toBe(opening);
    const alreadyDone = { ...opening, players: opening.players.map((item, index) => index === opening.currentPlayerIndex ? { ...item, grid: item.grid.map((value, cardIndex) => cardIndex < 3 ? { ...value, faceUp: true, removed: false } : value) } : item) };
    expect(revealOpeningCard(alreadyDone, 2)).toBe(alreadyDone);

    const idle = stateWith([player('ada', 'Ada', Array(12).fill(1))], { phase: 'round-over' });
    expect(revealOpeningCard(idle, 0)).toBe(idle);
    expect(chooseDiscard(idle)).toBe(idle);
    expect(drawBlind(idle)).toBe(idle);
    expect(cancelDiscardSelection(idle)).toBe(idle);
    expect(replaceCard(idle, 0)).toBe(idle);
    expect(discardDrawnAndReveal(idle, 0)).toBe(idle);
  });

  it('rejects missing or removed replacement targets and missing sources', () => {
    const active = player('ada', 'Ada', Array(12).fill(1), { hidden: [0], removed: [1] });
    const drawn = replacementState([active]);
    expect(replaceCard(drawn, 99)).toBe(drawn);
    expect(replaceCard(drawn, 1)).toBe(drawn);
    expect(discardDrawnAndReveal(drawn, 99)).toBe(drawn);
    expect(discardDrawnAndReveal(drawn, 1)).toBe(drawn);
    expect(discardDrawnAndReveal(drawn, 2)).toBe(drawn);

    const missingDrawn = { ...drawn, drawnCard: null };
    expect(replaceCard(missingDrawn, 0)).toBe(missingDrawn);
    expect(discardDrawnAndReveal(missingDrawn, 0)).toBe(missingDrawn);

    const missingDiscard = { ...drawn, selectedSource: 'discard' as const, drawnCard: null, discardPile: [] };
    expect(replaceCard(missingDiscard, 0)).toBe(missingDiscard);
  });

  it('clears matching columns into the discard pile and advances ordinary turns', () => {
    const clearing = player('ada', 'Ada', [5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 5], { hidden: [8] });
    const other = player('grace', 'Grace', Array(12).fill(4), { hidden: [0] });
    const result = replaceCard(replacementState([clearing, other], { drawnCard: card('five', 5) }), 8);
    expect(result.players[0].grid.filter((item) => item.removed)).toHaveLength(3);
    expect(result.discardPile.slice(0, 3).map((item) => item.value)).toEqual([5, 5, 5]);
    expect(result.currentPlayerIndex).toBe(1);
    expect(result.phase).toBe('choose-source');
  });

  it('gives every opponent one final turn, then scores and doubles a tied closer', () => {
    const closer = player('james', 'James', [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { hidden: [11] });
    const second = player('grace', 'Grace', [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { hidden: [11] });
    const third = player('you', 'You', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { hidden: [11] });

    let state = replaceCard(replacementState([closer, second, third]), 11);
    expect(state).toMatchObject({ roundCloserId: 'james', finalTurnPlayerIds: ['grace', 'you'], currentPlayerIndex: 1 });

    state = replaceCard(replacementState(state.players, {
      currentPlayerIndex: 1,
      roundCloserId: state.roundCloserId,
      finalTurnPlayerIds: state.finalTurnPlayerIds,
      roundHistory: state.roundHistory
    }), 11);
    expect(state.finalTurnPlayerIds).toEqual(['you']);
    expect(state.currentPlayerIndex).toBe(2);

    state = replaceCard(replacementState(state.players, {
      currentPlayerIndex: 2,
      roundCloserId: state.roundCloserId,
      finalTurnPlayerIds: state.finalTurnPlayerIds,
      roundHistory: state.roundHistory
    }), 11);
    expect(state.phase).toBe('round-over');
    expect(state.players.find((item) => item.id === 'james')?.roundScore).toBe(66);
    expect(state.log[0]).toContain("James' round score doubled to 66");
    expect(state.roundHistory).toHaveLength(1);
  });

  it('scores a one-player close immediately, preserves removed cards, and declares game over at 100', () => {
    const solo = player('human', 'You', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0], {
      hidden: [11],
      removed: [0],
      totalScore: 40
    });
    const result = replaceCard(replacementState([solo], { drawnCard: card('winning', 10) }), 11);
    expect(result.phase).toBe('game-over');
    expect(result.winnerId).toBe('human');
    expect(result.players[0].grid[0].removed).toBe(true);
    expect(result.players[0].totalScore).toBeGreaterThanOrEqual(100);
    expect(result.log[0]).not.toContain('round score doubled');
  });

  it('uses the player-facing possessive when You ties and doubles at round end', () => {
    const values = [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const closer = player('human', 'You', values, { hidden: [11] });
    const opponent = player('ada', 'Ada', values, { hidden: [11] });
    let result = replaceCard(replacementState([closer, opponent]), 11);
    result = replaceCard(replacementState(result.players, {
      currentPlayerIndex: 1,
      roundCloserId: result.roundCloserId,
      finalTurnPlayerIds: result.finalTurnPlayerIds,
      roundHistory: undefined as never
    }), 11);
    expect(result.log[0]).toContain('Your round score doubled');
    expect(result.roundHistory).toHaveLength(1);
  });

  it('starts a next round safely when legacy state has no round history', () => {
    const legacy = stateWith([player('human', 'You', Array(12).fill(1))], {
      roundHistory: undefined as never
    });
    expect(startNextRound(legacy, createSeededRandom(9)).roundHistory).toEqual([]);
  });

  it('uses safe fallbacks for stale final-turn and closer identifiers', () => {
    const active = player('ada', 'Ada', Array(12).fill(-1), { hidden: [0] });
    const missingNext = replaceCard(replacementState([active], {
      roundCloserId: 'ada',
      finalTurnPlayerIds: ['ada', 'missing']
    }), 0);
    expect(missingNext.currentPlayerIndex).toBe(0);
    expect(missingNext.log[0]).toContain('Next player');

    const missingCloser = replaceCard(replacementState([active], {
      roundCloserId: 'missing',
      finalTurnPlayerIds: ['ada']
    }), 0);
    expect(missingCloser.phase).toBe('round-over');
    expect(missingCloser.nextStarterId).toBe('ada');
  });
});

describe('AI fallback and endgame choices', () => {
  it('draws without a discard and falls back to the first available replacement', () => {
    const active = player('ai', 'Bot', Array(12).fill(2), { kind: 'ai', removed: [0, 1] });
    const noDiscard = stateWith([active], { discardPile: [] });
    expect(getBestAiMove(noDiscard)).toEqual({ action: 'draw' });

    const selectedDiscard = stateWith([active], {
      phase: 'choose-replacement',
      selectedSource: 'discard',
      discardPile: []
    });
    expect(getBestAiMove(selectedDiscard)).toEqual({ action: 'replace', index: 2 });

    const allRemoved = player('ai', 'Bot', Array(12).fill(2), { kind: 'ai', removed: Array.from({ length: 12 }, (_, index) => index) });
    expect(getBestAiMove(stateWith([allRemoved], { phase: 'choose-replacement' }))).toEqual({ action: 'replace', index: 0 });
  });

  it('places a useful blind draw and replaces when no hidden reveal remains', () => {
    const active = player('ai', 'Bot', [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], { kind: 'ai' });
    const useful = replacementState([active], { drawnCard: card('low', -2), roundCloserId: 'other', finalTurnPlayerIds: ['ai'] });
    expect(getBestAiMove(useful)).toEqual({ action: 'replace', index: 0 });

    const poor = replacementState([active], { drawnCard: card('high', 12) });
    expect(getBestAiMove(poor).action).toBe('replace');
  });
});
