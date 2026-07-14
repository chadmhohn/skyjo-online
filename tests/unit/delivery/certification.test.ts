import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_LIMITS,
  CERTIFICATION_PERSONA_PROFILES,
  K6_LINUX_AMD64_SHA256,
  assertRecoveryTraceMatchesCertification,
  assertRssStageEvidenceMatchesCertification,
  assertSanitizedCertificationValue,
  createAutomatedCertificationEvidence,
  createRecoveryTraceEvidence,
  createRssStageEvidence,
  measurePersistenceRpo,
  readVerifiedCertificationEvidence,
  readVerifiedRecoveryTraceEvidence,
  readVerifiedRssStageEvidence,
  validateAutomatedCertificationEvidence,
  validateEightClientPersonaEvidence,
  validateK6CertificationSummary,
  validateRecoveryCertification,
  validateRecoveryTraceEvidence,
  validateRssStageEvidence,
  writeCertificationEvidence,
  writeRecoveryTraceEvidence,
  writeRssStageEvidence
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
      roomsStarted: 20,
      sessionsVerified: 160
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

function rssStageEvidence(authenticatedLoadPeak = 128_000) {
  return createRssStageEvidence({
    sourceSha,
    accountBootstrap: {
      name: 'account-bootstrap',
      measuredForGate: false,
      peakElapsedMs: 2_000,
      peakRssKib: 300_000,
      sampleIntervalMs: 2_000,
      samples: [
        { elapsedMs: 0, rssKib: 80_000 },
        { elapsedMs: 2_000, rssKib: 300_000 }
      ]
    },
    authenticatedLoad: {
      name: 'authenticated-load',
      measuredForGate: true,
      peakElapsedMs: 5_000,
      peakRssKib: authenticatedLoadPeak,
      sampleIntervalMs: 5_000,
      samples: [
        { elapsedMs: 0, rssKib: 70_000 },
        { elapsedMs: 5_000, rssKib: authenticatedLoadPeak }
      ]
    }
  });
}

function automatedEvidence() {
  return createAutomatedCertificationEvidence({
    release: releaseIdentity(),
    k6Summary: k6Summary(),
    rss: rssStageEvidence(),
    recovery: recoveryEvidence(),
    persona: personaEvidence()
  });
}

function recoveryTraceEvidence() {
  return createRecoveryTraceEvidence({
    sourceSha,
    trials: recoveryEvidence().trials.map((trial) => ({
      trial: trial.trial,
      acknowledgedCommands: trial.acknowledgedCommands,
      durableCommands: trial.durableCommands,
      lostCommands: trial.acknowledgedCommands - trial.durableCommands,
      persistenceRpoMs: trial.persistenceRpoMs
    }))
  });
}

function recoveryAcknowledgement(commandId: string, acknowledgedAt: number) {
  return { commandId, acknowledgedAt };
}

describe('recovery RPO measurement', () => {
  it('measures the crash-time age of the oldest lost acknowledgement', () => {
    const acknowledgements = [
      recoveryAcknowledgement('command-a', 100),
      recoveryAcknowledgement('command-b', 950)
    ];
    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a'],
      crashSignalAt: 1_000
    })).toEqual({
      acknowledgedCommands: 2,
      durableCommands: 1,
      lostCommands: 1,
      persistenceRpoMs: 50
    });

    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a', 'command-b'],
      crashSignalAt: 2_000
    }).persistenceRpoMs).toBe(0);
  });

  it('includes post-ack exposure and preserves the inclusive 500ms boundary', () => {
    const acknowledgements = [
      recoveryAcknowledgement('command-a', 100),
      recoveryAcknowledgement('command-b', 500)
    ];
    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a'],
      crashSignalAt: 1_000
    }).persistenceRpoMs).toBe(500);
    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a'],
      crashSignalAt: 1_001
    }).persistenceRpoMs).toBe(501);
  });

  it('fails closed on inconsistent acknowledgement and durable streams', () => {
    const acknowledgements = [
      recoveryAcknowledgement('command-a', 100),
      recoveryAcknowledgement('command-b', 200),
      recoveryAcknowledgement('command-c', 300)
    ];
    expect(() => measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a', 'command-c'],
      crashSignalAt: 400
    })).toThrow(/prefix/i);
    expect(() => measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-b', 'command-a'],
      crashSignalAt: 400
    })).toThrow(/ordered acknowledged prefix/i);
    expect(() => measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['unknown-command'],
      crashSignalAt: 400
    })).toThrow(/acknowledged recovery stream/i);
    expect(() => measurePersistenceRpo({
      acknowledgements: [
        recoveryAcknowledgement('command-a', 200),
        recoveryAcknowledgement('command-b', 100)
      ],
      durableCommandIds: ['command-a'],
      crashSignalAt: 400
    })).toThrow(/monotonic/i);
  });

  it('creates sanitized partial trace evidence before a threshold assertion', () => {
    const trace = createRecoveryTraceEvidence({
      sourceSha,
      trials: [{
        trial: 1,
        acknowledgedCommands: 3,
        durableCommands: 1,
        lostCommands: 2,
        persistenceRpoMs: 501
      }]
    });
    expect(validateRecoveryTraceEvidence(trace)).toEqual(trace);
    expect(trace.trials[0]).toMatchObject({ thresholdPassed: false, persistenceRpoMs: 501 });
    expect(JSON.stringify(trace)).not.toMatch(/command-a|room|player|path|cookie/i);
  });
});

describe('v0.2.0 certification evidence', () => {
  it('accepts only the exact finite release topology and thresholds', () => {
    expect(validateK6CertificationSummary(k6Summary())).toEqual(k6Summary());
    expect(validateRecoveryCertification(recoveryEvidence())).toEqual(recoveryEvidence());
    expect(validateRssStageEvidence(rssStageEvidence())).toEqual(rssStageEvidence());
    expect(validateEightClientPersonaEvidence(personaEvidence())).toEqual(personaEvidence());
    expect(validateAutomatedCertificationEvidence(automatedEvidence())).toEqual(automatedEvidence());
    expect(assertRssStageEvidenceMatchesCertification(automatedEvidence(), rssStageEvidence())).toEqual(rssStageEvidence());
    expect(assertRecoveryTraceMatchesCertification(automatedEvidence(), recoveryTraceEvidence())).toEqual(recoveryTraceEvidence());

    for (const mutate of [
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.clientsConnected = 159; },
      (summary: ReturnType<typeof k6Summary>) => { summary.metrics.sessionsVerified = 159; },
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
      rss: rssStageEvidence(CERTIFICATION_LIMITS.rssKibExclusive),
      recovery: recoveryEvidence(),
      persona: personaEvidence()
    })).toThrow(/RSS/i);

    const wrongPersona = personaEvidence();
    wrongPersona.release.sourceSha = 'b'.repeat(40);
    expect(() => createAutomatedCertificationEvidence({
      release: releaseIdentity(),
      k6Summary: k6Summary(),
      rss: rssStageEvidence(),
      recovery: recoveryEvidence(),
      persona: wrongPersona
    })).toThrow(/different source SHA/i);

    const mismatchedRss = rssStageEvidence();
    mismatchedRss.stages[0].peakRssKib -= 1;
    mismatchedRss.stages[0].samples[1].rssKib -= 1;
    expect(() => assertRssStageEvidenceMatchesCertification(automatedEvidence(), mismatchedRss)).toThrow(/does not exactly match/i);

    const mismatchedRecovery = recoveryTraceEvidence();
    mismatchedRecovery.trials[0].durableCommands -= 1;
    mismatchedRecovery.trials[0].lostCommands += 1;
    expect(() => assertRecoveryTraceMatchesCertification(automatedEvidence(), mismatchedRecovery)).toThrow(/does not exactly match/i);
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
    const recoveryTracePath = path.join(directory, 'recovery-trials.json');
    const rssPath = path.join(directory, 'rss-stages.json');
    try {
      const trace = recoveryTraceEvidence();
      const traceWritten = await writeRecoveryTraceEvidence(recoveryTracePath, trace);
      expect(await fs.readFile(traceWritten.checksumPath, 'utf8')).toMatch(/^[a-f0-9]{64} {2}recovery-trials\.json\n$/);
      expect((await readVerifiedRecoveryTraceEvidence(recoveryTracePath, traceWritten.checksumPath)).evidence).toEqual(trace);
      expect(assertRecoveryTraceMatchesCertification(automatedEvidence(), trace)).toEqual(trace);
      const rssWritten = await writeRssStageEvidence(rssPath, rssStageEvidence());
      expect(await fs.readFile(rssWritten.checksumPath, 'utf8')).toMatch(/^[a-f0-9]{64} {2}rss-stages\.json\n$/);
      expect((await readVerifiedRssStageEvidence(rssPath, rssWritten.checksumPath)).evidence).toEqual(rssStageEvidence());
      await fs.appendFile(rssPath, ' ');
      await expect(readVerifiedRssStageEvidence(rssPath, rssWritten.checksumPath)).rejects.toThrow(/checksum/i);
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
    const [ci, nightly, installer, load, runner, realtime, verifier, packageDocument, packageLock, changelog] = await Promise.all([
      fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
      fs.readFile(path.join(root, '.github', 'workflows', 'nightly-certification.yml'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'install-k6.sh'), 'utf8'),
      fs.readFile(path.join(root, 'tests', 'load', 'skyjo-realtime.k6.js'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'run-automated-certification.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'src', 'serverRealtime.ts'), 'utf8'),
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
    expect(load).toMatch(/skyjo_sessions_verified: \[`count==\$\{expectedClients\}`\]/);
    expect(load).toMatch(/SKYJO_LOAD_AUTH_FILE/);
    expect(load).not.toMatch(/\/api\/account\/signup/);
    expect(runner).toMatch(/bootstrapLoadAuthentication[\s\S]*?stopCertificationServer\(server\)/);
    const bootstrapSection = runner.match(/async function bootstrapLoadAuthentication[\s\S]*?(?=async function runK6Certification)/)?.[0] || '';
    const measuredLoadSection = runner.match(/async function runK6Certification[\s\S]*?(?=async function resolveK6Binary)/)?.[0] || '';
    expect(bootstrapSection).toMatch(/catch \(error\) \{[\s\S]*?fs\.rm\(authenticationPath, \{ force: true \}\)/);
    expect(measuredLoadSection).toMatch(/finally \{[\s\S]*?fs\.rm\(authenticationPath, \{ force: true \}\)/);
    expect(runner).toMatch(/writeRssStageEvidence\(rssEvidencePath, rss\)/);
    expect(runner).toMatch(/acknowledgedAt: performance\.now\(\)/);
    expect(runner).toMatch(/child\.kill\('SIGKILL'\)[\s\S]*?crashSignalAt = performance\.now\(\)/);
    expect(runner).toMatch(/await recordMeasurement\(\{ trial, \.\.\.measurement \}\);[\s\S]*?Persistence RPO \$\{measurement\.persistenceRpoMs\.toFixed\(3\)\}ms exceeded/);
    expect(runner).toMatch(/writeRecoveryTraceEvidence\([\s\S]*?createRecoveryTraceEvidence/);
    expect(realtime).toMatch(/Buffer\.byteLength/);
    expect(realtime).not.toMatch(/new TextEncoder/);
    expect(verifier).not.toMatch(/gh release create|\/releases/);
    expect(verifier).toMatch(/rev-parse', 'HEAD\^\{commit\}'/);
    expect(verifier).toMatch(/readVerifiedRssStageEvidence/);
    expect(verifier).toMatch(/assertRssStageEvidenceMatchesCertification\(evidence, rssEvidence\)/);
    expect(verifier).toMatch(/readVerifiedRecoveryTraceEvidence/);
    expect(verifier).toMatch(/assertRecoveryTraceMatchesCertification\(evidence, recoveryEvidence\)/);
    expect(JSON.parse(packageDocument).version).toBe('0.2.0');
    expect(JSON.parse(packageLock).version).toBe('0.2.0');
    expect(changelog).toMatch(/^## 0\.2\.0 - 2026-07-13$/m);
  });
});
