import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} from '../../src/game';
import { getBestAiMove } from '../../src/aiProjection';
import { createSeededRandom, type RandomSource } from '../../src/runtime';
import type { Card, GameState, Player } from '../../src/types';

export interface SoloProgressGameStates {
  opening: GameState;
  chooseSource: GameState;
  drawnDecision: GameState;
  finalTurn: GameState;
  roundOver: GameState;
}

function playAutomatedStep(state: GameState, random: RandomSource): GameState {
  if (state.phase === 'game-over') return state;
  if (state.phase === 'round-over') return startNextRound(state, random);
  const player = state.players[state.currentPlayerIndex];
  if (state.phase === 'opening-reveal') {
    return revealOpeningCard(state, player.grid.findIndex((card) => !card.faceUp && !card.removed));
  }
  const move = getBestAiMove(state);
  if (state.phase === 'choose-source') {
    return move.action === 'discard' ? chooseDiscard(state) : drawBlind(state, random);
  }
  if (move.action === 'reveal') return discardDrawnAndReveal(state, move.index ?? 0);
  return replaceCard(state, move.index ?? 0);
}

export function soloProgressGameStates(): SoloProgressGameStates {
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = createSeededRandom(seed);
    let state = startFreshGame({ aiOpponentCount: 1, random });
    const opening = state;
    let chooseSource: GameState | undefined;
    let finalTurn: GameState | undefined;
    for (let step = 0; step < 5_000; step += 1) {
      const activePlayer = state.players[state.currentPlayerIndex];
      if (!chooseSource && !state.roundCloserId && state.phase === 'choose-source' && activePlayer.kind === 'human') {
        chooseSource = state;
      }
      if (
        !finalTurn &&
        state.roundCloserId &&
        (state.phase === 'choose-source' || state.phase === 'choose-replacement') &&
        activePlayer.kind === 'human'
      ) {
        finalTurn = state;
      }
      if (chooseSource && finalTurn && state.phase === 'round-over') {
        return {
          opening,
          chooseSource,
          drawnDecision: drawBlind(chooseSource, createSeededRandom(seed + 1_000)),
          finalTurn,
          roundOver: state
        };
      }
      state = playAutomatedStep(state, random);
    }
  }
  throw new Error('Could not build deterministic solo progress states.');
}

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
