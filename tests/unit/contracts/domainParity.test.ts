import path from 'node:path';
import {
  cancelDiscardSelection,
  chooseDiscard,
  createMultiplayerGame,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame,
  startNextRound
} from '../../../src/game';
import { projectAiKnowledge } from '../../../src/aiProjection';
import {
  chooseAiMove,
  soloAiStrategyVersion,
  type AiDifficulty,
  type AiKnowledgeState,
  type AiMove
} from '../../../src/aiStrategy';
import { createSeededRandom } from '../../../src/runtime';
import {
  redactGameState,
  type PublicGameStateSnapshot
} from '../../../src/protocolV2';
import {
  resolveSoloGameSetup,
  type SoloGameSetup
} from '../../../src/soloAiSetup';
import type { GameState } from '../../../src/types';
import { fixtureRoot, readJson } from './fixtureSupport';

type DomainAction =
  | { type: 'reveal-opening-card'; cardIndex: number }
  | { type: 'choose-discard' }
  | { type: 'cancel-discard' }
  | { type: 'draw-blind'; randomSeed: number }
  | { type: 'replace-card'; cardIndex: number }
  | { type: 'discard-and-reveal'; cardIndex: number }
  | { type: 'start-next-round'; randomSeed: number };

interface SeededSoloInput {
  kind: 'solo';
  seed: number;
  aiOpponentCount: number;
}

interface SeededMultiplayerInput {
  kind: 'multiplayer';
  seed: number;
  players: Array<{ id: string; name: string }>;
  round: number;
  previousCloserId: string | null;
}

interface DomainParityDocument {
  contractVersion: number;
  domainRulesVersion: number;
  aiStrategyVersion: number;
  seededGames: Array<{
    name: string;
    input: SeededSoloInput | SeededMultiplayerInput;
    expectedState: GameState;
  }>;
  scenarios: Array<{
    name: string;
    initialState: GameState;
    actions: DomainAction[];
    expectedStates: GameState[];
  }>;
  aiCases: Array<{
    name: string;
    difficulty: AiDifficulty;
    decisionKey: string;
    playerId: string;
    knowledge: AiKnowledgeState;
    expectedMove: AiMove | null;
  }>;
  redactionCases: Array<{
    name: string;
    viewerId: string;
    authoritativeState: GameState;
    expectedKnowledge: AiKnowledgeState;
    expectedPublicSnapshot: PublicGameStateSnapshot;
  }>;
  soloSetupCases: Array<{
    name: string;
    seededGame: string;
    aiPlayerIds: string[];
    gameId: string;
    inputSetup: SoloGameSetup;
    expectedSetup: SoloGameSetup;
  }>;
}

function applyAction(state: GameState, action: DomainAction): GameState {
  switch (action.type) {
    case 'reveal-opening-card':
      return revealOpeningCard(state, action.cardIndex);
    case 'choose-discard':
      return chooseDiscard(state);
    case 'cancel-discard':
      return cancelDiscardSelection(state);
    case 'draw-blind':
      return drawBlind(state, createSeededRandom(action.randomSeed));
    case 'replace-card':
      return replaceCard(state, action.cardIndex);
    case 'discard-and-reveal':
      return discardDrawnAndReveal(state, action.cardIndex);
    case 'start-next-round':
      return startNextRound(state, createSeededRandom(action.randomSeed));
  }
}

function namedScenario(
  scenarios: DomainParityDocument['scenarios'],
  name: string
): DomainParityDocument['scenarios'][number] {
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (!scenario) throw new Error(`Missing domain scenario ${name}.`);
  return scenario;
}

describe('IOS-3 cross-language domain parity corpus', () => {
  const document = readJson<DomainParityDocument>(path.join(fixtureRoot, 'domain-parity.json'));

  it('pins independent rules and AI strategy versions', () => {
    expect(document).toMatchObject({
      contractVersion: 1,
      domainRulesVersion: 1,
      aiStrategyVersion: soloAiStrategyVersion
    });
  });

  it('replays exact seeded solo and multiplayer games', () => {
    expect(document.seededGames.filter((fixture) => fixture.input.kind === 'solo')).toHaveLength(7);
    for (const fixture of document.seededGames) {
      const input = fixture.input;
      const actual = input.kind === 'solo'
        ? startFreshGame({
            aiOpponentCount: input.aiOpponentCount,
            random: createSeededRandom(input.seed)
          })
        : createMultiplayerGame(
            input.players,
            input.round,
            input.previousCloserId,
            createSeededRandom(input.seed)
          );
      expect(actual, fixture.name).toEqual(fixture.expectedState);
      const cards = [
        ...actual.players.flatMap((player) => player.grid),
        ...actual.drawPile,
        ...actual.discardPile,
        ...(actual.drawnCard ? [actual.drawnCard] : [])
      ].filter((card) => !card.removed);
      expect(cards, fixture.name).toHaveLength(150);
      expect(new Set(cards.map((card) => card.id)).size, fixture.name).toBe(150);
    }
  });

  it('replays every named rules transition exactly', () => {
    for (const fixture of document.scenarios) {
      expect(fixture.expectedStates, fixture.name).toHaveLength(fixture.actions.length);
      let state = structuredClone(fixture.initialState);
      fixture.actions.forEach((action, index) => {
        state = applyAction(state, action);
        expect(state, `${fixture.name}: action ${index + 1} (${action.type})`).toEqual(
          fixture.expectedStates[index]
        );
      });
    }
  });

  it('matches every deterministic Easy, Medium, Hard, and Ultra decision', () => {
    expect(new Set(document.aiCases.map((fixture) => fixture.difficulty))).toEqual(
      new Set<AiDifficulty>(['easy', 'medium', 'hard', 'ultra'])
    );
    for (const fixture of document.aiCases) {
      expect(
        chooseAiMove(fixture.knowledge, {
          playerId: fixture.playerId,
          difficulty: fixture.difficulty,
          decisionKey: fixture.decisionKey
        }),
        fixture.name
      ).toEqual(fixture.expectedMove);
    }
  });

  it('pins column order, final turns, doubling branches, threshold winner, next starter, and recycle', () => {
    const column = namedScenario(
      document.scenarios,
      'matching column clears above the replaced card in discard order'
    ).expectedStates[0];
    expect(column.discardPile.slice(0, 5).map((card) => card.id)).toEqual([
      'column-ada-card-0',
      'column-ada-card-4',
      'column-drawn-five',
      'column-ada-card-8',
      'domain-discard-0'
    ]);

    const tied = namedScenario(
      document.scenarios,
      'every opponent gets a final turn, tied closer doubles, and closer starts next round'
    );
    expect(tied.expectedStates[0]).toMatchObject({
      roundCloserId: 'tie-closer',
      finalTurnPlayerIds: ['tie-final']
    });
    expect(tied.expectedStates[2].players.map((player) => player.roundScore)).toEqual([84, 42]);
    expect(tied.expectedStates.at(-1)?.players[tied.expectedStates.at(-1)?.currentPlayerIndex ?? -1].id)
      .toBe('tie-closer');

    const orderedFinalTurns = namedScenario(
      document.scenarios,
      'three-player final turns advance in seat order before scoring'
    );
    expect(orderedFinalTurns.expectedStates[0]).toMatchObject({
      currentPlayerIndex: 1,
      phase: 'choose-source',
      roundCloserId: 'ordered-closer',
      finalTurnPlayerIds: ['ordered-second', 'ordered-third']
    });
    expect(orderedFinalTurns.expectedStates[2]).toMatchObject({
      currentPlayerIndex: 2,
      phase: 'choose-source',
      roundCloserId: 'ordered-closer',
      finalTurnPlayerIds: ['ordered-third']
    });
    expect(orderedFinalTurns.expectedStates[4]).toMatchObject({
      phase: 'round-over',
      roundCloserId: null,
      nextStarterId: 'ordered-closer',
      finalTurnPlayerIds: []
    });

    const strictLow = namedScenario(
      document.scenarios,
      'strict-low positive closer does not double'
    ).expectedStates.at(-1);
    expect(strictLow?.players[0].roundScore).toBe(31);
    expect(strictLow?.log[0]).not.toMatch(/doubled/);

    const nonpositive = namedScenario(
      document.scenarios,
      'nonpositive tied closer does not double'
    ).expectedStates.at(-1);
    expect(nonpositive?.players.map((player) => player.roundScore)).toEqual([-8, -8]);
    expect(nonpositive?.log[0]).not.toMatch(/doubled/);

    const threshold = namedScenario(
      document.scenarios,
      'game threshold selects the lowest-total winner'
    ).expectedStates.at(-1);
    expect(threshold).toMatchObject({ phase: 'game-over', winnerId: 'threshold-winner' });

    const recycle = namedScenario(
      document.scenarios,
      'empty draw pile deterministically recycles below the discard top'
    ).expectedStates[0];
    expect(recycle.drawnCard?.id).toBe('recycle-b');
    expect(recycle.discardPile.map((card) => card.id)).toEqual(['recycle-top']);
  });

  it('projects hidden cards and private draws without identifiers or hidden values', () => {
    for (const fixture of document.redactionCases) {
      const actual = projectAiKnowledge(fixture.authoritativeState, fixture.viewerId);
      expect(actual, fixture.name).toEqual(fixture.expectedKnowledge);
      const publicSnapshot = redactGameState(fixture.authoritativeState, fixture.viewerId);
      expect(publicSnapshot, fixture.name).toEqual(fixture.expectedPublicSnapshot);
      const hiddenCards = actual.players
        .flatMap((player) => player.grid)
        .filter((card) => !card.faceUp && !card.removed);
      expect(hiddenCards.every((card) => card.value === null), fixture.name).toBe(true);
      const serialized = JSON.stringify(actual);
      expect(serialized, fixture.name).not.toMatch(/-card-|draw-secret|private-draw|public-discard/);
      const serializedPublicSnapshot = JSON.stringify(publicSnapshot);
      expect(serializedPublicSnapshot, fixture.name).not.toMatch(/-card-|draw-secret|private-draw/);
      expect(publicSnapshot.players.every((player, playerIndex) =>
        player.grid.every((card, cardIndex) => card.id === `grid-${playerIndex}-${cardIndex}`)
      ), fixture.name).toBe(true);
      expect(publicSnapshot.discardPile.top?.id, fixture.name).toBe('discard-top');
      expect(publicSnapshot.drawnCard?.id ?? null, fixture.name).toBe(
        fixture.viewerId === fixture.authoritativeState.players[fixture.authoritativeState.currentPlayerIndex]?.id
          ? 'drawn-card'
          : null
      );
    }
    expect(document.redactionCases.map((fixture) => fixture.expectedKnowledge.drawnCardValue)).toEqual([6, null]);
  });

  it('matches fixed and balanced deterministic Mixed solo setup resolution', () => {
    const seededGames = new Map(
      document.seededGames.map((fixture) => [fixture.name, fixture.expectedState])
    );
    for (const fixture of document.soloSetupCases) {
      const state = seededGames.get(fixture.seededGame);
      expect(state, fixture.name).toBeDefined();
      if (!state) continue;
      const ids = state.players
        .filter((player) => player.kind === 'ai')
        .map((player) => player.id)
        .sort((left, right) => left.localeCompare(right));
      expect(ids, fixture.name).toEqual(fixture.aiPlayerIds);
      expect(resolveSoloGameSetup(fixture.inputSetup, state, fixture.gameId), fixture.name).toEqual(
        fixture.expectedSetup
      );
    }
  });
});
