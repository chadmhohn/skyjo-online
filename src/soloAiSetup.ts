import { soloAiStrategyVersion, type AiDifficulty } from './aiContracts.js';
import type { GameState } from './types';

export type SoloAiDifficulty = AiDifficulty;
export type SoloAiDifficultySelection = SoloAiDifficulty | 'mixed';

export interface SoloGameSetup {
  readonly aiOpponentCount: number;
  readonly difficulty: SoloAiDifficultySelection;
  readonly strategyVersion?: typeof soloAiStrategyVersion;
  readonly playerDifficulties?: Readonly<Record<string, SoloAiDifficulty>>;
}

const fixedDifficulties = ['easy', 'medium', 'hard', 'ultra'] as const;

function isFixedDifficulty(value: unknown): value is SoloAiDifficulty {
  return fixedDifficulties.includes(value as SoloAiDifficulty);
}

function isDifficultySelection(value: unknown): value is SoloAiDifficultySelection {
  return value === 'mixed' || isFixedDifficulty(value);
}

function validateOpponentCount(aiOpponentCount: number): void {
  if (!Number.isSafeInteger(aiOpponentCount) || aiOpponentCount < 1 || aiOpponentCount > 7) {
    throw new Error('AI opponent count must be an integer from 1 through 7.');
  }
}

function soloAiPlayerIds(state: GameState, aiOpponentCount: number): string[] {
  validateOpponentCount(aiOpponentCount);
  const playerIds = state.players.filter((player) => player.kind === 'ai').map((player) => player.id);
  if (playerIds.length !== aiOpponentCount || state.players.length !== aiOpponentCount + 1) {
    throw new Error('Solo AI setup does not match the game roster.');
  }
  return [...playerIds].sort((left, right) => left.localeCompare(right));
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function nextRandom(seed: number): { seed: number; value: number } {
  const value = (seed + 0x6d2b79f5) >>> 0;
  let mixed = value;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return { seed: value, value: ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296 };
}

function createMixedAssignments(gameId: string, playerIds: readonly string[]): Record<string, SoloAiDifficulty> {
  const shuffled = [...playerIds];
  let seed = hashSeed(`${gameId}:${playerIds.join(':')}:${soloAiStrategyVersion}`);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const random = nextRandom(seed);
    seed = random.seed;
    const swapIndex = Math.floor(random.value * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const offsetRandom = nextRandom(seed);
  const offset = Math.floor(offsetRandom.value * fixedDifficulties.length);
  return Object.fromEntries(
    shuffled.map((playerId, index) => [
      playerId,
      fixedDifficulties[(offset + index) % fixedDifficulties.length]
    ])
  );
}

function validateMixedAssignments(
  assignments: unknown,
  playerIds: readonly string[]
): asserts assignments is Readonly<Record<string, SoloAiDifficulty>> {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    throw new Error('Mixed AI setup requires one persisted difficulty for every AI player.');
  }
  const record = assignments as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  if (keys.length !== playerIds.length || keys.some((key, index) => key !== playerIds[index])) {
    throw new Error('Mixed AI assignments do not match the game roster.');
  }
  if (keys.some((key) => !isFixedDifficulty(record[key]))) {
    throw new Error('Mixed AI assignments contain an unsupported difficulty.');
  }
  const counts = fixedDifficulties.map(
    (difficulty) => keys.filter((key) => record[key] === difficulty).length
  );
  if (Math.max(...counts) - Math.min(...counts) > 1) {
    throw new Error('Mixed AI assignments must be balanced across difficulty levels.');
  }
}

export function createSoloGameSetup(
  aiOpponentCount: number,
  difficulty: SoloAiDifficultySelection = 'hard'
): SoloGameSetup {
  validateOpponentCount(aiOpponentCount);
  if (!isDifficultySelection(difficulty)) throw new Error('Unsupported solo AI difficulty.');
  return { aiOpponentCount, difficulty, strategyVersion: soloAiStrategyVersion };
}

export function resolveSoloGameSetup(
  setup: SoloGameSetup,
  state: GameState,
  gameId: string
): SoloGameSetup {
  const playerIds = soloAiPlayerIds(state, setup.aiOpponentCount);
  if (!isDifficultySelection(setup.difficulty)) throw new Error('Unsupported solo AI difficulty.');
  if (setup.strategyVersion !== undefined && setup.strategyVersion !== soloAiStrategyVersion) {
    throw new Error('Unsupported solo AI strategy version.');
  }

  if (setup.difficulty !== 'mixed') {
    if (setup.playerDifficulties !== undefined) {
      throw new Error('Fixed AI difficulty setup cannot contain mixed assignments.');
    }
    return {
      aiOpponentCount: setup.aiOpponentCount,
      difficulty: setup.difficulty,
      strategyVersion: soloAiStrategyVersion
    };
  }

  const assignments = setup.playerDifficulties ?? createMixedAssignments(gameId, playerIds);
  validateMixedAssignments(assignments, playerIds);
  return {
    aiOpponentCount: setup.aiOpponentCount,
    difficulty: 'mixed',
    strategyVersion: soloAiStrategyVersion,
    playerDifficulties: { ...assignments }
  };
}

export function isResolvedSoloGameSetup(
  setup: SoloGameSetup,
  state: GameState
): boolean {
  try {
    const playerIds = soloAiPlayerIds(state, setup.aiOpponentCount);
    if (!isDifficultySelection(setup.difficulty)) return false;
    if (setup.strategyVersion !== undefined && setup.strategyVersion !== soloAiStrategyVersion) return false;
    if (setup.difficulty === 'mixed') validateMixedAssignments(setup.playerDifficulties, playerIds);
    else if (setup.playerDifficulties !== undefined) return false;
    return true;
  } catch {
    return false;
  }
}

export function difficultyForSoloPlayer(setup: SoloGameSetup, playerId: string): SoloAiDifficulty {
  if (setup.difficulty !== 'mixed') return setup.difficulty;
  const difficulty = setup.playerDifficulties?.[playerId];
  if (!difficulty) throw new Error(`Mixed AI setup has no difficulty for ${playerId}.`);
  return difficulty;
}
