import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CERTIFICATION_FORMAT_VERSION = 1;
export const AUTOMATED_CERTIFICATION_FORMAT_VERSION = 2;
export const PERSONA_EVIDENCE_FORMAT_VERSION = 2;
export const CERTIFICATION_RELEASE_VERSION = '0.3.3';
export const CERTIFICATION_RELEASE_DATE = '2026-07-29';
export const APNS_ROLLBACK_ENVELOPE_SOURCE_SHA = 'f842937e7515e4f5d854644e5f7929bde5da5312';
export const K6_VERSION = '2.0.0';
export const K6_LINUX_AMD64_SHA256 = '2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90';
export const CERTIFICATION_LIMITS = Object.freeze({
  rooms: 20,
  clientsPerRoom: 8,
  clients: 160,
  durationSeconds: 600,
  markers: 12_000,
  observations: 96_000,
  errorRateExclusive: 0.001,
  propagationP95Ms: 250,
  rssKibExclusive: 256 * 1024,
  recoveryTrials: 3,
  persistenceRpoMs: 500,
  restartRtoMs: 15_000,
  reconnectRtoMs: 15_000,
  personaReconnectBannerMs: 500,
  personaReconnectRtoMs: 10_000,
  personaOpeningReveals: 16,
  personaOpeningSettleMs: 3_000,
  personaReducedMotionSettleMs: 1_000,
  personaStatePropagationSamples: 18,
  personaChatPropagationSamples: 20,
  personaPropagationP95Ms: 250,
  targetSizePx: 44
});

export const RECOVERY_TRACE_KIND = 'skyjo-recovery-rpo-trace';

const fullShaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const unsafeKeyPattern = /(?:cookie|credential|email|frame|password|path|playerid|raw|roomcode|secret|sql|token)/i;
const unsafeStringPatterns = [
  /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|\/(?!\/)(?:[^/\s]+(?:\/[^/\s]+)*\/?))/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:^|[;\s])(?:cookie|set-cookie|authorization)\s*[:=]/i,
  /\b(?:delete|insert|pragma|select|sqlite|update)\s+(?:from|into|table|users|rooms|set)\b/i
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields.`);
  }
}

function finiteNumber(value, label, { integer = false, minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a finite${integer ? ' safe integer' : ''}.`);
  }
  return value;
}

function exactNumber(value, expected, label) {
  finiteNumber(value, label);
  if (value !== expected) throw new Error(`${label} must equal ${expected}.`);
  return value;
}

function exactBoolean(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return value;
}

function exactString(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return value;
}

export function measurePersistenceRpo({ acknowledgements, durableCommandIds, crashSignalAt }) {
  if (!Array.isArray(acknowledgements) || acknowledgements.length < 1) {
    throw new Error('Persistence RPO measurement requires at least one acknowledgement.');
  }
  if (!Array.isArray(durableCommandIds)) {
    throw new Error('Persistence RPO durable command ids must be an array.');
  }
  finiteNumber(crashSignalAt, 'Persistence RPO crash signal time');

  const acknowledgementIndex = new Map();
  let previousAcknowledgedAt = -1;
  for (const [index, acknowledgement] of acknowledgements.entries()) {
    assertExactKeys(acknowledgement, ['acknowledgedAt', 'commandId'], `Persistence acknowledgement ${index + 1}`);
    if (typeof acknowledgement.commandId !== 'string' || acknowledgement.commandId.length < 1) {
      throw new Error('Persistence acknowledgement command id must be a non-empty string.');
    }
    if (acknowledgementIndex.has(acknowledgement.commandId)) {
      throw new Error('Persistence acknowledgement command ids must be unique.');
    }
    finiteNumber(acknowledgement.acknowledgedAt, 'Persistence acknowledgement time');
    if (acknowledgement.acknowledgedAt < previousAcknowledgedAt) {
      throw new Error('Persistence acknowledgement times must be monotonic.');
    }
    if (acknowledgement.acknowledgedAt > crashSignalAt) {
      throw new Error('Persistence acknowledgement cannot occur after the crash signal.');
    }
    acknowledgementIndex.set(acknowledgement.commandId, index);
    previousAcknowledgedAt = acknowledgement.acknowledgedAt;
  }

  const durableIndexes = [];
  const durableIds = new Set();
  for (const commandId of durableCommandIds) {
    if (typeof commandId !== 'string' || commandId.length < 1 || durableIds.has(commandId)) {
      throw new Error('Durable persistence command ids must be unique non-empty strings.');
    }
    const index = acknowledgementIndex.get(commandId);
    if (index === undefined) {
      throw new Error('Durable persistence command ids must belong to the acknowledged recovery stream.');
    }
    durableIds.add(commandId);
    durableIndexes.push(index);
  }
  if (durableIndexes.some((index, position) => index !== position)) {
    throw new Error('Durable persistence commands must form an ordered acknowledged prefix.');
  }

  const durableCommands = durableIndexes.length;
  const lostCommands = acknowledgements.length - durableCommands;
  const persistenceRpoMs = lostCommands === 0
    ? 0
    : crashSignalAt - acknowledgements[durableCommands].acknowledgedAt;
  finiteNumber(persistenceRpoMs, 'Persistence RPO');
  return {
    acknowledgedCommands: acknowledgements.length,
    durableCommands,
    lostCommands,
    persistenceRpoMs
  };
}

export function createRecoveryTraceEvidence({ sourceSha, trials }) {
  if (!fullShaPattern.test(sourceSha)) throw new Error('Recovery trace source SHA must be a full lowercase SHA.');
  if (!Array.isArray(trials) || trials.length < 1 || trials.length > CERTIFICATION_LIMITS.recoveryTrials) {
    throw new Error('Recovery trace must contain between one and three trials.');
  }
  const evidence = {
    formatVersion: CERTIFICATION_FORMAT_VERSION,
    kind: RECOVERY_TRACE_KIND,
    limitMs: CERTIFICATION_LIMITS.persistenceRpoMs,
    sourceSha,
    trials: trials.map((trial, index) => {
      assertExactKeys(trial, [
        'acknowledgedCommands',
        'durableCommands',
        'lostCommands',
        'persistenceRpoMs',
        'trial'
      ], `Recovery trace trial ${index + 1}`);
      exactNumber(trial.trial, index + 1, `Recovery trace trial identity ${index + 1}`);
      finiteNumber(trial.acknowledgedCommands, 'Recovery trace acknowledgements', { integer: true, minimum: 1 });
      finiteNumber(trial.durableCommands, 'Recovery trace durable commands', { integer: true });
      finiteNumber(trial.lostCommands, 'Recovery trace lost commands', { integer: true });
      finiteNumber(trial.persistenceRpoMs, 'Recovery trace persistence RPO');
      if (trial.durableCommands + trial.lostCommands !== trial.acknowledgedCommands) {
        throw new Error('Recovery trace command counts do not reconcile.');
      }
      return {
        ...trial,
        thresholdPassed: trial.persistenceRpoMs <= CERTIFICATION_LIMITS.persistenceRpoMs
      };
    })
  };
  return validateRecoveryTraceEvidence(evidence);
}

export function validateRecoveryTraceEvidence(value) {
  assertExactKeys(value, ['formatVersion', 'kind', 'limitMs', 'sourceSha', 'trials'], 'Recovery trace evidence');
  exactNumber(value.formatVersion, CERTIFICATION_FORMAT_VERSION, 'Recovery trace format version');
  exactString(value.kind, RECOVERY_TRACE_KIND, 'Recovery trace kind');
  exactNumber(value.limitMs, CERTIFICATION_LIMITS.persistenceRpoMs, 'Recovery trace limit');
  if (!fullShaPattern.test(value.sourceSha)) throw new Error('Recovery trace source SHA must be a full lowercase SHA.');
  if (!Array.isArray(value.trials) || value.trials.length < 1 || value.trials.length > CERTIFICATION_LIMITS.recoveryTrials) {
    throw new Error('Recovery trace must contain between one and three trials.');
  }
  value.trials.forEach((trial, index) => {
    assertExactKeys(trial, [
      'acknowledgedCommands',
      'durableCommands',
      'lostCommands',
      'persistenceRpoMs',
      'thresholdPassed',
      'trial'
    ], `Recovery trace trial ${index + 1}`);
    exactNumber(trial.trial, index + 1, `Recovery trace trial identity ${index + 1}`);
    finiteNumber(trial.acknowledgedCommands, 'Recovery trace acknowledgements', { integer: true, minimum: 1 });
    finiteNumber(trial.durableCommands, 'Recovery trace durable commands', { integer: true });
    finiteNumber(trial.lostCommands, 'Recovery trace lost commands', { integer: true });
    finiteNumber(trial.persistenceRpoMs, 'Recovery trace persistence RPO');
    if (trial.durableCommands + trial.lostCommands !== trial.acknowledgedCommands) {
      throw new Error('Recovery trace command counts do not reconcile.');
    }
    exactBoolean(
      trial.thresholdPassed,
      trial.persistenceRpoMs <= CERTIFICATION_LIMITS.persistenceRpoMs,
      'Recovery trace threshold result'
    );
  });
  assertSanitizedCertificationValue(value);
  return value;
}

export function assertSanitizedCertificationValue(value, trail = 'evidence') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSanitizedCertificationValue(item, `${trail}[${index}]`));
    return value;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (unsafeKeyPattern.test(key)) throw new Error(`Certification evidence contains a forbidden field at ${trail}.`);
      assertSanitizedCertificationValue(item, `${trail}.${key}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 160 || value.includes('\r') || value.includes('\n') || unsafeStringPatterns.some((pattern) => pattern.test(value))) {
      throw new Error(`Certification evidence contains an unsafe string at ${trail}.`);
    }
    return value;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Certification evidence contains a non-finite number at ${trail}.`);
  }
  if (!['boolean', 'number', 'string'].includes(typeof value) && value !== null) {
    throw new Error(`Certification evidence contains an unsupported value at ${trail}.`);
  }
  return value;
}

export function validateReleaseCertificationIdentity(value) {
  assertExactKeys(value, [
    'buildTimestamp',
    'k6ArchiveSha256',
    'k6Version',
    'nodeVersion',
    'protocolVersion',
    'schemaVersion',
    'sourceSha',
    'version'
  ], 'Release certification identity');
  exactString(value.version, CERTIFICATION_RELEASE_VERSION, 'Release version');
  if (!fullShaPattern.test(value.sourceSha)) throw new Error('Release source SHA must be a full lowercase commit SHA.');
  if (new Date(value.buildTimestamp).toISOString() !== value.buildTimestamp) {
    throw new Error('Release build timestamp must be canonical ISO time.');
  }
  exactNumber(value.schemaVersion, 2, 'Schema version');
  exactNumber(value.protocolVersion, 2, 'Protocol version');
  if (!/^v24\.\d+\.\d+$/.test(value.nodeVersion)) throw new Error('Certification must run on Node 24.');
  exactString(value.k6Version, K6_VERSION, 'k6 version');
  exactString(value.k6ArchiveSha256, K6_LINUX_AMD64_SHA256, 'k6 archive digest');
  return value;
}

export function validateK6CertificationSummary(value) {
  assertExactKeys(value, [
    'formatVersion',
    'kind',
    'loadDurationSeconds',
    'metrics',
    'thresholdsPassed',
    'topology'
  ], 'k6 certification summary');
  exactNumber(value.formatVersion, CERTIFICATION_FORMAT_VERSION, 'k6 summary format version');
  exactString(value.kind, 'skyjo-k6-summary', 'k6 summary kind');
  exactNumber(value.loadDurationSeconds, CERTIFICATION_LIMITS.durationSeconds, 'Load duration');
  assertExactKeys(value.topology, ['clientsPerRoom', 'rooms'], 'k6 topology');
  exactNumber(value.topology.rooms, CERTIFICATION_LIMITS.rooms, 'Load room count');
  exactNumber(value.topology.clientsPerRoom, CERTIFICATION_LIMITS.clientsPerRoom, 'Clients per room');
  assertExactKeys(value.metrics, [
    'clientsConnected',
    'errorCount',
    'errorRate',
    'interruptedIterations',
    'iterations',
    'markerObservations',
    'markersSent',
    'privacyViolations',
    'propagationP95Ms',
    'revisionDivergences',
    'roomsCompleted',
    'roomsStarted',
    'sessionsVerified'
  ], 'k6 metrics');
  const metrics = value.metrics;
  exactNumber(metrics.roomsStarted, CERTIFICATION_LIMITS.rooms, 'Started rooms');
  exactNumber(metrics.roomsCompleted, CERTIFICATION_LIMITS.rooms, 'Completed rooms');
  exactNumber(metrics.clientsConnected, CERTIFICATION_LIMITS.clients, 'Connected clients');
  exactNumber(metrics.sessionsVerified, CERTIFICATION_LIMITS.clients, 'Authenticated sessions');
  exactNumber(metrics.markersSent, CERTIFICATION_LIMITS.markers, 'Sent markers');
  exactNumber(metrics.markerObservations, CERTIFICATION_LIMITS.observations, 'Marker observations');
  exactNumber(metrics.iterations, CERTIFICATION_LIMITS.rooms, 'Completed k6 iterations');
  exactNumber(metrics.interruptedIterations, 0, 'Interrupted k6 iterations');
  exactNumber(metrics.errorCount, 0, 'Load error count');
  exactNumber(metrics.privacyViolations, 0, 'Privacy violation count');
  exactNumber(metrics.revisionDivergences, 0, 'Revision divergence count');
  finiteNumber(metrics.errorRate, 'Load error rate');
  if (metrics.errorRate >= CERTIFICATION_LIMITS.errorRateExclusive) {
    throw new Error('Load error rate must be below 0.1%.');
  }
  finiteNumber(metrics.propagationP95Ms, 'Propagation p95');
  if (metrics.propagationP95Ms > CERTIFICATION_LIMITS.propagationP95Ms) {
    throw new Error('State propagation p95 exceeds 250ms.');
  }
  exactBoolean(value.thresholdsPassed, true, 'k6 thresholdsPassed');
  assertSanitizedCertificationValue(value);
  return value;
}

export const CERTIFICATION_PERSONA_PROFILES = Object.freeze([
  'desktop-keyboard',
  'desktop-pointer',
  'phone-touch',
  'phone-reduced-motion',
  'tablet-portrait',
  'tablet-landscape',
  'text-200-keyboard',
  'background-reconnect'
]);

function validatePersonaPropagationSamples(value, expectedCount, label) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`${label} must contain exactly ${expectedCount} samples.`);
  }
  const samples = value.map((sample, index) => finiteNumber(sample, `${label} sample ${index + 1}`));
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
}

export function validateEightClientPersonaEvidence(value, { requirePassed = true } = {}) {
  assertExactKeys(value, ['formatVersion', 'gates', 'kind', 'measurements', 'profiles', 'propagation', 'release', 'topology'], 'Persona evidence');
  exactNumber(value.formatVersion, PERSONA_EVIDENCE_FORMAT_VERSION, 'Persona format version');
  exactString(value.kind, 'skyjo-eight-client-persona', 'Persona evidence kind');
  assertExactKeys(value.release, ['protocolVersion', 'sourceSha', 'version'], 'Persona release identity');
  exactString(value.release.version, CERTIFICATION_RELEASE_VERSION, 'Persona release version');
  if (!fullShaPattern.test(value.release.sourceSha)) throw new Error('Persona source SHA must be a full lowercase commit SHA.');
  exactNumber(value.release.protocolVersion, 2, 'Persona protocol version');
  assertExactKeys(value.topology, [
    'chatPropagationSamples',
    'clients',
    'openingReveals',
    'rooms',
    'statePropagationSamples'
  ], 'Persona topology');
  exactNumber(value.topology.rooms, 1, 'Persona room count');
  exactNumber(value.topology.clients, 8, 'Persona client count');
  exactNumber(value.topology.openingReveals, CERTIFICATION_LIMITS.personaOpeningReveals, 'Persona opening reveal count');
  exactNumber(
    value.topology.statePropagationSamples,
    CERTIFICATION_LIMITS.personaStatePropagationSamples,
    'Persona state propagation sample count'
  );
  exactNumber(
    value.topology.chatPropagationSamples,
    CERTIFICATION_LIMITS.personaChatPropagationSamples,
    'Persona chat propagation sample count'
  );
  if (!Array.isArray(value.profiles) || value.profiles.length !== CERTIFICATION_PERSONA_PROFILES.length) {
    throw new Error('Persona profile coverage is incomplete.');
  }
  CERTIFICATION_PERSONA_PROFILES.forEach((profile, index) => exactString(value.profiles[index], profile, `Persona profile ${index + 1}`));
  assertExactKeys(value.measurements, [
    'chatPropagationP95Ms',
    'maxHorizontalOverflowPx',
    'minimumTargetPx',
    'openingSettleMs',
    'reconnectBannerMs',
    'reconnectRtoMs',
    'reducedMotionSettleMs',
    'statePropagationP95Ms'
  ], 'Persona measurements');
  const measurements = value.measurements;
  for (const [label, measurement] of Object.entries(measurements)) finiteNumber(measurement, `Persona ${label}`);
  if (requirePassed && measurements.maxHorizontalOverflowPx > 0) throw new Error('Persona viewport has horizontal overflow.');
  if (requirePassed && measurements.minimumTargetPx < CERTIFICATION_LIMITS.targetSizePx) throw new Error('Persona target size is below 44px.');
  if (requirePassed && measurements.openingSettleMs > CERTIFICATION_LIMITS.personaOpeningSettleMs) throw new Error('Eight-client opening did not settle within three seconds.');
  if (requirePassed && measurements.reducedMotionSettleMs > CERTIFICATION_LIMITS.personaReducedMotionSettleMs) throw new Error('Reduced-motion opening did not settle within one second.');
  if (requirePassed && measurements.reconnectBannerMs > CERTIFICATION_LIMITS.personaReconnectBannerMs) throw new Error('Reconnect banner exceeded 500ms.');
  if (requirePassed && measurements.reconnectRtoMs > CERTIFICATION_LIMITS.personaReconnectRtoMs) throw new Error('Persona reconnect exceeded ten seconds.');
  assertExactKeys(value.propagation, ['chatMs', 'stateMs'], 'Persona propagation samples');
  const statePropagation = validatePersonaPropagationSamples(
    value.propagation.stateMs,
    CERTIFICATION_LIMITS.personaStatePropagationSamples,
    'Persona state propagation'
  );
  const chatPropagation = validatePersonaPropagationSamples(
    value.propagation.chatMs,
    CERTIFICATION_LIMITS.personaChatPropagationSamples,
    'Persona chat propagation'
  );
  exactNumber(measurements.statePropagationP95Ms, statePropagation.p95Ms, 'Persona state propagation p95');
  exactNumber(measurements.chatPropagationP95Ms, chatPropagation.p95Ms, 'Persona chat propagation p95');
  if (requirePassed && measurements.statePropagationP95Ms > CERTIFICATION_LIMITS.personaPropagationP95Ms) {
    throw new Error('Persona state propagation p95 exceeded 250ms.');
  }
  if (requirePassed && measurements.chatPropagationP95Ms > CERTIFICATION_LIMITS.personaPropagationP95Ms) {
    throw new Error('Persona chat propagation p95 exceeded 250ms.');
  }
  assertExactKeys(value.gates, ['browserPropagation', 'centeredTable', 'keyboardComplete', 'privacyRedaction', 'sameSeatReconnect'], 'Persona gates');
  exactBoolean(
    value.gates.browserPropagation,
    measurements.statePropagationP95Ms <= CERTIFICATION_LIMITS.personaPropagationP95Ms &&
      measurements.chatPropagationP95Ms <= CERTIFICATION_LIMITS.personaPropagationP95Ms,
    'Persona browser propagation gate'
  );
  for (const [gate, passed] of Object.entries(value.gates)) {
    if (typeof passed !== 'boolean') throw new Error(`Persona ${gate} must be boolean.`);
    if (requirePassed) exactBoolean(passed, true, `Persona ${gate}`);
  }
  assertSanitizedCertificationValue(value);
  return value;
}

export function validateRecoveryCertification(value) {
  assertExactKeys(value, ['maxPersistenceRpoMs', 'maxReconnectRtoMs', 'maxRestartRtoMs', 'trials'], 'Recovery evidence');
  if (!Array.isArray(value.trials) || value.trials.length !== CERTIFICATION_LIMITS.recoveryTrials) {
    throw new Error('Recovery evidence must contain exactly three trials.');
  }
  const trialValues = value.trials.map((trial, index) => {
    assertExactKeys(trial, [
      'acknowledgedCommands',
      'durableCommands',
      'persistenceRpoMs',
      'reconnectRtoMs',
      'restartRtoMs',
      'trial'
    ], `Recovery trial ${index + 1}`);
    exactNumber(trial.trial, index + 1, `Recovery trial identity ${index + 1}`);
    finiteNumber(trial.acknowledgedCommands, 'Acknowledged recovery commands', { integer: true, minimum: 2 });
    finiteNumber(trial.durableCommands, 'Durable recovery commands', { integer: true, minimum: 1 });
    if (trial.durableCommands > trial.acknowledgedCommands) throw new Error('Durable recovery commands exceed acknowledgements.');
    finiteNumber(trial.persistenceRpoMs, 'Persistence RPO');
    finiteNumber(trial.restartRtoMs, 'Restart RTO');
    finiteNumber(trial.reconnectRtoMs, 'Reconnect RTO');
    if (trial.persistenceRpoMs > CERTIFICATION_LIMITS.persistenceRpoMs) throw new Error('Persistence RPO exceeds 500ms.');
    if (trial.restartRtoMs > CERTIFICATION_LIMITS.restartRtoMs) throw new Error('Restart RTO exceeds 15 seconds.');
    if (trial.reconnectRtoMs > CERTIFICATION_LIMITS.reconnectRtoMs) throw new Error('Reconnect RTO exceeds 15 seconds.');
    return trial;
  });
  const expectedMaxRpo = Math.max(...trialValues.map((trial) => trial.persistenceRpoMs));
  const expectedMaxRestart = Math.max(...trialValues.map((trial) => trial.restartRtoMs));
  const expectedMaxReconnect = Math.max(...trialValues.map((trial) => trial.reconnectRtoMs));
  exactNumber(value.maxPersistenceRpoMs, expectedMaxRpo, 'Maximum persistence RPO');
  exactNumber(value.maxRestartRtoMs, expectedMaxRestart, 'Maximum restart RTO');
  exactNumber(value.maxReconnectRtoMs, expectedMaxReconnect, 'Maximum reconnect RTO');
  assertSanitizedCertificationValue(value);
  return value;
}

function validateRssStage(value, expectedName, measuredForGate) {
  assertExactKeys(value, [
    'measuredForGate',
    'name',
    'peakElapsedMs',
    'peakRssKib',
    'sampleIntervalMs',
    'samples'
  ], `RSS stage ${expectedName}`);
  exactString(value.name, expectedName, 'RSS stage name');
  exactBoolean(value.measuredForGate, measuredForGate, `RSS stage ${expectedName} measuredForGate`);
  finiteNumber(value.peakRssKib, `RSS stage ${expectedName} peak`, { integer: true, minimum: 1 });
  finiteNumber(value.peakElapsedMs, `RSS stage ${expectedName} peak time`, { integer: true });
  finiteNumber(value.sampleIntervalMs, `RSS stage ${expectedName} sample interval`, { integer: true, minimum: 100 });
  if (value.sampleIntervalMs > 60_000) throw new Error('RSS sample interval exceeds one minute.');
  if (!Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 256) {
    throw new Error('RSS stage must contain between one and 256 bounded samples.');
  }
  let previousElapsedMs = -1;
  for (const sample of value.samples) {
    assertExactKeys(sample, ['elapsedMs', 'rssKib'], `RSS stage ${expectedName} sample`);
    finiteNumber(sample.elapsedMs, `RSS stage ${expectedName} sample time`, { integer: true });
    finiteNumber(sample.rssKib, `RSS stage ${expectedName} sample`, { integer: true, minimum: 1 });
    if (sample.elapsedMs <= previousElapsedMs) throw new Error('RSS sample times must increase strictly.');
    if (sample.rssKib > value.peakRssKib) throw new Error('RSS sample exceeds the recorded stage peak.');
    previousElapsedMs = sample.elapsedMs;
  }
  if (value.peakElapsedMs > previousElapsedMs + value.sampleIntervalMs) {
    throw new Error('RSS peak time falls outside the sampled stage boundary.');
  }
  return value;
}

export function createRssStageEvidence({ sourceSha, accountBootstrap, authenticatedLoad }) {
  const evidence = {
    formatVersion: CERTIFICATION_FORMAT_VERSION,
    kind: 'skyjo-rss-stage-evidence',
    limitKibExclusive: CERTIFICATION_LIMITS.rssKibExclusive,
    sourceSha,
    authenticatedLoadPassed: authenticatedLoad.peakRssKib < CERTIFICATION_LIMITS.rssKibExclusive,
    stages: [accountBootstrap, authenticatedLoad]
  };
  return validateRssStageEvidence(evidence);
}

export function validateRssStageEvidence(value) {
  assertExactKeys(value, [
    'authenticatedLoadPassed',
    'formatVersion',
    'kind',
    'limitKibExclusive',
    'sourceSha',
    'stages'
  ], 'RSS stage evidence');
  exactNumber(value.formatVersion, CERTIFICATION_FORMAT_VERSION, 'RSS evidence format version');
  exactString(value.kind, 'skyjo-rss-stage-evidence', 'RSS evidence kind');
  exactNumber(value.limitKibExclusive, CERTIFICATION_LIMITS.rssKibExclusive, 'RSS limit');
  if (!fullShaPattern.test(value.sourceSha)) throw new Error('RSS source SHA must be a full lowercase commit SHA.');
  if (!Array.isArray(value.stages) || value.stages.length !== 2) {
    throw new Error('RSS evidence must contain exactly two process stages.');
  }
  validateRssStage(value.stages[0], 'account-bootstrap', false);
  validateRssStage(value.stages[1], 'authenticated-load', true);
  exactBoolean(
    value.authenticatedLoadPassed,
    value.stages[1].peakRssKib < CERTIFICATION_LIMITS.rssKibExclusive,
    'Authenticated load RSS result'
  );
  assertSanitizedCertificationValue(value);
  return value;
}

export function createAiBenchmarkCertificationReference({ digest, evidence }) {
  if (!sha256Pattern.test(digest || '')) throw new Error('AI benchmark evidence digest must be a SHA-256 digest.');
  const reference = {
    digest,
    formatVersion: evidence?.formatVersion,
    kind: evidence?.kind,
    releaseVersion: evidence?.releaseVersion,
    sourceSha: evidence?.sourceSha,
    strategyVersion: evidence?.strategyVersion
  };
  return validateAiBenchmarkCertificationReference(reference);
}

export function validateAiBenchmarkCertificationReference(value) {
  assertExactKeys(value, [
    'digest',
    'formatVersion',
    'kind',
    'releaseVersion',
    'sourceSha',
    'strategyVersion'
  ], 'AI benchmark certification reference');
  if (!sha256Pattern.test(value.digest || '')) throw new Error('AI benchmark evidence digest must be a SHA-256 digest.');
  exactNumber(value.formatVersion, 1, 'AI benchmark evidence format version');
  exactString(value.kind, 'skyjo-ai-benchmark', 'AI benchmark evidence kind');
  exactString(value.releaseVersion, CERTIFICATION_RELEASE_VERSION, 'AI benchmark release version');
  if (!fullShaPattern.test(value.sourceSha || '')) throw new Error('AI benchmark source SHA must be a full lowercase commit SHA.');
  finiteNumber(value.strategyVersion, 'AI benchmark strategy version', { integer: true, minimum: 1 });
  assertSanitizedCertificationValue(value);
  return value;
}

export function createAutomatedCertificationEvidence({ release, aiBenchmark, k6Summary, rss, recovery, persona }) {
  validateReleaseCertificationIdentity(release);
  validateAiBenchmarkCertificationReference(aiBenchmark);
  validateK6CertificationSummary(k6Summary);
  validateRssStageEvidence(rss);
  validateRecoveryCertification(recovery);
  validateEightClientPersonaEvidence(persona);
  if (!rss.authenticatedLoadPassed) throw new Error('Authenticated load RSS must remain below 256 MiB.');
  const maxRssKib = rss.stages[1].peakRssKib;
  if (persona.release.sourceSha !== release.sourceSha) throw new Error('Persona evidence belongs to a different source SHA.');
  if (rss.sourceSha !== release.sourceSha) throw new Error('RSS evidence belongs to a different source SHA.');
  if (
    aiBenchmark.sourceSha !== release.sourceSha ||
    aiBenchmark.releaseVersion !== release.version
  ) {
    throw new Error('AI benchmark evidence belongs to a different release.');
  }

  const evidence = {
    aiBenchmark: { ...aiBenchmark },
    formatVersion: AUTOMATED_CERTIFICATION_FORMAT_VERSION,
    kind: 'skyjo-pwa-automated-certification',
    release: { ...release },
    topology: {
      rooms: CERTIFICATION_LIMITS.rooms,
      clientsPerRoom: CERTIFICATION_LIMITS.clientsPerRoom,
      clients: CERTIFICATION_LIMITS.clients,
      durationSeconds: CERTIFICATION_LIMITS.durationSeconds,
      markers: CERTIFICATION_LIMITS.markers,
      observations: CERTIFICATION_LIMITS.observations
    },
    load: {
      ...k6Summary.metrics,
      maxRssKib
    },
    recovery,
    persona,
    rss,
    gates: {
      aiCalibration: true,
      exactTopology: true,
      finiteMeasurements: true,
      loadErrorRate: true,
      noPrivacyLeakage: true,
      noRevisionDivergence: true,
      persistenceRecovery: true,
      personaCoverage: true,
      propagationLatency: true,
      releaseIdentity: true,
      rss: true
    }
  };
  return validateAutomatedCertificationEvidence(evidence);
}

export function validateAutomatedCertificationEvidence(value) {
  assertExactKeys(value, ['aiBenchmark', 'formatVersion', 'gates', 'kind', 'load', 'persona', 'recovery', 'release', 'rss', 'topology'], 'Automated certification evidence');
  exactNumber(value.formatVersion, AUTOMATED_CERTIFICATION_FORMAT_VERSION, 'Certification format version');
  exactString(value.kind, 'skyjo-pwa-automated-certification', 'Certification evidence kind');
  validateReleaseCertificationIdentity(value.release);
  validateAiBenchmarkCertificationReference(value.aiBenchmark);
  if (
    value.aiBenchmark.sourceSha !== value.release.sourceSha ||
    value.aiBenchmark.releaseVersion !== value.release.version
  ) {
    throw new Error('AI benchmark reference does not match the certified release.');
  }
  assertExactKeys(value.topology, ['clients', 'clientsPerRoom', 'durationSeconds', 'markers', 'observations', 'rooms'], 'Certification topology');
  for (const [key, expected] of Object.entries({
    rooms: CERTIFICATION_LIMITS.rooms,
    clientsPerRoom: CERTIFICATION_LIMITS.clientsPerRoom,
    clients: CERTIFICATION_LIMITS.clients,
    durationSeconds: CERTIFICATION_LIMITS.durationSeconds,
    markers: CERTIFICATION_LIMITS.markers,
    observations: CERTIFICATION_LIMITS.observations
  })) exactNumber(value.topology[key], expected, `Certification topology ${key}`);
  assertExactKeys(value.load, [
    'clientsConnected',
    'errorCount',
    'errorRate',
    'interruptedIterations',
    'iterations',
    'markerObservations',
    'markersSent',
    'maxRssKib',
    'privacyViolations',
    'propagationP95Ms',
    'revisionDivergences',
    'roomsCompleted',
    'roomsStarted',
    'sessionsVerified'
  ], 'Certification load evidence');
  validateK6CertificationSummary({
    formatVersion: CERTIFICATION_FORMAT_VERSION,
    kind: 'skyjo-k6-summary',
    loadDurationSeconds: value.topology.durationSeconds,
    topology: { rooms: value.topology.rooms, clientsPerRoom: value.topology.clientsPerRoom },
    metrics: Object.fromEntries(Object.entries(value.load).filter(([key]) => key !== 'maxRssKib')),
    thresholdsPassed: true
  });
  finiteNumber(value.load.maxRssKib, 'Maximum application RSS', { integer: true, minimum: 1 });
  if (value.load.maxRssKib >= CERTIFICATION_LIMITS.rssKibExclusive) throw new Error('Application RSS must remain below 256 MiB.');
  validateRssStageEvidence(value.rss);
  if (
    value.rss.sourceSha !== value.release.sourceSha ||
    !value.rss.authenticatedLoadPassed ||
    value.rss.stages[1].peakRssKib !== value.load.maxRssKib
  ) {
    throw new Error('Authenticated load RSS evidence does not match the release peak.');
  }
  validateRecoveryCertification(value.recovery);
  validateEightClientPersonaEvidence(value.persona);
  if (value.persona.release.sourceSha !== value.release.sourceSha) throw new Error('Persona source SHA does not match release source SHA.');
  const gateNames = [
    'aiCalibration',
    'exactTopology',
    'finiteMeasurements',
    'loadErrorRate',
    'noPrivacyLeakage',
    'noRevisionDivergence',
    'persistenceRecovery',
    'personaCoverage',
    'propagationLatency',
    'releaseIdentity',
    'rss'
  ];
  assertExactKeys(value.gates, gateNames, 'Certification gates');
  gateNames.forEach((gate) => exactBoolean(value.gates[gate], true, `Certification gate ${gate}`));
  assertSanitizedCertificationValue(value);
  return value;
}

export function assertAiBenchmarkMatchesCertification(certification, aiBenchmarkEvidence, digest) {
  validateAutomatedCertificationEvidence(certification);
  const reference = createAiBenchmarkCertificationReference({ digest, evidence: aiBenchmarkEvidence });
  if (JSON.stringify(reference) !== JSON.stringify(certification.aiBenchmark)) {
    throw new Error('Standalone AI benchmark evidence does not match combined certification evidence.');
  }
  return aiBenchmarkEvidence;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

export function serializeCertificationEvidence(value) {
  validateAutomatedCertificationEvidence(value);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function serializeEightClientPersonaEvidence(value, options = {}) {
  validateEightClientPersonaEvidence(value, options);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function serializeRssStageEvidence(value) {
  validateRssStageEvidence(value);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function serializeRecoveryTraceEvidence(value) {
  validateRecoveryTraceEvidence(value);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function assertRssStageEvidenceMatchesCertification(certification, rssEvidence) {
  validateAutomatedCertificationEvidence(certification);
  validateRssStageEvidence(rssEvidence);
  if (serializeRssStageEvidence(certification.rss) !== serializeRssStageEvidence(rssEvidence)) {
    throw new Error('Standalone RSS evidence does not exactly match combined certification evidence.');
  }
  return rssEvidence;
}

export function assertRecoveryTraceMatchesCertification(certification, recoveryTrace) {
  validateAutomatedCertificationEvidence(certification);
  validateRecoveryTraceEvidence(recoveryTrace);
  if (
    recoveryTrace.sourceSha !== certification.release.sourceSha ||
    recoveryTrace.trials.length !== certification.recovery.trials.length
  ) {
    throw new Error('Recovery trace does not match the combined certification identity.');
  }
  certification.recovery.trials.forEach((trial, index) => {
    const traceTrial = recoveryTrace.trials[index];
    if (
      traceTrial.trial !== trial.trial ||
      traceTrial.acknowledgedCommands !== trial.acknowledgedCommands ||
      traceTrial.durableCommands !== trial.durableCommands ||
      traceTrial.lostCommands !== trial.acknowledgedCommands - trial.durableCommands ||
      traceTrial.persistenceRpoMs !== trial.persistenceRpoMs ||
      !traceTrial.thresholdPassed
    ) {
      throw new Error('Recovery trace does not exactly match the combined certification trials.');
    }
  });
  return recoveryTrace;
}

export function certificationSha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function writeCertificationEvidence(filePath, value) {
  const data = serializeCertificationEvidence(value);
  const digest = certificationSha256(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  const checksumPath = `${filePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { digest, checksumPath };
}

export async function writeEightClientPersonaEvidence(filePath, value, options = {}) {
  const data = serializeEightClientPersonaEvidence(value, options);
  const digest = certificationSha256(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  const checksumPath = `${filePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { digest, checksumPath };
}

export async function writeRssStageEvidence(filePath, value) {
  const data = serializeRssStageEvidence(value);
  const digest = certificationSha256(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  const checksumPath = `${filePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { digest, checksumPath };
}

export async function writeRecoveryTraceEvidence(filePath, value) {
  const data = serializeRecoveryTraceEvidence(value);
  const digest = certificationSha256(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, { encoding: 'utf8', mode: 0o600 });
  const checksumPath = `${filePath}.sha256`;
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { digest, checksumPath };
}

export async function readVerifiedRssStageEvidence(filePath, checksumPath = `${filePath}.sha256`) {
  const [data, checksum] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksum.match(new RegExp(`^([a-f0-9]{64})  ${expectedName}\\n$`));
  if (!match || !sha256Pattern.test(match[1])) throw new Error('RSS evidence checksum file is invalid.');
  const actual = certificationSha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(actual))) {
    throw new Error('RSS evidence checksum mismatch.');
  }
  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error('RSS evidence is not valid JSON.');
  }
  validateRssStageEvidence(decoded);
  if (serializeRssStageEvidence(decoded) !== data) throw new Error('RSS evidence is not canonically serialized.');
  return { evidence: decoded, digest: actual };
}

export async function readVerifiedRecoveryTraceEvidence(filePath, checksumPath = `${filePath}.sha256`) {
  const [data, checksum] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksum.match(new RegExp(`^([a-f0-9]{64})  ${expectedName}\\n$`));
  if (!match || !sha256Pattern.test(match[1])) throw new Error('Recovery trace checksum file is invalid.');
  const actual = certificationSha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(actual))) {
    throw new Error('Recovery trace checksum mismatch.');
  }
  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error('Recovery trace is not valid JSON.');
  }
  validateRecoveryTraceEvidence(decoded);
  if (serializeRecoveryTraceEvidence(decoded) !== data) throw new Error('Recovery trace is not canonically serialized.');
  return { evidence: decoded, digest: actual };
}

export async function readVerifiedCertificationEvidence(filePath, checksumPath = `${filePath}.sha256`) {
  const [data, checksum] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksum.match(new RegExp(`^([a-f0-9]{64})  ${expectedName}\\n$`));
  if (!match || !sha256Pattern.test(match[1])) throw new Error('Certification checksum file is invalid.');
  const actual = certificationSha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(actual))) throw new Error('Certification evidence checksum mismatch.');
  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error('Certification evidence is not valid JSON.');
  }
  validateAutomatedCertificationEvidence(decoded);
  if (serializeCertificationEvidence(decoded) !== data) throw new Error('Certification evidence is not canonically serialized.');
  return { evidence: decoded, digest: actual };
}

export async function readVerifiedEightClientPersonaEvidence(
  filePath,
  checksumPath = `${filePath}.sha256`,
  options = {}
) {
  const [data, checksum] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.readFile(checksumPath, 'utf8')
  ]);
  const expectedName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = checksum.match(new RegExp(`^([a-f0-9]{64})  ${expectedName}\\n$`));
  if (!match || !sha256Pattern.test(match[1])) throw new Error('Persona evidence checksum file is invalid.');
  const actual = certificationSha256(data);
  if (!crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(actual))) throw new Error('Persona evidence checksum mismatch.');
  let decoded;
  try {
    decoded = JSON.parse(data);
  } catch {
    throw new Error('Persona evidence is not valid JSON.');
  }
  validateEightClientPersonaEvidence(decoded, options);
  if (serializeEightClientPersonaEvidence(decoded, options) !== data) throw new Error('Persona evidence is not canonically serialized.');
  return { evidence: decoded, digest: actual };
}
