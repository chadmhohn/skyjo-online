export interface Card {
  value: number;
  id: string;
  faceUp: boolean;
}

export interface Player {
  id: string;
  name: string;
  grid: Card[][]; // 3 rows x 4 columns
  score: number;
  ready: boolean;
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