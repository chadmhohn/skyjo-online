import type { CommandReceipt } from './protocolV2.js';
import type { GameState, RoomChatMessage, RoomPlayer } from './types.js';

export const WAITING_HOST_TRANSFER_MS = 60_000;
export const ACTIVE_PLAYER_GRACE_MS = 120_000;
export const DEFAULT_ROOM_LIFECYCLE_POLICY = Object.freeze({
  activePlayerGraceMs: ACTIVE_PLAYER_GRACE_MS,
  waitingHostTransferMs: WAITING_HOST_TRANSFER_MS
});

export interface RoomLifecyclePolicy {
  activePlayerGraceMs: number;
  waitingHostTransferMs: number;
}

export interface RoomLifecycleResetAlias {
  commandId: string;
  expiresAt: number;
  fromCode: string;
  playerId: string;
}

export interface RoomLifecycleSource {
  chatMessages: RoomChatMessage[];
  hostId: string;
  players: RoomPlayer[];
  readyForNextRoundPlayerIds: string[];
  recentCommandIds: CommandReceipt[];
  resetAliases: RoomLifecycleResetAlias[];
  state: GameState | null;
  status: 'waiting' | 'playing' | 'finished';
}

export interface RemovedPlayerReferences {
  chatMessages: RoomChatMessage[];
  players: RoomPlayer[];
  readyForNextRoundPlayerIds: string[];
  recentCommandIds: CommandReceipt[];
  resetAliases: RoomLifecycleResetAlias[];
}

export interface HostTransferPlan {
  deadline: number;
  fromPlayerId: string;
  toPlayerId: string;
}

function timestamp(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

export function playerDisconnectedAt(
  player: Pick<RoomPlayer, 'connected' | 'disconnectedAt' | 'lastSeenAt'>
): number | null {
  return player.connected || !Number.isFinite(player.disconnectedAt) ? null : Number(player.disconnectedAt);
}

export function hostTransferDeadline(
  room: Pick<RoomLifecycleSource, 'hostId' | 'players' | 'status'>,
  policy: RoomLifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY
): number | null {
  const host = room.players.find((player) => player.id === room.hostId);
  const disconnectedAt = host ? playerDisconnectedAt(host) : null;
  if (disconnectedAt === null) return null;
  return disconnectedAt + (room.status === 'waiting' ? policy.waitingHostTransferMs : policy.activePlayerGraceMs);
}

export function aiTakeoverDeadline(
  room: Pick<RoomLifecycleSource, 'status'>,
  player: RoomPlayer,
  policy: RoomLifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY
): number | null {
  const disconnectedAt = playerDisconnectedAt(player);
  if (room.status === 'waiting' || disconnectedAt === null || player.controller === 'ai') return null;
  return disconnectedAt + policy.activePlayerGraceMs;
}

export function presenceFields(
  player: Pick<RoomPlayer, 'connected' | 'disconnectedAt' | 'lastSeenAt'>,
  connected: boolean,
  now: number
): Pick<RoomPlayer, 'connected' | 'disconnectedAt' | 'lastSeenAt'> {
  if (connected) {
    return { connected: true, disconnectedAt: null, lastSeenAt: now };
  }
  return {
    connected: false,
    disconnectedAt: player.connected
      ? now
      : playerDisconnectedAt(player) ?? now,
    lastSeenAt: player.lastSeenAt
  };
}

export function oldestConnectedHuman(
  players: readonly RoomPlayer[],
  excludedPlayerId?: string
): RoomPlayer | null {
  return [...players]
    .filter((player) => player.id !== excludedPlayerId && player.connected && player.controller !== 'ai')
    .sort((left, right) => {
      const joinedDifference = timestamp(left.joinedAt) - timestamp(right.joinedAt);
      return joinedDifference || left.id.localeCompare(right.id);
    })[0] ?? null;
}

export function dueHostTransfer(
  room: Pick<RoomLifecycleSource, 'hostId' | 'players' | 'status'>,
  now: number,
  policy: RoomLifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY
): HostTransferPlan | null {
  const deadline = hostTransferDeadline(room, policy);
  if (deadline === null || now < deadline) return null;
  const candidate = oldestConnectedHuman(room.players, room.hostId);
  return candidate
    ? { deadline, fromPlayerId: room.hostId, toPlayerId: candidate.id }
    : null;
}

export function hostFlags(players: readonly RoomPlayer[], hostId: string): RoomPlayer[] {
  return players.map((player) => ({ ...player, host: player.id === hostId }));
}

export function removePlayerReferences(
  room: Pick<
    RoomLifecycleSource,
    'chatMessages' | 'players' | 'readyForNextRoundPlayerIds' | 'recentCommandIds' | 'resetAliases'
  >,
  playerId: string
): RemovedPlayerReferences {
  const players = room.players.filter((player) => player.id !== playerId);
  const remainingIds = new Set(players.map((player) => player.id));
  return {
    players,
    chatMessages: room.chatMessages.filter((message) => message.playerId !== playerId),
    readyForNextRoundPlayerIds: room.readyForNextRoundPlayerIds.filter((id) => remainingIds.has(id)),
    recentCommandIds: room.recentCommandIds.filter((receipt) => remainingIds.has(receipt.playerId)),
    resetAliases: room.resetAliases.filter((alias) =>
      alias.playerId !== playerId && room.recentCommandIds.some(
        (receipt) => receipt.commandId === alias.commandId && remainingIds.has(receipt.playerId)
      )
    )
  };
}

export function connectedWaitingPlayerIds(
  room: Pick<RoomLifecycleSource, 'players' | 'status'>
): string[] {
  if (room.status !== 'waiting') return [];
  return room.players.filter((player) => player.connected && player.controller !== 'ai').map((player) => player.id);
}

export function canTakeOverWithAi(
  room: Pick<RoomLifecycleSource, 'status'>,
  player: RoomPlayer,
  now: number,
  policy: RoomLifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY
): boolean {
  const deadline = aiTakeoverDeadline(room, player, policy);
  return deadline !== null && now >= deadline;
}

export function shouldAutoReady(
  room: Pick<RoomLifecycleSource, 'readyForNextRoundPlayerIds' | 'state'>,
  player: RoomPlayer
): boolean {
  return player.controller === 'ai' &&
    (room.state?.phase === 'round-over' || room.state?.phase === 'game-over') &&
    !room.readyForNextRoundPlayerIds.includes(player.id);
}

export function shouldRunAiAction(
  room: Pick<RoomLifecycleSource, 'state' | 'status'>,
  player: RoomPlayer
): boolean {
  if (room.status !== 'playing' || player.controller !== 'ai' || !room.state) return false;
  return room.state.players[room.state.currentPlayerIndex]?.id === player.id &&
    room.state.phase !== 'round-over' && room.state.phase !== 'game-over';
}

export function reclaimAiSeat(
  room: Pick<RoomLifecycleSource, 'players' | 'readyForNextRoundPlayerIds'>,
  playerId: string
): { players: RoomPlayer[]; readyForNextRoundPlayerIds: string[] } | null {
  const target = room.players.find((player) => player.id === playerId);
  if (!target || target.controller !== 'ai' || !target.connected) return null;
  return {
    players: room.players.map((player) => player.id === playerId ? { ...player, controller: 'human' } : player),
    readyForNextRoundPlayerIds: room.readyForNextRoundPlayerIds.filter((id) => id !== playerId)
  };
}

export interface RuntimeLifecycleRoom extends RoomLifecycleSource {
  code: string;
  revision: number;
}

export interface HostTransferFence extends HostTransferPlan {
  expectedRevision: number;
  roomCode: string;
}

export interface ScheduledAiActionFence {
  commandId: string;
  controller: 'ai';
  dueAt: number;
  expectedRevision: number;
  playerId: string;
  roomCode: string;
}

export interface RoomLifecycleSchedulerOptions {
  aiActionDelayMs?: number;
  cancelInterval?: (handle: unknown) => void;
  executeAiAction: (fence: ScheduledAiActionFence) => boolean;
  lifecyclePolicy?: RoomLifecyclePolicy;
  now: () => number;
  randomUuid: () => string;
  rooms: () => Iterable<RuntimeLifecycleRoom>;
  scheduleInterval?: (callback: () => void, intervalMs: number) => unknown;
  tickIntervalMs?: number;
  transferHost: (fence: HostTransferFence) => boolean;
}

export interface RoomLifecycleScheduler {
  dispose(): void;
  runNow(): void;
}

export function createRoomLifecycleScheduler(options: RoomLifecycleSchedulerOptions): RoomLifecycleScheduler {
  const policy = options.lifecyclePolicy ?? DEFAULT_ROOM_LIFECYCLE_POLICY;
  const aiActionDelayMs = options.aiActionDelayMs ?? 650;
  const tickIntervalMs = options.tickIntervalMs ?? 250;
  if (!Number.isFinite(aiActionDelayMs) || aiActionDelayMs < 0) {
    throw new TypeError('aiActionDelayMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    throw new TypeError('tickIntervalMs must be a positive finite number.');
  }
  const scheduleInterval = options.scheduleInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const cancelInterval = options.cancelInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const scheduledAiActions = new Map<string, ScheduledAiActionFence>();

  function runNow(): void {
    const now = options.now();
    const activeKeys = new Set<string>();
    for (const room of options.rooms()) {
      const transfer = dueHostTransfer(room, now, policy);
      if (transfer && options.transferHost({
        ...transfer,
        expectedRevision: room.revision,
        roomCode: room.code
      })) {
        for (const key of scheduledAiActions.keys()) {
          if (key.startsWith(`${room.code}:`)) scheduledAiActions.delete(key);
        }
        continue;
      }

      for (const player of room.players) {
        if (!shouldAutoReady(room, player) && !shouldRunAiAction(room, player)) continue;
        const key = `${room.code}:${player.id}`;
        activeKeys.add(key);
        const scheduled = scheduledAiActions.get(key);
        if (
          scheduled &&
          scheduled.expectedRevision === room.revision &&
          scheduled.controller === player.controller
        ) {
          if (now >= scheduled.dueAt) {
            scheduledAiActions.delete(key);
            options.executeAiAction(scheduled);
          }
          continue;
        }
        scheduledAiActions.set(key, {
          commandId: options.randomUuid(),
          controller: 'ai',
          dueAt: now + aiActionDelayMs,
          expectedRevision: room.revision,
          playerId: player.id,
          roomCode: room.code
        });
      }
    }
    for (const key of scheduledAiActions.keys()) {
      if (!activeKeys.has(key)) scheduledAiActions.delete(key);
    }
  }

  const interval = scheduleInterval(runNow, tickIntervalMs);
  if (interval && typeof interval === 'object' && 'unref' in interval) {
    const unref = (interval as { unref?: () => unknown }).unref;
    unref?.call(interval);
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduledAiActions.clear();
      cancelInterval(interval);
    },
    runNow
  };
}
