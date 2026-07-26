import fc from 'fast-check';
import {
  chooseAiMove as chooseFromKnowledge,
  estimateAiHiddenCardValue,
  ultraDrawOutcomeLimit,
  type AiDifficulty,
  type AiKnowledgeCard,
  type AiKnowledgeState,
  type AiMove
} from '../../../src/aiStrategy';
import {
  chooseAiMoveForState as chooseAiMove,
  legalAiMovesForState as legalAiMoves,
  projectAiKnowledge
} from '../../../src/aiProjection';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame
} from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import type { Card, GameState, Player } from '../../../src/types';

const difficulties: readonly AiDifficulty[] = ['easy', 'medium', 'hard', 'ultra'];

function card(id: string, value: number, faceUp = true, removed = false): Card {
  return { id, value, faceUp, removed };
}

function grid(values: readonly number[], faceUp = true): Card[] {
  return Array.from({ length: 12 }, (_, index) =>
    card(`grid-${index}-${values[index] ?? 7}`, values[index] ?? 7, faceUp)
  );
}

function player(id: string, values: readonly number[], faceUp = true): Player {
  const cards = grid(values, faceUp);
  return {
    id,
    name: id,
    kind: id === 'bot' ? 'ai' : 'human',
    grid: cards,
    totalScore: 0,
    roundScore: cards.reduce((sum, item) => sum + (item.faceUp ? item.value : 0), 0)
  };
}

function stateWith(options: {
  phase?: GameState['phase'];
  selectedSource?: GameState['selectedSource'];
  botValues?: readonly number[];
  botFaceUp?: boolean;
  discardValue?: number | null;
  drawnValue?: number | null;
} = {}): GameState {
  const {
    phase = 'choose-source',
    selectedSource = null,
    botValues = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    botFaceUp = true,
    discardValue = 4,
    drawnValue = null
  } = options;
  return {
    players: [player('bot', botValues, botFaceUp), player('human', [2, 3], false)],
    drawPile: [card('draw-secret-12', 12, false), card('draw-secret-minus-2', -2, false)],
    discardPile: discardValue === null ? [] : [card(`discard-${discardValue}`, discardValue)],
    currentPlayerIndex: 0,
    phase,
    selectedSource,
    drawnCard: drawnValue === null ? null : card(`drawn-${drawnValue}`, drawnValue),
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { bot: botFaceUp ? 12 : 0, human: 0 },
    roundHistory: []
  };
}

function finishOpeningForBot(state: GameState): GameState {
  let current = state;
  while (current.phase === 'opening-reveal') {
    const active = current.players[current.currentPlayerIndex];
    const index = active.grid.findIndex((item) => !item.faceUp && !item.removed);
    current = revealOpeningCard(current, index);
  }
  const botIndex = current.players.findIndex((item) => item.kind === 'ai');
  return { ...current, currentPlayerIndex: botIndex };
}

function expectLegal(state: GameState, difficulty: AiDifficulty, decisionKey = 'legal'): AiMove {
  const playerId = state.players[state.currentPlayerIndex].id;
  const move = chooseAiMove(state, { playerId, difficulty, decisionKey });
  expect(move).not.toBeNull();
  expect(legalAiMoves(state, playerId)).toContainEqual(move);
  return move as AiMove;
}

function applyMove(state: GameState, move: AiMove): GameState {
  if (move.action === 'discard') return chooseDiscard(state);
  if (move.action === 'draw') return drawBlind(state, () => 0.5);
  if (move.action === 'replace') return replaceCard(state, move.index ?? -1);
  const discardedAndRevealed = discardDrawnAndReveal(state, move.index ?? -1);
  return discardedAndRevealed === state ? revealOpeningCard(state, move.index ?? -1) : discardedAndRevealed;
}

function expectEveryGeneratedMoveApplies(state: GameState): void {
  const playerId = state.players[state.currentPlayerIndex].id;
  const moves = legalAiMoves(state, playerId);
  expect(moves.length).toBeGreaterThan(0);
  for (const move of moves) expect(applyMove(state, move)).not.toBe(state);
}

describe('AI public-information boundary', () => {
  it('redacts hidden values, all card ids, and draw order while de-duplicating cleared cards', () => {
    const state = stateWith({ botFaceUp: false });
    const cleared = card('cleared-card-8', 8, true, true);
    state.players[0].grid[0] = cleared;
    state.discardPile = [{ ...cleared, removed: false }, card('older-public-1', 1)];
    state.drawnCard = card('private-drawn-6', 6);
    state.phase = 'choose-replacement';
    state.selectedSource = 'draw';

    const knowledge = projectAiKnowledge(state, 'bot');
    const serialized = JSON.stringify(knowledge);
    expect(serialized).not.toMatch(/cleared-card|older-public|private-drawn|draw-secret|grid-/);
    expect(knowledge.players[0].grid[1].value).toBeNull();
    expect(knowledge.drawPileCount).toBe(2);
    expect(knowledge.knownValues.filter((value) => value === 8)).toHaveLength(1);
    expect(knowledge.knownValues).toContain(6);
    expect(estimateAiHiddenCardValue(knowledge)).toBeGreaterThan(-2);

    const spectatorKnowledge = projectAiKnowledge(state, 'human');
    expect(spectatorKnowledge.drawnCardValue).toBeNull();
    expect(spectatorKnowledge.knownValues).not.toContain(6);
  });

  it('is invariant to every hidden value, hidden id, and draw-pile permutation, including Ultra', () => {
    const state = stateWith({ botFaceUp: false, discardValue: 2 });
    state.players[0].grid[0] = card('public-10', 10);
    state.players[0].grid[4] = card('public-5', 5);
    const mutated = structuredClone(state);
    for (const participant of mutated.players) {
      participant.grid = participant.grid.map((item, index) =>
        item.faceUp || item.removed ? item : card(`changed-hidden-${index}-${14 - index}`, 14 - index, false)
      );
    }
    mutated.drawPile = [...mutated.drawPile]
      .reverse()
      .map((item, index) => card(`changed-draw-${index}`, index - 2, false));

    expect(projectAiKnowledge(mutated, 'bot')).toEqual(projectAiKnowledge(state, 'bot'));
    for (const difficulty of difficulties) {
      expect(
        chooseAiMove(mutated, { playerId: 'bot', difficulty, decisionKey: 'hidden-invariance' })
      ).toEqual(chooseAiMove(state, { playerId: 'bot', difficulty, decisionKey: 'hidden-invariance' }));
    }
  });
});

describe('difficulty profiles', () => {
  it('is deterministic, independent from Math.random, and varies stochastic choices by decision key', () => {
    const state = stateWith({
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnValue: -2
    });
    const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('strategy must not use global randomness');
    });

    for (const difficulty of difficulties) {
      const options = { playerId: 'bot', difficulty, decisionKey: 'repeatable' } as const;
      expect(chooseAiMove(state, options)).toEqual(chooseAiMove(structuredClone(state), options));
    }
    const easyTargets = new Set(
      Array.from({ length: 64 }, (_, index) =>
        JSON.stringify(chooseAiMove(state, { playerId: 'bot', difficulty: 'easy', decisionKey: `key-${index}` }))
      )
    );
    expect(easyTargets.size).toBeGreaterThan(2);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('keeps aggregate fixed-seed decision quality ordered Ultra, Hard, Medium, Easy', () => {
    const state = stateWith({
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnValue: -2
    });
    const trueGain = (move: AiMove | null) => {
      if (!move || move.action !== 'replace' || move.index === undefined) return -20;
      return state.players[0].grid[move.index].value - -2;
    };
    const average = (difficulty: AiDifficulty) =>
      Array.from({ length: 256 }, (_, index) =>
        trueGain(chooseAiMove(state, { playerId: 'bot', difficulty, decisionKey: `regret-${index}` }))
      ).reduce((sum, value) => sum + value, 0) / 256;

    const scores = Object.fromEntries(difficulties.map((difficulty) => [difficulty, average(difficulty)]));
    expect(scores.ultra).toBeGreaterThanOrEqual(scores.hard);
    expect(scores.hard).toBeGreaterThanOrEqual(scores.medium);
    expect(scores.medium).toBeGreaterThanOrEqual(scores.easy);
  });

  it('uses a bounded 15-outcome Ultra draw evaluation and stays below the decision budget', () => {
    expect(ultraDrawOutcomeLimit).toBe(15);
    const state = stateWith({ botFaceUp: false, discardValue: 3 });
    for (let index = 0; index < 40; index += 1) {
      chooseAiMove(state, { playerId: 'bot', difficulty: 'ultra', decisionKey: `warm-${index}` });
    }
    const durations = Array.from({ length: 400 }, (_, index) => {
      const start = performance.now();
      expectLegal(state, 'ultra', `perf-${index}`);
      return performance.now() - start;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)];
    expect(p95).toBeLessThan(5);
    expect(durations[durations.length - 1]).toBeLessThan(16);
  });

  it('penalizes an actual positive-score close that risks doubling, not another player final turn', () => {
    const state = stateWith({
      phase: 'choose-replacement',
      selectedSource: 'draw',
      botValues: [12, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      drawnValue: 3
    });
    state.players[0].grid[0].faceUp = false;
    state.players[0].roundScore = 4;
    state.players[1] = player('human', Array(12).fill(0), true);

    expect(chooseAiMove(state, { playerId: 'bot', difficulty: 'hard', decisionKey: 'closer' })).toEqual({
      action: 'replace',
      index: 0
    });
    expect(chooseAiMove(state, { playerId: 'bot', difficulty: 'ultra', decisionKey: 'closer' })).toEqual({
      action: 'replace',
      index: 1
    });

    const otherPlayerFinalTurn = { ...state, roundCloserId: 'human', finalTurnPlayerIds: ['bot'] };
    expect(
      chooseAiMove(otherPlayerFinalTurn, {
        playerId: 'bot',
        difficulty: 'ultra',
        decisionKey: 'not-the-closer'
      })
    ).toEqual({ action: 'replace', index: 0 });
  });

  it('preserves the legacy Hard 0.2 placement floor under final-turn pressure', () => {
    const hidden = { faceUp: false, removed: false, value: null } as const;
    const visible = (value: number) => ({ faceUp: true, removed: false, value });
    const botGrid: AiKnowledgeCard[] = Array.from({ length: 12 }, () => visible(0));
    botGrid[0] = hidden;
    botGrid[4] = hidden;
    botGrid[8] = hidden;
    for (const index of [1, 2, 3, 5, 6, 7]) botGrid[index] = visible(4);
    const knowledge: AiKnowledgeState = {
      players: [
        { id: 'bot', totalScore: 0, grid: botGrid },
        { id: 'human', totalScore: 0, grid: Array.from({ length: 12 }, () => visible(0)) }
      ],
      currentPlayerIndex: 0,
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnCardValue: 5,
      discardTopValue: 0,
      discardPileCount: 1,
      drawPileCount: 100,
      knownValues: Array(10).fill(12),
      roundCloserId: 'human',
      finalTurnPlayerIds: ['bot']
    };

    expect(chooseFromKnowledge(knowledge, { playerId: 'bot', difficulty: 'hard', decisionKey: 'floor' })).toEqual({
      action: 'reveal',
      index: 0
    });
  });

  it('avoids revealing the last hidden card into doubling risk after a poor blind draw', () => {
    const state = stateWith({
      phase: 'choose-replacement',
      selectedSource: 'draw',
      botValues: [12, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      drawnValue: 12
    });
    state.players[0].grid[0].faceUp = false;
    state.players[0].roundScore = 4;
    state.players[1] = player('human', Array(12).fill(0), true);

    expect(chooseAiMove(state, { playerId: 'bot', difficulty: 'hard', decisionKey: 'reveal-close' })).toEqual({
      action: 'reveal',
      index: 0
    });
    expect(chooseAiMove(state, { playerId: 'bot', difficulty: 'ultra', decisionKey: 'reveal-close' })).toEqual({
      action: 'replace',
      index: 1
    });

    const finalTurn = { ...state, roundCloserId: 'human', finalTurnPlayerIds: ['bot'] };
    expect(
      chooseAiMove(finalTurn, { playerId: 'bot', difficulty: 'ultra', decisionKey: 'safe-final-reveal' })
    ).toEqual({ action: 'reveal', index: 0 });
  });
});

describe('shared legal-action surface', () => {
  it('rejects the wrong player and phases without legal AI work', () => {
    const state = stateWith();
    expect(chooseAiMove(state, { playerId: 'human', difficulty: 'hard', decisionKey: 'wrong' })).toBeNull();
    expect(legalAiMoves(state, 'human')).toEqual([]);
    for (const phase of ['round-over', 'game-over'] as const) {
      const terminal = { ...state, phase };
      expect(legalAiMoves(terminal, 'bot')).toEqual([]);
      expect(chooseAiMove(terminal, { playerId: 'bot', difficulty: 'ultra', decisionKey: phase })).toBeNull();
    }
  });

  it('covers opening, source, discard replacement, blind placement, and reveal actions', () => {
    const opening = stateWith({ phase: 'opening-reveal', botFaceUp: false });
    expectEveryGeneratedMoveApplies(opening);
    for (const difficulty of difficulties) expect(expectLegal(opening, difficulty).action).toBe('reveal');

    const source = stateWith();
    expectEveryGeneratedMoveApplies(source);
    for (const difficulty of difficulties) expectLegal(source, difficulty);

    const discard = chooseDiscard(source);
    expectEveryGeneratedMoveApplies(discard);
    for (const difficulty of difficulties) expect(expectLegal(discard, difficulty).action).toBe('replace');

    const drawn = drawBlind(source, () => 0);
    expectEveryGeneratedMoveApplies(drawn);
    for (const difficulty of difficulties) expectLegal(drawn, difficulty);
  });

  it('returns only actions accepted by the shared legal surface across seeded games', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 1, max: 7 }),
        fc.constantFrom(...difficulties),
        (seed, aiOpponentCount, difficulty) => {
          const state = finishOpeningForBot(
            startFreshGame({ aiOpponentCount, random: createSeededRandom(seed) })
          );
          const first = expectLegal(state, difficulty, `property-${seed}`);
          expectEveryGeneratedMoveApplies(state);
          const decisionState =
            first.action === 'discard'
              ? chooseDiscard(state)
              : drawBlind(state, createSeededRandom(seed ^ 0x5f3759df));
          expectLegal(decisionState, difficulty, `property-${seed}-placement`);
          expectEveryGeneratedMoveApplies(decisionState);
        }
      ),
      { numRuns: 80 }
    );
  });

  it('returns no move for malformed source/replacement states without a legal action', () => {
    const emptySource = stateWith({ discardValue: null });
    emptySource.drawPile = [];
    expect(legalAiMoves(emptySource, 'bot')).toEqual([]);
    expect(chooseAiMove(emptySource, { playerId: 'bot', difficulty: 'hard', decisionKey: 'empty' })).toBeNull();

    const missingSelection = stateWith({ phase: 'choose-replacement', selectedSource: null });
    expect(legalAiMoves(missingSelection, 'bot')).toEqual([]);
    expect(
      chooseAiMove(missingSelection, { playerId: 'bot', difficulty: 'easy', decisionKey: 'missing' })
    ).toBeNull();

    const completedOpening = stateWith({ phase: 'opening-reveal', botFaceUp: false });
    completedOpening.players[0].grid[0].faceUp = true;
    completedOpening.players[0].grid[1].faceUp = true;
    expect(legalAiMoves(completedOpening, 'bot')).toEqual([]);
  });
});
