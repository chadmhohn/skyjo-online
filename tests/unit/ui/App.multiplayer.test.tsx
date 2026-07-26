import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../../../src/App';
import { PHONE_LAYOUT_MEDIA_QUERY } from '../../../src/accessibility';
import {
  RESET_RECOVERY_MAX_SERIALIZED_LENGTH,
  RESET_RECOVERY_STORAGE_KEY,
  parseResetRecoveryHint,
  serializeResetRecoveryHint,
  type ResetRecoveryHint
} from '../../../src/resetRecovery';
import type { AccountUser } from '../../../src/account';
import * as lazyRoomConnection from '../../../src/lazyRoomConnection';
import {
  createRoomSnapshot,
  type ClientCommand,
  type GameCommand,
  type PublicRoomSnapshot
} from '../../../src/protocolV2';
import type { Card, GameState, MultiplayerRoom, Player, RoomChatMessage } from '../../../src/types';
import { setMediaQueryMatches } from '../../setup/dom';

const audioMocks = vi.hoisted(() => ({
  useGameAudio: vi.fn()
}));

vi.mock('../../../src/audio', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/audio')>(),
  useGameAudio: audioMocks.useGameAudio
}));

type SocketEventName = 'open' | 'message' | 'error' | 'close';
type SocketListener = (event: Event | MessageEvent<string>) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: unknown[] = [];
  closeCalls = 0;
  onSend: ((frame: unknown) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  throwOnSend = false;
  private readonly listeners = new Map<SocketEventName, Set<SocketListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: SocketEventName, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    if (this.throwOnSend) throw new Error('send failed');
    const frame = JSON.parse(data) as unknown;
    this.sent.push(frame);
    this.onSend?.(frame);
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', new Event('close'));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', new Event('open'));
  }

  receive(payload: unknown) {
    this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', new Event('close'));
  }

  fail() {
    this.dispatch('error', new Event('error'));
  }

  private dispatch(type: SocketEventName, event: Event | MessageEvent<string>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const accountUser: AccountUser = {
  id: 'account-alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'player',
  disabled: false,
  createdAt: 1,
  updatedAt: 2,
  lastLoginAt: 3
};

const savedRecoveryPlayerId = '00000000-0000-4000-8000-000000000001';
const savedRecoveryPeerId = '00000000-0000-4000-8000-000000000002';
const savedRecoveryCommandId = '10000000-0000-4000-8000-000000000001';
const newerTabPlayerId = '00000000-0000-4000-8000-000000000009';
const newerTabCommandId = '10000000-0000-4000-8000-000000000009';
const validResetRecoveryHint: ResetRecoveryHint = {
  fromCode: 'ABCDE',
  playerId: savedRecoveryPlayerId,
  commandId: savedRecoveryCommandId,
  expectedRevision: 7
};

function makeCard(id: string, value: number, faceUp = false, removed = false): Card {
  return { id, value, faceUp, removed };
}

function makePlayer(id: string, name: string, options: Partial<Player> = {}): Player {
  return {
    id,
    name,
    kind: 'human',
    totalScore: 0,
    roundScore: 0,
    grid: Array.from({ length: 12 }, (_, index) => makeCard(`${id}-card-${index}`, (index % 12) - 2)),
    ...options
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const players = overrides.players ?? [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')];
  return {
    players,
    drawPile: [makeCard('draw-1', 7), makeCard('draw-2', -1)],
    discardPile: [makeCard('discard-1', 4, true)],
    currentPlayerIndex: 0,
    phase: 'opening-reveal',
    selectedSource: null,
    drawnCard: null,
    round: 1,
    log: [],
    winnerId: null,
    nextStarterId: null,
    roundCloserId: null,
    finalTurnPlayerIds: [],
    openingRevealCounts: Object.fromEntries(players.map((player) => [player.id, 0])),
    roundHistory: [],
    ...overrides
  };
}

function makeRoom(overrides: Partial<MultiplayerRoom> = {}): MultiplayerRoom {
  return {
    code: 'ABCDE',
    hostId: 'p1',
    players: [
      { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
      { id: 'p2', name: 'Bob', connected: true, host: false }
    ],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: 100,
    completedGameId: null,
    revision: 0,
    ...overrides
  };
}

function makeResetCapableRoom(overrides: Partial<MultiplayerRoom> = {}): MultiplayerRoom {
  return makeRoom({
    hostId: savedRecoveryPlayerId,
    players: [
      {
        id: savedRecoveryPlayerId,
        userId: accountUser.id,
        name: 'Alice',
        connected: true,
        host: true
      },
      { id: savedRecoveryPeerId, name: 'Bob', connected: true, host: false }
    ],
    ...overrides
  });
}

function publicRoom(room: MultiplayerRoom, viewerPlayerId = 'p1'): PublicRoomSnapshot {
  return createRoomSnapshot(
    {
      code: room.code,
      hostId: room.hostId,
      players: room.players.map((player) => {
        const publicPlayer = { ...player };
        delete publicPlayer.userId;
        return publicPlayer;
      }),
      chatMessages: room.chatMessages,
      readyForNextRoundPlayerIds: room.readyForNextRoundPlayerIds,
      state: room.state,
      status: room.status,
      updatedAt: room.updatedAt,
      completedGameId: room.completedGameId ?? null,
      revision: room.revision
    },
    viewerPlayerId,
    room.serverNow ?? room.updatedAt
  );
}

function snapshotFrame(room: MultiplayerRoom, playerId = 'p1') {
  return {
    type: 'snapshot' as const,
    protocolVersion: 2 as const,
    playerId,
    revision: room.revision,
    room: publicRoom(room, playerId)
  };
}

function resyncFrame(
  room: MultiplayerRoom,
  commandId: string,
  playerId = 'p1',
  reason = 'stale-revision'
) {
  return {
    type: 'resync' as const,
    protocolVersion: 2 as const,
    playerId,
    revision: room.revision,
    room: publicRoom(room, playerId),
    reason,
    commandId
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function installFetch(user: AccountUser | null = accountUser) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/account/me') return response({ user });
    if (path === '/api/rooms/invite') {
      return response({ roomCode: 'ABCDE', path: '/invite/secure-token', expiresAt: 999 });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderLobby(user: AccountUser | null = accountUser, path = '/lobby') {
  window.history.replaceState({}, '', path);
  const fetchMock = installFetch(user);
  render(<App />);
  if (user) {
    await screen.findByRole('heading', { name: 'Multiplayer Lobby' });
    await waitFor(() =>
      expect(screen.getByTestId('connection-status')).not.toHaveAttribute('data-connection-state', 'connecting')
    );
  }
  return fetchMock;
}

function latestSocket() {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('Expected the app to create a WebSocket.');
  return socket;
}

function openSocket(socket = latestSocket()) {
  act(() => socket.open());
  return socket;
}

function receive(socket: FakeWebSocket, payload: unknown) {
  act(() => socket.receive(payload));
}

function lastFrame(socket: FakeWebSocket) {
  return socket.sent.at(-1) as Record<string, unknown>;
}

function deepObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(deepObjectKeys);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
    key,
    ...deepObjectKeys(nested)
  ]);
}

function lastCommand(socket: FakeWebSocket): ClientCommand {
  const frame = lastFrame(socket);
  expect(frame).toMatchObject({
    type: 'command',
    protocolVersion: 2,
    commandId: expect.stringMatching(/^[a-f0-9-]{36}$/i),
    expectedRevision: expect.any(Number),
    action: { type: expect.any(String) }
  });
  expect(frame).not.toHaveProperty('state');
  return frame as unknown as ClientCommand;
}

function expectCommand(socket: FakeWebSocket, action: GameCommand, expectedRevision: number): ClientCommand {
  const command = lastCommand(socket);
  expect(command.action).toEqual(action);
  expect(command.expectedRevision).toBe(expectedRevision);
  return command;
}

function receiveSnapshot(socket: FakeWebSocket, room: MultiplayerRoom, playerId = 'p1') {
  receive(socket, snapshotFrame(room, playerId));
}

function receiveAck(socket: FakeWebSocket, command: ClientCommand, revision: number) {
  receive(socket, {
    type: 'ack',
    protocolVersion: 2,
    commandId: command.commandId,
    revision
  });
}

function convergeCommand(
  socket: FakeWebSocket,
  command: ClientCommand,
  room: MultiplayerRoom,
  order: 'ack-first' | 'snapshot-first' = 'snapshot-first'
) {
  if (order === 'ack-first') {
    receiveAck(socket, command, room.revision);
    receiveSnapshot(socket, room);
    return;
  }
  receiveSnapshot(socket, room);
  receiveAck(socket, command, room.revision);
}

async function createJoinedRoom(room = makeRoom(), viewerPlayerId = room.hostId) {
  const user = userEvent.setup();
  await renderLobby();
  expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
  await user.click(screen.getByRole('button', { name: 'Create Room' }));
  expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connecting');
  expect(screen.getByRole('button', { name: 'Create Room' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  const socket = openSocket();
  expect(lastFrame(socket)).toEqual({
    type: 'create-room', protocolVersion: 2, snapshotEnvelopeVersion: 2, name: 'Alice'
  });
  receiveSnapshot(socket, room, viewerPlayerId);
  await screen.findByText(room.code);
  return { room, socket, user };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  audioMocks.useGameAudio.mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) }
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('multiplayer lobby', () => {
  it('fails closed when the route-scoped room connection chunk cannot load', async () => {
    vi.spyOn(lazyRoomConnection, 'loadRoomConnection').mockRejectedValueOnce(new Error('private chunk detail'));
    await renderLobby();

    await waitFor(() => expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'error'));
    expect(screen.getByText('Could not initialize the room connection. Reload and try again.')).toBeInTheDocument();
    expect(screen.queryByText('private chunk detail')).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not create a late room controller after the lobby unmounts during chunk loading', async () => {
    const roomConnection = await import('../../../src/roomConnection');
    let resolveChunk: ((module: typeof roomConnection) => void) | undefined;
    vi.spyOn(lazyRoomConnection, 'loadRoomConnection').mockReturnValueOnce(
      new Promise<typeof roomConnection>((resolve) => {
        resolveChunk = resolve;
      })
    );
    window.history.replaceState({}, '', '/lobby');
    installFetch();
    const rendered = render(<App />);
    await screen.findByRole('heading', { name: 'Multiplayer Lobby' });

    rendered.unmount();
    resolveChunk?.(roomConnection);
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('serializes and parses only the exact bounded reset recovery hint contract', () => {
    const serialized = serializeResetRecoveryHint(validResetRecoveryHint);
    expect(serialized).toBe(
      `{"fromCode":"ABCDE","playerId":"${savedRecoveryPlayerId}","commandId":"${savedRecoveryCommandId}","expectedRevision":7}`
    );
    expect(parseResetRecoveryHint(serialized)).toEqual(validResetRecoveryHint);
    const boundaryValue = serialized.padEnd(RESET_RECOVERY_MAX_SERIALIZED_LENGTH, ' ');
    expect(parseResetRecoveryHint(boundaryValue)).toEqual(validResetRecoveryHint);
    expect(parseResetRecoveryHint(`${boundaryValue} `)).toBeNull();

    for (const malformed of [
      null,
      '',
      '{',
      JSON.stringify({ ...validResetRecoveryHint, extra: true }),
      JSON.stringify({ ...validResetRecoveryHint, fromCode: 'abcde' }),
      JSON.stringify({ ...validResetRecoveryHint, playerId: 'not-a-uuid' }),
      JSON.stringify({ ...validResetRecoveryHint, commandId: 'not-a-uuid' }),
      JSON.stringify({ ...validResetRecoveryHint, expectedRevision: -1 }),
      JSON.stringify({ ...validResetRecoveryHint, expectedRevision: 1.5 }),
      JSON.stringify({ ...validResetRecoveryHint, expectedRevision: Number.MAX_SAFE_INTEGER })
    ]) {
      expect(parseResetRecoveryHint(malformed)).toBeNull();
    }
    expect(() => serializeResetRecoveryHint({ ...validResetRecoveryHint, expectedRevision: -1 })).toThrow(
      /invalid reset recovery hint/i
    );
  });

  it.each([
    ['malformed', '{'],
    ['oversize', 'x'.repeat(RESET_RECOVERY_MAX_SERIALIZED_LENGTH + 1)]
  ])('removes a %s persisted recovery hint before saved-seat boot', async (_label, rawHint) => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', savedRecoveryPlayerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, rawHint);
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const socket = openSocket();
    expect(lastFrame(socket)).toEqual({
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      snapshotEnvelopeVersion: 2,
      code: 'ABCDE',
      name: 'Alice',
      playerId: savedRecoveryPlayerId
    });
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['room code', { ...validResetRecoveryHint, fromCode: 'FGHIJ' }],
    [
      'player seat',
      { ...validResetRecoveryHint, playerId: '00000000-0000-4000-8000-000000000002' }
    ]
  ])('removes a recovery hint that mismatches the saved %s', async (_label, hint) => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', savedRecoveryPlayerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serializeResetRecoveryHint(hint));
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const socket = openSocket();
    expect(lastFrame(socket)).not.toHaveProperty('recoveryCommandId');
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('boots a matching saved reset hint onto the join wire without exposing its internal revision', async () => {
    const serialized = serializeResetRecoveryHint(validResetRecoveryHint);
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', savedRecoveryPlayerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serialized);
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const socket = openSocket();
    expect(lastFrame(socket)).toEqual({
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      snapshotEnvelopeVersion: 2,
      code: 'ABCDE',
      name: 'Alice',
      playerId: savedRecoveryPlayerId,
      recoveryCommandId: savedRecoveryCommandId
    });
    expect(lastFrame(socket)).not.toHaveProperty('recoveryExpectedRevision');
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBe(serialized);
  });

  it('does not reset the room until the host confirms the destructive action', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    const confirmReset = vi.mocked(window.confirm);
    confirmReset.mockReturnValueOnce(false);
    const sentBeforeReset = socket.sent.length;

    await user.click(screen.getByRole('button', { name: 'Reset Room' }));

    expect(confirmReset).toHaveBeenCalledWith(
      'Reset this room for every player? The current game will be discarded.'
    );
    expect(socket.sent).toHaveLength(sentBeforeReset);

    confirmReset.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    expectCommand(socket, { type: 'reset-room' }, 0);
  });

  it('recovers an advanced reset target after every live reply is lost and a hard reload', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    const resetCommand = expectCommand(socket, { type: 'reset-room' }, 0);
    const rawHint = window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY);
    expect(rawHint).not.toBeNull();
    const storedHint = JSON.parse(String(rawHint)) as Record<string, unknown>;
    expect(deepObjectKeys(storedHint).sort()).toEqual([
      'commandId',
      'expectedRevision',
      'fromCode',
      'playerId'
    ]);
    expect(storedHint).toEqual({
      fromCode: 'ABCDE',
      playerId: savedRecoveryPlayerId,
      commandId: resetCommand.commandId,
      expectedRevision: 0
    });
    expect(rawHint).not.toMatch(/players|state|draw|discard|card|email|name/i);

    cleanup();
    FakeWebSocket.instances = [];
    await renderLobby();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const recovered = openSocket();
    expect(lastFrame(recovered)).toEqual({
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      snapshotEnvelopeVersion: 2,
      code: 'ABCDE',
      name: 'Alice',
      playerId: savedRecoveryPlayerId,
      recoveryCommandId: resetCommand.commandId
    });

    const targetRoom = makeResetCapableRoom({ code: 'FGHIJ', revision: 3, updatedAt: 300 });
    receive(
      recovered,
      resyncFrame(targetRoom, resetCommand.commandId, savedRecoveryPlayerId, 'room-reset')
    );
    receiveAck(recovered, resetCommand, 1);

    expect(await screen.findByText('FGHIJ')).toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('FGHIJ');
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(recovered.sent.filter((frame) =>
      (frame as ClientCommand).action?.type === 'reset-room'
    )).toHaveLength(0);
  });

  it('retains reset recovery through an ordinary reconnect snapshot, replay, and unrelated error', async () => {
    const originalRoom = makeResetCapableRoom();
    const { socket, user } = await createJoinedRoom(originalRoom);
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    const resetCommand = expectCommand(socket, { type: 'reset-room' }, 0);
    const rawHint = window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY);

    act(() => socket.serverClose());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1000 });
    const recovered = openSocket();
    expect(lastFrame(recovered)).toMatchObject({
      type: 'join-room',
      code: 'ABCDE',
      playerId: savedRecoveryPlayerId,
      recoveryCommandId: resetCommand.commandId
    });
    receiveSnapshot(recovered, makeResetCapableRoom({ updatedAt: 200 }), savedRecoveryPlayerId);
    expect(lastFrame(recovered)).toEqual(resetCommand);
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBe(rawHint);

    receive(recovered, {
      type: 'error',
      protocolVersion: 2,
      code: 'presence-warning',
      message: 'A delayed unrelated warning.'
    });
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBe(rawHint);

    receive(recovered, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-code-unavailable',
      message: 'A room code could not be created. Try again.',
      commandId: resetCommand.commandId
    });
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('removes a newly stored reset hint when the transport rejects the command send', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    socket.throwOnSend = true;
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));

    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Room connection is not open.');
    expect(socket.sent.filter((frame) =>
      (frame as ClientCommand).action?.type === 'reset-room'
    )).toHaveLength(0);
  });

  it('fails closed when durable reset recovery storage is unavailable', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
      if (key === RESET_RECOVERY_STORAGE_KEY) throw new DOMException('Storage unavailable', 'QuotaExceededError');
      nativeSetItem.call(this, key, value);
    });
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Skyjo could not save reset recovery data. The room was not reset.'
    );
    expect(socket.sent.filter((frame) =>
      (frame as ClientCommand).action?.type === 'reset-room'
    )).toHaveLength(0);
  });

  it('restores the original recovery hint when a rapid second reset is rejected as pending', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    const firstCommandId = '20000000-0000-4000-8000-000000000001';
    const secondCommandId = '20000000-0000-4000-8000-000000000002';
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(firstCommandId)
      .mockReturnValueOnce(secondCommandId);
    const resetButton = screen.getByRole('button', { name: 'Reset Room' });
    socket.onSend = (frame) => {
      if ((frame as ClientCommand).action?.type !== 'reset-room') return;
      socket.onSend = null;
      resetButton.click();
    };

    await user.click(resetButton);

    expect(randomUuid).toHaveBeenCalledTimes(2);
    expect(socket.sent.filter((frame) =>
      (frame as ClientCommand).action?.type === 'reset-room'
    )).toEqual([
      expect.objectContaining({ commandId: firstCommandId, action: { type: 'reset-room' } })
    ]);
    expect(parseResetRecoveryHint(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY))).toEqual({
      fromCode: 'ABCDE',
      playerId: savedRecoveryPlayerId,
      commandId: firstCommandId,
      expectedRevision: 0
    });
  });

  it('clears a boot recovery hint after a terminal uncorrelated saved-seat rejection', async () => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', savedRecoveryPlayerId);
    window.localStorage.setItem(
      RESET_RECOVERY_STORAGE_KEY,
      serializeResetRecoveryHint({ ...validResetRecoveryHint, expectedRevision: 0 })
    );
    await renderLobby();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const socket = openSocket();
    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'stale-room',
      message: 'That saved room is no longer available.'
    });

    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(screen.getByText('That saved room is no longer available.')).toBeInTheDocument();
  });

  it('requires an account and preserves a sanitized shared room in the sign-in handoff', async () => {
    await renderLobby(null, '/lobby?room=a-b_c!12-extra');

    expect(await screen.findByRole('heading', { name: 'Sign in to play multiplayer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute(
      'href',
      '/account?next=%2Flobby%3Froom%3Da-b_c!12-extra'
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('creates and runs a waiting room with host, sharing, chat, presence, and start frames', async () => {
    const { socket, user } = await createJoinedRoom(
      makeRoom({
        players: [{ id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true }]
      })
    );
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    expect(socket.url).toBe('ws://localhost:3000/rooms');
    expect(window.localStorage.getItem('skyjo-player-id')).toBe('p1');
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('ABCDE');
    expect(screen.getByText(/Alice host online/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for players/)).toBeInTheDocument();
    expect(screen.getByText(/Need at least two connected players to start/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Game' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(
        'Join my Skyjo room ABCDE: http://localhost:3000/invite/secure-token'
      )
    );
    expect(await screen.findByText('Link copied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Table Chat/ }));
    const chatLog = screen.getByRole('log', { name: 'Table chat messages' });
    expect(chatLog).toHaveAttribute('aria-atomic', 'false');
    expect(chatLog).toHaveAttribute('aria-relevant', 'additions');
    const messageInput = screen.getByRole('textbox', { name: 'Message' });
    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();
    await user.type(messageInput, '  hello table  ');
    await user.click(sendButton);
    const chatCommand = expectCommand(socket, { type: 'send-chat-message', text: 'hello table' }, 0);
    expect(messageInput).toHaveValue('');

    await user.click(screen.getByRole('button', { name: /Table Chat/ }));
    const bobMessage: RoomChatMessage = {
      id: 'chat-1',
      playerId: 'p2',
      playerName: 'Bob',
      text: 'Ready when you are',
      createdAt: Date.UTC(2026, 6, 12, 18, 30)
    };
    const readyRoom = makeRoom({ chatMessages: [bobMessage], revision: 1 });
    convergeCommand(socket, chatCommand, readyRoom);
    expect(await screen.findByText('Bob: Ready when you are')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Game' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Table Chat/ }));
    expect(screen.getByText('Bob')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Table Chat/ }));

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(socket.sent).toContainEqual({ type: 'set-presence', visible: true });
    expect(socket.sent.at(-1)).toEqual({ type: 'set-presence', visible: false });

    await user.click(screen.getByRole('button', { name: 'Start Game' }));
    const startCommand = expectCommand(socket, { type: 'start-game' }, 1);
    convergeCommand(
      socket,
      startCommand,
      makeRoom({ state: makeState(), status: 'playing', chatMessages: [bobMessage], revision: 2 }),
      'ack-first'
    );
  });

  it('uses connected seats for start, lets the host remove a seat, and retires a confirmed leave once', async () => {
    const waitingRoom = makeRoom({
      players: [
        { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true, controller: 'human' },
        {
          id: 'p2',
          name: 'Bob',
          connected: false,
          host: false,
          controller: 'human',
          disconnectedAt: 1_000
        }
      ],
      updatedAt: 30_000,
      serverNow: 30_000
    });
    const { socket, user } = await createJoinedRoom(waitingRoom);

    expect(screen.getByRole('button', { name: 'Start Game' })).toBeDisabled();
    expect(screen.getByText(/Need at least two connected players to start/)).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getAllByText('Human controlled')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove Bob from room' }));
    const removeCommand = expectCommand(socket, { type: 'remove-player', playerId: 'p2' }, 0);
    convergeCommand(
      socket,
      removeCommand,
      makeRoom({
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true, controller: 'human' }
        ],
        revision: 1
      })
    );

    await user.click(screen.getByRole('button', { name: 'Leave Room' }));
    const leaveCommand = expectCommand(socket, { type: 'leave-room' }, 1);
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    receive(socket, {
      type: 'ack',
      protocolVersion: 2,
      commandId: leaveCommand.commandId,
      revision: 2,
      result: 'room-left'
    });
    receive(socket, {
      type: 'ack',
      protocolVersion: 2,
      commandId: leaveCommand.commandId,
      revision: 2,
      result: 'room-left'
    });

    expect(window.localStorage.getItem('skyjo-player-id')).toBeNull();
    expect(window.localStorage.getItem('skyjo-room-code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(removeItem.mock.calls.filter(([key]) => key === 'skyjo-player-id')).toHaveLength(1);
    expect(removeItem.mock.calls.filter(([key]) => key === 'skyjo-room-code')).toHaveLength(1);
  });

  it('retires a removed seat once without leaving recovery data that can resurrect it', async () => {
    const { socket } = await createJoinedRoom(makeResetCapableRoom(), savedRecoveryPlayerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serializeResetRecoveryHint(validResetRecoveryHint));
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const terminalFrame = {
      type: 'error',
      protocolVersion: 2,
      code: 'seat-removed',
      message: 'The host removed this seat.'
    };

    receive(socket, terminalFrame);
    receive(socket, terminalFrame);

    expect(screen.getByRole('alert')).toHaveTextContent('The host removed this seat.');
    expect(window.localStorage.getItem('skyjo-player-id')).toBeNull();
    expect(window.localStorage.getItem('skyjo-room-code')).toBeNull();
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(removeItem.mock.calls.filter(([key]) => key === 'skyjo-player-id')).toHaveLength(1);
    expect(removeItem.mock.calls.filter(([key]) => key === 'skyjo-room-code')).toHaveLength(1);
    expect(removeItem.mock.calls.filter(([key]) => key === RESET_RECOVERY_STORAGE_KEY)).toHaveLength(1);
  });

  it('keeps a newer tab session in shared storage when an older tab receives a late leave acknowledgement', async () => {
    const { socket, user } = await createJoinedRoom();
    await user.click(screen.getByRole('button', { name: 'Leave Room' }));
    const leaveCommand = expectCommand(socket, { type: 'leave-room' }, 0);
    const newerHint: ResetRecoveryHint = {
      fromCode: 'FGHIJ',
      playerId: newerTabPlayerId,
      commandId: newerTabCommandId,
      expectedRevision: 4
    };
    window.localStorage.setItem('skyjo-room-code', newerHint.fromCode);
    window.localStorage.setItem('skyjo-player-id', newerHint.playerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serializeResetRecoveryHint(newerHint));

    receive(socket, {
      type: 'ack',
      protocolVersion: 2,
      commandId: leaveCommand.commandId,
      revision: 1,
      result: 'room-left'
    });

    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-room-code')).toBe(newerHint.fromCode);
    expect(window.localStorage.getItem('skyjo-player-id')).toBe(newerHint.playerId);
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBe(serializeResetRecoveryHint(newerHint));
  });

  it('keeps a newer tab session in shared storage when an older tab receives a late seat removal', async () => {
    const { socket } = await createJoinedRoom();
    const newerHint: ResetRecoveryHint = {
      fromCode: 'FGHIJ',
      playerId: newerTabPlayerId,
      commandId: newerTabCommandId,
      expectedRevision: 4
    };
    window.localStorage.setItem('skyjo-room-code', newerHint.fromCode);
    window.localStorage.setItem('skyjo-player-id', newerHint.playerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serializeResetRecoveryHint(newerHint));

    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'seat-removed',
      message: 'The host removed this seat.'
    });

    expect(screen.getByText('The host removed this seat.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-room-code')).toBe(newerHint.fromCode);
    expect(window.localStorage.getItem('skyjo-player-id')).toBe(newerHint.playerId);
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBe(serializeResetRecoveryHint(newerHint));
  });

  it('retires a stale saved seat but keeps non-terminal recovery failures retryable', async () => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', savedRecoveryPlayerId);
    window.localStorage.setItem(RESET_RECOVERY_STORAGE_KEY, serializeResetRecoveryHint(validResetRecoveryHint));
    await renderLobby();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1_000 });
    const socket = openSocket();

    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'stale-seat',
      message: 'That saved room seat is no longer available.'
    });

    expect(screen.getByText('That saved room seat is no longer available.')).toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-player-id')).toBeNull();
    expect(window.localStorage.getItem('skyjo-room-code')).toBeNull();
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry Saved Seat' })).not.toBeInTheDocument();

    cleanup();
    FakeWebSocket.instances = [];
    await renderLobby();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
  });

  it('derives host and seat countdowns from server time without announcing every tick', async () => {
    const waitingRoom = makeRoom({
      players: [
        {
          id: 'p1',
          name: 'Alice',
          connected: false,
          host: true,
          controller: 'human',
          disconnectedAt: 1_000
        },
        { id: 'p2', userId: accountUser.id, name: 'Bob', connected: true, host: false, controller: 'human' }
      ],
      updatedAt: 31_000,
      serverNow: 31_000
    });
    const { socket } = await createJoinedRoom(waitingRoom, 'p2');
    const waitingHandoff = screen.getByTestId('host-transfer-status');
    expect(waitingHandoff).toHaveTextContent('Waiting-room host handoff in 0:30');
    expect(waitingHandoff.closest('[aria-live]')).toBeNull();

    receiveSnapshot(
      socket,
      makeRoom({
        players: waitingRoom.players,
        state: makeState(),
        status: 'playing',
        updatedAt: 61_000,
        serverNow: 61_000,
        revision: 1
      }),
      'p2'
    );
    const activeHandoff = screen.getByTestId('host-transfer-status');
    expect(activeHandoff).toHaveTextContent('Active-game host handoff in 1:00');
    expect(activeHandoff.closest('[aria-live]')).toBeNull();
  });

  it('offers AI takeover only after the server deadline and locks a locally AI-controlled seat', async () => {
    const activeRoom = makeRoom({
      players: [
        { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true, controller: 'human' },
        {
          id: 'p2',
          name: 'Bob',
          connected: false,
          host: false,
          controller: 'human',
          disconnectedAt: 1_000
        }
      ],
      state: makeState(),
      status: 'playing',
      updatedAt: 61_000,
      serverNow: 61_000
    });
    const { socket, user } = await createJoinedRoom(activeRoom);
    const countdown = screen.getByTestId('seat-countdown-p2');
    expect(countdown).toHaveTextContent('Reconnect window 1:00');
    expect(countdown.closest('[aria-live]')).toBeNull();
    expect(screen.queryByRole('button', { name: "Hand Bob's seat to AI" })).not.toBeInTheDocument();

    receiveSnapshot(
      socket,
      makeRoom({
        ...activeRoom,
        updatedAt: 61_001,
        serverNow: 121_001,
        revision: 1
      })
    );
    await user.click(screen.getByRole('button', { name: "Hand Bob's seat to AI" }));
    expectCommand(socket, { type: 'takeover-player-with-ai', playerId: 'p2' }, 1);

    cleanup();
    FakeWebSocket.instances = [];
    window.localStorage.clear();
    const aiRoom = makeRoom({
      players: [
        { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true, controller: 'ai' },
        { id: 'p2', name: 'Bob', connected: true, host: false, controller: 'human' }
      ],
      state: makeState(),
      status: 'playing'
    });
    await createJoinedRoom(aiRoom);
    expect(screen.getByRole('button', { name: 'Reset Room' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Room' })).toHaveAttribute(
      'title',
      'AI is controlling your seat. Keep this tab visible to reclaim it.'
    );
    expect(screen.getByText('AI controlled')).toBeInTheDocument();
  });

  it('joins sanitized codes and surfaces server, closed-socket, and share fallback errors', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderLobby(accountUser, '/lobby?room=a-b_c!12-more');
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    expect(screen.getByRole('textbox')).toHaveValue('ABC12');

    await user.click(screen.getByRole('button', { name: 'Join' }));
    const socket = openSocket();
    expect(lastFrame(socket)).toEqual({
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2,
      code: 'ABC12', name: 'Alice'
    });
    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-not-found',
      message: 'Room not found.'
    });
    expect(await screen.findByText('Room not found.')).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'error');
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();

    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText('Enter a room code.')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), 'a1-b2-c3');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    const joinedSocket = openSocket();
    receiveSnapshot(joinedSocket, makeRoom({ code: 'A1B2C' }));

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/rooms/invite') return response({ error: 'Invite service unavailable.' }, 503);
      return response({ user: accountUser });
    });
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('Skyjo room code: A1B2C'));
    expect(await screen.findByText('Invite service unavailable. Room code copied instead.')).toBeInTheDocument();
  });

  it('surfaces an exact create allocation failure and retires the pending room request', async () => {
    const user = userEvent.setup();
    await renderLobby();
    await user.click(screen.getByRole('button', { name: 'Create Room' }));
    const socket = openSocket();
    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-code-unavailable',
      message: 'A room code could not be created. Try again.'
    });

    expect(screen.getByText('A room code could not be created. Try again.')).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'error');
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(window.localStorage.getItem('skyjo-room-code')).toBeNull();
  });

  it('keeps the old room recoverable after a correlated reset allocation failure', async () => {
    const originalRoom = makeResetCapableRoom();
    const { socket, user } = await createJoinedRoom(originalRoom);
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    const resetCommand = expectCommand(socket, { type: 'reset-room' }, 0);
    expect(parseResetRecoveryHint(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY))).toMatchObject({
      fromCode: 'ABCDE',
      playerId: savedRecoveryPlayerId,
      commandId: resetCommand.commandId,
      expectedRevision: 0
    });
    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-code-unavailable',
      message: 'A room code could not be created. Try again.',
      commandId: resetCommand.commandId
    });

    expect(screen.getByRole('alert')).toHaveTextContent('A room code could not be created. Try again.');
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    expect(screen.getByRole('button', { name: 'Reset Room' })).toBeEnabled();
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('ABCDE');
    expect(window.localStorage.getItem(RESET_RECOVERY_STORAGE_KEY)).toBeNull();

    cleanup();
    FakeWebSocket.instances = [];
    await renderLobby();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const recovered = openSocket();
    expect(lastFrame(recovered)).toEqual({
      type: 'join-room',
      protocolVersion: 2,
      presenceVersion: 1,
      snapshotEnvelopeVersion: 2,
      code: 'ABCDE',
      name: 'Alice',
      playerId: savedRecoveryPlayerId
    });
    receiveSnapshot(recovered, makeResetCapableRoom({ updatedAt: 200 }), savedRecoveryPlayerId);
    expect(recovered.sent).toEqual([
      expect.objectContaining({ type: 'join-room' }),
      { type: 'set-presence', visible: true }
    ]);
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('ABCDE');
  });

  it('preserves a healthy socket on focus and autonomously rejoins the same seat after disconnect', async () => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', 'p1');
    window.localStorage.setItem('skyjo-player-name', 'Old name');
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const first = openSocket();
    expect(lastFrame(first)).toEqual({
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2,
      code: 'ABCDE', name: 'Alice', playerId: 'p1'
    });
    receiveSnapshot(first, makeRoom());
    expect(window.localStorage.getItem('skyjo-player-name')).toBe('Alice');

    act(() => window.dispatchEvent(new Event('focus')));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(first.closeCalls).toBe(0);
    expect(lastFrame(first)).toEqual({ type: 'set-presence', visible: true });

    act(() => first.serverClose());
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'reconnecting');
    expect(screen.getByText('ABCDE')).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1000 });
    const resumed = openSocket();
    expect(lastFrame(resumed)).toEqual({
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2,
      code: 'ABCDE', name: 'Alice', playerId: 'p1'
    });
    receiveSnapshot(resumed, makeRoom({ updatedAt: 200 }));
    expect(screen.getByText(/Bob online/)).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  });

  it('marks initial, live, resync, and reconnect snapshots for exact-once audio delivery', async () => {
    const latestAudioContext = () => audioMocks.useGameAudio.mock.calls.at(-1)?.[1];
    const { socket } = await createJoinedRoom(makeRoom({ revision: 4 }));

    await waitFor(() => expect(latestAudioContext()).toEqual({
      delivery: 'baseline',
      localPlayerId: 'p1',
      revision: 4,
      sessionId: 'ABCDE'
    }));

    receiveSnapshot(socket, makeRoom({ revision: 5, updatedAt: 200 }));
    await waitFor(() => expect(latestAudioContext()).toEqual({
      delivery: 'live',
      localPlayerId: 'p1',
      revision: 5,
      sessionId: 'ABCDE'
    }));

    receive(socket, resyncFrame(makeRoom({ revision: 6, updatedAt: 300 }), savedRecoveryCommandId));
    await waitFor(() => expect(latestAudioContext()).toEqual({
      delivery: 'resync',
      localPlayerId: 'p1',
      revision: 6,
      sessionId: 'ABCDE'
    }));

    act(() => socket.serverClose());
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1_000 });
    const reconnected = openSocket();
    receiveSnapshot(reconnected, makeRoom({ revision: 7, updatedAt: 400 }));
    await waitFor(() => expect(latestAudioContext()).toEqual({
      delivery: 'baseline',
      localPlayerId: 'p1',
      revision: 7,
      sessionId: 'ABCDE'
    }));
  });

  it('shows an initially offline lobby and disables room requests until online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await renderLobby();
    await waitFor(() =>
      expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'offline')
    );
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event('online')));
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
  });

  it('keeps application errors announced while an established transport remains connected', async () => {
    const { socket } = await createJoinedRoom();
    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'invalid-action',
      message: 'That move is not legal.'
    });

    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
    expect(screen.getByRole('alert')).toHaveTextContent('That move is not legal.');
    expect(socket.closeCalls).toBe(0);
  });

  it('offers retry and leave actions when a saved-seat recovery is rejected', async () => {
    const { socket, user } = await createJoinedRoom();
    act(() => socket.serverClose());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1000 });
    const rejected = openSocket();
    receive(rejected, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-not-found',
      message: 'Room not found.'
    });

    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'error');
    expect(screen.getByText('ABCDE')).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event('online')));
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
    expect(screen.getByRole('button', { name: 'Retry Saved Seat' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Leave Room' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry Saved Seat' }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3), { timeout: 1000 });
    const retried = openSocket();
    expect(lastFrame(retried)).toEqual({
      type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2,
      code: 'ABCDE', name: 'Alice', playerId: 'p1'
    });
    receive(retried, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-not-found',
      message: 'Room not found.'
    });

    await user.click(screen.getByRole('button', { name: 'Leave Room' }));
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeEnabled();
    expect(window.localStorage.getItem('skyjo-room-code')).toBeNull();
    expect(screen.queryByText('ABCDE')).not.toBeInTheDocument();
  });

  it('shows offline immediately, retains the last room read-only, and hard-disables multiplayer commands', async () => {
    const selectedDiscard = makeState({
      phase: 'choose-replacement',
      selectedSource: 'discard',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    const { socket, user } = await createJoinedRoom(makeRoom({ state: selectedDiscard, status: 'playing' }));

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));

    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'offline');
    expect(screen.getByText('ABCDE')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Put the discard card back.' })[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Room' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Replace with the discard card/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('gridcell', { name: /row 1, column 1, SKYJO face-down\. Not currently actionable/ })[0]).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Table Chat/ }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(socket.sent.filter((frame) => (frame as { type?: string }).type === 'update-state')).toHaveLength(0);
  });

  it('disables waiting-room host mutations until synchronization returns', async () => {
    await createJoinedRoom();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    expect(screen.getByRole('button', { name: 'Start Game' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Room' })).toBeDisabled();
  });

  it('rejects a new-code reset resync unless it matches the pending reset command', async () => {
    const { socket, user } = await createJoinedRoom(makeResetCapableRoom());
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    expectCommand(socket, { type: 'reset-room' }, 0);
    const forgedResetRoom = makeResetCapableRoom({
      code: 'FGHIJ',
      revision: 1
    });

    receive(
      socket,
      resyncFrame(
        forgedResetRoom,
        '11111111-1111-4111-8111-111111111111',
        savedRecoveryPlayerId,
        'room-reset'
      )
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The room server sent an invalid response. Reconnecting.');
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'reconnecting');
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('ABCDE');
    expect(screen.queryByText('FGHIJ')).not.toBeInTheDocument();
  });

  it('disables completed-round ready and next-round commands until synchronization returns', async () => {
    const user = userEvent.setup();
    const scoring = makeState({
      phase: 'round-over',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    await createJoinedRoom(
      makeRoom({ state: scoring, status: 'playing', readyForNextRoundPlayerIds: ['p1', 'p2'] })
    );
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    await user.click(screen.getByRole('button', { name: /Round scoring.*Open/ }));
    expect(await screen.findByRole('button', { name: 'Ready' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Next Round' })).toBeDisabled();
  });

  it('retains initial hidden visibility and publishes it immediately after the reconnect snapshot', async () => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', 'p1');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const socket = openSocket();
    receiveSnapshot(socket, makeRoom());
    expect(socket.sent).toEqual([
      {
        type: 'join-room', protocolVersion: 2, presenceVersion: 1, snapshotEnvelopeVersion: 2,
        code: 'ABCDE', name: 'Alice', playerId: 'p1'
      },
      { type: 'set-presence', visible: false }
    ]);
  });
});

describe('multiplayer game table', () => {
  it('sends protocol-v2 commands without whole state for every turn interaction', async () => {
    const openingState = makeState();
    const { socket, user } = await createJoinedRoom(makeRoom({ state: openingState, status: 'playing' }));

    expect(screen.getAllByText('Choose two face-down cards').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: /row 1, column 1, SKYJO face-down\. Reveal this opening card/ })[0]);
    const openingCommand = expectCommand(socket, { type: 'reveal-opening-card', cardIndex: 0 }, 0);
    const openingAfterReveal = makeState({
      players: [
        makePlayer('p1', 'Alice', {
          grid: makePlayer('p1', 'Alice').grid.map((card, index) => ({ ...card, faceUp: index === 0 }))
        }),
        makePlayer('p2', 'Bob')
      ],
      openingRevealCounts: { p1: 1, p2: 0 }
    });
    convergeCommand(
      socket,
      openingCommand,
      makeRoom({ state: openingAfterReveal, status: 'playing', revision: 1 })
    );

    const chooseSource = makeState({
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 },
      players: [
        makePlayer('p1', 'Alice', { grid: makePlayer('p1', 'Alice').grid.map((card, index) => ({ ...card, faceUp: index < 2 })) }),
        makePlayer('p2', 'Bob')
      ]
    });
    receiveSnapshot(socket, makeRoom({ state: chooseSource, status: 'playing', revision: 2 }));
    expect(screen.getAllByText('Choose a source').length).toBeGreaterThan(0);
    await user.click(screen.getAllByTitle('Take the top discard card.')[0]);
    const chooseCommand = expectCommand(socket, { type: 'choose-discard' }, 2);

    const discardSelected = { ...chooseSource, phase: 'choose-replacement' as const, selectedSource: 'discard' as const };
    convergeCommand(
      socket,
      chooseCommand,
      makeRoom({ state: discardSelected, status: 'playing', revision: 3 }),
      'ack-first'
    );
    expect(screen.getAllByText('Place the discard card').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Put the discard card back.' })[0]);
    const cancelCommand = expectCommand(socket, { type: 'cancel-discard' }, 3);
    convergeCommand(
      socket,
      cancelCommand,
      makeRoom({ state: chooseSource, status: 'playing', revision: 4 })
    );

    await user.click(screen.getAllByTitle('Draw blind from the deck.')[0]);
    const drawCommand = expectCommand(socket, { type: 'draw-blind' }, 4);

    const drawnState = {
      ...chooseSource,
      phase: 'choose-replacement' as const,
      selectedSource: 'draw' as const,
      drawnCard: makeCard('drawn', 9, true)
    };
    convergeCommand(socket, drawCommand, makeRoom({ state: drawnState, status: 'playing', revision: 5 }));
    expect(screen.getAllByRole('region', { name: 'Drawn card decision' }).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: /Discard \+ reveal/ })[0]);
    expect(screen.getAllByText('Discard + reveal selected. Choose a highlighted hidden card.').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: /row 1, column 3, SKYJO face-down\. Reveal after discarding the drawn card/ })[0]);
    const discardRevealCommand = expectCommand(socket, { type: 'discard-and-reveal', cardIndex: 2 }, 5);
    convergeCommand(
      socket,
      discardRevealCommand,
      makeRoom({ state: chooseSource, status: 'playing', revision: 6 })
    );

    receiveSnapshot(socket, makeRoom({ state: drawnState, status: 'playing', revision: 7 }));
    await user.click(screen.getAllByRole('button', { name: /Place drawn card/ })[0]);
    await user.click(screen.getAllByRole('button', { name: /row 1, column 1, .*Replace with the drawn card/ })[0]);
    expectCommand(socket, { type: 'replace-card', cardIndex: 0 }, 7);

    expect(socket.sent.some((frame) => (frame as { type?: string }).type === 'update-state')).toBe(false);
  });

  it('keeps commands pending until both ack and snapshot converge in either order', async () => {
    const chooseSource = makeState({
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 },
      players: [
        makePlayer('p1', 'Alice', {
          grid: makePlayer('p1', 'Alice').grid.map((card, index) => ({ ...card, faceUp: index < 2 }))
        }),
        makePlayer('p2', 'Bob')
      ]
    });
    const discardSelected = {
      ...chooseSource,
      phase: 'choose-replacement' as const,
      selectedSource: 'discard' as const
    };
    const { socket, user } = await createJoinedRoom(makeRoom({ state: chooseSource, status: 'playing' }));
    const deckButton = () => screen.getAllByText('Deck')[0].closest('button') as HTMLButtonElement;

    await user.click(screen.getAllByTitle('Take the top discard card.')[0]);
    const chooseCommand = expectCommand(socket, { type: 'choose-discard' }, 0);
    expect(deckButton()).toBeDisabled();

    receiveAck(socket, chooseCommand, 1);
    expect(deckButton()).toBeDisabled();
    receiveSnapshot(socket, makeRoom({ state: discardSelected, status: 'playing', revision: 1 }));
    expect(screen.getAllByRole('button', { name: 'Put the discard card back.' })[0]).toBeEnabled();

    await user.click(screen.getAllByRole('button', { name: 'Put the discard card back.' })[0]);
    const cancelCommand = expectCommand(socket, { type: 'cancel-discard' }, 1);
    receiveSnapshot(socket, makeRoom({ state: chooseSource, status: 'playing', revision: 2 }));
    expect(deckButton()).toBeDisabled();
    receiveAck(socket, cancelCommand, 2);
    expect(deckButton()).toBeEnabled();
  });

  it('applies an authoritative resync, clears the pending action, and invites a retry', async () => {
    const chooseSource = makeState({
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    const room = makeRoom({ state: chooseSource, status: 'playing' });
    const { socket, user } = await createJoinedRoom(room);

    await user.click(screen.getAllByTitle('Take the top discard card.')[0]);
    const command = expectCommand(socket, { type: 'choose-discard' }, 0);
    receive(socket, resyncFrame(room, command.commandId));

    expect(screen.getByRole('alert')).toHaveTextContent(/room changed before that action was accepted/i);
    expect(screen.getAllByTitle('Draw blind from the deck.')[0]).toBeEnabled();
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
  });

  it('fails closed when secure Web Crypto command ids are unavailable', async () => {
    const chooseSource = makeState({
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2 }
    });
    const { socket, user } = await createJoinedRoom(makeRoom({ state: chooseSource, status: 'playing' }));
    const sentBeforeAction = socket.sent.length;
    vi.stubGlobal('crypto', {});

    await user.click(screen.getAllByTitle('Take the top discard card.')[0]);
    expect(screen.getByRole('alert')).toHaveTextContent('Secure command ids are unavailable in this browser.');
    expect(socket.sent).toHaveLength(sentBeforeAction);

    await user.click(screen.getAllByTitle('Take the top discard card.')[0]);
    expect(socket.sent).toHaveLength(sentBeforeAction);
  });

  it('never renders or stores hidden server card ids and values from redacted snapshots', async () => {
    const alice = makePlayer('p1', 'Alice');
    alice.grid[0] = makeCard('server-secret-grid-card', 999);
    const bob = makePlayer('p2', 'Bob');
    const hiddenState = makeState({
      players: [alice, bob],
      currentPlayerIndex: 1,
      phase: 'choose-replacement',
      selectedSource: 'draw',
      drawnCard: makeCard('server-secret-blind-card', 997, true),
      drawPile: [makeCard('server-secret-draw-card', 998)],
      openingRevealCounts: { p1: 2, p2: 2 }
    });

    await createJoinedRoom(makeRoom({ state: hiddenState, status: 'playing' }));

    const rendered = document.body.innerHTML;
    const browserStorage = `${JSON.stringify(window.localStorage)}${JSON.stringify(window.sessionStorage)}`;
    expect(rendered).not.toContain('server-secret-grid-card');
    expect(rendered).not.toContain('server-secret-draw-card');
    expect(rendered).not.toContain('server-secret-blind-card');
    expect(rendered).not.toContain('999');
    expect(rendered).not.toContain('998');
    expect(rendered).not.toContain('997');
    expect(browserStorage).not.toContain('server-secret');
    expect(browserStorage).not.toContain('999');
    expect(browserStorage).not.toContain('998');
    expect(browserStorage).not.toContain('997');
  });

  it('renders one shared four-player table with opponent waits, final-lap states, and completed-round readiness controls', async () => {
    setMediaQueryMatches(PHONE_LAYOUT_MEDIA_QUERY, true);
    const fourPlayers = [
      makePlayer('p1', 'Alice'),
      makePlayer('p2', 'Bob'),
      makePlayer('p3', 'Carol'),
      makePlayer('p4', 'Drew')
    ];
    const waitingState = makeState({
      players: fourPlayers,
      currentPlayerIndex: 1,
      phase: 'choose-source',
      openingRevealCounts: { p1: 2, p2: 2, p3: 2, p4: 2 },
      roundCloserId: 'p3',
      finalTurnPlayerIds: ['p1', 'p2']
    });
    const { socket, user } = await createJoinedRoom(
      makeRoom({
        state: waitingState,
        status: 'playing',
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ]
      })
    );

    expect(screen.getAllByTestId('shared-game-table')).toHaveLength(1);
    expect(screen.getAllByTestId('table-center')).toHaveLength(1);
    expect(screen.getByTestId('opponent-rail')).toHaveAttribute('data-entry-count', '3');
    expect(screen.getByTestId('local-board')).toHaveAttribute('data-entry-count', '1');
    expect(screen.getByText('Waiting on Bob')).toBeInTheDocument();
    expect(screen.getByText('Bob is taking a final turn.')).toBeInTheDocument();
    expect(screen.getAllByTitle('Waiting for Bob.')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Drew' })).toBeInTheDocument();
    const roomOptionsTrigger = screen.getByRole('button', { name: 'Open room options' });
    await user.click(roomOptionsTrigger);
    expect(screen.getByRole('dialog', { name: 'Room ABCDE' })).toBeInTheDocument();
    expect(screen.getByText(/Carol away/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close room options' }));
    await waitFor(() => expect(roomOptionsTrigger).toHaveFocus());

    const roundOverPlayers = fourPlayers.map((player, index) => ({
      ...player,
      roundScore: 10 + index,
      totalScore: 20 + index
    }));
    const roundOver = makeState({
      players: roundOverPlayers,
      phase: 'round-over',
      round: 2,
      currentPlayerIndex: 0,
      roundCloserId: 'p3',
      finalTurnPlayerIds: [],
      openingRevealCounts: { p1: 2, p2: 2, p3: 2, p4: 2 },
      log: ['Round two scored.']
    });
    receiveSnapshot(
      socket,
      makeRoom({
        state: roundOver,
        status: 'finished',
        readyForNextRoundPlayerIds: ['p2', 'p3'],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 1
      })
    );

    await user.click(await screen.findByRole('button', { name: /Round scoring.*2\/4 ready.*Open/ }));
    expect(screen.getByRole('dialog', { name: 'Round complete.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Round complete.' })).toHaveFocus();
    expect(screen.getByText('Round two scored.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next Round' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: "I'm Ready" }));
    const readyCommand = expectCommand(socket, { type: 'set-next-round-ready', ready: true }, 1);

    convergeCommand(
      socket,
      readyCommand,
      makeRoom({
        state: roundOver,
        status: 'finished',
        readyForNextRoundPlayerIds: ['p1', 'p2', 'p3', 'p4'],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 2
      })
    );
    expect(screen.getByRole('button', { name: 'Ready' })).toBeInTheDocument();
    const nextRound = screen.getByRole('button', { name: 'Next Round' });
    expect(nextRound).toBeEnabled();
    await user.click(nextRound);
    const nextRoundCommand = expectCommand(socket, { type: 'start-game' }, 2);
    const nextRoundOpening = makeState({
      players: fourPlayers,
      phase: 'opening-reveal',
      round: 3,
      currentPlayerIndex: 0,
      openingRevealCounts: { p1: 0, p2: 0, p3: 0, p4: 0 }
    });
    convergeCommand(
      socket,
      nextRoundCommand,
      makeRoom({
        state: nextRoundOpening,
        status: 'playing',
        readyForNextRoundPlayerIds: [],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 3
      })
    );
    const guidance = screen.getByRole('region', { name: 'Action guidance' });
    await waitFor(() => expect(guidance).toHaveFocus());

    receiveSnapshot(
      socket,
      makeRoom({
        state: roundOver,
        status: 'finished',
        readyForNextRoundPlayerIds: ['p1', 'p2', 'p3', 'p4'],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 4
      })
    );
    await user.click(await screen.findByRole('button', { name: /Round scoring.*4\/4 ready.*Open/ }));
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    const summaryRestore = screen.getByRole('button', { name: /Round scoring.*4\/4 ready.*Open/ });
    expect(summaryRestore).toBeInTheDocument();
    await waitFor(() => expect(summaryRestore).toHaveFocus());

    const gameOver = { ...roundOver, phase: 'game-over' as const, winnerId: 'p1' };
    receiveSnapshot(
      socket,
      makeRoom({
        state: gameOver,
        status: 'finished',
        readyForNextRoundPlayerIds: [],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false, disconnectedAt: 1 },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 5
      })
    );
    await user.click(await screen.findByRole('button', { name: /Final totals.*0\/4 ready.*Open/ }));
    expect(screen.getByRole('heading', { name: 'Alice wins the game.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Game' })).toBeDisabled();
  });

  it('focuses and scrolls a desktop score disclosure, then restores its chip on Escape or minimize', async () => {
    const players = [makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')];
    const roundOver = makeState({
      players,
      phase: 'round-over',
      round: 2,
      currentPlayerIndex: 0,
      openingRevealCounts: { p1: 2, p2: 2 },
      log: ['Desktop round scored.']
    });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { user } = await createJoinedRoom(makeRoom({ state: roundOver, status: 'finished' }));

    let restore = await screen.findByRole('button', { name: /Round scoring.*Open/ });
    await user.click(restore);
    let title = screen.getByRole('heading', { name: 'Round complete.' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.queryByRole('dialog', { name: 'Round complete.' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    restore = await screen.findByRole('button', { name: /Round scoring.*Open/ });
    await waitFor(() => expect(restore).toHaveFocus());

    await user.click(restore);
    title = screen.getByRole('heading', { name: 'Round complete.' });
    await waitFor(() => expect(title).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    restore = await screen.findByRole('button', { name: /Round scoring.*Open/ });
    await waitFor(() => expect(restore).toHaveFocus());
  });
});
