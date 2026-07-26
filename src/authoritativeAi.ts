import { chooseAiMoveForState } from './aiProjection.js';
import {
  reduceAuthoritativeGameCommand,
  type GameCommand,
  type GameCommandReduction
} from './protocolV2.js';
import type { RandomSource } from './runtime.js';
import type { GameState } from './types.js';

export const MULTIPLAYER_AI_DIFFICULTY = 'hard' as const;

export function reduceAuthoritativeAiAction(
  state: GameState | null,
  playerId: string,
  random: RandomSource
): GameCommandReduction {
  if (!state) return { ok: false, message: 'No active game.' };
  const activePlayer = state.players[state.currentPlayerIndex];
  if (!activePlayer || activePlayer.id !== playerId) {
    return { ok: false, message: 'The AI seat is not the current player.' };
  }
  if (state.phase === 'round-over' || state.phase === 'game-over') {
    return { ok: false, message: 'The game is waiting for round confirmation.' };
  }

  const chooseHardMove = (current: GameState) =>
    chooseAiMoveForState(current, {
      playerId,
      difficulty: MULTIPLAYER_AI_DIFFICULTY,
      decisionKey: `multiplayer:${current.round}:${current.log[0] ?? ''}`
    });

  if (state.phase === 'opening-reveal') {
    const openingMove = chooseHardMove(state);
    return openingMove?.action === 'reveal' && openingMove.index !== undefined
      ? reduceAuthoritativeGameCommand(
          state,
          playerId,
          { type: 'reveal-opening-card', cardIndex: openingMove.index },
          random
        )
      : { ok: false, message: 'The AI seat has no opening card to reveal.' };
  }

  let current = state;
  if (current.phase === 'choose-source') {
    const sourceMove = chooseHardMove(current);
    if (!sourceMove) return { ok: false, message: 'The AI seat has no legal source action.' };
    const sourceAction: GameCommand = sourceMove.action === 'discard'
      ? { type: 'choose-discard' }
      : { type: 'draw-blind' };
    const sourceReduction = reduceAuthoritativeGameCommand(current, playerId, sourceAction, random);
    if (!sourceReduction.ok) return sourceReduction;
    current = sourceReduction.state;
  }

  if (current.phase !== 'choose-replacement') {
    return { ok: false, message: 'The AI action did not reach a replacement decision.' };
  }
  const placementMove = chooseHardMove(current);
  if (!placementMove) return { ok: false, message: 'The AI seat has no legal placement action.' };
  const cardIndex = placementMove.index ?? 0;
  const placementAction: GameCommand = placementMove.action === 'reveal'
    ? { type: 'discard-and-reveal', cardIndex }
    : { type: 'replace-card', cardIndex };
  return reduceAuthoritativeGameCommand(current, playerId, placementAction, random);
}
