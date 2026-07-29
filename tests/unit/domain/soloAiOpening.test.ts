import { revealOpeningCard, startFreshGame } from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import {
  advanceSoloAiOpeningSeat,
  drainSoloAiOpening,
  soloAiOpeningSeatDelayMs
} from '../../../src/soloAiOpening';
import type { GameState } from '../../../src/types';

function finishHumanOpening(state: GameState): GameState {
  let next = state;
  for (let reveal = 0; reveal < 2; reveal += 1) {
    const player = next.players[next.currentPlayerIndex];
    const cardIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    next = revealOpeningCard(next, cardIndex);
  }
  return next;
}

describe('solo AI opening cadence', () => {
  it('reveals one AI seat atomically without changing the input snapshot', () => {
    const initial = startFreshGame({ aiOpponentCount: 7, random: createSeededRandom(71) });
    const aiOpening = finishHumanOpening(initial);
    const activeAi = aiOpening.players[aiOpening.currentPlayerIndex];

    expect(activeAi.kind).toBe('ai');
    expect(soloAiOpeningSeatDelayMs).toBeGreaterThanOrEqual(200);
    expect(soloAiOpeningSeatDelayMs).toBeLessThanOrEqual(250);
    const advanced = advanceSoloAiOpeningSeat(aiOpening);

    expect(aiOpening.openingRevealCounts[activeAi.id]).toBe(0);
    expect(advanced.openingRevealCounts[activeAi.id]).toBe(2);
    expect(advanced.currentPlayerIndex).not.toBe(aiOpening.currentPlayerIndex);
    expect(advanced.log[0]).toMatch(/: reveal 2 cards\.$/);
  });

  it('drains every consecutive AI seat for reduced motion', () => {
    const initial = startFreshGame({ aiOpponentCount: 7, random: createSeededRandom(72) });
    const completed = drainSoloAiOpening(finishHumanOpening(initial));

    expect(completed.phase).toBe('choose-source');
    expect(completed.players.filter((player) => player.kind === 'ai')).toHaveLength(7);
    expect(Object.values(completed.openingRevealCounts)).toEqual(Array(8).fill(2));
  });

  it('does nothing outside an active AI opening seat and stops safely on malformed input', () => {
    const humanOpening = startFreshGame({ aiOpponentCount: 1, random: createSeededRandom(73) });
    expect(advanceSoloAiOpeningSeat(humanOpening)).toBe(humanOpening);
    expect(drainSoloAiOpening(humanOpening)).toBe(humanOpening);

    const active = drainSoloAiOpening(finishHumanOpening(humanOpening));
    expect(advanceSoloAiOpeningSeat(active)).toBe(active);
    expect(drainSoloAiOpening(active)).toBe(active);

    const malformed = {
      ...finishHumanOpening(startFreshGame({ aiOpponentCount: 1, random: createSeededRandom(74) })),
      players: []
    };
    expect(advanceSoloAiOpeningSeat(malformed)).toBe(malformed);
    expect(drainSoloAiOpening(malformed)).toBe(malformed);
  });

  it('handles partial and inconsistent AI opening snapshots without looping', () => {
    const aiOpening = finishHumanOpening(startFreshGame({ aiOpponentCount: 1, random: createSeededRandom(75) }));
    const ai = aiOpening.players[aiOpening.currentPlayerIndex];
    const firstHidden = ai.grid.findIndex((card) => !card.faceUp && !card.removed);
    const partiallyRevealed = revealOpeningCard(aiOpening, firstHidden);
    expect(advanceSoloAiOpeningSeat(partiallyRevealed).phase).toBe('choose-source');

    const noEligibleCards = {
      ...aiOpening,
      players: aiOpening.players.map((player, index) =>
        index === aiOpening.currentPlayerIndex
          ? { ...player, grid: player.grid.map((card) => ({ ...card, faceUp: true })) }
          : player
      )
    };
    expect(advanceSoloAiOpeningSeat(noEligibleCards)).toBe(noEligibleCards);
    expect(drainSoloAiOpening(noEligibleCards)).toBe(noEligibleCards);

    const alreadyAtLimit = {
      ...aiOpening,
      players: aiOpening.players.map((player, index) =>
        index === aiOpening.currentPlayerIndex
          ? {
              ...player,
              grid: player.grid.map((card, cardIndex) => ({ ...card, faceUp: cardIndex < 2 }))
            }
          : player
      )
    };
    expect(advanceSoloAiOpeningSeat(alreadyAtLimit)).toBe(alreadyAtLimit);
  });
});
