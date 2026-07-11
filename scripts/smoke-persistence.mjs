import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOMS_FILE,
  loadRoomsFromDisk,
  resolveRoomsFilePath,
  ROOMS_FILE_FORMAT,
  ROOMS_FILE_VERSION,
  ROOMS_PROTOCOL_VERSION,
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
      { id: 'host-1', userId: 'user-1', name: 'Ada', connected: true, host: true },
      { id: 'player-2', userId: 'user-2', name: 'Grace', connected: true, host: false }
    ],
    chatMessages: [
      {
        id: 'chat-1',
        playerId: 'host-1',
        playerName: 'Ada',
        text: 'Ready for the next round?',
        createdAt: now
      }
    ],
    readyForNextRoundPlayerIds: ['host-1', 'player-2'],
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
      openingRevealCounts: {},
      roundHistory: []
    },
    status: 'playing',
    updatedAt: now,
    completedGameId: 'game-1',
    gameSessionId: 'session-1',
    clients: new Set([{ readyState: 1 }])
  };

  const serialized = serializeRooms(new Map([[room.code, room]]), now + 1);
  assert.equal(serialized.rooms.length, 1);
  assert.equal('clients' in serialized.rooms[0], false, 'socket clients must not be persisted');
  assert.equal(serialized.rooms[0].players[0].connected, true, 'runtime presence can be written');
  assert.equal(serialized.rooms[0].players[0].userId, 'user-1', 'account user id is serialized');
  assert.equal(serialized.rooms[0].completedGameId, 'game-1', 'completed game id is serialized');
  assert.equal(serialized.rooms[0].gameSessionId, 'session-1', 'game session id is serialized');
  assert.equal(serialized.rooms[0].chatMessages.length, 1, 'room chat history is serialized');
  assert.equal(serialized.rooms[0].chatMessages[0].text, 'Ready for the next round?');
  assert.deepEqual(serialized.rooms[0].readyForNextRoundPlayerIds, ['host-1', 'player-2']);

  await saveRoomsToDisk(new Map([[room.code, room]]), roomsFile);
  const saved = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
  assert.equal(saved.format, ROOMS_FILE_FORMAT);
  assert.equal(saved.version, ROOMS_FILE_VERSION);
  assert.equal(saved.protocolVersion, ROOMS_PROTOCOL_VERSION);
  assert.equal(saved.rooms[0].code, room.code);
  assert.equal('clients' in saved.rooms[0], false, 'saved JSON must not contain clients');
  assert.equal(saved.rooms[0].chatMessages[0].playerName, 'Ada', 'saved room includes chat sender names');
  assert.equal(saved.rooms[0].players[1].userId, 'user-2', 'saved room includes account user ids');
  assert.deepEqual(saved.rooms[0].readyForNextRoundPlayerIds, ['host-1', 'player-2']);

  const restored = await loadRoomsFromDisk(roomsFile, { now: now + 1000, staleMs: ROOM_STALE_MS });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].code, room.code);
  assert.equal(restored[0].clients.size, 0, 'restored clients start empty');
  assert.equal(restored[0].players.every((player) => player.connected === false), true, 'restored players start offline');
  assert.equal(restored[0].players.find((player) => player.id === room.hostId)?.host, true, 'host flag is restored from hostId');
  assert.equal(restored[0].players.find((player) => player.id === room.hostId)?.userId, 'user-1', 'account user id is restored');
  assert.equal(restored[0].completedGameId, 'game-1', 'completed game id is restored');
  assert.equal(restored[0].chatMessages[0].text, 'Ready for the next round?', 'restored rooms keep chat history');
  assert.deepEqual(restored[0].readyForNextRoundPlayerIds, ['host-1', 'player-2'], 'restored rooms keep ready confirmations');

  const staleRoom = { ...room, code: 'OLD12', updatedAt: now - ROOM_STALE_MS - 1 };
  await saveRoomsToDisk(new Map([[staleRoom.code, staleRoom]]), roomsFile);
  const staleRestored = await loadRoomsFromDisk(roomsFile, { now, staleMs: ROOM_STALE_MS });
  assert.equal(staleRestored.length, 0, 'stale rooms are dropped on load');

  console.log('persistence smoke passed: env path, atomic JSON save, socket-free serialization, chat restore, offline restore, and stale load pruning');
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
