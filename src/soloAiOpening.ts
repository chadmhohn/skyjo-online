import { revealOpeningCard } from './game';
import type { GameState } from './types';

export const soloAiOpeningSeatDelayMs = 225;

export function advanceSoloAiOpeningSeat(state: GameState): GameState {
  if (state.phase !== 'opening-reveal') return state;
  const seat = state.players[state.currentPlayerIndex];
  if (!seat || seat.kind !== 'ai') return state;

  let next = state;
  for (let reveal = 0; reveal < 2; reveal += 1) {
    if (next.phase !== 'opening-reveal') break;
    const current = next.players[next.currentPlayerIndex];
    if (!current || current.id !== seat.id || current.kind !== 'ai') break;
    const cardIndex = current.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (cardIndex < 0) break;
    const advanced = revealOpeningCard(next, cardIndex);
    if (advanced === next) break;
    next = advanced;
  }
  return next;
}

export function drainSoloAiOpening(state: GameState): GameState {
  let next = state;
  for (let seat = 0; seat < state.players.length; seat += 1) {
    if (next.phase !== 'opening-reveal' || next.players[next.currentPlayerIndex]?.kind !== 'ai') break;
    const advanced = advanceSoloAiOpeningSeat(next);
    if (advanced === next) break;
    next = advanced;
  }
  return next;
}
