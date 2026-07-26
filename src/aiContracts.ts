export const soloAiStrategyVersion = 1 as const;

export type AiDifficulty = 'easy' | 'medium' | 'hard' | 'ultra';
export type AiMove = { action: 'discard' | 'draw' | 'replace' | 'reveal'; index?: number };
export type AiPhase = 'opening-reveal' | 'choose-source' | 'choose-replacement' | 'round-over' | 'game-over';
export type AiSelectedSource = 'draw' | 'discard' | null;

export interface AiDecisionOptions {
  playerId: string;
  difficulty: AiDifficulty;
  decisionKey: string;
}

export interface AiKnowledgeCard {
  readonly faceUp: boolean;
  readonly removed: boolean;
  readonly value: number | null;
}

export interface AiKnowledgePlayer {
  readonly id: string;
  readonly grid: readonly AiKnowledgeCard[];
  readonly totalScore: number;
}

export interface AiKnowledgeState {
  readonly players: readonly AiKnowledgePlayer[];
  readonly currentPlayerIndex: number;
  readonly phase: AiPhase;
  readonly selectedSource: AiSelectedSource;
  readonly drawnCardValue: number | null;
  readonly discardTopValue: number | null;
  readonly discardPileCount: number;
  readonly drawPileCount: number;
  readonly knownValues: readonly number[];
  readonly roundCloserId: string | null;
  readonly finalTurnPlayerIds: readonly string[];
}
