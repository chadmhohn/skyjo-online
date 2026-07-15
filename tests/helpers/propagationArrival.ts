import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  parseClientCommand,
  type GameCommand
} from '../../src/protocolV2';

export type PropagationFrame = {
  protocolVersion?: unknown;
  revision?: unknown;
  room?: {
    chatMessages?: unknown;
    revision?: unknown;
  };
  type?: unknown;
};

export type PropagationSentFrame = {
  action?: unknown;
  commandId?: unknown;
  expectedRevision?: unknown;
  protocolVersion?: unknown;
  type?: unknown;
};

export type PropagationProbe = {
  cancel: () => void;
  promise: Promise<number>;
};

type ProbeSignature = {
  actionFingerprint: string;
  actionType: string;
  expectedRevision: number;
  senderIndex: number;
};

type PendingProbe = {
  arrivals: Map<number, number>;
  reject: (error: Error) => void;
  resolve: (latencyMs: number) => void;
  signature: ProbeSignature;
  startedAt: number | null;
};

type ChatMessage = {
  text?: unknown;
};

export type PropagationSampleSummary = {
  count: number;
  maxMs: number;
  medianMs: number;
  minMs: number;
  p95Ms: number;
};

const PROBE_COMMAND_ID = '00000000-0000-4000-8000-000000000000';
const MAX_TRACKED_SENT_COMMANDS = 64;

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative timestamp.`);
  return value;
}

function safeRevision(frame: PropagationFrame): number | null {
  if (frame.type !== 'snapshot' && frame.type !== 'resync') return null;
  if (frame.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
    throw new Error('A propagation snapshot does not use protocol version 2.');
  }
  if (!Number.isSafeInteger(frame.revision) || Number(frame.revision) < 0) {
    throw new Error('A propagation snapshot contains an invalid revision.');
  }
  if (frame.room?.revision !== frame.revision) {
    throw new Error('A propagation snapshot contains divergent envelope and room revisions.');
  }
  return Number(frame.revision);
}

function chatMessages(frame: PropagationFrame): ChatMessage[] {
  const messages = frame.room?.chatMessages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) throw new Error('A propagation snapshot contains an invalid chat collection.');
  return messages as ChatMessage[];
}

function finishArrival(
  probes: Map<number | string, PendingProbe>,
  key: number | string,
  probe: PendingProbe,
  clientIndex: number,
  observedAt: number,
  clientCount: number
): Error | null {
  if (probe.arrivals.has(clientIndex)) return null;
  if (probe.startedAt === null) {
    return new Error('A propagation arrival preceded its matching sent command.');
  }
  if (observedAt < probe.startedAt) return new Error('A propagation arrival preceded its matching sent command.');
  probe.arrivals.set(clientIndex, observedAt);
  if (probe.arrivals.size !== clientCount) return null;
  const latencyMs = Math.max(...probe.arrivals.values()) - probe.startedAt;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return new Error('A propagation sample is missing a finite non-negative latency.');
  }
  probes.delete(key);
  probe.resolve(latencyMs);
  return null;
}

export function createPropagationArrivalTracker(
  clientCount: number,
  now: () => number = () => performance.now()
) {
  if (!Number.isSafeInteger(clientCount) || clientCount < 2) {
    throw new Error('Propagation tracking requires at least two clients.');
  }

  const latestRevisions = Array<number | null>(clientCount).fill(null);
  const pendingRevisions = new Map<number, PendingProbe>();
  const pendingChats = new Map<string, PendingProbe>();
  const revisionSignatures = new Map<number, ProbeSignature>();
  const chatSignatures = new Map<string, ProbeSignature>();
  const observedCommandRevisions = new Map<number, ProbeSignature>();
  const observedChatMarkers = new Set<string>();
  const seenCommandIdDigests = new Set<string>();
  let terminalError: Error | null = null;

  function rejectProbe(map: Map<number | string, PendingProbe>, key: number | string, error: Error): void {
    const probe = map.get(key);
    if (!probe) return;
    map.delete(key);
    probe.reject(error);
  }

  function beginProbe(
    map: Map<number | string, PendingProbe>,
    key: number | string,
    signature: ProbeSignature
  ): PropagationProbe {
    if (terminalError) throw terminalError;
    if (pendingRevisions.size + pendingChats.size > 0) {
      throw new Error('Only one propagation probe may be pending at a time.');
    }
    if (map.has(key)) throw new Error('A propagation probe for this marker is already pending.');
    if (
      !Number.isSafeInteger(signature.senderIndex) ||
      signature.senderIndex < 0 ||
      signature.senderIndex >= clientCount
    ) {
      throw new Error('Expected propagation sender index is invalid.');
    }
    let resolve!: (latencyMs: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Mark the rejection as observed immediately. Callers still await the original
    // promise, but an arrival can fail while the Playwright action is in flight.
    void promise.catch(() => {});
    map.set(key, {
      arrivals: new Map(),
      reject,
      resolve,
      signature,
      startedAt: null
    });
    return {
      cancel: () => {
        const probe = map.get(key);
        if (!probe) return;
        map.delete(key);
        probe.resolve(Number.NaN);
      },
      promise
    };
  }

  function expectedSignature(
    expectedRevision: number,
    expectedAction: GameCommand,
    expectedSenderIndex: number
  ): ProbeSignature {
    const parsed = parseClientCommand({
      type: 'command',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      commandId: PROBE_COMMAND_ID,
      expectedRevision,
      action: expectedAction
    });
    if (!parsed.ok) throw new Error(`Expected propagation action is invalid: ${parsed.message}`);
    return {
      actionFingerprint: parsed.canonicalAction,
      actionType: parsed.command.action.type,
      expectedRevision: parsed.command.expectedRevision,
      senderIndex: expectedSenderIndex
    };
  }

  function beginRevision(
    revision: number,
    expectedAction: GameCommand,
    expectedSenderIndex: number
  ): PropagationProbe {
    if (terminalError) throw terminalError;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Expected propagation revision is invalid.');
    if (revisionSignatures.has(revision)) {
      failAll(new Error(`Propagation revision ${revision} was probed more than once.`));
      throw terminalError;
    }
    if (observedCommandRevisions.has(revision)) {
      failAll(new Error(`Propagation revision ${revision} was sent before its probe was armed.`));
      throw terminalError;
    }
    const signature = expectedSignature(revision - 1, expectedAction, expectedSenderIndex);
    const probe = beginProbe(pendingRevisions, revision, signature);
    revisionSignatures.set(revision, signature);
    return probe;
  }

  function beginChat(marker: string, expectedRevision: number, expectedSenderIndex: number): PropagationProbe {
    if (terminalError) throw terminalError;
    if (!/^cert-chat-[0-9]{2}$/.test(marker)) throw new Error('Chat propagation marker is invalid.');
    const signature = expectedSignature(
      expectedRevision,
      { type: 'send-chat-message', text: marker },
      expectedSenderIndex
    );
    const expectedResultingRevision = signature.expectedRevision + 1;
    if (!Number.isSafeInteger(expectedResultingRevision)) {
      throw new Error('Expected chat propagation revision is invalid.');
    }
    if (chatSignatures.has(marker)) {
      failAll(new Error('Chat propagation markers must be unique.'));
      throw terminalError;
    }
    if (observedChatMarkers.has(marker) || observedCommandRevisions.has(expectedResultingRevision)) {
      failAll(new Error(`Chat propagation marker ${marker} was sent before its probe was armed.`));
      throw terminalError;
    }
    const probe = beginProbe(pendingChats, marker, signature);
    chatSignatures.set(marker, signature);
    return probe;
  }

  function failAll(error: Error): void {
    terminalError ??= error;
    for (const revision of [...pendingRevisions.keys()]) rejectProbe(pendingRevisions, revision, terminalError);
    for (const marker of [...pendingChats.keys()]) rejectProbe(pendingChats, marker, terminalError);
  }

  function rememberSentCommand(
    commandId: string,
    resultingRevision: number,
    actionFingerprint: string,
    actionType: string,
    senderIndex: number,
    chatMarker?: string
  ): boolean {
    const commandIdDigest = createHash('sha256').update(commandId).digest('hex');
    if (seenCommandIdDigests.has(commandIdDigest)) {
      failAll(new Error('A propagation command id was observed more than once.'));
      return false;
    }
    if (
      seenCommandIdDigests.size >= MAX_TRACKED_SENT_COMMANDS ||
      observedCommandRevisions.size >= MAX_TRACKED_SENT_COMMANDS
    ) {
      failAll(new Error('Propagation sent-command tracking exceeded its fixed bound.'));
      return false;
    }
    seenCommandIdDigests.add(commandIdDigest);
    if (observedCommandRevisions.has(resultingRevision)) {
      failAll(new Error(`Propagation resulting revision ${resultingRevision} was observed more than once.`));
      return false;
    }
    observedCommandRevisions.set(resultingRevision, {
      actionFingerprint,
      actionType,
      expectedRevision: resultingRevision - 1,
      senderIndex
    });
    if (chatMarker && /^cert-chat-[0-9]{2}$/.test(chatMarker)) {
      if (observedChatMarkers.has(chatMarker)) {
        failAll(new Error(`Chat propagation marker ${chatMarker} was observed more than once.`));
        return false;
      }
      observedChatMarkers.add(chatMarker);
    }
    return true;
  }

  function startProbe(
    map: Map<number | string, PendingProbe>,
    key: number | string,
    actionFingerprint: string,
    actionType: string,
    expectedRevision: number,
    senderIndex: number,
    observedAt: number
  ): void {
    const probe = map.get(key);
    if (!probe) {
      failAll(new Error('A propagation command did not match the pending probe.'));
      return;
    }
    if (probe.signature.expectedRevision !== expectedRevision) {
      failAll(new Error(
        `A propagation probe expected command revision ${probe.signature.expectedRevision} but observed ${expectedRevision}.`
      ));
      return;
    }
    if (probe.signature.actionFingerprint !== actionFingerprint) {
      const message = probe.signature.actionType === actionType
        ? `A propagation probe observed the wrong ${actionType} action payload.`
        : `A propagation probe expected ${probe.signature.actionType} but observed ${actionType}.`;
      failAll(new Error(message));
      return;
    }
    if (probe.signature.senderIndex !== senderIndex) {
      failAll(new Error(
        `A propagation probe expected sender ${probe.signature.senderIndex + 1} but observed sender ${senderIndex + 1}.`
      ));
      return;
    }
    if (probe.startedAt !== null) {
      failAll(new Error('A propagation probe observed its matching sent command more than once.'));
      return;
    }
    probe.startedAt = finiteTimestamp(observedAt, 'Propagation sent command');
  }

  function recordSentFrame(clientIndex: number, frame: PropagationSentFrame, observedAt = now()): void {
    if (terminalError) return;
    if (!Number.isSafeInteger(clientIndex) || clientIndex < 0 || clientIndex >= clientCount) {
      failAll(new Error('Propagation sent observer reported an invalid client index.'));
      return;
    }
    if (frame.type !== 'command') return;
    const parsed = parseClientCommand(frame);
    if (!parsed.ok) {
      failAll(new Error(`A sent propagation command failed protocol-v2 validation: ${parsed.message}`));
      return;
    }
    const { canonicalAction, command } = parsed;
    const actionType = command.action.type;
    const resultingRevision = command.expectedRevision + 1;
    if (!Number.isSafeInteger(resultingRevision)) {
      failAll(new Error('A sent propagation command contains an unsafe resulting revision.'));
      return;
    }
    try {
      observedAt = finiteTimestamp(observedAt, 'Propagation sent command');
    } catch (error) {
      failAll(error instanceof Error ? error : new Error('Propagation sent-command timing failed.'));
      return;
    }

    const pendingCount = pendingRevisions.size + pendingChats.size;
    if (pendingCount === 0) {
      if (revisionSignatures.has(resultingRevision)) {
        failAll(new Error(`Propagation revision ${resultingRevision} was sent after its probe completed.`));
        return;
      }
      if (actionType === 'send-chat-message' && chatSignatures.has(command.action.text)) {
        failAll(new Error(`Chat propagation marker ${command.action.text} was sent after its probe completed.`));
        return;
      }
    }
    if (!rememberSentCommand(
      command.commandId,
      resultingRevision,
      canonicalAction,
      actionType,
      clientIndex,
      actionType === 'send-chat-message' ? command.action.text : undefined
    )) return;

    if (pendingRevisions.size > 0) {
      const [expectedResultingRevision] = pendingRevisions.keys();
      startProbe(
        pendingRevisions,
        expectedResultingRevision,
        canonicalAction,
        actionType,
        command.expectedRevision,
        clientIndex,
        observedAt
      );
      return;
    }
    if (pendingChats.size > 0) {
      const [expectedMarker] = pendingChats.keys();
      startProbe(
        pendingChats,
        expectedMarker,
        canonicalAction,
        actionType,
        command.expectedRevision,
        clientIndex,
        observedAt
      );
      return;
    }
  }

  function recordFrame(clientIndex: number, frame: PropagationFrame, observedAt = now()): void {
    if (terminalError) return;
    if (!Number.isSafeInteger(clientIndex) || clientIndex < 0 || clientIndex >= clientCount) {
      failAll(new Error('Propagation observer reported an invalid client index.'));
      return;
    }
    let revision: number | null;
    let messages: ChatMessage[];
    try {
      revision = safeRevision(frame);
      if (revision === null) return;
      messages = chatMessages(frame);
      observedAt = finiteTimestamp(observedAt, 'Propagation arrival');
    } catch (error) {
      failAll(error instanceof Error ? error : new Error('Propagation frame validation failed.'));
      return;
    }

    const previousRevision = latestRevisions[clientIndex];
    if (previousRevision !== null && revision < previousRevision) {
      failAll(new Error('A propagation client observed a decreasing revision.'));
      return;
    }
    latestRevisions[clientIndex] = revision;

    for (const message of messages) {
      if (typeof message?.text !== 'string' || !/^cert-chat-[0-9]{2}$/.test(message.text)) continue;
      if (!chatSignatures.has(message.text)) {
        failAll(new Error(`Unexpected chat propagation marker ${message.text} was observed.`));
        return;
      }
    }
    for (const marker of chatSignatures.keys()) {
      if (messages.filter((message) => message?.text === marker).length > 1) {
        failAll(new Error(`Chat propagation marker ${marker} was duplicated.`));
        return;
      }
    }

    for (const [expectedRevision, probe] of [...pendingRevisions.entries()]) {
      if (revision > expectedRevision && !probe.arrivals.has(clientIndex)) {
        failAll(new Error(`Client ${clientIndex + 1} skipped expected revision ${expectedRevision}.`));
        return;
      } else if (revision === expectedRevision) {
        const error = finishArrival(pendingRevisions, expectedRevision, probe, clientIndex, observedAt, clientCount);
        if (error) {
          failAll(error);
          return;
        }
      }
    }

    for (const [marker, probe] of [...pendingChats.entries()]) {
      const matches = messages.filter((message) => message?.text === marker).length;
      const expectedResultingRevision = probe.signature.expectedRevision + 1;
      if (revision > expectedResultingRevision && !probe.arrivals.has(clientIndex)) {
        failAll(new Error(`Client ${clientIndex + 1} skipped expected chat revision ${expectedResultingRevision}.`));
        return;
      }
      if (matches === 1) {
        if (revision !== expectedResultingRevision) {
          failAll(new Error(
            `Chat propagation marker ${marker} arrived at revision ${revision} instead of ${expectedResultingRevision}.`
          ));
          return;
        }
        const error = finishArrival(pendingChats, marker, probe, clientIndex, observedAt, clientCount);
        if (error) {
          failAll(error);
          return;
        }
      } else if (revision === expectedResultingRevision && probe.startedAt !== null) {
        failAll(new Error(`Chat propagation marker ${marker} was missing from revision ${revision}.`));
        return;
      }
    }
  }

  function commonRevision(): number | null {
    if (terminalError) throw terminalError;
    const first = latestRevisions[0];
    if (first === null || latestRevisions.some((revision) => revision !== first)) return null;
    return first;
  }

  return {
    assertHealthy: () => {
      if (terminalError) throw terminalError;
    },
    beginChat,
    beginRevision,
    commonRevision,
    failAll,
    pendingCount: () => pendingChats.size + pendingRevisions.size,
    retainedObservationCount: () => (
      latestRevisions.filter((revision) => revision !== null).length +
      [...pendingRevisions.values(), ...pendingChats.values()]
        .reduce((count, probe) => count + probe.arrivals.size, 0) +
      revisionSignatures.size +
      chatSignatures.size +
      observedCommandRevisions.size +
      seenCommandIdDigests.size
    ),
    recordFrame,
    recordSentFrame
  };
}

export function summarizePropagationSamples(
  samples: readonly number[],
  expectedCount: number
): PropagationSampleSummary {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || samples.length !== expectedCount) {
    throw new Error(`Propagation evidence must contain exactly ${expectedCount} samples.`);
  }
  const sorted = samples.map((sample) => finiteTimestamp(sample, 'Propagation sample')).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1) as number
  };
}
