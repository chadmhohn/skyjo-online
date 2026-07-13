import * as serverValidation from '../../../src/serverValidation';
import { createSeededRandom, systemRandom } from '../../../src/runtime';

const roomPlayers = [
  { id: 'ada', name: 'Ada' },
  { id: 'grace', name: 'Grace' }
];

describe('server-owned multiplayer state construction', () => {
  it('exposes constructors without the retired whole-state acceptance surface', () => {
    expect(Object.keys(serverValidation).sort()).toEqual([
      'createInitialRoomState',
      'createNextRoundRoomState'
    ]);
  });

  it('keeps the production random source behind a deterministic test boundary', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    expect(systemRandom()).toBe(0.25);
  });

  it('constructs deterministic initial multiplayer state from the server random source', () => {
    const first = serverValidation.createInitialRoomState(roomPlayers, createSeededRandom(0x51a7e));
    const second = serverValidation.createInitialRoomState(roomPlayers, createSeededRandom(0x51a7e));

    expect(first).toEqual(second);
    expect(first.round).toBe(1);
    expect(first.phase).toBe('opening-reveal');
    expect(first.players.map(({ id, name, kind, totalScore }) => ({ id, name, kind, totalScore }))).toEqual([
      { id: 'ada', name: 'Ada', kind: 'human', totalScore: 0 },
      { id: 'grace', name: 'Grace', kind: 'human', totalScore: 0 }
    ]);
    expect(first.players.every((player) => player.grid.every((card) => !card.faceUp && !card.removed))).toBe(true);
  });

  it('constructs the next round with retained scores, starter, and immutable history', () => {
    const initial = serverValidation.createInitialRoomState(roomPlayers, createSeededRandom(0x51a7e));
    const history = [{
      round: 1,
      closerId: 'ada',
      scores: [
        { playerId: 'ada', name: 'Ada', roundScore: 12, totalScore: 12 },
        { playerId: 'grace', name: 'Grace', roundScore: 8, totalScore: 8 }
      ]
    }];
    const completed = {
      ...initial,
      round: 3,
      nextStarterId: 'grace',
      players: initial.players.map((player, index) => ({ ...player, totalScore: index === 0 ? 42 : 27 })),
      roundHistory: history
    };

    const next = serverValidation.createNextRoundRoomState(completed, createSeededRandom(0x600d));
    expect(next.round).toBe(4);
    expect(next.players.map((player) => player.totalScore)).toEqual([42, 27]);
    expect(next.roundHistory).toEqual(history);
    expect(next.roundHistory).toBe(history);

    const withoutHistory = serverValidation.createNextRoundRoomState(
      { ...completed, roundHistory: undefined as never },
      createSeededRandom(0x600d)
    );
    expect(withoutHistory.roundHistory).toEqual([]);
  });
});
