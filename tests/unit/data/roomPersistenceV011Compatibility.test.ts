import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadRoomsFromDisk,
  MAX_PERSISTED_COMMAND_RECEIPTS,
  normalizeRoomsDocument,
  serializeRooms
} from '../../../server-room-persistence.mjs';
import {
  createRoomInviteToken,
  inviteMatchesRoom,
  parseRoomInviteToken
} from '../../../server-room-invites.mjs';
import {
  createMultiplayerGame,
  drawBlind,
  replaceCard,
  revealOpeningCard
} from '../../../src/game';
import { createSeededRandom } from '../../../src/runtime';
import type { GameState } from '../../../src/types';

const v011Tag = 'v0.1.1';
const v011Commit = '15b354786a0b0ced130b9cdb4da89b904b5942e8';
const fixedNow = Date.parse('2026-07-11T12:00:00Z');
const resetCommandId = '10000000-0000-4000-8000-000000000001';
const currentRoomInstanceId = '33333333-3333-4333-8333-333333333333';
const inviteSecret = 'rollback-invite-test-secret-value';
const resetActionDigest = createHash('sha256')
  .update(JSON.stringify({ type: 'reset-room' }))
  .digest('hex');

type V011Room = {
  code: string;
  state: GameState | null;
  readyForNextRoundPlayerIds: string[];
  players: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type V011Document = {
  format: string;
  version: number;
  protocolVersion: number;
  savedAt: number;
  rooms: V011Room[];
};

type V011Persistence = {
  normalizeRoomsDocument: (
    value: unknown,
    options?: { now?: number; staleMs?: number; pruneStale?: boolean }
  ) => { rooms: V011Room[] };
  serializeRooms: (rooms: Map<string, V011Room>, savedAt?: number) => V011Document;
};

let exactV011: V011Persistence;
let tempDirectory = '';

function repositoryRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  }).trim();
}

async function importExactV011Persistence() {
  const root = repositoryRoot();
  const resolvedCommit = execFileSync('git', ['rev-parse', `${v011Tag}^{commit}`], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
  if (resolvedCommit !== v011Commit) {
    throw new Error(`${v011Tag} resolved to ${resolvedCommit}; expected immutable commit ${v011Commit}.`);
  }

  const source = execFileSync('git', ['show', `${v011Tag}:server-room-persistence.mjs`], {
    cwd: root,
    encoding: 'utf8'
  });
  const modulePath = path.join(tempDirectory, 'server-room-persistence-v0.1.1.mjs');
  await fs.writeFile(modulePath, source, 'utf8');
  return import(`${pathToFileURL(modulePath).href}?commit=${v011Commit}`) as Promise<V011Persistence>;
}

function gameRoster() {
  return [
    { id: 'host-1', name: 'Ada' },
    { id: 'player-2', name: 'Grace' }
  ];
}

function finishOpening(initial: GameState): GameState {
  let state = initial;
  while (state.phase === 'opening-reveal') {
    const player = state.players[state.currentPlayerIndex];
    const cardIndex = player.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (cardIndex < 0) throw new Error('Fixture could not find an opening card.');
    state = revealOpeningCard(state, cardIndex);
  }
  return state;
}

function activeBlindDrawState(): GameState {
  const opened = finishOpening(createMultiplayerGame(gameRoster(), 1, null, createSeededRandom(0x51a7e)));
  const state = drawBlind(opened, createSeededRandom(0xb11d));
  if (state.phase !== 'choose-replacement' || state.selectedSource !== 'draw' || !state.drawnCard) {
    throw new Error('Fixture did not produce an active blind draw.');
  }
  return state;
}

function completedState(gameOver: boolean): GameState {
  const opened = finishOpening(createMultiplayerGame(
    gameRoster(),
    1,
    null,
    createSeededRandom(gameOver ? 1 : 0x600d)
  ));
  const activeIndex = opened.currentPlayerIndex;
  const closerIndex = (activeIndex + 1) % opened.players.length;
  const blindDraw = drawBlind(opened, createSeededRandom(gameOver ? 0xabc : 0xf1a1));
  const finalTurn = {
    ...blindDraw,
    roundCloserId: blindDraw.players[closerIndex].id,
    finalTurnPlayerIds: [blindDraw.players[activeIndex].id]
  };
  const cardIndex = finalTurn.players[activeIndex].grid.findIndex((card) => !card.removed);
  const completed = replaceCard(finalTurn, cardIndex);
  const expectedPhase = gameOver ? 'game-over' : 'round-over';
  if (completed.phase !== expectedPhase) {
    throw new Error(`Fixture produced ${completed.phase}, expected ${expectedPhase}.`);
  }
  return completed;
}

function roomWithCurrentMetadata(state: GameState, status: 'playing' | 'finished') {
  return {
    roomVersion: 2,
    roomInstanceId: currentRoomInstanceId,
    code: 'FGHIJ',
    hostId: 'host-1',
    players: [
      {
        id: 'host-1',
        userId: 'user-1',
        name: 'Ada',
        connected: true,
        host: true,
        joinedAt: fixedNow - 2_000,
        lastSeenAt: fixedNow,
        controller: 'human' as const
      },
      {
        id: 'player-2',
        userId: 'user-2',
        name: 'Grace',
        connected: true,
        host: false,
        joinedAt: fixedNow - 1_000,
        lastSeenAt: fixedNow,
        controller: 'human' as const
      }
    ],
    chatMessages: [
      {
        id: 'chat-1',
        playerId: 'host-1',
        playerName: 'Ada',
        text: 'Compatibility check',
        createdAt: fixedNow
      }
    ],
    readyForNextRoundPlayerIds: state.phase === 'round-over' ? ['host-1'] : [],
    state,
    status,
    updatedAt: fixedNow,
    completedGameId: status === 'finished' ? 'game-1' : null,
    gameSessionId: 'session-1',
    revision: 1,
    recentCommandIds: [{
      commandId: resetCommandId,
      playerId: 'host-1',
      expectedRevision: 0,
      revision: 1,
      actionDigest: resetActionDigest
    }],
    resetAliases: [{
      fromCode: 'ABCDE',
      commandId: resetCommandId,
      playerId: 'host-1',
      expiresAt: fixedNow + 60_000
    }],
    clients: new Set()
  };
}

function cardOrder(state: GameState) {
  return {
    drawPile: state.drawPile.map((card) => card.id),
    discardPile: state.discardPile.map((card) => card.id),
    grids: state.players.map((player) => player.grid.map((card) => card.id))
  };
}

function highChurnReceipt(index: number) {
  const revision = index + 2;
  return {
    commandId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    playerId: 'host-1',
    expectedRevision: revision - 1,
    revision,
    actionDigest: 'b'.repeat(64)
  };
}

describe('exact v0.1.1 room persistence compatibility', () => {
  beforeAll(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-v011-compatibility-'));
    exactV011 = await importExactV011Persistence();
  });

  afterAll(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it.each([
    ['active blind draw', () => activeBlindDrawState(), 'playing' as const],
    ['round over', () => completedState(false), 'playing' as const],
    ['game over', () => completedState(true), 'finished' as const]
  ])('reads current %s state through the immutable tag and back into the current reader', async (
    label,
    createState,
    status
  ) => {
    const state = createState();
    const room = roomWithCurrentMetadata(state, status);
    const currentDocument = serializeRooms(new Map([[room.code, room]]), fixedNow);
    expect(currentDocument.rooms[0]).toMatchObject({
      roomVersion: 2,
      revision: 1,
      recentCommandIds: room.recentCommandIds,
      resetAliases: room.resetAliases,
      readyForNextRoundPlayerIds: room.readyForNextRoundPlayerIds
    });
    expect(currentDocument.rooms[0].players[0]).toMatchObject({
      joinedAt: fixedNow - 2_000,
      lastSeenAt: fixedNow,
      controller: 'human'
    });

    const oldNormalized = exactV011.normalizeRoomsDocument(structuredClone(currentDocument), {
      now: fixedNow + 1
    });
    expect(oldNormalized.rooms).toHaveLength(1);
    expect(oldNormalized.rooms[0]).not.toHaveProperty('roomVersion');
    expect(oldNormalized.rooms[0]).not.toHaveProperty('revision');
    expect(oldNormalized.rooms[0]).not.toHaveProperty('recentCommandIds');
    expect(oldNormalized.rooms[0]).not.toHaveProperty('resetAliases');
    expect(oldNormalized.rooms[0].players[0]).not.toHaveProperty('joinedAt');
    expect(oldNormalized.rooms[0].players[0]).not.toHaveProperty('lastSeenAt');
    expect(oldNormalized.rooms[0].players[0]).not.toHaveProperty('controller');

    const exactV011Golden = exactV011.serializeRooms(
      new Map([[oldNormalized.rooms[0].code, oldNormalized.rooms[0]]]),
      fixedNow
    );
    expect(exactV011Golden).toMatchObject({
      format: 'skyjo-rooms',
      version: 2,
      protocolVersion: 1,
      savedAt: fixedNow
    });
    expect(exactV011Golden.rooms[0]).not.toHaveProperty('roomVersion');
    expect(exactV011Golden.rooms[0]).not.toHaveProperty('revision');
    expect(exactV011Golden.rooms[0]).not.toHaveProperty('recentCommandIds');
    expect(exactV011Golden.rooms[0]).not.toHaveProperty('resetAliases');

    const goldenBytes = `${JSON.stringify(exactV011Golden, null, 2)}\n`;
    const goldenDocument = JSON.parse(goldenBytes) as V011Document;
    const currentNormalized = normalizeRoomsDocument(goldenDocument, { now: fixedNow + 1 });
    const restored = currentNormalized.rooms[0];

    expect(restored.state).toEqual(state);
    expect(cardOrder(restored.state as GameState)).toEqual(cardOrder(state));
    expect(restored.readyForNextRoundPlayerIds).toEqual(room.readyForNextRoundPlayerIds);
    expect(restored).toMatchObject({
      roomVersion: 2,
      revision: 0,
      recentCommandIds: [],
      resetAliases: []
    });

    const goldenPath = path.join(tempDirectory, `v0.1.1-${label.replaceAll(' ', '-')}.json`);
    await fs.writeFile(goldenPath, goldenBytes, 'utf8');
    const loaded = await loadRoomsFromDisk(goldenPath, { now: fixedNow + 1 });
    expect(loaded).toEqual(currentNormalized.rooms);
  });

  it('keeps rollback compatibility after receipt churn while preserving the reset recovery receipt', () => {
    const state = activeBlindDrawState();
    const room = roomWithCurrentMetadata(state, 'playing');
    const unpinnedReceipts = Array.from(
      { length: MAX_PERSISTED_COMMAND_RECEIPTS },
      (_, index) => highChurnReceipt(index)
    );
    room.revision = unpinnedReceipts.at(-1)?.revision || 1;
    room.recentCommandIds = [room.recentCommandIds[0], ...unpinnedReceipts];
    room.resetAliases[0].expiresAt = fixedNow - 1;

    const currentDocument = serializeRooms(new Map([[room.code, room]]), fixedNow);
    expect(currentDocument.rooms[0].recentCommandIds).toHaveLength(MAX_PERSISTED_COMMAND_RECEIPTS);
    expect(currentDocument.rooms[0].recentCommandIds.map((receipt: { commandId: string }) => receipt.commandId)).toEqual([
      resetCommandId,
      ...unpinnedReceipts.slice(1).map((receipt) => receipt.commandId)
    ]);
    expect(currentDocument.rooms[0].resetAliases).toEqual(room.resetAliases);

    const oldNormalized = exactV011.normalizeRoomsDocument(structuredClone(currentDocument), {
      now: fixedNow
    });
    expect(oldNormalized.rooms[0].state).toEqual(state);
    expect(oldNormalized.rooms[0]).not.toHaveProperty('recentCommandIds');
    expect(oldNormalized.rooms[0]).not.toHaveProperty('resetAliases');

    const exactV011Golden = exactV011.serializeRooms(
      new Map([[oldNormalized.rooms[0].code, oldNormalized.rooms[0]]]),
      fixedNow
    );
    const currentRestored = normalizeRoomsDocument(exactV011Golden, { now: fixedNow }).rooms[0];
    expect(currentRestored.state).toEqual(state);
    expect(cardOrder(currentRestored.state as GameState)).toEqual(cardOrder(state));
    expect(currentRestored).toMatchObject({
      revision: 0,
      recentCommandIds: [],
      resetAliases: []
    });
  });

  it('invalidates pre-rollback long and short invites after an exact old-writer round trip', () => {
    const room = roomWithCurrentMetadata(activeBlindDrawState(), 'playing');
    const currentDocument = serializeRooms(new Map([[room.code, room]]), fixedNow);
    expect(currentDocument.rooms[0].roomInstanceId).toBe(currentRoomInstanceId);
    const currentBeforeRollback = normalizeRoomsDocument(currentDocument, { now: fixedNow }).rooms[0];
    expect(currentBeforeRollback.roomInstanceId).toBe(currentRoomInstanceId);

    const longInvite = createRoomInviteToken({
      roomCode: room.code,
      roomInstanceId: currentRoomInstanceId,
      secret: inviteSecret,
      ttlMs: 60_000,
      now: () => fixedNow,
      randomBytes: () => Buffer.alloc(16, 9)
    });
    const parsedLongInvite = parseRoomInviteToken(longInvite.token, {
      secret: inviteSecret,
      now: () => fixedNow + 1
    });
    const consumedShortCodeBinding = {
      room: room.code,
      roomInstanceId: currentRoomInstanceId
    };
    expect(inviteMatchesRoom(parsedLongInvite, currentBeforeRollback)).toBe(true);
    expect(inviteMatchesRoom(consumedShortCodeBinding, currentBeforeRollback)).toBe(true);

    const oldNormalized = exactV011.normalizeRoomsDocument(structuredClone(currentDocument), {
      now: fixedNow + 1
    });
    expect(oldNormalized.rooms[0]).not.toHaveProperty('roomInstanceId');
    const oldRewritten = exactV011.serializeRooms(
      new Map([[oldNormalized.rooms[0].code, oldNormalized.rooms[0]]]),
      fixedNow + 1
    );
    expect(oldRewritten.rooms[0]).not.toHaveProperty('roomInstanceId');

    const currentAfterRollback = normalizeRoomsDocument(oldRewritten, { now: fixedNow + 2 }).rooms[0];
    expect(currentAfterRollback.roomInstanceId).not.toBe(currentRoomInstanceId);
    expect(currentAfterRollback.roomInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inviteMatchesRoom(parsedLongInvite, currentAfterRollback)).toBe(false);
    expect(inviteMatchesRoom(consumedShortCodeBinding, currentAfterRollback)).toBe(false);

    const currentRewrite = serializeRooms(new Map([[currentAfterRollback.code, currentAfterRollback]]), fixedNow + 3);
    const currentReread = normalizeRoomsDocument(currentRewrite, { now: fixedNow + 4 }).rooms[0];
    expect(currentReread.roomInstanceId).toBe(currentAfterRollback.roomInstanceId);
  });
});
