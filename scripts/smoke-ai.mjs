import assert from 'node:assert/strict';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  getBestAiMove,
  replaceCard
} from '../server-dist/game.js';

function card(id, value, faceUp = true, removed = false) {
  return { id, value, faceUp, removed };
}

function hidden(id, value = 7, removed = false) {
  return card(id, value, false, removed);
}

function visibleScore(grid) {
  return grid.reduce((total, item) => (item.faceUp && !item.removed ? total + item.value : total), 0);
}

function gridWith(overrides) {
  const grid = Array.from({ length: 12 }, (_, index) => hidden(`hidden-${index}`));
  for (const [index, value, faceUp = true, removed = false] of overrides) {
    grid[index] = card(`card-${index}-${value}-${faceUp}-${removed}`, value, faceUp, removed);
  }
  return grid;
}

function makePlayer(id, name, kind, grid) {
  return {
    id,
    name,
    kind,
    grid,
    totalScore: 0,
    roundScore: visibleScore(grid)
  };
}

function makeState({
  grid,
  phase = 'choose-source',
  selectedSource = null,
  discardValue = 6,
  drawnValue = null,
  roundCloserId = null,
  finalTurnPlayerIds = []
}) {
  const drawnCard = drawnValue === null ? null : card(`drawn-${drawnValue}`, drawnValue);
  return {
    players: [
      makePlayer('ai', 'Luke', 'ai', grid),
      makePlayer('human', 'You', 'human', gridWith([[0, 2], [1, 3]]))
    ],
    drawPile: [hidden('deck-1', 4), hidden('deck-2', 9), hidden('deck-3', -1)],
    discardPile: discardValue === null ? [] : [card(`discard-${discardValue}`, discardValue)],
    currentPlayerIndex: 0,
    phase,
    selectedSource,
    drawnCard,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId,
    finalTurnPlayerIds,
    openingRevealCounts: {}
  };
}

function assertLegalReplacement(state, move) {
  assert.equal(move.action, 'replace');
  assert.equal(state.players[0].grid[move.index].removed, false, 'AI replacement target must not be removed');
}

let state = makeState({
  grid: gridWith([
    [0, 12],
    [1, 2],
    [2, 7, false]
  ]),
  discardValue: 0
});
assert.equal(getBestAiMove(state).action, 'discard', 'AI should take a useful low discard card');
state = chooseDiscard(state);
let move = getBestAiMove(state);
assertLegalReplacement(state, move);
assert.equal(move.index, 0, 'AI should replace a visible 12 before an unknown hidden card');
state = replaceCard(state, move.index);
assert.notEqual(state.phase, 'choose-replacement', 'AI replacement should complete the turn');

state = makeState({
  grid: gridWith([
    [0, 9],
    [1, 3],
    [2, 7, false]
  ]),
  discardValue: 11
});
assert.equal(getBestAiMove(state).action, 'draw', 'AI should draw blind instead of taking a poor high discard');

state = makeState({
  grid: gridWith([
    [0, 5],
    [4, 5],
    [8, 7, false],
    [1, 9]
  ]),
  discardValue: 5
});
assert.equal(getBestAiMove(state).action, 'discard', 'AI should value a discard that can clear a column');
state = chooseDiscard(state);
move = getBestAiMove(state);
assertLegalReplacement(state, move);
assert.equal(move.index, 8, 'AI should place the matching discard into the column-clear slot');

state = makeState({
  grid: gridWith([
    [0, 12, true, true],
    [1, 10],
    [2, 7, false]
  ]),
  phase: 'choose-replacement',
  selectedSource: 'draw',
  drawnValue: -1
});
move = getBestAiMove(state);
assertLegalReplacement(state, move);
assert.equal(move.index, 1, 'AI should ignore removed cards even when they have high values');

state = makeState({
  grid: gridWith([
    [0, 12, false, true],
    [1, 7, false],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 0],
    [10, 0],
    [11, 0]
  ]),
  phase: 'choose-replacement',
  selectedSource: 'draw',
  drawnValue: 10
});
move = getBestAiMove(state);
assert.equal(move.action, 'reveal', 'AI should discard a bad drawn card and reveal a hidden card');
assert.equal(move.index, 1, 'AI reveal target must skip removed hidden cards');
state = discardDrawnAndReveal(state, move.index);
assert.notEqual(state.phase, 'choose-replacement', 'AI discard-and-reveal should complete the turn');

state = makeState({
  grid: gridWith([
    [0, 7, false],
    [1, 8, false],
    [2, 9, false],
    [3, 10, false],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
    [9, 0],
    [10, 0],
    [11, 0]
  ]),
  phase: 'choose-replacement',
  selectedSource: 'draw',
  drawnValue: 5,
  roundCloserId: 'human',
  finalTurnPlayerIds: ['ai']
});
move = getBestAiMove(state);
assertLegalReplacement(state, move);
assert.equal(move.action, 'replace', 'AI should accept modest score reduction during a final turn');

console.log('ai smoke passed: source choice, replacement targets, reveal targets, final-turn pressure, and removed-card safety');
