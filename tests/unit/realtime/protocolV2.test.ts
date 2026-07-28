import {
  MAX_RECENT_COMMAND_RECEIPTS,
  MULTIPLAYER_PROTOCOL_VERSION,
  PUBLIC_SNAPSHOT_LIMITS,
  createGameStateSnapshotProjector,
  createRoomSnapshot,
  hasPrivateDrawnCardVisibility,
  multiplayerRoomForRender,
  parseClientCommand,
  redactGameState,
  reduceAuthoritativeGameCommand,
  isWellFormedUnicode,
  type ClientCommand,
  type GameCommand
} from '../../../src/protocolV2';
import { createMultiplayerGame } from '../../../src/game';
import { isMultiplayerRoomSnapshot } from '../../../src/roomConnection';
import {
  REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES,
  sendRealtimeJson
} from '../../../src/serverRealtime';
import type { GameState, RoomPlayer } from '../../../src/types';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002'
];

const roster: RoomPlayer[] = [
  { id: 'p1', userId: 'account-1', name: 'Alice', connected: true, host: true },
  { id: 'p2', userId: 'account-2', name: 'Bob', connected: true, host: false }
];

function initialState(random = () => 0.5): GameState {
  return createMultiplayerGame(roster, 1, null, random);
}

function apply(state: GameState, playerId: string, action: GameCommand, random = () => 0.5): GameState {
  const result = reduceAuthoritativeGameCommand(state, playerId, action, random);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

function openedState(): GameState {
  let state = initialState();
  state = apply(state, 'p1', { type: 'reveal-opening-card', cardIndex: 0 });
  state = apply(state, 'p1', { type: 'reveal-opening-card', cardIndex: 1 });
  state = apply(state, 'p2', { type: 'reveal-opening-card', cardIndex: 0 });
  state = apply(state, 'p2', { type: 'reveal-opening-card', cardIndex: 1 });
  expect(state.phase).toBe('choose-source');
  return state;
}

function command(action: GameCommand, overrides: Partial<ClientCommand> = {}): ClientCommand {
  return {
    type: 'command',
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    commandId: ids[0],
    expectedRevision: 3,
    action,
    ...overrides
  };
}

describe('protocol v2 command schema and reducer', () => {
  it('accepts every exact action shape and canonicalizes it deterministically', () => {
    const actions: GameCommand[] = [
      { type: 'reveal-opening-card', cardIndex: 0 },
      { type: 'choose-discard' },
      { type: 'cancel-discard' },
      { type: 'draw-blind' },
      { type: 'replace-card', cardIndex: 11 },
      { type: 'discard-and-reveal', cardIndex: 4 },
      { type: 'set-next-round-ready', ready: true },
      { type: 'start-game' },
      { type: 'reset-room' },
      { type: 'leave-room' },
      { type: 'remove-player', playerId: 'p2' },
      { type: 'takeover-player-with-ai', playerId: 'p2' },
      { type: 'send-chat-message', text: 'hello' }
    ];
    actions.forEach((action, index) => {
      const parsed = parseClientCommand(command(action, { commandId: ids[index % ids.length] }));
      expect(parsed).toMatchObject({ ok: true, command: { action } });
      if (parsed.ok) expect(parsed.canonicalAction).toBe(JSON.stringify(action));
    });
  });

  it('preserves the previous PWA UTF-16 chat bound for astral text', () => {
    const maximum = '🙂'.repeat(PUBLIC_SNAPSHOT_LIMITS.chatMessageLength / 2);
    const oversized = `${maximum}🙂`;
    expect(maximum.length).toBe(PUBLIC_SNAPSHOT_LIMITS.chatMessageLength);
    expect(parseClientCommand(command({ type: 'send-chat-message', text: maximum })).ok).toBe(true);
    expect(parseClientCommand(command({ type: 'send-chat-message', text: oversized })).ok).toBe(false);
  });

  it('rejects lone surrogate code units in text and identifier actions', () => {
    for (const malformed of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      expect(parseClientCommand(command({ type: 'send-chat-message', text: `before${malformed}after` })).ok).toBe(false);
      expect(parseClientCommand(command({ type: 'remove-player', playerId: `p${malformed}` })).ok).toBe(false);
      expect(parseClientCommand(command({ type: 'takeover-player-with-ai', playerId: `p${malformed}` })).ok).toBe(false);
    }
  });

  it('rejects legacy, wrong-version, forged, unbounded, and malformed commands without reflecting attacker ids', () => {
    expect(parseClientCommand({ type: 'update-state', state: { forged: true } })).toMatchObject({
      ok: false,
      kind: 'upgrade-required'
    });
    expect(parseClientCommand({ ...command({ type: 'start-game' }), protocolVersion: 1 })).toMatchObject({
      ok: false,
      kind: 'upgrade-required'
    });
    const invalid = [
      null,
      [],
      { type: 'mystery' },
      { ...command({ type: 'start-game' }), commandId: 'x'.repeat(4_000) },
      { ...command({ type: 'start-game' }), expectedRevision: -1 },
      { ...command({ type: 'start-game' }), expectedRevision: 1.5 },
      { ...command({ type: 'start-game' }), playerId: 'p2' },
      command({ type: 'replace-card', cardIndex: 12 }),
      command({ type: 'replace-card', cardIndex: 0, value: 9 } as never),
      command({ type: 'set-next-round-ready', ready: 'yes' } as never),
      command({ type: 'leave-room', playerId: 'p2' } as never),
      command({ type: 'remove-player', playerId: '' }),
      command({ type: 'remove-player', playerId: 'x'.repeat(129) }),
      command({ type: 'takeover-player-with-ai', playerId: 'p2', extra: true } as never),
      command({ type: 'send-chat-message', text: 'x'.repeat(281) }),
      command({ type: 'unknown' } as never)
    ];
    invalid.forEach((value) => expect(parseClientCommand(value).ok).toBe(false));
    expect(parseClientCommand({ ...command({ type: 'start-game' }), protocolVersion: 1, commandId: 'x'.repeat(4_000) }))
      .not.toHaveProperty('commandId');
  });

  it('executes opening, discard, draw, replace, and discard-reveal solely from server state', () => {
    let state = initialState();
    const wrongActor = reduceAuthoritativeGameCommand(state, 'p2', { type: 'reveal-opening-card', cardIndex: 0 }, () => 0.5);
    expect(wrongActor).toEqual({ ok: false, message: 'It is not your turn.' });
    state = openedState();

    const selected = apply(state, 'p1', { type: 'choose-discard' });
    expect(selected).toMatchObject({ phase: 'choose-replacement', selectedSource: 'discard' });
    expect(apply(selected, 'p1', { type: 'cancel-discard' })).toMatchObject({ phase: 'choose-source', selectedSource: null });
    const placed = apply(selected, 'p1', { type: 'replace-card', cardIndex: 2 });
    expect(placed.currentPlayerIndex).toBe(1);

    const drawn = apply(state, 'p1', { type: 'draw-blind' });
    expect(drawn.drawnCard).not.toBeNull();
    expect(drawn.log[0]).toBe('Alice drew a blind card.');
    const replaced = apply(drawn, 'p1', { type: 'replace-card', cardIndex: 2 });
    expect(replaced.currentPlayerIndex).toBe(1);

    const drawnAgain = apply(state, 'p1', { type: 'draw-blind' });
    const revealed = apply(drawnAgain, 'p1', { type: 'discard-and-reveal', cardIndex: 2 });
    expect(revealed.players[0].grid[2].faceUp).toBe(true);
  });

  it('owns recycle randomness and rejects every illegal phase/source/index without consuming RNG', () => {
    const opened = openedState();
    const recycle = {
      ...opened,
      drawPile: [],
      discardPile: [opened.discardPile[0], ...opened.drawPile.slice(0, 4)]
    };
    const random = vi.fn(() => 0.25);
    const recycled = reduceAuthoritativeGameCommand(recycle, 'p1', { type: 'draw-blind' }, random);
    expect(recycled.ok).toBe(true);
    expect(random).toHaveBeenCalled();

    const exhausted = { ...opened, drawPile: [], discardPile: [opened.discardPile[0]] };
    const illegalRandom = vi.fn(() => 0.5);
    const illegal: Array<[GameState | null, string, GameCommand]> = [
      [null, 'p1', { type: 'draw-blind' }],
      [exhausted, 'p1', { type: 'draw-blind' }],
      [{ ...opened, discardPile: [] }, 'p1', { type: 'choose-discard' }],
      [opened, 'p1', { type: 'cancel-discard' }],
      [opened, 'p1', { type: 'replace-card', cardIndex: 0 }],
      [opened, 'p1', { type: 'discard-and-reveal', cardIndex: 0 }],
      [opened, 'p1', { type: 'start-game' }]
    ];
    illegal.forEach(([state, playerId, action]) => {
      expect(reduceAuthoritativeGameCommand(state, playerId, action, illegalRandom).ok).toBe(false);
    });
    expect(illegalRandom).not.toHaveBeenCalled();
  });

  it('exports the bounded durable receipt window contract', () => {
    expect(MAX_RECENT_COMMAND_RECEIPTS).toBe(128);
  });
});

describe('protocol v2 player-specific projection', () => {
  function roomWithState(state: GameState) {
    return {
      code: 'ABCDE',
      hostId: 'p1',
      players: roster,
      chatMessages: [{ id: 'c1', playerId: 'p1', playerName: 'Alice', text: 'hello', createdAt: 1 }],
      readyForNextRoundPlayerIds: [],
      state,
      status: 'playing' as const,
      updatedAt: 10,
      completedGameId: null,
      revision: 4
    };
  }

  it('exposes count/top only, nulls hidden values and ids, and scopes a blind draw to its seat', () => {
    const drawn = apply(openedState(), 'p1', { type: 'draw-blind' });
    const alice = createRoomSnapshot(roomWithState(drawn), 'p1');
    const bob = createRoomSnapshot(roomWithState(drawn), 'p2');
    const otherViewerIds = ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

    expect(alice.state?.drawPileCount).toBe(drawn.drawPile.length);
    expect(alice.state).not.toHaveProperty('drawPile');
    expect(alice.state?.discardPile).toEqual({
      count: drawn.discardPile.length,
      top: expect.objectContaining({ id: 'discard-top', value: drawn.discardPile[0].value })
    });
    expect(alice.state?.players.flatMap((player) => player.grid).filter((card) => !card.faceUp).every((card) => card.value === null)).toBe(true);
    const internalIds = [
      ...drawn.players.flatMap((player) => player.grid.map((card) => card.id)),
      ...drawn.drawPile.map((card) => card.id),
      ...drawn.discardPile.map((card) => card.id),
      ...(drawn.drawnCard ? [drawn.drawnCard.id] : [])
    ];
    internalIds.forEach((id) => expect(JSON.stringify(alice)).not.toContain(`"${id}"`));
    expect(alice.state?.drawnCard?.value).toBe(drawn.drawnCard?.value);
    expect(hasPrivateDrawnCardVisibility(drawn, 'p1')).toBe(true);
    expect(otherViewerIds.every((viewerId) => !hasPrivateDrawnCardVisibility(drawn, viewerId))).toBe(true);
    expect(bob.state?.drawnCard).toBeNull();
    expect(bob.state?.hasDrawnCard).toBe(true);
    expect(JSON.stringify(bob)).not.toContain(String(drawn.drawnCard?.id));
    for (const viewerId of otherViewerIds.slice(1)) {
      expect(createRoomSnapshot(roomWithState(drawn), viewerId)).toEqual(bob);
    }
  });

  it('reuses write-only projections only for the same immutable state and visibility', () => {
    const projector = createGameStateSnapshotProjector();
    const drawn = apply(openedState(), 'p1', { type: 'draw-blind' });
    const publicForBob = projector(drawn, 'p2');
    const publicForAnotherViewer = projector(drawn, 'p3');
    const privateForDrawer = projector(drawn, 'p1');

    expect(publicForAnotherViewer).toBe(publicForBob);
    expect(projector(drawn, 'p2')).toBe(publicForBob);
    expect(privateForDrawer).not.toBe(publicForBob);
    expect(privateForDrawer.drawnCard?.value).toBe(drawn.drawnCard?.value);
    expect(publicForBob.drawnCard).toBeNull();
    const detached = redactGameState(drawn, 'p2');
    expect(detached).not.toBe(publicForBob);
    detached.players[0].name = 'Detached mutation';
    expect(publicForBob.players[0].name).toBe('Alice');

    const replaced = apply(drawn, 'p1', { type: 'replace-card', cardIndex: 2 });
    const nextProjection = projector(replaced, 'p2');
    expect(nextProjection).not.toBe(publicForBob);
    expect(nextProjection.currentPlayerIndex).toBe(1);

    const firstRoom = createRoomSnapshot(roomWithState(drawn), 'p2', 10, undefined, projector);
    const secondRoom = createRoomSnapshot(roomWithState(drawn), 'p3', 11, undefined, projector);
    expect(firstRoom.state).toBe(publicForBob);
    expect(secondRoom.state).toBe(publicForBob);
    expect(firstRoom.serverNow).toBe(10);
    expect(secondRoom.serverNow).toBe(11);
  });

  it('sanitizes historical numeric draw logs before, during, and after later moves', () => {
    const opened = openedState();
    const drawn = apply(opened, 'p1', { type: 'draw-blind' });
    drawn.log.push('Alice drew a 12.', 'Bob drew a -2.');
    const during = redactGameState(drawn, 'p2');
    expect(during.log.every((entry) => !/drew a -?\d+/.test(entry))).toBe(true);
    const after = apply(drawn, 'p1', { type: 'replace-card', cardIndex: 2 });
    const later = redactGameState(after, 'p2');
    expect(later.log.every((entry) => !/drew a -?\d+/.test(entry))).toBe(true);
  });

  it('uses explicit allowlists and returns detached snapshots even with injected internal sentinels', () => {
    const state = openedState() as GameState & Record<string, unknown>;
    Object.assign(state.players[0], { secretPlayer: 'PLAYER_SECRET' });
    Object.assign(state.players[0].grid[0], { secretCard: 'CARD_SECRET' });
    state.roundHistory = [{
      round: 1,
      closerId: 'p1',
      scores: [{ playerId: 'p1', name: 'Alice', roundScore: 2, totalScore: 2, secretScore: 'SCORE_SECRET' } as never],
      secretHistory: 'HISTORY_SECRET'
    } as never];
    const source = roomWithState(state);
    Object.assign(source.chatMessages[0], { secretChat: 'CHAT_SECRET' });
    const snapshot = createRoomSnapshot(source, 'p1');
    const wire = JSON.stringify(snapshot);
    ['PLAYER_SECRET', 'CARD_SECRET', 'SCORE_SECRET', 'HISTORY_SECRET', 'CHAT_SECRET', 'account-1'].forEach((secret) => {
      expect(wire).not.toContain(secret);
    });
    snapshot.players[0].name = 'Changed';
    expect(source.players[0].name).toBe('Alice');
  });

  it('canonicalizes malformed producer text before public projection', () => {
    const malformed = String.fromCharCode(0xd800);
    const state = openedState();
    state.players[0].name = `A${malformed}B`;
    state.log = [`A${malformed}B`];
    const source = roomWithState(state);
    source.players[0].name = `A${malformed}B`;
    source.chatMessages[0].playerName = `A${malformed}B`;
    source.chatMessages[0].text = `A${malformed}B`;

    const snapshot = createRoomSnapshot(source, 'p1');
    expect(snapshot.players[0].name).toBe('A�B');
    expect(snapshot.state?.players[0].name).toBe('A�B');
    expect(snapshot.state?.log[0]).toBe('A�B');
    expect(snapshot.chatMessages[0]).toMatchObject({ playerName: 'A�B', text: 'A�B' });
    expect(isWellFormedUnicode(JSON.stringify(snapshot))).toBe(true);
  });

  it('projects the persisted superset into the exact bounded public contract below the outbound cap', () => {
    const playerIds = Array.from(
      { length: PUBLIC_SNAPSHOT_LIMITS.players },
      (_, index) => `${String(index).padStart(3, '0')}${'p'.repeat(PUBLIC_SNAPSHOT_LIMITS.identifierLength - 3)}`
    );
    const stateRoster = playerIds.map((id, index) => ({
      id,
      name: `${String(index)}${'N'.repeat(63)}`
    }));
    const state = createMultiplayerGame(stateRoster, 257, null, () => 0.5);
    state.log = Array.from({ length: 8 }, (_, index) => `${index}${'L'.repeat(511)}`);
    state.roundHistory = Array.from({ length: 256 }, (_, index) => ({
      round: index + 1,
      closerId: playerIds[index % playerIds.length],
      scores: playerIds.map((playerId, playerIndex) => ({
        playerId,
        name: `${String(playerIndex)}${'H'.repeat(63)}`,
        roundScore: 0,
        totalScore: 0
      }))
    }));
    const source = {
      code: 'ABCDE',
      hostId: playerIds[0],
      players: playerIds.map((id, index) => ({
        id,
        name: `${String(index)}${'R'.repeat(PUBLIC_SNAPSHOT_LIMITS.nameLength - 1)}`,
        connected: true,
        host: index === 0
      })),
      chatMessages: Array.from({ length: PUBLIC_SNAPSHOT_LIMITS.chatMessages }, (_, index) => ({
        id: `${String(index).padStart(3, '0')}${'c'.repeat(PUBLIC_SNAPSHOT_LIMITS.identifierLength - 3)}`,
        playerId: playerIds[index % playerIds.length],
        playerName: `${String(index % playerIds.length)}${'C'.repeat(23)}`,
        text: index === 0
          ? '🙂'.repeat((PUBLIC_SNAPSHOT_LIMITS.chatMessageLength / 2) + 1)
          : 'T'.repeat(PUBLIC_SNAPSHOT_LIMITS.chatMessageLength),
        createdAt: index + 1
      })),
      readyForNextRoundPlayerIds: [],
      state,
      status: 'playing' as const,
      updatedAt: 10,
      completedGameId: 'g'.repeat(PUBLIC_SNAPSHOT_LIMITS.identifierLength),
      revision: 4
    };

    const snapshot = createRoomSnapshot(source, playerIds[0]);
    expect(snapshot.players).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.players);
    expect(snapshot.players.every((player) => player.name.length === PUBLIC_SNAPSHOT_LIMITS.nameLength)).toBe(true);
    expect(snapshot.chatMessages).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.chatMessages);
    expect(snapshot.chatMessages.every((message) =>
      message.playerName.length === PUBLIC_SNAPSHOT_LIMITS.nameLength &&
      message.text.length === PUBLIC_SNAPSHOT_LIMITS.chatMessageLength
    )).toBe(true);
    expect(snapshot.chatMessages[0].text).toBe('🙂'.repeat(PUBLIC_SNAPSHOT_LIMITS.chatMessageLength / 2));
    expect(snapshot.state?.log).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.logEntries);
    expect(snapshot.state?.log.every((entry) => entry.length === PUBLIC_SNAPSHOT_LIMITS.logEntryLength)).toBe(true);
    expect(snapshot.state?.roundHistory).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.historyEntries);
    expect(snapshot.state?.roundHistory[0].round).toBe(157);
    expect(snapshot.state?.roundHistory.every((entry) =>
      entry.scores.every((score) => score.name.length === PUBLIC_SNAPSHOT_LIMITS.nameLength)
    )).toBe(true);
    expect(snapshot.players.map((player) => player.id)).toEqual(playerIds);
    expect(isMultiplayerRoomSnapshot(snapshot, source.code)).toBe(true);

    const frame = {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      playerId: playerIds[0],
      revision: source.revision,
      room: snapshot
    };
    const byteLength = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    expect(byteLength).toBeLessThan(REALTIME_MAX_OUTBOUND_PUBLIC_FRAME_BYTES);
    const send = vi.fn();
    expect(sendRealtimeJson({
      OPEN: 1,
      readyState: 1,
      on: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      send,
      terminate: vi.fn()
    }, frame)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it('adapts counts to null client-only placeholders without inventing hidden information', () => {
    const snapshot = createRoomSnapshot(roomWithState(openedState()), 'p1');
    if (!snapshot.state) throw new Error('missing state');
    snapshot.state.discardPile.count = 5;
    const render = multiplayerRoomForRender(snapshot);
    expect(render.state?.drawPile).toHaveLength(snapshot.state.drawPileCount);
    expect(render.state?.discardPile).toHaveLength(5);
    expect(render.state?.discardPile.slice(1).every((card) => card.value === null)).toBe(true);
  });

  it('keeps malformed face-down tombstone values redacted', () => {
    const state = openedState();
    state.players[0].grid[2] = { ...state.players[0].grid[2], faceUp: false, removed: true };
    expect(redactGameState(state, 'p1').players[0].grid[2].value).toBeNull();
  });
});
