import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APNS_ROLLBACK_ENVELOPE_SOURCE_SHA,
  CERTIFICATION_LIMITS,
  CERTIFICATION_PERSONA_PROFILES,
  CERTIFICATION_RELEASE_DATE,
  CERTIFICATION_RELEASE_VERSION,
  K6_LINUX_AMD64_SHA256,
  PERSONA_EVIDENCE_FORMAT_VERSION,
  assertAiBenchmarkMatchesCertification,
  assertRecoveryTraceMatchesCertification,
  assertRssStageEvidenceMatchesCertification,
  assertSanitizedCertificationValue,
  createAutomatedCertificationEvidence,
  createRecoveryTraceEvidence,
  createRssStageEvidence,
  measurePersistenceRpo,
  readVerifiedCertificationEvidence,
  readVerifiedEightClientPersonaEvidence,
  readVerifiedRecoveryTraceEvidence,
  readVerifiedRssStageEvidence,
  validateAutomatedCertificationEvidence,
  validateEightClientPersonaEvidence,
  validateK6CertificationSummary,
  validateRecoveryCertification,
  validateRecoveryTraceEvidence,
  validateRssStageEvidence,
  writeCertificationEvidence,
  writeEightClientPersonaEvidence,
  writeRecoveryTraceEvidence,
  writeRssStageEvidence
} from '../../../scripts/certification-lib.mjs';
import { REQUIRED_CHECKS } from '../../../scripts/github-governance-lib.mjs';
import { selectSimulatorMatrix } from '../../../scripts/select-ios-ui-simulators.mjs';
import {
  validateReleaseTagMetadata,
  verifyReleaseTagIdentity
} from '../../../scripts/verify-release-tag-identity.mjs';
import {
  runApnsRollbackProof,
  sensitiveBinaryLogRepresentations
} from '../../../server-apns-rollback-proof.mjs';
import { MULTIPLAYER_PROTOCOL_VERSION, type GameCommand } from '../../../src/protocolV2';
import {
  createPropagationArrivalTracker,
  summarizePropagationSamples
} from '../../helpers/propagationArrival';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceSha = 'a'.repeat(40);

function aiBenchmarkReference() {
  return {
    digest: 'd'.repeat(64),
    formatVersion: 1,
    kind: 'skyjo-ai-benchmark',
    releaseVersion: CERTIFICATION_RELEASE_VERSION,
    sourceSha,
    strategyVersion: 1
  };
}

function releaseIdentity() {
  return {
    version: CERTIFICATION_RELEASE_VERSION,
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
  const stateMs = Array.from(
    { length: CERTIFICATION_LIMITS.personaStatePropagationSamples },
    (_, index) => 100 + index
  );
  const chatMs = Array.from(
    { length: CERTIFICATION_LIMITS.personaChatPropagationSamples },
    (_, index) => 120 + index
  );
  const stateSummary = summarizePropagationSamples(stateMs, CERTIFICATION_LIMITS.personaStatePropagationSamples);
  const chatSummary = summarizePropagationSamples(chatMs, CERTIFICATION_LIMITS.personaChatPropagationSamples);
  return {
    formatVersion: PERSONA_EVIDENCE_FORMAT_VERSION,
    kind: 'skyjo-eight-client-persona',
    release: { version: CERTIFICATION_RELEASE_VERSION, sourceSha, protocolVersion: 2 },
    topology: {
      rooms: 1,
      clients: 8,
      openingReveals: CERTIFICATION_LIMITS.personaOpeningReveals,
      statePropagationSamples: stateMs.length,
      chatPropagationSamples: chatMs.length
    },
    profiles: [...CERTIFICATION_PERSONA_PROFILES],
    propagation: { chatMs, stateMs },
    measurements: {
      chatPropagationP95Ms: chatSummary.p95Ms,
      maxHorizontalOverflowPx: 0,
      minimumTargetPx: 44,
      openingSettleMs: 900,
      reconnectBannerMs: 50,
      reconnectRtoMs: 1_000,
      reducedMotionSettleMs: 200,
      statePropagationP95Ms: stateSummary.p95Ms
    },
    gates: {
      browserPropagation: true,
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
    aiBenchmark: aiBenchmarkReference(),
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
      recoveryAcknowledgement('command-b', 900),
      recoveryAcknowledgement('command-c', 950)
    ];
    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a'],
      crashSignalAt: 1_000
    })).toEqual({
      acknowledgedCommands: 3,
      durableCommands: 1,
      lostCommands: 2,
      persistenceRpoMs: 100
    });

    expect(measurePersistenceRpo({
      acknowledgements,
      durableCommandIds: ['command-a', 'command-b', 'command-c'],
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

describe('v0.3.3 certification evidence', () => {
  it('records propagation arrivals without retaining or cloning diagnostic frame history', async () => {
    const commandId = '00000000-0000-4000-8000-000000000001';
    const sentCommand = (action: GameCommand, expectedRevision: number, nextCommandId = commandId) => ({
      type: 'command' as const,
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      commandId: nextCommandId,
      expectedRevision,
      action
    });
    const revealAction = { type: 'reveal-opening-card', cardIndex: 0 } as const;

    async function sampleWithDiagnosticHistory(historyLength: number) {
      const tracker = createPropagationArrivalTracker(8, () => 100);
      for (let index = 0; index < historyLength; index += 1) {
        tracker.recordFrame(index % 8, { type: 'ack' }, 90 + index / Math.max(historyLength, 1));
      }
      expect(tracker.retainedObservationCount()).toBe(0);
      const probe = tracker.beginRevision(7, revealAction, 0);
      tracker.recordSentFrame(0, sentCommand(revealAction, 6), 100);
      for (let clientIndex = 0; clientIndex < 8; clientIndex += 1) {
        tracker.recordFrame(clientIndex, {
          type: 'snapshot',
          protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
          revision: 7,
          room: { revision: 7, chatMessages: [] }
        }, 110 + clientIndex);
      }
      const latencyMs = await probe.promise;
      expect(tracker.pendingCount()).toBe(0);
      expect(tracker.retainedObservationCount()).toBe(11);
      return latencyMs;
    }

    expect(await sampleWithDiagnosticHistory(0)).toBe(17);
    expect(await sampleWithDiagnosticHistory(10_000)).toBe(17);

    const skippedRevision = createPropagationArrivalTracker(8, () => 100);
    const revisionProbe = skippedRevision.beginRevision(7, revealAction, 0);
    skippedRevision.recordSentFrame(0, sentCommand(revealAction, 6), 100);
    skippedRevision.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      revision: 8,
      room: { revision: 8, chatMessages: [] }
    }, 101);
    await expect(revisionProbe.promise).rejects.toThrow(/skipped expected revision/i);
    expect(() => skippedRevision.assertHealthy()).toThrow(/skipped expected revision/i);
    expect(() => skippedRevision.beginRevision(9, revealAction, 0)).toThrow(/skipped expected revision/i);
    expect(() => skippedRevision.commonRevision()).toThrow(/skipped expected revision/i);

    const duplicateChat = createPropagationArrivalTracker(8, () => 100);
    const chatProbe = duplicateChat.beginChat('cert-chat-01', 0, 0);
    duplicateChat.recordSentFrame(
      0,
      sentCommand({ type: 'send-chat-message', text: 'cert-chat-01' }, 0),
      100
    );
    duplicateChat.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      revision: 1,
      room: {
        revision: 1,
        chatMessages: [{ text: 'cert-chat-01' }, { text: 'cert-chat-01' }]
      }
    }, 101);
    await expect(chatProbe.promise).rejects.toThrow(/duplicated/i);

    const lateDuplicateChat = createPropagationArrivalTracker(8, () => 100);
    const completedChatProbe = lateDuplicateChat.beginChat('cert-chat-01', 0, 0);
    lateDuplicateChat.recordSentFrame(
      0,
      sentCommand({ type: 'send-chat-message', text: 'cert-chat-01' }, 0),
      100
    );
    for (let clientIndex = 0; clientIndex < 8; clientIndex += 1) {
      lateDuplicateChat.recordFrame(clientIndex, {
        type: 'snapshot',
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        revision: 1,
        room: { revision: 1, chatMessages: [{ text: 'cert-chat-01' }] }
      }, 101 + clientIndex);
    }
    await expect(completedChatProbe.promise).resolves.toBe(8);
    lateDuplicateChat.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      revision: 1,
      room: {
        revision: 1,
        chatMessages: [{ text: 'cert-chat-01' }, { text: 'cert-chat-01' }]
      }
    }, 109);
    expect(() => lateDuplicateChat.assertHealthy()).toThrow(/duplicated/i);

    const sentBeforeArming = createPropagationArrivalTracker(8, () => 100);
    sentBeforeArming.recordSentFrame(0, sentCommand(revealAction, 6), 100);
    expect(() => sentBeforeArming.beginRevision(7, revealAction, 0)).toThrow(/sent before its probe was armed/i);
    expect(() => sentBeforeArming.assertHealthy()).toThrow(/sent before its probe was armed/i);

    const missingSentCommand = createPropagationArrivalTracker(8, () => 100);
    const missingSentProbe = missingSentCommand.beginRevision(7, revealAction, 0);
    missingSentCommand.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      revision: 7,
      room: { revision: 7, chatMessages: [] }
    }, 101);
    await expect(missingSentProbe.promise).rejects.toThrow(/preceded its matching sent command/i);

    const duplicateSentCommand = createPropagationArrivalTracker(8, () => 100);
    const duplicateSentProbe = duplicateSentCommand.beginRevision(7, revealAction, 0);
    const sentFrame = sentCommand(revealAction, 6);
    duplicateSentCommand.recordSentFrame(0, sentFrame, 100);
    duplicateSentCommand.recordSentFrame(0, sentFrame, 101);
    await expect(duplicateSentProbe.promise).rejects.toThrow(/command id.*more than once/i);
    expect(() => duplicateSentCommand.assertHealthy()).toThrow(/command id.*more than once/i);

    const mismatchedAction = createPropagationArrivalTracker(8, () => 100);
    const mismatchedActionProbe = mismatchedAction.beginRevision(7, revealAction, 0);
    mismatchedAction.recordSentFrame(0, sentCommand({ type: 'draw-blind' }, 6), 100);
    await expect(mismatchedActionProbe.promise).rejects.toThrow(/expected reveal-opening-card but observed draw-blind/i);
    expect(() => mismatchedAction.assertHealthy()).toThrow(/expected reveal-opening-card but observed draw-blind/i);

    const mismatchedPayload = createPropagationArrivalTracker(8, () => 100);
    const mismatchedPayloadProbe = mismatchedPayload.beginRevision(7, revealAction, 0);
    mismatchedPayload.recordSentFrame(
      0,
      sentCommand({ type: 'reveal-opening-card', cardIndex: 1 }, 6),
      100
    );
    await expect(mismatchedPayloadProbe.promise).rejects.toThrow(/wrong reveal-opening-card action payload/i);
    expect(() => mismatchedPayload.assertHealthy()).toThrow(/wrong reveal-opening-card action payload/i);

    const mismatchedSender = createPropagationArrivalTracker(8, () => 100);
    const mismatchedSenderProbe = mismatchedSender.beginRevision(7, revealAction, 0);
    mismatchedSender.recordSentFrame(1, sentFrame, 100);
    await expect(mismatchedSenderProbe.promise).rejects.toThrow(/expected sender 1 but observed sender 2/i);
    expect(() => mismatchedSender.assertHealthy()).toThrow(/expected sender 1 but observed sender 2/i);

    const mismatchedRevision = createPropagationArrivalTracker(8, () => 100);
    const mismatchedRevisionProbe = mismatchedRevision.beginRevision(7, revealAction, 0);
    mismatchedRevision.recordSentFrame(0, sentCommand(revealAction, 5), 100);
    await expect(mismatchedRevisionProbe.promise).rejects.toThrow(/expected command revision 6 but observed 5/i);
    expect(() => mismatchedRevision.assertHealthy()).toThrow(/expected command revision 6 but observed 5/i);

    const replayAfterCompletion = createPropagationArrivalTracker(8, () => 100);
    const completedRevisionProbe = replayAfterCompletion.beginRevision(7, revealAction, 0);
    replayAfterCompletion.recordSentFrame(0, sentFrame, 100);
    for (let clientIndex = 0; clientIndex < 8; clientIndex += 1) {
      replayAfterCompletion.recordFrame(clientIndex, {
        type: 'snapshot',
        protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
        revision: 7,
        room: { revision: 7, chatMessages: [] }
      }, 101 + clientIndex);
    }
    await expect(completedRevisionProbe.promise).resolves.toBe(8);
    replayAfterCompletion.recordSentFrame(
      0,
      sentCommand(revealAction, 6, '00000000-0000-4000-8000-000000000002'),
      109
    );
    expect(() => replayAfterCompletion.assertHealthy()).toThrow(/sent after its probe completed/i);

    for (const invalidFrame of [
      { ...sentFrame, protocolVersion: 1 },
      { ...sentFrame, commandId: 'not-a-command-id' },
      { ...sentFrame, action: { type: 'reveal-opening-card' } },
      { ...sentFrame, action: { type: 'reveal-opening-card', cardIndex: 999 } }
    ]) {
      const invalidEnvelope = createPropagationArrivalTracker(8, () => 100);
      const invalidEnvelopeProbe = invalidEnvelope.beginRevision(7, revealAction, 0);
      invalidEnvelope.recordSentFrame(0, invalidFrame, 100);
      await expect(invalidEnvelopeProbe.promise).rejects.toThrow(/protocol-v2 validation/i);
      expect(() => invalidEnvelope.assertHealthy()).toThrow(/protocol-v2 validation/i);
    }

    const concurrentProbe = createPropagationArrivalTracker(8, () => 100);
    const armedProbe = concurrentProbe.beginRevision(7, revealAction, 0);
    expect(() => concurrentProbe.beginChat('cert-chat-01', 6, 0)).toThrow(/only one propagation probe/i);
    armedProbe.cancel();

    const wrongInboundProtocol = createPropagationArrivalTracker(8, () => 100);
    wrongInboundProtocol.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: 1,
      revision: 0,
      room: { revision: 0, chatMessages: [] }
    }, 100);
    expect(() => wrongInboundProtocol.assertHealthy()).toThrow(/protocol version 2/i);

    const stickyFailure = createPropagationArrivalTracker(8, () => 100);
    stickyFailure.recordFrame(0, {
      type: 'snapshot',
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      revision: Number.NaN,
      room: { revision: Number.NaN, chatMessages: [] }
    }, 101);
    expect(() => stickyFailure.assertHealthy()).toThrow(/invalid revision/i);
    expect(() => stickyFailure.beginRevision(1, revealAction, 0)).toThrow(/invalid revision/i);

    expect(() => summarizePropagationSamples([1, 2, Number.NaN], 3)).toThrow(/finite/i);
    expect(() => summarizePropagationSamples([1, 2], 3)).toThrow(/exactly 3/i);
    expect(summarizePropagationSamples(Array.from({ length: 18 }, (_, index) => index + 1), 18).p95Ms).toBe(18);
    expect(summarizePropagationSamples([...Array.from({ length: 19 }, (_, index) => index + 1), 10_000], 20).p95Ms).toBe(19);

    const personaSource = await fs.readFile(
      path.join(root, 'tests', 'e2e', 'certification', 'eight-client-personas.spec.ts'),
      'utf8'
    );
    expect(personaSource).toMatch(
      /socket\.onMessage\(\(payload\) => \{\s+const observedAt = performance\.now\(\);\s+const serialized/
    );
    expect(personaSource).toMatch(
      /socket\.on\('framereceived', \(\{ payload \}\) => \{\s+const observedAt = performance\.now\(\);\s+const serialized/
    );
  });

  it('accepts only the exact finite release topology and thresholds', () => {
    expect(validateK6CertificationSummary(k6Summary())).toEqual(k6Summary());
    expect(validateRecoveryCertification(recoveryEvidence())).toEqual(recoveryEvidence());
    expect(validateRssStageEvidence(rssStageEvidence())).toEqual(rssStageEvidence());
    expect(validateEightClientPersonaEvidence(personaEvidence())).toEqual(personaEvidence());
    expect(validateAutomatedCertificationEvidence(automatedEvidence())).toEqual(automatedEvidence());
    expect(assertAiBenchmarkMatchesCertification(
      automatedEvidence(),
      {
        formatVersion: 1,
        kind: 'skyjo-ai-benchmark',
        releaseVersion: CERTIFICATION_RELEASE_VERSION,
        sourceSha,
        strategyVersion: 1
      },
      'd'.repeat(64)
    )).toMatchObject({ sourceSha, strategyVersion: 1 });
    expect(assertRssStageEvidenceMatchesCertification(automatedEvidence(), rssStageEvidence())).toEqual(rssStageEvidence());
    expect(assertRecoveryTraceMatchesCertification(automatedEvidence(), recoveryTraceEvidence())).toEqual(recoveryTraceEvidence());

    const benchmark = {
      formatVersion: 1,
      kind: 'skyjo-ai-benchmark',
      releaseVersion: CERTIFICATION_RELEASE_VERSION,
      sourceSha,
      strategyVersion: 1
    };
    expect(() => assertAiBenchmarkMatchesCertification(
      automatedEvidence(), benchmark, 'e'.repeat(64)
    )).toThrow(/does not match/i);
    expect(() => assertAiBenchmarkMatchesCertification(
      automatedEvidence(), { ...benchmark, sourceSha: 'b'.repeat(40) }, 'd'.repeat(64)
    )).toThrow(/does not match/i);
    expect(() => assertAiBenchmarkMatchesCertification(
      automatedEvidence(), { ...benchmark, releaseVersion: '0.2.2' }, 'd'.repeat(64)
    )).toThrow(/release version/i);
    expect(() => assertAiBenchmarkMatchesCertification(
      automatedEvidence(), { ...benchmark, strategyVersion: 2 }, 'd'.repeat(64)
    )).toThrow(/does not match/i);

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

    const missingPropagation = personaEvidence();
    missingPropagation.propagation.stateMs.pop();
    expect(() => validateEightClientPersonaEvidence(missingPropagation)).toThrow(/exactly 18/i);

    const nonFinitePropagation = personaEvidence();
    nonFinitePropagation.propagation.chatMs[0] = Number.NaN;
    expect(() => validateEightClientPersonaEvidence(nonFinitePropagation)).toThrow(/finite/i);

    const slowPropagation = personaEvidence();
    slowPropagation.propagation.stateMs[slowPropagation.propagation.stateMs.length - 1] = 251;
    slowPropagation.measurements.statePropagationP95Ms = 251;
    expect(() => validateEightClientPersonaEvidence(slowPropagation)).toThrow(/exceeded 250ms/i);

    const mismatchedPropagation = personaEvidence();
    mismatchedPropagation.measurements.chatPropagationP95Ms += 1;
    expect(() => validateEightClientPersonaEvidence(mismatchedPropagation)).toThrow(/must equal/i);

    const obsoletePersona = personaEvidence();
    obsoletePersona.formatVersion = 1;
    expect(() => validateEightClientPersonaEvidence(obsoletePersona)).toThrow(/format version/i);

    expect(() => createAutomatedCertificationEvidence({
      aiBenchmark: aiBenchmarkReference(),
      release: releaseIdentity(),
      k6Summary: k6Summary(),
      rss: rssStageEvidence(CERTIFICATION_LIMITS.rssKibExclusive),
      recovery: recoveryEvidence(),
      persona: personaEvidence()
    })).toThrow(/RSS/i);

    const wrongPersona = personaEvidence();
    wrongPersona.release.sourceSha = 'b'.repeat(40);
    expect(() => createAutomatedCertificationEvidence({
      aiBenchmark: aiBenchmarkReference(),
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
    const personaPath = path.join(directory, 'persona.json');
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

      const failedPersona = personaEvidence();
      failedPersona.propagation.stateMs[failedPersona.propagation.stateMs.length - 1] = 251;
      failedPersona.measurements.statePropagationP95Ms = 251;
      failedPersona.gates.browserPropagation = false;
      const personaWritten = await writeEightClientPersonaEvidence(personaPath, failedPersona, { requirePassed: false });
      expect(personaWritten.digest).toMatch(/^[a-f0-9]{64}$/);
      expect((await readVerifiedEightClientPersonaEvidence(
        personaPath,
        personaWritten.checksumPath,
        { requirePassed: false }
      )).evidence).toEqual(failedPersona);
      await expect(readVerifiedEightClientPersonaEvidence(personaPath, personaWritten.checksumPath)).rejects.toThrow(/exceeded 250ms/i);

      await fs.appendFile(evidencePath, ' ');
      await expect(readVerifiedCertificationEvidence(evidencePath, written.checksumPath)).rejects.toThrow(/checksum/i);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('v0.3.3 immutable tag identity', () => {
  const metadata = {
    tagRef: 'refs/tags/v0.3.3',
    tagName: 'v0.3.3',
    packageVersion: '0.3.3',
    packageLockVersion: '0.3.3',
    packageLockRootVersion: '0.3.3',
    certificationVersion: '0.3.3'
  };
  const packageDocument = { version: metadata.packageVersion };
  const packageLock = {
    version: metadata.packageLockVersion,
    packages: { '': { version: metadata.packageLockRootVersion } }
  };
  const tagObject = 'a'.repeat(40);
  const commit = 'b'.repeat(40);

  function annotatedTagContents(overrides: { object?: string; type?: string; tag?: string } = {}) {
    return [
      `object ${overrides.object ?? commit}`,
      `type ${overrides.type ?? 'commit'}`,
      `tag ${overrides.tag ?? metadata.tagName}`,
      'tagger Release Bot <release@example.com> 1785247200 -0600',
      '',
      'Skyjo release',
      ''
    ].join('\n');
  }

  function tagIdentityGit(tagContents: string, checkoutCommit = commit) {
    const responses = new Map([
      ['cat-file -t refs/tags/v0.3.3', 'tag\n'],
      ['rev-parse --verify refs/tags/v0.3.3^{tag}', `${tagObject}\n`],
      ['rev-parse --verify HEAD^{commit}', `${checkoutCommit}\n`],
      [`cat-file tag ${tagObject}`, tagContents]
    ]);
    return vi.fn(async (arguments_: string[]) => responses.get(arguments_.join(' ')) || '');
  }

  function verifyTag(runGit: (arguments_: string[]) => Promise<string>) {
    return verifyReleaseTagIdentity({
      tagRef: metadata.tagRef,
      tagName: metadata.tagName,
      packageDocument,
      packageLock,
      certificationVersion: metadata.certificationVersion,
      runGit
    });
  }

  it('binds the full tag ref, package, lockfile, and certification versions exactly', () => {
    expect(validateReleaseTagMetadata(metadata)).toBe('v0.3.3');
    for (const changed of [
      { tagRef: 'refs/tags/v0.3.2', tagName: 'v0.3.2' },
      { tagRef: 'refs/tags/v0.3.3-extra' },
      { tagName: 'v0.3.2' },
      { packageVersion: '0.3.2' },
      { packageLockVersion: '0.3.2' },
      { packageLockRootVersion: '0.3.2' },
      { certificationVersion: '0.3.2' }
    ]) {
      expect(() => validateReleaseTagMetadata({ ...metadata, ...changed })).toThrow(/release|version|tag/i);
    }
  });

  it('accepts only an annotated tag object directly naming the checked-out commit', async () => {
    const runGit = tagIdentityGit(annotatedTagContents());
    await expect(verifyTag(runGit)).resolves.toEqual({
      expectedTag: 'v0.3.3',
      tagObject,
      taggedCommit: commit
    });
    expect(runGit).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/tags/v0.3.3^{tag}']);
    expect(runGit).toHaveBeenCalledWith(['cat-file', 'tag', tagObject]);
    expect(runGit).not.toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'refs/tags/v0.3.3^{commit}'
    ]);
  });

  it('rejects lightweight tags and commit drift', async () => {
    await expect(verifyTag(async () => 'commit\n')).rejects.toThrow(/annotated tag/i);
    await expect(
      verifyTag(tagIdentityGit(annotatedTagContents(), 'c'.repeat(40)))
    ).rejects.toThrow(/checked-out commit/i);
  });

  it('rejects mismatched names, malformed headers, and duplicate reserved headers', async () => {
    const cases = [
      {
        contents: annotatedTagContents({ tag: 'v0.3.2' }),
        error: /name does not match/i
      },
      {
        contents: annotatedTagContents().replace(`object ${commit}`, `object\t${commit}`),
        error: /header is malformed/i
      },
      {
        contents: annotatedTagContents().replace(`type commit\n`, ''),
        error: /header is malformed/i
      },
      {
        contents: annotatedTagContents().replace(
          `type commit\n`,
          `object ${'c'.repeat(40)}\ntype commit\n`
        ),
        error: /duplicate object header/i
      },
      {
        contents: annotatedTagContents().replace('tag v0.3.3\n', 'type commit\ntag v0.3.3\n'),
        error: /duplicate type header/i
      },
      {
        contents: annotatedTagContents().replace(
          'tagger Release Bot',
          'tag v0.3.3\ntagger Release Bot'
        ),
        error: /duplicate tag header/i
      },
      {
        contents: annotatedTagContents().replace('tagger Release Bot', 'unknown Release Bot'),
        error: /header is malformed/i
      },
      {
        contents: annotatedTagContents().replace('\n\nSkyjo release', '\nSkyjo release'),
        error: /header is malformed/i
      }
    ];
    for (const { contents, error } of cases) {
      await expect(verifyTag(tagIdentityGit(contents))).rejects.toThrow(error);
    }
  });

  it('rejects nested tag targets without accepting an indirectly peeled commit', async () => {
    const runGit = tagIdentityGit(annotatedTagContents({
      object: 'c'.repeat(40),
      type: 'tag'
    }));
    await expect(verifyTag(runGit)).rejects.toThrow(/directly target a commit/i);
    expect(runGit).not.toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'refs/tags/v0.3.3^{commit}'
    ]);
  });
});

describe('v0.3.3 workflow governance', () => {
  it('enumerates common text and JSON renderings of sensitive binary storage', () => {
    expect(sensitiveBinaryLogRepresentations('0001ff')).toEqual([
      '0001ff',
      '0001FF',
      '00 01 ff',
      '00 01 FF',
      '00:01:ff',
      '00:01:FF',
      'AAH/',
      'AAH_',
      '0,1,255',
      '0, 1, 255',
      '"0":0,"1":1,"2":255'
    ]);
    expect(sensitiveBinaryLogRepresentations('fbff')).toEqual(expect.arrayContaining([
      'fb:ff',
      'FB:FF',
      '+/8=',
      '+/8',
      '-_8'
    ]));
  });

  it('selects a compact standard phone independently from the large-phone entry', () => {
    type SimulatorMatrixEntry = {
      role: 'standard-phone' | 'large-phone' | 'ipad';
      runtime: string;
      name: string;
      udid: string;
    };
    const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
    const device = (name: string, udid: string) => ({ name, udid, isAvailable: true });
    const baseDevices = [
      device('iPhone 17 Pro', '00000000-0000-4000-8000-000000000001'),
      device('iPhone 17e', '00000000-0000-4000-8000-000000000002'),
      device('iPhone 17 Pro Max', '00000000-0000-4000-8000-000000000003'),
      device('iPad Pro 13-inch (M5)', '00000000-0000-4000-8000-000000000004')
    ];

    let matrix = selectSimulatorMatrix({ devices: { [runtime]: baseDevices } }) as SimulatorMatrixEntry[];
    expect(matrix.find((entry) => entry.role === 'standard-phone')?.name).toBe('iPhone 17e');
    expect(matrix.find((entry) => entry.role === 'large-phone')?.name).toBe('iPhone 17 Pro Max');

    matrix = selectSimulatorMatrix({
      devices: {
        [runtime]: [
          ...baseDevices,
          device('iPhone SE (3rd generation)', '00000000-0000-4000-8000-000000000005')
        ]
      }
    });
    expect(matrix.find((entry) => entry.role === 'standard-phone')?.name).toBe(
      'iPhone SE (3rd generation)'
    );
  });

  it('rejects missing or malformed APNs rollback proof identity before synthetic work', async () => {
    await expect(runApnsRollbackProof()).rejects.toThrow('exact lowercase 40-character release SHA');
    await expect(runApnsRollbackProof({ expectedReleaseSha: 'A'.repeat(40) })).rejects.toThrow(
      'exact lowercase 40-character release SHA'
    );

    const helperPath = path.join(root, 'server-apns-rollback-proof.mjs');
    const invalidArguments = [
      [],
      ['--expected-release-sha', 'A'.repeat(40)],
      ['--expected-release-sha', 'a'.repeat(40), 'extra'],
      ['--wrong-option', 'a'.repeat(40)]
    ];
    for (const args of invalidArguments) {
      const result = spawnSync(process.execPath, [helperPath, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {},
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Usage: server-apns-rollback-proof.mjs --expected-release-sha <lowercase-40-sha>'
      );
      expect(result.stderr).not.toContain('APNS-ROW-MUST-NEVER-REACH-LOGS');
    }

    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-apns-proof-symlink-'));
    try {
      const helperSymlink = path.join(temporaryDirectory, 'server-apns-rollback-proof.mjs');
      await fs.symlink(helperPath, helperSymlink);
      const symlinkResult = spawnSync(process.execPath, [helperSymlink], {
        cwd: root,
        encoding: 'utf8',
        env: {},
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      expect(symlinkResult.status).not.toBe(0);
      expect(symlinkResult.signal).toBeNull();
      expect(symlinkResult.stdout).toBe('');
      expect(symlinkResult.stderr).toContain(
        'Usage: server-apns-rollback-proof.mjs --expected-release-sha <lowercase-40-sha>'
      );
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }

    const wrapperResult = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'smoke-apns-rollback-compatibility.mjs'), '--expected-release-sha', 'a'.repeat(40)],
      { cwd: root, encoding: 'utf8', env: {}, timeout: 5_000, maxBuffer: 64 * 1024 }
    );
    expect(wrapperResult.status).not.toBe(0);
    expect(wrapperResult.signal).toBeNull();
    expect(wrapperResult.stdout).toBe('');
    expect(wrapperResult.stderr).toContain('Usage: smoke-apns-rollback-compatibility.mjs');
  });

  it('requires the exact load gate and preserves pinned, least-privilege workflow execution', async () => {
    const [
      ci,
      uiAccessibilityHarness,
      codeql,
      nightly,
      installer,
      load,
      runner,
      realtime,
      verifier,
      apnsRollbackSmoke,
      apnsRollbackProof,
      artifactIntegration,
      releaseController,
      serverEntrypoint,
      packageDocument,
      packageLock,
      changelog,
      certificationAddendum,
      securityAddendum,
      deploymentChecklist,
      immutableDeployment
    ] = await Promise.all([
      fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'ios-ui-accessibility-test.sh'), 'utf8'),
      fs.readFile(path.join(root, '.github', 'workflows', 'codeql.yml'), 'utf8'),
      fs.readFile(path.join(root, '.github', 'workflows', 'nightly-certification.yml'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'install-k6.sh'), 'utf8'),
      fs.readFile(path.join(root, 'tests', 'load', 'skyjo-realtime.k6.js'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'run-automated-certification.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'src', 'serverRealtime.ts'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'verify-v030-release.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'smoke-apns-rollback-compatibility.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'server-apns-rollback-proof.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'test-runtime-artifact-integration.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'deploy', 'release-controller.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'package.json'), 'utf8'),
      fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
      fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'releases', 'v0.3.3-certification.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'releases', 'v0.3.3-security.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'deployment-smoke-checklist.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'immutable-deployment.md'), 'utf8')
    ]);
    expect(REQUIRED_CHECKS).toContain('CI / Load & Recovery');
    expect(REQUIRED_CHECKS.filter((check: string) => check === 'CI / Load & Recovery')).toHaveLength(1);
    expect(REQUIRED_CHECKS).toContain('iOS / Build');
    expect(REQUIRED_CHECKS.filter((check: string) => check === 'iOS / Build')).toHaveLength(1);
    expect(REQUIRED_CHECKS).toContain('iOS / Networking Contracts');
    expect(REQUIRED_CHECKS.filter((check: string) => check === 'iOS / Networking Contracts')).toHaveLength(1);
    expect(REQUIRED_CHECKS).toContain('iOS / UI & Accessibility');
    expect(REQUIRED_CHECKS.filter((check: string) => check === 'iOS / UI & Accessibility')).toHaveLength(1);
    expect(REQUIRED_CHECKS).toHaveLength(14);
    expect(ci).toMatch(/ios-build:\s*\n\s*name: iOS \/ Build/);
    expect(ci).toMatch(/ios-networking-contracts:\s*\n\s*name: iOS \/ Networking Contracts/);
    expect(ci).toMatch(/ios-ui-accessibility:\s*\n\s*name: iOS \/ UI & Accessibility/);
    const iosBuildSection = ci.match(/\n {2}ios-build:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    const iosNetworkingSection = ci.match(/\n {2}ios-networking-contracts:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    const iosUiRoleSection = ci.match(/\n {2}ios-ui-accessibility-role:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    const iosUiAggregateSection = ci.match(/\n {2}ios-ui-accessibility:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    expect(iosNetworkingSection).toMatch(/fetch-depth: 0/);
    expect(iosNetworkingSection).toMatch(/npm exec -- playwright install chromium/);
    expect(iosNetworkingSection).toMatch(/\.\/scripts\/ios-build-test\.sh --networking-contracts/);
    expect(iosBuildSection).not.toMatch(/playwright install chromium/);
    expect(iosUiRoleSection).toMatch(/name: iOS \/ UI & Accessibility \(\$\{\{ matrix\.role \}\}\)/);
    expect(iosUiRoleSection).toMatch(
      /role:\s*\n\s*- standard-phone\s*\n\s*- large-phone\s*\n\s*- ipad-portrait\s*\n\s*- ipad-landscape/
    );
    expect(iosUiRoleSection).toMatch(/SKYJO_IOS_UI_ACCESSIBILITY_ROLE: \$\{\{ matrix\.role \}\}/);
    expect(iosUiRoleSection).toMatch(
      /name: ios-ui-accessibility-\$\{\{ matrix\.role \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
    );
    expect(iosUiAggregateSection).toMatch(/if: \$\{\{ always\(\) \}\}/);
    expect(iosUiAggregateSection).toMatch(/needs: ios-ui-accessibility-role/);
    expect(iosUiAggregateSection).toMatch(
      /ROLE_JOBS_RESULT: \$\{\{ needs\.ios-ui-accessibility-role\.result \}\}/
    );
    expect(uiAccessibilityHarness).toContain(
      '""|standard-phone|large-phone|ipad-portrait|ipad-landscape) ;;'
    );
    expect(uiAccessibilityHarness).toContain('for udid in "${active_udids[@]}"; do');
    expect(uiAccessibilityHarness).toContain(
      'printf \'Selected UI accessibility role: %s\\n\' "${selected_role:-full-matrix}"'
    );
    const invalidUiRole = spawnSync(
      'bash',
      [path.join(root, 'scripts', 'ios-ui-accessibility-test.sh')],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, SKYJO_IOS_UI_ACCESSIBILITY_ROLE: 'full-matrix' }
      }
    );
    expect(invalidUiRole.status).toBe(1);
    expect(invalidUiRole.stderr).toContain(
      'SKYJO_IOS_UI_ACCESSIBILITY_ROLE must be one of standard-phone, large-phone, ipad-portrait, or ipad-landscape.'
    );
    expect(ci).toMatch(/load-recovery:\s*\n\s*name: CI \/ Load & Recovery/);
    const loadRecoverySection = ci.match(/\n {2}load-recovery:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    expect(loadRecoverySection).toContain('test-results/certification');
    expect(loadRecoverySection).not.toMatch(/playwright-report|test-results\/playwright|test-results\/server/);
    expect(nightly).toContain('Upload checksummed sanitized nightly evidence');
    expect(nightly).toContain('test-results/certification');
    expect(nightly).not.toMatch(/playwright-report|test-results\/playwright|test-results\/server/);
    expect(ci).toMatch(/release-canary:[\s\S]*?needs:[\s\S]*?- load-recovery/);
    expect(ci).toMatch(/pull_request:[\s\S]*push:[\s\S]*tags:[\s\S]*v\*/);
    expect(ci).toMatch(/Check out repository[\s\S]*?fetch-depth: 0/);
    expect(ci).toContain('Bind annotated tag to package and certification identity');
    expect(ci).toContain('node scripts/verify-release-tag-identity.mjs "$GITHUB_REF" "$GITHUB_REF_NAME"');
    expect(codeql).not.toMatch(/push:[\s\S]*?tags:/);
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
    expect(verifier).toMatch(/merge-base',\s*'--is-ancestor',\s*APNS_ROLLBACK_ENVELOPE_SOURCE_SHA/);
    expect(verifier).toContain("packageLock.packages?.['']?.version");
    expect(CERTIFICATION_RELEASE_VERSION).toBe('0.3.3');
    expect(CERTIFICATION_RELEASE_DATE).toBe('2026-07-30');
    expect(APNS_ROLLBACK_ENVELOPE_SOURCE_SHA).toBe('f842937e7515e4f5d854644e5f7929bde5da5312');
    const packageJson = JSON.parse(packageDocument);
    expect(packageJson.version).toBe('0.3.3');
    expect(packageJson.scripts['test:e2e:certification']).toContain('release-identity.spec.ts');
    expect(packageJson.scripts['test:e2e:certification']).toContain('--retries=0');
    expect(packageJson.scripts['smoke:apns-rollback']).toBe(
      'npm run build:server && node scripts/write-release-json.mjs && node scripts/smoke-apns-rollback-compatibility.mjs'
    );
    expect(packageJson.scripts['smoke:delivery']).toContain('npm run smoke:apns-rollback');
    expect(packageJson.scripts['smoke:release']).toContain('npm run smoke:delivery');
    expect(apnsRollbackSmoke).toContain('process.argv.slice(2).length !== 0');
    expect(apnsRollbackSmoke).toContain("loadReleaseIdentity(path.join(projectRoot, 'dist')");
    expect(apnsRollbackSmoke).toContain('allowDevelopment: false');
    expect(apnsRollbackSmoke).toContain('requireFullSha: true');
    expect(apnsRollbackSmoke).toContain('runApnsRollbackProof({ expectedReleaseSha: releaseIdentity.releaseSha })');
    expect(apnsRollbackSmoke).not.toContain('sensitiveCanary');
    expect(apnsRollbackSmoke).not.toContain("'--expected-release-sha'");
    expect(apnsRollbackProof).toContain('const leakedLogNeedles = new Set()');
    expect(apnsRollbackProof).toContain("logScanTails.get(stream) || ''");
    expect(apnsRollbackProof).toContain('combined.includes(needle)');
    expect(apnsRollbackProof).toContain('maxSensitiveLogNeedleLength - 1');
    expect(apnsRollbackProof).toContain('expectedRows[0].token_ciphertext_hex');
    expect(apnsRollbackProof).toContain('expectedRows[0].token_fingerprint_hex');
    expect(apnsRollbackProof).toContain("bytes.toString('base64url')");
    expect(apnsRollbackProof).toContain("standardBase64.replace(/=+$/u, '')");
    expect(apnsRollbackProof).toContain("join(':')");
    expect(apnsRollbackProof).toContain("decimalBytes.join(',')");
    expect(apnsRollbackProof).toContain('indexedDecimalBytes');
    expect(apnsRollbackProof).toContain('await fs.realpath(process.argv[1])');
    expect(apnsRollbackProof).toContain('assert.equal(leakedLogNeedles.size, 0');
    expect(apnsRollbackProof).toContain('APNs rollback proof server diagnostics withheld (${logByteCount} bytes)');
    expect(apnsRollbackProof).toContain('diagnostics withheld');
    expect(apnsRollbackProof).toContain('argv.length !== 2');
    expect(apnsRollbackProof).toContain("argv[0] !== '--expected-release-sha'");
    expect(apnsRollbackProof).toContain('const releaseSha = validateExpectedReleaseSha(expectedReleaseSha)');
    expect(apnsRollbackProof).toContain("fetch(`${baseUrl}/version`");
    expect(apnsRollbackProof).toContain('assert.equal(version.releaseSha, releaseSha)');
    expect(apnsRollbackProof).toContain('if (validatedGracefulStops.has(serverProcess)) return');
    expect(apnsRollbackProof).toContain('serverProcess.exitCode !== null || serverProcess.signalCode !== null');
    expect(apnsRollbackProof).toContain("serverProcess.kill('SIGTERM')");
    expect(apnsRollbackProof).toContain("serverProcess.kill('SIGKILL')");
    expect(apnsRollbackProof).toContain("serverProcess.once('close', (code, signal) => resolve({ code, signal }))");
    expect(apnsRollbackProof).toMatch(/exit\.code !== 0 \|\|\s+exit\.signal !== null/);
    expect(apnsRollbackProof).toContain('could not be reaped during bounded cleanup');
    expect(apnsRollbackProof).toContain('validatedGracefulStops.add(serverProcess)');
    expect(apnsRollbackProof).toContain("process.on('SIGINT', onSigint)");
    expect(apnsRollbackProof).toContain("process.on('SIGTERM', onSigterm)");
    expect(apnsRollbackProof).toContain("process.off('SIGINT', onSigint)");
    expect(apnsRollbackProof).toContain("process.off('SIGTERM', onSigterm)");
    expect(apnsRollbackProof).toContain('serverProcesses.map((serverProcess) => stopServer(serverProcess, { requireCleanExit: false }))');
    expect(apnsRollbackProof).toContain('assertApnsRowsPreserved(apnsRows(copiedDatabase), expectedRows)');
    expect(apnsRollbackProof).toContain('isDeepStrictEqual(actualRows, expectedRows)');
    expect(apnsRollbackProof).toContain('detected a row preservation mismatch');
    expect(apnsRollbackProof).not.toContain('assert.deepEqual(apnsRows(copiedDatabase), expectedRows)');
    for (const field of ['user_id', 'app_version', 'locale', 'created_at', 'updated_at']) {
      expect(apnsRollbackProof).toContain(`expectedRows[0].${field}`);
    }
    const bothValidatedStops = apnsRollbackProof.indexOf(
      'await Promise.all([stopServer(first), stopServer(second)])'
    );
    const postShutdownRowProof = apnsRollbackProof.indexOf(
      'assertApnsRowsPreserved(apnsRows(copiedDatabase), expectedRows)',
      bothValidatedStops
    );
    expect(bothValidatedStops).toBeGreaterThan(-1);
    expect(postShutdownRowProof).toBeGreaterThan(bothValidatedStops);
    expect(apnsRollbackProof).toContain('proof passed for ${releaseSha}');
    expect(apnsRollbackProof).not.toMatch(/console\.(?:error|log)\(logs\)/);
    expect(serverEntrypoint).not.toContain('server-apns-rollback-proof');
    expect(artifactIntegration).toContain("path.join(projectRoot, 'release', expectedNames.archiveName)");
    expect(artifactIntegration).toContain('verifyRuntimeArtifact({');
    expect(artifactIntegration).toContain('[published.archivePath, first.archivePath, second.archivePath]');
    expect(artifactIntegration).toContain('[published.checksumPath, first.checksumPath, second.checksumPath]');
    expect(artifactIntegration).toContain('readBoundedRegularFile(publishedSbomPath');
    expect(artifactIntegration).toContain('maxBytes: MAX_FILE_BYTES');
    expect(artifactIntegration).toContain('[publishedSbomData, firstSbomData, secondSbomData]');
    expect(artifactIntegration).not.toContain('fs.lstat(publishedSbomPath)');
    expect(artifactIntegration).not.toContain('fs.readFile(publishedSbomPath)');
    expect(artifactIntegration).toContain("'--extract', '--gzip', '--file', published.archivePath");
    expect(artifactIntegration).toContain("'server-apns-rollback-proof.mjs'");
    expect(artifactIntegration).toContain("controllerContract.entries.has('scripts/smoke-apns-rollback-compatibility.mjs')");
    expect(artifactIntegration).toContain('stdout: apnsProofOutput, stderr: apnsProofError');
    expect(artifactIntegration).toContain('`APNs rollback envelope proof passed for ${releaseSha}:');
    expect(artifactIntegration).toContain("assert.equal(apnsProofError, ''");
    expect(artifactIntegration).toContain('process.stdout.write(apnsProofOutput)');
    expect(artifactIntegration).toContain("'--expected-release-sha'");
    expect(artifactIntegration).toContain('env: { TMPDIR: temporaryRoot }');
    expect(artifactIntegration).toContain('Packaged server diagnostics withheld');
    expect(artifactIntegration).not.toMatch(/console\.error\(logs\)/);
    const promotedMetadataTagAssignment = releaseController.indexOf('metadata.tag = parsed.tag;');
    const promotedMetadataWrite = releaseController.indexOf(
      "await fsp.writeFile(resolveWithin(incoming, '.skyjo-deployment.json'), `${JSON.stringify(metadata)}\\n`, { mode: 0o444 });"
    );
    const promotedTreeNormalization = releaseController.indexOf(
      "await run('/usr/bin/chmod', ['--recursive', 'u=rwX,go=rX', incoming]);"
    );
    expect(promotedMetadataTagAssignment).toBeGreaterThan(-1);
    expect(promotedMetadataWrite).toBeGreaterThan(promotedMetadataTagAssignment);
    expect(promotedTreeNormalization).toBeGreaterThan(promotedMetadataWrite);
    expect(JSON.parse(packageLock).version).toBe('0.3.3');
    expect(JSON.parse(packageLock).packages[''].version).toBe('0.3.3');
    expect(changelog).toMatch(/^## 0\.3\.3 - 2026-07-30$/m);
    expect(changelog).toContain('source-only native solo launcher and game table');
    expect(changelog).toContain('artifact-only synthetic rollback-proof helper');
    expect(ci).toContain('Prove pinned live v0.3.2 and immutable v0.1.1 rollback compatibility');
    expect(certificationAddendum).toContain('not byte-equivalent to `v0.3.2`');
    expect(certificationAddendum).toContain('immutable cached-PWA v0.3.2 validator pin');
    expect(certificationAddendum).toContain('four-role UI/accessibility matrix');
    expect(certificationAddendum).toContain('normal `server.mjs` startup never imports it');
    expect(certificationAddendum).toContain('explicit approval in the current conversation naming both exact tag `v0.3.3` and exact `CERT_SHA`');
    expect(certificationAddendum).toContain('`previous` resolves to the exact immutable `v0.3.3` tag');
    expect(certificationAddendum).toContain('keep issue #203 open and #204 blocked');
    expect(certificationAddendum).toContain('CodeQL does not run automatically on tag pushes');
    expect(certificationAddendum).toContain('--name "skyjo-build-$CERT_SHA"');
    expect(certificationAddendum).toContain(
      '--name "certification-$CERT_SHA-$TAG_RUN_ID-$TAG_RUN_ATTEMPT"'
    );
    expect(certificationAddendum).toMatch(
      /--name "skyjo-build-\$CERT_SHA" \\\n\s+--dir \./
    );
    expect(certificationAddendum).toMatch(
      /--name "certification-\$CERT_SHA-\$TAG_RUN_ID-\$TAG_RUN_ATTEMPT" \\\n\s+--dir test-results/
    );
    expect(certificationAddendum).toContain('--tag v0.3.3');
    expect(certificationAddendum).toContain('--production-base-url https://skyjo.groundworkrevops.com');
    expect(certificationAddendum).toContain('published release back through GitHub');
    expect(certificationAddendum).toContain('every SHA-256 sidecar');
    expect(certificationAddendum).toContain('/srv/skyjo-online/previous');
    expect(certificationAddendum).toContain('set -eu');
    expect(certificationAddendum).toContain("/usr/bin/stat -c '%a' \"$resolved_previous/.skyjo-deployment.json\")\" = '644'");
    expect(certificationAddendum).not.toContain("/usr/bin/stat -c '%a' \"$resolved_previous/.skyjo-deployment.json\")\" = '444'");
    expect(certificationAddendum).toContain('/usr/bin/cmp -s - "$resolved_previous/.skyjo-deployment.json"');
    expect(certificationAddendum).toContain("controller's `releaseSha`, `artifactSha256`, `tag` key order and single final LF");
    expect(certificationAddendum).toContain('/usr/bin/sudo -u skyjo-canary /usr/bin/env -i TMPDIR=/var/tmp');
    expect(certificationAddendum).toContain('"$resolved_previous/server-apns-rollback-proof.mjs"');
    expect(certificationAddendum).toContain('--expected-release-sha "$V033_SHA"');
    expect(certificationAddendum).toContain('does not read the production environment or state');
    expect(certificationAddendum).not.toContain('physical `PASS V0.3 IOS`');
    expect(securityAddendum).toContain('Production dependencies remain unchanged');
    expect(securityAddendum).toContain('does not create or use `apns_devices`');
    expect(securityAddendum).toContain('bound to the current authorized account');
    expect(securityAddendum).toContain('general autonomy is insufficient');
    expect(securityAddendum).toContain('CodeQL does not run automatically on tag pushes');
    expect(securityAddendum).toContain('artifact-only certification helper');
    expect(securityAddendum).toContain('Normal `server.mjs` startup never imports it');
    expect(securityAddendum).toContain('requires both servers to exit cleanly after SIGTERM');
    expect(deploymentChecklist).toContain('exact uploaded archive, checksum, and SBOM equal both deterministic rebuilds');
    expect(deploymentChecklist).toContain('root-owned mode-`0644` `.skyjo-deployment.json` exact bytes');
    expect(deploymentChecklist).toContain('run its artifact-carried proof helper as `skyjo-canary` under `env -i`');
    expect(immutableDeployment).toContain('invokes the helper\'s strict direct CLI with its required expected SHA');
    expect(immutableDeployment).toContain('root-owned mode-`0644` deployment metadata bytes');
    expect(immutableDeployment).toContain('literal installed-`previous` proof');
  });
});
