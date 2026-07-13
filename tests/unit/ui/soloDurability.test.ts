import { startFreshGame } from '../../../src/game';
import {
  closeSoloDatabaseForTests,
  createStatsOutboxCoordinator,
  enqueueCompletedGame,
  flushStatsOutbox,
  listStatsOutbox,
  loadSoloSession,
  resetSoloDatabaseForTests,
  saveSoloSession,
  soloDatabaseName,
  soloDatabaseVersion,
  soloOwnerKey,
  soloSessionStoreName,
  statsOutboxStoreName
} from '../../../src/soloDurability';
import type { GameState } from '../../../src/types';

const gameA = '11111111-1111-4111-8111-111111111111';
const gameB = '22222222-2222-4222-8222-222222222222';
const gameC = '33333333-3333-4333-8333-333333333333';

function activeState(): GameState {
  return startFreshGame({ aiOpponentCount: 1, random: () => 0.25 });
}

function completedState(total = 12): GameState {
  const state = activeState();
  return {
    ...state,
    phase: 'game-over',
    winnerId: 'human',
    players: state.players.map((player, index) => ({
      ...player,
      totalScore: total + index,
      roundScore: total + index
    })),
    roundHistory: [
      {
        round: 1,
        closerId: 'human',
        scores: state.players.map((player, index) => ({
          playerId: player.id,
          name: player.name,
          roundScore: total + index,
          totalScore: total + index
        }))
      }
    ]
  };
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(soloDatabaseName, soloDatabaseVersion);
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
  });
}

async function putRaw(storeName: string, value: unknown): Promise<void> {
  const database = await openRawDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
  database.close();
}

describe('solo IndexedDB durability', () => {
  it('creates the v1 stores with composite owner keys and restores only the active owner', async () => {
    const guestState = activeState();
    const accountState = { ...activeState(), round: 2 };
    expect(await saveSoloSession('guest', gameA, guestState, 1, () => 10)).toBeNull();
    expect(await saveSoloSession(soloOwnerKey('alice'), gameB, accountState, 1, () => 20)).toBeNull();

    expect((await loadSoloSession('guest')).session).toMatchObject({ ownerKey: 'guest', gameId: gameA, updatedAt: 10 });
    expect((await loadSoloSession(soloOwnerKey('alice'))).session).toMatchObject({
      ownerKey: 'account:alice',
      gameId: gameB,
      state: { round: 2 }
    });
    expect((await loadSoloSession(soloOwnerKey('bob'))).session).toBeNull();

    const database = await openRawDatabase();
    expect(database.version).toBe(1);
    expect([...database.objectStoreNames]).toEqual([soloSessionStoreName, statsOutboxStoreName]);
    const sessionTransaction = database.transaction(soloSessionStoreName);
    expect(sessionTransaction.objectStore(soloSessionStoreName).keyPath).toEqual(['ownerKey', 'gameId']);
    expect([...sessionTransaction.objectStore(soloSessionStoreName).indexNames]).toEqual(['byOwner', 'byOwnerUpdatedAt']);
    const outboxTransaction = database.transaction(statsOutboxStoreName);
    expect(outboxTransaction.objectStore(statsOutboxStoreName).keyPath).toEqual(['ownerKey', 'gameId']);
    expect([...outboxTransaction.objectStore(statsOutboxStoreName).indexNames]).toEqual([
      'byOwner',
      'byOwnerNextAttempt'
    ]);
    database.close();
  });

  it('quarantines only the newest corrupt or incompatible session and preserves an older valid record', async () => {
    const ownerKey = soloOwnerKey('alice');
    await saveSoloSession(ownerKey, gameA, activeState(), 1, () => 10);
    await putRaw(soloSessionStoreName, {
      ownerKey,
      gameId: gameB,
      schemaVersion: 99,
      state: { phase: 'choose-source' },
      aiOpponentCount: 1,
      updatedAt: 20
    });

    const recovered = await loadSoloSession(ownerKey);
    expect(recovered.session).toBeNull();
    expect(recovered.warning).toMatchObject({ kind: 'recovered' });
    const valid = await loadSoloSession(ownerKey);
    expect(valid.session?.gameId).toBe(gameA);
    expect(valid.warning).toBeNull();
  });

  it('warns on quota and private-mode failures without rejecting gameplay operations', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    const quota = await saveSoloSession('guest', gameA, activeState(), 1);
    expect(quota).toMatchObject({ kind: 'quota' });
    put.mockRestore();

    await resetSoloDatabaseForTests();
    const realIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: { open: () => { throw new DOMException('Private mode', 'SecurityError'); } }
    });
    const unavailable = await loadSoloSession('guest');
    expect(unavailable).toMatchObject({ session: null, warning: { kind: 'unavailable' } });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: realIndexedDb });
  });

  it('survives a database close/reopen that models a service-worker application update', async () => {
    await saveSoloSession('guest', gameA, activeState(), 1, () => 100);
    await enqueueCompletedGame('guest', gameB, completedState(), () => 101);
    await closeSoloDatabaseForTests();

    expect((await loadSoloSession('guest')).session?.gameId).toBe(gameA);
    expect((await listStatsOutbox('guest')).map((record) => record.gameId)).toEqual([gameB]);
  });
});

describe('solo stats outbox', () => {
  it('keeps equal-score games distinct by UUID and makes duplicate enqueue idempotent', async () => {
    const ownerKey = soloOwnerKey('alice');
    const equalScores = completedState(18);
    await enqueueCompletedGame(ownerKey, gameA, equalScores, () => 10);
    await enqueueCompletedGame(ownerKey, gameB, equalScores, () => 20);
    await flushStatsOutbox({
      ownerKey,
      now: () => 30,
      deliver: async () => {
        throw new Error('offline');
      }
    });
    await enqueueCompletedGame(ownerKey, gameA, equalScores, () => 40);

    const queued = await listStatsOutbox(ownerKey);
    expect(queued.map((record) => record.gameId)).toEqual([gameA, gameB]);
    expect(queued[0]).toMatchObject({ attempts: 1, createdAt: 10, lastError: 'offline' });
  });

  it('retries a bounded batch after offline failure and treats duplicate server success as delivered', async () => {
    const ownerKey = soloOwnerKey('alice');
    for (const gameId of [gameA, gameB, gameC, '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']) {
      await enqueueCompletedGame(ownerKey, gameId, completedState(), () => 10);
    }
    const offline = vi.fn(async () => {
      throw new TypeError('Network unavailable');
    });
    const first = await flushStatsOutbox({ ownerKey, deliver: offline, force: true, now: () => 20 });
    expect(first).toMatchObject({ attempted: 4, delivered: 0, pending: 5 });

    const serverGame = { id: 'same-server-game' };
    const online = vi.fn(async () => serverGame);
    const second = await flushStatsOutbox({ ownerKey, deliver: online, force: true, now: () => 30 });
    expect(second).toMatchObject({ attempted: 4, delivered: 4, pending: 1 });
    const third = await flushStatsOutbox({ ownerKey, deliver: online, force: true, now: () => 40 });
    expect(third).toMatchObject({ attempted: 1, delivered: 1, pending: 0 });
    expect(online).toHaveBeenCalledTimes(5);
  });

  it('never submits a guest record under a later account', async () => {
    await enqueueCompletedGame('guest', gameA, completedState());
    await enqueueCompletedGame(soloOwnerKey('alice'), gameB, completedState());
    const delivered: string[] = [];
    const result = await flushStatsOutbox({
      ownerKey: soloOwnerKey('alice'),
      force: true,
      deliver: async (record) => delivered.push(record.gameId)
    });
    expect(result.delivered).toBe(1);
    expect(delivered).toEqual([gameB]);
    expect((await listStatsOutbox('guest')).map((record) => record.gameId)).toEqual([gameA]);
  });

  it('is single-flight and fences an account switch while a delivery is in progress', async () => {
    const alice = soloOwnerKey('alice');
    const bob = soloOwnerKey('bob');
    await enqueueCompletedGame(alice, gameA, completedState());
    await enqueueCompletedGame(bob, gameB, completedState());
    let releaseAlice: (() => void) | undefined;
    const delivered: Array<{ ownerKey: string; gameId: string }> = [];
    const coordinator = createStatsOutboxCoordinator(
      (record, signal) =>
        new Promise<void>((resolve, reject) => {
          if (record.ownerKey === alice) {
            releaseAlice = resolve;
            signal.addEventListener('abort', () => reject(new DOMException('Owner changed', 'AbortError')), { once: true });
            return;
          }
          delivered.push({ ownerKey: record.ownerKey, gameId: record.gameId });
          resolve();
        })
    );

    coordinator.setOwner(alice);
    const first = coordinator.flush(true);
    const duplicateTrigger = coordinator.flush(true);
    expect(duplicateTrigger).toBe(first);
    await vi.waitFor(() => expect(releaseAlice).toBeTypeOf('function'));
    coordinator.setOwner(bob);
    const switched = coordinator.flush(true);
    releaseAlice?.();
    await switched;

    expect(delivered).toEqual([{ ownerKey: bob, gameId: gameB }]);
    expect((await listStatsOutbox(alice)).map((record) => record.gameId)).toEqual([gameA]);
    expect(await listStatsOutbox(bob)).toEqual([]);
    coordinator.dispose();
  });
});
