import {
  createInitialRoomState,
  createNextRoundRoomState,
  deepEqual,
  legalMultiplayerStateUpdates,
  validateMultiplayerStateUpdate
} from '../../../src/serverValidation';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from '../../../src/game';
import type { Card, GameState } from '../../../src/types';

function card(id: string, value: number, faceUp = true, removed = false): Card {
  return { id, value, faceUp, removed };
}

function finishOpening(initial: GameState): GameState {
  let state = initial;
  while (state.phase === 'opening-reveal') {
    const active = state.players[state.currentPlayerIndex];
    state = revealOpeningCard(state, active.grid.findIndex((item) => !item.faceUp && !item.removed));
  }
  return state;
}

describe('server-side multiplayer validation', () => {
  it('compares nested primitives, arrays, and records independent of object key order', () => {
    expect(deepEqual({ b: [2, { c: 3 }], a: 1 }, { a: 1, b: [2, { c: 3 }] })).toBe(true);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual({ 0: 1 }, [1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual('one', 'two')).toBe(false);
  });

  it('accepts legal opening moves and rejects tampered, malformed, or out-of-turn updates', () => {
    const state = createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]);
    const active = state.players[state.currentPlayerIndex];
    const index = active.grid.findIndex((item) => !item.faceUp);
    const legal = revealOpeningCard(state, index);

    expect(validateMultiplayerStateUpdate(state, legal, active.id)).toEqual({ ok: true });
    expect(validateMultiplayerStateUpdate(state, legal, 'not-active')).toEqual({ ok: false, message: 'It is not your turn.' });
    expect(validateMultiplayerStateUpdate(state, null, active.id)).toEqual({ ok: false, message: 'Invalid game state update.' });

    const tampered = structuredClone(legal);
    tampered.round = 99;
    expect(validateMultiplayerStateUpdate(state, tampered, active.id)).toEqual({ ok: false, message: 'That move is not legal.' });
    expect(validateMultiplayerStateUpdate(null, {}, 'ada')).toEqual({ ok: false, message: 'No active game.' });

    const missingActive = { ...state, currentPlayerIndex: 99 };
    expect(validateMultiplayerStateUpdate(missingActive, {}, active.id)).toEqual({
      ok: false,
      message: 'Current game state is invalid.'
    });
  });

  it('enumerates opening, source, discard replacement, and draw replacement moves', () => {
    const opening = createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]);
    expect(legalMultiplayerStateUpdates(opening)).toHaveLength(12);
    const partiallyOpened = revealOpeningCard(opening, 0);
    expect(legalMultiplayerStateUpdates(partiallyOpened)).toHaveLength(11);
    expect(legalMultiplayerStateUpdates({ ...opening, currentPlayerIndex: 99 })).toEqual([]);

    const source = finishOpening(opening);
    const sourceCandidates = legalMultiplayerStateUpdates(source);
    expect(sourceCandidates.some((candidate) => candidate.selectedSource === 'discard')).toBe(true);
    expect(sourceCandidates.some((candidate) => candidate.selectedSource === 'draw')).toBe(true);

    const emptySources = { ...source, drawPile: [], discardPile: [] };
    expect(legalMultiplayerStateUpdates(emptySources)).toEqual([]);

    const discard = chooseDiscard(source);
    const discardCandidates = legalMultiplayerStateUpdates(discard);
    expect(discardCandidates.some((candidate) => candidate.phase === 'choose-source')).toBe(true);
    expect(discardCandidates).toHaveLength(13);
    expect(legalMultiplayerStateUpdates({ ...discard, discardPile: [] })).toHaveLength(1);

    const drawn = drawBlind(source, () => 0);
    const active = drawn.players[drawn.currentPlayerIndex];
    active.grid[0] = { ...active.grid[0], removed: true };
    active.grid[1] = { ...active.grid[1], faceUp: true };
    const drawnCandidates = legalMultiplayerStateUpdates(drawn);
    expect(drawnCandidates.some((candidate) => candidate.log[0].includes('discarded'))).toBe(true);
    expect(drawnCandidates.some((candidate) => candidate.log[0].includes('replaced'))).toBe(true);
    expect(legalMultiplayerStateUpdates({ ...drawn, drawnCard: null })).toEqual([]);
    expect(legalMultiplayerStateUpdates({ ...source, phase: 'round-over' })).toEqual([]);
  });

  it('accepts any legal recycle draw order and rejects forged recycled piles and cards', () => {
    const source = finishOpening(createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]));
    const recycleBase: GameState = {
      ...source,
      drawPile: [],
      discardPile: [card('top', 1), card('a', 3), card('b', 5), card('c', 7)]
    };
    const legal = drawBlind(recycleBase, () => 0.4);
    legal.drawPile.reverse();
    expect(validateMultiplayerStateUpdate(recycleBase, legal, recycleBase.players[recycleBase.currentPlayerIndex].id)).toEqual({ ok: true });

    const wrongPile = structuredClone(legal);
    wrongPile.drawPile = [card('forged', 12, false)];
    expect(validateMultiplayerStateUpdate(recycleBase, wrongPile, recycleBase.players[recycleBase.currentPlayerIndex].id).ok).toBe(false);

    const wrongDrawn = structuredClone(legal);
    wrongDrawn.drawnCard = card('forged', -2);
    expect(validateMultiplayerStateUpdate(recycleBase, wrongDrawn, recycleBase.players[recycleBase.currentPlayerIndex].id).ok).toBe(false);
    expect(validateMultiplayerStateUpdate({ ...recycleBase, discardPile: [card('only', 1)] }, legal, recycleBase.players[0].id).ok).toBe(false);

    const malformedPile = structuredClone(legal);
    malformedPile.drawPile = [null, ...legal.drawPile.slice(1)] as never;
    expect(validateMultiplayerStateUpdate(recycleBase, malformedPile, recycleBase.players[0].id).ok).toBe(false);
  });

  it('validates representative replacement actions and carries round history forward', () => {
    const source = finishOpening(createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]));
    const discard = chooseDiscard(source);
    const discardMove = replaceCard(discard, 0);
    expect(validateMultiplayerStateUpdate(discard, discardMove, discard.players[discard.currentPlayerIndex].id)).toEqual({ ok: true });

    const drawn = drawBlind(source, () => 0);
    const hidden = drawn.players[drawn.currentPlayerIndex].grid.findIndex((item) => !item.faceUp && !item.removed);
    const revealMove = discardDrawnAndReveal(drawn, hidden);
    expect(validateMultiplayerStateUpdate(drawn, revealMove, drawn.players[drawn.currentPlayerIndex].id)).toEqual({ ok: true });

    source.roundHistory.push({ round: 1, closerId: 'ada', scores: [] });
    source.nextStarterId = 'grace';
    const next = createNextRoundRoomState(source);
    expect(next.round).toBe(2);
    expect(next.roundHistory).toEqual(source.roundHistory);

    const withoutHistory = createNextRoundRoomState({ ...source, roundHistory: undefined as never });
    expect(withoutHistory.roundHistory).toEqual([]);
  });
});
