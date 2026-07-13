import assert from 'node:assert/strict';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  parseClientCommand,
  redactGameState,
  reduceAuthoritativeGameCommand
} from '../server-dist/protocolV2.js';
import { createInitialRoomState } from '../server-dist/serverValidation.js';

const commandId = '12345678-1234-4123-8123-123456789abc';
const players = [
  { id: 'player-1', name: 'Ada' },
  { id: 'player-2', name: 'Grace' }
];
const deterministicInitialRandom = () => 0.25;
const initial = createInitialRoomState(players, deterministicInitialRandom);
const activePlayer = initial.players[initial.currentPlayerIndex];
assert.ok(activePlayer, 'expected an active player');

const openingIndex = activePlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
assert.notEqual(openingIndex, -1, 'expected a hidden opening card');
const parsedOpening = parseClientCommand({
  type: 'command',
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  commandId,
  expectedRevision: 0,
  action: { type: 'reveal-opening-card', cardIndex: openingIndex }
});
assert.equal(parsedOpening.ok, true);
assert.deepEqual(parsedOpening.command.action, { type: 'reveal-opening-card', cardIndex: openingIndex });

const openingReduction = reduceAuthoritativeGameCommand(
  initial,
  activePlayer.id,
  parsedOpening.command.action,
  () => {
    throw new Error('opening reveals must not consume randomness');
  }
);
assert.equal(openingReduction.ok, true, openingReduction.message);
assert.equal(openingReduction.state.players[initial.currentPlayerIndex].grid[openingIndex].faceUp, true);
assert.equal(initial.players[initial.currentPlayerIndex].grid[openingIndex].faceUp, false);

const strictEnvelope = parseClientCommand({
  type: 'command',
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  commandId,
  expectedRevision: 0,
  action: { type: 'draw-blind' },
  state: initial
});
assert.deepEqual(strictEnvelope, {
  ok: false,
  kind: 'invalid',
  message: 'Invalid command envelope.',
  commandId
});

const legacyWholeState = parseClientCommand({
  type: 'update-state',
  protocolVersion: 1,
  commandId,
  state: openingReduction.state
});
assert.deepEqual(legacyWholeState, {
  ok: false,
  kind: 'upgrade-required',
  message: 'This client must upgrade to multiplayer protocol 2.',
  commandId
});

const recycleBase = {
  ...openingReduction.state,
  drawPile: [],
  discardPile: [
    { ...openingReduction.state.discardPile[0], id: 'discard-top', value: 9, faceUp: true, removed: false },
    { ...openingReduction.state.drawPile[0], id: 'recycle-a', value: 1, faceUp: true, removed: false },
    { ...openingReduction.state.drawPile[1], id: 'recycle-b', value: 2, faceUp: true, removed: false },
    { ...openingReduction.state.drawPile[2], id: 'recycle-c', value: 3, faceUp: true, removed: false }
  ],
  phase: 'choose-source',
  selectedSource: null,
  drawnCard: null
};
const parsedDraw = parseClientCommand({
  type: 'command',
  protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
  commandId: '22345678-1234-4123-8123-123456789abc',
  expectedRevision: 1,
  action: { type: 'draw-blind' }
});
assert.equal(parsedDraw.ok, true);
assert.deepEqual(parsedDraw.command.action, { type: 'draw-blind' });

let recycleRandomCalls = 0;
const recycled = reduceAuthoritativeGameCommand(
  recycleBase,
  activePlayer.id,
  parsedDraw.command.action,
  () => {
    recycleRandomCalls += 1;
    return 0;
  }
);
assert.equal(recycled.ok, true, recycled.message);
assert.equal(recycleRandomCalls, 2, 'the server random source must shuffle every recycled card');
assert.equal(recycled.state.drawnCard.id, 'recycle-b');
assert.deepEqual(recycled.state.drawPile.map((card) => card.id), ['recycle-c', 'recycle-a']);
assert.deepEqual(recycled.state.discardPile.map((card) => card.id), ['discard-top']);

const ownerView = redactGameState(recycled.state, activePlayer.id);
const opponentView = redactGameState(recycled.state, players[1].id);
assert.equal(ownerView.hasDrawnCard, true);
assert.equal(ownerView.drawnCard.value, 2);
assert.equal(opponentView.hasDrawnCard, true);
assert.equal(opponentView.drawnCard, null);
assert.equal(ownerView.drawPileCount, 2);
assert.equal(Object.hasOwn(ownerView, 'drawPile'), false, 'wire snapshots expose a count, never the draw pile');
for (const player of opponentView.players) {
  for (const card of player.grid) {
    if (!card.faceUp && !card.removed) assert.equal(card.value, null, 'face-down grid values must be redacted');
  }
}
assert.ok(opponentView.log.every((entry) => !/drew a -?\d+\./.test(entry)), 'draw logs must not leak blind values');

console.log('validation smoke passed: strict protocol-v2 commands, authoritative recycle RNG, hidden-state redaction, and update-state upgrade enforcement');
