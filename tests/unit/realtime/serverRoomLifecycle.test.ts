import {
  ACTIVE_PLAYER_GRACE_MS,
  aiTakeoverDeadline,
  canTakeOverWithAi,
  connectedWaitingPlayerIds,
  createRoomLifecycleScheduler,
  dueHostTransfer,
  hostFlags,
  hostTransferDeadline,
  oldestConnectedHuman,
  playerDisconnectedAt,
  presenceFields,
  reclaimAiSeat,
  removePlayerReferences,
  shouldAutoReady,
  shouldRunAiAction,
  WAITING_HOST_TRANSFER_MS
} from '../../../src/serverRoomLifecycle';
import { createMultiplayerGame } from '../../../src/game';
import type { RoomPlayer } from '../../../src/types';

function player(id: string, overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    id,
    name: id,
    connected: true,
    host: id === 'host',
    controller: 'human',
    joinedAt: 100,
    lastSeenAt: 100,
    disconnectedAt: null,
    ...overrides
  };
}

function room(status: 'waiting' | 'playing' | 'finished' = 'waiting') {
  const players = [player('host'), player('guest', { joinedAt: 200 })];
  return {
    hostId: 'host',
    players,
    chatMessages: [{ id: 'chat', playerId: 'guest', playerName: 'guest', text: 'hi', createdAt: 100 }],
    readyForNextRoundPlayerIds: ['guest'],
    recentCommandIds: [{
      commandId: '10000000-0000-4000-8000-000000000001',
      playerId: 'guest',
      expectedRevision: 0,
      revision: 1,
      actionDigest: 'a'.repeat(64)
    }],
    resetAliases: [{
      fromCode: 'OLD01',
      commandId: '10000000-0000-4000-8000-000000000001',
      playerId: 'guest',
      expiresAt: 1_000
    }],
    state: status === 'waiting' ? null : createMultiplayerGame(players, 1, null, () => 0.5),
    status
  };
}

describe('server room lifecycle', () => {
  it('anchors presence only on the connected to disconnected edge', () => {
    const online = player('p');
    expect(presenceFields(online, false, 500)).toEqual({ connected: false, disconnectedAt: 500, lastSeenAt: 100 });
    const offline = { ...online, connected: false, disconnectedAt: 500 };
    expect(presenceFields(offline, false, 900).disconnectedAt).toBe(500);
    expect(presenceFields(offline, true, 900)).toEqual({ connected: true, disconnectedAt: null, lastSeenAt: 900 });
    expect(playerDisconnectedAt({ ...offline, disconnectedAt: undefined })).toBeNull();
  });

  it('plans deterministic waiting and active host transfers at exact deadlines', () => {
    const value = room();
    value.players[0] = player('host', { connected: false, disconnectedAt: 1_000 });
    value.players.push(player('alpha', { joinedAt: 200 }));
    value.players[1] = player('zeta', { joinedAt: 200 });
    expect(hostTransferDeadline(value)).toBe(1_000 + WAITING_HOST_TRANSFER_MS);
    expect(dueHostTransfer(value, 1_000 + WAITING_HOST_TRANSFER_MS - 1)).toBeNull();
    expect(dueHostTransfer(value, 1_000 + WAITING_HOST_TRANSFER_MS)).toMatchObject({ toPlayerId: 'alpha' });
    value.status = 'playing';
    expect(hostTransferDeadline(value)).toBe(1_000 + ACTIVE_PLAYER_GRACE_MS);
    expect(oldestConnectedHuman(value.players, 'host')?.id).toBe('alpha');
    expect(hostFlags(value.players, 'alpha').filter((candidate) => candidate.host).map((candidate) => candidate.id)).toEqual(['alpha']);
  });

  it('purges every reference owned by a removed waiting seat', () => {
    const next = removePlayerReferences(room(), 'guest');
    expect(next.players.map((candidate) => candidate.id)).toEqual(['host']);
    expect(next.chatMessages).toEqual([]);
    expect(next.readyForNextRoundPlayerIds).toEqual([]);
    expect(next.recentCommandIds).toEqual([]);
    expect(next.resetAliases).toEqual([]);
  });

  it('uses only connected human waiting seats and enforces the active grace boundary', () => {
    const waiting = room();
    waiting.players[1] = player('guest', { connected: false, disconnectedAt: 500 });
    waiting.players.push(player('ai', { controller: 'ai' }));
    expect(connectedWaitingPlayerIds(waiting)).toEqual(['host']);
    expect(aiTakeoverDeadline(waiting, waiting.players[1])).toBeNull();

    const active = { ...waiting, status: 'playing' as const };
    expect(aiTakeoverDeadline(active, active.players[1])).toBe(500 + ACTIVE_PLAYER_GRACE_MS);
    expect(canTakeOverWithAi(active, active.players[1], 500 + ACTIVE_PLAYER_GRACE_MS - 1)).toBe(false);
    expect(canTakeOverWithAi(active, active.players[1], 500 + ACTIVE_PLAYER_GRACE_MS)).toBe(true);
  });

  it('identifies AI readiness and current-turn work without changing game player kinds', () => {
    const value = room('playing');
    const aiSeat = value.players[0];
    aiSeat.controller = 'ai';
    expect(value.state?.players.every((gamePlayer) => gamePlayer.kind === 'human')).toBe(true);
    expect(shouldRunAiAction(value, aiSeat)).toBe(true);
    if (value.state) value.state.phase = 'round-over';
    expect(shouldRunAiAction(value, aiSeat)).toBe(false);
    expect(shouldAutoReady(value, aiSeat)).toBe(true);
    value.readyForNextRoundPlayerIds.push(aiSeat.id);
    expect(shouldAutoReady(value, aiSeat)).toBe(false);
    const reclaimed = reclaimAiSeat(value, aiSeat.id);
    expect(reclaimed?.players.find((candidate) => candidate.id === aiSeat.id)).toMatchObject({ controller: 'human' });
    expect(reclaimed?.readyForNextRoundPlayerIds).toEqual(['guest']);
    expect(reclaimAiSeat(value, 'guest')).toBeNull();
  });

  it('runs host transfers and revision-fenced AI work from an injectable clock', () => {
    let now = 1_000;
    const value = { ...room('playing'), code: 'ROOM1', revision: 4 };
    value.players[0] = player('host', { connected: false, disconnectedAt: now });
    const transfers: unknown[] = [];
    const aiActions: unknown[] = [];
    let intervalCallback: (() => void) | null = null;
    const interval = { unref: vi.fn() };
    const cancelInterval = vi.fn();
    const scheduler = createRoomLifecycleScheduler({
      aiActionDelayMs: 650,
      cancelInterval,
      executeAiAction: (fence) => {
        aiActions.push(fence);
        return true;
      },
      now: () => now,
      randomUuid: () => '10000000-0000-4000-8000-000000000099',
      rooms: () => [value],
      scheduleInterval: (callback, delay) => {
        expect(delay).toBe(250);
        intervalCallback = callback;
        return interval;
      },
      transferHost: (fence) => {
        transfers.push(fence);
        value.hostId = fence.toPlayerId;
        value.players = hostFlags(value.players, fence.toPlayerId);
        value.revision += 1;
        return true;
      }
    });
    expect(interval.unref).toHaveBeenCalledOnce();
    now += ACTIVE_PLAYER_GRACE_MS - 1;
    scheduler.runNow();
    expect(transfers).toEqual([]);
    now += 1;
    expect(intervalCallback).not.toBeNull();
    (intervalCallback as unknown as () => void)();
    expect(transfers).toEqual([expect.objectContaining({
      expectedRevision: 4,
      fromPlayerId: 'host',
      roomCode: 'ROOM1',
      toPlayerId: 'guest'
    })]);

    const aiSeat = value.players.find((candidate) => candidate.id === 'host')!;
    aiSeat.controller = 'ai';
    scheduler.runNow();
    now += 649;
    scheduler.runNow();
    expect(aiActions).toEqual([]);
    now += 1;
    scheduler.runNow();
    expect(aiActions).toEqual([expect.objectContaining({
      controller: 'ai',
      expectedRevision: 5,
      playerId: 'host',
      roomCode: 'ROOM1'
    })]);
    scheduler.dispose();
    scheduler.dispose();
    expect(cancelInterval).toHaveBeenCalledOnce();
  });

  it('rejects invalid scheduler timing configuration', () => {
    const base = {
      executeAiAction: () => false,
      now: () => 0,
      randomUuid: () => 'id',
      rooms: () => [],
      transferHost: () => false
    };
    expect(() => createRoomLifecycleScheduler({ ...base, aiActionDelayMs: -1 })).toThrow(/aiActionDelayMs/i);
    expect(() => createRoomLifecycleScheduler({ ...base, tickIntervalMs: 0 })).toThrow(/tickIntervalMs/i);
  });
});
