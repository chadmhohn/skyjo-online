import { normalizePersistedGameState } from '../../../server-game-state-validation.mjs';
import { parseClientCommand, redactGameState } from '../../../src/protocolV2';
import { isMultiplayerRoomSnapshot } from '../../../src/roomConnection';
import type { GameState } from '../../../src/types';
import { readFixture, type FixtureCase } from './fixtureSupport';

function named(cases: FixtureCase[], name: string): FixtureCase {
  const fixture = cases.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing fixture ${name}.`);
  return fixture;
}

describe('current producer and consumer parity', () => {
  const gameValid = readFixture('game-state.valid.json').cases;
  const gameInvalid = readFixture('game-state.invalid.json').cases;
  const clientValid = readFixture('protocol-client.valid.json').cases;
  const clientInvalid = readFixture('protocol-client.invalid.json').cases;
  const serverValid = readFixture('protocol-server.valid.json').cases;
  const serverInvalid = readFixture('protocol-server.invalid.json').cases;

  it('normalizes every authoritative game-state fixture', () => {
    for (const fixture of gameValid) {
      expect(fixture.context, fixture.name).toBeDefined();
      expect(normalizePersistedGameState(fixture.value, fixture.context), fixture.name).toEqual(fixture.value);
    }
  });

  it('rejects every semantic game-state counterexample', () => {
    for (const fixture of gameInvalid.filter((candidate) => candidate.expectedLayer === 'semantic')) {
      expect(() => normalizePersistedGameState(fixture.value, fixture.context), fixture.name).toThrow();
    }
  });

  it('parses every canonical command fixture and covers all thirteen actions', () => {
    const commands = clientValid.filter((fixture) => (fixture.value as { type?: unknown }).type === 'command');
    for (const fixture of commands) expect(parseClientCommand(fixture.value), fixture.name).toMatchObject({ ok: true });
    const actionTypes = new Set(commands.map((fixture) => (
      fixture.value as { action: { type: string } }
    ).action.type));
    expect([...actionTypes].sort()).toEqual([
      'cancel-discard',
      'choose-discard',
      'discard-and-reveal',
      'draw-blind',
      'leave-room',
      'remove-player',
      'replace-card',
      'reset-room',
      'reveal-opening-card',
      'send-chat-message',
      'set-next-round-ready',
      'start-game',
      'takeover-player-with-ai'
    ]);
  });

  it('rejects malformed command envelopes through the runtime parser', () => {
    const commands = clientInvalid.filter((fixture) => {
      const type = (fixture.value as { type?: unknown })?.type;
      return type === 'command' || type === 'update-state';
    });
    for (const fixture of commands) expect(parseClientCommand(fixture.value).ok, fixture.name).toBe(false);
  });

  it('accepts every produced public room snapshot', () => {
    for (const fixture of serverValid) {
      const frame = fixture.value as { room?: unknown };
      if (frame.room) expect(isMultiplayerRoomSnapshot(frame.room), fixture.name).toBe(true);
    }
  });

  it('rejects public snapshot counterexamples in the current consumer', () => {
    for (const fixture of serverInvalid.filter((candidate) => candidate.expectedLayer === 'consumer')) {
      const frame = fixture.value as { revision?: number; room?: { revision?: number } };
      const roomAccepted = frame.room ? isMultiplayerRoomSnapshot(frame.room) : false;
      const revisionsMatch = frame.revision === frame.room?.revision;
      expect(roomAccepted && revisionsMatch, fixture.name).toBe(false);
    }
  });

  it('matches current viewer-specific redaction exactly', () => {
    const blindState = named(gameValid, 'private blind draw').value as GameState;
    const personalized = named(serverValid, 'personalized snapshot').value as {
      playerId: string;
      room: { state: unknown };
    };
    const shared = named(serverValid, 'shared public snapshot').value as { room: { state: unknown } };
    expect(personalized.room.state).toEqual(redactGameState(blindState, personalized.playerId));
    expect(shared.room.state).toEqual(redactGameState(blindState, blindState.players[1].id));
  });
});
