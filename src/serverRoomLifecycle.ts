import type { CommandReceipt } from './protocolV2.js';
import type { GameState, RoomChatMessage, RoomPlayer } from './types.js';

export const WAITING_HOST_TRANSFER_MS = 60_000;
export const ACTIVE_PLAYER_GRACE_MS = 120_000;

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

export function hostTransferDeadline(room: Pick<RoomLifecycleSource, 'hostId' | 'players' | 'status'>): number | null {
  const host = room.players.find((player) => player.id === room.hostId);
  const disconnectedAt = host ? playerDisconnectedAt(host) : null;
  if (disconnectedAt === null) return null;
  return disconnectedAt + (room.status === 'waiting' ? WAITING_HOST_TRANSFER_MS : ACTIVE_PLAYER_GRACE_MS);
}

export function aiTakeoverDeadline(
  room: Pick<RoomLifecycleSource, 'status'>,
  player: RoomPlayer
): number | null {
  const disconnectedAt = playerDisconnectedAt(player);
  if (room.status === 'waiting' || disconnectedAt === null || player.controller === 'ai') return null;
  return disconnectedAt + ACTIVE_PLAYER_GRACE_MS;
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
  now: number
): HostTransferPlan | null {
  const deadline = hostTransferDeadline(room);
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
  now: number
): boolean {
  const deadline = aiTakeoverDeadline(room, player);
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
