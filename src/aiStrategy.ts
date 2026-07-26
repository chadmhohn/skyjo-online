import {
  skyjoCardValueCounts,
  skyjoColumnIndexes,
  skyjoDefaultHiddenCardEstimate
} from './gameRules.js';
import { createSeededRandom } from './runtime.js';
import {
  soloAiStrategyVersion,
  type AiDecisionOptions,
  type AiDifficulty,
  type AiKnowledgeCard,
  type AiKnowledgePlayer,
  type AiKnowledgeState,
  type AiMove
} from './aiContracts.js';

export { soloAiStrategyVersion } from './aiContracts.js';
export type {
  AiDecisionOptions,
  AiDifficulty,
  AiKnowledgeCard,
  AiKnowledgePlayer,
  AiKnowledgeState,
  AiMove
} from './aiContracts.js';
export const ultraDrawOutcomeLimit = skyjoCardValueCounts.length;

interface AiRoundContext {
  hiddenCount: number;
  isFinalTurn: boolean;
  isLateRound: boolean;
  roundHasCloser: boolean;
  visibleTotal: number;
  opponentEstimatedTotals: readonly number[];
}

interface AiReplacementTarget {
  index: number;
  estimatedCurrentValue: number;
  gain: number;
  score: number;
  faceUp: boolean;
}

interface ValueProbability {
  value: number;
  probability: number;
}

const endgameHiddenCardCount = 2;
const columnClearTieBonus = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function knowledgeFingerprint(knowledge: AiKnowledgeState): string {
  const grids = knowledge.players
    .map((player) =>
      player.grid
        .map((card) => (card.removed ? 'x' : card.value === null ? '?' : String(card.value)))
        .join(',')
    )
    .join('|');
  return [
    knowledge.phase,
    knowledge.selectedSource ?? '-',
    knowledge.currentPlayerIndex,
    knowledge.discardTopValue ?? '-',
    knowledge.drawnCardValue ?? '-',
    knowledge.drawPileCount,
    grids
  ].join(':');
}

function decisionRandom(knowledge: AiKnowledgeState, options: AiDecisionOptions): () => number {
  return createSeededRandom(
    hashSeed(
      `${soloAiStrategyVersion}:${options.difficulty}:${options.playerId}:${options.decisionKey}:${knowledgeFingerprint(knowledge)}`
    )
  );
}

function remainingValueDistribution(knownValues: readonly number[]): ValueProbability[] {
  const remainingCounts = new Map<number, number>(skyjoCardValueCounts.map(({ value, count }) => [value, count]));
  for (const value of knownValues) {
    const count = remainingCounts.get(value) ?? 0;
    if (count > 0) remainingCounts.set(value, count - 1);
  }
  const total = [...remainingCounts.values()].reduce((sum, count) => sum + count, 0);
  if (total <= 0) return [{ value: skyjoDefaultHiddenCardEstimate, probability: 1 }];
  return [...remainingCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([value, count]) => ({ value, probability: count / total }));
}

export function estimateAiHiddenCardValue(knowledge: AiKnowledgeState): number {
  return remainingValueDistribution(knowledge.knownValues).reduce(
    (sum, item) => sum + item.value * item.probability,
    0
  );
}

function currentKnowledgePlayer(knowledge: AiKnowledgeState): AiKnowledgePlayer | null {
  return knowledge.players[knowledge.currentPlayerIndex] ?? null;
}

export function legalAiMoves(knowledge: AiKnowledgeState): AiMove[] {
  const player = currentKnowledgePlayer(knowledge);
  if (!player) return [];
  if (knowledge.phase === 'opening-reveal') {
    const revealedCount = player.grid.filter((card) => card.faceUp && !card.removed).length;
    if (revealedCount >= 2) return [];
    return player.grid.flatMap((card, index) =>
      card.value === null && !card.removed ? [{ action: 'reveal' as const, index }] : []
    );
  }
  if (knowledge.phase === 'choose-source') {
    return [
      ...(knowledge.drawPileCount > 0 || knowledge.discardPileCount > 1
        ? [{ action: 'draw' as const }]
        : []),
      ...(knowledge.discardTopValue !== null ? [{ action: 'discard' as const }] : [])
    ];
  }
  if (knowledge.phase !== 'choose-replacement') return [];
  const replacements = player.grid.flatMap((card, index) =>
    !card.removed ? [{ action: 'replace' as const, index }] : []
  );
  if (knowledge.selectedSource === 'discard' && knowledge.discardTopValue !== null) return replacements;
  if (knowledge.selectedSource !== 'draw' || knowledge.drawnCardValue === null) return [];
  return [
    ...replacements,
    ...player.grid.flatMap((card, index) =>
      card.value === null && !card.removed ? [{ action: 'reveal' as const, index }] : []
    )
  ];
}

function sameMove(left: AiMove, right: AiMove): boolean {
  return left.action === right.action && left.index === right.index;
}

function legalChoice(preferred: AiMove | null, legal: readonly AiMove[]): AiMove | null {
  if (preferred && legal.some((move) => sameMove(move, preferred))) return preferred;
  return legal[0] ?? null;
}

function getAiRoundContext(knowledge: AiKnowledgeState, player: AiKnowledgePlayer): AiRoundContext {
  const hiddenCount = player.grid.filter((card) => card.value === null && !card.removed).length;
  const opponentHiddenCounts = knowledge.players
    .filter((item) => item.id !== player.id)
    .map((item) => item.grid.filter((card) => card.value === null && !card.removed).length);
  const fewestOpponentHiddenCount = opponentHiddenCounts.length > 0 ? Math.min(...opponentHiddenCounts) : hiddenCount;
  const isFinalTurn = Boolean(
    knowledge.roundCloserId && knowledge.finalTurnPlayerIds.includes(player.id)
  );

  const visibleTotal = player.grid.reduce(
    (total, card) => total + (!card.removed && card.value !== null ? card.value : 0),
    0
  );
  return {
    hiddenCount,
    isFinalTurn,
    isLateRound: isFinalTurn || hiddenCount <= endgameHiddenCardCount || fewestOpponentHiddenCount <= 1,
    roundHasCloser: knowledge.roundCloserId !== null,
    visibleTotal,
    opponentEstimatedTotals: knowledge.players
      .filter((item) => item.id !== player.id)
      .map((item) =>
        item.grid.reduce(
          (total, card) =>
            total +
            (card.removed ? 0 : card.value === null ? skyjoDefaultHiddenCardEstimate : card.value),
          0
        )
      )
  };
}

function visibleColumnPartners(player: AiKnowledgePlayer, cardIndex: number): AiKnowledgeCard[] {
  return skyjoColumnIndexes(cardIndex)
    .filter((index) => index !== cardIndex)
    .map((index) => player.grid[index])
    .filter(
      (card): card is AiKnowledgeCard =>
        Boolean(card && card.faceUp && !card.removed && card.value !== null)
    );
}

function estimateHiddenSlotValue(
  player: AiKnowledgePlayer,
  cardIndex: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): number {
  if (difficulty === 'easy' || difficulty === 'medium') return skyjoDefaultHiddenCardEstimate;
  const partners = visibleColumnPartners(player, cardIndex);
  const partnerAverage =
    partners.length > 0
      ? partners.reduce((total, card) => total + (card.value ?? 0), 0) / partners.length
      : hiddenEstimate;
  const columnPressure = (partnerAverage - hiddenEstimate) * 0.18;
  const adjustedColumnPressure = context.isFinalTurn ? Math.max(0, columnPressure) : columnPressure;
  const lateRoundRisk = context.isFinalTurn ? 0.55 : context.isLateRound ? 0.25 : 0;

  return clamp(hiddenEstimate + adjustedColumnPressure + lateRoundRisk, 3.75, 6.75);
}

function estimatedSlotValue(
  player: AiKnowledgePlayer,
  cardIndex: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): number {
  const card = player.grid[cardIndex];
  if (!card || card.removed) return Number.NEGATIVE_INFINITY;
  return card.value ?? estimateHiddenSlotValue(player, cardIndex, hiddenEstimate, context, difficulty);
}

function replacementClearsColumn(
  player: AiKnowledgePlayer,
  cardIndex: number,
  replacementValue: number
): boolean {
  return skyjoColumnIndexes(cardIndex).every((index) => {
    const card = player.grid[index];
    if (!card || card.removed) return false;
    if (index === cardIndex) return true;
    return card.faceUp && card.value === replacementValue;
  });
}

function estimatedColumnValue(
  player: AiKnowledgePlayer,
  cardIndex: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): number {
  return skyjoColumnIndexes(cardIndex).reduce(
    (total, index) => total + estimatedSlotValue(player, index, hiddenEstimate, context, difficulty),
    0
  );
}

function scoreReplacementTarget(
  player: AiKnowledgePlayer,
  cardIndex: number,
  replacementValue: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): AiReplacementTarget | null {
  const card = player.grid[cardIndex];
  if (!card || card.removed) return null;

  const estimatedCurrentValue = estimatedSlotValue(player, cardIndex, hiddenEstimate, context, difficulty);
  const clearsColumn = replacementClearsColumn(player, cardIndex, replacementValue);
  const gain = clearsColumn
    ? estimatedColumnValue(player, cardIndex, hiddenEstimate, context, difficulty)
    : estimatedCurrentValue - replacementValue;
  const clearBonus = difficulty === 'medium' ? 0.2 : columnClearTieBonus;
  const closesRound = card.value === null && context.hiddenCount === 1 && !context.roundHasCloser;
  const visiblePartners = visibleColumnPartners(player, cardIndex);
  const projectedClosingScore = clearsColumn
    ? context.visibleTotal - visiblePartners.reduce((sum, partner) => sum + (partner.value ?? 0), 0)
    : context.visibleTotal + replacementValue;
  const closerRisk =
    difficulty === 'ultra' && closesRound
      ? projectedDoublingRisk(projectedClosingScore, context)
      : 0;

  return {
    index: cardIndex,
    estimatedCurrentValue,
    gain,
    score: gain + (clearsColumn ? clearBonus : 0) + (card.faceUp ? 0.05 : 0) - closerRisk,
    faceUp: card.faceUp
  };
}

function replacementTargets(
  player: AiKnowledgePlayer,
  replacementValue: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): AiReplacementTarget[] {
  return player.grid
    .map((_, index) =>
      scoreReplacementTarget(player, index, replacementValue, hiddenEstimate, context, difficulty)
    )
    .filter((target): target is AiReplacementTarget => Boolean(target))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.estimatedCurrentValue !== a.estimatedCurrentValue) {
        return b.estimatedCurrentValue - a.estimatedCurrentValue;
      }
      if (a.faceUp !== b.faceUp) return a.faceUp ? -1 : 1;
      return a.index - b.index;
    });
}

function weightedTarget(
  targets: readonly AiReplacementTarget[],
  temperature: number,
  random: () => number
): AiReplacementTarget | null {
  if (targets.length === 0) return null;
  if (temperature <= 0) return targets[0];
  const bestScore = targets[0].score;
  const weighted = targets.map((target) => ({
    target,
    weight: Math.exp((target.score - bestScore) / temperature)
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.target;
  }
  return weighted[weighted.length - 1].target;
}

function chooseReplacementTarget(
  player: AiKnowledgePlayer,
  replacementValue: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty,
  random: () => number
): AiReplacementTarget | null {
  const targets = replacementTargets(player, replacementValue, hiddenEstimate, context, difficulty);
  if (difficulty === 'easy') return weightedTarget(targets, 3.4, random);
  if (difficulty === 'medium') return weightedTarget(targets, 1.25, random);
  return targets[0] ?? null;
}

function firstAvailableReplacementIndex(player: AiKnowledgePlayer): number {
  const index = player.grid.findIndex((card) => !card.removed);
  return index >= 0 ? index : 0;
}

function revealCandidates(
  player: AiKnowledgePlayer,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): Array<{ index: number; score: number }> {
  return player.grid
    .map((card, index) => {
      if (card.value !== null || card.removed) return null;
      const partners = visibleColumnPartners(player, index);
      const positivePartnerTotal = partners.reduce(
        (total, partner) => total + Math.max(0, partner.value ?? 0),
        0
      );
      const matchingPairBonus =
        partners.length === 2 && partners[0].value === partners[1].value
          ? Math.max(0, partners[0].value ?? 0) * 0.2
          : 0;
      return {
        index,
        score:
          estimateHiddenSlotValue(player, index, hiddenEstimate, context, difficulty) +
          positivePartnerTotal * (difficulty === 'ultra' ? 0.12 : 0.08) +
          matchingPairBonus +
          (context.isLateRound ? 0.3 : 0)
      };
    })
    .filter((candidate): candidate is { index: number; score: number } => Boolean(candidate))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
}

function chooseRevealIndex(
  player: AiKnowledgePlayer,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty,
  random: () => number
): number | null {
  const candidates = revealCandidates(player, hiddenEstimate, context, difficulty);
  if (candidates.length === 0) return null;
  if (difficulty === 'easy') return candidates[Math.floor(random() * candidates.length)]?.index ?? candidates[0].index;
  if (difficulty === 'medium') return candidates[Math.min(Math.floor(random() * 3), candidates.length - 1)].index;
  return candidates[0].index;
}

function drawSourceScore(
  player: AiKnowledgePlayer,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): number {
  const expectedDrawTarget = replacementTargets(
    player,
    hiddenEstimate,
    hiddenEstimate,
    context,
    difficulty
  )[0];
  const revealFallback = context.hiddenCount > 0 ? (context.isLateRound ? 1.1 : 0.65) : Number.NEGATIVE_INFINITY;
  return Math.max(expectedDrawTarget?.gain ?? Number.NEGATIVE_INFINITY, revealFallback);
}

function ultraDrawSourceScore(
  player: AiKnowledgePlayer,
  knowledge: AiKnowledgeState,
  hiddenEstimate: number,
  context: AiRoundContext
): number {
  return remainingValueDistribution(knowledge.knownValues).reduce((expected, item) => {
    const target = replacementTargets(player, item.value, hiddenEstimate, context, 'ultra')[0];
    const revealValue = context.hiddenCount > 0 ? (context.isLateRound ? 0.95 : 0.5) : Number.NEGATIVE_INFINITY;
    const value = Math.max(target?.gain ?? Number.NEGATIVE_INFINITY, revealValue);
    return expected + item.probability * value;
  }, 0);
}

function discardSourceMargin(discardValue: number, hiddenEstimate: number, context: AiRoundContext): number {
  const base = context.isFinalTurn ? 0.1 : context.isLateRound ? 0.45 : 0.85;
  if (discardValue <= 1) return Math.max(0.05, base - 0.35);
  if (discardValue >= hiddenEstimate + 3) return base + 0.75;
  return base;
}

function drawnCardPlacementThreshold(
  drawnValue: number,
  hiddenEstimate: number,
  context: AiRoundContext,
  difficulty: AiDifficulty
): number {
  const visiblePressure = context.visibleTotal >= 24 ? -0.35 : 0;
  const base = context.isFinalTurn ? 0.2 : context.isLateRound ? 0.55 : drawnValue <= hiddenEstimate ? 1 : 1.45;
  const difficultyAdjustment = difficulty === 'easy' ? -0.65 : difficulty === 'medium' ? -0.2 : 0;
  const minimum = difficulty === 'easy' ? 0.05 : 0.2;
  return Math.max(minimum, base + visiblePressure + difficultyAdjustment);
}

function chooseSource(
  knowledge: AiKnowledgeState,
  player: AiKnowledgePlayer,
  context: AiRoundContext,
  hiddenEstimate: number,
  difficulty: AiDifficulty,
  random: () => number
): AiMove {
  const discardValue = knowledge.discardTopValue;
  if (discardValue === null) return { action: 'draw' };
  const discardTarget = replacementTargets(player, discardValue, hiddenEstimate, context, difficulty)[0];
  if (!discardTarget || discardTarget.gain <= 0) return { action: 'draw' };

  const discardValueBias = clamp((hiddenEstimate - discardValue) * 0.15, -0.8, 0.8);
  const discardScore = discardTarget.score + discardValueBias;
  const drawScore = drawSourceScore(
    player,
    hiddenEstimate,
    context,
    difficulty === 'ultra' ? 'hard' : difficulty
  );
  const hardMargin = discardSourceMargin(discardValue, hiddenEstimate, context);

  if (difficulty === 'hard') {
    return discardScore >= drawScore + hardMargin ? { action: 'discard' } : { action: 'draw' };
  }
  if (difficulty === 'ultra') {
    if (discardScore >= drawScore + hardMargin) return { action: 'discard' };
    const exactDrawScore = ultraDrawSourceScore(player, knowledge, hiddenEstimate, context);
    return discardScore >= exactDrawScore + 0.2 ? { action: 'discard' } : { action: 'draw' };
  }

  const temperature = difficulty === 'easy' ? 3.25 : 1.45;
  const margin = difficulty === 'easy' ? hardMargin * 0.2 : hardMargin * 0.55;
  const discardProbability = 1 / (1 + Math.exp(-(discardScore - drawScore - margin) / temperature));
  return random() < discardProbability ? { action: 'discard' } : { action: 'draw' };
}

export function chooseAiMove(knowledge: AiKnowledgeState, options: AiDecisionOptions): AiMove | null {
  const currentPlayer = knowledge.players[knowledge.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== options.playerId) return null;
  const legal = legalAiMoves(knowledge);
  if (legal.length === 0) return null;
  const player = currentKnowledgePlayer(knowledge);
  if (!player) return null;
  const context = getAiRoundContext(knowledge, player);
  const hiddenEstimate =
    options.difficulty === 'easy' || options.difficulty === 'medium'
      ? skyjoDefaultHiddenCardEstimate
      : estimateAiHiddenCardValue(knowledge);
  const random = decisionRandom(knowledge, options);

  if (knowledge.phase === 'opening-reveal') {
    const index = chooseRevealIndex(player, hiddenEstimate, context, options.difficulty, random);
    return legalChoice(index === null ? null : { action: 'reveal', index }, legal);
  }
  if (knowledge.phase === 'choose-source') {
    return legalChoice(
      chooseSource(knowledge, player, context, hiddenEstimate, options.difficulty, random),
      legal
    );
  }
  if (knowledge.phase !== 'choose-replacement') return null;

  if (knowledge.selectedSource === 'discard') {
    const target =
      knowledge.discardTopValue === null
        ? null
        : chooseReplacementTarget(
            player,
            knowledge.discardTopValue,
            hiddenEstimate,
            context,
            options.difficulty,
            random
          );
    return legalChoice(
      { action: 'replace', index: target?.index ?? firstAvailableReplacementIndex(player) },
      legal
    );
  }

  if (knowledge.selectedSource === 'draw' && knowledge.drawnCardValue !== null) {
    const target = chooseReplacementTarget(
      player,
      knowledge.drawnCardValue,
      hiddenEstimate,
      context,
      options.difficulty,
      random
    );
    const placementThreshold = drawnCardPlacementThreshold(
      knowledge.drawnCardValue,
      hiddenEstimate,
      context,
      options.difficulty
    );
    if (target && target.gain >= placementThreshold) {
      return legalChoice({ action: 'replace', index: target.index }, legal);
    }

    const riskyClosingReveal =
      options.difficulty === 'ultra' &&
      context.hiddenCount === 1 &&
      projectedDoublingRisk(context.visibleTotal + hiddenEstimate, context) > 0;
    if (riskyClosingReveal) {
      const safeFaceUpTarget = replacementTargets(
        player,
        knowledge.drawnCardValue,
        hiddenEstimate,
        context,
        'ultra'
      ).find((candidate) => candidate.faceUp);
      if (safeFaceUpTarget) {
        return legalChoice({ action: 'replace', index: safeFaceUpTarget.index }, legal);
      }
    }

    const revealIndex = chooseRevealIndex(player, hiddenEstimate, context, options.difficulty, random);
    if (revealIndex !== null) return legalChoice({ action: 'reveal', index: revealIndex }, legal);
    return legalChoice(
      { action: 'replace', index: target?.index ?? firstAvailableReplacementIndex(player) },
      legal
    );
  }

  return legalChoice({ action: 'replace', index: firstAvailableReplacementIndex(player) }, legal);
}

function projectedDoublingRisk(projectedScore: number, context: AiRoundContext): number {
  if (context.roundHasCloser || projectedScore <= 0) return 0;
  const strictlyLowest = context.opponentEstimatedTotals.every(
    (opponentScore) => projectedScore < opponentScore
  );
  if (strictlyLowest) return 0;
  return (
    projectedScore * 0.85 +
    Math.max(0, projectedScore - Math.min(...context.opponentEstimatedTotals)) * 0.15
  );
}
