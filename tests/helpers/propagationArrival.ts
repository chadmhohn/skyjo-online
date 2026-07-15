import { performance } from 'node:perf_hooks';

export type PropagationFrame = {
  revision?: unknown;
  room?: {
    chatMessages?: unknown;
    revision?: unknown;
  };
  type?: unknown;
};

export type PropagationSentFrame = {
  action?: {
    text?: unknown;
    type?: unknown;
  };
  expectedRevision?: unknown;
  type?: unknown;
};

export type PropagationProbe = {
  cancel: () => void;
  promise: Promise<number>;
};

type PendingProbe = {
  arrivals: Map<number, number>;
  expectedActionType: string;
  reject: (error: Error) => void;
  resolve: (latencyMs: number) => void;
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

function finiteTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative timestamp.`);
  return value;
}

function safeRevision(frame: PropagationFrame): number | null {
  if (frame.type !== 'snapshot' && frame.type !== 'resync') return null;
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
  const usedChatMarkers = new Set<string>();
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
    expectedActionType: string
  ): PropagationProbe {
    if (terminalError) throw terminalError;
    if (map.has(key)) throw new Error('A propagation probe for this marker is already pending.');
    let resolve!: (latencyMs: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Mark the rejection as observed immediately. Callers still await the original
    // promise, but an arrival can fail while the Playwright action is in flight.
    void promise.catch(() => {});
    map.set(key, { arrivals: new Map(), expectedActionType, reject, resolve, startedAt: null });
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

  function beginRevision(revision: number, expectedActionType: string): PropagationProbe {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Expected propagation revision is invalid.');
    if (!expectedActionType) throw new Error('Expected propagation action type is invalid.');
    return beginProbe(pendingRevisions, revision, expectedActionType);
  }

  function beginChat(marker: string): PropagationProbe {
    if (!/^cert-chat-[0-9]{2}$/.test(marker)) throw new Error('Chat propagation marker is invalid.');
    if (usedChatMarkers.has(marker)) throw new Error('Chat propagation markers must be unique.');
    usedChatMarkers.add(marker);
    return beginProbe(pendingChats, marker, 'send-chat-message');
  }

  function failAll(error: Error): void {
    terminalError ??= error;
    for (const revision of [...pendingRevisions.keys()]) rejectProbe(pendingRevisions, revision, terminalError);
    for (const marker of [...pendingChats.keys()]) rejectProbe(pendingChats, marker, terminalError);
  }

  function startProbe(
    map: Map<number | string, PendingProbe>,
    key: number | string,
    actionType: string,
    observedAt: number
  ): void {
    const probe = map.get(key);
    if (!probe) return;
    if (probe.expectedActionType !== actionType) {
      failAll(new Error(`A propagation probe expected ${probe.expectedActionType} but observed ${actionType}.`));
      return;
    }
    if (probe.startedAt !== null) {
      failAll(new Error('A propagation probe observed its matching sent command more than once.'));
      return;
    }
    probe.startedAt = finiteTimestamp(observedAt, 'Propagation sent command');
  }

  function recordSentFrame(frame: PropagationSentFrame, observedAt = now()): void {
    if (terminalError) return;
    if (frame.type !== 'command') return;
    if (!Number.isSafeInteger(frame.expectedRevision) || Number(frame.expectedRevision) < 0) {
      failAll(new Error('A sent propagation command contains an invalid expected revision.'));
      return;
    }
    if (!frame.action || typeof frame.action.type !== 'string' || !frame.action.type) {
      failAll(new Error('A sent propagation command contains an invalid action type.'));
      return;
    }
    const actionType = frame.action.type;
    const resultingRevision = Number(frame.expectedRevision) + 1;
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
    startProbe(pendingRevisions, resultingRevision, actionType, observedAt);

    if (actionType !== 'send-chat-message') return;
    if (typeof frame.action.text !== 'string') {
      failAll(new Error('A sent chat propagation command contains an invalid marker.'));
      return;
    }
    startProbe(pendingChats, frame.action.text, actionType, observedAt);
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
      if (!usedChatMarkers.has(message.text)) {
        failAll(new Error(`Unexpected chat propagation marker ${message.text} was observed.`));
        return;
      }
    }
    for (const marker of usedChatMarkers) {
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
      if (matches === 1) {
        const error = finishArrival(pendingChats, marker, probe, clientIndex, observedAt, clientCount);
        if (error) {
          failAll(error);
          return;
        }
      }
    }
  }

  function commonRevision(): number | null {
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
      usedChatMarkers.size
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
