import {
  createSoloGameSetup,
  difficultyForSoloPlayer,
  isResolvedSoloGameSetup,
  resolveSoloGameSetup,
  type SoloAiDifficulty
} from '../../../src/soloAiSetup';
import { startFreshGame } from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';

describe('solo AI setup', () => {
  it('keeps fixed profiles compact and defaults legacy-compatible new setup to Hard', () => {
    const state = startFreshGame({ aiOpponentCount: 3, random: createSeededRandom(1) });
    const hard = resolveSoloGameSetup(createSoloGameSetup(3), state, 'game-a');
    expect(hard).toEqual({ aiOpponentCount: 3, difficulty: 'hard', strategyVersion: 1 });
    for (const player of state.players.filter((item) => item.kind === 'ai')) {
      expect(difficultyForSoloPlayer(hard, player.id)).toBe('hard');
    }
    expect(isResolvedSoloGameSetup(hard, state)).toBe(true);
  });

  it('creates complete, balanced, deterministic per-game Mixed assignments', () => {
    for (let count = 1; count <= 7; count += 1) {
      const state = startFreshGame({ aiOpponentCount: count, random: createSeededRandom(10 + count) });
      const draft = createSoloGameSetup(count, 'mixed');
      const first = resolveSoloGameSetup(draft, state, 'e13cbf75-0163-4163-8163-000000000001');
      const replay = resolveSoloGameSetup(draft, structuredClone(state), 'e13cbf75-0163-4163-8163-000000000001');
      expect(replay).toEqual(first);
      expect(Object.keys(first.playerDifficulties ?? {}).sort()).toEqual(
        state.players.filter((player) => player.kind === 'ai').map((player) => player.id).sort()
      );
      const counts = ['easy', 'medium', 'hard', 'ultra'].map(
        (difficulty) =>
          Object.values(first.playerDifficulties ?? {}).filter((value) => value === difficulty).length
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(isResolvedSoloGameSetup(first, state)).toBe(true);
    }
  });

  it('persists exact Mixed identities across roster order and rejects malformed assignments', () => {
    const state = startFreshGame({ aiOpponentCount: 4, random: createSeededRandom(20) });
    const resolved = resolveSoloGameSetup(createSoloGameSetup(4, 'mixed'), state, 'stable-game');
    const reordered = { ...state, players: [state.players[0], ...state.players.slice(1).reverse()] };
    expect(resolveSoloGameSetup(resolved, reordered, 'ignored-after-persist')).toEqual(resolved);

    const aiIds = state.players.filter((player) => player.kind === 'ai').map((player) => player.id);
    const missing = {
      ...resolved,
      playerDifficulties: Object.fromEntries(aiIds.slice(1).map((id) => [id, 'hard' as const]))
    };
    const unsupported = {
      ...resolved,
      playerDifficulties: { ...resolved.playerDifficulties, [aiIds[0]]: 'impossible' as SoloAiDifficulty }
    };
    const unbalanced = {
      ...resolved,
      playerDifficulties: Object.fromEntries(aiIds.map((id) => [id, 'hard' as const]))
    };
    for (const malformed of [missing, unsupported, unbalanced]) {
      expect(() => resolveSoloGameSetup(malformed, state, 'game')).toThrow();
      expect(isResolvedSoloGameSetup(malformed, state)).toBe(false);
    }
    expect(() => difficultyForSoloPlayer(missing, aiIds[0])).toThrow(/no difficulty/i);
  });

  it('resolves a replacement Mixed game from its new game id instead of carrying prior identities', () => {
    const state = startFreshGame({ aiOpponentCount: 7, random: createSeededRandom(21) });
    const prior = resolveSoloGameSetup(
      createSoloGameSetup(7, 'mixed'),
      state,
      '11111111-1111-4111-8111-111111111111'
    );
    const replacementDraft = createSoloGameSetup(prior.aiOpponentCount, prior.difficulty);
    const replacement = resolveSoloGameSetup(
      replacementDraft,
      state,
      '22222222-2222-4222-8222-222222222222'
    );

    expect(replacement.playerDifficulties).not.toEqual(prior.playerDifficulties);
    expect(resolveSoloGameSetup(prior, state, 'ignored-for-continue')).toEqual(prior);
  });

  it('rejects invalid counts, selections, strategy versions, fixed maps, and roster mismatches', () => {
    expect(() => createSoloGameSetup(0)).toThrow(/1 through 7/);
    expect(() => createSoloGameSetup(8)).toThrow(/1 through 7/);
    expect(() => createSoloGameSetup(2.5)).toThrow(/1 through 7/);
    expect(() => createSoloGameSetup(2, 'legendary' as 'hard')).toThrow(/unsupported/i);

    const state = startFreshGame({ aiOpponentCount: 2, random: createSeededRandom(30) });
    expect(() => resolveSoloGameSetup({ ...createSoloGameSetup(2), strategyVersion: 2 as 1 }, state, 'game')).toThrow(
      /strategy version/i
    );
    expect(() =>
      resolveSoloGameSetup(
        { ...createSoloGameSetup(2), playerDifficulties: { 'ai-1': 'hard', 'ai-2': 'hard' } },
        state,
        'game'
      )
    ).toThrow(/fixed/i);
    expect(() => resolveSoloGameSetup(createSoloGameSetup(1), state, 'game')).toThrow(/roster/i);
  });
});
