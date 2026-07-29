import fc from 'fast-check';
import {
  cancelDiscardSelection,
  chooseDiscard,
  createMultiplayerGame,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} from '../../../src/game';
import { getBestAiMove } from '../../../src/aiProjection';
import { createSeededRandom } from '../../../src/runtime';
import type { Card, GameState, Player } from '../../../src/types';

const expectedValueCounts = new Map<number, number>([
  [-2, 5],
  [-1, 10],
  [0, 15],
  ...Array.from({ length: 12 }, (_, index) => [index + 1, 10] as const)
]);

function cardsIn(state: GameState): Card[] {
  return [
    ...state.players.flatMap((player) => player.grid.filter((card) => !card.removed)),
    ...state.drawPile,
    ...state.discardPile,
    ...(state.drawnCard ? [state.drawnCard] : [])
  ];
}

function assertDeckInvariant(state: GameState) {
  const cards = cardsIn(state);
  expect(cards).toHaveLength(150);
  expect(new Set(cards.map((card) => card.id)).size).toBe(150);
  for (const [value, count] of expectedValueCounts) {
    expect(cards.filter((card) => card.value === value)).toHaveLength(count);
  }
}

function finishOpening(state: GameState): GameState {
  let current = state;
  while (current.phase === 'opening-reveal') {
    const player = current.players[current.currentPlayerIndex];
    const index = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    current = revealOpeningCard(current, index);
  }
  return current;
}

function card(id: string, value: number, faceUp = true, removed = false): Card {
  return { id, value, faceUp, removed };
}

function gridWith(overrides: Array<[number, number, boolean?, boolean?]>): Card[] {
  const grid = Array.from({ length: 12 }, (_, index) => card(`hidden-${index}`, 7, false));
  for (const [index, value, faceUp = true, removed = false] of overrides) {
    grid[index] = card(`card-${index}-${value}-${faceUp}-${removed}`, value, faceUp, removed);
  }
  return grid;
}

function player(id: string, name: string, kind: Player['kind'], grid: Card[]): Player {
  return {
    id,
    name,
    kind,
    grid,
    totalScore: 0,
    roundScore: grid.reduce((sum, item) => sum + (item.faceUp && !item.removed ? item.value : 0), 0)
  };
}

function aiState(options: {
  grid: Card[];
  phase?: GameState['phase'];
  selectedSource?: GameState['selectedSource'];
  discardValue?: number | null;
  drawnValue?: number | null;
  roundCloserId?: string | null;
  finalTurnPlayerIds?: string[];
}): GameState {
  const {
    grid,
    phase = 'choose-source',
    selectedSource = null,
    discardValue = 6,
    drawnValue = null,
    roundCloserId = null,
    finalTurnPlayerIds = []
  } = options;
  return {
    players: [player('ai', 'Luke', 'ai', grid), player('human', 'You', 'human', gridWith([[0, 2], [1, 3]]))],
    drawPile: [card('deck-1', 4, false), card('deck-2', 9, false), card('deck-3', -1, false)],
    discardPile: discardValue === null ? [] : [card(`discard-${discardValue}`, discardValue)],
    currentPlayerIndex: 0,
    phase,
    selectedSource,
    drawnCard: drawnValue === null ? null : card(`drawn-${drawnValue}`, drawnValue),
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId,
    finalTurnPlayerIds,
    openingRevealCounts: {},
    roundHistory: []
  };
}

describe('deterministic deck and turn engine', () => {
  it('replays the same seed exactly and changes with a different seed', () => {
    const first = startFreshGame({ aiOpponentCount: 3, random: createSeededRandom(42) });
    const replay = startFreshGame({ aiOpponentCount: 3, random: createSeededRandom(42) });
    const different = startFreshGame({ aiOpponentCount: 3, random: createSeededRandom(43) });

    expect(replay).toEqual(first);
    expect(different).not.toEqual(first);
    assertDeckInvariant(first);
  });

  it('uses subject-aware opening reveal copy at game creation and seat transitions', () => {
    const solo = startFreshGame({ random: createSeededRandom(42) });
    expect(solo.log[0]).toBe('Your turn: reveal 2 cards.');

    let multiplayer = createMultiplayerGame(
      [{ id: 'ada', name: 'Ada' }, { id: 'you', name: 'You' }],
      1,
      null,
      createSeededRandom(7)
    );
    expect(multiplayer.log[0]).toBe("Ada's turn: reveal 2 cards.");
    multiplayer = revealOpeningCard(multiplayer, 0);
    multiplayer = revealOpeningCard(multiplayer, 1);
    expect(multiplayer.log[0]).toBe(
      'Ada finished. Your turn: reveal 2 cards.'
    );
  });

  it('preserves deck composition for every supported multiplayer size and seed', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 2, max: 8 }), (seed, playerCount) => {
        const state = createMultiplayerGame(
          Array.from({ length: playerCount }, (_, index) => ({ id: `p-${index}`, name: `Player ${index}` })),
          1,
          null,
          createSeededRandom(seed)
        );
        assertDeckInvariant(state);
        expect(state.phase).toBe('opening-reveal');
      }),
      { numRuns: 40 }
    );
  });

  it('completes manual opening reveals and supports reversible discard selection', () => {
    let state = createMultiplayerGame(
      [{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }],
      1,
      null,
      createSeededRandom(7)
    );
    expect(revealOpeningCard(state, -1)).toBe(state);
    state = finishOpening(state);
    expect(state.phase).toBe('choose-source');
    expect(Object.values(state.openingRevealCounts)).toEqual([2, 2]);

    const selected = chooseDiscard(state);
    expect(selected).toMatchObject({ phase: 'choose-replacement', selectedSource: 'discard' });
    expect(cancelDiscardSelection(selected)).toMatchObject({ phase: 'choose-source', selectedSource: null });
    expect(cancelDiscardSelection(state)).toBe(state);
  });

  it('keeps prototype-like player ids as own count keys without changing object prototypes or scores', () => {
    const objectPrototypeKeys = Reflect.ownKeys(Object.prototype);
    let state = createMultiplayerGame(
      [{ id: '__proto__', name: 'Prototype' }, { id: 'constructor', name: 'Constructor' }],
      1,
      null,
      createSeededRandom(19)
    );

    expect(Object.getPrototypeOf(state.openingRevealCounts)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(state.openingRevealCounts, '__proto__')?.value).toBe(0);
    expect(Object.getOwnPropertyDescriptor(state.openingRevealCounts, 'constructor')?.value).toBe(0);

    state = finishOpening(state);

    expect(state.phase).toBe('choose-source');
    expect(Object.getPrototypeOf(state.openingRevealCounts)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(state.openingRevealCounts, '__proto__')?.value).toBe(2);
    expect(Object.getOwnPropertyDescriptor(state.openingRevealCounts, 'constructor')?.value).toBe(2);
    expect(state.players.every((item) => item.roundScore === item.grid.filter((card) => card.faceUp && !card.removed).reduce((total, card) => total + card.value, 0))).toBe(true);
    expect(Reflect.ownKeys(Object.prototype)).toEqual(objectPrototypeKeys);
  });

  it('supports blind draw placement, discard-and-reveal, and deterministic recycle', () => {
    const opened = finishOpening(
      createMultiplayerGame(
        [{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }],
        1,
        null,
        createSeededRandom(11)
      )
    );
    const drawn = drawBlind(opened, createSeededRandom(1));
    expect(drawn).toMatchObject({ phase: 'choose-replacement', selectedSource: 'draw' });
    const hiddenIndex = drawn.players[drawn.currentPlayerIndex].grid.findIndex((item) => !item.faceUp);
    const revealed = discardDrawnAndReveal(drawn, hiddenIndex);
    expect(revealed.phase).not.toBe('choose-replacement');
    assertDeckInvariant(revealed);

    const drawnAgain = drawBlind(opened, createSeededRandom(2));
    const replaced = replaceCard(drawnAgain, 0);
    expect(replaced.phase).not.toBe('choose-replacement');
    assertDeckInvariant(replaced);

    const recycleBase: GameState = {
      ...opened,
      drawPile: [],
      discardPile: [card('top', 1), card('recycle-a', 4), card('recycle-b', 8)]
    };
    const recycled = drawBlind(recycleBase, () => 0);
    expect(recycled.drawnCard?.id).toBe('recycle-b');
    expect(recycled.discardPile.map((item) => item.id)).toEqual(['top']);
  });

  it('starts the next round with stable scores and retained history', () => {
    const state = startFreshGame({ aiOpponentCount: 2, random: createSeededRandom(19) });
    state.roundHistory.push({ round: 1, closerId: 'human', scores: [] });
    const next = startNextRound(state, createSeededRandom(20));
    expect(next.round).toBe(2);
    expect(next.roundHistory).toEqual(state.roundHistory);
    expect(next.players.map((item) => item.id)).toEqual(state.players.map((item) => item.id));
  });
});

describe('AI choices', () => {
  it('takes a low discard and targets the highest visible card', () => {
    const state = aiState({ grid: gridWith([[0, 12], [1, 2], [2, 7, false]]), discardValue: 0 });
    expect(getBestAiMove(state)).toEqual({ action: 'discard' });
    const move = getBestAiMove(chooseDiscard(state));
    expect(move).toEqual({ action: 'replace', index: 0 });
  });

  it('draws past a poor discard and reveals after a poor blind draw', () => {
    expect(getBestAiMove(aiState({ grid: gridWith([[0, 9], [1, 3]]), discardValue: 11 }))).toEqual({ action: 'draw' });
    const state = aiState({
      grid: gridWith([[0, 12, false, true], [1, 7, false], ...Array.from({ length: 10 }, (_, index) => [index + 2, 0] as [number, number])]),
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnValue: 10
    });
    expect(getBestAiMove(state)).toEqual({ action: 'reveal', index: 1 });
  });

  it('values a matching column and never targets removed cards', () => {
    const matching = aiState({ grid: gridWith([[0, 5], [4, 5], [8, 7, false], [1, 9]]), discardValue: 5 });
    expect(getBestAiMove(matching)).toEqual({ action: 'discard' });
    expect(getBestAiMove(chooseDiscard(matching))).toEqual({ action: 'replace', index: 8 });

    const removed = aiState({
      grid: gridWith([[0, 12, true, true], [1, 10], [2, 7, false]]),
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnValue: -1
    });
    expect(getBestAiMove(removed)).toEqual({ action: 'replace', index: 1 });
  });
});
