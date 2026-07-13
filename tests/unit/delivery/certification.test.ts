import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_LIMITS,
  CERTIFICATION_PERSONA_PROFILES,
  K6_LINUX_AMD64_SHA256,
  assertSanitizedCertificationValue,
  createAutomatedCertificationEvidence,
  readVerifiedCertificationEvidence,
  validateAutomatedCertificationEvidence,
  validateEightClientPersonaEvidence,
  validateK6CertificationSummary,
  validateRecoveryCertification,
  writeCertificationEvidence
} from '../../../scripts/certification-lib.mjs';
import { REQUIRED_CHECKS } from '../../../scripts/github-governance-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceSha = 'a'.repeat(40);

function releaseIdentity() {
  return {
    version: '0.2.0',
    sourceSha,
    buildTimestamp: '2026-07-13T12:00:00.000Z',
    schemaVersion: 2,
    protocolVersion: 2,
    nodeVersion: 'v24.15.0',
    k6Version: '2.0.0',
    k6ArchiveSha256: K6_LINUX_AMD64_SHA256
  };
}

function k6Summary() {
  return {
    formatVersion: 1,
    kind: 'skyjo-k6-summary',
    loadDurationSeconds: 600,
    topology: { rooms: 20, clientsPerRoom: 8 },
    metrics: {
      clientsConnected: 160,
      errorCount: 0,
      errorRate: 0,
      interruptedIterations: 0,
      iterations: 20,
      markerObservations: 96_000,
      markersSent: 12_000,
      privacyViolations: 0,
      propagationP95Ms: 125,
      revisionDivergences: 0,
      roomsCompleted: 20,
      roomsStarted: 20
    },
    thresholdsPassed: true
  };
}

function personaEvidence() {
  return {
    formatVersion: 1,
    kind: 'skyjo-eight-client-persona',
    release: { version: '0.2.0', sourceSha, protocolVersion: 2 },
    topology: { rooms: 1, clients: 8, openingReveals: 16 },
    profiles: [...CERTIFICATION_PERSONA_PROFILES],
    measurements: {
      maxHorizontalOverflowPx: 0,
      minimumTargetPx: 44,
      openingSettleMs: 900,
      reconnectBannerMs: 50,
      reconnectRtoMs: 1_000,
      reducedMotionSettleMs: 200
    },
    gates: {
      centeredTable: true,
      keyboardComplete: true,
      privacyRedaction: true,
      sameSeatReconnect: true
    }
  };
}

function recoveryEvidence() {
  const trials = [1, 2, 3].map((trial) => ({
    trial,
    acknowledgedCommands: 8 + trial,
    durableCommands: 7 + trial,
    persistenceRpoMs: 100 + trial,
    restartRtoMs: 500 + trial,
    reconnectRtoMs: 700 + trial
  }));
  return {
    trials,
    maxPersistenceRpoMs: 103,
    maxRestartRtoMs: 503,
    maxReconnectRtoMs: 703
  };
}

function automatedEvidence() {
  return createAutomatedCertificationEvidence({
    release: releaseIdentity(),
    k6Summary: k6Summary(),
    maxRssKib: 128_000,
    recovery: recoveryEvidence(),
    persona: personaEvidence()
  });
}

describe('v0.2.0 certification evidence', () => {
  it('accepts only the exact finite release topology and thresholds', () => {
    expect(validateK6CertificationSummary(k6Summary())).toEqual(k6Summary());
    expect(validateRecoveryCertification(recoveryEvidence())).toEqual(recoveryEvidence());
    expect(validateEightClientPersonaEvidence(personaEvidence())).toEqual(personaEvidence());
    expect(validateAutomatedCertificationEvidence(automatedEvidence())).toEqual(automatedEvidence());

    for (const mutate of [
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.clientsConnected = 159; },
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.errorRate = 0.001; },
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.propagationP95Ms = 250.01; },
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.revisionDivergences = 1; },
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.markersSent = Number.NaN; },
      (summary: ReturnType<typeof k6Summary>) => { summary.thresholdsPassed = false; }
    ]) {
      const summary = k6Summary();
      mutate(summary);
      expect(() => validateK6CertificationSummary(summary)).toThrow();
    }
  });

  it('fails closed on recovery, persona, RSS, and release identity boundaries', () => {
    const recovery = recoveryEvidence();
    recovery.trials[0].persistenceRpoMs = 501;
    recovery.maxPersistenceRpoMs = 501;
    expect(() => validateRecoveryCertification(recovery)).toThrow(/RPO/i);

    const persona = personaEvidence();
    persona.measurements.reducedMotionSettleMs = 1_001;
    expect(() => validateEightClientPersonaEvidence(persona)).toThrow(/Reduced-motion/i);

    expect(() => createAutomatedCertificationEvidence({
      release: releaseIdentity(),
      k6Summary: k6Summary(),
      maxRssKib: CERTIFICATION_LIMITS.rssKibExclusive,
      recovery: recoveryEvidence(),
      persona: personaEvidence()
    })).toThrow(/RSS/i);

    const wrongPersona = personaEvidence();
    wrongPersona.release.sourceSha = 'b'.repeat(40);
    expect(() => createAutomatedCertificationEvidence({
      release: releaseIdentity(),
      k6Summary: k6Summary(),
      maxRssKib: 100_000,
      recovery: recoveryEvidence(),
      persona: wrongPersona
    })).toThrow(/different source SHA/i);
  });

  it('rejects PII, credentials, filesystem paths, SQL, and raw protocol evidence', () => {
    for (const unsafe of [
      { operatorEmail: 'person@example.test' },
      { artifact: 'C:\\private\\artifact.json' },
      { artifact: 'C:/private/artifact.json' },
      { artifact: '\\\\server\\share\\artifact.json' },
      { note: '/etc/skyjo-online.env' },
      { note: '/root/private-state' },
      { note: '/opt/skyjo-online/node' },
      { note: '/run/skyjo-online/service.pid' },
      { note: '/mnt/candidate-state' },
      { note: '/workspace/release.json' },
      { note: '/tmp/private-state' },
      { cookie: 'value' },
      { note: 'SELECT users FROM sqlite' },
      { rawFrames: [] }
    ]) {
      expect(() => assertSanitizedCertificationValue(unsafe)).toThrow();
    }
  });

  it('writes canonical evidence and verifies its exact SHA-256 checksum', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-certification-unit-'));
    const evidencePath = path.join(directory, 'automated.json');
    try {
      const written = await writeCertificationEvidence(evidencePath, automatedEvidence());
      const verified = await readVerifiedCertificationEvidence(evidencePath, written.checksumPath);
      expect(verified.digest).toBe(written.digest);
      expect(verified.evidence.release.sourceSha).toBe(sourceSha);

      await fs.appendFile(evidencePath, ' ');
      await expect(readVerifiedCertificationEvidence(evidencePath, written.checksumPath)).rejects.toThrow(/checksum/i);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('v0.2.0 workflow governance', () => {
  it('requires the exact load gate and preserves pinned, least-privilege workflow execution', async () => {
    const [ci, nightly, installer, load, verifier, packageDocument, packageLock, changelog] = await Promise.all([
      fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
      fs.readFile(path.join(root, '.github', 'workflows', 'nightly-certification.yml'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'install-k6.sh'), 'utf8'),
      fs.readFile(path.join(root, 'tests', 'load', 'skyjo-realtime.k6.js'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'verify-v020-release.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'package.json'), 'utf8'),
      fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
      fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
    ]);
    expect(REQUIRED_CHECKS).toContain('CI / Load & Recovery');
    expect(REQUIRED_CHECKS.filter((check: string) => check === 'CI / Load & Recovery')).toHaveLength(1);
    expect(ci).toMatch(/load-recovery:\s*\n\s*name: CI \/ Load & Recovery/);
    expect(ci).toMatch(/release-canary:[\s\S]*?needs:[\s\S]*?- load-recovery/);
    expect(ci).toMatch(/pull_request:[\s\S]*push:[\s\S]*tags:[\s\S]*v\*/);
    expect(nightly).toMatch(/schedule:[\s\S]*cron:/);
    expect(nightly).toMatch(/workflow_dispatch:/);
    expect(nightly).toMatch(/npm run certify:automated/);
    for (const workflow of [ci, nightly]) expect(workflow).not.toMatch(/uses: [^\n]+@v\d/);
    expect(installer).toContain(K6_LINUX_AMD64_SHA256);
    expect(installer).toMatch(/expected_manifest/);
    expect(installer).toMatch(/--no-same-owner --no-same-permissions/);
    expect(installer).toMatch(/destination must not already exist/);
    expect(load).toMatch(/from 'k6\/websockets'/);
    expect(load).toMatch(/executor: 'per-vu-iterations'/);
    expect(load).toMatch(/skyjo_operation_error_rate: \['rate<0\.001'\]/);
    expect(load).toMatch(/skyjo_propagation_ms: \['p\(95\)<=250'\]/);
    expect(verifier).not.toMatch(/gh release create|\/releases/);
    expect(verifier).toMatch(/rev-parse', 'HEAD\^\{commit\}'/);
    expect(JSON.parse(packageDocument).version).toBe('0.2.0');
    expect(JSON.parse(packageLock).version).toBe('0.2.0');
    expect(changelog).toMatch(/^## 0\.2\.0 - 2026-07-13$/m);
  });
});
