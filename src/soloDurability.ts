import type { GameState } from './types';

export const soloDatabaseName = 'skyjo-pwa';
export const soloDatabaseVersion = 1;
export const soloSessionStoreName = 'soloSessions';
export const statsOutboxStoreName = 'statsOutbox';

const recordSchemaVersion = 1;
const maxDeliveryBatchSize = 4;
const maxRetryDelayMs = 5 * 60 * 1000;

export type SoloOwnerKey = `account:${string}` | 'guest';
export type SoloPersistenceWarningKind = 'quota' | 'recovered' | 'unavailable';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
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
    try {
      request = indexedDB.open(soloDatabaseName, soloDatabaseVersion);
    } catch (error) {
      reject(error);
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
      database.addEventListener('versionchange', () => {
        database.close();
        databasePromise = null;
      });
      resolve(database);
    });
    request.addEventListener('blocked', () => reject(new Error('IndexedDB upgrade was blocked.')), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('IndexedDB could not be opened.')), {
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

function isCard(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    typeof value.faceUp === 'boolean' &&
    typeof value.removed === 'boolean'
  );
}

function isRoundScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.playerId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.roundScore === 'number' &&
    Number.isFinite(value.roundScore) &&
    typeof value.totalScore === 'number' &&
    Number.isFinite(value.totalScore)
  );
}

function isRoundHistoryEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isInteger(value.round) &&
    Number(value.round) >= 1 &&
    typeof value.closerId === 'string' &&
    Array.isArray(value.scores) &&
    value.scores.every(isRoundScore)
  );
}

export function isCompatibleSoloGameState(value: unknown): value is GameState {
  if (!isRecord(value) || !Array.isArray(value.players) || value.players.length < 2 || value.players.length > 8) return false;
  if (!Array.isArray(value.drawPile) || !value.drawPile.every(isCard)) return false;
  if (!Array.isArray(value.discardPile) || !value.discardPile.every(isCard)) return false;
  if (!Number.isInteger(value.currentPlayerIndex) || Number(value.currentPlayerIndex) < 0 || Number(value.currentPlayerIndex) >= value.players.length) return false;
  if (!['opening-reveal', 'choose-source', 'choose-replacement', 'round-over', 'game-over'].includes(String(value.phase))) return false;
  if (value.selectedSource !== null && value.selectedSource !== 'draw' && value.selectedSource !== 'discard') return false;
  if (value.drawnCard !== null && !isCard(value.drawnCard)) return false;
  if (!Number.isInteger(value.round) || Number(value.round) < 1) return false;
  if (!Array.isArray(value.log) || !value.log.every((entry) => typeof entry === 'string')) return false;
  if (value.winnerId !== null && typeof value.winnerId !== 'string') return false;
  if (value.nextStarterId !== null && typeof value.nextStarterId !== 'string') return false;
  if (value.roundCloserId !== null && typeof value.roundCloserId !== 'string') return false;
  if (!Array.isArray(value.finalTurnPlayerIds) || !value.finalTurnPlayerIds.every((id) => typeof id === 'string')) return false;
  if (
    !isRecord(value.openingRevealCounts) ||
    !Object.values(value.openingRevealCounts).every(
      (count) => Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 12
    ) ||
    !Array.isArray(value.roundHistory) ||
    !value.roundHistory.every(isRoundHistoryEntry)
  ) {
    return false;
  }

  let humanPlayers = 0;
  const playerIds = new Set<string>();
  for (const player of value.players) {
    if (
      !isRecord(player) ||
      typeof player.id !== 'string' ||
      typeof player.name !== 'string' ||
      (player.kind !== 'human' && player.kind !== 'ai') ||
      !Array.isArray(player.grid) ||
      player.grid.length !== 12 ||
      !player.grid.every(isCard) ||
      typeof player.totalScore !== 'number' ||
      !Number.isFinite(player.totalScore) ||
      typeof player.roundScore !== 'number' ||
      !Number.isFinite(player.roundScore)
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
  return value.finalTurnPlayerIds.every((id) => playerIds.has(id));
}

function isSoloSessionRecord(value: unknown): value is SoloSessionRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === recordSchemaVersion &&
    isOwnerKey(value.ownerKey) &&
    isUuid(value.gameId) &&
    Number.isInteger(value.aiOpponentCount) &&
    Number(value.aiOpponentCount) >= 1 &&
    Number(value.aiOpponentCount) <= 7 &&
    isValidTimestamp(value.updatedAt) &&
    isCompatibleSoloGameState(value.state)
  );
}

function isStatsOutboxRecord(value: unknown): value is StatsOutboxRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === recordSchemaVersion &&
    isOwnerKey(value.ownerKey) &&
    isUuid(value.gameId) &&
    Number.isInteger(value.attempts) &&
    Number(value.attempts) >= 0 &&
    isValidTimestamp(value.createdAt) &&
    isValidTimestamp(value.updatedAt) &&
    isValidTimestamp(value.nextAttemptAt) &&
    typeof value.lastError === 'string' &&
    isCompatibleSoloGameState(value.state) &&
    value.state.phase === 'game-over'
  );
}

function isOwnerKey(value: unknown): value is SoloOwnerKey {
  return value === 'guest' || (typeof value === 'string' && value.startsWith('account:') && value.length > 8);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function persistenceWarning(error: unknown): SoloPersistenceWarning {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'QuotaExceededError') {
    return {
      kind: 'quota',
      message: 'This device is low on storage. You can keep playing, but this game may not restore after closing Skyjo.'
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

export function createSoloGameId(): string {
  return crypto.randomUUID();
}

export async function loadSoloSession(ownerKey: SoloOwnerKey): Promise<SoloSessionLoadResult> {
  try {
    const records = await withStore(soloSessionStoreName, 'readonly', async (store) => {
      const index = store.index('byOwner');
      const valueRequest = index.getAll(ownerKey);
      const keyRequest = index.getAllKeys(ownerKey);
      const [values, keys] = await Promise.all([requestResult(valueRequest), requestResult(keyRequest)]);
      return (values as unknown[]).map((value, index) => ({ value, primaryKey: keys[index] })).sort((left, right) => {
        const leftTime = isRecord(left.value) && typeof left.value.updatedAt === 'number' ? left.value.updatedAt : 0;
        const rightTime = isRecord(right.value) && typeof right.value.updatedAt === 'number' ? right.value.updatedAt : 0;
        return rightTime - leftTime;
      });
    });
    if (records.length === 0) return { session: null, warning: null };

    const { value: candidate, primaryKey } = records[0];
    if (isSoloSessionRecord(candidate) && candidate.ownerKey === ownerKey && candidate.state.phase !== 'game-over') {
      return { session: candidate, warning: null };
    }

    await deleteSoloSessionKey(primaryKey).catch(() => undefined);
    return {
      session: null,
      warning: {
        kind: 'recovered',
        message: 'A saved game was damaged or created by an incompatible version. A new game was started safely.'
      }
    };
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
  aiOpponentCount: number,
  now = Date.now
): Promise<SoloPersistenceWarning | null> {
  try {
    if (!isUuid(gameId) || !isCompatibleSoloGameState(state)) throw new Error('Invalid solo session.');
    const updatedAt = now();
    await withStore(soloSessionStoreName, 'readwrite', async (store) => {
      const existing = (await requestResult(store.index('byOwner').getAllKeys(ownerKey))) as IDBValidKey[];
      for (const key of existing) {
        if (Array.isArray(key) && key[1] !== gameId) store.delete(key);
      }
      await requestResult(
        store.put({
          ownerKey,
          gameId,
          schemaVersion: recordSchemaVersion,
          state,
          aiOpponentCount,
          updatedAt
        } satisfies SoloSessionRecord)
      );
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
    if (!isUuid(gameId) || !isCompatibleSoloGameState(state) || state.phase !== 'game-over') {
      throw new Error('Only completed solo games can be queued.');
    }
    await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
      const key = [ownerKey, gameId];
      const existing = await requestResult(store.get(key));
      if (existing) return;
      const timestamp = now();
      await requestResult(
        store.add({
          ownerKey,
          gameId,
          schemaVersion: recordSchemaVersion,
          state,
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
  const records = await withStore(statsOutboxStoreName, 'readonly', async (store) => {
    const index = store.index('byOwner');
    const valueRequest = index.getAll(ownerKey);
    const keyRequest = index.getAllKeys(ownerKey);
    const [values, keys] = await Promise.all([requestResult(valueRequest), requestResult(keyRequest)]);
    return (values as unknown[]).map((value, index) => ({ value, primaryKey: keys[index] }));
  });
  const validRecords: StatsOutboxRecord[] = [];
  for (const { value: record, primaryKey } of records) {
    if (isStatsOutboxRecord(record) && record.ownerKey === ownerKey) {
      validRecords.push(record);
      continue;
    }
    await withStore(statsOutboxStoreName, 'readwrite', async (store) => {
      await requestResult(store.delete(primaryKey));
    }).catch(() => undefined);
  }
  return validRecords.sort((left, right) => left.createdAt - right.createdAt);
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
  const records = (await listStatsOutbox(ownerKey))
    .filter((record) => force || record.nextAttemptAt <= timestamp)
    .slice(0, Math.max(1, Math.min(batchSize, maxDeliveryBatchSize)));
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
      if (aborted(signal, isOwnerCurrent) || (error instanceof DOMException && error.name === 'AbortError')) {
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

  function flush(force = false): Promise<StatsFlushResult> {
    if (!ownerKey) return Promise.resolve({ attempted: 0, delivered: 0, pending: 0, aborted: false });
    queued = true;
    queuedForce ||= force;
    if (!inFlight) {
      inFlight = runFlush().finally(() => {
        inFlight = null;
      });
    }
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
