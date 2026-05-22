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

export interface RoomPlayer {
  id: string;
  userId?: string;
  name: string;
  connected: boolean;
  host: boolean;
}

export interface RoomChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
}

export interface MultiplayerRoom {
  code: string;
  hostId: string;
  players: RoomPlayer[];
  chatMessages: RoomChatMessage[];
  readyForNextRoundPlayerIds: string[];
  state: GameState | null;
  status: 'waiting' | 'playing' | 'finished';
  updatedAt: number;
  completedGameId?: string | null;
}

export interface RoundScoreResult {
  playerId: string;
  name: string;
  roundScore: number;
  totalScore: number;
}

export interface RoundHistoryEntry {
  round: number;
  closerId: string;
  scores: RoundScoreResult[];
}

export type TurnPhase = 'opening-reveal' | 'choose-source' | 'choose-replacement' | 'round-over' | 'game-over';

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
  nextStarterId: string | null;
  roundCloserId: string | null;
  finalTurnPlayerIds: string[];
  openingRevealCounts: Record<string, number>;
  roundHistory: RoundHistoryEntry[];
}

export interface MoveResult {
  card: Card;
  drawPile: Card[];
  discardPile: Card[];
}
