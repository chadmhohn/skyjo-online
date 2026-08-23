import type { Card, GameState, Player } from './types';
import { sanitizeLegacySoloAiNames } from './legacyAiBranding';
import {
  createSoloGameSetup,
  isResolvedSoloGameSetup,
  resolveSoloGameSetup,
  type SoloGameSetup
} from './soloAiSetup';

export { createSoloGameSetup } from './soloAiSetup';
export type { SoloAiDifficulty, SoloAiDifficultySelection, SoloGameSetup } from './soloAiSetup';

export const soloDatabaseName = 'skyjo-pwa';
export const soloDatabaseVersion = 1;
export const soloSessionStoreName = 'soloSessions';
export const statsOutboxStoreName = 'statsOutbox';

const recordSchemaVersion = 1;
const maxDeliveryBatchSize = 4;
const maxRetryDelayMs = 5 * 60 * 1000;
const soloWinningScore = 100;
const canonicalSoloDeckValues = [
  ...Array<number>(5).fill(-2),
  ...Array<number>(10).fill(-1),
  ...Array<number>(15).fill(0),
  ...Array.from({ length: 12 }, (_, index) => Array<number>(10).fill(index + 1)).flat()
] as const;

export type SoloOwnerKey = `account:${string}` | 'guest';
export type SoloPersistenceWarningKind = 'conflict' | 'quota' | 'recovered' | 'unavailable';

export interface SoloPersistenceWarning {
  kind: SoloPersistenceWarningKind;
  message: string;
}

export interface SoloSessionRecord {
  ownerKey: SoloOwnerKey;
  gameId: string;
  schemaVersion: 1;
  state: GameState;
  aiOpponentCount: number;
  setup: SoloGameSetup;
  updatedAt: number;
}

export interface StatsOutboxRecord {
  ownerKey: SoloOwnerKey;
  gameId: string;
  schemaVersion: 1;
  state: GameState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastError: string;
}

export interface SoloSessionLoadResult {
  session: SoloSessionRecord | null;
  warning: SoloPersistenceWarning | null;
}

export interface StatsFlushResult {
  attempted: number;
  delivered: number;
  pending: number;
  aborted: boolean;
}

export type StatsDelivery = (record: StatsOutboxRecord, signal: AbortSignal) => Promise<unknown>;

type StatsFlushOptions = {
  ownerKey: SoloOwnerKey;
  deliver: StatsDelivery;
  signal?: AbortSignal;
  force?: boolean;
  now?: () => number;
  batchSize?: number;
  isOwnerCurrent?: () => boolean;
};

type StatsOutboxCoordinator = {
  dispose: () => void;
  flush: (force?: boolean) => Promise<StatsFlushResult>;
  setOwner: (ownerKey: SoloOwnerKey | null) => void;
};

let databasePromise: Promise<IDBDatabase> | null = null;

class SoloSessionConflictError extends Error {
  override readonly name = 'SoloSessionConflictError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed.')), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error || new Error('IndexedDB transaction was aborted.')),
      { once: true }
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error || new Error('IndexedDB transaction failed.')),
      { once: true }
    );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }

    let request: IDBOpenDBRequest;
    let openFailed = false;
    const rejectOpen = (error: unknown) => {
      openFailed = true;
      reject(error);
    };
    try {
      request = indexedDB.open(soloDatabaseName, soloDatabaseVersion);
    } catch (error) {
      rejectOpen(error);
      return;
    }

    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(soloSessionStoreName)) {
        const sessions = database.createObjectStore(soloSessionStoreName, { keyPath: ['ownerKey', 'gameId'] });
        sessions.createIndex('byOwner', 'ownerKey', { unique: false });
        sessions.createIndex('byOwnerUpdatedAt', ['ownerKey', 'updatedAt'], { unique: false });
      }
      if (!database.objectStoreNames.contains(statsOutboxStoreName)) {
        const outbox = database.createObjectStore(statsOutboxStoreName, { keyPath: ['ownerKey', 'gameId'] });
        outbox.createIndex('byOwner', 'ownerKey', { unique: false });
        outbox.createIndex('byOwnerNextAttempt', ['ownerKey', 'nextAttemptAt'], { unique: false });
      }
    });
    request.addEventListener('success', () => {
      const database = request.result;
      if (openFailed) {
        database.close();
        return;
      }
      database.addEventListener('versionchange', () => {
        database.close();
        databasePromise = null;
      });
      resolve(database);
    });
    request.addEventListener('blocked', () => rejectOpen(new Error('IndexedDB upgrade was blocked.')), { once: true });
    request.addEventListener('error', () => rejectOpen(request.error || new Error('IndexedDB could not be opened.')), {
      once: true
    });
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise as Promise<IDBDatabase>;
}

async function withStore<T>(
  storeName: typeof soloSessionStoreName | typeof statsOutboxStoreName,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const completion = transactionComplete(transaction);
  try {
    const result = await operation(transaction.objectStore(storeName));
    await completion;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The request may already have aborted the transaction.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

function canonicalCardIndex(card: Pick<Card, 'id' | 'value'>): number | null {
  const match = /^card-(0|[1-9]\d*)-(-?\d+)$/.exec(card.id);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0 || index >= canonicalSoloDeckValues.length) return null;
  return Number(match[2]) === card.value && canonicalSoloDeckValues[index] === card.value ? index : null;
}

function isCard(value: unknown): value is Card {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.value) &&
    typeof value.faceUp === 'boolean' &&
    typeof value.removed === 'boolean' &&
    canonicalCardIndex(value as unknown as Card) !== null
  );
}

function isRoundScore(value: unknown): value is GameState['roundHistory'][number]['scores'][number] {
  return (
    isRecord(value) &&
    typeof value.playerId === 'string' &&
    typeof value.name === 'string' &&
    Number.isSafeInteger(value.roundScore) &&
    Number.isSafeInteger(value.totalScore)
  );
}

function isRoundHistoryEntry(value: unknown): value is GameState['roundHistory'][number] {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.round) &&
    Number(value.round) >= 1 &&
    typeof value.closerId === 'string' &&
    Array.isArray(value.scores) &&
    value.scores.every(isRoundScore)
  );
}

function visibleGridScore(player: Player): number {
  return player.grid.reduce((total, card) => total + (card.faceUp && !card.removed ? card.value : 0), 0);
}

function finalGridScore(player: Player): number {
  return player.grid.reduce((total, card) => total + (card.removed ? 0 : card.value), 0);
}

function hasCanonicalPhysicalDeck(state: GameState): boolean {
  if (state.discardPile.length === 0) return false;
  if (state.drawPile.some((card) => card.faceUp || card.removed)) return false;
  if (state.discardPile.some((card) => !card.faceUp || card.removed)) return false;
  if (state.drawnCard && (!state.drawnCard.faceUp || state.drawnCard.removed)) return false;

  const activeCards = [
    ...state.drawPile,
    ...state.discardPile,
    ...(state.drawnCard ? [state.drawnCard] : []),
    ...state.players.flatMap((player) => player.grid.filter((card) => !card.removed))
  ];
  const terminal = state.phase === 'round-over' || state.phase === 'game-over';
  if (!terminal && activeCards.length !== canonicalSoloDeckValues.length) return false;

  const activeIndexes = new Set<number>();
  for (const card of activeCards) {
    const index = canonicalCardIndex(card);
    if (index === null || activeIndexes.has(index)) return false;
    activeIndexes.add(index);
  }

  const coveredIndexes = new Set(activeIndexes);
  for (const card of state.players.flatMap((player) => player.grid.filter((item) => item.removed))) {
    const index = canonicalCardIndex(card);
    if (!card.faceUp || index === null) return false;
    coveredIndexes.add(index);
  }
  return coveredIndexes.size === canonicalSoloDeckValues.length;
}

function hasCoherentRemovedColumns(state: GameState): boolean {
  for (const player of state.players) {
    for (let column = 0; column < 4; column += 1) {
      const cards = [player.grid[column], player.grid[column + 4], player.grid[column + 8]];
      const removedCards = cards.filter((card) => card.removed);
      if (removedCards.length === 0) {
        if (cards.every((card) => card.faceUp && card.value === cards[0].value)) return false;
        continue;
      }
      if (
        state.phase === 'opening-reveal' ||
        removedCards.length !== 3 ||
        new Set(removedCards.map((card) => card.id)).size !== 3 ||
        removedCards.some((card) => !card.faceUp || card.value !== removedCards[0].value)
      ) {
        return false;
      }
    }
  }
  return true;
}

function hasCoherentKnownCards(state: GameState): boolean {
  if (state.phase === 'opening-reveal') return true;
  if (state.players.some((player) => player.grid.filter((card) => card.faceUp || card.removed).length < 2)) {
    return false;
  }
  if (state.phase === 'round-over' || state.phase === 'game-over' || state.roundCloserId !== null) return true;
  return !state.players.some((player) => player.grid.every((card) => card.faceUp || card.removed));
}

function hasCoherentOpeningCounts(state: GameState): boolean {
  const keys = Object.keys(state.openingRevealCounts);
  if (keys.length !== state.players.length) return false;
  for (const player of state.players) {
    if (!Object.prototype.hasOwnProperty.call(state.openingRevealCounts, player.id)) return false;
    const recorded = state.openingRevealCounts[player.id];
    if (!Number.isSafeInteger(recorded) || recorded < 0 || recorded > 2) return false;
    const visible = player.grid.filter((card) => card.faceUp && !card.removed).length;
    if (state.phase === 'opening-reveal' ? recorded !== visible : recorded !== 2) return false;
  }
  if (state.phase !== 'opening-reveal') return true;
  const firstIncompletePlayer = state.players.findIndex(
    (player) => player.grid.filter((card) => card.faceUp && !card.removed).length < 2
  );
  return firstIncompletePlayer >= 0 && state.currentPlayerIndex === firstIncompletePlayer;
}

function hasCoherentRoundHistory(state: GameState, playersById: Map<string, Player>): boolean {
  const terminal = state.phase === 'round-over' || state.phase === 'game-over';
  const expectedEntries = terminal ? state.round : state.round - 1;
  if (state.roundHistory.length !== expectedEntries) return false;

  const totals = new Map(state.players.map((player) => [player.id, 0]));
  for (const [index, entry] of state.roundHistory.entries()) {
    if (entry.round !== index + 1 || !playersById.has(entry.closerId) || entry.scores.length !== state.players.length) {
      return false;
    }
    const scoreIds = new Set<string>();
    for (const score of entry.scores) {
      const player = playersById.get(score.playerId);
      if (!player || scoreIds.has(score.playerId) || score.name !== player.name) return false;
      if (score.totalScore !== (totals.get(score.playerId) || 0) + score.roundScore) return false;
      scoreIds.add(score.playerId);
      totals.set(score.playerId, score.totalScore);
    }
    if (scoreIds.size !== state.players.length) return false;
  }

  for (const player of state.players) {
    if (player.totalScore !== (totals.get(player.id) || 0)) return false;
    if (!terminal && player.roundScore !== visibleGridScore(player)) return false;
  }
  if (!terminal) return true;
  const latestScores = new Map(state.roundHistory[state.roundHistory.length - 1].scores.map((score) => [score.playerId, score]));
  return state.players.every((player) => latestScores.get(player.id)?.roundScore === player.roundScore);
}

function hasCoherentTerminalState(state: GameState): boolean {
  if (state.phase !== 'round-over' && state.phase !== 'game-over') return true;
  if (state.players.some((player) => player.grid.some((card) => !card.removed && !card.faceUp))) {
    return false;
  }
  const closerId = state.nextStarterId;
  if (!closerId) return false;
  if (state.roundHistory[state.roundHistory.length - 1]?.closerId !== closerId) return false;
  const closer = state.players.find((player) => player.id === closerId);
  if (!closer) return false;
  const rawScores = new Map(state.players.map((player) => [player.id, finalGridScore(player)]));
  const closerRawScore = rawScores.get(closer.id) || 0;
  const lowestOtherScore = Math.min(...state.players.filter((player) => player.id !== closer.id).map((player) => rawScores.get(player.id) || 0));
  const expectedCloserScore = closerRawScore >= lowestOtherScore && closerRawScore > 0 ? closerRawScore * 2 : closerRawScore;
  for (const player of state.players) {
    const expectedScore = player.id === closer.id ? expectedCloserScore : rawScores.get(player.id);
    if (player.roundScore !== expectedScore) return false;
  }

  const thresholdReached = state.players.some((player) => player.totalScore >= soloWinningScore);
  if (state.phase === 'round-over') return !thresholdReached && state.winnerId === null;
  if (!thresholdReached || !state.winnerId) return false;
  const lowestTotal = Math.min(...state.players.map((player) => player.totalScore));
  const expectedWinner = state.players.find((player) => player.totalScore === lowestTotal);
  return state.winnerId === expectedWinner?.id;
}

function hasCoherentPhase(state: GameState): boolean {
  const noSelection = state.selectedSource === null && state.drawnCard === null;
  const noFinalTurn = state.roundCloserId === null && state.finalTurnPlayerIds.length === 0;
  if (state.phase === 'opening-reveal') {
    const expectedStarter = state.round === 1 ? null : state.roundHistory[state.roundHistory.length - 1]?.closerId || null;
    return noSelection && noFinalTurn && state.winnerId === null && state.nextStarterId === expectedStarter;
  }
  if (state.phase === 'round-over') {
    return noSelection && noFinalTurn && state.winnerId === null && state.nextStarterId !== null;
  }
  if (state.phase === 'game-over') {
    return noSelection && noFinalTurn && state.winnerId !== null && state.nextStarterId !== null;
  }
  if (state.winnerId !== null || state.nextStarterId !== null) return false;
  if (state.phase === 'choose-source' && !noSelection) return false;
  if (
    state.phase === 'choose-replacement' &&
    !(
      (state.selectedSource === 'draw' && state.drawnCard !== null) ||
      (state.selectedSource === 'discard' && state.drawnCard === null)
    )
  ) {
    return false;
  }
  if (state.roundCloserId === null) return state.finalTurnPlayerIds.length === 0;
  const closerIndex = state.players.findIndex((player) => player.id === state.roundCloserId);
  const closer = state.players[closerIndex];
  if (!closer || closer.grid.some((card) => !card.faceUp && !card.removed)) return false;

  const fullFinalTurnOrder = Array.from({ length: state.players.length - 1 }, (_, offset) => {
    return state.players[(closerIndex + offset + 1) % state.players.length].id;
  });
  const remainingStart = fullFinalTurnOrder.indexOf(state.players[state.currentPlayerIndex].id);
  if (remainingStart < 0) return false;
  const expectedRemaining = fullFinalTurnOrder.slice(remainingStart);
  return (
    state.finalTurnPlayerIds.length === expectedRemaining.length &&
    state.finalTurnPlayerIds.every((playerId, index) => playerId === expectedRemaining[index])
  );
}

export function isCompatibleSoloGameState(value: unknown): value is GameState {
  if (!isRecord(value) || !Array.isArray(value.players) || value.players.length < 2 || value.players.length > 8) return false;
  if (!Array.isArray(value.drawPile) || !value.drawPile.every(isCard)) return false;
  if (!Array.isArray(value.discardPile) || !value.discardPile.every(isCard)) return false;
  if (!Number.isSafeInteger(value.currentPlayerIndex) || Number(value.currentPlayerIndex) < 0 || Number(value.currentPlayerIndex) >= value.players.length) return false;
  if (!['opening-reveal', 'choose-source', 'choose-replacement', 'round-over', 'game-over'].includes(String(value.phase))) return false;
  if (value.selectedSource !== null && value.selectedSource !== 'draw' && value.selectedSource !== 'discard') return false;
  if (value.drawnCard !== null && !isCard(value.drawnCard)) return false;
  if (!Number.isSafeInteger(value.round) || Number(value.round) < 1) return false;
  if (!Array.isArray(value.log) || value.log.length > 8 || !value.log.every((entry) => typeof entry === 'string')) return false;
  if (value.winnerId !== null && typeof value.winnerId !== 'string') return false;
  if (value.nextStarterId !== null && typeof value.nextStarterId !== 'string') return false;
  if (value.roundCloserId !== null && typeof value.roundCloserId !== 'string') return false;
  if (!Array.isArray(value.finalTurnPlayerIds) || !value.finalTurnPlayerIds.every((id) => typeof id === 'string')) return false;
  if (!isRecord(value.openingRevealCounts) || !Array.isArray(value.roundHistory) || !value.roundHistory.every(isRoundHistoryEntry)) {
    return false;
  }

  let humanPlayers = 0;
  const playerIds = new Set<string>();
  for (const player of value.players) {
    if (
      !isRecord(player) ||
      typeof player.id !== 'string' ||
      !player.id ||
      typeof player.name !== 'string' ||
      !player.name ||
      (player.kind !== 'human' && player.kind !== 'ai') ||
      !Array.isArray(player.grid) ||
      player.grid.length !== 12 ||
      !player.grid.every(isCard) ||
      !Number.isSafeInteger(player.totalScore) ||
      !Number.isSafeInteger(player.roundScore)
    ) {
      return false;
    }
    if (playerIds.has(player.id)) return false;
    playerIds.add(player.id);
    if (player.kind === 'human') humanPlayers += 1;
  }
  if (humanPlayers !== 1) return false;
  if (value.winnerId !== null && !playerIds.has(value.winnerId as string)) return false;
  if (value.nextStarterId !== null && !playerIds.has(value.nextStarterId as string)) return false;
  if (value.roundCloserId !== null && !playerIds.has(value.roundCloserId as string)) return false;
  if (!value.finalTurnPlayerIds.every((id) => playerIds.has(id))) return false;

  const state = value as unknown as GameState;
  const playersById = new Map(state.players.map((player) => [player.id, player]));
  return (
    hasCanonicalPhysicalDeck(state) &&
    hasCoherentRemovedColumns(state) &&
    hasCoherentOpeningCounts(state) &&
    hasCoherentKnownCards(state) &&
    hasCoherentRoundHistory(state, playersById) &&
    hasCoherentPhase(state) &&
    hasCoherentTerminalState(state)
  );
}

function hasExpectedAiOpponentCount(state: GameState, aiOpponentCount: unknown): aiOpponentCount is number {
  return (
    Number.isSafeInteger(aiOpponentCount) &&
    Number(aiOpponentCount) >= 1 &&
    Number(aiOpponentCount) <= 7 &&
    Number(aiOpponentCount) === state.players.length - 1 &&
    Number(aiOpponentCount) === state.players.filter((player) => player.kind === 'ai').length
  );
}

function normalizeSoloGameSetup(
  state: GameState,
  aiOpponentCount: unknown,
  setup: unknown
): SoloGameSetup | null {
  if (!hasExpectedAiOpponentCount(state, aiOpponentCount)) return null;
  if (setup === undefined) {
    return createSoloGameSetup(aiOpponentCount, 'hard');
  }
  if (!isRecord(setup) || setup.aiOpponentCount !== aiOpponentCount) return null;
  const candidate = setup as unknown as SoloGameSetup;
  if (!isResolvedSoloGameSetup(candidate, state)) return null;
  try {
    return resolveSoloGameSetup(candidate, state, 'persisted-assignment');
  } catch {
    return null;
  }
}

function normalizeSoloSessionRecord(value: unknown): SoloSessionRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== recordSchemaVersion ||
    !isOwnerKey(value.ownerKey) ||
    !isUuid(value.gameId) ||
    !isValidTimestamp(value.updatedAt) ||
    !isCompatibleSoloGameState(value.state)
  ) {
    return null;
  }
  const state = sanitizeLegacySoloAiNames(value.state);
  if (!isCompatibleSoloGameState(state)) return null;
  // `setup` remains the v0.2.2 Hard-only rollback contract. New profile
  // metadata lives in the additive `aiSetup` sibling and is preferred when
  // present; malformed new metadata is never silently reassigned.
  const setup = normalizeSoloGameSetup(
    state,
    value.aiOpponentCount,
    value.aiSetup === undefined ? value.setup : value.aiSetup
  );
  if (!setup) return null;
  return {
    ownerKey: value.ownerKey,
    gameId: value.gameId,
    schemaVersion: recordSchemaVersion,
    state,
    aiOpponentCount: setup.aiOpponentCount,
    setup,
    updatedAt: value.updatedAt
  };
}

function normalizeStatsOutboxRecord(value: unknown): StatsOutboxRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== recordSchemaVersion ||
    !isOwnerKey(value.ownerKey) ||
    !isUuid(value.gameId) ||
    !Number.isInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    !isValidTimestamp(value.createdAt) ||
    !isValidTimestamp(value.updatedAt) ||
    !isValidTimestamp(value.nextAttemptAt) ||
    typeof value.lastError !== 'string' ||
    !isCompatibleSoloGameState(value.state) ||
    value.state.phase !== 'game-over'
  ) {
    return null;
  }
  const state = sanitizeLegacySoloAiNames(value.state);
  if (!isCompatibleSoloGameState(state) || state.phase !== 'game-over') return null;
  return {
    ownerKey: value.ownerKey,
    gameId: value.gameId,
    schemaVersion: recordSchemaVersion,
    state,
    attempts: Number(value.attempts),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextAttemptAt: value.nextAttemptAt,
    lastError: value.lastError
  };
}

function isOwnerKey(value: unknown): value is SoloOwnerKey {
  return value === 'guest' || (typeof value === 'string' && value.startsWith('account:') && value.length > 8);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function persistenceWarning(error: unknown): SoloPersistenceWarning {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'SoloSessionConflictError') {
    return {
      kind: 'conflict',
      message: 'A newer saved game is already active. Your current game was left unchanged.'
    };
  }
  if (name === 'QuotaExceededError') {
    return {
      kind: 'quota',
      message: 'This device is low on storage. You can keep playing, but this game may not restore after closing Flipvale.'
    };
  }
  return {
    kind: 'unavailable',
    message: 'Saved games are unavailable in this browser session. You can keep playing normally.'
  };
}

function retryDelay(attempts: number): number {
  return Math.min(maxRetryDelayMs, 1000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return 'Stats delivery failed.';
}

function aborted(signal: AbortSignal | undefined, isOwnerCurrent: (() => boolean) | undefined): boolean {
  return Boolean(signal?.aborted || (isOwnerCurrent && !isOwnerCurrent()));
}

export function soloOwnerKey(userId?: string | null): SoloOwnerKey {
  return userId ? `account:${userId}` : 'guest';
}

/**
 * Remove one deleted account's browser-owned solo state without touching the
 * guest partition or another signed-in account. Both stores share one
 * IndexedDB transaction so a storage failure cannot leave a partial purge.
 */
export async function deleteSoloAccountData(userId: string): Promise<void> {
  if (!isUuid(userId)) throw new Error('Invalid deleted account identifier.');
  const ownerKey = soloOwnerKey(userId);
  const database = await openDatabase();
  const transaction = database.transaction(
    [soloSessionStoreName, statsOutboxStoreName],
    'readwrite'
  );
  const completion = transactionComplete(transaction);
  try {
    const stores = [
      transaction.objectStore(soloSessionStoreName),
      transaction.objectStore(statsOutboxStoreName)
    ];
    const keysByStore = await Promise.all(
      stores.map((store) => requestResult(store.index('byOwner').getAllKeys(ownerKey)))
    );
    for (let storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
      for (const key of keysByStore[storeIndex] as IDBValidKey[]) {
        await requestResult(stores[storeIndex].delete(key));
      }
    }
    await completion;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

export function createSoloGameId(): string {
  return crypto.randomUUID();
}

function recoveredSessionWarning(): SoloPersistenceWarning {
  return {
    kind: 'recovered',
    message: 'A saved game was damaged or created by an incompatible version. The newest usable game was recovered safely.'
  };
}

function discardedSessionWarning(): SoloPersistenceWarning {
  return {
    kind: 'recovered',
    message: 'A saved game was damaged or created by an incompatible version, so it was removed safely.'
  };
}

async function deleteStatsOutboxForOwner(ownerKey: SoloOwnerKey): Promise<void> {
  await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
    const keys = (await requestResult(store.index('byOwner').getAllKeys(ownerKey))) as IDBValidKey[];
    for (const key of keys) store.delete(key);
  });
}

export async function loadSoloSession(ownerKey: SoloOwnerKey): Promise<SoloSessionLoadResult> {
  try {
    if (ownerKey === 'guest') await deleteStatsOutboxForOwner(ownerKey).catch(() => undefined);
    return await withStore(soloSessionStoreName, 'readwrite', async (store) => {
      const index = store.index('byOwner');
      const valueRequest = index.getAll(ownerKey);
      const keyRequest = index.getAllKeys(ownerKey);
      const [values, keys] = await Promise.all([requestResult(valueRequest), requestResult(keyRequest)]);
      const records = (values as unknown[])
        .map((value, index) => ({ value, primaryKey: keys[index] }))
        .sort((left, right) => {
          const leftTime = isRecord(left.value) && typeof left.value.updatedAt === 'number' ? left.value.updatedAt : 0;
          const rightTime = isRecord(right.value) && typeof right.value.updatedAt === 'number' ? right.value.updatedAt : 0;
          if (rightTime !== leftTime) return rightTime - leftTime;
          return JSON.stringify(right.primaryKey).localeCompare(JSON.stringify(left.primaryKey));
        });
      if (records.length === 0) return { session: null, warning: null };

      let recovered = false;
      for (const { value: candidate, primaryKey } of records) {
        const normalized = normalizeSoloSessionRecord(candidate);
        if (normalized && normalized.ownerKey === ownerKey && normalized.state.phase !== 'game-over') {
          if (normalized.state !== (candidate as SoloSessionRecord).state) {
            await requestResult(store.put({ ...(candidate as Record<string, unknown>), ...normalized }));
          }
          return { session: normalized, warning: recovered ? recoveredSessionWarning() : null };
        }
        recovered = true;
        await requestResult(store.delete(primaryKey));
      }
      return { session: null, warning: discardedSessionWarning() };
    });
  } catch (error) {
    return { session: null, warning: persistenceWarning(error) };
  }
}

async function deleteSoloSessionKey(key: IDBValidKey): Promise<void> {
  await withStore(soloSessionStoreName, 'readwrite', async (store) => {
    await requestResult(store.delete(key));
  });
}

export async function saveSoloSession(
  ownerKey: SoloOwnerKey,
  gameId: string,
  state: GameState,
  setupInput: number | SoloGameSetup,
  now = Date.now
): Promise<SoloPersistenceWarning | null> {
  try {
    const sanitizedState = sanitizeLegacySoloAiNames(state);
    const setup =
      typeof setupInput === 'number'
        ? normalizeSoloGameSetup(sanitizedState, setupInput, undefined)
        : normalizeSoloGameSetup(sanitizedState, setupInput.aiOpponentCount, setupInput);
    if (!isUuid(gameId) || !isCompatibleSoloGameState(sanitizedState) || !setup) {
      throw new Error('Invalid solo session.');
    }
    const updatedAt = now();
    if (!isValidTimestamp(updatedAt)) throw new Error('Invalid solo session timestamp.');
    await withStore(soloSessionStoreName, 'readwrite', async (store) => {
      const existing = (await requestResult(store.index('byOwner').getAllKeys(ownerKey))) as IDBValidKey[];
      const hasCurrentGame = existing.some((key) => Array.isArray(key) && key[1] === gameId);
      const hasDifferentGame = existing.some((key) => Array.isArray(key) && key[1] !== gameId);
      if (!hasCurrentGame && hasDifferentGame) {
        throw new SoloSessionConflictError('A stale autosave cannot replace a newer active game.');
      }
      await requestResult(
        store.put({
          ownerKey,
          gameId,
          schemaVersion: recordSchemaVersion,
          state: sanitizedState,
          aiOpponentCount: setup.aiOpponentCount,
          setup: { aiOpponentCount: setup.aiOpponentCount, difficulty: 'hard' },
          aiSetup: setup,
          updatedAt
        })
      );
      for (const key of existing) {
        if (Array.isArray(key) && key[1] !== gameId) await requestResult(store.delete(key));
      }
    });
    return null;
  } catch (error) {
    return persistenceWarning(error);
  }
}

export async function replaceSoloSession(
  ownerKey: SoloOwnerKey,
  previousGameId: string,
  gameId: string,
  state: GameState,
  setup: SoloGameSetup,
  now = Date.now
): Promise<SoloPersistenceWarning | null> {
  try {
    const sanitizedState = sanitizeLegacySoloAiNames(state);
    const normalizedSetup = normalizeSoloGameSetup(sanitizedState, setup.aiOpponentCount, setup);
    if (
      !isUuid(previousGameId) ||
      !isUuid(gameId) ||
      previousGameId === gameId ||
      !isCompatibleSoloGameState(sanitizedState) ||
      !normalizedSetup
    ) {
      throw new Error('Invalid solo session replacement.');
    }
    const updatedAt = now();
    if (!isValidTimestamp(updatedAt)) throw new Error('Invalid solo session timestamp.');

    await withStore(soloSessionStoreName, 'readwrite', async (store) => {
      const existing = (await requestResult(store.index('byOwner').getAllKeys(ownerKey))) as IDBValidKey[];
      const existingGameIds = existing
        .filter((key): key is IDBValidKey[] => Array.isArray(key))
        .map((key) => key[1]);
      if (existingGameIds.length > 0 && !existingGameIds.includes(previousGameId)) {
        throw new SoloSessionConflictError('The expected saved game is no longer active.');
      }

      // Write first, then remove superseded records in the same transaction. Any
      // failed request aborts the transaction and restores the previous record.
      await requestResult(
        store.put({
          ownerKey,
          gameId,
          schemaVersion: recordSchemaVersion,
          state: sanitizedState,
          aiOpponentCount: normalizedSetup.aiOpponentCount,
          setup: { aiOpponentCount: normalizedSetup.aiOpponentCount, difficulty: 'hard' },
          aiSetup: normalizedSetup,
          updatedAt
        })
      );
      for (const key of existing) {
        if (Array.isArray(key) && key[1] !== gameId) await requestResult(store.delete(key));
      }
    });
    return null;
  } catch (error) {
    return persistenceWarning(error);
  }
}

export async function deleteSoloSession(ownerKey: SoloOwnerKey, gameId: string): Promise<void> {
  await deleteSoloSessionKey([ownerKey, gameId]);
}

export async function enqueueCompletedGame(
  ownerKey: SoloOwnerKey,
  gameId: string,
  state: GameState,
  now = Date.now
): Promise<SoloPersistenceWarning | null> {
  try {
    const sanitizedState = sanitizeLegacySoloAiNames(state);
    if (!isUuid(gameId) || !isCompatibleSoloGameState(sanitizedState) || sanitizedState.phase !== 'game-over') {
      throw new Error('Only completed solo games can be queued.');
    }
    await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
      if (ownerKey === 'guest') {
        const guestKeys = (await requestResult(store.index('byOwner').getAllKeys(ownerKey))) as IDBValidKey[];
        for (const key of guestKeys) await requestResult(store.delete(key));
      }
      const key = [ownerKey, gameId];
      const existing = await requestResult(store.get(key));
      const normalizedExisting = normalizeStatsOutboxRecord(existing);
      if (normalizedExisting?.ownerKey === ownerKey && normalizedExisting.gameId === gameId) {
        if (normalizedExisting.state !== (existing as StatsOutboxRecord).state) {
          await requestResult(store.put(normalizedExisting));
        }
        return;
      }
      const timestamp = now();
      await requestResult(
        store.put({
          ownerKey,
          gameId,
          schemaVersion: recordSchemaVersion,
          state: sanitizedState,
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          lastError: ''
        } satisfies StatsOutboxRecord)
      );
    });
    return null;
  } catch (error) {
    return persistenceWarning(error);
  }
}

export async function listStatsOutbox(ownerKey: SoloOwnerKey): Promise<StatsOutboxRecord[]> {
  const validRecords = await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
    const index = store.index('byOwner');
    const valueRequest = index.getAll(ownerKey);
    const keyRequest = index.getAllKeys(ownerKey);
    const [values, keys] = await Promise.all([requestResult(valueRequest), requestResult(keyRequest)]);
    const records = (values as unknown[]).map((value, index) => ({ value, primaryKey: keys[index] }));
    const valid: StatsOutboxRecord[] = [];
    for (const { value: record, primaryKey } of records) {
      const normalized = normalizeStatsOutboxRecord(record);
      if (normalized && normalized.ownerKey === ownerKey) {
        valid.push(normalized);
        if (normalized.state !== (record as StatsOutboxRecord).state) {
          await requestResult(store.put(normalized));
        }
      } else await requestResult(store.delete(primaryKey));
    }
    return valid;
  });
  return validRecords.sort((left, right) => left.createdAt - right.createdAt || left.gameId.localeCompare(right.gameId));
}

export async function flushStatsOutbox({
  ownerKey,
  deliver,
  signal,
  force = false,
  now = Date.now,
  batchSize = maxDeliveryBatchSize,
  isOwnerCurrent
}: StatsFlushOptions): Promise<StatsFlushResult> {
  if (!ownerKey.startsWith('account:')) return { attempted: 0, delivered: 0, pending: (await listStatsOutbox(ownerKey)).length, aborted: false };
  if (aborted(signal, isOwnerCurrent)) return { attempted: 0, delivered: 0, pending: 0, aborted: true };

  const timestamp = now();
  const queuedRecords = await listStatsOutbox(ownerKey);
  const records: StatsOutboxRecord[] = [];
  const deliveryLimit = Math.max(1, Math.min(batchSize, maxDeliveryBatchSize));
  for (const record of queuedRecords) {
    if (records.length >= deliveryLimit || (!force && record.nextAttemptAt > timestamp)) break;
    records.push(record);
  }
  let attempted = 0;
  let delivered = 0;

  for (const record of records) {
    if (aborted(signal, isOwnerCurrent)) {
      return { attempted, delivered, pending: (await listStatsOutbox(ownerKey)).length, aborted: true };
    }
    attempted += 1;
    try {
      await deliver(record, signal || new AbortController().signal);
      if (aborted(signal, isOwnerCurrent)) {
        return { attempted, delivered, pending: (await listStatsOutbox(ownerKey)).length, aborted: true };
      }
      await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
        await requestResult(store.delete([ownerKey, record.gameId]));
      });
      delivered += 1;
    } catch (error) {
      if (aborted(signal, isOwnerCurrent)) {
        return { attempted, delivered, pending: (await listStatsOutbox(ownerKey)).length, aborted: true };
      }
      const attempts = record.attempts + 1;
      await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
        await requestResult(
          store.put({
            ...record,
            attempts,
            updatedAt: timestamp,
            nextAttemptAt: timestamp + retryDelay(attempts),
            lastError: errorMessage(error)
          } satisfies StatsOutboxRecord)
        );
      });
      break;
    }
  }

  return { attempted, delivered, pending: (await listStatsOutbox(ownerKey)).length, aborted: false };
}

export function createStatsOutboxCoordinator(deliver: StatsDelivery): StatsOutboxCoordinator {
  let ownerKey: SoloOwnerKey | null = null;
  let generation = 0;
  let controller = new AbortController();
  let inFlight: Promise<StatsFlushResult> | null = null;
  let queued = false;
  let queuedForce = false;

  function setOwner(nextOwnerKey: SoloOwnerKey | null) {
    if (ownerKey === nextOwnerKey) return;
    ownerKey = nextOwnerKey?.startsWith('account:') ? nextOwnerKey : null;
    generation += 1;
    controller.abort();
    controller = new AbortController();
  }

  async function runFlush(): Promise<StatsFlushResult> {
    let result: StatsFlushResult = { attempted: 0, delivered: 0, pending: 0, aborted: false };
    while (queued && ownerKey) {
      const activeOwner = ownerKey;
      const activeGeneration = generation;
      const activeController = controller;
      const force = queuedForce;
      queued = false;
      queuedForce = false;
      result = await flushStatsOutbox({
        ownerKey: activeOwner,
        deliver,
        signal: activeController.signal,
        force,
        isOwnerCurrent: () => ownerKey === activeOwner && generation === activeGeneration
      });
    }
    return result;
  }

  function startFlush(): Promise<StatsFlushResult> {
    const tracked = runFlush().then(
      (result) => {
        if (inFlight === tracked) inFlight = null;
        return queued && ownerKey ? startFlush() : result;
      },
      (error: unknown) => {
        if (inFlight === tracked) inFlight = null;
        if (queued && ownerKey) void startFlush().catch(() => undefined);
        throw error;
      }
    );
    inFlight = tracked;
    return tracked;
  }

  function flush(force = false): Promise<StatsFlushResult> {
    if (!ownerKey) return Promise.resolve({ attempted: 0, delivered: 0, pending: 0, aborted: false });
    queued = true;
    queuedForce ||= force;
    if (!inFlight) return startFlush();
    return inFlight;
  }

  function dispose() {
    ownerKey = null;
    generation += 1;
    queued = false;
    queuedForce = false;
    controller.abort();
  }

  return { dispose, flush, setOwner };
}

export async function resetSoloDatabaseForTests(): Promise<void> {
  if (databasePromise) {
    const database = await databasePromise.catch(() => null);
    database?.close();
    databasePromise = null;
  }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(soloDatabaseName);
    request.addEventListener('success', () => resolve(), { once: true });
    request.addEventListener('blocked', () => reject(new Error('Test database deletion was blocked.')), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('Test database deletion failed.')), {
      once: true
    });
  });
}

export async function closeSoloDatabaseForTests(): Promise<void> {
  if (!databasePromise) return;
  const database = await databasePromise.catch(() => null);
  database?.close();
  databasePromise = null;
}
