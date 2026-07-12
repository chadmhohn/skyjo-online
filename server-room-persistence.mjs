import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ROOMS_FILE = path.join('.data', 'rooms.json');
export const ROOM_STALE_MS = 1000 * 60 * 60 * 6;
export const ROOMS_FILE_FORMAT = 'skyjo-rooms';
export const ROOMS_FILE_VERSION = 2;
export const ROOMS_PROTOCOL_VERSION = 1;
export const SUPPORTED_ROOMS_PROTOCOL_VERSIONS = Object.freeze([1]);

const validStatuses = new Set(['waiting', 'playing', 'finished']);
const maxPersistedChatMessages = 80;
const maxPersistedChatMessageLength = 280;
const maxPersistedRooms = 10_000;
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

function normalizePlayer(value, roomIndex) {
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
  const id = stringValue(value.id).trim();
  const name = stringValue(value.name, 'Player').trim().slice(0, 24) || 'Player';
  if (!id) {
    throw formatError(`Room ${roomIndex} contains a player without an id.`);
  }
  if (value.userId !== undefined && typeof value.userId !== 'string') {
    throw formatError(`Room ${roomIndex} contains an invalid player user id.`);
  }
  return {
    id,
    userId: stringValue(value.userId).trim() || undefined,
    name,
    connected: false,
    host: value.host === true
  };
}

function normalizeChatMessage(value, roomIndex) {
  if (!isRecord(value)) {
    throw formatError(`Room ${roomIndex} contains an invalid chat message.`);
  }
  if (value.playerName !== undefined && (typeof value.playerName !== 'string' || value.playerName.trim() === '')) {
    throw formatError(`Room ${roomIndex} contains an invalid chat player name.`);
  }
  const id = stringValue(value.id).trim();
  const playerId = stringValue(value.playerId).trim();
  const playerName = stringValue(value.playerName, 'Player').trim().slice(0, 24) || 'Player';
  const text = stringValue(value.text).replace(/\s+/g, ' ').trim().slice(0, maxPersistedChatMessageLength);
  const createdAt = value.createdAt;
  if (!id || !playerId || !text || !Number.isFinite(createdAt) || createdAt < 0) {
    throw formatError(`Room ${roomIndex} contains a malformed chat message.`);
  }
  return {
    id,
    playerId,
    playerName,
    text,
    createdAt
  };
}

function normalizeRoom(value, roomIndex) {
  if (!isRecord(value)) {
    throw formatError(`Room ${roomIndex} must be an object.`);
  }
  const code = stringValue(value.code).trim().toUpperCase();
  const hostId = stringValue(value.hostId).trim();
  const status = stringValue(value.status);
  const updatedAt = value.updatedAt;
  if (!/^[A-Z0-9]{5}$/.test(code) || !hostId || !validStatuses.has(status) || !Number.isFinite(updatedAt) || updatedAt < 0) {
    throw formatError(`Room ${roomIndex} is missing required state.`);
  }
  if (!Array.isArray(value.players) || value.players.length < 1 || value.players.length > 8) {
    throw formatError(`Room ${roomIndex} must contain between one and eight players.`);
  }

  const players = value.players.map((player) => normalizePlayer(player, roomIndex));
  const playerIds = new Set(players.map((player) => player.id));
  if (playerIds.size !== players.length) {
    throw formatError(`Room ${roomIndex} contains duplicate player ids.`);
  }
  if (!playerIds.has(hostId)) {
    throw formatError(`Room ${roomIndex} host is not a room player.`);
  }

  if (value.chatMessages !== undefined && !Array.isArray(value.chatMessages)) {
    throw formatError(`Room ${roomIndex} chat messages must be an array.`);
  }
  const chatMessages = Array.isArray(value.chatMessages)
    ? value.chatMessages.map((message) => normalizeChatMessage(message, roomIndex)).slice(-maxPersistedChatMessages)
    : [];

  if (value.readyForNextRoundPlayerIds !== undefined && !Array.isArray(value.readyForNextRoundPlayerIds)) {
    throw formatError(`Room ${roomIndex} ready player ids must be an array.`);
  }
  if (Array.isArray(value.readyForNextRoundPlayerIds) && value.readyForNextRoundPlayerIds.some((id) => typeof id !== 'string')) {
    throw formatError(`Room ${roomIndex} contains an invalid ready player id.`);
  }
  const readyForNextRoundPlayerIds = Array.isArray(value.readyForNextRoundPlayerIds)
    ? value.readyForNextRoundPlayerIds
        .map((id) => stringValue(id).trim())
        .filter((id, index, ids) => playerIds.has(id) && ids.indexOf(id) === index)
    : [];

  if (value.state !== undefined && value.state !== null && !isRecord(value.state)) {
    throw formatError(`Room ${roomIndex} game state must be an object or null.`);
  }
  if (value.completedGameId !== undefined && value.completedGameId !== null && typeof value.completedGameId !== 'string') {
    throw formatError(`Room ${roomIndex} completed game id must be a string or null.`);
  }
  if (value.gameSessionId !== undefined && value.gameSessionId !== null && typeof value.gameSessionId !== 'string') {
    throw formatError(`Room ${roomIndex} game session id must be a string or null.`);
  }

  return {
    code,
    hostId,
    players: players.map((player) => ({
      ...player,
      host: player.id === hostId
    })),
    chatMessages,
    readyForNextRoundPlayerIds,
    state: isRecord(value.state) ? value.state : null,
    status,
    updatedAt,
    completedGameId: stringValue(value.completedGameId).trim() || null,
    gameSessionId: stringValue(value.gameSessionId).trim() || null,
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

  const normalizedRooms = document.rooms.map((room, index) => normalizeRoom(room, index));
  const roomCodes = new Set();
  for (const room of normalizedRooms) {
    if (roomCodes.has(room.code)) {
      throw formatError(`Room persistence document contains duplicate room code ${room.code}.`);
    }
    roomCodes.add(room.code);
  }

  return {
    ...document,
    rooms: pruneStale ? normalizedRooms.filter((room) => room.updatedAt >= now - staleMs) : normalizedRooms
  };
}

export function resolveRoomsFilePath(env = process.env) {
  const configuredPath = stringValue(env.SKYJO_ROOMS_FILE).trim();
  return path.resolve(configuredPath || DEFAULT_ROOMS_FILE);
}

export function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((player) => ({
      id: player.id,
      userId: player.userId || undefined,
      name: player.name,
      connected: player.connected === true,
      host: player.host === true
    })),
    chatMessages: Array.isArray(room.chatMessages)
      ? room.chatMessages.map((message) => normalizeChatMessage(message, room.code)).slice(-maxPersistedChatMessages)
      : [],
    readyForNextRoundPlayerIds: Array.isArray(room.readyForNextRoundPlayerIds)
      ? room.readyForNextRoundPlayerIds.filter((id, index, ids) => ids.indexOf(id) === index)
      : [],
    state: room.state ?? null,
    status: room.status,
    updatedAt: room.updatedAt,
    completedGameId: room.completedGameId || null,
    gameSessionId: room.gameSessionId || null
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
