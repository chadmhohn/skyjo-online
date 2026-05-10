export interface Card {
  value: number;
  id: string;
  faceUp: boolean;
  removed: boolean;
}

export interface Player {
  id: string;
  kind: 'human' | 'ai';
  name: string;
  grid: Card[];
  totalScore: number;
  roundScore: number;
}

export interface GameRoom {
  id: string;
  players: Player[];
  currentTurn: string;
  drawPile: Card[];
  discardPile: Card[];
  status: 'waiting' | 'playing' | 'finished';
  password?: string;
}

export type TurnPhase = 'choose-source' | 'choose-replacement' | 'round-over' | 'game-over';

export interface GameState {
  players: Player[];
  drawPile: Card[];
  discardPile: Card[];
  currentPlayerIndex: number;
  phase: TurnPhase;
  selectedSource: 'draw' | 'discard' | null;
  drawnCard: Card | null;
  round: number;
  log: string[];
  winnerId: string | null;
}

export interface MoveResult {
  card: Card;
  drawPile: Card[];
  discardPile: Card[];
}
