import {
  MAX_RECENT_COMMAND_RECEIPTS,
  MULTIPLAYER_PROTOCOL_VERSION,
  createRoomSnapshot,
  multiplayerRoomForRender,
  parseClientCommand,
  redactGameState,
  reduceAuthoritativeGameCommand,
  type ClientCommand,
  type GameCommand
} from '../../../src/protocolV2';
import { createMultiplayerGame } from '../../../src/game';
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
      { type: 'send-chat-message', text: 'hello' }
    ];
    actions.forEach((action, index) => {
      const parsed = parseClientCommand(command(action, { commandId: ids[index % ids.length] }));
      expect(parsed).toMatchObject({ ok: true, command: { action } });
      if (parsed.ok) expect(parsed.canonicalAction).toBe(JSON.stringify(action));
    });
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
    expect(bob.state?.drawnCard).toBeNull();
    expect(bob.state?.hasDrawnCard).toBe(true);
    expect(JSON.stringify(bob)).not.toContain(String(drawn.drawnCard?.id));
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
