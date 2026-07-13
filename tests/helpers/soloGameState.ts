import { startFreshGame } from '../../src/game';
import type { Card, GameState, Player } from '../../src/types';

function gridScore(grid: Card[]): number {
  return grid.reduce((total, card) => total + (card.removed ? 0 : card.value), 0);
}

function revealAndClearTerminalColumns(grid: Card[]): Card[] {
  const revealed = grid.map((card) => ({ ...card, faceUp: true }));
  for (let column = 0; column < 4; column += 1) {
    const indexes = [column, column + 4, column + 8];
    const cards = indexes.map((index) => revealed[index]);
    if (cards.every((card) => !card.removed && card.value === cards[0].value)) {
      for (const index of indexes) revealed[index] = { ...revealed[index], removed: true };
    }
  }
  return revealed;
}

export function completedSoloGameState(aiOpponentCount = 1, random: () => number = () => 0.35): GameState {
  const state = startFreshGame({ aiOpponentCount, random });
  const firstAiIndex = state.players.findIndex((player) => player.kind === 'ai');
  if (firstAiIndex < 0) throw new Error('A completed solo fixture requires an AI player.');

  const selectedValueCounts = new Map<number, number>();
  const highDrawIndexes = state.drawPile
    .map((card, index) => ({ card, index }))
    .sort((left, right) => right.card.value - left.card.value || left.index - right.index)
    .filter(({ card }) => {
      const selectedCount = selectedValueCounts.get(card.value) || 0;
      if (selectedCount >= 8) return false;
      selectedValueCounts.set(card.value, selectedCount + 1);
      return true;
    })
    .slice(0, 12)
    .map(({ index }) => index);
  const highDrawIndexSet = new Set(highDrawIndexes);
  const originalAiGrid = state.players[firstAiIndex].grid;
  const highCards = highDrawIndexes.map((index) => ({ ...state.drawPile[index], faceUp: true, removed: false }));
  let replacementIndex = 0;
  const drawPile = state.drawPile.map((card, index) => {
    if (!highDrawIndexSet.has(index)) return card;
    const replacement = originalAiGrid[replacementIndex];
    replacementIndex += 1;
    return { ...replacement, faceUp: false, removed: false };
  });

  const revealedPlayers = state.players.map((player, index) => ({
    ...player,
    grid: revealAndClearTerminalColumns(index === firstAiIndex ? highCards : player.grid)
  }));
  const closer = revealedPlayers.find((player) => player.kind === 'human') as Player;
  const rawScores = new Map(revealedPlayers.map((player) => [player.id, gridScore(player.grid)]));
  const closerRawScore = rawScores.get(closer.id) || 0;
  const lowestOtherScore = Math.min(
    ...revealedPlayers.filter((player) => player.id !== closer.id).map((player) => rawScores.get(player.id) || 0)
  );
  const closerScore = closerRawScore >= lowestOtherScore && closerRawScore > 0 ? closerRawScore * 2 : closerRawScore;
  const players = revealedPlayers.map((player) => {
    const roundScore = player.id === closer.id ? closerScore : rawScores.get(player.id) || 0;
    return { ...player, roundScore, totalScore: roundScore };
  });
  const winner = [...players].sort((left, right) => left.totalScore - right.totalScore)[0];

  return {
    ...state,
    players,
    drawPile,
    phase: 'game-over',
    selectedSource: null,
    drawnCard: null,
    winnerId: winner.id,
    nextStarterId: closer.id,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: Object.fromEntries(players.map((player) => [player.id, 2])),
    roundHistory: [
      {
        round: 1,
        closerId: closer.id,
        scores: players.map((player) => ({
          playerId: player.id,
          name: player.name,
          roundScore: player.roundScore,
          totalScore: player.totalScore
        }))
      }
    ]
  };
}
