import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CERTIFICATION_FORMAT_VERSION = 1;
export const CERTIFICATION_RELEASE_VERSION = '0.2.0';
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
  personaOpeningSettleMs: 3_000,
  personaReducedMotionSettleMs: 1_000,
  targetSizePx: 44
});

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
    'roomsStarted'
  ], 'k6 metrics');
  const metrics = value.metrics;
  exactNumber(metrics.roomsStarted, CERTIFICATION_LIMITS.rooms, 'Started rooms');
  exactNumber(metrics.roomsCompleted, CERTIFICATION_LIMITS.rooms, 'Completed rooms');
  exactNumber(metrics.clientsConnected, CERTIFICATION_LIMITS.clients, 'Connected clients');
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

export function validateEightClientPersonaEvidence(value) {
  assertExactKeys(value, ['formatVersion', 'gates', 'kind', 'measurements', 'profiles', 'release', 'topology'], 'Persona evidence');
  exactNumber(value.formatVersion, CERTIFICATION_FORMAT_VERSION, 'Persona format version');
  exactString(value.kind, 'skyjo-eight-client-persona', 'Persona evidence kind');
  assertExactKeys(value.release, ['protocolVersion', 'sourceSha', 'version'], 'Persona release identity');
  exactString(value.release.version, CERTIFICATION_RELEASE_VERSION, 'Persona release version');
  if (!fullShaPattern.test(value.release.sourceSha)) throw new Error('Persona source SHA must be a full lowercase commit SHA.');
  exactNumber(value.release.protocolVersion, 2, 'Persona protocol version');
  assertExactKeys(value.topology, ['clients', 'openingReveals', 'rooms'], 'Persona topology');
  exactNumber(value.topology.rooms, 1, 'Persona room count');
  exactNumber(value.topology.clients, 8, 'Persona client count');
  exactNumber(value.topology.openingReveals, 16, 'Persona opening reveal count');
  if (!Array.isArray(value.profiles) || value.profiles.length !== CERTIFICATION_PERSONA_PROFILES.length) {
    throw new Error('Persona profile coverage is incomplete.');
  }
  CERTIFICATION_PERSONA_PROFILES.forEach((profile, index) => exactString(value.profiles[index], profile, `Persona profile ${index + 1}`));
  assertExactKeys(value.measurements, [
    'maxHorizontalOverflowPx',
    'minimumTargetPx',
    'openingSettleMs',
    'reconnectBannerMs',
    'reconnectRtoMs',
    'reducedMotionSettleMs'
  ], 'Persona measurements');
  const measurements = value.measurements;
  for (const [label, measurement] of Object.entries(measurements)) finiteNumber(measurement, `Persona ${label}`);
  if (measurements.maxHorizontalOverflowPx > 0) throw new Error('Persona viewport has horizontal overflow.');
  if (measurements.minimumTargetPx < CERTIFICATION_LIMITS.targetSizePx) throw new Error('Persona target size is below 44px.');
  if (measurements.openingSettleMs > CERTIFICATION_LIMITS.personaOpeningSettleMs) throw new Error('Eight-client opening did not settle within three seconds.');
  if (measurements.reducedMotionSettleMs > CERTIFICATION_LIMITS.personaReducedMotionSettleMs) throw new Error('Reduced-motion opening did not settle within one second.');
  if (measurements.reconnectBannerMs > CERTIFICATION_LIMITS.personaReconnectBannerMs) throw new Error('Reconnect banner exceeded 500ms.');
  if (measurements.reconnectRtoMs > CERTIFICATION_LIMITS.personaReconnectRtoMs) throw new Error('Persona reconnect exceeded ten seconds.');
  assertExactKeys(value.gates, ['centeredTable', 'keyboardComplete', 'privacyRedaction', 'sameSeatReconnect'], 'Persona gates');
  for (const [gate, passed] of Object.entries(value.gates)) exactBoolean(passed, true, `Persona ${gate}`);
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

export function createAutomatedCertificationEvidence({ release, k6Summary, maxRssKib, recovery, persona }) {
  validateReleaseCertificationIdentity(release);
  validateK6CertificationSummary(k6Summary);
  validateRecoveryCertification(recovery);
  validateEightClientPersonaEvidence(persona);
  finiteNumber(maxRssKib, 'Maximum application RSS', { integer: true, minimum: 1 });
  if (maxRssKib >= CERTIFICATION_LIMITS.rssKibExclusive) throw new Error('Application RSS must remain below 256 MiB.');
  if (persona.release.sourceSha !== release.sourceSha) throw new Error('Persona evidence belongs to a different source SHA.');

  const evidence = {
    formatVersion: CERTIFICATION_FORMAT_VERSION,
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
    gates: {
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
  assertExactKeys(value, ['formatVersion', 'gates', 'kind', 'load', 'persona', 'recovery', 'release', 'topology'], 'Automated certification evidence');
  exactNumber(value.formatVersion, CERTIFICATION_FORMAT_VERSION, 'Certification format version');
  exactString(value.kind, 'skyjo-pwa-automated-certification', 'Certification evidence kind');
  validateReleaseCertificationIdentity(value.release);
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
    'roomsStarted'
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
  validateRecoveryCertification(value.recovery);
  validateEightClientPersonaEvidence(value.persona);
  if (value.persona.release.sourceSha !== value.release.sourceSha) throw new Error('Persona source SHA does not match release source SHA.');
  const gateNames = [
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

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

export function serializeCertificationEvidence(value) {
  validateAutomatedCertificationEvidence(value);
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
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
