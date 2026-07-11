import {
  createInitialRoomState,
  deepEqual,
  legalMultiplayerStateUpdates,
  validateMultiplayerStateUpdate
} from '../../../src/serverValidation';
import { revealOpeningCard } from '../../../src/game';

describe('server-side multiplayer validation', () => {
  it('compares nested structures without depending on object key order', () => {
    expect(deepEqual({ b: [2, { c: 3 }], a: 1 }, { a: 1, b: [2, { c: 3 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('accepts legal opening moves and rejects tampered or out-of-turn state', () => {
    const state = createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]);
    const active = state.players[state.currentPlayerIndex];
    const index = active.grid.findIndex((card) => !card.faceUp);
    const legal = revealOpeningCard(state, index);

    expect(validateMultiplayerStateUpdate(state, legal, active.id)).toEqual({ ok: true });
    expect(validateMultiplayerStateUpdate(state, legal, 'not-active')).toMatchObject({ ok: false });

    const tampered = structuredClone(legal);
    tampered.round = 99;
    expect(validateMultiplayerStateUpdate(state, tampered, active.id)).toMatchObject({
      ok: false,
      message: 'That move is not legal.'
    });
  });

  it('enumerates only changed legal states and rejects invalid inputs', () => {
    const state = createInitialRoomState([{ id: 'ada', name: 'Ada' }, { id: 'grace', name: 'Grace' }]);
    expect(legalMultiplayerStateUpdates(state)).toHaveLength(12);
    expect(validateMultiplayerStateUpdate(null, {}, 'ada')).toEqual({ ok: false, message: 'No active game.' });
    expect(validateMultiplayerStateUpdate(state, null, state.players[0].id)).toMatchObject({ ok: false });
  });
});
