import { createMultiplayerGame } from '../../../src/game';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type ClientCommand,
  type CommandReceipt,
  type GameCommand
} from '../../../src/protocolV2';
import {
  createProtocolV2MessageHandler,
  createResetAliasIndex,
  isResetAliasCodeReserved,
  MAX_RESET_ALIASES,
  rebuildResetAliasIndex,
  RESET_ALIAS_TTL_MS,
  type ProtocolV2HandlerOptions,
  type ProtocolV2Room,
  type ProtocolV2Socket
} from '../../../src/serverProtocolV2';
import { sendRealtimeJson } from '../../../src/serverRealtime';
import type { RoomPlayer } from '../../../src/types';

const HOST_ID = '00000000-0000-4000-8000-000000000001';
const GUEST_ID = '00000000-0000-4000-8000-000000000002';
const NEW_ID = '00000000-0000-4000-8000-000000000003';
const COMMAND_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_COMMAND_ID = '10000000-0000-4000-8000-000000000002';

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
    completed: [] as unknown[],
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
      return { id: 'completed-1' };
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

describe('protocol v2 command ordering and receipts', () => {
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

describe('protocol v2 gameplay and lifecycle commands', () => {
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
