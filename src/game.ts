import type { Card, GameState, MoveResult, Player } from './types';

const rows = 3;
const columns = 4;
const winningScore = 100;
const endgameHiddenCardCount = 2;
const columnClearTieBonus = 0.35;

const cardValueCounts = [
  { value: -2, count: 5 },
  { value: -1, count: 10 },
  { value: 0, count: 15 },
  ...Array.from({ length: 12 }, (_, index) => ({ value: index + 1, count: 10 }))
] as const;

const deckCardCount = cardValueCounts.reduce((total, { count }) => total + count, 0);
const deckValueTotal = cardValueCounts.reduce((total, { value, count }) => total + value * count, 0);
const defaultHiddenCardEstimate = deckValueTotal / deckCardCount;

type PlayerSeed = Pick<Player, 'id' | 'name' | 'kind'> & Partial<Pick<Player, 'totalScore'>>;
type AiMove = { action: 'discard' | 'draw' | 'replace' | 'reveal'; index?: number };

interface AiRoundContext {
  hiddenCount: number;
  isFinalTurn: boolean;
  isLateRound: boolean;
  visibleTotal: number;
}

interface AiReplacementTarget {
  index: number;
  estimatedCurrentValue: number;
  gain: number;
  score: number;
  faceUp: boolean;
}

const singlePlayerAiOpponentSlots = 7;

export const singlePlayerAiNames = [
  'Picard',
  'Riker',
  'Data',
  'Worf',
  'Geordi',
  'Beverly',
  'Troi',
  'Sisko',
  'Kira',
  'Dax',
  'Odo',
  'Quark',
  'Janeway',
  'Seven',
  'Tuvok',
  'Kirk',
  'Spock',
  'Uhura',
  'Sulu',
  'Scotty',
  'Bones',
  'Pike',
  'Saru',
  'Burnham',
  'Mariner',
  'Boimler',
  'Adama',
  'Roslin',
  'Starbuck',
  'Apollo',
  'Boomer',
  'Athena',
  'Helo',
  'Tyrol',
  'Tigh',
  'Baltar',
  'Six',
  'Anders',
  'Gaeta',
  'Dualla',
  'TChalla',
  'Shuri',
  'Okoye',
  'Wanda',
  'Vision',
  'Natasha',
  'Clint',
  'Thor',
  'Loki',
  'Valkyrie',
  'Carol',
  'Monica',
  'Kamala',
  'Strange',
  'Wong',
  'Peter',
  'Miles',
  'Gwen',
  'Logan',
  'Ororo',
  'Rogue',
  'Gambit',
  'Jean',
  'Scott',
  'Hank',
  'Doom',
  'Reed',
  'Sue',
  'Ben',
  'Johnny',
  'Ripley',
  'Hicks',
  'Vasquez',
  'Sarah',
  'Neo',
  'Trinity',
  'Morpheus',
  'Luke',
  'Leia',
  'Han',
  'Chewie',
  'Lando',
  'Rey',
  'Finn',
  'Poe',
  'Ahsoka',
  'Grogu'
] as const;

export const singlePlayerAiOpponents = singlePlayerAiNames.slice(0, singlePlayerAiOpponentSlots).map((name, index) => ({
  id: 'ai-' + (index + 1),
  name,
  kind: 'ai' as const
})) satisfies readonly PlayerSeed[];

export const singlePlayerAiOpponentRange = {
  min: 1,
  max: singlePlayerAiOpponentSlots
} as const;

export interface SinglePlayerGameOptions {
  aiOpponentCount?: number;
}

function normalizeSinglePlayerAiOpponentCount(aiOpponentCount: number = singlePlayerAiOpponentRange.min): number {
  if (!Number.isFinite(aiOpponentCount)) return singlePlayerAiOpponentRange.min;
  return Math.min(singlePlayerAiOpponentRange.max, Math.max(singlePlayerAiOpponentRange.min, Math.trunc(aiOpponentCount)));
}

function createSinglePlayerRoster(
  aiOpponentCount: number = singlePlayerAiOpponentRange.min,
  previousScores = new Map<string, number>()
): PlayerSeed[] {
  const count = normalizeSinglePlayerAiOpponentCount(aiOpponentCount);
  const selectedAiNames = shuffle([...singlePlayerAiNames]).slice(0, count);
  return [
    { id: 'human', name: 'You', kind: 'human', totalScore: previousScores.get('human') ?? 0 },
    ...selectedAiNames.map((name, index) => {
      const id = 'ai-' + (index + 1);
      return {
        id,
        name,
        kind: 'ai' as const,
        totalScore: previousScores.get(id) ?? 0
      };
    })
  ];
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeDeck(): Card[] {
  const values = cardValueCounts.flatMap(({ value, count }) => Array<number>(count).fill(value));

  return shuffle(
    values.map((value, index) => ({
      id: `card-${index}-${value}`,
      value,
      faceUp: false,
      removed: false
    }))
  );
}

function drawCard(drawPile: Card[], discardPile: Card[]): MoveResult {
  if (drawPile.length > 0) {
    const [card, ...remaining] = drawPile;
    return { card: { ...card, faceUp: true }, drawPile: remaining, discardPile };
  }

  const [topDiscard, ...rest] = discardPile;
  const recycled = shuffle(rest.map((card) => ({ ...card, faceUp: false, removed: false })));
  const [card, ...remaining] = recycled;
  return {
    card: { ...card, faceUp: true },
    drawPile: remaining,
    discardPile: topDiscard ? [topDiscard] : []
  };
}

function scoreGrid(grid: Card[]): number {
  return grid.reduce((total, card) => {
    if (card.removed) return total;
    return total + card.value;
  }, 0);
}

function visibleScore(grid: Card[]): number {
  return grid.reduce((total, card) => {
    if (card.removed || !card.faceUp) return total;
    return total + card.value;
  }, 0);
}

function allCardsKnown(grid: Card[]): boolean {
  return grid.every((card) => card.faceUp || card.removed);
}

function clearMatchingColumns(grid: Card[]): Card[] {
  return clearMatchingColumnsWithDiscards(grid).grid;
}

function clearMatchingColumnsWithDiscards(grid: Card[]): { grid: Card[]; clearedCards: Card[] } {
  const next = grid.map((card) => ({ ...card }));
  const clearedCards: Card[] = [];

  for (let column = 0; column < columns; column += 1) {
    const indexes = [column, column + columns, column + columns * 2];
    const cards = indexes.map((index) => next[index]);
    if (cards.every((card) => card.faceUp && !card.removed && card.value === cards[0].value)) {
      clearedCards.push(...cards.map((card) => ({ ...card, faceUp: true, removed: false })));
      for (const index of indexes) {
        next[index] = { ...next[index], removed: true };
      }
    }
  }

  return { grid: next, clearedCards };
}

function revealRandomOpeningCards(grid: Card[]): Card[] {
  const indexes = shuffle(Array.from({ length: rows * columns }, (_, index) => index)).slice(0, 2);
  return grid.map((card, index) => (indexes.includes(index) ? { ...card, faceUp: true } : card));
}

function makePlayer(
  id: string,
  name: string,
  kind: Player['kind'],
  deck: Card[],
  totalScore = 0,
  autoRevealOpeningCards = false
): { player: Player; deck: Card[] } {
  const grid = autoRevealOpeningCards ? revealRandomOpeningCards(deck.slice(0, rows * columns)) : deck.slice(0, rows * columns);
  return {
    player: {
      id,
      name,
      kind,
      grid,
      totalScore,
      roundScore: visibleScore(grid)
    },
    deck: deck.slice(rows * columns)
  };
}

function updatePlayer(state: GameState, player: Player): GameState {
  return {
    ...state,
    players: state.players.map((item) => (item.id === player.id ? player : item))
  };
}

function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

function openingStarterIndex(players: Player[], startPlayerId?: string | null): number {
  if (startPlayerId) {
    const preferredIndex = players.findIndex((player) => player.id === startPlayerId);
    if (preferredIndex >= 0) return preferredIndex;
  }

  return players.reduce((bestIndex, player, index) => {
    const bestScore = visibleScore(players[bestIndex].grid);
    const score = visibleScore(player.grid);
    return score > bestScore ? index : bestIndex;
  }, 0);
}

function openingRevealCount(player: Player): number {
  return player.grid.filter((card) => card.faceUp && !card.removed).length;
}

function openingRevealCounts(players: Player[]): Record<string, number> {
  return Object.fromEntries(players.map((player) => [player.id, openingRevealCount(player)]));
}

function firstPlayerNeedingOpeningReveal(players: Player[]): number {
  return players.findIndex((player) => openingRevealCount(player) < 2);
}

function withLog(state: GameState, message: string): GameState {
  return { ...state, log: [message, ...state.log].slice(0, 8) };
}

function possessiveName(name: string): string {
  if (name.toLowerCase() === 'you') return 'Your';
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function finalTurnOrder(players: Player[], closerId: string): string[] {
  const closerIndex = players.findIndex((player) => player.id === closerId);
  if (closerIndex < 0) return players.map((player) => player.id);

  return Array.from({ length: players.length - 1 }, (_, offset) => {
    const index = (closerIndex + offset + 1) % players.length;
    return players[index].id;
  });
}

function finishFinalTurn(state: GameState, player: Player): GameState {
  const remaining = state.finalTurnPlayerIds.filter((playerId) => playerId !== player.id);
  if (remaining.length === 0) {
    const closer = state.players.find((item) => item.id === state.roundCloserId) || player;
    return finishRound({ ...state, finalTurnPlayerIds: [] }, closer);
  }

  const nextPlayerId = remaining[0];
  const nextPlayerIndex = state.players.findIndex((item) => item.id === nextPlayerId);
  return withLog(
    {
      ...state,
      currentPlayerIndex: nextPlayerIndex >= 0 ? nextPlayerIndex : state.currentPlayerIndex,
      selectedSource: null,
      drawnCard: null,
      phase: 'choose-source',
      finalTurnPlayerIds: remaining
    },
    `${state.players[nextPlayerIndex]?.name || 'Next player'} gets a final turn.`
  );
}

function finishTurn(state: GameState, player: Player): GameState {
  const { grid: clearedGrid, clearedCards } = clearMatchingColumnsWithDiscards(player.grid);
  const updatedPlayer = {
    ...player,
    grid: clearedGrid,
    roundScore: visibleScore(clearedGrid)
  };
  const updatedState = updatePlayer(
    clearedCards.length > 0
      ? {
          ...state,
          discardPile: [...clearedCards, ...state.discardPile]
        }
      : state,
    updatedPlayer
  );

  if (state.roundCloserId) {
    return finishFinalTurn(updatedState, updatedPlayer);
  }

  if (allCardsKnown(clearedGrid)) {
    const finalTurns = finalTurnOrder(updatedState.players, updatedPlayer.id);
    if (finalTurns.length === 0) return finishRound(updatedState, updatedPlayer);

    const nextPlayerId = finalTurns[0];
    const nextPlayerIndex = updatedState.players.findIndex((item) => item.id === nextPlayerId);
    return withLog(
      {
        ...updatedState,
        currentPlayerIndex: nextPlayerIndex >= 0 ? nextPlayerIndex : updatedState.currentPlayerIndex,
        selectedSource: null,
        drawnCard: null,
        phase: 'choose-source',
        roundCloserId: updatedPlayer.id,
        finalTurnPlayerIds: finalTurns
      },
      `${updatedPlayer.name} revealed their last card. Everyone else gets one final turn.`
    );
  }

  return {
    ...updatedState,
    currentPlayerIndex: (state.currentPlayerIndex + 1) % state.players.length,
    selectedSource: null,
    drawnCard: null,
    phase: 'choose-source'
  };
}

function finishRound(state: GameState, closer: Player): GameState {
  const scoredPlayers = state.players.map((player) => {
    const revealedGrid = clearMatchingColumns(
      player.grid.map((card) => (card.removed ? card : { ...card, faceUp: true }))
    );
    const roundScore = scoreGrid(revealedGrid);
    return {
      ...player,
      grid: revealedGrid,
      roundScore,
      totalScore: player.totalScore + roundScore
    };
  });
  const closerScore = scoredPlayers.find((player) => player.id === closer.id)?.roundScore ?? 0;
  const closerIsStrictLowest = scoredPlayers.every(
    (player) => player.id === closer.id || closerScore < player.roundScore
  );
  const closerScoreDoubled = !closerIsStrictLowest && closerScore > 0;
  const players = scoredPlayers.map((player) => {
    if (player.id !== closer.id || !closerScoreDoubled) return player;
    const adjustedRoundScore = player.roundScore * 2;
    return {
      ...player,
      roundScore: adjustedRoundScore,
      totalScore: player.totalScore - player.roundScore + adjustedRoundScore
    };
  });
  const leader = [...players].sort((a, b) => a.totalScore - b.totalScore)[0];
  const gameOver = players.some((player) => player.totalScore >= winningScore);
  const doubledNote = closerScoreDoubled ? ` ${possessiveName(closer.name)} round score doubled to ${closerScore * 2}.` : '';

  return withLog(
    {
      ...state,
      players,
      phase: gameOver ? 'game-over' : 'round-over',
      selectedSource: null,
      drawnCard: null,
      winnerId: gameOver ? leader.id : null,
      nextStarterId: closer.id,
      roundCloserId: null,
      finalTurnPlayerIds: []
    },
    `${closer.name} ended the round.${doubledNote} ${leader.name} leads with ${leader.totalScore}.`
  );
}

export function createGameForPlayers(
  players: PlayerSeed[],
  round = 1,
  startPlayerId?: string | null,
  autoRevealOpeningCards = true
): GameState {
  let deck = makeDeck();
  const dealtPlayers: Player[] = [];

  for (const player of players) {
    const dealt = makePlayer(player.id, player.name, player.kind, deck, player.totalScore ?? 0, autoRevealOpeningCards);
    dealtPlayers.push(dealt.player);
    deck = dealt.deck;
  }

  const openingIndex = firstPlayerNeedingOpeningReveal(dealtPlayers);
  const hasOpeningReveals = openingIndex < 0;
  const currentPlayerIndex = hasOpeningReveals ? openingStarterIndex(dealtPlayers, round > 1 ? startPlayerId : null) : openingIndex;
  const starter = dealtPlayers[currentPlayerIndex];
  const discard = { ...deck[0], faceUp: true };
  const drawPile = deck.slice(1);
  const phase = hasOpeningReveals ? 'choose-source' : 'opening-reveal';

  return {
    players: dealtPlayers,
    drawPile,
    discardPile: [discard],
    currentPlayerIndex,
    phase,
    selectedSource: null,
    drawnCard: null,
    round,
    log: [
      hasOpeningReveals
        ? `${starter.name} starts round ${round}. Pick from the discard pile or draw blind.`
        : `${starter.name} chooses two opening cards to reveal.`
    ],
    winnerId: null,
    nextStarterId: hasOpeningReveals ? null : round > 1 ? startPlayerId || null : null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: openingRevealCounts(dealtPlayers)
  };
}

export function createGame(
  existingPlayers?: Player[],
  round = 1,
  startPlayerId?: string | null,
  options: SinglePlayerGameOptions = {}
): GameState {
  const previousScores = new Map((existingPlayers || []).map((player) => [player.id, player.totalScore]));
  const players =
    existingPlayers && existingPlayers.length > 0 && options.aiOpponentCount === undefined
      ? existingPlayers.map((player) => ({
          id: player.id,
          name: player.name,
          kind: player.kind,
          totalScore: player.totalScore
        }))
      : createSinglePlayerRoster(options.aiOpponentCount ?? existingPlayers?.filter((player) => player.kind === 'ai').length, previousScores);

  return createGameForPlayers(
    players,
    round,
    startPlayerId,
    false
  );
}

export function createMultiplayerGame(
  players: Array<Pick<Player, 'id' | 'name'> & Partial<Pick<Player, 'totalScore'>>>,
  round = 1,
  startPlayerId?: string | null
): GameState {
  return createGameForPlayers(
    players.map((player) => ({
      id: player.id,
      name: player.name,
      kind: 'human',
      totalScore: player.totalScore ?? 0
    })),
    round,
    startPlayerId,
    false
  );
}

export function startFreshGame(options: SinglePlayerGameOptions = {}): GameState {
  return createGame(undefined, 1, null, options);
}

export function startNextRound(state: GameState): GameState {
  return createGame(state.players, state.round + 1, state.nextStarterId);
}

export function revealOpeningCard(state: GameState, cardIndex: number): GameState {
  if (state.phase !== 'opening-reveal') return state;
  const player = currentPlayer(state);
  const card = player.grid[cardIndex];
  const currentCount = state.openingRevealCounts[player.id] ?? openingRevealCount(player);
  if (!card || card.faceUp || card.removed || currentCount >= 2) return state;

  const grid = player.grid.map((item, index) => (index === cardIndex ? { ...item, faceUp: true } : item));
  const nextPlayer = { ...player, grid, roundScore: visibleScore(grid) };
  const updatedState = updatePlayer(
    {
      ...state,
      openingRevealCounts: {
        ...state.openingRevealCounts,
        [player.id]: currentCount + 1
      }
    },
    nextPlayer
  );
  const nextCount = currentCount + 1;

  if (nextCount < 2) {
    return withLog(updatedState, `${player.name} revealed an opening card.`);
  }

  const nextPlayerIndex = updatedState.players.findIndex((item) => (updatedState.openingRevealCounts[item.id] ?? 0) < 2);
  if (nextPlayerIndex >= 0) {
    return withLog(
      {
        ...updatedState,
        currentPlayerIndex: nextPlayerIndex
      },
      `${player.name} finished opening reveals. ${updatedState.players[nextPlayerIndex].name} chooses two opening cards.`
    );
  }

  const starterIndex = openingStarterIndex(updatedState.players, updatedState.nextStarterId);
  const starter = updatedState.players[starterIndex];
  return withLog(
    {
      ...updatedState,
      currentPlayerIndex: starterIndex,
      phase: 'choose-source',
      selectedSource: null,
      drawnCard: null,
      nextStarterId: null
    },
    `${starter.name} starts round ${state.round}. Pick from the discard pile or draw blind.`
  );
}

export function chooseDiscard(state: GameState): GameState {
  if (state.phase !== 'choose-source') return state;
  return withLog({ ...state, selectedSource: 'discard', phase: 'choose-replacement' }, `${currentPlayer(state).name} picked the discard pile.`);
}

export function drawBlind(state: GameState): GameState {
  if (state.phase !== 'choose-source') return state;
  const result = drawCard(state.drawPile, state.discardPile);
  return withLog(
    {
      ...state,
      drawPile: result.drawPile,
      discardPile: result.discardPile,
      drawnCard: result.card,
      selectedSource: 'draw',
      phase: 'choose-replacement'
    },
    `${currentPlayer(state).name} drew a ${result.card.value}.`
  );
}

export function replaceCard(state: GameState, cardIndex: number): GameState {
  if (state.phase !== 'choose-replacement' || !state.selectedSource) return state;
  const player = currentPlayer(state);
  const oldCard = player.grid[cardIndex];
  if (!oldCard || oldCard.removed) return state;

  let replacement: Card | undefined;
  let discardPile = state.discardPile;
  const drawPile = state.drawPile;

  if (state.selectedSource === 'discard') {
    const [discardCard, ...remainingDiscard] = state.discardPile;
    replacement = discardCard;
    discardPile = remainingDiscard;
  } else {
    replacement = state.drawnCard || undefined;
  }

  if (!replacement) return state;

  const grid = player.grid.map((card, index) =>
    index === cardIndex ? { ...replacement, faceUp: true, removed: false } : card
  );
  const nextPlayer = { ...player, grid };
  const nextDiscard = [{ ...oldCard, faceUp: true, removed: false }, ...discardPile];
  const nextState = withLog(
    {
      ...state,
      drawPile,
      discardPile: nextDiscard
    },
    `${player.name} replaced a card with ${replacement.value}.`
  );

  return finishTurn(nextState, nextPlayer);
}

export function discardDrawnAndReveal(state: GameState, cardIndex: number): GameState {
  if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) return state;
  const player = currentPlayer(state);
  const card = player.grid[cardIndex];
  if (!card || card.faceUp || card.removed) return state;

  const grid = player.grid.map((item, index) => (index === cardIndex ? { ...item, faceUp: true } : item));
  const nextPlayer = { ...player, grid };
  const nextState = withLog(
    {
      ...state,
      discardPile: [state.drawnCard, ...state.discardPile]
    },
    `${player.name} discarded ${state.drawnCard.value} and revealed a card.`
  );

  return finishTurn(nextState, nextPlayer);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function columnIndexesFor(cardIndex: number): number[] {
  const column = cardIndex % columns;
  return [column, column + columns, column + columns * 2];
}

function getAiRoundContext(state: GameState, player: Player): AiRoundContext {
  const hiddenCount = player.grid.filter((card) => !card.faceUp && !card.removed).length;
  const opponentHiddenCounts = state.players
    .filter((item) => item.id !== player.id)
    .map((item) => item.grid.filter((card) => !card.faceUp && !card.removed).length);
  const fewestOpponentHiddenCount = opponentHiddenCounts.length > 0 ? Math.min(...opponentHiddenCounts) : hiddenCount;
  const isFinalTurn = Boolean(state.roundCloserId && state.finalTurnPlayerIds.includes(player.id));

  return {
    hiddenCount,
    isFinalTurn,
    isLateRound: isFinalTurn || hiddenCount <= endgameHiddenCardCount || fewestOpponentHiddenCount <= 1,
    visibleTotal: visibleScore(player.grid)
  };
}

function estimatedRemainingHiddenCardValue(state: GameState): number {
  const remainingCounts = new Map(cardValueCounts.map(({ value, count }) => [value, count]));
  const knownValues = [
    ...state.players.flatMap((player) =>
      player.grid.filter((card) => card.faceUp || card.removed).map((card) => card.value)
    ),
    ...state.discardPile.map((card) => card.value),
    ...(state.drawnCard ? [state.drawnCard.value] : [])
  ];

  for (const value of knownValues) {
    const count = remainingCounts.get(value);
    if (count && count > 0) remainingCounts.set(value, count - 1);
  }

  const remaining = [...remainingCounts].reduce(
    (total, [value, count]) => ({
      count: total.count + count,
      value: total.value + value * count
    }),
    { count: 0, value: 0 }
  );

  return remaining.count > 0 ? remaining.value / remaining.count : defaultHiddenCardEstimate;
}

function visibleColumnPartners(player: Player, cardIndex: number): Card[] {
  return columnIndexesFor(cardIndex)
    .filter((index) => index !== cardIndex)
    .map((index) => player.grid[index])
    .filter((card): card is Card => Boolean(card && card.faceUp && !card.removed));
}

function estimateHiddenSlotValue(
  player: Player,
  cardIndex: number,
  hiddenEstimate: number,
  context: AiRoundContext
): number {
  const partners = visibleColumnPartners(player, cardIndex);
  const partnerAverage =
    partners.length > 0 ? partners.reduce((total, card) => total + card.value, 0) / partners.length : hiddenEstimate;
  const columnPressure = (partnerAverage - hiddenEstimate) * 0.18;
  const adjustedColumnPressure = context.isFinalTurn ? Math.max(0, columnPressure) : columnPressure;
  const lateRoundRisk = context.isFinalTurn ? 0.55 : context.isLateRound ? 0.25 : 0;

  return clamp(hiddenEstimate + adjustedColumnPressure + lateRoundRisk, 3.75, 6.75);
}

function estimatedSlotValue(player: Player, cardIndex: number, hiddenEstimate: number, context: AiRoundContext): number {
  const card = player.grid[cardIndex];
  if (!card || card.removed) return Number.NEGATIVE_INFINITY;
  return card.faceUp ? card.value : estimateHiddenSlotValue(player, cardIndex, hiddenEstimate, context);
}

function replacementClearsColumn(player: Player, cardIndex: number, replacementValue: number): boolean {
  return columnIndexesFor(cardIndex).every((index) => {
    const card = player.grid[index];
    if (!card || card.removed) return false;
    if (index === cardIndex) return true;
    return card.faceUp && card.value === replacementValue;
  });
}

function estimatedColumnValue(
  player: Player,
  cardIndex: number,
  hiddenEstimate: number,
  context: AiRoundContext
): number {
  return columnIndexesFor(cardIndex).reduce(
    (total, index) => total + estimatedSlotValue(player, index, hiddenEstimate, context),
    0
  );
}

function scoreReplacementTarget(
  player: Player,
  cardIndex: number,
  replacementValue: number,
  hiddenEstimate: number,
  context: AiRoundContext
): AiReplacementTarget | null {
  const card = player.grid[cardIndex];
  if (!card || card.removed) return null;

  const estimatedCurrentValue = estimatedSlotValue(player, cardIndex, hiddenEstimate, context);
  const clearsColumn = replacementClearsColumn(player, cardIndex, replacementValue);
  const gain = clearsColumn
    ? estimatedColumnValue(player, cardIndex, hiddenEstimate, context)
    : estimatedCurrentValue - replacementValue;

  return {
    index: cardIndex,
    estimatedCurrentValue,
    gain,
    score: gain + (clearsColumn ? columnClearTieBonus : 0) + (card.faceUp ? 0.05 : 0),
    faceUp: card.faceUp
  };
}

function findBestReplacementTarget(
  player: Player,
  replacementValue: number,
  hiddenEstimate: number,
  context: AiRoundContext
): AiReplacementTarget | null {
  const targets = player.grid
    .map((_, index) => scoreReplacementTarget(player, index, replacementValue, hiddenEstimate, context))
    .filter((target): target is AiReplacementTarget => Boolean(target))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.estimatedCurrentValue !== a.estimatedCurrentValue) return b.estimatedCurrentValue - a.estimatedCurrentValue;
      if (a.faceUp !== b.faceUp) return a.faceUp ? -1 : 1;
      return a.index - b.index;
    });

  return targets[0] ?? null;
}

function firstAvailableReplacementIndex(player: Player): number {
  const index = player.grid.findIndex((card) => !card.removed);
  return index >= 0 ? index : 0;
}

function findBestRevealIndex(player: Player, hiddenEstimate: number, context: AiRoundContext): number | null {
  const candidates = player.grid
    .map((card, index) => {
      if (card.faceUp || card.removed) return null;

      const partners = visibleColumnPartners(player, index);
      const positivePartnerTotal = partners.reduce((total, partner) => total + Math.max(0, partner.value), 0);
      const matchingPairBonus =
        partners.length === 2 && partners[0].value === partners[1].value ? Math.max(0, partners[0].value) * 0.2 : 0;
      const pressureBonus = context.isLateRound ? 0.3 : 0;

      return {
        index,
        score:
          estimateHiddenSlotValue(player, index, hiddenEstimate, context) +
          positivePartnerTotal * 0.08 +
          matchingPairBonus +
          pressureBonus
      };
    })
    .filter((candidate): candidate is { index: number; score: number } => Boolean(candidate))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  return candidates[0]?.index ?? null;
}

function drawSourceScore(player: Player, hiddenEstimate: number, context: AiRoundContext): number {
  const expectedDrawTarget = findBestReplacementTarget(player, hiddenEstimate, hiddenEstimate, context);
  const revealFallback = context.hiddenCount > 0 ? (context.isLateRound ? 1.1 : 0.65) : Number.NEGATIVE_INFINITY;
  return Math.max(expectedDrawTarget?.gain ?? Number.NEGATIVE_INFINITY, revealFallback);
}

function discardSourceMargin(discardValue: number, hiddenEstimate: number, context: AiRoundContext): number {
  const base = context.isFinalTurn ? 0.1 : context.isLateRound ? 0.45 : 0.85;
  if (discardValue <= 1) return Math.max(0.05, base - 0.35);
  if (discardValue >= hiddenEstimate + 3) return base + 0.75;
  return base;
}

function drawnCardPlacementThreshold(drawnValue: number, hiddenEstimate: number, context: AiRoundContext): number {
  const visiblePressure = context.visibleTotal >= 24 ? -0.35 : 0;
  const base = context.isFinalTurn ? 0.2 : context.isLateRound ? 0.55 : drawnValue <= hiddenEstimate ? 1 : 1.45;
  return Math.max(0.2, base + visiblePressure);
}

export function getBestAiMove(state: GameState): AiMove {
  const player = currentPlayer(state);
  const hiddenEstimate = estimatedRemainingHiddenCardValue(state);
  const context = getAiRoundContext(state, player);

  if (state.phase === 'choose-source') {
    const topDiscard = state.discardPile[0];
    if (!topDiscard) return { action: 'draw' };

    const discardTarget = findBestReplacementTarget(player, topDiscard.value, hiddenEstimate, context);
    const discardValueBias = clamp((hiddenEstimate - topDiscard.value) * 0.15, -0.8, 0.8);
    const discardScore = (discardTarget?.score ?? Number.NEGATIVE_INFINITY) + discardValueBias;
    const drawScore = drawSourceScore(player, hiddenEstimate, context);
    const margin = discardSourceMargin(topDiscard.value, hiddenEstimate, context);

    if (discardTarget && discardTarget.gain > 0 && discardScore >= drawScore + margin) return { action: 'discard' };
    return { action: 'draw' };
  }

  if (state.selectedSource === 'discard') {
    const topDiscard = state.discardPile[0];
    const target = topDiscard ? findBestReplacementTarget(player, topDiscard.value, hiddenEstimate, context) : null;
    return { action: 'replace', index: target?.index ?? firstAvailableReplacementIndex(player) };
  }

  if (state.drawnCard) {
    const target = findBestReplacementTarget(player, state.drawnCard.value, hiddenEstimate, context);
    const placementThreshold = drawnCardPlacementThreshold(state.drawnCard.value, hiddenEstimate, context);
    if (target && target.gain >= placementThreshold) return { action: 'replace', index: target.index };

    const revealIndex = findBestRevealIndex(player, hiddenEstimate, context);
    if (revealIndex !== null) return { action: 'reveal', index: revealIndex };

    return { action: 'replace', index: target?.index ?? firstAvailableReplacementIndex(player) };
  }

  return { action: 'replace', index: firstAvailableReplacementIndex(player) };
}
