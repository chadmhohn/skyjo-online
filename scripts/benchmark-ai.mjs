import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import {
  AI_BENCHMARK_BUDGETS,
  AI_BENCHMARK_DRAW_OUTCOME_COUNT,
  AI_BENCHMARK_EVALUATOR,
  AI_BENCHMARK_FORMAT_VERSION,
  AI_BENCHMARK_KIND,
  AI_BENCHMARK_PARAMETERS,
  readAiBenchmarkReleaseVersion,
  readVerifiedAiBenchmarkEvidence,
  resolveAiBenchmarkSourceSha,
  writeAiBenchmarkEvidence
} from './ai-benchmark-evidence.mjs';
import { soloAiStrategyVersion, ultraDrawOutcomeLimit } from '../server-dist/aiStrategy.js';
import { chooseAiMoveForState, legalAiMovesForState } from '../server-dist/aiProjection.js';
import {
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard,
  startFreshGame
} from '../server-dist/game.js';
import { createSeededRandom } from '../server-dist/runtime.js';
import { skyjoCardValueCounts, skyjoDeckCardCount } from '../server-dist/gameRules.js';

const projectRoot = path.resolve();
const [sourceSha, releaseVersion] = await Promise.all([
  resolveAiBenchmarkSourceSha({ projectRoot }),
  readAiBenchmarkReleaseVersion(projectRoot)
]);

let state = startFreshGame({
  aiOpponentCount: AI_BENCHMARK_PARAMETERS.benchmarkAiOpponentCount,
  random: createSeededRandom(AI_BENCHMARK_PARAMETERS.benchmarkStateSeed)
});
while (state.phase === 'opening-reveal') {
  const active = state.players[state.currentPlayerIndex];
  const index = active.grid.findIndex((card) => !card.faceUp && !card.removed);
  state = revealOpeningCard(state, index);
}
state = {
  ...state,
  currentPlayerIndex: state.players.findIndex((player) => player.kind === 'ai')
};
const playerId = state.players[state.currentPlayerIndex].id;

assert.equal(
  ultraDrawOutcomeLimit,
  AI_BENCHMARK_DRAW_OUTCOME_COUNT,
  'Ultra must evaluate only the canonical 15 card values'
);
for (let index = 0; index < AI_BENCHMARK_PARAMETERS.performanceWarmupSamples; index += 1) {
  chooseAiMoveForState(state, { playerId, difficulty: 'ultra', decisionKey: `warm-${index}` });
}

const durations = [];
for (let index = 0; index < AI_BENCHMARK_PARAMETERS.performanceSamples; index += 1) {
  const startedAt = performance.now();
  const move = chooseAiMoveForState(state, { playerId, difficulty: 'ultra', decisionKey: `bench-${index}` });
  durations.push(performance.now() - startedAt);
  assert.ok(move, 'Ultra must choose a move for the canonical benchmark state');
  assert.ok(
    legalAiMovesForState(state, playerId).some(
      (candidate) => candidate.action === move.action && candidate.index === move.index
    ),
    'Ultra benchmark move must be legal'
  );
}

durations.sort((left, right) => left - right);
const percentile = (ratio) => durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))];

function card(id, value, faceUp = true, removed = false) {
  return { id, value, faceUp, removed };
}

function player(id, values, visibleIndexes) {
  const grid = values.map((value, index) => card(`${id}-${index}-${value}`, value, visibleIndexes.includes(index)));
  return {
    id,
    name: id,
    kind: id === 'bot' ? 'ai' : 'human',
    grid,
    totalScore: 0,
    roundScore: grid.reduce((sum, item) => sum + (item.faceUp ? item.value : 0), 0)
  };
}

function qualityState({ botValues, visibleIndexes, phase, selectedSource, discardValue, drawnValue, drawValue = 12 }) {
  return {
    players: [
      player('bot', botValues, visibleIndexes),
      player('human', Array(12).fill(0), Array.from({ length: 12 }, (_, index) => index))
    ],
    drawPile: [card(`quality-draw-${drawValue}`, drawValue, false), card('quality-draw-0', 0, false)],
    discardPile: [card(`quality-discard-${discardValue}`, discardValue)],
    currentPlayerIndex: 0,
    phase,
    selectedSource,
    drawnCard: drawnValue === null ? null : card(`quality-drawn-${drawnValue}`, drawnValue),
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: { bot: visibleIndexes.length, human: 12 },
    roundHistory: []
  };
}

const sourceQualityFixtures = skyjoCardValueCounts.map(({ value, count }) => ({
  name: `source-choice-draw-${value}`,
  weight: count / skyjoDeckCardCount,
  state: qualityState({
    botValues: [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1],
    visibleIndexes: [0, 1],
    phase: 'choose-source',
    selectedSource: null,
    discardValue: 0,
    drawnValue: null,
    drawValue: value
  })
}));

const qualityFixtures = [
  ...sourceQualityFixtures,
  {
    name: 'blind-placement',
    weight: 1,
    state: qualityState({
      botValues: [12, 11, 10, 7, 6, 5, 4, 3, 2, 1, 0, -1],
      visibleIndexes: [0, 1, 2],
      phase: 'choose-replacement',
      selectedSource: 'draw',
      discardValue: 6,
      drawnValue: -2
    })
  },
  {
    name: 'column-opportunity',
    weight: 1,
    state: qualityState({
      botValues: [5, 9, 8, 7, 5, 6, 4, 3, 10, 2, 1, 0],
      visibleIndexes: [0, 1, 4],
      phase: 'choose-replacement',
      selectedSource: 'discard',
      discardValue: 5,
      drawnValue: null
    })
  },
  // Closing-risk fixtures intentionally carry one quarter of a normal placement
  // fixture: a one-hidden-card board is a rare late-round state, and these
  // targeted checks supplement rather than dominate the 2,000 real dealt games.
  {
    name: 'closing-doubling-risk',
    weight: AI_BENCHMARK_PARAMETERS.closingScenarioWeight,
    state: qualityState({
      botValues: [2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      visibleIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      phase: 'choose-replacement',
      selectedSource: 'draw',
      discardValue: 6,
      drawnValue: 3
    })
  },
  {
    name: 'closing-reveal-risk',
    weight: AI_BENCHMARK_PARAMETERS.closingScenarioWeight,
    state: qualityState({
      botValues: [12, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      visibleIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      phase: 'choose-replacement',
      selectedSource: 'draw',
      discardValue: 6,
      drawnValue: 12
    })
  }
];

function applyMove(snapshot, move) {
  if (move.action === 'discard') return chooseDiscard(snapshot);
  if (move.action === 'draw') return drawBlind(snapshot, () => 0.5);
  if (move.action === 'replace') return replaceCard(snapshot, move.index ?? -1);
  return discardDrawnAndReveal(snapshot, move.index ?? -1);
}

function rawGridScore(snapshot, id) {
  const active = snapshot.players.find((candidate) => candidate.id === id);
  return active.grid.reduce((sum, item) => sum + (item.removed ? 0 : item.value), 0);
}

function hiddenCount(snapshot, id) {
  const active = snapshot.players.find((candidate) => candidate.id === id);
  return active.grid.filter((item) => !item.faceUp && !item.removed).length;
}

function trueOutcomeBenefit(before, after, id) {
  const beforeScore = rawGridScore(before, id);
  const afterScore = rawGridScore(after, id);
  const newlyClosed = before.roundCloserId === null && after.roundCloserId === id;
  const opponentScores = after.players
    .filter((candidate) => candidate.id !== id)
    .map((candidate) => rawGridScore(after, candidate.id));
  const doubled = newlyClosed && afterScore > 0 && opponentScores.some((score) => afterScore >= score);
  const effectiveAfterScore = doubled ? afterScore * 2 : afterScore;
  const revealProgress = Math.max(0, hiddenCount(before, id) - hiddenCount(after, id)) * 0.25;
  return beforeScore - effectiveAfterScore + revealProgress;
}

function completeOutcomes(snapshot) {
  const id = snapshot.players[snapshot.currentPlayerIndex].id;
  const firstMoves = legalAiMovesForState(snapshot, id);
  const outcomes = [];
  for (const first of firstMoves) {
    const firstState = applyMove(snapshot, first);
    if (firstState.phase !== 'choose-replacement' || firstState.players[firstState.currentPlayerIndex]?.id !== id) {
      outcomes.push(firstState);
      continue;
    }
    for (const second of legalAiMovesForState(firstState, id)) outcomes.push(applyMove(firstState, second));
  }
  return outcomes;
}

function runProfile(snapshot, difficulty, decisionKey) {
  const id = snapshot.players[snapshot.currentPlayerIndex].id;
  const first = chooseAiMoveForState(snapshot, { playerId: id, difficulty, decisionKey: `${decisionKey}:1` });
  if (!first) return null;
  const firstState = applyMove(snapshot, first);
  if (firstState.phase !== 'choose-replacement' || firstState.players[firstState.currentPlayerIndex]?.id !== id) {
    return firstState;
  }
  const second = chooseAiMoveForState(firstState, { playerId: id, difficulty, decisionKey: `${decisionKey}:2` });
  return second ? applyMove(firstState, second) : null;
}

const quality = Object.fromEntries(
  ['easy', 'medium', 'hard', 'ultra'].map((difficulty) => {
    const scenarios = Object.fromEntries(
      qualityFixtures.map((fixture) => {
        const id = fixture.state.players[fixture.state.currentPlayerIndex].id;
        const oracleBenefit = Math.max(
          ...completeOutcomes(fixture.state).map((outcome) => trueOutcomeBenefit(fixture.state, outcome, id))
        );
        const benefits = Array.from({ length: AI_BENCHMARK_PARAMETERS.qualitySamplesPerScenario }, (_, index) => {
          const outcome = runProfile(fixture.state, difficulty, `quality-${fixture.name}-${index}`);
          return outcome ? trueOutcomeBenefit(fixture.state, outcome, id) : -100;
        });
        const benefit = benefits.reduce((sum, value) => sum + value, 0) / benefits.length;
        return [fixture.name, {
          benefit: Number(benefit.toFixed(4)),
          regret: Number((oracleBenefit - benefit).toFixed(4)),
          weight: fixture.weight
        }];
      })
    );
    const totalWeight = Object.values(scenarios).reduce((sum, scenario) => sum + scenario.weight, 0);
    const aggregateBenefit =
      Object.values(scenarios).reduce((sum, scenario) => sum + scenario.benefit * scenario.weight, 0) /
      totalWeight;
    const aggregateRegret =
      Object.values(scenarios).reduce((sum, scenario) => sum + scenario.regret * scenario.weight, 0) /
      totalWeight;
    return [difficulty, {
      aggregateBenefit: Number(aggregateBenefit.toFixed(4)),
      aggregateRegret: Number(aggregateRegret.toFixed(4)),
      scenarios
    }];
  })
);

assert.ok(quality.ultra.aggregateBenefit >= quality.hard.aggregateBenefit, 'Ultra benefit must be at least Hard');
assert.ok(quality.hard.aggregateBenefit >= quality.medium.aggregateBenefit, 'Hard benefit must be at least Medium');
assert.ok(quality.medium.aggregateBenefit >= quality.easy.aggregateBenefit, 'Medium benefit must be at least Easy');

const seededDealSampleCount = AI_BENCHMARK_PARAMETERS.seededDealSamples;
const seededDealBenefits = Object.fromEntries(
  ['easy', 'medium', 'hard', 'ultra'].map((difficulty) => [difficulty, 0])
);
const seededDealRegret = Object.fromEntries(
  ['easy', 'medium', 'hard', 'ultra'].map((difficulty) => [difficulty, 0])
);
const seededDealFirstSeed = AI_BENCHMARK_PARAMETERS.seededDealFirstSeed;
const seededDealLastSeed = seededDealFirstSeed + seededDealSampleCount - 1;
for (let seed = seededDealFirstSeed; seed <= seededDealLastSeed; seed += 1) {
  let dealt = startFreshGame({
    aiOpponentCount: AI_BENCHMARK_PARAMETERS.seededDealAiOpponentCount,
    random: createSeededRandom(seed)
  });
  while (dealt.phase === 'opening-reveal') {
    const active = dealt.players[dealt.currentPlayerIndex];
    const cardIndex = active.grid.findIndex((candidate) => !candidate.faceUp && !candidate.removed);
    dealt = revealOpeningCard(dealt, cardIndex);
  }
  dealt = {
    ...dealt,
    currentPlayerIndex: dealt.players.findIndex((candidate) => candidate.kind === 'ai')
  };
  const id = dealt.players[dealt.currentPlayerIndex].id;
  const oracleBenefit = Math.max(
    ...completeOutcomes(dealt).map((outcome) => trueOutcomeBenefit(dealt, outcome, id))
  );
  for (const difficulty of ['easy', 'medium', 'hard', 'ultra']) {
    const outcome = runProfile(dealt, difficulty, `seeded-deal-${seed}`);
    const benefit = outcome ? trueOutcomeBenefit(dealt, outcome, id) : -100;
    seededDealBenefits[difficulty] += benefit;
    seededDealRegret[difficulty] += oracleBenefit - benefit;
  }
}
for (const difficulty of Object.keys(seededDealBenefits)) {
  seededDealBenefits[difficulty] = Number(
    (seededDealBenefits[difficulty] / seededDealSampleCount).toFixed(6)
  );
  seededDealRegret[difficulty] = Number(
    (seededDealRegret[difficulty] / seededDealSampleCount).toFixed(6)
  );
}
assert.ok(seededDealBenefits.ultra >= seededDealBenefits.hard, 'Seeded Ultra benefit must be at least Hard');
assert.ok(seededDealBenefits.hard >= seededDealBenefits.medium, 'Seeded Hard benefit must be at least Medium');
assert.ok(seededDealBenefits.medium >= seededDealBenefits.easy, 'Seeded Medium benefit must be at least Easy');
assert.ok(seededDealRegret.ultra <= seededDealRegret.hard, 'Seeded Ultra regret must not exceed Hard');
assert.ok(seededDealRegret.hard <= seededDealRegret.medium, 'Seeded Hard regret must not exceed Medium');
assert.ok(seededDealRegret.medium <= seededDealRegret.easy, 'Seeded Medium regret must not exceed Easy');

const evidence = {
  formatVersion: AI_BENCHMARK_FORMAT_VERSION,
  kind: AI_BENCHMARK_KIND,
  sourceSha,
  releaseVersion,
  strategyVersion: soloAiStrategyVersion,
  parameters: { ...AI_BENCHMARK_PARAMETERS },
  budgets: { ...AI_BENCHMARK_BUDGETS },
  performance: {
    sampleCount: durations.length,
    outcomeLimit: ultraDrawOutcomeLimit,
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(durations[durations.length - 1].toFixed(3))
  },
  quality,
  seededDeals: {
    sampleCount: seededDealSampleCount,
    firstSeed: seededDealFirstSeed,
    lastSeed: seededDealLastSeed,
    evaluator: AI_BENCHMARK_EVALUATOR,
    benefits: seededDealBenefits,
    regret: seededDealRegret
  }
};

assert.ok(
  evidence.performance.p95Ms < evidence.budgets.p95Ms,
  `Ultra p95 ${evidence.performance.p95Ms}ms exceeds 5ms`
);
assert.ok(
  evidence.performance.maxMs < evidence.budgets.maxMs,
  `Ultra max ${evidence.performance.maxMs}ms exceeds 16ms`
);

const outputDirectory = path.resolve('test-results', 'ai');
const outputPath = path.join(outputDirectory, 'benchmark.json');
const written = await writeAiBenchmarkEvidence(outputPath, evidence);
const verified = await readVerifiedAiBenchmarkEvidence(outputPath, written.checksumPath, {
  expectedReleaseVersion: releaseVersion,
  expectedSourceSha: sourceSha,
  expectedStrategyVersion: soloAiStrategyVersion
});
assert.equal(verified.digest, written.digest, 'Written AI evidence checksum must verify');
assert.deepEqual(verified.evidence, evidence, 'Written AI evidence must verify without normalization');
console.log(
  `ai benchmark passed for ${sourceSha}: p95 ${evidence.performance.p95Ms}ms, ` +
  `max ${evidence.performance.maxMs}ms; quality E ${seededDealBenefits.easy}, M ${seededDealBenefits.medium}, ` +
  `H ${seededDealBenefits.hard}, U ${seededDealBenefits.ultra}; evidence ${written.digest}`
);
