import type { Card, GameState, MoveResult, Player } from './types';

const rows = 3;
const columns = 4;
const winningScore = 100;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeDeck(): Card[] {
  const values = [
    ...Array(5).fill(-2),
    ...Array(10).fill(-1),
    ...Array(15).fill(0),
    ...Array.from({ length: 12 }, (_, index) => Array(10).fill(index + 1)).flat()
  ];

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
  const next = grid.map((card) => ({ ...card }));
  for (let column = 0; column < columns; column += 1) {
    const indexes = [column, column + columns, column + columns * 2];
    const cards = indexes.map((index) => next[index]);
    if (cards.every((card) => card.faceUp && !card.removed && card.value === cards[0].value)) {
      for (const index of indexes) {
        next[index] = { ...next[index], removed: true };
      }
    }
  }
  return next;
}

function revealOpeningCards(grid: Card[]): Card[] {
  const indexes = shuffle(Array.from({ length: rows * columns }, (_, index) => index)).slice(0, 2);
  return grid.map((card, index) => (indexes.includes(index) ? { ...card, faceUp: true } : card));
}

function makePlayer(id: string, name: string, kind: Player['kind'], deck: Card[], totalScore = 0): { player: Player; deck: Card[] } {
  const grid = revealOpeningCards(deck.slice(0, rows * columns));
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

function withLog(state: GameState, message: string): GameState {
  return { ...state, log: [message, ...state.log].slice(0, 8) };
}

function finishTurn(state: GameState, player: Player): GameState {
  const clearedGrid = clearMatchingColumns(player.grid);
  const updatedPlayer = {
    ...player,
    grid: clearedGrid,
    roundScore: visibleScore(clearedGrid)
  };
  const updatedState = updatePlayer(state, updatedPlayer);

  if (allCardsKnown(clearedGrid)) {
    return finishRound(updatedState, updatedPlayer);
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
  const players = state.players.map((player) => {
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
  const leader = [...players].sort((a, b) => a.totalScore - b.totalScore)[0];
  const gameOver = players.some((player) => player.totalScore >= winningScore);

  return withLog(
    {
      ...state,
      players,
      phase: gameOver ? 'game-over' : 'round-over',
      selectedSource: null,
      drawnCard: null,
      winnerId: gameOver ? leader.id : null,
      nextStarterId: closer.id
    },
    `${closer.name} ended the round. ${leader.name} leads with ${leader.totalScore}.`
  );
}

export function createGameForPlayers(
  players: Array<Pick<Player, 'id' | 'name' | 'kind'> & Partial<Pick<Player, 'totalScore'>>>,
  round = 1,
  startPlayerId?: string | null
): GameState {
  let deck = makeDeck();
  const dealtPlayers: Player[] = [];

  for (const player of players) {
    const dealt = makePlayer(player.id, player.name, player.kind, deck, player.totalScore || 0);
    dealtPlayers.push(dealt.player);
    deck = dealt.deck;
  }

  const currentPlayerIndex = openingStarterIndex(dealtPlayers, round > 1 ? startPlayerId : null);
  const starter = dealtPlayers[currentPlayerIndex];
  const discard = { ...deck[0], faceUp: true };
  const drawPile = deck.slice(1);

  return {
    players: dealtPlayers,
    drawPile,
    discardPile: [discard],
    currentPlayerIndex,
    phase: 'choose-source',
    selectedSource: null,
    drawnCard: null,
    round,
    log: [`${starter.name} starts round ${round}. Pick from the discard pile or draw blind.`],
    winnerId: null,
    nextStarterId: null
  };
}

export function createGame(existingPlayers?: Player[], round = 1, startPlayerId?: string | null): GameState {
  const previousScores = new Map((existingPlayers || []).map((player) => [player.id, player.totalScore]));
  return createGameForPlayers(
    [
      { id: 'human', name: 'You', kind: 'human', totalScore: previousScores.get('human') || 0 },
      { id: 'ai-1', name: 'Nova', kind: 'ai', totalScore: previousScores.get('ai-1') || 0 }
    ],
    round,
    startPlayerId
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
      totalScore: player.totalScore || 0
    })),
    round,
    startPlayerId
  );
}

export function startFreshGame(): GameState {
  return createGame();
}

export function startNextRound(state: GameState): GameState {
  return createGame(state.players, state.round + 1, state.nextStarterId);
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

export function getBestAiMove(state: GameState): { action: 'discard' | 'draw' | 'replace' | 'reveal'; index?: number } {
  const player = currentPlayer(state);
  const hiddenIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
  const candidates = player.grid
    .map((card, index) => ({ card, index, score: card.faceUp ? card.value : 6 }))
    .filter(({ card }) => !card.removed)
    .sort((a, b) => b.score - a.score);
  const worst = candidates[0];

  if (state.phase === 'choose-source') {
    const topDiscard = state.discardPile[0];
    if (topDiscard && worst && topDiscard.value < worst.score) return { action: 'discard' };
    return { action: 'draw' };
  }

  if (state.selectedSource === 'discard') {
    return { action: 'replace', index: worst?.index || 0 };
  }

  if (state.drawnCard && worst && state.drawnCard.value < worst.score) {
    return { action: 'replace', index: worst.index };
  }

  if (hiddenIndex >= 0) return { action: 'reveal', index: hiddenIndex };
  return { action: 'replace', index: worst?.index || 0 };
}
