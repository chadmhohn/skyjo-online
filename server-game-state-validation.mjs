import {
  isWellFormedUnicode,
  toWellFormedUnicode
} from './server-unicode.mjs';

const GAME_STATE_KEYS = Object.freeze([
  'players',
  'drawPile',
  'discardPile',
  'currentPlayerIndex',
  'phase',
  'selectedSource',
  'drawnCard',
  'round',
  'log',
  'winnerId',
  'nextStarterId',
  'roundCloserId',
  'finalTurnPlayerIds',
  'openingRevealCounts',
  'roundHistory'
]);
const PLAYER_KEYS = Object.freeze(['id', 'kind', 'name', 'grid', 'totalScore', 'roundScore']);
const CARD_KEYS = Object.freeze(['id', 'value', 'faceUp', 'removed']);
const HISTORY_KEYS = Object.freeze(['round', 'closerId', 'scores']);
const HISTORY_SCORE_KEYS = Object.freeze(['playerId', 'name', 'roundScore', 'totalScore']);
const PHASES = new Set(['opening-reveal', 'choose-source', 'choose-replacement', 'round-over', 'game-over']);
const ROOM_STATUSES = new Set(['waiting', 'playing', 'finished']);
const EXPECTED_CARD_VALUE_COUNTS = new Map([
  [-2, 5],
  [-1, 10],
  [0, 15],
  ...Array.from({ length: 12 }, (_, index) => [index + 1, 10])
]);

export const PERSISTED_GAME_STATE_LIMITS = Object.freeze({
  players: 8,
  cards: 150,
  cardIdLength: 128,
  playerIdLength: 128,
  playerNameLength: 64,
  logEntries: 8,
  logEntryLength: 512,
  historyEntries: 256,
  scoreMagnitude: 1_000_000_000
});

export class PersistedGameStateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistedGameStateValidationError';
    this.code = 'INVALID_PERSISTED_GAME_STATE';
  }
}

function fail(message) {
  throw new PersistedGameStateValidationError(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactRecord(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an invalid shape.`);
  }
  return value;
}

function boundedIdentifier(value, maximumLength, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function boundedName(value, label) {
  const normalized = typeof value === 'string' ? toWellFormedUnicode(value) : value;
  if (
    typeof normalized !== 'string' ||
    normalized.length === 0 ||
    normalized.length > PERSISTED_GAME_STATE_LIMITS.playerNameLength ||
    normalized.trim() !== normalized ||
    /[\u0000\r\n]/.test(normalized)
  ) {
    fail(`${label} is invalid.`);
  }
  return normalized;
}

function finiteScore(value, label) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > PERSISTED_GAME_STATE_LIMITS.scoreMagnitude) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function validPlayerReference(value, rosterIds, playerIdSet, label, allowNull = true) {
  if (value === null && allowNull) return null;
  const id = boundedIdentifier(value, PERSISTED_GAME_STATE_LIMITS.playerIdLength, label);
  if (!playerIdSet.has(id) || !rosterIds.includes(id)) fail(`${label} does not reference a room player.`);
  return id;
}

function normalizeCard(value, label) {
  const card = requireExactRecord(value, CARD_KEYS, label);
  const id = boundedIdentifier(card.id, PERSISTED_GAME_STATE_LIMITS.cardIdLength, `${label} id`);
  if (!Number.isInteger(card.value) || card.value < -2 || card.value > 12) {
    fail(`${label} value is invalid.`);
  }
  if (typeof card.faceUp !== 'boolean' || typeof card.removed !== 'boolean') {
    fail(`${label} flags are invalid.`);
  }
  return { id, value: card.value, faceUp: card.faceUp, removed: card.removed };
}

function normalizeReferenceList(value, rosterIds, playerIdSet, label) {
  if (!Array.isArray(value) || value.length > rosterIds.length) fail(`${label} must be a bounded array.`);
  const normalized = value.map((item, index) =>
    validPlayerReference(item, rosterIds, playerIdSet, `${label}[${index}]`, false)
  );
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate players.`);
  return normalized;
}

function normalizeContext(context) {
  if (!isRecord(context)) fail('Game-state validation context is required.');
  const rosterPlayerIds = context.rosterPlayerIds;
  if (!Array.isArray(rosterPlayerIds) || rosterPlayerIds.length < 2 || rosterPlayerIds.length > PERSISTED_GAME_STATE_LIMITS.players) {
    fail('Room roster must contain between two and eight player ids.');
  }
  const normalizedRoster = rosterPlayerIds.map((id, index) =>
    boundedIdentifier(id, PERSISTED_GAME_STATE_LIMITS.playerIdLength, `Room roster player ${index}`)
  );
  if (new Set(normalizedRoster).size !== normalizedRoster.length) fail('Room roster player ids must be unique.');
  if (!ROOM_STATUSES.has(context.roomStatus)) fail('Room status is invalid.');
  const playerIdSet = new Set(normalizedRoster);
  const readyForNextRoundPlayerIds = normalizeReferenceList(
    context.readyForNextRoundPlayerIds ?? [],
    normalizedRoster,
    playerIdSet,
    'Ready player ids'
  );
  return {
    rosterPlayerIds: normalizedRoster,
    playerIdSet,
    roomStatus: context.roomStatus,
    readyForNextRoundPlayerIds
  };
}

function normalizePlayers(value, rosterIds) {
  if (!Array.isArray(value) || value.length !== rosterIds.length) {
    fail('Game-state players must exactly match the room roster.');
  }
  return value.map((item, playerIndex) => {
    const player = requireExactRecord(item, PLAYER_KEYS, `Player ${playerIndex}`);
    const id = boundedIdentifier(player.id, PERSISTED_GAME_STATE_LIMITS.playerIdLength, `Player ${playerIndex} id`);
    if (id !== rosterIds[playerIndex]) fail('Game-state player order does not match the room roster.');
    if (player.kind !== 'human' && player.kind !== 'ai') fail(`Player ${playerIndex} kind is invalid.`);
    const name = boundedName(player.name, `Player ${playerIndex} name`);
    if (!Array.isArray(player.grid) || player.grid.length !== 12) fail(`Player ${playerIndex} grid must contain 12 cards.`);
    const grid = player.grid.map((card, cardIndex) => normalizeCard(card, `Player ${playerIndex} grid card ${cardIndex}`));
    return {
      id,
      kind: player.kind,
      name,
      grid,
      totalScore: finiteScore(player.totalScore, `Player ${playerIndex} total score`),
      roundScore: finiteScore(player.roundScore, `Player ${playerIndex} round score`)
    };
  });
}

function normalizeCardPile(value, label) {
  if (!Array.isArray(value) || value.length > PERSISTED_GAME_STATE_LIMITS.cards) {
    fail(`${label} must be a bounded card array.`);
  }
  return value.map((card, index) => normalizeCard(card, `${label} card ${index}`));
}

function normalizeOpeningCounts(value, rosterIds) {
  const counts = requireExactRecord(value, rosterIds, 'Opening reveal counts');
  const normalized = {};
  for (const id of rosterIds) {
    if (!Number.isSafeInteger(counts[id]) || counts[id] < 0 || counts[id] > 2) {
      fail('Opening reveal count is invalid.');
    }
    normalized[id] = counts[id];
  }
  return normalized;
}

function normalizeHistory(value, rosterIds, playerIdSet) {
  if (!Array.isArray(value) || value.length > PERSISTED_GAME_STATE_LIMITS.historyEntries) {
    fail('Round history must be a bounded array.');
  }
  return value.map((item, historyIndex) => {
    const entry = requireExactRecord(item, HISTORY_KEYS, `Round history entry ${historyIndex}`);
    if (!Number.isSafeInteger(entry.round) || entry.round !== historyIndex + 1) {
      fail('Round history must be contiguous and start at round one.');
    }
    const closerId = validPlayerReference(
      entry.closerId,
      rosterIds,
      playerIdSet,
      `Round history entry ${historyIndex} closer`,
      false
    );
    if (!Array.isArray(entry.scores) || entry.scores.length !== rosterIds.length) {
      fail(`Round history entry ${historyIndex} scores must exactly match the room roster.`);
    }
    const scores = entry.scores.map((itemScore, scoreIndex) => {
      const score = requireExactRecord(itemScore, HISTORY_SCORE_KEYS, `Round history score ${historyIndex}:${scoreIndex}`);
      const playerId = validPlayerReference(
        score.playerId,
        rosterIds,
        playerIdSet,
        `Round history score ${historyIndex}:${scoreIndex} player`,
        false
      );
      if (playerId !== rosterIds[scoreIndex]) fail('Round history score order does not match the room roster.');
      return {
        playerId,
        name: boundedName(score.name, `Round history score ${historyIndex}:${scoreIndex} name`),
        roundScore: finiteScore(score.roundScore, `Round history score ${historyIndex}:${scoreIndex} round score`),
        totalScore: finiteScore(score.totalScore, `Round history score ${historyIndex}:${scoreIndex} total score`)
      };
    });
    return { round: entry.round, closerId, scores };
  });
}

function validatePhysicalCards(players, drawPile, discardPile, drawnCard, scoringPhase) {
  if (discardPile.length === 0) fail('Discard pile must contain a top card.');
  const physicalCards = new Map();

  function addCardOccurrence(card, label, live) {
    const existing = physicalCards.get(card.id);
    if (existing && existing.value !== card.value) fail(`${label} changes a physical card value.`);
    const record = existing ?? { value: card.value, liveCount: 0, tombstoneCount: 0 };
    if (live) {
      record.liveCount += 1;
      if (record.liveCount > 1) fail(`${label} duplicates a live card id.`);
    } else {
      record.tombstoneCount += 1;
    }
    physicalCards.set(card.id, record);
  }

  for (const [playerIndex, player] of players.entries()) {
    for (const [cardIndex, card] of player.grid.entries()) {
      if (card.removed) {
        if (!card.faceUp) fail(`Player ${playerIndex} removed grid card ${cardIndex} must be face up.`);
        addCardOccurrence(card, `Player ${playerIndex} removed grid card ${cardIndex}`, false);
      } else {
        addCardOccurrence(card, `Player ${playerIndex} grid card ${cardIndex}`, true);
      }
    }
  }
  for (const [index, card] of drawPile.entries()) {
    if (card.faceUp || card.removed) fail(`Draw pile card ${index} must be live and face down.`);
    addCardOccurrence(card, `Draw pile card ${index}`, true);
  }
  for (const [index, card] of discardPile.entries()) {
    if (!card.faceUp || card.removed) fail(`Discard pile card ${index} must be live and face up.`);
    addCardOccurrence(card, `Discard pile card ${index}`, true);
  }
  if (drawnCard) {
    if (!drawnCard.faceUp || drawnCard.removed) fail('Drawn card must be live and face up.');
    addCardOccurrence(drawnCard, 'Drawn card', true);
  }

  if (physicalCards.size !== PERSISTED_GAME_STATE_LIMITS.cards) {
    fail('Game state must contain exactly 150 distinct physical card ids.');
  }
  const actualValueCounts = new Map();
  for (const card of physicalCards.values()) {
    if (card.liveCount === 0 && !scoringPhase) fail('Active game state cannot strand a card as tombstones only.');
    actualValueCounts.set(card.value, (actualValueCounts.get(card.value) ?? 0) + 1);
  }
  for (const [value, expectedCount] of EXPECTED_CARD_VALUE_COUNTS) {
    if (actualValueCounts.get(value) !== expectedCount) fail('Live card values do not match the game deck.');
  }
}

function validateScores(state) {
  const visibleScores = new Map(state.players.map((player) => [
    player.id,
    player.grid.reduce(
      (total, card) => total + (card.faceUp && !card.removed ? card.value : 0),
      0
    )
  ]));
  const scoringPhase = state.phase === 'round-over' || state.phase === 'game-over';
  const closerId = scoringPhase ? state.roundHistory.at(-1)?.closerId : null;
  const closerVisibleScore = closerId ? visibleScores.get(closerId) : undefined;
  const closerScoreDoubled = closerId !== null &&
    closerVisibleScore !== undefined &&
    closerVisibleScore > 0 &&
    state.players.some((player) => player.id !== closerId && closerVisibleScore >= visibleScores.get(player.id));

  for (const [playerIndex, player] of state.players.entries()) {
    const visibleScore = visibleScores.get(player.id);
    const expectedScore = closerScoreDoubled && player.id === closerId ? visibleScore * 2 : visibleScore;
    if (player.roundScore !== expectedScore) fail(`Player ${playerIndex} round score does not match the visible grid.`);
  }
}

function validateHistoryCoherence(state) {
  const scoringPhase = state.phase === 'round-over' || state.phase === 'game-over';
  const expectedHistoryLength = scoringPhase ? state.round : state.round - 1;
  if (state.roundHistory.length !== expectedHistoryLength) fail('Round number and history length disagree.');
  const lastHistory = state.roundHistory.at(-1);
  if (!lastHistory) return;
  for (const [index, player] of state.players.entries()) {
    const score = lastHistory.scores[index];
    if (score.totalScore !== player.totalScore) fail('Player total score does not match round history.');
    if (scoringPhase && score.roundScore !== player.roundScore) fail('Player round score does not match round history.');
  }
}

function validatePhaseCoherence(state, context) {
  const scoringPhase = state.phase === 'round-over' || state.phase === 'game-over';
  if (context.roomStatus === 'waiting') fail('A waiting room cannot contain active game state.');
  if (context.roomStatus === 'finished' && state.phase !== 'game-over') fail('A finished room must contain game-over state.');
  if (context.roomStatus === 'playing' && state.phase === 'game-over') fail('Game-over state requires a finished room.');
  if (!scoringPhase && context.readyForNextRoundPlayerIds.length > 0) {
    fail('Ready player ids are allowed only after a round finishes.');
  }

  if (state.phase === 'choose-replacement') {
    if (state.selectedSource !== 'draw' && state.selectedSource !== 'discard') {
      fail('Replacement phase requires an exact selected source.');
    }
    if (state.selectedSource === 'draw' && !state.drawnCard) fail('Blind-draw replacement requires a drawn card.');
    if (state.selectedSource === 'discard' && state.drawnCard) fail('Discard replacement cannot contain a drawn card.');
  } else if (state.selectedSource !== null || state.drawnCard !== null) {
    fail('Only replacement phase may retain a selected source or drawn card.');
  }

  if (state.phase === 'opening-reveal') {
    if (state.roundCloserId !== null || state.finalTurnPlayerIds.length > 0 || state.winnerId !== null) {
      fail('Opening state contains incompatible round completion fields.');
    }
    for (const [index, player] of state.players.entries()) {
      const visible = player.grid.filter((card) => card.faceUp && !card.removed).length;
      if (state.openingRevealCounts[player.id] !== visible || visible > 2) {
        fail(`Opening reveal count for player ${index} disagrees with the grid.`);
      }
    }
    if (state.openingRevealCounts[state.players[state.currentPlayerIndex].id] >= 2) {
      fail('Opening current player has already completed both reveals.');
    }
  } else {
    for (const player of state.players) {
      if (state.openingRevealCounts[player.id] !== 2) fail('Active and completed rounds require two opening reveals per player.');
    }
  }

  if (scoringPhase) {
    if (state.roundCloserId !== null || state.finalTurnPlayerIds.length > 0 || state.nextStarterId === null) {
      fail('Completed round fields are incoherent.');
    }
    if (state.nextStarterId !== state.roundHistory.at(-1)?.closerId) {
      fail('Next starter must be the recorded round closer.');
    }
    if (state.players.some((player) => player.grid.some((card) => !card.faceUp && !card.removed))) {
      fail('Completed rounds cannot retain face-down live grid cards.');
    }
  } else if (state.phase !== 'opening-reveal' && state.nextStarterId !== null) {
    fail('An active turn cannot retain a next-round starter.');
  }

  if (state.phase === 'game-over') {
    if (state.winnerId === null || !state.players.some((player) => player.totalScore >= 100)) {
      fail('Game-over state lacks a valid winner threshold.');
    }
    const leader = [...state.players].sort((left, right) => left.totalScore - right.totalScore)[0];
    if (state.winnerId !== leader.id) fail('Game-over winner does not match the lowest total score.');
  } else if (state.winnerId !== null) {
    fail('Winner id is allowed only in game-over state.');
  }
  if (state.phase === 'round-over' && state.players.some((player) => player.totalScore >= 100)) {
    fail('Round-over state crossed the game-over threshold.');
  }

  if (state.roundCloserId === null) {
    if (state.finalTurnPlayerIds.length > 0) fail('Final-turn players require a round closer.');
  } else {
    if (scoringPhase || state.phase === 'opening-reveal' || state.finalTurnPlayerIds.length === 0) {
      fail('Round closer is incompatible with the current phase.');
    }
    if (state.finalTurnPlayerIds.includes(state.roundCloserId)) fail('Round closer cannot receive a final turn.');
    const currentPlayerId = state.players[state.currentPlayerIndex].id;
    if (!state.finalTurnPlayerIds.includes(currentPlayerId)) fail('Current player must be in the remaining final-turn list.');
  }
}

export function normalizePersistedGameState(value, validationContext) {
  const context = normalizeContext(validationContext);
  const input = requireExactRecord(value, GAME_STATE_KEYS, 'Game state');
  const players = normalizePlayers(input.players, context.rosterPlayerIds);
  const drawPile = normalizeCardPile(input.drawPile, 'Draw pile');
  const discardPile = normalizeCardPile(input.discardPile, 'Discard pile');
  if (!Number.isSafeInteger(input.currentPlayerIndex) || input.currentPlayerIndex < 0 || input.currentPlayerIndex >= players.length) {
    fail('Current player index is invalid.');
  }
  if (!PHASES.has(input.phase)) fail('Game phase is invalid.');
  if (input.selectedSource !== null && input.selectedSource !== 'draw' && input.selectedSource !== 'discard') {
    fail('Selected source is invalid.');
  }
  const drawnCard = input.drawnCard === null ? null : normalizeCard(input.drawnCard, 'Drawn card');
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > PERSISTED_GAME_STATE_LIMITS.historyEntries + 1) {
    fail('Round number is invalid.');
  }
  if (!Array.isArray(input.log) || input.log.length > PERSISTED_GAME_STATE_LIMITS.logEntries) {
    fail('Game log must be a bounded array.');
  }
  const log = input.log.map((entry) => {
    const normalized = typeof entry === 'string' ? toWellFormedUnicode(entry) : entry;
    if (typeof normalized !== 'string' ||
        !isWellFormedUnicode(normalized) ||
        normalized.length > PERSISTED_GAME_STATE_LIMITS.logEntryLength ||
        /\u0000/.test(normalized)) {
      fail('Game log entry is invalid.');
    }
    return normalized;
  });
  const winnerId = validPlayerReference(input.winnerId, context.rosterPlayerIds, context.playerIdSet, 'Winner id');
  const nextStarterId = validPlayerReference(input.nextStarterId, context.rosterPlayerIds, context.playerIdSet, 'Next starter id');
  const roundCloserId = validPlayerReference(input.roundCloserId, context.rosterPlayerIds, context.playerIdSet, 'Round closer id');
  const finalTurnPlayerIds = normalizeReferenceList(
    input.finalTurnPlayerIds,
    context.rosterPlayerIds,
    context.playerIdSet,
    'Final-turn player ids'
  );
  const openingRevealCounts = normalizeOpeningCounts(input.openingRevealCounts, context.rosterPlayerIds);
  const roundHistory = normalizeHistory(input.roundHistory, context.rosterPlayerIds, context.playerIdSet);

  const normalized = {
    players,
    drawPile,
    discardPile,
    currentPlayerIndex: input.currentPlayerIndex,
    phase: input.phase,
    selectedSource: input.selectedSource,
    drawnCard,
    round: input.round,
    log,
    winnerId,
    nextStarterId,
    roundCloserId,
    finalTurnPlayerIds,
    openingRevealCounts,
    roundHistory
  };
  validatePhysicalCards(
    players,
    drawPile,
    discardPile,
    drawnCard,
    normalized.phase === 'round-over' || normalized.phase === 'game-over'
  );
  validateScores(normalized);
  validateHistoryCoherence(normalized);
  validatePhaseCoherence(normalized, context);
  return normalized;
}

export function validatePersistedGameState(value, validationContext) {
  try {
    normalizePersistedGameState(value, validationContext);
    return true;
  } catch (error) {
    if (error instanceof PersistedGameStateValidationError) return false;
    throw error;
  }
}
