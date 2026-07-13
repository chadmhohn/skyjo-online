import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../../../src/App';
import type { AccountUser } from '../../../src/account';
import {
  createRoomSnapshot,
  type ClientCommand,
  type GameCommand,
  type PublicRoomSnapshot
} from '../../../src/protocolV2';
import type { Card, GameState, MultiplayerRoom, Player, RoomChatMessage } from '../../../src/types';

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
  readyState = FakeWebSocket.CONNECTING;
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
    this.sent.push(JSON.parse(data));
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
    viewerPlayerId
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
  if (user) await screen.findByRole('heading', { name: 'Multiplayer Lobby' });
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

async function createJoinedRoom(room = makeRoom()) {
  const user = userEvent.setup();
  await renderLobby();
  expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'idle');
  await user.click(screen.getByRole('button', { name: 'Create Room' }));
  expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connecting');
  expect(screen.getByRole('button', { name: 'Create Room' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  const socket = openSocket();
  expect(lastFrame(socket)).toEqual({ type: 'create-room', protocolVersion: 2, name: 'Alice' });
  receiveSnapshot(socket, room);
  await screen.findByText(room.code);
  return { room, socket, user };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('multiplayer lobby', () => {
  it('requires an account and preserves a sanitized shared room in the sign-in handoff', async () => {
    await renderLobby(null, '/lobby?room=a-b_c!12-extra');

    expect(await screen.findByRole('heading', { name: 'Sign in to play multiplayer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute(
      'href',
      '/account?next=%2Flobby%3Froom%3Da-b_c!12-extra'
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('creates and runs a waiting room with host, sharing, chat, presence, start, and reset frames', async () => {
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
    expect(screen.getByText(/Need at least two players to start/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Game' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(
        'Join my Skyjo room ABCDE: http://localhost:3000/invite/secure-token'
      )
    );
    expect(await screen.findByText('Link copied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Table Chat/ }));
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
    expect(socket.sent.slice(-2)).toEqual([
      { type: 'set-presence', visible: true },
      { type: 'set-presence', visible: false }
    ]);

    await user.click(screen.getByRole('button', { name: 'Start Game' }));
    const startCommand = expectCommand(socket, { type: 'start-game' }, 1);
    convergeCommand(
      socket,
      startCommand,
      makeRoom({ state: makeState(), status: 'playing', chatMessages: [bobMessage], revision: 2 }),
      'ack-first'
    );

    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    const resetCommand = expectCommand(socket, { type: 'reset-room' }, 2);
    const resetRoom = makeRoom({
      code: 'FGHIJ',
      players: [{ id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true }],
      revision: 3
    });
    receive(socket, resyncFrame(resetRoom, resetCommand.commandId, 'p1', 'room-reset'));
    receiveAck(socket, resetCommand, 3);
    expect(await screen.findByText('FGHIJ')).toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-room-code')).toBe('FGHIJ');

    receive(socket, {
      type: 'error',
      protocolVersion: 2,
      code: 'room-reset',
      message: 'The host reset this room. Ask for the new room link to rejoin.'
    });
    expect(await screen.findByText('The host reset this room. Ask for the new room link to rejoin.')).toBeInTheDocument();
    expect(window.localStorage.getItem('skyjo-player-id')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create Room' })).toBeInTheDocument();
  });

  it('joins sanitized codes and surfaces server, closed-socket, and share fallback errors', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderLobby(accountUser, '/lobby?room=a-b_c!12-more');
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    expect(screen.getByRole('textbox')).toHaveValue('ABC12');

    await user.click(screen.getByRole('button', { name: 'Join' }));
    const socket = openSocket();
    expect(lastFrame(socket)).toEqual({ type: 'join-room', protocolVersion: 2, code: 'ABC12', name: 'Alice' });
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

  it('preserves a healthy socket on focus and autonomously rejoins the same seat after disconnect', async () => {
    window.localStorage.setItem('skyjo-room-code', 'ABCDE');
    window.localStorage.setItem('skyjo-player-id', 'p1');
    window.localStorage.setItem('skyjo-player-name', 'Old name');
    await renderLobby();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 1000 });
    const first = openSocket();
    expect(lastFrame(first)).toEqual({ type: 'join-room', protocolVersion: 2, code: 'ABCDE', name: 'Alice', playerId: 'p1' });
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
    expect(lastFrame(resumed)).toEqual({ type: 'join-room', protocolVersion: 2, code: 'ABCDE', name: 'Alice', playerId: 'p1' });
    receiveSnapshot(resumed, makeRoom({ updatedAt: 200 }));
    expect(screen.getByText(/Bob online/)).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveAttribute('data-connection-state', 'connected');
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
    expect(lastFrame(retried)).toEqual({ type: 'join-room', protocolVersion: 2, code: 'ABCDE', name: 'Alice', playerId: 'p1' });
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
    expect(screen.getAllByRole('button', { name: /Replace card 1 with the discard card/ })[0]).toBeDisabled();

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
    const { socket, user } = await createJoinedRoom();
    await user.click(screen.getByRole('button', { name: 'Reset Room' }));
    expectCommand(socket, { type: 'reset-room' }, 0);
    const forgedResetRoom = makeRoom({
      code: 'FGHIJ',
      players: [{ id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true }],
      revision: 1
    });

    receive(
      socket,
      resyncFrame(
        forgedResetRoom,
        '11111111-1111-4111-8111-111111111111',
        'p1',
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
    expect(screen.getByRole('button', { name: 'Ready' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next Round' })).toBeDisabled();
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
      { type: 'join-room', protocolVersion: 2, code: 'ABCDE', name: 'Alice', playerId: 'p1' },
      { type: 'set-presence', visible: false }
    ]);
  });
});

describe('multiplayer game table', () => {
  it('sends protocol-v2 commands without whole state for every turn interaction', async () => {
    const openingState = makeState();
    const { socket, user } = await createJoinedRoom(makeRoom({ state: openingState, status: 'playing' }));

    expect(screen.getAllByText('Choose two face-down cards').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Reveal opening card 1.' })[0]);
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
    expect(screen.getAllByText('Drawn card waiting').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: /Discard \+ reveal/ })[0]);
    expect(screen.getAllByText('Discard mode: select a highlighted hidden card.').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Reveal hidden card 3 after discarding the drawn card.' })[0]);
    const discardRevealCommand = expectCommand(socket, { type: 'discard-and-reveal', cardIndex: 2 }, 5);
    convergeCommand(
      socket,
      discardRevealCommand,
      makeRoom({ state: chooseSource, status: 'playing', revision: 6 })
    );

    receiveSnapshot(socket, makeRoom({ state: drawnState, status: 'playing', revision: 7 }));
    await user.click(screen.getAllByRole('button', { name: /Place drawn card/ })[0]);
    await user.click(screen.getAllByRole('button', { name: 'Replace card 1 with the drawn card.' })[0]);
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

  it('renders opponent waits, four-player boards, final-lap states, and completed-round readiness controls', async () => {
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
          { id: 'p3', name: 'Carol', connected: false, host: false },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ]
      })
    );

    expect(screen.getAllByText('Waiting on Bob').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bob is taking a final turn.').length).toBeGreaterThan(0);
    expect(screen.getByText(/Carol away/)).toBeInTheDocument();
    expect(screen.getAllByTitle('Waiting for Bob.').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { name: 'Drew' }).length).toBeGreaterThan(0);

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
          { id: 'p3', name: 'Carol', connected: false, host: false },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 1
      })
    );

    await user.click(await screen.findByRole('button', { name: /Round scoring.*2\/4 ready.*Open/ }));
    expect(screen.getByRole('heading', { name: 'Round complete.' })).toBeInTheDocument();
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
          { id: 'p3', name: 'Carol', connected: false, host: false },
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
    convergeCommand(
      socket,
      nextRoundCommand,
      makeRoom({
        state: roundOver,
        status: 'finished',
        readyForNextRoundPlayerIds: ['p1', 'p2', 'p3', 'p4'],
        players: [
          { id: 'p1', userId: accountUser.id, name: 'Alice', connected: true, host: true },
          { id: 'p2', name: 'Bob', connected: true, host: false },
          { id: 'p3', name: 'Carol', connected: false, host: false },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 3
      })
    );
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByRole('button', { name: /Round scoring.*4\/4 ready.*Open/ })).toBeInTheDocument();

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
          { id: 'p3', name: 'Carol', connected: false, host: false },
          { id: 'p4', name: 'Drew', connected: true, host: false }
        ],
        revision: 4
      })
    );
    await user.click(await screen.findByRole('button', { name: /Final totals.*0\/4 ready.*Open/ }));
    expect(screen.getByRole('heading', { name: 'Alice wins the game.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Game' })).toBeDisabled();
  });
});
