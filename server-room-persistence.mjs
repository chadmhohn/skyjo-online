import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ROOMS_FILE = path.join('.data', 'rooms.json');
export const ROOM_STALE_MS = 1000 * 60 * 60 * 6;

const validStatuses = new Set(['waiting', 'playing', 'finished']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizePlayer(value) {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id).trim();
  const name = stringValue(value.name, 'Player').trim().slice(0, 24) || 'Player';
  if (!id) return null;
  return {
    id,
    name,
    connected: false,
    host: value.host === true
  };
}

function normalizeRoom(value, now, staleMs) {
  if (!isRecord(value)) return null;
  const code = stringValue(value.code).trim().toUpperCase();
  const hostId = stringValue(value.hostId).trim();
  const status = stringValue(value.status);
  const updatedAt = Number(value.updatedAt);
  if (!code || !hostId || !validStatuses.has(status) || !Number.isFinite(updatedAt)) return null;
  if (updatedAt < now - staleMs) return null;
  if (!Array.isArray(value.players) || value.players.length < 1 || value.players.length > 8) return null;

  const players = value.players.map(normalizePlayer);
  if (players.some((player) => !player)) return null;
  if (!players.some((player) => player.id === hostId)) return null;

  return {
    code,
    hostId,
    players: players.map((player) => ({
      ...player,
      host: player.id === hostId
    })),
    state: isRecord(value.state) ? value.state : null,
    status,
    updatedAt,
    clients: new Set()
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
      name: player.name,
      connected: player.connected === true,
      host: player.host === true
    })),
    state: room.state ?? null,
    status: room.status,
    updatedAt: room.updatedAt
  };
}

export function serializeRooms(rooms, savedAt = Date.now()) {
  return {
    version: 1,
    savedAt,
    rooms: [...rooms.values()].map(serializeRoom)
  };
}

export async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  const data = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function saveRoomsToDisk(rooms, filePath = resolveRoomsFilePath()) {
  await atomicWriteJson(filePath, serializeRooms(rooms));
}

export async function loadRoomsFromDisk(filePath = resolveRoomsFilePath(), options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? ROOM_STALE_MS;
  let data;
  try {
    data = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const parsed = JSON.parse(data);
  const rawRooms = Array.isArray(parsed) ? parsed : parsed.rooms;
  if (!Array.isArray(rawRooms)) return [];

  return rawRooms
    .map((room) => normalizeRoom(room, now, staleMs))
    .filter(Boolean);
}
