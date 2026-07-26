import { vi } from 'vitest';
import type { AiMove } from '../../../src/aiContracts';
import type { Card, GameState, Player } from '../../../src/types';

const decisions = vi.hoisted(() => vi.fn<() => AiMove | null>());

vi.mock('../../../src/aiProjection', () => ({
  chooseAiMoveForState: decisions
}));

import { MULTIPLAYER_AI_DIFFICULTY, reduceAuthoritativeAiAction } from '../../../src/authoritativeAi';

function card(index: number, value = index, faceUp = false, removed = false): Card {
  return { id: `card-${index}-${value}`, value, faceUp, removed };
}

function player(): Player {
  return {
    id: 'bot',
    name: 'Bot',
    kind: 'human',
    grid: Array.from({ length: 12 }, (_, index) => card(index)),
    totalScore: 0,
    roundScore: 0
  };
}

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    players: [player(), { ...player(), id: 'human', name: 'Human' }],
    drawPile: [card(100, 4), card(101, 9)],
    discardPile: [card(102, 0, true)],
    currentPlayerIndex: 0,
    phase: 'choose-source',
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: ['Bot acts.'],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { bot: 0, human: 0 },
    roundHistory: [],
    ...overrides
  };
}

describe('authoritative multiplayer AI orchestration', () => {
  const random = vi.fn(() => 0.25);

  beforeEach(() => {
    decisions.mockReset();
    random.mockClear();
  });

  it('keeps takeover explicitly Hard and rejects missing, wrong, or terminal seats', () => {
    expect(MULTIPLAYER_AI_DIFFICULTY).toBe('hard');
    expect(reduceAuthoritativeAiAction(null, 'bot', random)).toMatchObject({ ok: false, message: 'No active game.' });
    expect(reduceAuthoritativeAiAction(state({ players: [] }), 'bot', random)).toMatchObject({ ok: false });
    expect(reduceAuthoritativeAiAction(state(), 'human', random)).toMatchObject({ ok: false, message: /not the current/i });
    expect(reduceAuthoritativeAiAction(state({ phase: 'round-over' }), 'bot', random)).toMatchObject({ ok: false });
    expect(reduceAuthoritativeAiAction(state({ phase: 'game-over' }), 'bot', random)).toMatchObject({ ok: false });
  });

  it('reveals an opening card and rejects an unavailable opening decision', () => {
    decisions.mockReturnValueOnce({ action: 'reveal', index: 0 });
    expect(reduceAuthoritativeAiAction(state({ phase: 'opening-reveal' }), 'bot', random)).toMatchObject({
      ok: true,
      state: { openingRevealCounts: { bot: 1 } }
    });
    expect(decisions).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ difficulty: 'hard', playerId: 'bot', decisionKey: expect.stringContaining('Bot acts.') })
    );

    decisions.mockReturnValueOnce(null);
    expect(reduceAuthoritativeAiAction(state({ phase: 'opening-reveal' }), 'bot', random)).toMatchObject({
      ok: false,
      message: /no opening card/i
    });
  });

  it('completes discard and draw turns without consuming strategy RNG', () => {
    decisions.mockReturnValueOnce({ action: 'discard' }).mockReturnValueOnce({ action: 'replace', index: 0 });
    expect(reduceAuthoritativeAiAction(state(), 'bot', random)).toMatchObject({ ok: true });
    expect(random).not.toHaveBeenCalled();

    decisions.mockReturnValueOnce({ action: 'draw' }).mockReturnValueOnce({ action: 'reveal', index: 0 });
    expect(reduceAuthoritativeAiAction(state(), 'bot', random)).toMatchObject({ ok: true });
    expect(random).not.toHaveBeenCalled();
  });

  it('returns fenced source and placement failures without mutating through them', () => {
    decisions.mockReturnValueOnce(null);
    expect(reduceAuthoritativeAiAction(state(), 'bot', random)).toMatchObject({ ok: false, message: /no legal source/i });

    decisions.mockReturnValueOnce({ action: 'draw' });
    expect(
      reduceAuthoritativeAiAction(state({ drawPile: [], discardPile: [card(200, 2, true)] }), 'bot', random)
    ).toMatchObject({ ok: false, message: /draw pile is not available/i });

    decisions.mockReturnValueOnce(null);
    expect(
      reduceAuthoritativeAiAction(
        state({ phase: 'choose-replacement', selectedSource: 'draw', drawnCard: card(201, 3, true) }),
        'bot',
        random
      )
    ).toMatchObject({ ok: false, message: /no legal placement/i });

    decisions.mockReturnValueOnce({ action: 'replace', index: 99 });
    expect(
      reduceAuthoritativeAiAction(
        state({ phase: 'choose-replacement', selectedSource: 'draw', drawnCard: card(202, 3, true) }),
        'bot',
        random
      )
    ).toMatchObject({ ok: false, message: /replacement is not legal/i });
  });

  it('uses the default replacement index and rejects a phase that cannot reach placement', () => {
    decisions.mockReturnValueOnce({ action: 'replace' });
    expect(
      reduceAuthoritativeAiAction(
        state({ phase: 'choose-replacement', selectedSource: 'draw', drawnCard: card(203, -1, true) }),
        'bot',
        random
      )
    ).toMatchObject({ ok: true });

    expect(
      reduceAuthoritativeAiAction(state({ phase: 'invalid' as GameState['phase'] }), 'bot', random)
    ).toMatchObject({ ok: false, message: /did not reach/i });
  });
});
