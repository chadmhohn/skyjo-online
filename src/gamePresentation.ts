import type { Player } from './types';

export function knownCardCount(player: Player) {
  return player.grid.filter((card) => card.faceUp || card.removed).length;
}
