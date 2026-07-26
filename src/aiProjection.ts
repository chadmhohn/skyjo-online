import { chooseAiMove, legalAiMoves } from './aiStrategy.js';
import type {
  AiDecisionOptions,
  AiKnowledgeState,
  AiMove
} from './aiContracts.js';
import type { Card, GameState } from './types.js';

function isPublicGridCard(card: Card): boolean {
  return card.faceUp || card.removed;
}

/**
 * This is the sole authoritative-state adapter for AI decisions. Hidden values,
 * physical card identifiers (which historically encoded values), and draw-pile
 * order are absent from the core strategy's input type.
 */
export function projectAiKnowledge(state: GameState, playerId: string): AiKnowledgeState {
  const seenKnownCardIds = new Set<string>();
  const knownValues: number[] = [];
  const remember = (card: Card) => {
    if (seenKnownCardIds.has(card.id)) return;
    seenKnownCardIds.add(card.id);
    knownValues.push(card.value);
  };

  for (const player of state.players) {
    for (const card of player.grid) {
      if (isPublicGridCard(card)) remember(card);
    }
  }
  for (const card of state.discardPile) remember(card);

  const currentPlayer = state.players[state.currentPlayerIndex];
  const maySeeDrawnCard = currentPlayer?.id === playerId;
  if (maySeeDrawnCard && state.drawnCard) remember(state.drawnCard);

  return {
    players: state.players.map((player) => ({
      id: player.id,
      totalScore: player.totalScore,
      grid: player.grid.map((card) => ({
        faceUp: card.faceUp,
        removed: card.removed,
        value: isPublicGridCard(card) ? card.value : null
      }))
    })),
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    selectedSource: state.selectedSource,
    drawnCardValue: maySeeDrawnCard ? (state.drawnCard?.value ?? null) : null,
    discardTopValue: state.discardPile[0]?.value ?? null,
    discardPileCount: state.discardPile.length,
    drawPileCount: state.drawPile.length,
    knownValues,
    roundCloserId: state.roundCloserId,
    finalTurnPlayerIds: [...state.finalTurnPlayerIds]
  };
}

export function chooseAiMoveForState(state: GameState, options: AiDecisionOptions): AiMove | null {
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== options.playerId) return null;
  return chooseAiMove(projectAiKnowledge(state, options.playerId), options);
}

export function legalAiMovesForState(state: GameState, playerId: string): AiMove[] {
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== playerId) return [];
  return legalAiMoves(projectAiKnowledge(state, playerId));
}

/** Compatibility entry point for the original single shared Hard strategy. */
export function getBestAiMove(state: GameState): AiMove {
  const player = state.players[state.currentPlayerIndex];
  const move = chooseAiMoveForState(state, {
    playerId: player?.id ?? '',
    difficulty: 'hard',
    decisionKey: 'legacy-hard'
  });
  if (move) return move;
  if (state.phase === 'choose-replacement' && player) {
    const index = player.grid.findIndex((card) => !card.removed);
    return { action: 'replace', index: index >= 0 ? index : 0 };
  }
  return { action: 'draw' };
}
