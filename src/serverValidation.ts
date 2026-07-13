import { createMultiplayerGame } from './game.js';
import { systemRandom, type RandomSource } from './runtime.js';
import type { GameState, Player, RoomPlayer } from './types';

type RoomPlayerSeed = Pick<RoomPlayer, 'id' | 'name'>;
type RoundPlayerSeed = Pick<Player, 'id' | 'name' | 'totalScore'>;

export function createInitialRoomState(players: RoomPlayerSeed[], random: RandomSource = systemRandom): GameState {
  return createMultiplayerGame(players.map((player) => ({ id: player.id, name: player.name })), 1, null, random);
}

export function createNextRoundRoomState(state: GameState, random: RandomSource = systemRandom): GameState {
  const players: RoundPlayerSeed[] = state.players.map((player) => ({
    id: player.id,
    name: player.name,
    totalScore: player.totalScore
  }));
  return {
    ...createMultiplayerGame(players, state.round + 1, state.nextStarterId, random),
    roundHistory: state.roundHistory ?? []
  };
}
