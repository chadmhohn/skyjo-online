import { performance } from 'node:perf_hooks';

export type PropagationFrame = {
  revision?: unknown;
  room?: {
    chatMessages?: unknown;
    revision?: unknown;
  };
  type?: unknown;
};

export type PropagationProbe = {
  cancel: () => void;
  promise: Promise<number>;
};

type PendingProbe = {
  arrivals: Map<number, number>;
  reject: (error: Error) => void;
  resolve: (latencyMs: number) => void;
  startedAt: number;
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
): void {
  if (probe.arrivals.has(clientIndex)) return;
  probe.arrivals.set(clientIndex, observedAt);
  if (probe.arrivals.size !== clientCount) return;
  const latencyMs = Math.max(...probe.arrivals.values()) - probe.startedAt;
  probes.delete(key);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    probe.reject(new Error('A propagation sample is missing a finite non-negative latency.'));
    return;
  }
  probe.resolve(latencyMs);
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

  function rejectProbe(map: Map<number | string, PendingProbe>, key: number | string, error: Error): void {
    const probe = map.get(key);
    if (!probe) return;
    map.delete(key);
    probe.reject(error);
  }

  function beginProbe(map: Map<number | string, PendingProbe>, key: number | string): PropagationProbe {
    if (map.has(key)) throw new Error('A propagation probe for this marker is already pending.');
    const startedAt = finiteTimestamp(now(), 'Propagation start');
    let resolve!: (latencyMs: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Mark the rejection as observed immediately. Callers still await the original
    // promise, but an arrival can fail while the Playwright action is in flight.
    void promise.catch(() => {});
    map.set(key, { arrivals: new Map(), reject, resolve, startedAt });
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

  function beginRevision(revision: number): PropagationProbe {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Expected propagation revision is invalid.');
    return beginProbe(pendingRevisions, revision);
  }

  function beginChat(marker: string): PropagationProbe {
    if (!/^cert-chat-[0-9]{2}$/.test(marker)) throw new Error('Chat propagation marker is invalid.');
    if (usedChatMarkers.has(marker)) throw new Error('Chat propagation markers must be unique.');
    usedChatMarkers.add(marker);
    return beginProbe(pendingChats, marker);
  }

  function failAll(error: Error): void {
    for (const revision of [...pendingRevisions.keys()]) rejectProbe(pendingRevisions, revision, error);
    for (const marker of [...pendingChats.keys()]) rejectProbe(pendingChats, marker, error);
  }

  function recordFrame(clientIndex: number, frame: PropagationFrame, observedAt = now()): void {
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

    for (const [expectedRevision, probe] of [...pendingRevisions.entries()]) {
      if (revision > expectedRevision && !probe.arrivals.has(clientIndex)) {
        rejectProbe(
          pendingRevisions,
          expectedRevision,
          new Error(`Client ${clientIndex + 1} skipped expected revision ${expectedRevision}.`)
        );
      } else if (revision === expectedRevision) {
        finishArrival(pendingRevisions, expectedRevision, probe, clientIndex, observedAt, clientCount);
      }
    }

    for (const [marker, probe] of [...pendingChats.entries()]) {
      const matches = messages.filter((message) => message?.text === marker).length;
      if (matches > 1) {
        rejectProbe(pendingChats, marker, new Error(`Chat propagation marker ${marker} was duplicated.`));
      } else if (matches === 1) {
        finishArrival(pendingChats, marker, probe, clientIndex, observedAt, clientCount);
      }
    }
  }

  function commonRevision(): number | null {
    const first = latestRevisions[0];
    if (first === null || latestRevisions.some((revision) => revision !== first)) return null;
    return first;
  }

  return {
    beginChat,
    beginRevision,
    commonRevision,
    failAll,
    pendingCount: () => pendingChats.size + pendingRevisions.size,
    recordFrame
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
