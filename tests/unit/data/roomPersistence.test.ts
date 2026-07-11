import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOMS_FILE,
  ROOM_STALE_MS,
  loadRoomsFromDisk,
  resolveRoomsFilePath,
  saveRoomsToDisk,
  serializeRooms
} from '../../../server-room-persistence.mjs';

const fixedNow = Date.parse('2026-07-11T12:00:00Z');

function room(updatedAt = fixedNow) {
  return {
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
        createdAt: fixedNow
      }
    ],
    readyForNextRoundPlayerIds: ['host-1', 'player-2', 'host-1'],
    state: { phase: 'choose-source' },
    status: 'playing',
    updatedAt,
    completedGameId: 'game-1',
    gameSessionId: 'session-1',
    clients: new Set([{ readyState: 1 }])
  };
}

describe('room persistence', () => {
  let tempDir = '';
  let roomsFile = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-room-test-'));
    roomsFile = path.join(tempDir, 'rooms.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves production paths without sharing state between tests', () => {
    expect(resolveRoomsFilePath({})).toBe(path.resolve(DEFAULT_ROOMS_FILE));
    expect(resolveRoomsFilePath({ SKYJO_ROOMS_FILE: roomsFile })).toBe(roomsFile);
  });

  it('atomically saves socket-free state and restores players offline', async () => {
    const value = room();
    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow + 1);
    expect(serialized).toMatchObject({ version: 1, savedAt: fixedNow + 1 });
    expect(serialized.rooms[0]).not.toHaveProperty('clients');
    expect(serialized.rooms[0].readyForNextRoundPlayerIds).toEqual(['host-1', 'player-2']);

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const restored = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1000, staleMs: ROOM_STALE_MS });

    expect(restored).toHaveLength(1);
    expect(restored[0].clients.size).toBe(0);
    expect(restored[0].players.every((player: { connected: boolean }) => !player.connected)).toBe(true);
    expect(restored[0]).toMatchObject({
      code: 'ABCDE',
      completedGameId: 'game-1',
      gameSessionId: 'session-1'
    });
  });

  it('drops stale and malformed rooms and treats a missing file as empty', async () => {
    expect(await loadRoomsFromDisk(roomsFile, { now: fixedNow })).toEqual([]);

    await saveRoomsToDisk(new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]), roomsFile);
    expect(await loadRoomsFromDisk(roomsFile, { now: fixedNow, staleMs: ROOM_STALE_MS })).toEqual([]);

    await fs.writeFile(roomsFile, JSON.stringify({ rooms: [{ code: '', status: 'broken' }] }), 'utf8');
    expect(await loadRoomsFromDisk(roomsFile, { now: fixedNow })).toEqual([]);
  });
});
