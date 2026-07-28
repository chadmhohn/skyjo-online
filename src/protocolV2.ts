import {
  cancelDiscardSelection,
  chooseDiscard,
  discardDrawnAndReveal,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from './game.js';
import {
  aiTakeoverDeadline,
  DEFAULT_ROOM_LIFECYCLE_POLICY,
  hostTransferDeadline,
  type RoomLifecyclePolicy
} from './serverRoomLifecycle.js';
import type { RandomSource } from './runtime.js';
import type {
  Card,
  GameState,
  MultiplayerRoom,
  Player,
  RoomChatMessage,
  RoomPlayer,
  RoundHistoryEntry,
  TurnPhase
} from './types';
import {
  isWellFormedUnicode,
  wellFormedUTF16Prefix
} from '../server-unicode.mjs';

export const MULTIPLAYER_PROTOCOL_VERSION = 2 as const;
export const EXPLICIT_PRESENCE_VERSION = 1 as const;
export const SHARED_SNAPSHOT_ENVELOPE_VERSION = 2 as const;
// This is a client-to-server command-frame limit, not a server snapshot limit.
export const MAX_INBOUND_CLIENT_FRAME_BYTES = 16_384;
export const MAX_RECENT_COMMAND_RECEIPTS = 128;
export const PUBLIC_SNAPSHOT_LIMITS = Object.freeze({
  cards: 150,
  chatMessageLength: 280,
  chatMessages: 80,
  historyEntries: 100,
  identifierLength: 128,
  logEntries: 8,
  logEntryLength: 320,
  nameLength: 24,
  players: 8,
  roomCodeLength: 5
});

export type GameCommand =
  | { type: 'reveal-opening-card'; cardIndex: number }
  | { type: 'choose-discard' }
  | { type: 'cancel-discard' }
  | { type: 'draw-blind' }
  | { type: 'replace-card'; cardIndex: number }
  | { type: 'discard-and-reveal'; cardIndex: number }
  | { type: 'set-next-round-ready'; ready: boolean }
  | { type: 'start-game' }
  | { type: 'reset-room' }
  | { type: 'leave-room' }
  | { type: 'remove-player'; playerId: string }
  | { type: 'takeover-player-with-ai'; playerId: string }
  | { type: 'send-chat-message'; text: string };

export interface ClientCommand {
  type: 'command';
  protocolVersion: typeof MULTIPLAYER_PROTOCOL_VERSION;
  commandId: string;
  expectedRevision: number;
  action: GameCommand;
}

export interface CommandReceipt {
  commandId: string;
  playerId: string;
  expectedRevision: number;
  revision: number;
  actionDigest: string;
}

export interface PublicCardSnapshot {
  id: string;
  value: number | null;
  faceUp: boolean;
  removed: boolean;
}

export interface PublicPlayerSnapshot extends Omit<Player, 'grid'> {
  grid: PublicCardSnapshot[];
}

export interface PublicGameStateSnapshot {
  players: PublicPlayerSnapshot[];
  drawPileCount: number;
  discardPile: {
    count: number;
    top: PublicCardSnapshot | null;
  };
  currentPlayerIndex: number;
  phase: TurnPhase;
  selectedSource: 'draw' | 'discard' | null;
  hasDrawnCard: boolean;
  drawnCard: PublicCardSnapshot | null;
  round: number;
  log: string[];
  winnerId: string | null;
  nextStarterId: string | null;
  roundCloserId: string | null;
  finalTurnPlayerIds: string[];
  openingRevealCounts: Record<string, number>;
  roundHistory: RoundHistoryEntry[];
}

export interface PublicRoomPlayerSnapshot extends Omit<RoomPlayer, 'userId' | 'disconnectedAt'> {
  joinedAt?: number;
  lastSeenAt?: number;
  controller: 'human' | 'ai';
  disconnectedAt: number | null;
  aiTakeoverAt: number | null;
}

export interface PublicRoomSnapshot {
  code: string;
  hostId: string;
  players: PublicRoomPlayerSnapshot[];
  chatMessages: RoomChatMessage[];
  readyForNextRoundPlayerIds: string[];
  state: PublicGameStateSnapshot | null;
  status: 'waiting' | 'playing' | 'finished';
  updatedAt: number;
  completedGameId: string | null;
  finishedByAi: boolean;
  hostTransferAt: number | null;
  revision: number;
  serverNow: number;
}

export interface SnapshotFrame {
  type: 'snapshot';
  protocolVersion: typeof MULTIPLAYER_PROTOCOL_VERSION;
  playerId: string;
  revision: number;
  room: PublicRoomSnapshot;
}

export interface ResyncFrame extends Omit<SnapshotFrame, 'type'> {
  type: 'resync';
  commandId?: string;
  reason: string;
}

export type ParsedCommandResult =
  | { ok: true; command: ClientCommand; canonicalAction: string }
  | { ok: false; kind: 'invalid' | 'upgrade-required'; message: string; commandId?: string };

export type GameCommandReduction =
  | { ok: true; state: GameState }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export { isWellFormedUnicode };

function isCardIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 12;
}

function parseAction(value: unknown): GameCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'reveal-opening-card':
    case 'replace-card':
    case 'discard-and-reveal':
      return hasExactKeys(value, ['type', 'cardIndex']) && isCardIndex(value.cardIndex)
        ? { type: value.type, cardIndex: value.cardIndex }
        : null;
    case 'choose-discard':
    case 'cancel-discard':
    case 'draw-blind':
    case 'start-game':
    case 'reset-room':
    case 'leave-room':
      return hasExactKeys(value, ['type']) ? { type: value.type } : null;
    case 'remove-player':
    case 'takeover-player-with-ai':
      return hasExactKeys(value, ['type', 'playerId']) &&
        typeof value.playerId === 'string' &&
        isWellFormedUnicode(value.playerId) &&
        value.playerId.length > 0 &&
        value.playerId.length <= PUBLIC_SNAPSHOT_LIMITS.identifierLength
        ? { type: value.type, playerId: value.playerId }
        : null;
    case 'set-next-round-ready':
      return hasExactKeys(value, ['type', 'ready']) && typeof value.ready === 'boolean'
        ? { type: value.type, ready: value.ready }
        : null;
    case 'send-chat-message':
      return hasExactKeys(value, ['type', 'text']) &&
        typeof value.text === 'string' &&
        isWellFormedUnicode(value.text) &&
        value.text.length <= PUBLIC_SNAPSHOT_LIMITS.chatMessageLength
        ? { type: value.type, text: value.text }
        : null;
    default:
      return null;
  }
}

const commandIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function parseClientCommand(value: unknown): ParsedCommandResult {
  if (!isRecord(value)) return { ok: false, kind: 'invalid', message: 'Invalid command envelope.' };
  const commandId = typeof value.commandId === 'string' && commandIdPattern.test(value.commandId)
    ? value.commandId
    : undefined;
  if (value.type !== 'command' || value.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
    if (value.type === 'command' || value.type === 'update-state') {
      return {
        ok: false,
        kind: 'upgrade-required',
        message: 'This client must upgrade to multiplayer protocol 2.',
        ...(commandId ? { commandId } : {})
      };
    }
    return { ok: false, kind: 'invalid', message: 'Invalid command envelope.', ...(commandId ? { commandId } : {}) };
  }
  if (!hasExactKeys(value, ['type', 'protocolVersion', 'commandId', 'expectedRevision', 'action'])) {
    return { ok: false, kind: 'invalid', message: 'Invalid command envelope.', ...(commandId ? { commandId } : {}) };
  }
  if (!commandId || !commandIdPattern.test(commandId)) {
    return { ok: false, kind: 'invalid', message: 'Invalid command id.' };
  }
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    return { ok: false, kind: 'invalid', message: 'Invalid expected revision.', commandId };
  }
  const action = parseAction(value.action);
  if (!action) return { ok: false, kind: 'invalid', message: 'Invalid command action.', commandId };
  return {
    ok: true,
    command: {
      type: 'command',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      commandId,
      expectedRevision: Number(value.expectedRevision),
      action
    },
    canonicalAction: JSON.stringify(action)
  };
}

export function reduceAuthoritativeGameCommand(
  state: GameState | null,
  playerId: string,
  action: GameCommand,
  random: RandomSource
): GameCommandReduction {
  if (!state) return { ok: false, message: 'No active game.' };
  const activePlayer = state.players[state.currentPlayerIndex];
  if (!activePlayer) return { ok: false, message: 'Current game state is invalid.' };
  if (activePlayer.id !== playerId) return { ok: false, message: 'It is not your turn.' };

  let nextState: GameState;
  switch (action.type) {
    case 'reveal-opening-card': {
      const card = activePlayer.grid[action.cardIndex];
      if (state.phase !== 'opening-reveal' || !card || card.faceUp || card.removed) {
        return { ok: false, message: 'That opening reveal is not legal.' };
      }
      nextState = revealOpeningCard(state, action.cardIndex);
      break;
    }
    case 'choose-discard':
      if (state.phase !== 'choose-source' || state.discardPile.length === 0) {
        return { ok: false, message: 'The discard pile is not available.' };
      }
      nextState = chooseDiscard(state);
      break;
    case 'cancel-discard':
      if (state.phase !== 'choose-replacement' || state.selectedSource !== 'discard') {
        return { ok: false, message: 'There is no discard selection to cancel.' };
      }
      nextState = cancelDiscardSelection(state);
      break;
    case 'draw-blind':
      if (state.phase !== 'choose-source' || (state.drawPile.length === 0 && state.discardPile.length <= 1)) {
        return { ok: false, message: 'The draw pile is not available.' };
      }
      nextState = drawBlind(state, random);
      break;
    case 'replace-card': {
      const card = activePlayer.grid[action.cardIndex];
      const selectedCardAvailable = state.selectedSource === 'discard'
        ? state.discardPile.length > 0
        : state.selectedSource === 'draw' && Boolean(state.drawnCard);
      if (state.phase !== 'choose-replacement' || !selectedCardAvailable || !card || card.removed) {
        return { ok: false, message: 'That replacement is not legal.' };
      }
      nextState = replaceCard(state, action.cardIndex);
      break;
    }
    case 'discard-and-reveal': {
      const card = activePlayer.grid[action.cardIndex];
      if (
        state.phase !== 'choose-replacement' ||
        state.selectedSource !== 'draw' ||
        !state.drawnCard ||
        !card ||
        card.faceUp ||
        card.removed
      ) {
        return { ok: false, message: 'That discard and reveal is not legal.' };
      }
      nextState = discardDrawnAndReveal(state, action.cardIndex);
      break;
    }
    default:
      return { ok: false, message: 'That command does not mutate game state.' };
  }

  if (nextState === state) return { ok: false, message: 'That move is not legal.' };
  return { ok: true, state: nextState };
}

function publicCard(card: Card, id: string, reveal: boolean): PublicCardSnapshot {
  return {
    id,
    value: reveal && card.faceUp ? card.value : null,
    faceUp: card.faceUp,
    removed: card.removed
  };
}

function publicName(value: string): string {
  return wellFormedUTF16Prefix(value, PUBLIC_SNAPSHOT_LIMITS.nameLength);
}

export function redactGameState(state: GameState, viewerPlayerId: string): PublicGameStateSnapshot {
  const viewerMaySeeDrawnCard = hasPrivateDrawnCardVisibility(state, viewerPlayerId);
  const log = state.log
    .slice(0, PUBLIC_SNAPSHOT_LIMITS.logEntries)
    .map((entry) => entry.replace(/^(.+) drew a -?\d+\.$/, '$1 drew a blind card.'))
    .map((entry) => wellFormedUTF16Prefix(entry, PUBLIC_SNAPSHOT_LIMITS.logEntryLength));
  const discardTop = state.discardPile[0];

  return {
    players: state.players.map((player, playerIndex) => ({
      id: player.id,
      kind: player.kind,
      name: publicName(player.name),
      grid: player.grid.map((card, cardIndex) =>
        publicCard(card, `grid-${playerIndex}-${cardIndex}`, card.faceUp || card.removed)
      ),
      totalScore: player.totalScore,
      roundScore: player.roundScore
    })),
    drawPileCount: state.drawPile.length,
    discardPile: {
      count: state.discardPile.length,
      top: discardTop ? publicCard(discardTop, 'discard-top', true) : null
    },
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    selectedSource: state.selectedSource,
    hasDrawnCard: Boolean(state.drawnCard),
    drawnCard: viewerMaySeeDrawnCard && state.drawnCard ? publicCard(state.drawnCard, 'drawn-card', true) : null,
    round: state.round,
    log,
    winnerId: state.winnerId,
    nextStarterId: state.nextStarterId,
    roundCloserId: state.roundCloserId,
    finalTurnPlayerIds: [...state.finalTurnPlayerIds],
    openingRevealCounts: { ...state.openingRevealCounts },
    roundHistory: state.roundHistory.slice(-PUBLIC_SNAPSHOT_LIMITS.historyEntries).map((entry) => ({
      round: entry.round,
      closerId: entry.closerId,
      scores: entry.scores.map((score) => ({
        playerId: score.playerId,
        name: publicName(score.name),
        roundScore: score.roundScore,
        totalScore: score.totalScore
      }))
    }))
  };
}

export type GameStateSnapshotProjector = (
  state: GameState,
  viewerPlayerId: string
) => PublicGameStateSnapshot;

/**
 * Cache projections of immutable server game-state objects without changing
 * the detached contract of redactGameState(). Authoritative reducers replace GameState
 * objects, and the projector is retained only by the server's write-only wire
 * path. A WeakMap entry therefore expires with its source state and never
 * relies on room revisions or mutable room metadata for invalidation.
 */
export function createGameStateSnapshotProjector(): GameStateSnapshotProjector {
  const projections = new WeakMap<GameState, Map<string, PublicGameStateSnapshot>>();
  return (state, viewerPlayerId) => {
    const visibility = hasPrivateDrawnCardVisibility(state, viewerPlayerId)
      ? `private:${viewerPlayerId}`
      : 'public';
    let byVisibility = projections.get(state);
    if (!byVisibility) {
      byVisibility = new Map();
      projections.set(state, byVisibility);
    }
    const cached = byVisibility.get(visibility);
    if (cached) return cached;
    const projected = redactGameState(state, viewerPlayerId);
    byVisibility.set(visibility, projected);
    return projected;
  };
}

export function hasPrivateDrawnCardVisibility(state: GameState | null, viewerPlayerId: string): boolean {
  const activePlayer = state?.players[state.currentPlayerIndex];
  return Boolean(state?.selectedSource === 'draw' && state.drawnCard && activePlayer?.id === viewerPlayerId);
}

interface SnapshotRoomSource extends Omit<
  PublicRoomSnapshot,
  'finishedByAi' | 'hostTransferAt' | 'players' | 'serverNow' | 'state'
> {
  finishedByAi?: boolean;
  players: RoomPlayer[];
  state: GameState | null;
}

export function createRoomSnapshot(
  room: SnapshotRoomSource,
  viewerPlayerId: string,
  serverNow = room.updatedAt,
  lifecyclePolicy: RoomLifecyclePolicy = DEFAULT_ROOM_LIFECYCLE_POLICY,
  projectGameState: GameStateSnapshotProjector = redactGameState
): PublicRoomSnapshot {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((player) => ({
      id: player.id,
      name: publicName(player.name),
      connected: player.connected,
      host: player.host,
      ...(Number.isFinite(player.joinedAt) ? { joinedAt: player.joinedAt } : {}),
      ...(Number.isFinite(player.lastSeenAt) ? { lastSeenAt: player.lastSeenAt } : {}),
      controller: player.controller || 'human',
      disconnectedAt: player.connected || !Number.isFinite(player.disconnectedAt)
        ? null
        : Number(player.disconnectedAt),
      aiTakeoverAt: aiTakeoverDeadline(room, player, lifecyclePolicy)
    })),
    chatMessages: room.chatMessages.slice(-PUBLIC_SNAPSHOT_LIMITS.chatMessages).map((message) => ({
      id: message.id,
      playerId: message.playerId,
      playerName: publicName(message.playerName),
      text: wellFormedUTF16Prefix(message.text, PUBLIC_SNAPSHOT_LIMITS.chatMessageLength),
      createdAt: message.createdAt
    })),
    readyForNextRoundPlayerIds: [...room.readyForNextRoundPlayerIds],
    state: room.state ? projectGameState(room.state, viewerPlayerId) : null,
    status: room.status,
    updatedAt: room.updatedAt,
    completedGameId: room.completedGameId,
    finishedByAi: room.finishedByAi === true,
    hostTransferAt: hostTransferDeadline(room, lifecyclePolicy),
    revision: room.revision,
    serverNow
  };
}

/**
 * Convert a redacted wire snapshot to the established render shape. Placeholder
 * cards preserve only deck count; no hidden value or server card id is invented.
 */
export function multiplayerRoomForRender(snapshot: PublicRoomSnapshot): MultiplayerRoom {
  const state = snapshot.state
    ? ({
        ...snapshot.state,
        players: snapshot.state.players as unknown as Player[],
        drawPile: Array.from({ length: snapshot.state.drawPileCount }, (_, index) => ({
          id: `draw-count-${index}`,
          value: null,
          faceUp: false,
          removed: false
        })) as unknown as Card[],
        discardPile: snapshot.state.discardPile.top
          ? ([
              snapshot.state.discardPile.top,
              ...Array.from(
                { length: Math.max(0, snapshot.state.discardPile.count - 1) },
                (_, index) => ({
                  id: `discard-count-${index}`,
                  value: null,
                  faceUp: false,
                  removed: false
                })
              )
            ] as unknown as Card[])
          : [],
        drawnCard: (snapshot.state.drawnCard || (snapshot.state.hasDrawnCard
          ? { id: 'drawn-card-hidden', value: null, faceUp: false, removed: false }
          : null)) as unknown as Card | null
      } as GameState)
    : null;
  return {
    ...snapshot,
    state
  };
}
