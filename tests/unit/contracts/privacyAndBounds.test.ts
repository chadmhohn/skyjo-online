import { MAX_INBOUND_CLIENT_FRAME_BYTES, PUBLIC_SNAPSHOT_LIMITS } from '../../../src/protocolV2';
import { readFixture, type FixtureCase } from './fixtureSupport';

function named(cases: FixtureCase[], name: string): FixtureCase {
  const fixture = cases.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing fixture ${name}.`);
  return fixture;
}

describe('privacy and portable bounds', () => {
  const serverValid = readFixture('protocol-server.valid.json').cases;
  const serverInvalid = readFixture('protocol-server.invalid.json').cases;
  const clientInvalid = readFixture('protocol-client.invalid.json').cases;

  it('reveals a blind draw only to its current drawer', () => {
    const personalized = named(serverValid, 'personalized snapshot').value as {
      room: { state: { hasDrawnCard: boolean; drawnCard: { value: number } | null } };
    };
    const shared = named(serverValid, 'shared public snapshot').value as {
      room: { state: { hasDrawnCard: boolean; drawnCard: unknown } };
    };
    expect(personalized.room.state.hasDrawnCard).toBe(true);
    expect(personalized.room.state.drawnCard?.value).toBeTypeOf('number');
    expect(shared.room.state).toMatchObject({ hasDrawnCard: true, drawnCard: null });
  });

  it('contains no authoritative pile, physical card id, account id field, or numeric blind-draw log in wire fixtures', () => {
    const serialized = JSON.stringify(serverValid.map((fixture) => fixture.value));
    expect(serialized).not.toMatch(/"drawPile":/);
    expect(serialized).not.toMatch(/"userId":/);
    expect(serialized).not.toMatch(/"id":"card-/);
    expect(serialized).not.toMatch(/drew a -?\d+\./);
  });

  it('publishes exact maximum collection and string bounds after projection', () => {
    const bounded = named(serverValid, 'bounded shared snapshot').value as {
      room: {
        chatMessages: Array<{ text: string }>;
        players: Array<{ name: string }>;
        state: { log: string[]; roundHistory: unknown[] };
      };
    };
    expect(bounded.room.players).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.players);
    expect(Math.max(...bounded.room.players.map((player) => player.name.length))).toBe(PUBLIC_SNAPSHOT_LIMITS.nameLength);
    expect(bounded.room.chatMessages).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.chatMessages);
    expect(bounded.room.chatMessages.every((message) => message.text.length === PUBLIC_SNAPSHOT_LIMITS.chatMessageLength)).toBe(true);
    expect(bounded.room.state.log).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.logEntries);
    expect(bounded.room.state.log.every((entry) => entry.length === PUBLIC_SNAPSHOT_LIMITS.logEntryLength)).toBe(true);
    expect(bounded.room.state.roundHistory).toHaveLength(PUBLIC_SNAPSHOT_LIMITS.historyEntries);
  });

  it('marks viewer-specific private leakage as invalid', () => {
    const leaked = named(serverInvalid, 'private draw leaked in shared frame').value as {
      room: { state: { drawnCard: unknown } };
    };
    expect(leaked.room.state.drawnCard).not.toBeNull();
  });

  it('includes an encoded frame beyond the inbound byte ceiling', () => {
    const oversized = named(clientInvalid, 'frame byte limit exceeded');
    expect(oversized.wireBytes).toBeGreaterThan(MAX_INBOUND_CLIENT_FRAME_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversized.value), 'utf8')).toBe(oversized.wireBytes);
  });
});
