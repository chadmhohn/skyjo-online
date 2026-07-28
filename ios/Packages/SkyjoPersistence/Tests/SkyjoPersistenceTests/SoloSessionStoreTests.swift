import Foundation
import SkyjoDomain
import SwiftData
import Testing

@testable import SkyjoPersistence

extension SkyjoPersistenceTestSuite {
@Suite("Owner-partitioned atomic solo persistence")
struct SoloSessionStoreTests {
  @Test("Guest and account partitions never expose another owner's save")
  func ownerPartitioning() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)

    for owner in [
      SoloOwnerPartition.guest,
      .account(PersistenceTestSupport.aliceID),
      .account(PersistenceTestSupport.bobID),
    ] {
      _ = try await store.startSession(
        owner: owner,
        gameID: gameID,
        state: state,
        setup: setup,
        savedAtMilliseconds: 10
      )
    }

    #expect(try await store.loadSession(for: .guest).session?.owner == .guest)
    #expect(
      try await store.loadSession(for: .account(PersistenceTestSupport.aliceID)).session?.owner
        == .account(PersistenceTestSupport.aliceID)
    )
    #expect(
      try await store.loadSession(for: .account(PersistenceTestSupport.bobID)).session?.owner
        == .account(PersistenceTestSupport.bobID)
    )
  }

  @Test("Monotonic save sequences reject stale and conflicting autosaves")
  func staleAutosaves() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    var state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await store.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: 0,
      savedAtMilliseconds: 10
    )

    state = GameEngine.revealOpeningCard(state, at: 0)
    _ = try await store.autosave(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: 1,
      savedAtMilliseconds: 20
    )

    await expectPersistenceError(.staleAutosave) {
      _ = try await store.autosave(
        owner: .guest,
        gameID: gameID,
        state: state,
        setup: setup,
        saveSequence: 0,
        savedAtMilliseconds: 30
      )
    }

    let duplicate = try await store.autosave(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: 1,
      savedAtMilliseconds: 99
    )
    #expect(duplicate.savedAtMilliseconds == 20)

    let conflictingState = GameEngine.revealOpeningCard(state, at: 1)
    await expectPersistenceError(.staleAutosave) {
      _ = try await store.autosave(
        owner: .guest,
        gameID: gameID,
        state: conflictingState,
        setup: setup,
        saveSequence: 1,
        savedAtMilliseconds: 40
      )
    }
    await expectPersistenceError(.sessionConflict) {
      _ = try await store.autosave(
        owner: .guest,
        gameID: PersistenceTestSupport.secondGameID,
        state: state,
        setup: setup,
        saveSequence: 2,
        savedAtMilliseconds: 50
      )
    }
  }

  @Test(
    "Replacement interruption rolls back to the prior game",
    arguments: [
      PersistenceCheckpoint.afterNewSessionInsert,
      .afterPriorSessionDelete,
      .beforeCommit,
    ]
  )
  func replacementRollback(checkpoint: PersistenceCheckpoint) async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let originalStore = SoloPersistenceStore(modelContainer: container)
    let originalState = try PersistenceTestSupport.activeState()
    let originalID = PersistenceTestSupport.guestGameID
    let originalSetup = try PersistenceTestSupport.setup(for: originalState, gameID: originalID)
    _ = try await originalStore.startSession(
      owner: .guest,
      gameID: originalID,
      state: originalState,
      setup: originalSetup,
      savedAtMilliseconds: 10
    )

    let replacementState = try PersistenceTestSupport.activeState(aiOpponentCount: 2)
    let replacementID = PersistenceTestSupport.secondGameID
    let replacementSetup = try PersistenceTestSupport.setup(
      for: replacementState,
      gameID: replacementID
    )
    let interruptedStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(faults: .failing(at: checkpoint))
    )
    await expectPersistenceError(.writeInterrupted) {
      _ = try await interruptedStore.replaceSession(
        owner: .guest,
        expectedGameID: originalID,
        newGameID: replacementID,
        state: replacementState,
        setup: replacementSetup,
        savedAtMilliseconds: 20
      )
    }

    let recovered = try await originalStore.loadSession(for: .guest)
    #expect(recovered.session?.gameID == originalID)
    #expect(recovered.session?.state == originalState)
  }

  @Test("A lost acknowledgement after commit reloads the complete replacement")
  func replacementCommitAcknowledgementLoss() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let originalStore = SoloPersistenceStore(modelContainer: container)
    let originalState = try PersistenceTestSupport.activeState()
    let originalID = PersistenceTestSupport.guestGameID
    _ = try await originalStore.startSession(
      owner: .guest,
      gameID: originalID,
      state: originalState,
      setup: try PersistenceTestSupport.setup(for: originalState, gameID: originalID),
      savedAtMilliseconds: 10
    )

    let replacementState = try PersistenceTestSupport.activeState(aiOpponentCount: 2)
    let replacementID = PersistenceTestSupport.secondGameID
    let interruptedStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(
        faults: .failing(at: .afterCommitAcknowledgement)
      )
    )
    await expectPersistenceError(.writeInterrupted) {
      _ = try await interruptedStore.replaceSession(
        owner: .guest,
        expectedGameID: originalID,
        newGameID: replacementID,
        state: replacementState,
        setup: try PersistenceTestSupport.setup(for: replacementState, gameID: replacementID),
        savedAtMilliseconds: 20
      )
    }

    #expect(try await originalStore.loadSession(for: .guest).session?.gameID == replacementID)
  }

  @Test("V1 cleanup prefers an older valid save over a newer corrupt duplicate owner row")
  func corruptionRecovery() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    let state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let snapshot = SoloSessionSnapshot(
      owner: .guest,
      gameID: gameID,
      saveSequence: 7,
      state: state,
      setup: try PersistenceTestSupport.setup(for: state, gameID: gameID),
      savedAtMilliseconds: 10
    )
    try writeV1Store(
      url: paths.store,
      sessions: [
        V1SessionFixture(snapshot: snapshot),
        V1SessionFixture(
          recordID: UUID().uuidString.lowercased(),
          ownerKey: SoloOwnerPartition.guest.storageKey,
          gameID: PersistenceTestSupport.secondGameID.uuidString.lowercased(),
          payloadVersion: 99,
          payload: Data("incompatible".utf8),
          updatedAtMilliseconds: 20
        ),
      ],
      outboxes: []
    )

    let container = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: container)
    let recovered = try await store.loadSession(for: .guest)
    #expect(recovered.session?.gameID == gameID)
    #expect(recovered.session?.saveSequence == 7)
    #expect(recovered.warning == nil)
    let context = ModelContext(container)
    #expect(try context.fetchCount(FetchDescriptor<SoloSessionRecord>()) == 1)
  }

  @Test("Low-storage failures are classified and leave the saved turn unchanged")
  func lowStorageFailure() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let normalStore = SoloPersistenceStore(modelContainer: container)
    var state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await normalStore.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    state = GameEngine.revealOpeningCard(state, at: 0)

    let quotaStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(
        faults: .failing(
          at: .beforeCommit,
          with: CocoaError(.fileWriteOutOfSpace)
        )
      )
    )
    await expectPersistenceError(.storageFull) {
      _ = try await quotaStore.autosave(
        owner: .guest,
        gameID: gameID,
        state: state,
        setup: setup,
        saveSequence: 1,
        savedAtMilliseconds: 20
      )
    }

    let restored = try await normalStore.loadSession(for: .guest).session
    #expect(restored?.saveSequence == 0)
  }

  @Test("Real V1 session and outbox records migrate with restored sequence and remain deliverable")
  func realV1ToV2Migration() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    let state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    let snapshot = SoloSessionSnapshot(
      owner: .guest,
      gameID: gameID,
      saveSequence: 17,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    let payload = try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))
    let terminal = try PersistenceTestSupport.terminalState()
    let outboxGameID = PersistenceTestSupport.secondGameID
    let outboxSetup = try PersistenceTestSupport.setup(for: terminal, gameID: outboxGameID)
    let outboxEnvelope = StatsSubmissionEnvelopeV1(
      accountID: PersistenceTestSupport.aliceID,
      gameID: outboxGameID,
      state: terminal,
      setup: outboxSetup,
      completedAtMilliseconds: 11
    )
    let outboxPayload = try PersistenceEnvelopeCodec.encode(outboxEnvelope)
    let v1Outbox = V1OutboxFixture(
      recordID: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!,
      accountID: PersistenceTestSupport.aliceID,
      gameID: outboxGameID,
      payload: outboxPayload,
      attempts: 2,
      createdAtMilliseconds: 11,
      updatedAtMilliseconds: 12,
      nextAttemptAtMilliseconds: 13
    )

    try writeV1Store(
      url: paths.store,
      sessions: [V1SessionFixture(snapshot: snapshot, payload: payload)],
      outboxes: [v1Outbox]
    )

    let migratedContainer = try SkyjoPersistenceContainer.make(at: paths.store)
    let migratedStore = SoloPersistenceStore(modelContainer: migratedContainer)
    let restored = try await migratedStore.loadSession(for: .guest)
    #expect(restored.session?.gameID == gameID)
    #expect(restored.session?.saveSequence == 17)
    let status = try await migratedStore.outboxStatus(accountID: PersistenceTestSupport.aliceID)
    #expect(
      status
        == StatsOutboxStatus(
          queued: 1,
          terminalFailures: 0,
          blockedByTerminalFailure: false
        )
    )
    let migratedItem = try #require(
      try await migratedStore.eligibleOutboxItems(
        accountID: PersistenceTestSupport.aliceID,
        nowMilliseconds: 13,
        force: false,
        limit: 1
      ).first
    )
    #expect(migratedItem.recordID == v1Outbox.recordID)
    #expect(migratedItem.gameID == outboxGameID)
    #expect(migratedItem.envelopeData == outboxPayload)
    #expect(migratedItem.request == outboxEnvelope.request)
    #expect(migratedItem.attempts == 2)
    #expect(migratedItem.createdAtMilliseconds == 11)
    #expect(migratedItem.nextAttemptAtMilliseconds == 13)
    #expect(!migratedItem.isTerminalFailure)

    let coordinator = StatsOutboxCoordinator(store: migratedStore) { request in
      #expect(request == outboxEnvelope.request)
    }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    #expect(
      await coordinator.flush(force: false)
        == StatsFlushResult(attempted: 1, delivered: 1, pending: 0, aborted: false)
    )
    #expect(SkyjoPersistenceSchemaMetadata.currentVersion == 2)
  }

  @Test("Read-only disk storage reports unavailable without replacing the prior save")
  func readOnlyStorage() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    let state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)

    try await writeCurrentStore(
      url: paths.store,
      state: state,
      gameID: gameID,
      setup: setup
    )
    let changed = GameEngine.revealOpeningCard(state, at: 0)
    do {
      let readOnlyContainer = try SkyjoPersistenceContainer.make(at: paths.store, allowsSave: false)
      let readOnlyStore = SoloPersistenceStore(modelContainer: readOnlyContainer)
      await expectPersistenceError(.storageUnavailable) {
        _ = try await readOnlyStore.autosave(
          owner: .guest,
          gameID: gameID,
          state: changed,
          setup: setup,
          saveSequence: 1,
          savedAtMilliseconds: 20
        )
      }
    }
    let verificationContainer = try SkyjoPersistenceContainer.make(at: paths.store, allowsSave: false)
    let verificationStore = SoloPersistenceStore(modelContainer: verificationContainer)
    #expect(try await verificationStore.loadSession(for: .guest).session?.saveSequence == 0)
  }

  @Test("Owner uniqueness remains durable across independent disk contexts")
  func ownerUniquenessAcrossContexts() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    let state = try PersistenceTestSupport.activeState()
    let firstID = PersistenceTestSupport.guestGameID
    let firstContainer = try SkyjoPersistenceContainer.make(at: paths.store)
    let firstStore = SoloPersistenceStore(modelContainer: firstContainer)
    _ = try await firstStore.startSession(
      owner: .guest,
      gameID: firstID,
      state: state,
      setup: try PersistenceTestSupport.setup(for: state, gameID: firstID),
      savedAtMilliseconds: 10
    )

    let secondContainer = try SkyjoPersistenceContainer.make(at: paths.store)
    let secondStore = SoloPersistenceStore(modelContainer: secondContainer)
    let secondID = PersistenceTestSupport.secondGameID
    await expectPersistenceError(.sessionConflict) {
      _ = try await secondStore.startSession(
        owner: .guest,
        gameID: secondID,
        state: state,
        setup: try PersistenceTestSupport.setup(for: state, gameID: secondID),
        savedAtMilliseconds: 20
      )
    }

    #expect(try await secondStore.loadSession(for: .guest).session?.gameID == firstID)
    let verification = ModelContext(secondContainer)
    #expect(try verification.fetchCount(FetchDescriptor<SoloSessionRecord>()) == 1)
  }

  @Test("Autosave coordinator coalesces turns and lifecycle flush surfaces warnings")
  func autosaveCoordinator() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    var state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await store.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    let coordinator = SoloAutosaveCoordinator(
      store: store,
      owner: .guest,
      gameID: gameID,
      setup: setup,
      initialSaveSequence: 0
    )

    state = GameEngine.revealOpeningCard(state, at: 0)
    await coordinator.recordLegalTurn(state: state, saveSequence: 1, savedAtMilliseconds: 20)
    state = GameEngine.revealOpeningCard(state, at: 1)
    await coordinator.recordLegalTurn(state: state, saveSequence: 2, savedAtMilliseconds: 30)
    await coordinator.bestEffortLifecycleFlush()
    #expect(await coordinator.flushPending() == nil)
    #expect(try await store.loadSession(for: .guest).session?.saveSequence == 2)
  }

  @Test("Autosave cancellation is terminal and cannot be reused by a later game turn")
  func autosaveCancellationIsTerminal() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    var state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await store.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    let coordinator = SoloAutosaveCoordinator(
      store: store,
      owner: .guest,
      gameID: gameID,
      setup: setup,
      initialSaveSequence: 0
    )
    await coordinator.cancel()
    state = GameEngine.revealOpeningCard(state, at: 0)
    await coordinator.recordLegalTurn(state: state, saveSequence: 1, savedAtMilliseconds: 20)
    #expect(await coordinator.flushPending() == nil)
    #expect(try await store.loadSession(for: .guest).session?.saveSequence == 0)
  }

  @Test("Envelope capacity retains the largest schema-bounded eight-player history")
  func maximumHistoryPayload() throws {
    let gameID = PersistenceTestSupport.guestGameID
    let state = try maximumHistoryTerminalState()
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    try SoloGameStateValidator.validate(state, setup: setup, gameID: gameID)
    let snapshot = SoloSessionSnapshot(
      owner: .account(PersistenceTestSupport.aliceID),
      gameID: gameID,
      saveSequence: 256,
      state: state,
      setup: setup,
      savedAtMilliseconds: 256
    )
    let data = try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))
    #expect(data.count > 256 * 1_024)
    #expect(data.count < PersistenceEnvelopeCodec.maximumPayloadBytes)
  }

  @Test("Two MiB envelope limit counts four-byte UTF-8 scalars on disk")
  func fourByteUTF8PayloadBoundary() async throws {
    let emptyEnvelopeBytes = try JSONEncoder().encode(FourBytePayload(value: "")).count
    let acceptedScalarCount =
      (PersistenceEnvelopeCodec.maximumPayloadBytes - emptyEnvelopeBytes) / 4
    let accepted = FourBytePayload(value: String(repeating: "😀", count: acceptedScalarCount))
    let acceptedData = try PersistenceEnvelopeCodec.encode(accepted)
    #expect(accepted.value.count < PersistenceEnvelopeCodec.maximumPayloadBytes)
    #expect(acceptedData.count == PersistenceEnvelopeCodec.maximumPayloadBytes)
    #expect(try PersistenceEnvelopeCodec.decode(FourBytePayload.self, from: acceptedData) == accepted)

    let oversized = FourBytePayload(value: accepted.value + "😀")
    let oversizedData = try JSONEncoder().encode(oversized)
    #expect(oversized.value.count < PersistenceEnvelopeCodec.maximumPayloadBytes)
    #expect(oversizedData.count > PersistenceEnvelopeCodec.maximumPayloadBytes)
    do {
      _ = try PersistenceEnvelopeCodec.encode(oversized)
      Issue.record("Four-byte UTF-8 bytes beyond the cap must be rejected during encoding")
    } catch let error as SoloPersistenceError {
      #expect(error == .invalidSnapshot)
    }
    do {
      _ = try PersistenceEnvelopeCodec.decode(FourBytePayload.self, from: oversizedData)
      Issue.record("Four-byte UTF-8 bytes beyond the cap must be rejected during decoding")
    } catch let error as SoloPersistenceError {
      #expect(error == .incompatibleRecord)
    }

    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    do {
      let container = try SkyjoPersistenceContainer.make(at: paths.store)
      let context = ModelContext(container)
      context.autosaveEnabled = false
      context.insert(
        SoloSessionRecord(
          recordID: UUID().uuidString.lowercased(),
          ownerKey: SoloOwnerPartition.guest.storageKey,
          gameID: PersistenceTestSupport.guestGameID.uuidString.lowercased(),
          payloadVersion: PersistenceEnvelopeCodec.currentVersion,
          payload: oversizedData,
          updatedAtMilliseconds: 10,
          saveSequence: 0
        )
      )
      try context.save()
    }

    let reopened = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: reopened)
    let result = try await store.loadSession(for: .guest)
    #expect(result.session == nil)
    #expect(result.warning == .discarded)
    let verification = ModelContext(reopened)
    #expect(try verification.fetchCount(FetchDescriptor<SoloSessionRecord>()) == 0)
  }

  @Test("Explicit start, replacement, and deletion conflicts preserve the active UUID")
  func explicitFlowConflictsAndDeletion() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await store.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    await expectPersistenceError(.sessionConflict) {
      _ = try await store.startSession(
        owner: .guest,
        gameID: gameID,
        state: state,
        setup: setup,
        savedAtMilliseconds: 11
      )
    }
    await expectPersistenceError(.sessionConflict) {
      _ = try await store.replaceSession(
        owner: .guest,
        expectedGameID: PersistenceTestSupport.secondGameID,
        newGameID: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!,
        state: state,
        setup: setup,
        savedAtMilliseconds: 12
      )
    }
    await expectPersistenceError(.sessionConflict) {
      try await store.deleteSession(
        owner: .guest,
        expectedGameID: PersistenceTestSupport.secondGameID
      )
    }
    try await store.deleteSession(owner: .guest, expectedGameID: gameID)
    #expect(try await store.loadSession(for: .guest).session == nil)
  }

  @Test("Terminal session rows and entirely incompatible records are discarded safely")
  func terminalAndIncompatibleSessionCleanup() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let gameID = PersistenceTestSupport.guestGameID
    let snapshot = SoloSessionSnapshot(
      owner: .guest,
      gameID: gameID,
      saveSequence: 1,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      savedAtMilliseconds: 10
    )
    let context = ModelContext(container)
    context.insert(
      SoloSessionRecord(
        recordID: UUID().uuidString.lowercased(),
        ownerKey: SoloOwnerPartition.guest.storageKey,
        gameID: gameID.uuidString.lowercased(),
        payloadVersion: PersistenceEnvelopeCodec.currentVersion,
        payload: try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot)),
        updatedAtMilliseconds: 10,
        saveSequence: 1
      )
    )
    try context.save()
    let discarded = try await store.loadSession(for: .guest)
    #expect(discarded.session == nil)
    #expect(discarded.warning == .discarded)

    let corruptContext = ModelContext(container)
    corruptContext.insert(
      SoloSessionRecord(
        recordID: UUID().uuidString.lowercased(),
        ownerKey: SoloOwnerPartition.guest.storageKey,
        gameID: gameID.uuidString.lowercased(),
        payloadVersion: 99,
        payload: Data(),
        updatedAtMilliseconds: 20,
        saveSequence: 0
      )
    )
    try corruptContext.save()
    let incompatible = try await store.loadSession(for: .guest)
    #expect(incompatible.session == nil)
    #expect(incompatible.warning == .discarded)
  }

  @Test("Autosave storage failure becomes a nonblocking warning and retains the pending turn")
  func autosaveWarning() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let normalStore = SoloPersistenceStore(modelContainer: container)
    var state = try PersistenceTestSupport.activeState()
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: state, gameID: gameID)
    _ = try await normalStore.startSession(
      owner: .guest,
      gameID: gameID,
      state: state,
      setup: setup,
      savedAtMilliseconds: 10
    )
    let interruptedStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(faults: .failing(at: .beforeCommit))
    )
    let coordinator = SoloAutosaveCoordinator(
      store: interruptedStore,
      owner: .guest,
      gameID: gameID,
      setup: setup,
      initialSaveSequence: 0
    )
    state = GameEngine.revealOpeningCard(state, at: 0)
    await coordinator.recordLegalTurn(state: state, saveSequence: 1, savedAtMilliseconds: 20)
    #expect(await coordinator.flushPending()?.kind == .unavailable)
    #expect(try await normalStore.loadSession(for: .guest).session?.saveSequence == 0)
    await coordinator.cancel()
  }

  @Test("Invalid start and completion transitions fail before touching storage")
  func invalidTransitions() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let active = try PersistenceTestSupport.activeState()
    let activeSetup = try PersistenceTestSupport.setup(
      for: active,
      gameID: PersistenceTestSupport.guestGameID
    )
    await expectPersistenceError(.invalidSnapshot) {
      try await store.completeSession(
        owner: .guest,
        gameID: PersistenceTestSupport.guestGameID,
        state: active,
        setup: activeSetup,
        saveSequence: 0,
        completedAtMilliseconds: 10
      )
    }
    let terminal = try PersistenceTestSupport.terminalState()
    await expectPersistenceError(.invalidSnapshot) {
      _ = try await store.startSession(
        owner: .guest,
        gameID: PersistenceTestSupport.guestGameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(
          for: terminal,
          gameID: PersistenceTestSupport.guestGameID
        ),
        savedAtMilliseconds: 10
      )
    }
    var malformed = active
    malformed.drawPile.removeLast()
    await expectPersistenceError(.invalidSnapshot) {
      _ = try await store.startSession(
        owner: .guest,
        gameID: PersistenceTestSupport.guestGameID,
        state: malformed,
        setup: activeSetup,
        savedAtMilliseconds: 10
      )
    }
  }
}
}

private func expectPersistenceError(
  _ expected: SoloPersistenceError,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    Issue.record("Expected a persistence error")
  } catch let error as SoloPersistenceError {
    #expect(error == expected)
  } catch {
    Issue.record("Expected a typed persistence error")
  }
}

private func writeV1Store(
  url: URL,
  sessions: [V1SessionFixture],
  outboxes: [V1OutboxFixture]
) throws {
  let schema = Schema(versionedSchema: SkyjoPersistenceSchemaV1.self)
  let configuration = ModelConfiguration(
    "SkyjoPersistence",
    schema: schema,
    url: url,
    allowsSave: true,
    cloudKitDatabase: .none
  )
  let container = try ModelContainer(for: schema, configurations: [configuration])
  let context = ModelContext(container)
  context.autosaveEnabled = false
  for session in sessions {
    context.insert(
      SkyjoPersistenceSchemaV1.SoloSessionRecord(
        recordID: session.recordID,
        ownerKey: session.ownerKey,
        gameID: session.gameID,
        payloadVersion: session.payloadVersion,
        payload: session.payload,
        updatedAtMilliseconds: session.updatedAtMilliseconds
      )
    )
  }
  for outbox in outboxes {
    context.insert(
      SkyjoPersistenceSchemaV1.StatsOutboxRecord(
        recordID: outbox.recordID.uuidString.lowercased(),
        ownerKey: SoloOwnerPartition.account(outbox.accountID).storageKey,
        gameID: outbox.gameID.uuidString.lowercased(),
        payloadVersion: PersistenceEnvelopeCodec.currentVersion,
        payload: outbox.payload,
        attempts: outbox.attempts,
        createdAtMilliseconds: outbox.createdAtMilliseconds,
        updatedAtMilliseconds: outbox.updatedAtMilliseconds,
        nextAttemptAtMilliseconds: outbox.nextAttemptAtMilliseconds
      )
    )
  }
  try context.save()
}

private struct V1SessionFixture {
  let recordID: String
  let ownerKey: String
  let gameID: String
  let payloadVersion: Int
  let payload: Data
  let updatedAtMilliseconds: Int64

  init(snapshot: SoloSessionSnapshot, payload: Data? = nil) throws {
    recordID = UUID().uuidString.lowercased()
    ownerKey = snapshot.owner.storageKey
    gameID = snapshot.gameID.uuidString.lowercased()
    payloadVersion = PersistenceEnvelopeCodec.currentVersion
    self.payload = try payload
      ?? PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))
    updatedAtMilliseconds = snapshot.savedAtMilliseconds
  }

  init(
    recordID: String,
    ownerKey: String,
    gameID: String,
    payloadVersion: Int,
    payload: Data,
    updatedAtMilliseconds: Int64
  ) {
    self.recordID = recordID
    self.ownerKey = ownerKey
    self.gameID = gameID
    self.payloadVersion = payloadVersion
    self.payload = payload
    self.updatedAtMilliseconds = updatedAtMilliseconds
  }
}

private struct FourBytePayload: Codable, Equatable {
  let value: String
}

private struct V1OutboxFixture {
  let recordID: UUID
  let accountID: UUID
  let gameID: UUID
  let payload: Data
  let attempts: Int
  let createdAtMilliseconds: Int64
  let updatedAtMilliseconds: Int64
  let nextAttemptAtMilliseconds: Int64
}

private func writeCurrentStore(
  url: URL,
  state: GameState,
  gameID: UUID,
  setup: SoloGameSetup
) async throws {
  let container = try SkyjoPersistenceContainer.make(at: url)
  let store = SoloPersistenceStore(modelContainer: container)
  _ = try await store.startSession(
    owner: .guest,
    gameID: gameID,
    state: state,
    setup: setup,
    savedAtMilliseconds: 10
  )
}

private func maximumHistoryTerminalState() throws -> GameState {
  var state = try PersistenceTestSupport.completedGame(aiOpponentCount: 7).terminal
  let oldIDs = state.players.map(\.id)
  let newIDs = state.players.indices.map { index in
    String(repeating: Character(UnicodeScalar(97 + index)!), count: 128)
  }
  let idMap = Dictionary(uniqueKeysWithValues: zip(oldIDs, newIDs))
  let longName = String(repeating: "🂠", count: 64)
  for index in state.players.indices {
    state.players[index].id = newIDs[index]
    state.players[index].name = "\(index)" + String(longName.dropFirst())
  }
  state.winnerId = state.winnerId.flatMap { idMap[$0] }
  state.nextStarterId = state.nextStarterId.flatMap { idMap[$0] }
  state.roundCloserId = state.roundCloserId.flatMap { idMap[$0] }
  state.finalTurnPlayerIds = state.finalTurnPlayerIds.compactMap { idMap[$0] }
  state.openingRevealCounts = Dictionary(
    uniqueKeysWithValues: state.players.map { ($0.id, 2) }
  )
  state.round = 256
  state.log = Array(repeating: String(repeating: "🂠", count: 512), count: 8)
  let closerID = try #require(state.nextStarterId)
  state.roundHistory = (1...256).map { round in
    RoundHistoryEntry(
      round: round,
      closerId: closerID,
      scores: state.players.map { player in
        RoundScore(
          playerId: player.id,
          name: player.name,
          roundScore: round == 1
            ? player.totalScore - player.roundScore
            : (round == 256 ? player.roundScore : 0),
          totalScore: round == 256
            ? player.totalScore
            : player.totalScore - player.roundScore
        )
      }
    )
  }
  return state
}
