import assert from 'node:assert/strict';
import {
  createInitialRoomState,
  validateMultiplayerStateUpdate
} from '../server-dist/serverValidation.js';
import { chooseDiscard, replaceCard, revealOpeningCard } from '../server-dist/game.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function card(id, value, faceUp = true, removed = false) {
  return { id, value, faceUp, removed };
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

const columnClearBase = {
  players: [
    {
      id: 'player-1',
      kind: 'human',
      name: 'Ada',
      grid: [
        card('clear-0', 5),
        card('p1-1', 1),
        card('p1-2', 2),
        card('p1-3', 3),
        card('clear-4', 5),
        card('p1-5', 4),
        card('p1-6', 6),
        card('p1-7', 7),
        card('old-9', 9, false),
        card('p1-9', 8),
        card('p1-10', 10),
        card('p1-11', 11, false)
      ],
      totalScore: 0,
      roundScore: 0
    },
    {
      id: 'player-2',
      kind: 'human',
      name: 'Grace',
      grid: Array.from({ length: 12 }, (_, index) => card(`p2-${index}`, index, false)),
      totalScore: 0,
      roundScore: 0
    }
  ],
  drawPile: [],
  discardPile: [card('replacement-5', 5), card('previous-discard', 2)],
  currentPlayerIndex: 0,
  phase: 'choose-replacement',
  selectedSource: 'discard',
  drawnCard: null,
  round: 1,
  log: [],
  winnerId: null,
  nextStarterId: null,
  roundCloserId: null,
  finalTurnPlayerIds: [],
  openingRevealCounts: { 'player-1': 2, 'player-2': 2 }
};
const columnClearMove = replaceCard(columnClearBase, 8);
accept(columnClearBase, columnClearMove);
assert.deepEqual(
  columnClearMove.discardPile.slice(0, 5).map((item) => item.id),
  ['clear-0', 'clear-4', 'replacement-5', 'old-9', 'previous-discard'],
  'cleared column should sit on top of the replaced card and prior discard pile'
);

console.log('validation smoke passed: accepted legal opening/source/replacement/recycled-draw moves and rejected tampered states');
