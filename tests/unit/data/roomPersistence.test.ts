import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ROOMS_FILE,
  ROOMS_FILE_FORMAT,
  ROOMS_FILE_VERSION,
  ROOMS_PROTOCOL_VERSION,
  ROOM_STALE_MS,
  RoomPersistenceFormatError,
  atomicWriteJson,
  isUnsupportedDirectorySyncError,
  loadRoomsFromDisk,
  loadRoomsSnapshotFromDisk,
  normalizeRoomsDocument,
  parseRoomsDocument,
  resolveRoomsFilePath,
  saveRoomsToDisk,
  serializeRooms
} from '../../../server-room-persistence.mjs';
import { createPersistenceHealthTracker } from '../../../server-persistence-health.mjs';

const fixedNow = Date.parse('2026-07-11T12:00:00Z');

function room(updatedAt = fixedNow, code = 'ABCDE') {
  return {
    code,
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

  it('writes the v2 envelope and atomically restores socket-free rooms offline', async () => {
    const value = room();
    const serialized = serializeRooms(new Map([[value.code, value]]), fixedNow + 1);
    expect(serialized).toEqual(expect.objectContaining({
      format: ROOMS_FILE_FORMAT,
      version: ROOMS_FILE_VERSION,
      protocolVersion: ROOMS_PROTOCOL_VERSION,
      savedAt: fixedNow + 1
    }));
    expect(Object.keys(serialized)).toEqual(['format', 'version', 'protocolVersion', 'savedAt', 'rooms']);
    expect(serialized.rooms[0]).not.toHaveProperty('clients');
    expect(serialized.rooms[0].readyForNextRoundPlayerIds).toEqual(['host-1', 'player-2']);

    await saveRoomsToDisk(new Map([[value.code, value]]), roomsFile);
    const saved = JSON.parse(await fs.readFile(roomsFile, 'utf8'));
    expect(saved).toEqual(expect.objectContaining({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: 1
    }));
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const snapshot = await loadRoomsSnapshotFromDisk(roomsFile, {
      now: fixedNow + 1000,
      staleMs: ROOM_STALE_MS
    });
    expect(snapshot).toEqual(expect.objectContaining({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: 1,
      legacy: false,
      missing: false
    }));
    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0].clients.size).toBe(0);
    expect(snapshot.rooms[0].players.every((player: { connected: boolean }) => !player.connected)).toBe(true);
    expect(snapshot.rooms[0]).toMatchObject({
      code: 'ABCDE',
      completedGameId: 'game-1',
      gameSessionId: 'session-1'
    });

    const compatibleRooms = await loadRoomsFromDisk(roomsFile, { now: fixedNow + 1000 });
    expect(compatibleRooms.map((restoredRoom: { code: string }) => restoredRoom.code)).toEqual(['ABCDE']);
  });

  it.each([
    ['top-level array', (rooms: unknown[]) => rooms],
    ['unversioned object', (rooms: unknown[]) => ({ rooms })],
    ['v1 envelope', (rooms: unknown[]) => ({ version: 1, savedAt: fixedNow, rooms })]
  ])('reads the legacy %s contract for an upgrade rewrite', async (_name, envelope) => {
    const current = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    await fs.writeFile(roomsFile, JSON.stringify(envelope(current.rooms)), 'utf8');

    const snapshot = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow + 1 });

    expect(snapshot).toEqual(expect.objectContaining({
      legacy: true,
      missing: false,
      protocolVersion: 1
    }));
    expect(snapshot.rooms).toHaveLength(1);
  });

  it('treats only a missing file or valid stale rooms as an empty collection', async () => {
    const missing = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow });
    expect(missing).toEqual(expect.objectContaining({ missing: true, rooms: [] }));
    expect(await loadRoomsFromDisk(roomsFile, { now: fixedNow })).toEqual([]);

    await saveRoomsToDisk(new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]), roomsFile);
    const stale = await loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow, staleMs: ROOM_STALE_MS });
    expect(stale).toEqual(expect.objectContaining({ missing: false, rooms: [] }));
  });

  it('fully validates stale rooms before pruning and preserves rejected source bytes', async () => {
    const staleCorrupt = serializeRooms(
      new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]),
      fixedNow
    );
    staleCorrupt.rooms[0].chatMessages = [null as never];
    const contents = `${JSON.stringify(staleCorrupt)}\n`;
    await fs.writeFile(roomsFile, contents, 'utf8');

    await expect(loadRoomsSnapshotFromDisk(roomsFile, { now: fixedNow, staleMs: ROOM_STALE_MS })).rejects.toThrow(
      /invalid chat message/i
    );
    expect(await fs.readFile(roomsFile, 'utf8')).toBe(contents);

    const validStale = serializeRooms(new Map([['ABCDE', room(fixedNow - ROOM_STALE_MS - 1)]]), fixedNow);
    expect(normalizeRoomsDocument(validStale, { pruneStale: false }).rooms).toHaveLength(1);
    expect(normalizeRoomsDocument(validStale, { now: fixedNow, staleMs: ROOM_STALE_MS }).rooms).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{"rooms":', 'INVALID_ROOMS_JSON'],
    ['a non-document root', JSON.stringify('rooms'), 'INVALID_ROOMS_FILE'],
    ['an unversioned malformed envelope', JSON.stringify({ rooms: {} }), 'INVALID_ROOMS_FILE'],
    ['a future version', JSON.stringify({ format: 'skyjo-rooms', version: 3, protocolVersion: 1, rooms: [] }), 'UNSUPPORTED_ROOMS_VERSION'],
    ['a future protocol', JSON.stringify({ format: 'skyjo-rooms', version: 2, protocolVersion: 2, rooms: [] }), 'UNSUPPORTED_ROOMS_PROTOCOL'],
    ['a v2 envelope without savedAt', JSON.stringify({ format: 'skyjo-rooms', version: 2, protocolVersion: 1, rooms: [] }), 'INVALID_ROOMS_FILE'],
    ['a wrong format marker', JSON.stringify({ format: 'other', version: 2, protocolVersion: 1, rooms: [] }), 'INVALID_ROOMS_FORMAT']
  ])('rejects %s without replacing the source file', async (_name, contents, code) => {
    await fs.writeFile(roomsFile, contents, 'utf8');

    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toMatchObject({
      name: 'RoomPersistenceFormatError',
      code
    });
    expect(await fs.readFile(roomsFile, 'utf8')).toBe(contents);
  });

  it('rejects malformed and duplicate room state instead of silently returning less data', async () => {
    const valid = serializeRooms(new Map([['ABCDE', room()]]), fixedNow);
    const malformed = structuredClone(valid);
    malformed.rooms[0].players = [];
    await fs.writeFile(roomsFile, JSON.stringify(malformed), 'utf8');
    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toBeInstanceOf(RoomPersistenceFormatError);

    const duplicated = serializeRooms(
      new Map([
        ['first', room(fixedNow, 'ABCDE')],
        ['second', room(fixedNow, 'abcde')]
      ]),
      fixedNow
    );
    await fs.writeFile(roomsFile, JSON.stringify(duplicated), 'utf8');
    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toThrow(/duplicate room code/i);
  });

  it.each([
    ['a non-object player', (value: ReturnType<typeof room>) => { value.players[0] = null as never; }],
    ['a player without an id', (value: ReturnType<typeof room>) => { value.players[0].id = ''; }],
    ['duplicate player ids', (value: ReturnType<typeof room>) => { value.players[1].id = value.players[0].id; }],
    ['a non-string player name', (value: ReturnType<typeof room>) => { value.players[0].name = 42 as never; }],
    ['an empty player name', (value: ReturnType<typeof room>) => { value.players[0].name = ''; }],
    ['a non-string user id', (value: ReturnType<typeof room>) => { value.players[0].userId = 42 as never; }],
    ['a non-boolean connection state', (value: ReturnType<typeof room>) => { value.players[0].connected = 'yes' as never; }],
    ['a non-boolean host state', (value: ReturnType<typeof room>) => { value.players[0].host = 'yes' as never; }],
    ['a host outside the player list', (value: ReturnType<typeof room>) => { value.hostId = 'missing'; }],
    ['non-array chat', (value: ReturnType<typeof room>) => { value.chatMessages = {} as never; }],
    ['a non-object chat message', (value: ReturnType<typeof room>) => { value.chatMessages = [null as never]; }],
    ['a non-string chat player name', (value: ReturnType<typeof room>) => { value.chatMessages[0].playerName = 42 as never; }],
    ['an invalid chat timestamp', (value: ReturnType<typeof room>) => { value.chatMessages[0].createdAt = 'now' as never; }],
    ['a malformed chat message', (value: ReturnType<typeof room>) => { value.chatMessages[0].text = ''; }],
    ['non-array ready ids', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = {} as never; }],
    ['a non-string ready id', (value: ReturnType<typeof room>) => { value.readyForNextRoundPlayerIds = [42 as never]; }],
    ['non-object game state', (value: ReturnType<typeof room>) => { value.state = [] as never; }],
    ['a non-numeric update time', (value: ReturnType<typeof room>) => { value.updatedAt = 'now' as never; }],
    ['a non-string completed game id', (value: ReturnType<typeof room>) => { value.completedGameId = 1 as never; }],
    ['a non-string game session id', (value: ReturnType<typeof room>) => { value.gameSessionId = 1 as never; }]
  ])('rejects persisted room corruption: %s', async (_name, corrupt) => {
    const value = room();
    corrupt(value);
    const envelope = {
      format: ROOMS_FILE_FORMAT,
      version: ROOMS_FILE_VERSION,
      protocolVersion: ROOMS_PROTOCOL_VERSION,
      savedAt: fixedNow,
      rooms: [value]
    };
    await fs.writeFile(roomsFile, JSON.stringify(envelope), 'utf8');

    await expect(loadRoomsFromDisk(roomsFile, { now: fixedNow })).rejects.toBeInstanceOf(RoomPersistenceFormatError);
  });

  it('validates strict parser metadata before any file access is involved', () => {
    expect(parseRoomsDocument([])).toEqual(expect.objectContaining({ version: 0, legacy: true }));
    expect(() => parseRoomsDocument({ format: 'skyjo-rooms', rooms: [] })).toThrow(/missing a version/i);
    expect(() => parseRoomsDocument({ version: 0, rooms: [] })).toThrow(/positive integer/i);
    expect(() => serializeRooms(new Map(), Number.NaN)).toThrow(/savedAt/i);
  });

  it('classifies directory fsync portability errors independently of the host platform', () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      expect(isUnsupportedDirectorySyncError('win32', { code })).toBe(true);
      expect(isUnsupportedDirectorySyncError('linux', { code })).toBe(false);
    }
    expect(isUnsupportedDirectorySyncError('win32', { code: 'EIO' })).toBe(false);
    expect(isUnsupportedDirectorySyncError('darwin', { code: 'EINVAL' })).toBe(false);
    expect(isUnsupportedDirectorySyncError('win32', null)).toBe(false);
    expect(isUnsupportedDirectorySyncError('win32', { code: 22 })).toBe(false);
  });

  it('rejects invalid load clocks and propagates non-missing read errors', async () => {
    await expect(loadRoomsSnapshotFromDisk(roomsFile, { now: Number.NaN })).rejects.toThrow(/now and staleMs/i);
    await expect(loadRoomsSnapshotFromDisk(tempDir, { now: fixedNow })).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('surfaces atomic rename failures while preserving the previous file and cleaning the temp file', async () => {
    const original = { generation: 'old', rooms: [1, 2, 3] };
    const replacement = { generation: 'new', rooms: [4, 5, 6] };
    await fs.writeFile(roomsFile, JSON.stringify(original), 'utf8');
    const renameError = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(renameError);

    await expect(atomicWriteJson(roomsFile, replacement)).rejects.toBe(renameError);

    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual(original);
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces non-portability directory fsync failures after leaving a complete new file', async () => {
    const originalOpen = fs.open.bind(fs);
    const directorySyncError = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(tempDir)) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(directorySyncError);
      }
      return handle;
    });
    await fs.writeFile(roomsFile, JSON.stringify({ generation: 'old' }), 'utf8');

    await expect(atomicWriteJson(roomsFile, { generation: 'new' })).rejects.toBe(directorySyncError);

    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual({ generation: 'new' });
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('records health success only after the final durability step', async () => {
    const originalOpen = fs.open.bind(fs);
    const directorySyncError = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(tempDir)) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(directorySyncError);
      }
      return handle;
    });
    const tracker = createPersistenceHealthTracker({ clock: () => fixedNow });

    await expect(tracker.track(() => atomicWriteJson(roomsFile, { durable: true }))).rejects.toBe(directorySyncError);

    expect(tracker.probe()).toEqual(expect.objectContaining({
      status: 'error',
      lastSuccessAt: null,
      failureCode: 'EIO'
    }));
    expect(JSON.parse(await fs.readFile(roomsFile, 'utf8'))).toEqual({ durable: true });
  });
});
