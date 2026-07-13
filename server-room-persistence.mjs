import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  PersistedGameStateValidationError,
  normalizePersistedGameState
} from './server-game-state-validation.mjs';

export const DEFAULT_ROOMS_FILE = path.join('.data', 'rooms.json');
export const ROOM_STALE_MS = 1000 * 60 * 60 * 6;
export const ROOMS_FILE_FORMAT = 'skyjo-rooms';
export const ROOMS_FILE_VERSION = 2;
export const ROOMS_PROTOCOL_VERSION = 1;
export const SUPPORTED_ROOMS_PROTOCOL_VERSIONS = Object.freeze([1]);
export const MAX_PERSISTED_RESET_ALIASES = 8;
export const MAX_PERSISTED_COMMAND_RECEIPTS = 128;
export const MAX_PERSISTED_IDENTIFIER_LENGTH = 128;

const validStatuses = new Set(['waiting', 'playing', 'finished']);
const maxPersistedChatMessages = 80;
const maxPersistedChatMessageLength = 280;
const maxPersistedRooms = 10_000;
const commandIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const roomInstanceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const resetRoomActionDigest = createHash('sha256').update(JSON.stringify({ type: 'reset-room' })).digest('hex');
const unsupportedWindowsDirectorySyncCodes = new Set(['EINVAL', 'ENOTSUP', 'EPERM']);

export class RoomPersistenceFormatError extends Error {
  constructor(message, code = 'INVALID_ROOMS_FILE', options = undefined) {
    super(message, options);
    this.name = 'RoomPersistenceFormatError';
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function boundedIdentifier(value, label) {
  const normalized = stringValue(value).trim();
  if (!normalized || normalized.length > MAX_PERSISTED_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw formatError(`${label} is invalid.`);
  }
  return normalized;
}

function optionalBoundedIdentifier(value, label) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return boundedIdentifier(value, label);
}

function retainCommandReceiptsForResetAliases(receipts, aliases) {
  const pinnedCommandIds = new Set(aliases.map((alias) => stringValue(alias?.commandId)));
  const maximumUnpinnedReceipts = Math.max(0, MAX_PERSISTED_COMMAND_RECEIPTS - pinnedCommandIds.size);
  const retained = [];
  let unpinnedCount = 0;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    const pinned = pinnedCommandIds.has(stringValue(receipt?.commandId));
    if (!pinned && unpinnedCount >= maximumUnpinnedReceipts) continue;
    retained.push(receipt);
    if (!pinned) unpinnedCount += 1;
  }
  return retained.reverse();
}

function formatError(message, code = 'INVALID_ROOMS_FILE', options = undefined) {
  return new RoomPersistenceFormatError(message, code, options);
}

function optionalTimestamp(value, fieldName) {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw formatError(`${fieldName} must be a non-negative finite timestamp.`);
  }
  return value;
}

function normalizePlayer(value, roomIndex, fallbackTimestamp, restoredAt = fallbackTimestamp) {
  if (!isRecord(value)) {
    throw formatError(`Room ${roomIndex} contains an invalid player.`);
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim() === '')) {
    throw formatError(`Room ${roomIndex} contains an invalid player name.`);
  }
  if (value.connected !== undefined && typeof value.connected !== 'boolean') {
    throw formatError(`Room ${roomIndex} contains an invalid player connection state.`);
  }
  if (value.host !== undefined && typeof value.host !== 'boolean') {
    throw formatError(`Room ${roomIndex} contains an invalid player host state.`);
  }
  const id = boundedIdentifier(value.id, `Room ${roomIndex} player id`);
  const name = stringValue(value.name, 'Player').trim().slice(0, 24) || 'Player';
  if (value.userId !== undefined && typeof value.userId !== 'string') {
    throw formatError(`Room ${roomIndex} contains an invalid player user id.`);
  }
  const userId = value.userId === undefined || value.userId.trim() === ''
    ? undefined
    : boundedIdentifier(value.userId, `Room ${roomIndex} player user id`);
  const joinedAt = value.joinedAt === undefined ? fallbackTimestamp : optionalTimestamp(value.joinedAt, `Room ${roomIndex} player joinedAt`);
  const lastSeenAt = value.lastSeenAt === undefined ? fallbackTimestamp : optionalTimestamp(value.lastSeenAt, `Room ${roomIndex} player lastSeenAt`);
  if (value.disconnectedAt !== undefined && value.disconnectedAt !== null &&
      (!Number.isFinite(value.disconnectedAt) || value.disconnectedAt < 0)) {
    throw formatError(`Room ${roomIndex} contains an invalid player disconnectedAt.`);
  }
  if (value.controller !== undefined && value.controller !== 'human' && value.controller !== 'ai') {
    throw formatError(`Room ${roomIndex} contains an invalid player controller.`);
  }
  return {
    id,
    userId,
    name,
    connected: false,
    host: value.host === true,
    joinedAt,
    lastSeenAt,
    disconnectedAt: value.connected === true
      ? restoredAt
      : value.disconnectedAt ?? restoredAt,
    controller: value.controller || 'human'
  };
}

function normalizeCommandReceipt(value, roomIndex, playerIds, roomRevision) {
  if (!isRecord(value)) throw formatError(`Room ${roomIndex} contains an invalid command receipt.`);
  const keys = Object.keys(value).sort();
  const expectedKeys = ['actionDigest', 'commandId', 'expectedRevision', 'playerId', 'revision'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw formatError(`Room ${roomIndex} contains an invalid command receipt.`);
  }
  const commandId = stringValue(value.commandId);
  const playerId = stringValue(value.playerId);
  const expectedRevision = value.expectedRevision;
  const revision = value.revision;
  const actionDigest = stringValue(value.actionDigest);
  if (
    !commandIdPattern.test(commandId) ||
    !playerIds.has(playerId) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !Number.isSafeInteger(revision) ||
    revision !== expectedRevision + 1 ||
    revision > roomRevision ||
    !sha256Pattern.test(actionDigest)
  ) {
    throw formatError(`Room ${roomIndex} contains a malformed command receipt.`);
  }
  return { commandId, playerId, expectedRevision, revision, actionDigest };
}

function normalizeResetAlias(value, roomIndex, roomCode, playerIds, receiptsByCommandId) {
  if (!isRecord(value)) throw formatError(`Room ${roomIndex} contains an invalid reset alias.`);
  const keys = Object.keys(value).sort();
  const expectedKeys = ['commandId', 'expiresAt', 'fromCode', 'playerId'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw formatError(`Room ${roomIndex} contains an invalid reset alias.`);
  }
  const fromCode = stringValue(value.fromCode).trim().toUpperCase();
  const commandId = stringValue(value.commandId);
  const playerId = stringValue(value.playerId);
  const expiresAt = value.expiresAt;
  const receipt = receiptsByCommandId.get(commandId);
  if (
    !/^[A-Z0-9]{5}$/.test(fromCode) ||
    fromCode === roomCode ||
    !commandIdPattern.test(commandId) ||
    !playerIds.has(playerId) ||
    !Number.isFinite(expiresAt) ||
    expiresAt < 0 ||
    !receipt ||
    receipt.playerId !== playerId ||
    receipt.actionDigest !== resetRoomActionDigest
  ) {
    throw formatError(`Room ${roomIndex} contains a malformed reset alias.`);
  }
  return { fromCode, commandId, playerId, expiresAt };
}

function normalizeChatMessage(value, roomIndex, playersById) {
  if (!isRecord(value)) {
    throw formatError(`Room ${roomIndex} contains an invalid chat message.`);
  }
  if (value.playerName !== undefined && (typeof value.playerName !== 'string' || value.playerName.trim() === '')) {
    throw formatError(`Room ${roomIndex} contains an invalid chat player name.`);
  }
  const id = boundedIdentifier(value.id, `Room ${roomIndex} chat message id`);
  const playerId = boundedIdentifier(value.playerId, `Room ${roomIndex} chat player id`);
  const playerName = stringValue(value.playerName, 'Player').trim().slice(0, 24) || 'Player';
  const text = stringValue(value.text).replace(/\s+/g, ' ').trim().slice(0, maxPersistedChatMessageLength);
  const createdAt = value.createdAt;
  if (!text || !Number.isFinite(createdAt) || createdAt < 0) {
    throw formatError(`Room ${roomIndex} contains a malformed chat message.`);
  }
  if (!playersById.has(playerId)) {
    throw formatError(`Room ${roomIndex} contains an invalid chat author.`);
  }
  return {
    id,
    playerId,
    playerName,
    text,
    createdAt
  };
}

function normalizeReadyPlayerIds(value, roomIndex, playerIds) {
  if (value !== undefined && !Array.isArray(value)) {
    throw formatError(`Room ${roomIndex} ready player ids must be an array.`);
  }
  if (value === undefined) return [];
  const readyPlayerIds = value.map((id) => {
    if (typeof id !== 'string') {
      throw formatError(`Room ${roomIndex} contains an invalid ready player id.`);
    }
    const normalizedId = id.trim();
    if (!normalizedId || normalizedId !== id || !playerIds.has(normalizedId)) {
      throw formatError(`Room ${roomIndex} contains an unknown ready player id.`);
    }
    return normalizedId;
  });
  if (new Set(readyPlayerIds).size !== readyPlayerIds.length) {
    throw formatError(`Room ${roomIndex} contains duplicate ready player ids.`);
  }
  return readyPlayerIds;
}

function normalizeRoomGameState(value, roomIndex, status, players, readyForNextRoundPlayerIds) {
  if (status === 'waiting') {
    if (value !== null) {
      throw formatError(`Room ${roomIndex} waiting state must be null.`);
    }
    if (readyForNextRoundPlayerIds.length > 0) {
      throw formatError(`Room ${roomIndex} waiting room cannot contain ready player ids.`);
    }
    return null;
  }
  if (value === undefined || value === null) {
    throw formatError(`Room ${roomIndex} ${status} state is required.`);
  }
  try {
    return normalizePersistedGameState(value, {
      rosterPlayerIds: players.map((player) => player.id),
      roomStatus: status,
      readyForNextRoundPlayerIds
    });
  } catch (error) {
    if (!(error instanceof PersistedGameStateValidationError)) throw error;
    throw formatError(`Room ${roomIndex} contains invalid game state.`, 'INVALID_ROOMS_FILE', { cause: error });
  }
}

function deriveLegacyGameSessionId({ code, hostId, players }) {
  // Only stable, normalized room identity participates so a lost rewrite can
  // be derived again after later gameplay without changing the source key.
  const canonicalRoomIdentity = JSON.stringify([
    code,
    hostId,
    players.map((player) => [player.id, player.userId ?? null])
  ]);
  return `legacy-${createHash('sha256').update(canonicalRoomIdentity).digest('hex')}`;
}

function deriveLegacyRoomInstanceId({ code, hostId, players }) {
  const canonicalRoomIdentity = JSON.stringify([
    'skyjo-room-instance-v1',
    code,
    hostId,
    players.map((player) => [player.id, player.userId ?? null, player.joinedAt ?? null])
  ]);
  const digest = createHash('sha256').update(canonicalRoomIdentity).digest('hex');
  const uuidHex = `${digest.slice(0, 12)}4${digest.slice(13, 16)}${(
    (Number.parseInt(digest[16], 16) & 0x3) | 0x8
  ).toString(16)}${digest.slice(17, 32)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
}

function normalizeRoom(value, roomIndex, restoredAt) {
  if (!isRecord(value)) {
    throw formatError(`Room ${roomIndex} must be an object.`);
  }
  const code = stringValue(value.code).trim().toUpperCase();
  const hostId = boundedIdentifier(value.hostId, `Room ${roomIndex} host id`);
  const status = stringValue(value.status);
  const updatedAt = value.updatedAt;
  if (!/^[A-Z0-9]{5}$/.test(code) || !validStatuses.has(status) || !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw formatError(`Room ${roomIndex} is missing required state.`);
  }
  if (!Array.isArray(value.players) || value.players.length < 1 || value.players.length > 8) {
    throw formatError(`Room ${roomIndex} must contain between one and eight players.`);
  }

  if (value.roomVersion !== undefined && value.roomVersion !== 1 && value.roomVersion !== 2) {
    throw formatError(`Room ${roomIndex} has an unsupported room version.`);
  }
  const revision = value.revision === undefined ? 0 : value.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw formatError(`Room ${roomIndex} has an invalid revision.`);
  }

  const players = value.players.map((player) => normalizePlayer(player, roomIndex, updatedAt, restoredAt));
  const playerIds = new Set(players.map((player) => player.id));
  const playersById = new Map(players.map((player) => [player.id, player]));
  if (playerIds.size !== players.length) {
    throw formatError(`Room ${roomIndex} contains duplicate player ids.`);
  }
  if (!playerIds.has(hostId)) {
    throw formatError(`Room ${roomIndex} host is not a room player.`);
  }
  if (value.roomInstanceId !== undefined && !roomInstanceIdPattern.test(stringValue(value.roomInstanceId))) {
    throw formatError(`Room ${roomIndex} has an invalid room instance id.`);
  }
  const roomInstanceId = value.roomInstanceId === undefined
    ? deriveLegacyRoomInstanceId({ code, hostId, players })
    : stringValue(value.roomInstanceId).toLowerCase();

  if (value.chatMessages !== undefined && !Array.isArray(value.chatMessages)) {
    throw formatError(`Room ${roomIndex} chat messages must be an array.`);
  }
  const chatMessages = Array.isArray(value.chatMessages)
    ? value.chatMessages
        .map((message) => normalizeChatMessage(message, roomIndex, playersById))
        .slice(-maxPersistedChatMessages)
    : [];

  const readyForNextRoundPlayerIds = normalizeReadyPlayerIds(
    value.readyForNextRoundPlayerIds,
    roomIndex,
    playerIds
  );

  if (value.recentCommandIds !== undefined && !Array.isArray(value.recentCommandIds)) {
    throw formatError(`Room ${roomIndex} command receipts must be an array.`);
  }
  if (Array.isArray(value.recentCommandIds) && value.recentCommandIds.length > MAX_PERSISTED_COMMAND_RECEIPTS) {
    throw formatError(`Room ${roomIndex} contains too many command receipts.`);
  }
  const recentCommandIds = Array.isArray(value.recentCommandIds)
    ? value.recentCommandIds.map((receipt) => normalizeCommandReceipt(receipt, roomIndex, playerIds, revision))
    : [];
  if (new Set(recentCommandIds.map((receipt) => receipt.commandId)).size !== recentCommandIds.length) {
    throw formatError(`Room ${roomIndex} contains duplicate command ids.`);
  }
  if (new Set(recentCommandIds.map((receipt) => receipt.revision)).size !== recentCommandIds.length) {
    throw formatError(`Room ${roomIndex} contains duplicate command revisions.`);
  }

  if (value.resetAliases !== undefined && !Array.isArray(value.resetAliases)) {
    throw formatError(`Room ${roomIndex} reset aliases must be an array.`);
  }
  if (Array.isArray(value.resetAliases) && value.resetAliases.length > MAX_PERSISTED_RESET_ALIASES) {
    throw formatError(`Room ${roomIndex} contains too many reset aliases.`);
  }
  const receiptsByCommandId = new Map(recentCommandIds.map((receipt) => [receipt.commandId, receipt]));
  const resetAliases = Array.isArray(value.resetAliases)
    ? value.resetAliases.map((alias) => normalizeResetAlias(alias, roomIndex, code, playerIds, receiptsByCommandId))
    : [];
  if (new Set(resetAliases.map((alias) => alias.fromCode)).size !== resetAliases.length) {
    throw formatError(`Room ${roomIndex} contains duplicate reset alias codes.`);
  }
  if (new Set(resetAliases.map((alias) => alias.commandId)).size !== resetAliases.length) {
    throw formatError(`Room ${roomIndex} contains duplicate reset alias commands.`);
  }

  const state = normalizeRoomGameState(value.state, roomIndex, status, players, readyForNextRoundPlayerIds);
  if (status === 'waiting' && players.some((player) => player.controller === 'ai')) {
    throw formatError(`Room ${roomIndex} waiting room cannot contain an AI-controlled seat.`);
  }
  if (value.completedGameId !== undefined && value.completedGameId !== null && typeof value.completedGameId !== 'string') {
    throw formatError(`Room ${roomIndex} completed game id must be a string or null.`);
  }
  if (value.gameSessionId !== undefined && value.gameSessionId !== null && typeof value.gameSessionId !== 'string') {
    throw formatError(`Room ${roomIndex} game session id must be a string or null.`);
  }
  const persistedGameSessionId = optionalBoundedIdentifier(
    value.gameSessionId,
    `Room ${roomIndex} game session id`
  );
  const gameSessionId = persistedGameSessionId ?? (
    state !== null && (status === 'playing' || status === 'finished')
      ? deriveLegacyGameSessionId({ code, hostId, players })
      : null
  );
  if (value.finishedByAi !== undefined && typeof value.finishedByAi !== 'boolean') {
    throw formatError(`Room ${roomIndex} contains an invalid finishedByAi state.`);
  }

  return {
    roomVersion: 2,
    code,
    hostId,
    players: players.map((player) => ({
      ...player,
      host: player.id === hostId
    })),
    chatMessages,
    readyForNextRoundPlayerIds,
    state,
    status,
    updatedAt,
    completedGameId: optionalBoundedIdentifier(value.completedGameId, `Room ${roomIndex} completed game id`),
    gameSessionId,
    finishedByAi: value.finishedByAi === true,
    roomInstanceId,
    revision,
    recentCommandIds,
    resetAliases,
    clients: new Set()
  };
}

function parseVersionedEnvelope(value) {
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw formatError('Room persistence version must be a positive integer.', 'INVALID_ROOMS_VERSION');
  }
  if (value.version > ROOMS_FILE_VERSION) {
    throw formatError(
      `Room persistence version ${value.version} is newer than supported version ${ROOMS_FILE_VERSION}.`,
      'UNSUPPORTED_ROOMS_VERSION'
    );
  }

  if (value.version === ROOMS_FILE_VERSION) {
    if (value.format !== ROOMS_FILE_FORMAT) {
      throw formatError('Room persistence format marker is invalid.', 'INVALID_ROOMS_FORMAT');
    }
    if (!SUPPORTED_ROOMS_PROTOCOL_VERSIONS.includes(value.protocolVersion)) {
      throw formatError(
        `Room protocol version ${String(value.protocolVersion)} is not supported.`,
        'UNSUPPORTED_ROOMS_PROTOCOL'
      );
    }
    if (!hasOwn(value, 'savedAt')) {
      throw formatError('Current room persistence envelope is missing savedAt.');
    }
  } else if (
    value.protocolVersion !== undefined &&
    !SUPPORTED_ROOMS_PROTOCOL_VERSIONS.includes(value.protocolVersion)
  ) {
    throw formatError(
      `Legacy room protocol version ${String(value.protocolVersion)} is not supported.`,
      'UNSUPPORTED_ROOMS_PROTOCOL'
    );
  }

  if (!Array.isArray(value.rooms)) {
    throw formatError('Room persistence envelope must contain a rooms array.');
  }

  return {
    format: value.version === ROOMS_FILE_VERSION ? ROOMS_FILE_FORMAT : null,
    version: value.version,
    protocolVersion: value.protocolVersion ?? ROOMS_PROTOCOL_VERSION,
    savedAt: optionalTimestamp(value.savedAt, 'savedAt'),
    rooms: value.rooms,
    legacy: value.version < ROOMS_FILE_VERSION ||
      (value.protocolVersion ?? ROOMS_PROTOCOL_VERSION) !== ROOMS_PROTOCOL_VERSION
  };
}

/**
 * Parse and validate a decoded rooms document without normalizing runtime room state.
 * Legacy top-level arrays, unversioned { rooms } objects, and version 1 envelopes
 * remain readable so an accepted document can be rewritten in the current format.
 */
export function parseRoomsDocument(value) {
  if (Array.isArray(value)) {
    return {
      format: null,
      version: 0,
      protocolVersion: ROOMS_PROTOCOL_VERSION,
      savedAt: null,
      rooms: value,
      legacy: true
    };
  }
  if (!isRecord(value)) {
    throw formatError('Room persistence document must be an object or legacy array.');
  }
  if (hasOwn(value, 'version')) return parseVersionedEnvelope(value);
  if (hasOwn(value, 'format') || hasOwn(value, 'protocolVersion')) {
    throw formatError('Versioned room persistence metadata is missing a version.', 'INVALID_ROOMS_VERSION');
  }
  if (!Array.isArray(value.rooms)) {
    throw formatError('Legacy room persistence object must contain a rooms array.');
  }
  return {
    format: null,
    version: 0,
    protocolVersion: ROOMS_PROTOCOL_VERSION,
    savedAt: optionalTimestamp(value.savedAt, 'savedAt'),
    rooms: value.rooms,
    legacy: true
  };
}

function assertStrictEnvelopeKeys(value, document) {
  if (Array.isArray(value)) return;
  const actualKeys = Object.keys(value).sort();
  let allowedKeys;
  if (document.version === ROOMS_FILE_VERSION) {
    allowedKeys = ['format', 'version', 'protocolVersion', 'savedAt', 'rooms'];
  } else if (document.version === 1) {
    allowedKeys = value.protocolVersion === undefined
      ? ['version', 'savedAt', 'rooms']
      : ['version', 'protocolVersion', 'savedAt', 'rooms'];
  } else {
    allowedKeys = value.savedAt === undefined ? ['rooms'] : ['savedAt', 'rooms'];
  }
  const expectedKeys = allowedKeys.sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw formatError('Room persistence envelope contains unsupported fields.');
  }
}

/**
 * Strictly validate and normalize a decoded room document. All rooms are fully
 * validated, including duplicate invariants, before optional stale pruning.
 */
export function normalizeRoomsDocument(value, options = {}) {
  const pruneStale = options.pruneStale !== false;
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? ROOM_STALE_MS;
  if (pruneStale && (!Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0)) {
    throw new TypeError('now and staleMs must be finite, and staleMs must be non-negative');
  }

  const document = parseRoomsDocument(value);
  assertStrictEnvelopeKeys(value, document);
  if (document.rooms.length > maxPersistedRooms) {
    throw formatError(`Room persistence document exceeds ${maxPersistedRooms} rooms.`);
  }

  const normalizedRooms = document.rooms.map((room, index) => normalizeRoom(room, index, now));
  const backfilledGameSessionId = normalizedRooms.some((room, index) => {
    const persistedGameSessionId = optionalBoundedIdentifier(
      document.rooms[index].gameSessionId,
      `Room ${index} game session id`
    );
    return room.gameSessionId !== persistedGameSessionId;
  });
  const backfilledRoomInstanceId = normalizedRooms.some(
    (room, index) => room.roomInstanceId !== document.rooms[index].roomInstanceId
  );
  const backfilledLifecycleAnchor = document.rooms.some((room) =>
    Array.isArray(room.players) && room.players.some((player) =>
      player.connected === true || player.disconnectedAt === undefined || player.disconnectedAt === null
    )
  );
  const roomCodes = new Set();
  for (const room of normalizedRooms) {
    if (roomCodes.has(room.code)) {
      throw formatError(`Room persistence document contains duplicate room code ${room.code}.`);
    }
    roomCodes.add(room.code);
  }
  const liveResetAliasCodes = new Set();
  for (const room of normalizedRooms) {
    for (const alias of room.resetAliases) {
      if (alias.expiresAt <= now) continue;
      if (roomCodes.has(alias.fromCode)) {
        throw formatError(`Room persistence reset alias collides with active room code ${alias.fromCode}.`);
      }
      if (liveResetAliasCodes.has(alias.fromCode)) {
        throw formatError(`Room persistence contains duplicate live reset alias code ${alias.fromCode}.`);
      }
      liveResetAliasCodes.add(alias.fromCode);
    }
  }

  return {
    ...document,
    legacy: document.legacy || backfilledGameSessionId || backfilledRoomInstanceId || backfilledLifecycleAnchor,
    rooms: pruneStale ? normalizedRooms.filter((room) => room.updatedAt >= now - staleMs) : normalizedRooms
  };
}

export function reconcileCompletedRoomJournals(rooms, findJournalBySourceKey) {
  if (!rooms || typeof rooms.values !== 'function') {
    throw new TypeError('rooms must provide a values() iterator');
  }
  if (typeof findJournalBySourceKey !== 'function') {
    throw new TypeError('findJournalBySourceKey must be a function');
  }

  const recoveryPlans = [];
  for (const room of rooms.values()) {
    if (!room?.state || room.status === 'waiting' || !room.gameSessionId) continue;
    const sourceKey = `multi:${room.gameSessionId}`;
    const journal = findJournalBySourceKey(sourceKey);
    if (journal === null || journal === undefined) continue;
    if (!isRecord(journal)) {
      throw formatError(`Room ${room.code} completion journal is invalid.`, 'INVALID_COMPLETION_JOURNAL');
    }
    const gameId = boundedIdentifier(journal.id, `Room ${room.code} completion journal game id`);
    if (journal.sourceKey !== sourceKey || journal.roomCode !== room.code) {
      throw formatError(`Room ${room.code} completion journal identity does not match.`, 'INVALID_COMPLETION_JOURNAL');
    }
    const completedAt = optionalTimestamp(journal.completedAt, `Room ${room.code} completion journal timestamp`);
    if (completedAt === null) {
      throw formatError(`Room ${room.code} completion journal timestamp is missing.`, 'INVALID_COMPLETION_JOURNAL');
    }
    if (typeof journal.finishedByAi !== 'boolean') {
      throw formatError(`Room ${room.code} completion journal AI attribution is invalid.`, 'INVALID_COMPLETION_JOURNAL');
    }
    let state;
    try {
      state = normalizePersistedGameState(journal.state, {
        rosterPlayerIds: room.players.map((player) => player.id),
        roomStatus: 'finished',
        readyForNextRoundPlayerIds: []
      });
    } catch (cause) {
      throw formatError(
        `Room ${room.code} completion journal state is invalid.`,
        'INVALID_COMPLETION_JOURNAL',
        { cause }
      );
    }
    if (state.phase !== 'game-over') {
      throw formatError(`Room ${room.code} completion journal is not terminal.`, 'INVALID_COMPLETION_JOURNAL');
    }
    if (room.completedGameId && room.completedGameId !== gameId) {
      throw formatError(`Room ${room.code} completion journal conflicts with persisted history.`, 'INVALID_COMPLETION_JOURNAL');
    }

    if (room.completedGameId === gameId) {
      if (room.status !== 'finished' || !isDeepStrictEqual(room.state, state) || room.finishedByAi !== journal.finishedByAi) {
        throw formatError(`Room ${room.code} completed state conflicts with its journal.`, 'INVALID_COMPLETION_JOURNAL');
      }
      continue;
    }
    if (!Number.isSafeInteger(room.revision) || room.revision >= Number.MAX_SAFE_INTEGER) {
      throw formatError(`Room ${room.code} cannot advance its recovery revision.`, 'INVALID_COMPLETION_JOURNAL');
    }
    recoveryPlans.push({
      room,
      state,
      gameId,
      completedAt,
      finishedByAi: journal.finishedByAi
    });
  }

  for (const plan of recoveryPlans) {
    plan.room.revision += 1;
    plan.room.state = plan.state;
    plan.room.status = 'finished';
    plan.room.completedGameId = plan.gameId;
    plan.room.finishedByAi = plan.finishedByAi;
    plan.room.readyForNextRoundPlayerIds = plan.room.players
      .filter((player) => player.controller === 'ai')
      .map((player) => player.id);
    plan.room.updatedAt = Math.max(plan.room.updatedAt, plan.completedAt);
  }
  return recoveryPlans.length;
}

export function resolveRoomsFilePath(env = process.env) {
  const configuredPath = stringValue(env.SKYJO_ROOMS_FILE).trim();
  return path.resolve(configuredPath || DEFAULT_ROOMS_FILE);
}

export function serializeRoom(room) {
  const code = stringValue(room.code);
  if (!/^[A-Z0-9]{5}$/.test(code)) throw formatError('Room code is invalid.');
  const hostId = boundedIdentifier(room.hostId, `Room ${code} host id`);
  if (!Array.isArray(room.players) || room.players.length < 1 || room.players.length > 8) {
    throw formatError(`Room ${code} must contain between one and eight players.`);
  }
  if (Array.isArray(room.resetAliases) && room.resetAliases.length > MAX_PERSISTED_RESET_ALIASES) {
    throw formatError(`Room ${code} contains too many reset aliases.`);
  }
  const resetAliasesForRetention = Array.isArray(room.resetAliases) ? room.resetAliases : [];
  const serializedPlayers = room.players.map((player) => ({
    ...normalizePlayer(player, code, room.updatedAt, room.updatedAt),
    connected: player.connected === true,
    host: player.host === true,
    disconnectedAt: player.connected === true
      ? null
      : player.disconnectedAt === undefined || player.disconnectedAt === null
        ? player.lastSeenAt ?? room.updatedAt
        : optionalTimestamp(player.disconnectedAt, `Room ${code} player disconnectedAt`)
  }));
  const playerIds = new Set(serializedPlayers.map((player) => player.id));
  if (playerIds.size !== serializedPlayers.length) throw formatError(`Room ${code} contains duplicate player ids.`);
  if (!playerIds.has(hostId)) throw formatError(`Room ${code} host is not a room player.`);
  const playersById = new Map(serializedPlayers.map((player) => [player.id, player]));
  if (room.roomInstanceId !== undefined && !roomInstanceIdPattern.test(stringValue(room.roomInstanceId))) {
    throw formatError(`Room ${code} has an invalid room instance id.`);
  }
  const roomInstanceId = room.roomInstanceId === undefined
    ? deriveLegacyRoomInstanceId({ code, hostId, players: serializedPlayers })
    : stringValue(room.roomInstanceId).toLowerCase();
  const chatMessages = Array.isArray(room.chatMessages)
    ? room.chatMessages
        .map((message) => normalizeChatMessage(message, code, playersById))
        .slice(-maxPersistedChatMessages)
    : [];
  const readyForNextRoundPlayerIds = normalizeReadyPlayerIds(
    room.readyForNextRoundPlayerIds,
    code,
    playerIds
  );
  const state = normalizeRoomGameState(
    room.state,
    code,
    room.status,
    serializedPlayers,
    readyForNextRoundPlayerIds
  );
  const recentCommandIds = Array.isArray(room.recentCommandIds)
    ? retainCommandReceiptsForResetAliases(room.recentCommandIds, resetAliasesForRetention).map((receipt) => ({
        commandId: receipt.commandId,
        playerId: receipt.playerId,
        expectedRevision: receipt.expectedRevision,
        revision: receipt.revision,
        actionDigest: receipt.actionDigest
      }))
    : [];
  if (recentCommandIds.length > MAX_PERSISTED_COMMAND_RECEIPTS) {
    throw formatError(`Room ${code} contains too many command receipts.`);
  }
  const receiptsByCommandId = new Map(recentCommandIds.map((receipt) => [receipt.commandId, receipt]));
  return {
    roomVersion: 2,
    code,
    hostId,
    players: serializedPlayers,
    chatMessages,
    readyForNextRoundPlayerIds,
    state,
    status: room.status,
    updatedAt: room.updatedAt,
    completedGameId: optionalBoundedIdentifier(room.completedGameId, `Room ${code} completed game id`),
    gameSessionId: optionalBoundedIdentifier(room.gameSessionId, `Room ${code} game session id`),
    finishedByAi: room.finishedByAi === true,
    roomInstanceId,
    revision: Number.isSafeInteger(room.revision) && room.revision >= 0 ? room.revision : 0,
    recentCommandIds,
    resetAliases: resetAliasesForRetention.length > 0
      ? resetAliasesForRetention
          .map((alias) => normalizeResetAlias(alias, code, code, playerIds, receiptsByCommandId))
      : []
  };
}

export function serializeRooms(rooms, savedAt = Date.now()) {
  if (!rooms || typeof rooms.values !== 'function') {
    throw new TypeError('rooms must provide a values() iterator');
  }
  optionalTimestamp(savedAt, 'savedAt');
  return {
    format: ROOMS_FILE_FORMAT,
    version: ROOMS_FILE_VERSION,
    protocolVersion: ROOMS_PROTOCOL_VERSION,
    savedAt,
    rooms: [...rooms.values()].map(serializeRoom)
  };
}

export function isUnsupportedDirectorySyncError(platform, error) {
  return platform === 'win32'
    && error !== null
    && typeof error === 'object'
    && typeof error.code === 'string'
    && unsupportedWindowsDirectorySyncCodes.has(error.code);
}

async function syncDirectory(directory) {
  let directoryHandle;
  try {
    directoryHandle = await fs.open(directory, 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(process.platform, error)) throw error;
  } finally {
    if (directoryHandle) await directoryHandle.close();
  }
}

export async function atomicWriteJson(filePath, payload) {
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    const tempHandle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await tempHandle.writeFile(data, { encoding: 'utf8' });
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await fs.rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch (cleanupError) {
      if (error && typeof error === 'object' && !hasOwn(error, 'cleanupError')) {
        Object.defineProperty(error, 'cleanupError', { value: cleanupError });
      }
    }
    throw error;
  }
}

export async function saveRoomsToDisk(rooms, filePath = resolveRoomsFilePath()) {
  await atomicWriteJson(filePath, serializeRooms(rooms));
}

export async function loadRoomsSnapshotFromDisk(filePath = resolveRoomsFilePath(), options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? ROOM_STALE_MS;
  if (!Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0) {
    throw new TypeError('now and staleMs must be finite, and staleMs must be non-negative');
  }

  let data;
  try {
    data = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        format: null,
        version: null,
        protocolVersion: ROOMS_PROTOCOL_VERSION,
        savedAt: null,
        legacy: false,
        missing: true,
        rooms: []
      };
    }
    throw error;
  }

  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch (cause) {
    throw formatError('Room persistence file is not valid JSON.', 'INVALID_ROOMS_JSON', { cause });
  }

  const document = normalizeRoomsDocument(decoded, { now, staleMs, pruneStale: true });

  return {
    ...document,
    missing: false,
    rooms: document.rooms
  };
}

/**
 * Backward-compatible array-returning wrapper used by the current server.
 * Format and parse failures intentionally propagate so callers cannot mistake
 * corruption or a newer schema for an empty room collection.
 */
export async function loadRoomsFromDisk(filePath = resolveRoomsFilePath(), options = {}) {
  const snapshot = await loadRoomsSnapshotFromDisk(filePath, options);
  return snapshot.rooms;
}
