import { createHash } from 'node:crypto';
import {
  normalizeRoomsDocument,
  serializeRooms
} from '../../../server-room-persistence.mjs';
import { createMultiplayerGame, replaceCard, revealOpeningCard } from '../../../src/game';
import {
  createRoomSnapshot,
  MAX_RECENT_COMMAND_RECEIPTS,
  MULTIPLAYER_PROTOCOL_VERSION,
  type ClientCommand,
  type CommandReceipt,
  type GameCommand
} from '../../../src/protocolV2';
import { isMultiplayerRoomSnapshot } from '../../../src/roomConnection';
import {
  createProtocolV2MessageHandler,
  createResetAliasIndex,
  isResetAliasCodeReserved,
  MAX_RESET_ALIASES,
  rebuildResetAliasIndex,
  retainCommandReceiptsForResetAliases,
  RESET_ALIAS_TTL_MS,
  type ProtocolV2CompletedGameInput,
  type ProtocolV2HandlerOptions,
  type ProtocolV2Room,
  type ProtocolV2Socket
} from '../../../src/serverProtocolV2';
import { sendRealtimeJson, type RealtimeClientMessage } from '../../../src/serverRealtime';
import { ACTIVE_PLAYER_GRACE_MS } from '../../../src/serverRoomLifecycle';
import type { RoomPlayer } from '../../../src/types';

const HOST_ID = '00000000-0000-4000-8000-000000000001';
const GUEST_ID = '00000000-0000-4000-8000-000000000002';
const NEW_ID = '00000000-0000-4000-8000-000000000003';
const COMMAND_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_COMMAND_ID = '10000000-0000-4000-8000-000000000002';

function commandIdAt(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function playerIdAt(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function persistedDigest(canonicalAction: string): string {
  return createHash('sha256').update(canonicalAction).digest('hex');
}

function player(id: string, name: string, host = false, userId = `${id}-account`): RoomPlayer {
  return {
    id,
    userId,
    name,
    connected: true,
    host,
    joinedAt: 100,
    lastSeenAt: 100,
    controller: 'human'
  };
}

function socket(id = HOST_ID, accountId = `${id}-account`, name = id === HOST_ID ? 'Host' : 'Guest') {
  const sent: unknown[] = [];
  const value: ProtocolV2Socket = {
    OPEN: 1,
    readyState: 1,
    accountUser: { id: accountId, displayName: name },
    roomCode: 'ROOM1',
    playerId: id,
    visible: true,
    on: vi.fn(),
    ping: vi.fn(),
    send: vi.fn((payload: string) => sent.push(JSON.parse(payload))),
    terminate: vi.fn()
  };
  return { socket: value, sent };
}

function room(overrides: Partial<ProtocolV2Room> = {}): ProtocolV2Room {
  const players = overrides.players || [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')];
  return {
    chatMessages: [],
    clients: new Set(),
    code: 'ROOM1',
    completedGameId: null,
    gameSessionId: 'session-1',
    hostId: players[0]?.id || '',
    players,
    readyForNextRoundPlayerIds: [],
    recentCommandIds: [],
    resetAliases: [],
    revision: 0,
    roomVersion: 2,
    state: null,
    status: 'waiting',
    updatedAt: 100,
    ...overrides
  };
}

function command(
  action: GameCommand,
  expectedRevision = 0,
  commandId = COMMAND_ID
): ClientCommand & Record<string, unknown> {
  return {
    type: 'command',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    commandId,
    expectedRevision,
    action
  } as ClientCommand & Record<string, unknown>;
}

function digest(action: GameCommand): string {
  return `digest:${JSON.stringify(action)}`;
}

function receipt(action: GameCommand, overrides: Partial<CommandReceipt> = {}): CommandReceipt {
  return {
    commandId: COMMAND_ID,
    playerId: HOST_ID,
    expectedRevision: 0,
    revision: 1,
    actionDigest: digest(action),
    ...overrides
  };
}

function resetRecoveryTarget(overrides: Partial<ProtocolV2Room> = {}): ProtocolV2Room {
  const resetReceipt = receipt({ type: 'reset-room' });
  return room({
    code: 'NEW01',
    hostId: HOST_ID,
    players: [{ ...player(HOST_ID, 'Host', true), connected: false }],
    revision: 1,
    recentCommandIds: [resetReceipt],
    resetAliases: [{
      fromCode: 'OLD01',
      commandId: resetReceipt.commandId,
      playerId: HOST_ID,
      expiresAt: 900
    }],
    ...overrides
  });
}

function harness(roomValue = room()) {
  const host = socket();
  const rooms = new Map<string, ProtocolV2Room>([[roomValue.code, roomValue]]);
  roomValue.clients.add(host.socket);
  const calls = {
    broadcasts: [] as ProtocolV2Room[],
    snapshots: [] as Array<{ socket: ProtocolV2Socket; room: ProtocolV2Room; options?: unknown }>,
    json: [] as Array<{ socket: ProtocolV2Socket; payload: Record<string, unknown> }>,
    persisted: 0,
    notified: 0,
    completed: [] as ProtocolV2CompletedGameInput[],
    completionErrors: [] as unknown[],
    randomValues: [] as number[],
    uuidValues: [] as string[]
  };
  let uuidIndex = 0;
  const uuids = [NEW_ID, '00000000-0000-4000-8000-000000000004'];
  const options: ProtocolV2HandlerOptions = {
    allPlayersReadyForNextRound: (candidate) =>
      candidate.players.every((item) => candidate.readyForNextRoundPlayerIds.includes(item.id)),
    appendRoomChatMessage: (candidate, author, text) => {
      candidate.chatMessages.push({ id: `chat-${candidate.chatMessages.length}`, playerId: author.id, playerName: author.name, text, createdAt: 500 });
    },
    broadcastRoom: (candidate) => calls.broadcasts.push(candidate),
    cleanChatText: (value) => String(value).trim(),
    createInitialRoomState: (players, random) => createMultiplayerGame(players, 1, null, random),
    createNextRoundRoomState: (state, random) => {
      const nextState = createMultiplayerGame(state.players, state.round + 1, state.nextStarterId, random);
      nextState.roundHistory = state.roundHistory;
      return nextState;
    },
    createWaitingRoom: ({ code, hostPlayer, ws }) => {
      const candidate = room({
        code,
        hostId: hostPlayer.id,
        players: [player(hostPlayer.id, hostPlayer.name, true, hostPlayer.userId)],
        clients: new Set([ws])
      });
      return candidate;
    },
    digestAction: (canonicalAction) => `digest:${canonicalAction}`,
    makeRoomCodeForSocket: () => 'NEW01',
    normalizedReadyIds: (candidate) => candidate.readyForNextRoundPlayerIds.filter((id) => candidate.players.some((item) => item.id === id)),
    notifyAwayPlayersAfterMove: () => { calls.notified += 1; },
    now: () => 500,
    persistRoomsSoon: () => { calls.persisted += 1; },
    random: () => {
      calls.randomValues.push(0.25);
      return 0.25;
    },
    randomUuid: () => {
      const value = uuids[uuidIndex++] || `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, '0')}`;
      calls.uuidValues.push(value);
      return value;
    },
    recordCompletedGame: (input) => {
      calls.completed.push(input);
      return { id: 'completed-1', recovered: false, state: input.state };
    },
    reportCompletedGameError: (error) => calls.completionErrors.push(error),
    roomPlayer: (ws) => {
      const candidate = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const member = candidate?.players.find((item) => item.id === ws.playerId);
      return candidate && member ? { room: candidate, player: member } : null;
    },
    rooms,
    sendJson: (ws, payload) => calls.json.push({ socket: ws, payload: payload as Record<string, unknown> }),
    sendRoomSnapshot: (ws, candidate, snapshotOptions) => calls.snapshots.push({ socket: ws, room: candidate, options: snapshotOptions }),
    setPlayerReadyForNextRound: (candidate, playerId, ready) => {
      candidate.readyForNextRoundPlayerIds = ready
        ? [...new Set([...candidate.readyForNextRoundPlayerIds, playerId])]
        : candidate.readyForNextRoundPlayerIds.filter((id) => id !== playerId);
    },
    syncPlayerPresence: (candidate, member) => {
      member.connected = [...candidate.clients].some((client) => client.playerId === member.id && client.visible !== false);
    }
  };
  const handler = createProtocolV2MessageHandler(options);
  return { ...host, room: roomValue, rooms, calls, options, handler };
}

function lastPayload(value: ReturnType<typeof harness>): Record<string, unknown> {
  return value.calls.json.at(-1)?.payload || {};
}

function completionRoom(playerCount: 2 | 4 | 8): ProtocolV2Room {
  const players = Array.from({ length: playerCount }, (_, index) =>
    player(playerIdAt(index), index === 0 ? 'Host' : `Player ${index + 1}`, index === 0)
  );
  let state = createMultiplayerGame(players, 1, null, () => 0.5);
  const remainingCards = [
    ...state.players.flatMap((item) => item.grid),
    ...state.drawPile,
    ...state.discardPile
  ].map((card) => ({ ...card, faceUp: false, removed: false }));
  const takeCard = (value: number) => {
    const index = remainingCards.findIndex((card) => card.value === value);
    if (index < 0) throw new Error(`Completion fixture is missing a ${value} card.`);
    return remainingCards.splice(index, 1)[0];
  };
  const hostGrid = [12, 12, 12, 12, 11, 11, 11, 11, 10, 10, 10, 10].map(takeCard);
  const closerGrid = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(takeCard);
  state.players = state.players.map((item, index) => ({
    ...item,
    grid: index === 0 ? hostGrid : index === 1 ? closerGrid : remainingCards.splice(0, 12),
    roundScore: 0
  }));
  const discard = remainingCards.pop();
  if (!discard) throw new Error('Completion fixture is missing a discard card.');
  state.drawPile = remainingCards;
  state.discardPile = [{ ...discard, faceUp: true }];
  state.openingRevealCounts = Object.fromEntries(players.map((item) => [item.id, 0]));
  for (let index = 0; index < playerCount * 2; index += 1) {
    const activePlayer = state.players[state.currentPlayerIndex];
    const cardIndex = activePlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
    if (cardIndex < 0) throw new Error('Completion fixture could not reveal an opening card.');
    state = revealOpeningCard(state, cardIndex);
  }
  state.players = state.players.map((item, index) => {
    if (index !== 1) return item;
    const grid = item.grid.map((card) => ({ ...card, faceUp: true }));
    return {
      ...item,
      grid,
      roundScore: grid.reduce((total, card) => total + card.value, 0)
    };
  });
  state = {
    ...state,
    currentPlayerIndex: 0,
    phase: 'choose-replacement',
    selectedSource: 'discard',
    drawnCard: null,
    roundCloserId: players[1].id,
    finalTurnPlayerIds: [players[0].id]
  };
  return room({
    gameSessionId: 'completion-session',
    players,
    revision: 7,
    state,
    status: 'playing'
  });
}

function privateCardIds(candidate: ProtocolV2Room): string[] {
  if (!candidate.state) return [];
  return [
    ...candidate.state.players.flatMap((item) => item.grid.map((card) => card.id)),
    ...candidate.state.drawPile.map((card) => card.id),
    ...candidate.state.discardPile.map((card) => card.id),
    ...(candidate.state.drawnCard ? [candidate.state.drawnCard.id] : [])
  ];
}

describe('protocol v2 room admission', () => {
  it.each([
    { type: 'update-state', state: {} },
    { type: 'command', protocolVersion: 1, commandId: COMMAND_ID, expectedRevision: 0, action: { type: 'start-game' } }
  ])('emits exactly one upgrade-required frame for legacy input', (message) => {
    const value = harness();
    value.handler(value.socket, message);
    expect(value.calls.json.map(({ payload }) => payload.type)).toEqual(['upgrade-required']);
  });

  it('strictly validates create requests and creates one server-owned host seat', () => {
    const value = harness();
    value.handler(value.socket, { type: 'create-room', protocolVersion: 2, name: 'ignored', extra: true });
    expect(lastPayload(value)).toMatchObject({ type: 'error', code: 'invalid-command' });

    value.handler(value.socket, { type: 'create-room', protocolVersion: 2, name: 'ignored' });
    const created = value.rooms.get('NEW01');
    expect(created?.players).toEqual([expect.objectContaining({ id: NEW_ID, name: 'Host', userId: `${HOST_ID}-account`, host: true })]);
    expect(value.socket).toMatchObject({ roomCode: 'NEW01', playerId: NEW_ID });
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.snapshots).toHaveLength(1);
  });

  it('emits an exact v2 create error without mutation or RNG when room-code allocation is unavailable', () => {
    const value = harness();
    value.options.makeRoomCodeForSocket = () => null;
    const handler = createProtocolV2MessageHandler(value.options);
    handler(value.socket, { type: 'create-room', protocolVersion: 2, name: 'Host' });

    expect(value.calls.json).toEqual([{
      socket: value.socket,
      payload: {
        type: 'error',
        protocolVersion: 2,
        code: 'room-code-unavailable',
        message: 'A room code could not be created. Try again.'
      }
    }]);
    expect([...value.rooms.keys()]).toEqual(['ROOM1']);
    expect(value.socket).toMatchObject({ roomCode: 'ROOM1', playerId: HOST_ID });
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.snapshots).toEqual([]);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
  });

  it.each([
    [{ type: 'join-room', protocolVersion: 2, code: 'MISS', name: 'x' }, 'room-not-found'],
    [{ type: 'join-room', protocolVersion: 2, presenceVersion: 2, code: 'ROOM1', name: 'x' }, 'invalid-command'],
    [{ type: 'join-room', protocolVersion: 2, code: 'ROOM1', name: 'x', playerId: HOST_ID, extra: true }, 'invalid-command']
  ])('rejects invalid join requests without mutation', (message, code) => {
    const value = harness();
    if (code === 'room-not-found') value.rooms.delete('ROOM1');
    value.handler(value.socket, message);
    expect(lastPayload(value)).toMatchObject({ type: 'error', code });
    expect(value.calls.persisted).toBe(0);
  });

  it('rejects stolen seats, late spectators, full rooms, and exhausted revisions', () => {
    const stolen = harness();
    const attacker = socket(HOST_ID, 'attacker', 'Attacker').socket;
    stolen.handler(attacker, { type: 'join-room', protocolVersion: 2, code: 'room1', name: 'ignored', playerId: HOST_ID });
    expect(lastPayload(stolen)).toMatchObject({ code: 'seat-forbidden' });

    const started = harness(room({ status: 'playing' }));
    const newcomer = socket('', 'new-account', 'New').socket;
    started.handler(newcomer, { type: 'join-room', protocolVersion: 2, code: 'ROOM1', name: 'ignored' });
    expect(lastPayload(started)).toMatchObject({ code: 'game-started' });

    const eight = Array.from({ length: 8 }, (_, index) => player(`p${index}`, `P${index}`, index === 0));
    const full = harness(room({ players: eight, hostId: 'p0' }));
    full.handler(newcomer, { type: 'join-room', protocolVersion: 2, code: 'ROOM1', name: 'ignored' });
    expect(lastPayload(full)).toMatchObject({ code: 'room-full' });

    const exhausted = harness(room({ revision: Number.MAX_SAFE_INTEGER }));
    exhausted.handler(newcomer, { type: 'join-room', protocolVersion: 2, code: 'ROOM1', name: 'ignored' });
    expect(lastPayload(exhausted)).toMatchObject({ code: 'revision-exhausted' });
  });

  it('adds a new seat with exactly one revision and broadcasts it', () => {
    const value = harness();
    const newcomer = socket('', 'new-account', 'New').socket;
    value.handler(newcomer, { type: 'join-room', protocolVersion: 2, code: ' room1 ', name: 'ignored' });
    expect(value.room.revision).toBe(1);
    expect(value.room.players.at(-1)).toMatchObject({ id: NEW_ID, userId: 'new-account', name: 'New', joinedAt: 500, lastSeenAt: 500 });
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
  });

  it('reconnects the same healthy seat without incrementing revision', () => {
    const value = harness();
    value.handler(value.socket, { type: 'join-room', protocolVersion: 2, code: 'room1', name: 'ignored', playerId: HOST_ID });
    expect(value.room.revision).toBe(0);
    expect(value.room.players[0].lastSeenAt).toBe(500);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toHaveLength(0);
    expect(value.calls.snapshots).toHaveLength(1);
  });

  it('preserves a hidden reconnect until the client explicitly reports visible presence', () => {
    const value = harness(room({
      players: [
        { ...player(HOST_ID, 'Host', true), connected: false, disconnectedAt: 100 },
        player(GUEST_ID, 'Guest')
      ]
    }));
    value.socket.visible = false;
    value.handler(value.socket, {
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      code: 'room1',
      name: 'ignored',
      playerId: HOST_ID
    });

    expect(value.socket.visible).toBe(false);
    expect(value.room.players[0]).toMatchObject({ connected: false, disconnectedAt: 100, lastSeenAt: 500 });
    expect(value.calls.broadcasts).toHaveLength(0);
    expect(value.calls.snapshots).toHaveLength(1);
  });

  it('broadcasts reconnects whose public presence or account name changed', () => {
    const value = harness(room({ players: [{ ...player(HOST_ID, 'Old', true), connected: false }, player(GUEST_ID, 'Guest')] }));
    value.handler(value.socket, { type: 'join-room', protocolVersion: 2, code: 'ROOM1', name: 'ignored', playerId: HOST_ID });
    expect(value.room.revision).toBe(0);
    expect(value.room.players[0]).toMatchObject({ name: 'Host', connected: true });
    expect(value.calls.broadcasts).toEqual([value.room]);
  });

  it('rebuilds the persisted alias index and reserves only live lineage codes', () => {
    const target = resetRecoveryTarget();
    const rooms = new Map([[target.code, target]]);
    const index = createResetAliasIndex(rooms);
    expect(index.get('OLD01')).toEqual([{ alias: target.resetAliases[0], targetCode: 'NEW01' }]);
    expect(isResetAliasCodeReserved(index, 'OLD01', 500)).toBe(true);
    expect(isResetAliasCodeReserved(index, 'OLD01', 900)).toBe(false);
    target.resetAliases.push({
      fromCode: 'OLDER',
      commandId: OTHER_COMMAND_ID,
      playerId: HOST_ID,
      expiresAt: 901
    });
    rebuildResetAliasIndex(index, rooms);
    expect(index.has('OLDER')).toBe(true);
  });

  it('recovers a reset host after restart without changing revision, then resyncs before receipt ack', () => {
    const target = resetRecoveryTarget();
    const value = harness(target);
    target.clients.clear();
    const order: string[] = [];
    value.options.resetAliasIndex = createResetAliasIndex(value.rooms);
    value.options.sendRoomSnapshot = (_socket, _room, snapshotOptions) => order.push(`resync:${snapshotOptions?.commandId}`);
    value.options.sendJson = (_socket, payload) => {
      const frame = payload as Record<string, unknown>;
      order.push(`${String(frame.type)}:${String(frame.commandId || frame.code)}`);
    };
    const handler = createProtocolV2MessageHandler(value.options);
    handler(value.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: 'OLD01',
      name: 'ignored',
      playerId: HOST_ID,
      recoveryCommandId: COMMAND_ID
    });
    expect(order).toEqual([`resync:${COMMAND_ID}`, `ack:${COMMAND_ID}`]);
    expect(value.socket).toMatchObject({ roomCode: 'NEW01', playerId: HOST_ID });
    expect(target).toMatchObject({ revision: 1, updatedAt: 500 });
    expect(value.calls.persisted).toBe(1);
  });

  it('serializes, reloads, and recovers a reset after 129 later commands', () => {
    const value = harness();
    value.handler(value.socket, command({ type: 'reset-room' }));
    const target = value.rooms.get('NEW01');
    if (!target) throw new Error('Reset target was not created.');
    for (let index = 2; index <= 130; index += 1) {
      value.handler(value.socket, command(
        { type: 'send-chat-message', text: `message-${index}` },
        target.revision,
        commandIdAt(index)
      ));
    }

    expect(target.recentCommandIds).toHaveLength(MAX_RECENT_COMMAND_RECEIPTS);
    expect(target.recentCommandIds.some((item) => item.commandId === COMMAND_ID)).toBe(true);
    expect(target.recentCommandIds.some((item) => item.commandId === commandIdAt(2))).toBe(false);
    target.recentCommandIds = target.recentCommandIds.map((item) => ({
      ...item,
      actionDigest: item.commandId === COMMAND_ID
        ? persistedDigest(JSON.stringify({ type: 'reset-room' }))
        : 'b'.repeat(64)
    }));

    const document = serializeRooms(new Map([[target.code, target]]), 500);
    expect(document.rooms[0].recentCommandIds).toHaveLength(MAX_RECENT_COMMAND_RECEIPTS);
    const restored = normalizeRoomsDocument(document, { now: 500, pruneStale: false }).rooms[0] as ProtocolV2Room;
    const recovery = harness(restored);
    const recoveryHandler = createProtocolV2MessageHandler({
      ...recovery.options,
      digestAction: persistedDigest,
      resetAliasIndex: createResetAliasIndex(recovery.rooms)
    });
    recoveryHandler(recovery.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: 'ROOM1',
      name: 'ignored',
      playerId: HOST_ID,
      recoveryCommandId: COMMAND_ID
    });

    expect(recovery.calls.snapshots.at(-1)).toMatchObject({
      room: { code: 'NEW01', revision: 130 },
      options: { type: 'resync', commandId: COMMAND_ID, reason: 'room-reset' }
    });
    expect(lastPayload(recovery)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 1 });

    const beforeReplay = serializeRooms(recovery.rooms, 500);
    recovery.calls.snapshots.length = 0;
    recovery.calls.json.length = 0;
    recovery.calls.broadcasts.length = 0;
    recovery.calls.persisted = 0;
    recovery.calls.notified = 0;
    recovery.calls.randomValues.length = 0;
    recovery.calls.uuidValues.length = 0;
    recoveryHandler(recovery.socket, command({ type: 'reset-room' }, 0, COMMAND_ID));

    expect(serializeRooms(recovery.rooms, 500)).toEqual(beforeReplay);
    expect(recovery.calls.snapshots).toEqual([{
      socket: recovery.socket,
      room: restored,
      options: undefined
    }]);
    expect(recovery.calls.json).toEqual([{
      socket: recovery.socket,
      payload: {
        type: 'ack',
        protocolVersion: 2,
        commandId: COMMAND_ID,
        revision: 1
      }
    }]);
    expect(recovery.calls.persisted).toBe(0);
    expect(recovery.calls.broadcasts).toEqual([]);
    expect(recovery.calls.notified).toBe(0);
    expect(recovery.calls.randomValues).toEqual([]);
    expect(recovery.calls.uuidValues).toEqual([]);
  });

  it('never lets a recovery hint fall through to a recycled direct room code', () => {
    const target = resetRecoveryTarget({
      resetAliases: [{ fromCode: 'OLD01', commandId: COMMAND_ID, playerId: HOST_ID, expiresAt: 499 }]
    });
    const recycled = room({ code: 'OLD01' });
    const value = harness(target);
    value.rooms.set(recycled.code, recycled);
    value.options.resetAliasIndex = createResetAliasIndex(value.rooms);
    createProtocolV2MessageHandler(value.options)(value.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: 'OLD01',
      name: 'ignored',
      playerId: HOST_ID,
      recoveryCommandId: COMMAND_ID
    });
    expect(lastPayload(value)).toMatchObject({ code: 'stale-room' });
    expect(value.socket.roomCode).not.toBe('OLD01');
    expect(recycled.clients.size).toBe(0);
  });

  it.each([
    ['manual old invite', {}, {}],
    ['saved seat without hint', { playerId: HOST_ID }, {}],
    ['wrong account', { playerId: HOST_ID, recoveryCommandId: COMMAND_ID }, { accountId: 'attacker' }],
    ['wrong seat', { playerId: GUEST_ID, recoveryCommandId: COMMAND_ID }, {}],
    ['wrong command id', { playerId: HOST_ID, recoveryCommandId: OTHER_COMMAND_ID }, {}],
    ['expired alias', { playerId: HOST_ID, recoveryCommandId: COMMAND_ID }, { expiresAt: 499 }],
    ['missing receipt', { playerId: HOST_ID, recoveryCommandId: COMMAND_ID }, { recentCommandIds: [] }],
    [
      'non-reset receipt',
      { playerId: HOST_ID, recoveryCommandId: COMMAND_ID },
      { recentCommandIds: [receipt({ type: 'start-game' })] }
    ]
  ])('returns one target-free stale-room error for reset recovery mismatch: %s', (_name, joinFields, setup) => {
    const config = setup as {
      accountId?: string;
      expiresAt?: number;
      recentCommandIds?: CommandReceipt[];
    };
    const target = resetRecoveryTarget({
      ...(config.expiresAt === undefined
        ? {}
        : { resetAliases: [{ fromCode: 'OLD01', commandId: COMMAND_ID, playerId: HOST_ID, expiresAt: config.expiresAt }] }),
      ...(config.recentCommandIds === undefined ? {} : { recentCommandIds: config.recentCommandIds })
    });
    const value = harness(target);
    value.socket.accountUser = {
      id: config.accountId || `${HOST_ID}-account`,
      displayName: 'Host'
    };
    value.options.resetAliasIndex = createResetAliasIndex(value.rooms);
    const handler = createProtocolV2MessageHandler(value.options);
    handler(value.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: 'OLD01',
      name: 'ignored',
      ...joinFields
    });
    expect(value.calls.json).toHaveLength(1);
    expect(lastPayload(value)).toMatchObject({ type: 'error', code: 'stale-room' });
    expect(JSON.stringify(lastPayload(value))).not.toContain('NEW01');
    expect(value.calls.snapshots).toHaveLength(0);
    expect(target.revision).toBe(1);
  });

  it('fails closed when an indexed reset target disappears or recovery becomes ambiguous', () => {
    for (const mutate of [
      (value: ReturnType<typeof harness>, index: ReturnType<typeof createResetAliasIndex>) => {
        void index;
        return value.rooms.delete('NEW01');
      },
      (_value: ReturnType<typeof harness>, index: ReturnType<typeof createResetAliasIndex>) => {
        index.get('OLD01')?.push({ ...index.get('OLD01')![0] });
      }
    ]) {
      const target = resetRecoveryTarget();
      const value = harness(target);
      const index = createResetAliasIndex(value.rooms);
      mutate(value, index);
      value.options.resetAliasIndex = index;
      createProtocolV2MessageHandler(value.options)(value.socket, {
        type: 'join-room',
        protocolVersion: 2,
        code: 'OLD01',
        name: 'ignored',
        playerId: HOST_ID,
        recoveryCommandId: COMMAND_ID
      });
      expect(lastPayload(value)).toMatchObject({ code: 'stale-room' });
      expect(JSON.stringify(lastPayload(value))).not.toContain('NEW01');
    }
  });

  it('allows recoveryCommandId only alongside an exact saved player seat', () => {
    const value = harness(resetRecoveryTarget());
    value.handler(value.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: 'OLD01',
      name: 'ignored',
      recoveryCommandId: COMMAND_ID
    });
    expect(lastPayload(value)).toMatchObject({ code: 'invalid-command' });
  });
});

describe('protocol v2 resilient seat lifecycle commands', () => {
  it('removes a waiting player terminally and never recreates a supplied stale seat', () => {
    const value = harness();
    const guest = socket(GUEST_ID, `${GUEST_ID}-account`, 'Guest');
    value.room.clients.add(guest.socket);
    value.room.chatMessages = [{ id: 'guest-chat', playerId: GUEST_ID, playerName: 'Guest', text: 'bye', createdAt: 100 }];
    value.room.readyForNextRoundPlayerIds = [GUEST_ID];

    value.handler(guest.socket, command({ type: 'leave-room' }));

    expect(value.room.players.map((candidate) => candidate.id)).toEqual([HOST_ID]);
    expect(value.room.chatMessages).toEqual([]);
    expect(value.room.readyForNextRoundPlayerIds).toEqual([]);
    expect(guest.socket).toMatchObject({ roomCode: null, playerId: null });
    expect(value.calls.json.at(-1)).toMatchObject({
      socket: guest.socket,
      payload: { type: 'ack', commandId: COMMAND_ID, revision: 1, result: 'room-left' }
    });

    const reconnect = socket(GUEST_ID, `${GUEST_ID}-account`, 'Guest');
    value.handler(reconnect.socket, {
      type: 'join-room',
      protocolVersion: 2,
      code: value.room.code,
      name: 'Guest',
      playerId: GUEST_ID
    });
    expect(value.room.players).toHaveLength(1);
    expect(value.calls.json.at(-1)?.payload).toMatchObject({ code: 'stale-seat' });
  });

  it('lets the canonical host remove a non-host and purges every owned reference', () => {
    const guestReceipt = receipt(
      { type: 'send-chat-message', text: 'guest' },
      { playerId: GUEST_ID, commandId: OTHER_COMMAND_ID }
    );
    const value = harness(room({
      chatMessages: [{ id: 'guest-chat', playerId: GUEST_ID, playerName: 'Guest', text: 'guest', createdAt: 100 }],
      readyForNextRoundPlayerIds: [GUEST_ID],
      recentCommandIds: [guestReceipt],
      resetAliases: [{ fromCode: 'OLD01', commandId: OTHER_COMMAND_ID, playerId: GUEST_ID, expiresAt: 900 }]
    }));
    const guest = socket(GUEST_ID, `${GUEST_ID}-account`, 'Guest');
    value.room.clients.add(guest.socket);

    value.handler(value.socket, command({ type: 'remove-player', playerId: GUEST_ID }));

    expect(value.room.players.map((candidate) => candidate.id)).toEqual([HOST_ID]);
    expect(value.room.chatMessages).toEqual([]);
    expect(value.room.readyForNextRoundPlayerIds).toEqual([]);
    expect(value.room.resetAliases).toEqual([]);
    expect(value.room.recentCommandIds).toEqual([expect.objectContaining({ commandId: COMMAND_ID, playerId: HOST_ID })]);
    expect(value.room.revision).toBe(1);
    expect(value.calls.json).toEqual(expect.arrayContaining([
      expect.objectContaining({ socket: guest.socket, payload: expect.objectContaining({ code: 'seat-removed' }) }),
      expect.objectContaining({ socket: value.socket, payload: expect.objectContaining({ type: 'ack', commandId: COMMAND_ID }) })
    ]));
  });

  it('starts with connected humans only and rejects an aggregate-away host command', () => {
    const awayId = NEW_ID;
    const value = harness(room({
      players: [
        player(HOST_ID, 'Host', true),
        player(GUEST_ID, 'Guest'),
        player(awayId, 'Away', false, `${awayId}-account`)
      ]
    }));
    value.room.players[2].connected = false;
    value.room.players[2].disconnectedAt = 100;
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(value.room.players.map((candidate) => candidate.id)).toEqual([HOST_ID, GUEST_ID]);
    expect(value.room.state?.players.map((candidate) => candidate.id)).toEqual([HOST_ID, GUEST_ID]);
    expect(value.room.players.filter((candidate) => candidate.host).map((candidate) => candidate.id)).toEqual([HOST_ID]);

    const hiddenHost = harness(room({
      players: [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest'), player(NEW_ID, 'Other')]
    }));
    hiddenHost.room.players[0].connected = false;
    hiddenHost.room.players[0].disconnectedAt = 100;
    hiddenHost.handler(hiddenHost.socket, command({ type: 'start-game' }));
    expect(lastPayload(hiddenHost)).toMatchObject({ code: 'player-away' });
    expect(hiddenHost.room.status).toBe('waiting');
    expect(hiddenHost.room.players.filter((candidate) => candidate.host).map((candidate) => candidate.id)).toEqual([HOST_ID]);
  });

  it('rejects a second room admission from a socket already admitted by this handler', () => {
    const empty = harness();
    const fresh = socket(HOST_ID, `${HOST_ID}-account`, 'Host');
    fresh.socket.roomCode = null;
    fresh.socket.playerId = null;
    empty.handler(fresh.socket, { type: 'create-room', protocolVersion: 2, name: 'Host' });
    expect(fresh.socket.admittedRoomCode).toBe('NEW01');
    empty.handler(fresh.socket, { type: 'create-room', protocolVersion: 2, name: 'Host' });
    expect(empty.calls.json.at(-1)?.payload).toMatchObject({ code: 'already-in-room' });
  });

  it('takes over only after grace and commits a complete AI turn in one fenced revision', () => {
    const players = [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')];
    const state = createMultiplayerGame(players, 1, null, () => 0.5);
    state.phase = 'choose-source';
    state.currentPlayerIndex = 1;
    state.openingRevealCounts = { [HOST_ID]: 2, [GUEST_ID]: 2 };
    const target = room({ state, status: 'playing', players });
    target.players[1].connected = false;
    target.players[1].disconnectedAt = 1_000;
    const value = harness(target);
    let timestamp = 1_000 + ACTIVE_PLAYER_GRACE_MS - 1;
    value.options.now = () => timestamp;
    const handler = createProtocolV2MessageHandler(value.options);

    handler(value.socket, command({ type: 'takeover-player-with-ai', playerId: GUEST_ID }));
    expect(lastPayload(value)).toMatchObject({ code: 'takeover-unavailable' });
    expect(target.revision).toBe(0);

    timestamp += 1;
    handler(value.socket, command({ type: 'takeover-player-with-ai', playerId: GUEST_ID }));
    expect(target.players[1]).toMatchObject({ id: GUEST_ID, controller: 'ai', connected: false });
    expect(target.revision).toBe(1);
    expect(handler.executeAutomatedAction({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: 1,
      playerId: GUEST_ID,
      roomCode: target.code
    })).toBe(true);
    expect(target.revision).toBe(2);
    expect(target.state).toMatchObject({ selectedSource: null, drawnCard: null });
    expect(target.state?.players.find((candidate) => candidate.id === GUEST_ID)?.kind).toBe('human');
    expect(value.calls.broadcasts).toEqual([target, target]);
    expect(handler.executeAutomatedAction({
      commandId: commandIdAt(99),
      expectedRevision: 1,
      playerId: GUEST_ID,
      roomCode: target.code
    })).toBe(false);
  });

  it('auto-readies every AI-controlled seat at round-over in one fenced revision', () => {
    const thirdId = playerIdAt(3);
    const players = [
      player(HOST_ID, 'Host', true),
      { ...player(GUEST_ID, 'Guest'), controller: 'ai' as const },
      { ...player(thirdId, 'Third'), controller: 'ai' as const }
    ];
    const state = createMultiplayerGame(players, 1, null, () => 0.5);
    state.phase = 'round-over';
    const target = room({ players, state, status: 'playing' });
    const value = harness(target);
    const handler = createProtocolV2MessageHandler(value.options);

    expect(handler.executeAutomatedAction({
      commandId: OTHER_COMMAND_ID,
      expectedRevision: 0,
      playerId: GUEST_ID,
      roomCode: target.code
    })).toBe(true);

    expect(target.readyForNextRoundPlayerIds).toEqual([GUEST_ID, thirdId]);
    expect(target.revision).toBe(1);
    expect(target.recentCommandIds).toEqual([expect.objectContaining({
      commandId: OTHER_COMMAND_ID,
      playerId: GUEST_ID,
      revision: 1
    })]);
    expect(target.state?.players.every((candidate) => candidate.kind === 'human')).toBe(true);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([target]);
    expect(handler.executeAutomatedAction({
      commandId: commandIdAt(99),
      expectedRevision: 0,
      playerId: thirdId,
      roomCode: target.code
    })).toBe(false);
  });
});

describe('protocol v2 command ordering and receipts', () => {
  it('keeps every alias-pinned receipt and fills the remaining total window with newest unpinned receipts', () => {
    const aliases = Array.from({ length: MAX_RESET_ALIASES }, (_, index) => ({
      commandId: commandIdAt(index + 1)
    }));
    const receipts = Array.from({ length: MAX_RECENT_COMMAND_RECEIPTS + MAX_RESET_ALIASES }, (_, index) =>
      receipt(
        { type: 'send-chat-message', text: `message-${index + 1}` },
        {
          commandId: commandIdAt(index + 1),
          expectedRevision: index,
          revision: index + 1
        }
      )
    );

    const retained = retainCommandReceiptsForResetAliases(receipts, aliases);
    expect(retained).toHaveLength(MAX_RECENT_COMMAND_RECEIPTS);
    expect(aliases.every((alias) => retained.some((item) => item.commandId === alias.commandId))).toBe(true);
    expect(retained.filter((item) => !aliases.some((alias) => alias.commandId === item.commandId))).toHaveLength(
      MAX_RECENT_COMMAND_RECEIPTS - MAX_RESET_ALIASES
    );
    expect(retained.map((item) => item.revision)).toEqual([
      ...Array.from({ length: MAX_RESET_ALIASES }, (_, index) => index + 1),
      ...Array.from(
        { length: MAX_RECENT_COMMAND_RECEIPTS - MAX_RESET_ALIASES },
        (_, index) => index + (MAX_RESET_ALIASES * 2) + 1
      )
    ]);
  });

  it('prunes expired aliases and evicts their newly unpinned receipt in the same accepted command', () => {
    const resetReceipt = receipt({ type: 'reset-room' });
    const ordinaryReceipts = Array.from({ length: MAX_RECENT_COMMAND_RECEIPTS }, (_, index) =>
      receipt(
        { type: 'send-chat-message', text: `message-${index + 2}` },
        {
          commandId: commandIdAt(index + 2),
          expectedRevision: index + 1,
          revision: index + 2
        }
      )
    );
    const target = resetRecoveryTarget({
      revision: MAX_RECENT_COMMAND_RECEIPTS + 1,
      recentCommandIds: [resetReceipt, ...ordinaryReceipts],
      resetAliases: [{
        fromCode: 'OLD01',
        commandId: COMMAND_ID,
        playerId: HOST_ID,
        expiresAt: 499
      }]
    });
    const value = harness(target);
    target.players[0].connected = true;
    target.players[0].disconnectedAt = null;
    value.socket.roomCode = target.code;
    const aliasIndex = createResetAliasIndex(value.rooms);
    const handler = createProtocolV2MessageHandler({ ...value.options, resetAliasIndex: aliasIndex });
    handler(value.socket, command(
      { type: 'send-chat-message', text: 'after expiry' },
      target.revision,
      commandIdAt(MAX_RECENT_COMMAND_RECEIPTS + 2)
    ));

    expect(target.resetAliases).toEqual([]);
    expect(aliasIndex.has('OLD01')).toBe(false);
    expect(target.recentCommandIds).toHaveLength(MAX_RECENT_COMMAND_RECEIPTS);
    expect(target.recentCommandIds.some((item) => item.commandId === COMMAND_ID)).toBe(false);
    expect(target.recentCommandIds.map((item) => item.revision)).toEqual(
      Array.from({ length: MAX_RECENT_COMMAND_RECEIPTS }, (_, index) => index + 3)
    );
  });

  it('fails closed for malformed commands and commands before admission', () => {
    const value = harness();
    value.handler(value.socket, { type: 'wat' });
    expect(lastPayload(value)).toMatchObject({ code: 'invalid-command' });
    value.socket.roomCode = null;
    value.socket.playerId = null;
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(lastPayload(value)).toMatchObject({ code: 'room-required', commandId: COMMAND_ID });
  });

  it('checks an exact duplicate before revision and returns snapshot then original ack', () => {
    const action: GameCommand = { type: 'send-chat-message', text: 'hello' };
    const value = harness(room({ revision: 8, recentCommandIds: [receipt(action)] }));
    const order: string[] = [];
    value.options.sendRoomSnapshot = () => order.push('snapshot');
    value.options.sendJson = (_ws, payload) => order.push(String((payload as Record<string, unknown>).type));
    createProtocolV2MessageHandler(value.options)(value.socket, command(action, 0));
    expect(order).toEqual(['snapshot', 'ack']);
    expect(value.room.revision).toBe(8);
    expect(value.calls.persisted).toBe(0);
  });

  it.each([
    ['away', { connected: false, disconnectedAt: 100 }],
    ['AI-controlled', { controller: 'ai' as const }]
  ])('replays an exact receipt for an %s seat before live-human guards', (_label, seatState) => {
    const action: GameCommand = { type: 'send-chat-message', text: 'hello' };
    const host = { ...player(HOST_ID, 'Host', true), ...seatState };
    const value = harness(room({
      players: [host, player(GUEST_ID, 'Guest')],
      revision: 8,
      recentCommandIds: [receipt(action)]
    }));
    const order: string[] = [];
    value.options.sendRoomSnapshot = () => order.push('snapshot');
    value.options.sendJson = (_ws, payload) => order.push(String((payload as Record<string, unknown>).type));

    createProtocolV2MessageHandler(value.options)(value.socket, command(action, 0));

    expect(order).toEqual(['snapshot', 'ack']);
    expect(value.room.revision).toBe(8);
    expect(value.calls.persisted).toBe(0);
  });

  it.each([
    ['away', { connected: false, disconnectedAt: 100 }],
    ['AI-controlled', { controller: 'ai' as const }]
  ])('rejects a conflicting command id for an %s seat before live-human guards', (_label, seatState) => {
    const priorAction: GameCommand = { type: 'send-chat-message', text: 'original' };
    const host = { ...player(HOST_ID, 'Host', true), ...seatState };
    const value = harness(room({
      players: [host, player(GUEST_ID, 'Guest')],
      revision: 8,
      recentCommandIds: [receipt(priorAction)]
    }));

    value.handler(value.socket, command({ type: 'send-chat-message', text: 'conflict' }, 0));

    expect(lastPayload(value)).toMatchObject({ code: 'command-id-conflict', commandId: COMMAND_ID });
    expect(value.calls.snapshots).toHaveLength(0);
    expect(value.room.revision).toBe(8);
  });

  it.each([
    receipt({ type: 'send-chat-message', text: 'hello' }, { playerId: GUEST_ID }),
    receipt({ type: 'send-chat-message', text: 'hello' }, { expectedRevision: 7 }),
    receipt({ type: 'send-chat-message', text: 'different' })
  ])('binds command ids to the original seat, revision, and action digest', (prior) => {
    const action: GameCommand = { type: 'send-chat-message', text: 'hello' };
    const value = harness(room({ revision: 8, recentCommandIds: [prior] }));
    value.handler(value.socket, command(action, 0));
    expect(lastPayload(value)).toMatchObject({ code: 'command-id-conflict', commandId: COMMAND_ID });
    expect(value.calls.snapshots).toHaveLength(0);
  });

  it.each([
    [3, 2, 'stale-revision'],
    [3, 4, 'future-revision']
  ])('resyncs stale and future commands without mutation', (revision, expectedRevision, reason) => {
    const value = harness(room({ revision }));
    value.handler(value.socket, command({ type: 'send-chat-message', text: 'hello' }, expectedRevision));
    expect(value.calls.snapshots).toEqual([{ socket: value.socket, room: value.room, options: { type: 'resync', commandId: COMMAND_ID, reason } }]);
    expect(value.room.revision).toBe(revision);
    expect(value.calls.persisted).toBe(0);
  });

  it('rejects new commands when the revision counter is exhausted', () => {
    const value = harness(room({ revision: Number.MAX_SAFE_INTEGER }));
    value.handler(value.socket, command({ type: 'send-chat-message', text: 'hello' }, Number.MAX_SAFE_INTEGER));
    expect(lastPayload(value)).toMatchObject({ code: 'revision-exhausted' });
  });

  it('commits a legal command exactly once before broadcast and ack', () => {
    const value = harness();
    const order: string[] = [];
    value.options.persistRoomsSoon = () => order.push('persist');
    value.options.broadcastRoom = () => order.push('broadcast');
    value.options.sendJson = (_ws, payload) => order.push(String((payload as Record<string, unknown>).type));
    createProtocolV2MessageHandler(value.options)(value.socket, command({ type: 'send-chat-message', text: ' hello ' }));
    expect(value.room).toMatchObject({ revision: 1, updatedAt: 500 });
    expect(value.room.chatMessages).toEqual([expect.objectContaining({ text: 'hello', playerId: HOST_ID })]);
    expect(value.room.recentCommandIds).toEqual([expect.objectContaining({ commandId: COMMAND_ID, revision: 1, expectedRevision: 0 })]);
    expect(order).toEqual(['persist', 'broadcast', 'ack']);
  });

  it('isolates a throwing peer send and still delivers the committed broadcast to another peer', () => {
    const value = harness();
    const broken = socket(GUEST_ID).socket;
    broken.send = vi.fn(() => { throw new Error('peer failed'); });
    const healthy = socket(GUEST_ID).socket;
    value.room.clients = new Set([broken, healthy]);
    value.options.broadcastRoom = (candidate) => {
      for (const client of candidate.clients) sendRealtimeJson(client, { type: 'snapshot', revision: candidate.revision });
    };
    createProtocolV2MessageHandler(value.options)(value.socket, command({ type: 'send-chat-message', text: 'hello' }));
    expect(broken.send).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledOnce();
    expect(JSON.parse((healthy.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatchObject({ revision: 1 });
  });
});

describe('protocol v2 completed-game atomicity', () => {
  const playerCounts = [2, 4, 8] as const;

  it.each(playerCounts)('commits a genuine %i-player completion once and redacts every final snapshot', (playerCount) => {
    const target = completionRoom(playerCount);
    expect(() => normalizeRoomsDocument(serializeRooms(new Map([[target.code, target]]), 500), {
      now: 500,
      pruneStale: false
    })).not.toThrow();
    const value = harness(target);
    for (let index = 1; index < playerCount; index += 1) {
      const member = target.players[index];
      target.clients.add(socket(member.id, member.userId || '', member.name).socket);
    }
    const finalSnapshots: ReturnType<typeof createRoomSnapshot>[] = [];
    value.options.broadcastRoom = (candidate) => {
      value.calls.broadcasts.push(candidate);
      for (const client of candidate.clients) {
        if (client.playerId) finalSnapshots.push(createRoomSnapshot(candidate, client.playerId));
      }
    };
    value.options.digestAction = persistedDigest;
    const handler = createProtocolV2MessageHandler(value.options);
    const action: GameCommand = { type: 'replace-card', cardIndex: 0 };
    const firstCommand = command(action, 7, COMMAND_ID);

    handler(value.socket, firstCommand);

    expect(value.room).toMatchObject({
      completedGameId: 'completed-1',
      revision: 8,
      status: 'finished',
      updatedAt: 500
    });
    expect(value.room.state).toMatchObject({
      phase: 'game-over',
      finalTurnPlayerIds: [],
      roundCloserId: null,
      roundHistory: [expect.objectContaining({ round: 1 })]
    });
    expect(value.room.state?.roundHistory[0].scores).toHaveLength(playerCount);
    expect(value.room.recentCommandIds).toEqual([
      expect.objectContaining({
        commandId: COMMAND_ID,
        expectedRevision: 7,
        playerId: HOST_ID,
        revision: 8
      })
    ]);
    expect(value.calls.completed).toHaveLength(1);
    expect(value.calls.completed[0]).toMatchObject({
      createdByUserId: `${HOST_ID}-account`,
      mode: 'multi',
      playerAccounts: Object.fromEntries(
        target.players.map((member) => [member.id, member.userId || null])
      ),
      roomCode: 'ROOM1',
      sourceKey: 'multi:completion-session',
      state: { phase: 'game-over' }
    });
    expect(value.calls.completed[0].state).toBe(value.room.state);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(lastPayload(value)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 8 });
    expect(() => normalizeRoomsDocument(serializeRooms(value.rooms, 500), {
      now: 500,
      pruneStale: false
    })).not.toThrow();

    expect(finalSnapshots).toHaveLength(playerCount);
    const wireJson = JSON.stringify(finalSnapshots);
    for (const snapshot of finalSnapshots) {
      expect(isMultiplayerRoomSnapshot(snapshot, target.code)).toBe(true);
      expect(snapshot).toMatchObject({
        completedGameId: 'completed-1',
        revision: 8,
        status: 'finished',
        state: {
          drawnCard: null,
          phase: 'game-over'
        }
      });
      expect(snapshot).not.toHaveProperty('clients');
      expect(snapshot).not.toHaveProperty('gameSessionId');
      expect(snapshot).not.toHaveProperty('recentCommandIds');
      expect(snapshot).not.toHaveProperty('resetAliases');
      expect(snapshot.state).not.toHaveProperty('drawPile');
      expect(snapshot.state).toHaveProperty('drawPileCount');
      expect(snapshot.state).toHaveProperty('discardPile');
      for (const member of snapshot.players) expect(member).not.toHaveProperty('userId');
    }
    expect(wireJson).not.toContain('completion-session');
    expect(wireJson).not.toContain('multi:completion-session');
    for (const member of target.players) expect(wireJson).not.toContain(member.userId || 'missing-account');
    for (const cardId of privateCardIds(value.room)) expect(wireJson).not.toContain(cardId);

    handler(value.socket, firstCommand);
    expect(value.calls.snapshots.at(-1)).toEqual({
      socket: value.socket,
      room: value.room,
      options: undefined
    });
    expect(lastPayload(value)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 8 });
    handler(value.socket, command(action, 7, OTHER_COMMAND_ID));
    expect(value.calls.snapshots.at(-1)).toEqual({
      socket: value.socket,
      room: value.room,
      options: { type: 'resync', commandId: OTHER_COMMAND_ID, reason: 'stale-revision' }
    });
    expect(value.room.revision).toBe(8);
    expect(value.calls.completed).toHaveLength(1);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toHaveLength(1);
    expect(value.calls.notified).toBe(1);
    expect(finalSnapshots).toHaveLength(playerCount);
  });

  it('attributes terminal history to AI only while an AI controller still owns a seat', () => {
    const aiOwned = harness(completionRoom(2));
    aiOwned.room.players[1].controller = 'ai';
    createProtocolV2MessageHandler(aiOwned.options)(
      aiOwned.socket,
      command({ type: 'replace-card', cardIndex: 0 }, 7, COMMAND_ID)
    );
    expect(aiOwned.calls.completed[0]?.finishedByAi).toBe(true);
    expect(aiOwned.room.finishedByAi).toBe(true);
    expect(aiOwned.room.readyForNextRoundPlayerIds).toEqual([GUEST_ID]);
    expect(aiOwned.room.state?.players.every((candidate) => candidate.kind === 'human')).toBe(true);

    const reclaimed = harness(completionRoom(2));
    reclaimed.room.players[1].controller = 'human';
    createProtocolV2MessageHandler(reclaimed.options)(
      reclaimed.socket,
      command({ type: 'replace-card', cardIndex: 0 }, 7, OTHER_COMMAND_ID)
    );
    expect(reclaimed.calls.completed[0]?.finishedByAi).toBe(false);
    expect(reclaimed.room.finishedByAi).toBe(false);
  });

  it('uses the trusted semantic match flag when journal object keys are reordered', () => {
    const value = harness(completionRoom(2));
    value.options.recordCompletedGame = (input) => {
      value.calls.completed.push(input);
      const reorderedState = Object.fromEntries(
        Object.entries(input.state).reverse()
      ) as typeof input.state;
      reorderedState.players = input.state.players.map((item) =>
        Object.fromEntries(Object.entries(item).reverse()) as typeof item
      );
      expect(JSON.stringify(reorderedState)).not.toBe(JSON.stringify(input.state));
      return { id: 'completed-reordered', recovered: false, state: reorderedState };
    };
    const handler = createProtocolV2MessageHandler(value.options);

    handler(value.socket, command({ type: 'replace-card', cardIndex: 0 }, 7, COMMAND_ID));

    expect(value.room).toMatchObject({
      completedGameId: 'completed-reordered',
      revision: 8,
      status: 'finished'
    });
    expect(value.room.recentCommandIds).toEqual([
      expect.objectContaining({ commandId: COMMAND_ID, expectedRevision: 7, revision: 8 })
    ]);
    expect(value.calls.completed).toHaveLength(1);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(value.calls.snapshots).toEqual([]);
    expect(lastPayload(value)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 8 });
  });

  it('rolls back a failed history write completely and lets the exact command retry once', () => {
    const value = harness(completionRoom(4));
    const beforeDocument = serializeRooms(value.rooms, 500);
    const beforeState = value.room.state;
    const beforeClients = [...value.room.clients];
    let attempts = 0;
    value.options.recordCompletedGame = (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error('database unavailable');
      value.calls.completed.push(input);
      return { id: 'completed-after-retry', recovered: false, state: input.state };
    };
    const handler = createProtocolV2MessageHandler(value.options);
    const retryable = command({ type: 'replace-card', cardIndex: 0 }, 7, COMMAND_ID);

    handler(value.socket, retryable);

    expect(attempts).toBe(1);
    expect(value.calls.completed).toEqual([]);
    expect(value.calls.completionErrors).toEqual([expect.objectContaining({ message: 'database unavailable' })]);
    expect(lastPayload(value)).toMatchObject({
      type: 'error',
      code: 'history-save-failed',
      commandId: COMMAND_ID
    });
    expect(value.room.state).toBe(beforeState);
    expect([...value.room.clients]).toEqual(beforeClients);
    expect(serializeRooms(value.rooms, 500)).toEqual(beforeDocument);
    expect(value.room).toMatchObject({ completedGameId: null, revision: 7, recentCommandIds: [] });
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.notified).toBe(0);
    expect(value.calls.snapshots).toEqual([]);

    handler(value.socket, retryable);

    expect(attempts).toBe(2);
    expect(value.calls.completed).toHaveLength(1);
    expect(value.calls.completed[0]).toMatchObject({
      sourceKey: 'multi:completion-session',
      state: { phase: 'game-over' }
    });
    expect(value.room).toMatchObject({
      completedGameId: 'completed-after-retry',
      revision: 8,
      status: 'finished'
    });
    expect(value.room.recentCommandIds).toEqual([
      expect.objectContaining({ commandId: COMMAND_ID, expectedRevision: 7, revision: 8 })
    ]);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(lastPayload(value)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 8 });
  });

  it('fails closed without a durable game session identity instead of reusing the room code', () => {
    const target = completionRoom(2);
    target.gameSessionId = null;
    const value = harness(target);
    const beforeDocument = serializeRooms(value.rooms, 500);
    const beforeState = value.room.state;

    value.handler(value.socket, command({ type: 'replace-card', cardIndex: 0 }, 7, COMMAND_ID));

    expect(value.room.state).toBe(beforeState);
    expect(serializeRooms(value.rooms, 500)).toEqual(beforeDocument);
    expect(value.room).toMatchObject({ completedGameId: null, gameSessionId: null, revision: 7, recentCommandIds: [] });
    expect(value.calls.completed).toEqual([]);
    expect(value.calls.completionErrors).toEqual([
      expect.objectContaining({ message: 'Room ROOM1 is missing a game session id.' })
    ]);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.notified).toBe(0);
    expect(value.calls.snapshots).toEqual([]);
    expect(lastPayload(value)).toMatchObject({
      type: 'error',
      code: 'history-save-failed',
      commandId: COMMAND_ID
    });
  });

  it('recovers a DB commit after room-file loss and restart without creating a second record', () => {
    const value = harness(completionRoom(2));
    const beforeDocument = serializeRooms(value.rooms, 500);
    const storedGames = new Map<string, { id: string; input: ProtocolV2CompletedGameInput }>();
    const committedInputs: ProtocolV2CompletedGameInput[] = [];
    let attempts = 0;
    const recordCompletedGame = (input: ProtocolV2CompletedGameInput) => {
      attempts += 1;
      let stored = storedGames.get(input.sourceKey);
      if (!stored) {
        stored = { id: 'completed-idempotent', input };
        storedGames.set(input.sourceKey, stored);
        committedInputs.push(input);
      }
      if (attempts === 1) throw new Error('connection lost after commit');
      return {
        id: stored.id,
        recovered: JSON.stringify(stored.input.state) !== JSON.stringify(input.state),
        state: stored.input.state
      };
    };
    value.options.recordCompletedGame = recordCompletedGame;
    const handler = createProtocolV2MessageHandler(value.options);
    const retryable = command({ type: 'replace-card', cardIndex: 0 }, 7, COMMAND_ID);

    handler(value.socket, retryable);

    expect(attempts).toBe(1);
    expect(storedGames.size).toBe(1);
    expect(committedInputs).toHaveLength(1);
    expect(storedGames.get('multi:completion-session')?.input).toBe(committedInputs[0]);
    expect(serializeRooms(value.rooms, 500)).toEqual(beforeDocument);
    expect(value.room).toMatchObject({ completedGameId: null, revision: 7, recentCommandIds: [] });
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.notified).toBe(0);
    expect(lastPayload(value)).toMatchObject({ code: 'history-save-failed', commandId: COMMAND_ID });
    const divergentRetryState = replaceCard(value.room.state!, 1);
    expect(JSON.stringify(divergentRetryState)).not.toBe(JSON.stringify(committedInputs[0].state));

    const restoredRoom = normalizeRoomsDocument(beforeDocument, {
      now: 500,
      pruneStale: false
    }).rooms[0] as ProtocolV2Room;
    restoredRoom.players[0].connected = true;
    restoredRoom.players[0].disconnectedAt = null;
    const restarted = harness(restoredRoom);
    restarted.options.recordCompletedGame = recordCompletedGame;
    const restartedHandler = createProtocolV2MessageHandler(restarted.options);
    const differentRetry = command({ type: 'replace-card', cardIndex: 1 }, 7, OTHER_COMMAND_ID);
    restartedHandler(restarted.socket, differentRetry);
    restartedHandler(restarted.socket, differentRetry);

    expect(attempts).toBe(2);
    expect(storedGames.size).toBe(1);
    expect(committedInputs).toHaveLength(1);
    expect(value.room).toMatchObject({ completedGameId: null, revision: 7, status: 'playing' });
    expect(restarted.room).toMatchObject({
      completedGameId: 'completed-idempotent',
      recentCommandIds: [],
      revision: 8,
      status: 'finished'
    });
    expect(restarted.room.state).toEqual(committedInputs[0].state);
    expect(restarted.room.state).not.toEqual(divergentRetryState);
    expect(restarted.calls.persisted).toBe(1);
    expect(restarted.calls.broadcasts).toEqual([restarted.room]);
    expect(restarted.calls.notified).toBe(0);
    expect(restarted.calls.json).toEqual([]);
    expect(restarted.calls.snapshots).toEqual([
      {
        socket: restarted.socket,
        room: restarted.room,
        options: { type: 'resync', commandId: OTHER_COMMAND_ID, reason: 'completion-recovered' }
      },
      {
        socket: restarted.socket,
        room: restarted.room,
        options: { type: 'resync', commandId: OTHER_COMMAND_ID, reason: 'stale-revision' }
      }
    ]);
  });

  it('serializes two sockets racing the same seat and revision without divergent effects', () => {
    const value = harness(completionRoom(8));
    const racer = socket(HOST_ID, `${HOST_ID}-account`, 'Host').socket;
    value.room.clients.add(racer);
    const finalSnapshots: ReturnType<typeof createRoomSnapshot>[] = [];
    const resyncSnapshots: ReturnType<typeof createRoomSnapshot>[] = [];
    value.options.broadcastRoom = (candidate) => {
      value.calls.broadcasts.push(candidate);
      for (const client of candidate.clients) {
        if (client.playerId) finalSnapshots.push(createRoomSnapshot(candidate, client.playerId));
      }
    };
    value.options.sendRoomSnapshot = (client, candidate, snapshotOptions) => {
      value.calls.snapshots.push({ socket: client, room: candidate, options: snapshotOptions });
      if (client.playerId) resyncSnapshots.push(createRoomSnapshot(candidate, client.playerId));
    };
    const handler = createProtocolV2MessageHandler(value.options);
    const action: GameCommand = { type: 'replace-card', cardIndex: 0 };

    handler(value.socket, command(action, 7, COMMAND_ID));
    handler(racer, command(action, 7, OTHER_COMMAND_ID));

    expect(value.room).toMatchObject({ completedGameId: 'completed-1', revision: 8, status: 'finished' });
    expect(value.room.recentCommandIds).toEqual([
      expect.objectContaining({ commandId: COMMAND_ID, expectedRevision: 7, revision: 8 })
    ]);
    expect(value.calls.completed).toHaveLength(1);
    expect(value.calls.completed[0].sourceKey).toBe('multi:completion-session');
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(value.calls.json).toEqual([
      {
        socket: value.socket,
        payload: {
          type: 'ack',
          protocolVersion: 2,
          commandId: COMMAND_ID,
          revision: 8
        }
      }
    ]);
    expect(value.calls.snapshots).toEqual([
      {
        socket: racer,
        room: value.room,
        options: { type: 'resync', commandId: OTHER_COMMAND_ID, reason: 'stale-revision' }
      }
    ]);
    expect(finalSnapshots).toHaveLength(2);
    expect(resyncSnapshots).toEqual([finalSnapshots[0]]);
    expect(isMultiplayerRoomSnapshot(resyncSnapshots[0], value.room.code)).toBe(true);
  });

  it('stops a same-revision racing blind draw before the loser can consume server RNG', () => {
    const players = [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')];
    let state = createMultiplayerGame(players, 1, null, () => 0.5);
    for (let index = 0; index < players.length * 2; index += 1) {
      const activePlayer = state.players[state.currentPlayerIndex];
      const cardIndex = activePlayer.grid.findIndex((card) => !card.faceUp && !card.removed);
      state = revealOpeningCard(state, cardIndex);
    }
    state.discardPile = [
      ...state.discardPile,
      ...state.drawPile.map((card) => ({ ...card, faceUp: true }))
    ];
    state.drawPile = [];
    state.currentPlayerIndex = 0;
    const value = harness(room({ players, revision: 3, state, status: 'playing' }));
    const racer = socket(HOST_ID, `${HOST_ID}-account`, 'Host').socket;
    value.room.clients.add(racer);
    const handler = createProtocolV2MessageHandler(value.options);
    const action: GameCommand = { type: 'draw-blind' };

    handler(value.socket, command(action, 3, COMMAND_ID));
    const winnerRandomCalls = value.calls.randomValues.length;
    handler(racer, command(action, 3, OTHER_COMMAND_ID));

    expect(winnerRandomCalls).toBeGreaterThan(0);
    expect(value.calls.randomValues).toHaveLength(winnerRandomCalls);
    expect(value.room).toMatchObject({ revision: 4, status: 'playing' });
    expect(value.room.state).toMatchObject({ phase: 'choose-replacement', selectedSource: 'draw' });
    expect(value.room.recentCommandIds).toEqual([
      expect.objectContaining({ commandId: COMMAND_ID, expectedRevision: 3, revision: 4 })
    ]);
    expect(value.calls.completed).toEqual([]);
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(value.calls.json).toEqual([
      {
        socket: value.socket,
        payload: {
          type: 'ack',
          protocolVersion: 2,
          commandId: COMMAND_ID,
          revision: 4
        }
      }
    ]);
    expect(value.calls.snapshots).toEqual([
      {
        socket: racer,
        room: value.room,
        options: { type: 'resync', commandId: OTHER_COMMAND_ID, reason: 'stale-revision' }
      }
    ]);
  });
});

describe('protocol v2 gameplay and lifecycle commands', () => {
  it.each([
    [
      'out-of-turn command',
      command({ type: 'reveal-opening-card', cardIndex: 0 }),
      'illegal-move'
    ],
    [
      'cross-seat envelope actor',
      { ...command({ type: 'reveal-opening-card', cardIndex: 0 }), playerId: HOST_ID },
      'invalid-command'
    ],
    [
      'forged action actor',
      {
        ...command({ type: 'reveal-opening-card', cardIndex: 0 }),
        action: { type: 'reveal-opening-card', cardIndex: 0, playerId: HOST_ID }
      },
      'invalid-command'
    ]
  ])('rejects a guest %s without any authoritative side effect', (_label, payload, expectedCode) => {
    const players = [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')];
    const state = createMultiplayerGame(players, 1, null, () => 0.5);
    state.currentPlayerIndex = 0;
    state.phase = 'opening-reveal';
    const value = harness(room({ state, status: 'playing' }));
    const guest = socket(GUEST_ID).socket;
    value.room.clients.add(guest);
    const before = serializeRooms(value.rooms, 500);

    value.handler(guest, payload as RealtimeClientMessage);

    expect(lastPayload(value)).toMatchObject({
      type: 'error',
      code: expectedCode,
      commandId: COMMAND_ID
    });
    expect(serializeRooms(value.rooms, 500)).toEqual(before);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.notified).toBe(0);
    expect(value.calls.completed).toEqual([]);
    expect(value.calls.completionErrors).toEqual([]);
    expect(value.calls.snapshots).toEqual([]);
  });

  it('rejects gameplay without a live game and illegal moves without committing', () => {
    const waiting = harness();
    waiting.handler(waiting.socket, command({ type: 'draw-blind' }));
    expect(lastPayload(waiting)).toMatchObject({ code: 'no-active-game' });

    const state = createMultiplayerGame(waiting.room.players, 1, null, () => 0.5);
    const playing = harness(room({ state, status: 'playing' }));
    playing.handler(playing.socket, command({ type: 'choose-discard' }));
    expect(lastPayload(playing)).toMatchObject({ code: 'illegal-move' });
    expect(playing.room.revision).toBe(0);
  });

  it('uses only the injected server RNG and commits a legal recycled blind draw once', () => {
    const players = [player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')];
    const state = createMultiplayerGame(players, 1, null, () => 0.5);
    state.phase = 'choose-source';
    state.currentPlayerIndex = 0;
    state.drawPile = [];
    state.discardPile = [
      { id: 'discard-bottom', value: 1, faceUp: true, removed: false },
      { id: 'discard-mid', value: 2, faceUp: true, removed: false },
      { id: 'discard-top', value: 3, faceUp: true, removed: false }
    ];
    const value = harness(room({ state, status: 'playing' }));
    value.handler(value.socket, command({ type: 'draw-blind' }));
    expect(value.calls.randomValues.length).toBeGreaterThan(0);
    expect(value.room).toMatchObject({ revision: 1, status: 'playing' });
    expect(value.room.state).toMatchObject({ phase: 'choose-replacement', selectedSource: 'draw' });
    expect(value.calls.persisted).toBe(1);
    expect(value.calls.broadcasts).toEqual([value.room]);
    expect(value.calls.notified).toBe(1);
    expect(lastPayload(value)).toMatchObject({ type: 'ack', commandId: COMMAND_ID, revision: 1 });
  });

  it.each([
    [{ type: 'send-chat-message', text: '   ' }, 'empty-chat'],
    [{ type: 'set-next-round-ready', ready: true }, 'not-scoring']
  ] as Array<[GameCommand, string]>)('rejects invalid non-game transitions', (action, code) => {
    const value = harness();
    value.handler(value.socket, command(action));
    expect(lastPayload(value)).toMatchObject({ code });
    expect(value.room.revision).toBe(0);
  });

  it('sets and clears scoring readiness while rejecting no-op readiness', () => {
    const base = createMultiplayerGame([player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')], 1, null, () => 0.5);
    base.phase = 'round-over';
    const value = harness(room({ state: base, status: 'playing' }));
    value.handler(value.socket, command({ type: 'set-next-round-ready', ready: true }));
    expect(value.room.readyForNextRoundPlayerIds).toEqual([HOST_ID]);
    value.handler(value.socket, command({ type: 'set-next-round-ready', ready: true }, 1, OTHER_COMMAND_ID));
    expect(lastPayload(value)).toMatchObject({ code: 'unchanged-command' });
    value.handler(value.socket, command({ type: 'set-next-round-ready', ready: false }, 1, OTHER_COMMAND_ID));
    expect(value.room.readyForNextRoundPlayerIds).toEqual([]);
    expect(value.room.revision).toBe(2);
  });

  it('enforces start-game host and player-count authorization', () => {
    const guestValue = harness();
    const guest = socket(GUEST_ID).socket;
    guestValue.room.clients.add(guest);
    guestValue.handler(guest, command({ type: 'start-game' }));
    expect(lastPayload(guestValue)).toMatchObject({ code: 'host-required' });

    const solo = harness(room({ players: [player(HOST_ID, 'Host', true)] }));
    solo.handler(solo.socket, command({ type: 'start-game' }));
    expect(lastPayload(solo)).toMatchObject({ code: 'players-required' });
  });

  it('starts a waiting room with server-owned shuffle and session identity', () => {
    const value = harness();
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(value.room).toMatchObject({ revision: 1, status: 'playing', completedGameId: null, gameSessionId: NEW_ID });
    expect(value.room.state?.phase).toBe('opening-reveal');
    expect(value.calls.randomValues.length).toBeGreaterThan(0);
  });

  it('starts a next round only after every player is ready', () => {
    const state = createMultiplayerGame([player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')], 1, null, () => 0.5);
    state.phase = 'round-over';
    const blocked = harness(room({ state, status: 'playing', readyForNextRoundPlayerIds: [HOST_ID] }));
    blocked.handler(blocked.socket, command({ type: 'start-game' }));
    expect(lastPayload(blocked)).toMatchObject({ code: 'players-not-ready' });

    const value = harness(room({ state, status: 'playing', readyForNextRoundPlayerIds: [HOST_ID, GUEST_ID] }));
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(value.room).toMatchObject({ revision: 1, status: 'playing', readyForNextRoundPlayerIds: [] });
    expect(value.room.state?.round).toBe(2);
  });

  it('restarts a finished game only after every player is ready', () => {
    const state = createMultiplayerGame([player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')], 2, null, () => 0.5);
    state.phase = 'game-over';
    const blocked = harness(room({ state, status: 'finished' }));
    blocked.handler(blocked.socket, command({ type: 'start-game' }));
    expect(lastPayload(blocked)).toMatchObject({ code: 'players-not-ready' });

    const value = harness(room({ state, status: 'finished', completedGameId: 'old', readyForNextRoundPlayerIds: [HOST_ID, GUEST_ID] }));
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(value.room).toMatchObject({ revision: 1, status: 'playing', completedGameId: null, gameSessionId: NEW_ID });
  });

  it('rejects start-game during an active turn', () => {
    const state = createMultiplayerGame([player(HOST_ID, 'Host', true), player(GUEST_ID, 'Guest')], 1, null, () => 0.5);
    const value = harness(room({ state, status: 'playing' }));
    value.handler(value.socket, command({ type: 'start-game' }));
    expect(lastPayload(value)).toMatchObject({ code: 'invalid-phase' });
  });

  it('enforces reset host authorization', () => {
    const value = harness();
    const guest = socket(GUEST_ID).socket;
    value.room.clients.add(guest);
    value.handler(guest, command({ type: 'reset-room' }));
    expect(lastPayload(value)).toMatchObject({ code: 'host-required' });
  });

  it('emits a correlated v2 reset error without mutation, receipt, or RNG when allocation fails', () => {
    const value = harness();
    value.options.makeRoomCodeForSocket = () => null;
    createProtocolV2MessageHandler(value.options)(value.socket, command({ type: 'reset-room' }));

    expect(value.calls.json).toEqual([{
      socket: value.socket,
      payload: {
        type: 'error',
        protocolVersion: 2,
        code: 'room-code-unavailable',
        message: 'A room code could not be created. Try again.',
        commandId: COMMAND_ID
      }
    }]);
    expect(value.rooms.has('ROOM1')).toBe(true);
    expect(value.rooms.size).toBe(1);
    expect(value.room).toMatchObject({ code: 'ROOM1', revision: 0, recentCommandIds: [], resetAliases: [] });
    expect(value.socket).toMatchObject({ roomCode: 'ROOM1', playerId: HOST_ID });
    expect(value.calls.persisted).toBe(0);
    expect(value.calls.snapshots).toEqual([]);
    expect(value.calls.broadcasts).toEqual([]);
    expect(value.calls.randomValues).toEqual([]);
    expect(value.calls.uuidValues).toEqual([]);
  });

  it('emits an authenticated reset resync before ack while detaching guests', () => {
    const value = harness();
    const guest = socket(GUEST_ID);
    value.room.clients.add(guest.socket);
    value.handler(value.socket, command({ type: 'reset-room' }));
    expect(value.rooms.has('ROOM1')).toBe(false);
    const replacement = value.rooms.get('NEW01');
    expect(replacement).toMatchObject({ revision: 1, hostId: HOST_ID });
    expect(replacement?.resetAliases).toEqual([{
      fromCode: 'ROOM1',
      commandId: COMMAND_ID,
      playerId: HOST_ID,
      expiresAt: 500 + RESET_ALIAS_TTL_MS
    }]);
    expect(guest.socket).toMatchObject({ roomCode: null, playerId: null });
    expect(value.calls.json.map(({ payload }) => payload.type)).toEqual(['error', 'ack']);
    expect(value.calls.snapshots).toEqual([{
      socket: value.socket,
      room: replacement,
      options: { type: 'resync', commandId: COMMAND_ID, reason: 'room-reset' }
    }]);
  });

  it('copies only live reset aliases with their receipts and keeps the lineage bounded', () => {
    const aliases = Array.from({ length: MAX_RESET_ALIASES }, (_, index) => ({
      fromCode: `OLD0${index}`,
      commandId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      playerId: HOST_ID,
      expiresAt: index === 0 ? 499 : 900 + index
    }));
    const priorReceipts = aliases.map((alias, index) => receipt(
      { type: 'reset-room' },
      {
        commandId: alias.commandId,
        expectedRevision: index,
        revision: index + 1
      }
    ));
    const value = harness(room({
      revision: MAX_RESET_ALIASES,
      resetAliases: aliases,
      recentCommandIds: priorReceipts
    }));
    value.handler(value.socket, command({ type: 'reset-room' }, MAX_RESET_ALIASES));
    const replacement = value.rooms.get('NEW01');
    expect(replacement?.resetAliases).toHaveLength(MAX_RESET_ALIASES);
    expect(replacement?.resetAliases.map((alias) => alias.fromCode)).toEqual([
      ...aliases.slice(1).map((alias) => alias.fromCode),
      'ROOM1'
    ]);
    expect(replacement?.recentCommandIds.map((item) => item.commandId)).toEqual([
      ...priorReceipts.slice(1).map((item) => item.commandId),
      COMMAND_ID
    ]);
  });
});
