import assert from 'node:assert/strict';
import {
  createInitialRoomState,
  validateMultiplayerStateUpdate
} from '../server-dist/serverValidation.js';
import { chooseDiscard, replaceCard, revealOpeningCard } from '../server-dist/game.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function activePlayer(state) {
  return state.players[state.currentPlayerIndex];
}

function openingRevealIndex(state) {
  const player = activePlayer(state);
  const index = player.grid.findIndex((card) => !card.faceUp && !card.removed);
  assert.notEqual(index, -1, 'expected an opening card to reveal');
  return index;
}

function replacementIndex(state) {
  const player = activePlayer(state);
  const index = player.grid.findIndex((card) => !card.removed);
  assert.notEqual(index, -1, 'expected a card to replace');
  return index;
}

function accept(currentState, nextState) {
  const validation = validateMultiplayerStateUpdate(currentState, nextState, activePlayer(currentState).id);
  assert.equal(validation.ok, true, validation.message);
  return nextState;
}

function reject(currentState, nextState) {
  const validation = validateMultiplayerStateUpdate(currentState, nextState, activePlayer(currentState).id);
  assert.equal(validation.ok, false, 'expected tampered state to be rejected');
  assert.match(validation.message || '', /not legal|invalid/i);
}

const roomPlayers = [
  { id: 'player-1', name: 'Ada' },
  { id: 'player-2', name: 'Grace' }
];

let state = createInitialRoomState(roomPlayers);
assert.equal(state.phase, 'opening-reveal');

const firstOpeningMove = revealOpeningCard(state, openingRevealIndex(state));
const tamperedOpeningMove = clone(firstOpeningMove);
const otherPlayer = tamperedOpeningMove.players.find((player) => player.id !== activePlayer(state).id);
assert.ok(otherPlayer, 'expected a second player');
const otherHiddenIndex = otherPlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
assert.notEqual(otherHiddenIndex, -1, 'expected another hidden card');
otherPlayer.grid[otherHiddenIndex].faceUp = true;
reject(state, tamperedOpeningMove);

state = accept(state, firstOpeningMove);

while (state.phase === 'opening-reveal') {
  state = accept(state, revealOpeningCard(state, openingRevealIndex(state)));
}

assert.equal(state.phase, 'choose-source');

state = accept(state, chooseDiscard(state));
assert.equal(state.phase, 'choose-replacement');

state = accept(state, replaceCard(state, replacementIndex(state)));
assert.notEqual(state.phase, 'choose-replacement');

const recycleBase = {
  ...clone(state),
  drawPile: [],
  discardPile: [
    { ...state.discardPile[0], faceUp: true, removed: false },
    { ...state.drawPile[0], faceUp: true, removed: false },
    { ...state.drawPile[1], faceUp: true, removed: false }
  ],
  selectedSource: null,
  drawnCard: null,
  phase: 'choose-source'
};
const recycledDrawnCard = { ...recycleBase.discardPile[1], faceUp: true, removed: false };
const recycledRemainingCard = { ...recycleBase.discardPile[2], faceUp: false, removed: false };
const recycledDrawMove = {
  ...recycleBase,
  drawPile: [recycledRemainingCard],
  discardPile: [recycleBase.discardPile[0]],
  drawnCard: recycledDrawnCard,
  selectedSource: 'draw',
  phase: 'choose-replacement',
  log: [`${activePlayer(recycleBase).name} drew a ${recycledDrawnCard.value}.`, ...recycleBase.log].slice(0, 8)
};
accept(recycleBase, recycledDrawMove);

const impossibleRecycledDraw = clone(recycledDrawMove);
impossibleRecycledDraw.drawnCard = { id: 'forged-card', value: -2, faceUp: true, removed: false };
reject(recycleBase, impossibleRecycledDraw);

console.log('validation smoke passed: accepted legal opening/source/replacement/recycled-draw moves and rejected tampered states');
