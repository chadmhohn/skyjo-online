import type { AiDecisionOptions, AiMove } from './aiContracts';
import type { GameState } from './types';

type SoloAiStrategyModule = {
  chooseAiMoveForState: (state: GameState, options: AiDecisionOptions) => AiMove | null;
};

let strategyPromise: Promise<SoloAiStrategyModule> | null = null;

export function loadSoloAiStrategy(): Promise<SoloAiStrategyModule> {
  strategyPromise ??= import('./aiProjection').then(({ chooseAiMoveForState }) => ({ chooseAiMoveForState }));
  return strategyPromise;
}
