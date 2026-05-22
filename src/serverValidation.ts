import {
  cancelDiscardSelection,
  chooseDiscard,
  createMultiplayerGame,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from './game.js';
import type { Card, GameState, Player, RoomPlayer } from './types';

type RoomPlayerSeed = Pick<RoomPlayer, 'id' | 'name'>;
type RoundPlayerSeed = Pick<Player, 'id' | 'name' | 'totalScore'>;

interface ValidationResult {
  ok: boolean;
  message?: string;
}

const gridSize = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!deepEqual(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return false;
}

function changedState(currentState: GameState, nextState: GameState): GameState | null {
  return deepEqual(currentState, nextState) ? null : nextState;
}

function addCandidate(candidates: GameState[], currentState: GameState, nextState: GameState): void {
  const changed = changedState(currentState, nextState);
  if (!changed) return;
  if (!candidates.some((candidate) => deepEqual(candidate, changed))) candidates.push(changed);
}

export function createInitialRoomState(players: RoomPlayerSeed[]): GameState {
  return createMultiplayerGame(players.map((player) => ({ id: player.id, name: player.name })));
}

export function createNextRoundRoomState(state: GameState): GameState {
  const players: RoundPlayerSeed[] = state.players.map((player) => ({
    id: player.id,
    name: player.name,
    totalScore: player.totalScore
  }));
  return {
    ...createMultiplayerGame(players, state.round + 1, state.nextStarterId),
    roundHistory: state.roundHistory ?? []
  };
}

export function legalMultiplayerStateUpdates(currentState: GameState): GameState[] {
  const candidates: GameState[] = [];
  const activePlayer = currentState.players[currentState.currentPlayerIndex];
  if (!activePlayer) return candidates;

  if (currentState.phase === 'opening-reveal') {
    for (let index = 0; index < gridSize; index += 1) {
      addCandidate(candidates, currentState, revealOpeningCard(currentState, index));
    }
    return candidates;
  }

  if (currentState.phase === 'choose-source') {
    if (currentState.discardPile.length > 0) {
      addCandidate(candidates, currentState, chooseDiscard(currentState));
    }
    if (currentState.drawPile.length > 0) {
      addCandidate(candidates, currentState, drawBlind(currentState));
    }
    return candidates;
  }

  if (currentState.phase === 'choose-replacement') {
    if (currentState.selectedSource === 'discard') {
      addCandidate(candidates, currentState, cancelDiscardSelection(currentState));
    }
    if (currentState.selectedSource === 'discard' && currentState.discardPile.length === 0) return candidates;
    if (currentState.selectedSource === 'draw' && !currentState.drawnCard) return candidates;

    for (let index = 0; index < activePlayer.grid.length; index += 1) {
      if (!activePlayer.grid[index]?.removed) {
        addCandidate(candidates, currentState, replaceCard(currentState, index));
      }
      if (currentState.selectedSource === 'draw' && currentState.drawnCard && !activePlayer.grid[index]?.faceUp && !activePlayer.grid[index]?.removed) {
        addCandidate(candidates, currentState, discardDrawnAndReveal(currentState, index));
      }
    }
  }

  return candidates;
}

function cardSortKey(card: unknown): string {
  if (!isRecord(card)) return '';
  return `${String(card.id)}:${String(card.value)}:${String(card.faceUp)}:${String(card.removed)}`;
}

function sortedCards(cards: unknown[]): unknown[] {
  return [...cards].sort((left, right) => cardSortKey(left).localeCompare(cardSortKey(right)));
}

function unorderedCardsEqual(left: unknown, right: Card[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return deepEqual(sortedCards(left), sortedCards(right));
}

function isLegalRecycledDrawUpdate(currentState: GameState, proposedState: Record<string, unknown>): boolean {
  if (currentState.phase !== 'choose-source' || currentState.drawPile.length > 0 || currentState.discardPile.length <= 1) {
    return false;
  }

  const activePlayer = currentState.players[currentState.currentPlayerIndex];
  if (!activePlayer) return false;
  const topDiscard = currentState.discardPile[0];
  const recycledCards = currentState.discardPile.slice(1).map((card) => ({
    ...card,
    faceUp: false,
    removed: false
  }));

  return recycledCards.some((card, index) => {
    const drawnCard = { ...card, faceUp: true };
    const remainingDrawPile = recycledCards.filter((_, cardIndex) => cardIndex !== index);
    if (!unorderedCardsEqual(proposedState.drawPile, remainingDrawPile)) return false;

    const expectedState = {
      ...currentState,
      drawPile: proposedState.drawPile as Card[],
      discardPile: topDiscard ? [topDiscard] : [],
      drawnCard,
      selectedSource: 'draw' as const,
      phase: 'choose-replacement' as const,
      log: [`${activePlayer.name} drew a ${drawnCard.value}.`, ...currentState.log].slice(0, 8)
    };

    return deepEqual(expectedState, proposedState);
  });
}

export function validateMultiplayerStateUpdate(
  currentState: GameState | null,
  proposedState: unknown,
  playerId: string
): ValidationResult {
  if (!currentState) return { ok: false, message: 'No active game.' };

  const activePlayer = currentState.players[currentState.currentPlayerIndex];
  if (!activePlayer) return { ok: false, message: 'Current game state is invalid.' };
  if (activePlayer.id !== playerId) return { ok: false, message: 'It is not your turn.' };

  if (!isRecord(proposedState)) return { ok: false, message: 'Invalid game state update.' };

  const legalStates = legalMultiplayerStateUpdates(currentState);
  if (legalStates.some((state) => deepEqual(state, proposedState))) return { ok: true };
  if (isLegalRecycledDrawUpdate(currentState, proposedState)) return { ok: true };

  return { ok: false, message: 'That move is not legal.' };
}
