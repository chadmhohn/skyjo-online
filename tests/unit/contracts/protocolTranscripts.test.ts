import path from 'node:path';
import { createContractAjv, fixtureRoot, readJson } from './fixtureSupport';

interface TranscriptStep {
  input: unknown;
  output: Array<Record<string, unknown>>;
  resultingRevision: number;
}

interface Transcript {
  name: string;
  initialRevision: number;
  steps: TranscriptStep[];
}

describe('protocol-v2 deterministic transcripts', () => {
  const document = readJson<{ transcripts: Transcript[] }>(path.join(fixtureRoot, 'protocol-transcripts.json'));
  const { validators } = createContractAjv();
  const client = validators.get('protocol-v2-client-frame.schema.json');
  const server = validators.get('protocol-v2-server-frame.schema.json');

  it('contains stale, future, replay, conflict, reset, and reset-recovery scenarios', () => {
    expect(document.transcripts.map((transcript) => transcript.name)).toEqual([
      'exact replay and conflicting command id',
      'stale revision',
      'future revision',
      'room reset and old-code recovery'
    ]);
  });

  it('keeps every transcript frame within the published schemas', () => {
    if (!client || !server) throw new Error('Protocol schemas were not compiled.');
    for (const transcript of document.transcripts) {
      for (const step of transcript.steps) {
        expect(client(step.input), `${transcript.name} input: ${JSON.stringify(client.errors)}`).toBe(true);
        for (const output of step.output) {
          expect(server(output), `${transcript.name} output: ${JSON.stringify(server.errors)}`).toBe(true);
        }
      }
    }
  });

  it('records exactly-once replay without a second revision increment', () => {
    const transcript = document.transcripts[0];
    expect(transcript.steps[0].output.map((frame) => frame.type)).toEqual(['snapshot', 'ack']);
    expect(transcript.steps[1].output.map((frame) => frame.type)).toEqual(['snapshot', 'ack']);
    expect(transcript.steps[0].resultingRevision).toBe(8);
    expect(transcript.steps[1].resultingRevision).toBe(8);
    expect(transcript.steps[2].output).toEqual([
      expect.objectContaining({ type: 'error', code: 'command-id-conflict' })
    ]);
  });

  it('resyncs stale and future revisions without mutation', () => {
    for (const transcript of document.transcripts.slice(1, 3)) {
      expect(transcript.steps[0].resultingRevision).toBe(transcript.initialRevision);
      expect(transcript.steps[0].output).toEqual([
        expect.objectContaining({ type: 'resync', reason: `${transcript.name.split(' ')[0]}-revision` })
      ]);
    }
  });

  it('recovers a reset through the prior room code and command id', () => {
    const transcript = document.transcripts[3];
    expect(transcript.steps[0].output.map((frame) => frame.type)).toEqual(['resync', 'ack']);
    expect(transcript.steps[1].output.map((frame) => frame.type)).toEqual(['resync', 'ack']);
    for (const step of transcript.steps) {
      expect(step.output[0]).toMatchObject({ type: 'resync', reason: 'room-reset', revision: 8 });
      expect((step.output[0].room as { code: string }).code).toBe('FGHIJ');
    }
  });
});
