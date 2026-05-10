import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOMS_FILE,
  loadRoomsFromDisk,
  resolveRoomsFilePath,
  ROOM_STALE_MS,
  saveRoomsToDisk,
  serializeRooms
} from '../server-room-persistence.mjs';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-rooms-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const now = Date.now();

try {
  assert.equal(resolveRoomsFilePath({}), path.resolve(DEFAULT_ROOMS_FILE));
  assert.equal(resolveRoomsFilePath({ SKYJO_ROOMS_FILE: roomsFile }), roomsFile);

  const room = {
    code: 'ABCDE',
    hostId: 'host-1',
    players: [
      { id: 'host-1', name: 'Ada', connected: true, host: true },
      { id: 'player-2', name: 'Grace', connected: true, host: false }
    ],
    state: {
      players: [],
      drawPile: [],
      discardPile: [],
      currentPlayerIndex: 0,
      phase: 'choose-source',
      selectedSource: null,
      drawnCard: null,
      round: 1,
      log: [],
      winnerId: null,
      nextStarterId: null,
      roundCloserId: null,
      finalTurnPlayerIds: [],
      openingRevealCounts: {}
    },
    status: 'playing',
    updatedAt: now,
    clients: new Set([{ readyState: 1 }])
  };

  const serialized = serializeRooms(new Map([[room.code, room]]), now + 1);
  assert.equal(serialized.rooms.length, 1);
  assert.equal('clients' in serialized.rooms[0], false, 'socket clients must not be persisted');
  assert.equal(serialized.rooms[0].players[0].connected, true, 'runtime presence can be written');

  await saveRoomsToDisk(new Map([[room.code, room]]), roomsFile);
  const saved = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.rooms[0].code, room.code);
  assert.equal('clients' in saved.rooms[0], false, 'saved JSON must not contain clients');

  const restored = await loadRoomsFromDisk(roomsFile, { now: now + 1000, staleMs: ROOM_STALE_MS });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].code, room.code);
  assert.equal(restored[0].clients.size, 0, 'restored clients start empty');
  assert.equal(restored[0].players.every((player) => player.connected === false), true, 'restored players start offline');
  assert.equal(restored[0].players.find((player) => player.id === room.hostId)?.host, true, 'host flag is restored from hostId');

  const staleRoom = { ...room, code: 'OLD12', updatedAt: now - ROOM_STALE_MS - 1 };
  await saveRoomsToDisk(new Map([[staleRoom.code, staleRoom]]), roomsFile);
  const staleRestored = await loadRoomsFromDisk(roomsFile, { now, staleMs: ROOM_STALE_MS });
  assert.equal(staleRestored.length, 0, 'stale rooms are dropped on load');

  console.log('persistence smoke passed: env path, atomic JSON save, socket-free serialization, offline restore, and stale load pruning');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
