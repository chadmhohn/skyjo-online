import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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

describe('v0.3.2 certification evidence', () => {
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

describe('v0.3.2 workflow governance', () => {
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

  it('requires the exact load gate and preserves pinned, least-privilege workflow execution', async () => {
    const [
      ci,
      nightly,
      installer,
      load,
      runner,
      realtime,
      verifier,
      apnsRollbackSmoke,
      packageDocument,
      packageLock,
      changelog,
      certificationAddendum,
      securityAddendum
    ] = await Promise.all([
      fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
      fs.readFile(path.join(root, '.github', 'workflows', 'nightly-certification.yml'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'install-k6.sh'), 'utf8'),
      fs.readFile(path.join(root, 'tests', 'load', 'skyjo-realtime.k6.js'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'run-automated-certification.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'src', 'serverRealtime.ts'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'verify-v030-release.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'scripts', 'smoke-apns-rollback-compatibility.mjs'), 'utf8'),
      fs.readFile(path.join(root, 'package.json'), 'utf8'),
      fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
      fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'releases', 'v0.3.2-certification.md'), 'utf8'),
      fs.readFile(path.join(root, 'docs', 'releases', 'v0.3.2-security.md'), 'utf8')
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
    expect(iosNetworkingSection).toMatch(/fetch-depth: 0/);
    expect(iosNetworkingSection).toMatch(/npm exec -- playwright install chromium/);
    expect(iosNetworkingSection).toMatch(/\.\/scripts\/ios-build-test\.sh --networking-contracts/);
    expect(iosBuildSection).not.toMatch(/playwright install chromium/);
    expect(ci).toMatch(/load-recovery:\s*\n\s*name: CI \/ Load & Recovery/);
    const loadRecoverySection = ci.match(/\n {2}load-recovery:[\s\S]*?(?=\n {2}[a-z][a-z-]+:)/)?.[0] || '';
    expect(loadRecoverySection).toContain('test-results/certification');
    expect(loadRecoverySection).not.toMatch(/playwright-report|test-results\/playwright|test-results\/server/);
    expect(nightly).toContain('Upload checksummed sanitized nightly evidence');
    expect(nightly).toContain('test-results/certification');
    expect(nightly).not.toMatch(/playwright-report|test-results\/playwright|test-results\/server/);
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
    expect(CERTIFICATION_RELEASE_DATE).toBe('2026-07-27');
    const packageJson = JSON.parse(packageDocument);
    expect(packageJson.version).toBe('0.3.2');
    expect(packageJson.scripts['test:e2e:certification']).toContain('release-identity.spec.ts');
    expect(packageJson.scripts['test:e2e:certification']).toContain('--retries=0');
    expect(packageJson.scripts['smoke:apns-rollback']).toBe(
      'npm run build:server && node scripts/write-release-json.mjs && node scripts/smoke-apns-rollback-compatibility.mjs'
    );
    expect(packageJson.scripts['smoke:delivery']).toContain('npm run smoke:apns-rollback');
    expect(packageJson.scripts['smoke:release']).toContain('npm run smoke:delivery');
    expect(apnsRollbackSmoke).toContain('logs.includes(sensitiveCanary)');
    expect(apnsRollbackSmoke).toContain('diagnostics withheld');
    expect(apnsRollbackSmoke).not.toMatch(/console\.(?:error|log)\(logs\)/);
    expect(JSON.parse(packageLock).version).toBe('0.3.2');
    expect(changelog).toMatch(/^## 0\.3\.2 - 2026-07-27$/m);
    expect(certificationAddendum).toContain('physical `PASS V0.3 IOS`');
    expect(certificationAddendum).toContain('complete automated CI and CodeQL matrix');
    expect(certificationAddendum).toContain('byte-equivalence proof');
    expect(certificationAddendum).toContain('`v0.3.0` and `v0.3.1` remain immutable and unpublished');
    expect(securityAddendum).toContain('Browser resource type is deliberately not an authorization boundary');
    expect(securityAddendum).toContain('`/cdn-cgi/rum?`');
  });
});
