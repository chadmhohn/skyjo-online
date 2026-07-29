import Foundation
import SkyjoDomain
import SwiftData
import Testing

@testable import SkyjoPersistence

extension SkyjoPersistenceTestSuite {
@Suite("Durable idempotent stats outbox")
struct StatsOutboxTests {
  @Test("Guest completion deletes the session and never creates an outbox row")
  func guestCompletion() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let game = try PersistenceTestSupport.completedGame()
    let active = game.initial
    let terminal = game.terminal
    let gameID = PersistenceTestSupport.guestGameID
    let setup = try PersistenceTestSupport.setup(for: terminal, gameID: gameID)
    _ = try await store.startSession(
      owner: .guest,
      gameID: gameID,
      state: active,
      setup: try PersistenceTestSupport.setup(for: active, gameID: gameID),
      savedAtMilliseconds: 10
    )

    try await store.completeSession(
      owner: .guest,
      gameID: gameID,
      state: terminal,
      setup: setup,
      saveSequence: 1,
      completedAtMilliseconds: 20
    )

    #expect(try await store.loadSession(for: .guest).session == nil)
    let context = ModelContext(container)
    #expect(try context.fetchCount(FetchDescriptor<StatsOutboxRecord>()) == 0)
  }

  @Test("Account completion atomically creates one immutable idempotent request")
  func accountCompletionIsIdempotent() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let gameID = PersistenceTestSupport.guestGameID
    let accountID = PersistenceTestSupport.aliceID
    let setup = try PersistenceTestSupport.setup(for: terminal, gameID: gameID)

    for _ in 0..<2 {
      try await store.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: setup,
        saveSequence: 1,
        completedAtMilliseconds: 20
      )
    }

    #expect(try await store.pendingOutboxCount(accountID: accountID) == 1)
    let item = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: false,
        limit: 4
      ).first
    )
    #expect(item.request.clientGameKey == gameID.uuidString.lowercased())
    #expect(item.request.expectedAccountUserId == accountID.uuidString.lowercased())
    #expect(item.request.completedAt == 20)

    try await store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: setup,
      saveSequence: 1,
      completedAtMilliseconds: 21
    )
    let unchanged = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 21,
        force: true,
        limit: 1
      ).first
    )
    #expect(unchanged.envelopeData == item.envelopeData)
    #expect(unchanged.request.completedAt == 20)
  }

  @Test("Completion retry after a lost commit acknowledgement preserves the first request")
  func completionAcknowledgementLossIsIdempotent() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let terminal = try PersistenceTestSupport.terminalState()
    let gameID = PersistenceTestSupport.guestGameID
    let accountID = PersistenceTestSupport.aliceID
    let setup = try PersistenceTestSupport.setup(for: terminal, gameID: gameID)
    let interrupted = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(
        nowMilliseconds: { 20 },
        faults: .failing(at: .afterCommitAcknowledgement)
      )
    )

    await expectStatsPersistenceError(.writeInterrupted) {
      try await interrupted.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: setup,
        saveSequence: 1
      )
    }

    let retry = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(nowMilliseconds: { 21 })
    )
    try await retry.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: setup,
      saveSequence: 1
    )
    #expect(try await retry.pendingOutboxCount(accountID: accountID) == 1)
    let item = try #require(
      try await retry.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 21,
        force: true,
        limit: 1
      ).first
    )
    #expect(item.request.completedAt == 20)
  }

  @Test(
    "Completion interruption preserves the active save and queues no stats",
    arguments: [
      PersistenceCheckpoint.afterOutboxInsert,
      .afterPriorSessionDelete,
      .beforeCommit,
    ]
  )
  func completionRollback(checkpoint: PersistenceCheckpoint) async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let normalStore = SoloPersistenceStore(modelContainer: container)
    let game = try PersistenceTestSupport.completedGame()
    let active = game.initial
    let terminal = game.terminal
    let gameID = PersistenceTestSupport.guestGameID
    let accountID = PersistenceTestSupport.aliceID
    _ = try await normalStore.startSession(
      owner: .account(accountID),
      gameID: gameID,
      state: active,
      setup: try PersistenceTestSupport.setup(for: active, gameID: gameID),
      savedAtMilliseconds: 10
    )
    let interrupted = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(faults: .failing(at: checkpoint))
    )

    await expectStatsPersistenceError(.writeInterrupted) {
      try await interrupted.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
        saveSequence: 1,
        completedAtMilliseconds: 20
      )
    }

    #expect(
      try await normalStore.loadSession(for: .account(accountID)).session?.gameID == gameID
    )
    #expect(try await normalStore.pendingOutboxCount(accountID: accountID) == 0)
  }

  @Test("FIFO delivery is account scoped, deterministic, and capped at four per pass")
  func fifoAndBatchCap() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameIDs = (1...5).map {
      UUID(uuidString: "00000000-0000-4000-8000-\(String(format: "%012d", $0))")!
    }
    for (index, gameID) in gameIDs.enumerated() {
      try await store.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
        saveSequence: 0,
        completedAtMilliseconds: Int64(index + 1)
      )
    }

    let collector = DeliveryCollector()
    let coordinator = StatsOutboxCoordinator(store: store) { request in
      await collector.append(request.clientGameKey)
    }
    await coordinator.setConfirmedAccount(accountID)
    let first = await coordinator.flush(force: true)
    #expect(first == StatsFlushResult(attempted: 4, delivered: 4, pending: 1, aborted: false))
    let second = await coordinator.flush(force: true)
    #expect(second == StatsFlushResult(attempted: 1, delivered: 1, pending: 0, aborted: false))
    #expect(await collector.values == gameIDs.map { $0.uuidString.lowercased() })
  }

  @Test("A failed FIFO head backs off and cannot be overtaken")
  func failureBackoffAndFifo() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    for (gameID, time) in [
      (PersistenceTestSupport.guestGameID, Int64(10)),
      (PersistenceTestSupport.secondGameID, Int64(20)),
    ] {
      try await store.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
        saveSequence: 0,
        completedAtMilliseconds: time
      )
    }

    let sleepProbe = RetrySleepProbe()
    let coordinator = StatsOutboxCoordinator(
      store: store,
      environment: StatsOutboxCoordinatorEnvironment(
        nowMilliseconds: { 100 },
        sleep: { duration in try await sleepProbe.recordAndStop(duration) }
      )
    ) { _ in
      throw StatsDeliveryError.retryable(.transport)
    }
    await coordinator.setConfirmedAccount(accountID)
    let failed = await coordinator.flush(force: true)
    #expect(failed.attempted == 1)
    #expect(failed.delivered == 0)
    #expect(failed.pending == 2)
    #expect(await sleepProbe.waitForDuration() == .seconds(1))

    let notDue = await coordinator.flush(force: false)
    #expect(notDue.attempted == 0)
    #expect(notDue.pending == 2)
    #expect(SoloPersistenceStore.retryDelayMilliseconds(afterAttempts: 1) == 1_000)
    #expect(SoloPersistenceStore.retryDelayMilliseconds(afterAttempts: 2) == 2_000)
    #expect(SoloPersistenceStore.retryDelayMilliseconds(afterAttempts: 20) == 300_000)
    await coordinator.dispose()
  }

  @Test("The portable retry-attempt ceiling saturates without overflow")
  func retryAttemptCeilingSaturates() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameID = PersistenceTestSupport.guestGameID
    try await store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      saveSequence: 0,
      completedAtMilliseconds: 10
    )

    let context = ModelContext(container)
    let row = try #require(context.fetch(FetchDescriptor<StatsOutboxRecord>()).first)
    row.attempts = PersistenceEnvelopeCodec.maximumOutboxAttempts
    try context.save()
    let item = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: true,
        limit: 1
      ).first
    )
    #expect(item.attempts == PersistenceEnvelopeCodec.maximumOutboxAttempts)
    #expect(
      try await store.markOutboxFailed(
        item,
        category: .transport,
        nowMilliseconds: 20
      ) == 300_020
    )
    let saturated = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: true,
        limit: 1
      ).first
    )
    #expect(saturated.attempts == PersistenceEnvelopeCodec.maximumOutboxAttempts)
  }

  @Test("Account generation abort retains the old row and delivers only the new owner")
  func accountSwitchAbortsInFlightDelivery() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let alice = PersistenceTestSupport.aliceID
    let bob = PersistenceTestSupport.bobID
    try await store.completeSession(
      owner: .account(alice),
      gameID: PersistenceTestSupport.guestGameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(
        for: terminal,
        gameID: PersistenceTestSupport.guestGameID
      ),
      saveSequence: 0,
      completedAtMilliseconds: 10
    )
    try await store.completeSession(
      owner: .account(bob),
      gameID: PersistenceTestSupport.secondGameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(
        for: terminal,
        gameID: PersistenceTestSupport.secondGameID
      ),
      saveSequence: 0,
      completedAtMilliseconds: 20
    )

    let gate = AccountSwitchDeliveryGate(aliceID: alice)
    let coordinator = StatsOutboxCoordinator(store: store) { request in
      try await gate.deliver(request)
    }
    await coordinator.setConfirmedAccount(alice)
    let aliceFlush = Task { await coordinator.flush(force: true) }
    await gate.waitUntilAliceStarted()

    await coordinator.setConfirmedAccount(bob)
    let bobResult = await coordinator.flush(force: true)
    #expect(bobResult.delivered == 1)
    await gate.releaseAlice()
    let aliceResult = await aliceFlush.value
    #expect(
      aliceResult
        == StatsFlushResult(attempted: 0, delivered: 0, pending: 0, aborted: true)
    )
    #expect(try await store.pendingOutboxCount(accountID: alice) == 1)
    #expect(try await store.pendingOutboxCount(accountID: bob) == 0)
  }

  @Test("Poison completion timestamps and corrupted outbox payloads never reach delivery")
  func poisonRows() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let gameID = PersistenceTestSupport.guestGameID
    let accountID = PersistenceTestSupport.aliceID
    await expectStatsPersistenceError(.invalidSnapshot) {
      try await store.completeSession(
        owner: .account(accountID),
        gameID: gameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
        saveSequence: 0,
        completedAtMilliseconds: PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum + 1
      )
    }

    let context = ModelContext(container)
    context.insert(
      StatsOutboxRecord(
        recordID: UUID().uuidString.lowercased(),
        ownerKey: SoloOwnerPartition.account(accountID).storageKey,
        gameID: gameID.uuidString.lowercased(),
        payloadVersion: 99,
        payload: Data("corrupt".utf8),
        attempts: 0,
        createdAtMilliseconds: 10,
        updatedAtMilliseconds: 10,
        nextAttemptAtMilliseconds: 10
      )
    )
    try context.save()
    #expect(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: true,
        limit: 4
      ).isEmpty
    )
    #expect(try await store.pendingOutboxCount(accountID: accountID) == 1)
    let blockedStatus = try await store.outboxStatus(accountID: accountID)
    #expect(blockedStatus.queued == 1)
    #expect(blockedStatus.terminalFailures == 0)
    #expect(blockedStatus.corruptRecords == 1)
    #expect(blockedStatus.blockedByTerminalFailure)
    #expect(blockedStatus.blockedHeadGameID == gameID)
    #expect(blockedStatus.blockedHeadKind == .corrupt)
    _ = try #require(blockedStatus.blockedHeadRecoveryHandle)
    let coordinator = StatsOutboxCoordinator(store: store) { _ in
      Issue.record("A corrupt outbox body must not reach delivery")
    }
    await coordinator.setConfirmedAccount(accountID)
    #expect(await coordinator.flush(force: true).attempted == 0)
    #expect(await coordinator.latestWarning?.kind == .statsNotSaved)
    let recoveryHandle = try #require(
      await coordinator.status().blockedHeadRecoveryHandle
    )
    do {
      try await coordinator.discardBlockedHead(
        expectedRecoveryHandle: StatsOutboxRecoveryHandle(token: UUID())
      )
      Issue.record("A different opaque capability must not discard the blocked head")
    } catch let error as SoloPersistenceError {
      #expect(error == .sessionConflict)
    }
    try await coordinator.discardBlockedHead(expectedRecoveryHandle: recoveryHandle)
    #expect(await coordinator.latestWarning == nil)
    #expect(await coordinator.status() == .empty)
  }

  @Test(
    "UI blocked-outbox fixtures expose the production recovery contract",
    arguments: [StatsOutboxBlockedHeadKind.terminal, .corrupt]
  )
  func uiBlockedOutboxFixture(kind: StatsOutboxBlockedHeadKind) async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameID = PersistenceTestSupport.guestGameID
    try await store.prepareBlockedOutboxForUITesting(
      accountID: accountID,
      gameID: gameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      kind: kind,
      completedAtMilliseconds: 20
    )

    let status = try await store.outboxStatus(accountID: accountID)
    #expect(status.queued == 1)
    #expect(status.terminalFailures == (kind == .terminal ? 1 : 0))
    #expect(status.corruptRecords == (kind == .corrupt ? 1 : 0))
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == gameID)
    #expect(status.blockedHeadKind == kind)
    let recoveryHandle = try #require(status.blockedHeadRecoveryHandle)

    await expectStatsPersistenceError(.sessionConflict) {
      try await store.prepareBlockedOutboxForUITesting(
        accountID: accountID,
        gameID: PersistenceTestSupport.secondGameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(
          for: terminal,
          gameID: PersistenceTestSupport.secondGameID
        ),
        kind: kind,
        completedAtMilliseconds: 21
      )
    }

    try await store.discardBlockedOutboxHead(
      accountID: accountID,
      expectedRecoveryHandle: recoveryHandle
    )
    #expect(try await store.outboxStatus(accountID: accountID) == .empty)
  }

  @Test("Permanent delivery failure dead-letters the FIFO head without overtaking or retry")
  func permanentFailureDeadLettersHead() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let alice = PersistenceTestSupport.aliceID
    let bob = PersistenceTestSupport.bobID
    for (gameID, time) in [
      (PersistenceTestSupport.guestGameID, Int64(10)),
      (PersistenceTestSupport.secondGameID, Int64(20)),
    ] {
      try await store.completeSession(
        owner: .account(alice),
        gameID: gameID,
        state: terminal,
        setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
        saveSequence: 0,
        completedAtMilliseconds: time
      )
    }
    let bobGame = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    try await store.completeSession(
      owner: .account(bob),
      gameID: bobGame,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: bobGame),
      saveSequence: 0,
      completedAtMilliseconds: 30
    )

    let probe = PermanentDeliveryProbe(aliceID: alice)
    let sleepProbe = RetryInvocationProbe()
    let coordinator = StatsOutboxCoordinator(
      store: store,
      environment: StatsOutboxCoordinatorEnvironment(
        nowMilliseconds: { 100 },
        sleep: { duration in try await sleepProbe.reject(duration) }
      )
    ) { request in
      try await probe.deliver(request)
    }
    await coordinator.setConfirmedAccount(alice)
    let failed = await coordinator.flush(force: true)
    #expect(failed == StatsFlushResult(attempted: 1, delivered: 0, pending: 2, aborted: false))
    #expect(await coordinator.latestWarning?.kind == .statsNotSaved)
    let status = await coordinator.status()
    #expect(status.queued == 2)
    #expect(status.terminalFailures == 1)
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == PersistenceTestSupport.guestGameID)
    #expect(status.blockedHeadKind == .terminal)
    let recoveryHandle = try #require(status.blockedHeadRecoveryHandle)
    let blocked = await coordinator.flush(force: true)
    #expect(blocked.attempted == 0)
    #expect(await probe.aliceCalls == 1)
    await Task.yield()
    #expect(await sleepProbe.calls == 0)

    await expectStatsPersistenceError(.sessionConflict) {
      try await store.retryTerminalOutboxHead(
        accountID: bob,
        expectedRecoveryHandle: recoveryHandle,
        nowMilliseconds: 101
      )
    }
    await probe.allowAliceSuccess()
    let recovered = await coordinator.retryTerminalHead(
      expectedRecoveryHandle: recoveryHandle
    )
    #expect(recovered == StatsFlushResult(attempted: 2, delivered: 2, pending: 0, aborted: false))
    #expect(await coordinator.latestWarning == nil)
    #expect(await coordinator.status() == .empty)

    await coordinator.setConfirmedAccount(bob)
    #expect(await coordinator.flush(force: true).delivered == 1)
    #expect(try await store.pendingOutboxCount(accountID: alice) == 0)
    #expect(try await store.pendingOutboxCount(accountID: bob) == 0)
  }

  @Test("Authorization changes abort without mutating or delaying the FIFO head")
  func authorizationChangeLeavesHeadUntouched() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameID = PersistenceTestSupport.guestGameID
    try await store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      saveSequence: 0,
      completedAtMilliseconds: 10
    )
    let before = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: true,
        limit: 1
      ).first
    )
    let coordinator = StatsOutboxCoordinator(store: store) { _ in
      throw StatsDeliveryError.authorizationChanged
    }
    await coordinator.setConfirmedAccount(accountID)

    #expect(
      await coordinator.flush(force: true)
        == StatsFlushResult(attempted: 0, delivered: 0, pending: 0, aborted: true)
    )

    let after = try #require(
      try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: 20,
        force: true,
        limit: 1
      ).first
    )
    #expect(after.envelopeData == before.envelopeData)
    #expect(after.attempts == before.attempts)
    #expect(after.nextAttemptAtMilliseconds == before.nextAttemptAtMilliseconds)
    #expect(!after.isTerminalFailure)
    #expect(try await store.pendingOutboxCount(accountID: accountID) == 1)
  }

  @Test("Dead-letter status survives a disk-store relaunch")
  func permanentFailureSurvivesRelaunch() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    try await writePermanentFailureStore(at: paths.store)

    let container = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: container)
    let status = try await store.outboxStatus(accountID: PersistenceTestSupport.aliceID)
    #expect(status.queued == 1)
    #expect(status.terminalFailures == 1)
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == PersistenceTestSupport.guestGameID)

    let calls = DeliveryCollector()
    let coordinator = StatsOutboxCoordinator(store: store) { request in
      await calls.append(request.clientGameKey)
    }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    #expect(await coordinator.flush(force: true).attempted == 0)
    #expect(await coordinator.latestWarning?.kind == .statsNotSaved)
    #expect(await calls.values.isEmpty)
    let confirmedStatus = await coordinator.status()
    let recovered = await coordinator.retryTerminalHead(
      expectedRecoveryHandle: try #require(confirmedStatus.blockedHeadRecoveryHandle)
    )
    #expect(recovered.delivered == 1)
    #expect(recovered.pending == 0)
    #expect(await coordinator.latestWarning == nil)
    #expect(await coordinator.status() == .empty)
  }

  @Test("A corrupt disk head exposes an opaque handle after relaunch for confirmed discard")
  func corruptHeadRecoverySurvivesRelaunch() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    try writeCorruptOutboxStore(at: paths.store)

    let container = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: container)
    let coordinator = StatsOutboxCoordinator(store: store) { _ in
      Issue.record("A corrupt outbox body must not reach delivery")
    }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    let status = await coordinator.status()
    #expect(status.queued == 1)
    #expect(status.corruptRecords == 1)
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == PersistenceTestSupport.guestGameID)
    let recoveryHandle = try #require(status.blockedHeadRecoveryHandle)

    try await coordinator.discardBlockedHead(expectedRecoveryHandle: recoveryHandle)
    #expect(await coordinator.status() == .empty)
  }

  @Test("Malformed disk identifiers expose an opaque handle and cannot poison FIFO")
  func malformedIdentifierHeadIsRecoverable() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    try await writePoisonedFifoStore(at: paths.store, poison: .malformedIdentifiers)

    let container = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: container)
    let delivered = DeliveryCollector()
    let coordinator = StatsOutboxCoordinator(store: store) { request in
      await delivered.append(request.clientGameKey)
    }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    let status = await coordinator.status()
    #expect(status.queued == 2)
    #expect(status.corruptRecords == 1)
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == nil)
    let handle = try #require(status.blockedHeadRecoveryHandle)
    #expect(await coordinator.flush(force: true).attempted == 0)

    try await coordinator.discardBlockedHead(expectedRecoveryHandle: handle)
    let drained = await coordinator.flush(force: true)
    #expect(drained == StatsFlushResult(attempted: 1, delivered: 1, pending: 0, aborted: false))
    #expect(
      await delivered.values
        == [PersistenceTestSupport.secondGameID.uuidString.lowercased()]
    )
  }

  @Test("An Int.max disk attempt counter exposes an opaque handle and cannot poison FIFO")
  func excessiveAttemptHeadIsRecoverable() async throws {
    let paths = try PersistenceTestSupport.temporaryStoreURL()
    defer { try? FileManager.default.removeItem(at: paths.directory) }
    try await writePoisonedFifoStore(at: paths.store, poison: .excessiveAttempts)

    let container = try SkyjoPersistenceContainer.make(at: paths.store)
    let store = SoloPersistenceStore(modelContainer: container)
    let coordinator = StatsOutboxCoordinator(store: store) { _ in }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    let status = await coordinator.status()
    #expect(status.queued == 2)
    #expect(status.corruptRecords == 1)
    #expect(status.blockedByTerminalFailure)
    #expect(status.blockedHeadGameID == PersistenceTestSupport.guestGameID)
    let handle = try #require(status.blockedHeadRecoveryHandle)

    try await coordinator.discardBlockedHead(expectedRecoveryHandle: handle)
    #expect(await coordinator.flush(force: true).delivered == 1)
    #expect(await coordinator.status() == .empty)
  }

  @Test("Account switch invalidates a gated terminal retry before it mutates the old owner")
  func accountSwitchFencesTerminalRetry() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let normalStore = SoloPersistenceStore(modelContainer: container)
    try await makeTerminalHead(in: normalStore)

    let gate = AsyncPersistenceGate(checkpoint: .beforeOutboxRetryUpdate)
    let gatedStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(
        recoveryBarrier: { checkpoint in await gate.pause(at: checkpoint) }
      )
    )
    let coordinator = StatsOutboxCoordinator(store: gatedStore) { _ in
      Issue.record("The invalidated retry must not reach delivery")
    }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    let recoveryHandle = try #require(
      await coordinator.status().blockedHeadRecoveryHandle
    )
    let recovery = Task {
      await coordinator.retryTerminalHead(expectedRecoveryHandle: recoveryHandle)
    }
    await gate.waitUntilBlocked()
    await coordinator.setConfirmedAccount(PersistenceTestSupport.bobID)
    await gate.release()

    #expect(
      await recovery.value
        == StatsFlushResult(attempted: 0, delivered: 0, pending: 0, aborted: true)
    )
    let aliceStatus = try await normalStore.outboxStatus(accountID: PersistenceTestSupport.aliceID)
    #expect(aliceStatus.queued == 1)
    #expect(aliceStatus.terminalFailures == 1)
    #expect(aliceStatus.blockedByTerminalFailure)
    #expect(aliceStatus.blockedHeadGameID == PersistenceTestSupport.guestGameID)
    #expect(try await normalStore.outboxStatus(accountID: PersistenceTestSupport.bobID) == .empty)
  }

  @Test("Logout invalidates a gated blocked-head discard before deleting the old owner")
  func accountSwitchFencesBlockedDiscard() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let normalStore = SoloPersistenceStore(modelContainer: container)
    try await makeTerminalHead(in: normalStore)

    let gate = AsyncPersistenceGate(checkpoint: .beforeOutboxDelete)
    let gatedStore = SoloPersistenceStore(
      modelContainer: container,
      environment: SoloPersistenceEnvironment(
        recoveryBarrier: { checkpoint in await gate.pause(at: checkpoint) }
      )
    )
    let coordinator = StatsOutboxCoordinator(store: gatedStore) { _ in }
    await coordinator.setConfirmedAccount(PersistenceTestSupport.aliceID)
    let recoveryHandle = try #require(
      await coordinator.status().blockedHeadRecoveryHandle
    )
    let discard = Task { () -> SoloPersistenceError? in
      do {
        try await coordinator.discardBlockedHead(
          expectedRecoveryHandle: recoveryHandle
        )
        return nil
      } catch let error as SoloPersistenceError {
        return error
      } catch {
        return .storageUnavailable
      }
    }
    await gate.waitUntilBlocked()
    await coordinator.setConfirmedAccount(nil)
    await gate.release()

    #expect(await discard.value == .sessionConflict)
    let aliceStatus = try await normalStore.outboxStatus(accountID: PersistenceTestSupport.aliceID)
    #expect(aliceStatus.queued == 1)
    #expect(aliceStatus.terminalFailures == 1)
    #expect(aliceStatus.blockedByTerminalFailure)
    #expect(aliceStatus.blockedHeadGameID == PersistenceTestSupport.guestGameID)
  }

  @Test("A queued recovery capability cannot cross same-account reauthorization")
  func queuedRecoveryCannotCrossSameAccountReauthorization() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    try await makeTerminalHead(in: store)

    let gate = AsyncCoordinatorRecoveryGate()
    let coordinator = StatsOutboxCoordinator(
      store: store,
      environment: StatsOutboxCoordinatorEnvironment(
        recoveryBarrier: { checkpoint in await gate.pause(at: checkpoint) }
      )
    ) { _ in }
    let accountID = PersistenceTestSupport.aliceID
    await coordinator.setConfirmedAccount(accountID)
    let staleHandle = try #require(
      await coordinator.status().blockedHeadRecoveryHandle
    )
    let discard = Task { () -> SoloPersistenceError? in
      do {
        try await coordinator.discardBlockedHead(expectedRecoveryHandle: staleHandle)
        return nil
      } catch let error as SoloPersistenceError {
        return error
      } catch {
        return .storageUnavailable
      }
    }

    await gate.waitUntilBlocked()
    await coordinator.setConfirmedAccount(nil)
    await coordinator.setConfirmedAccount(accountID)
    let currentHandle = try #require(
      await coordinator.status().blockedHeadRecoveryHandle
    )
    #expect(currentHandle != staleHandle)
    await gate.release()

    #expect(await discard.value == .sessionConflict)
    let blockedStatus = try await store.outboxStatus(accountID: accountID)
    #expect(blockedStatus.queued == 1)
    #expect(blockedStatus.terminalFailures == 1)
    #expect(blockedStatus.blockedByTerminalFailure)

    try await coordinator.discardBlockedHead(expectedRecoveryHandle: currentHandle)
    #expect(try await store.outboxStatus(accountID: accountID) == .empty)
  }

  @Test("Recovery capabilities cannot cross coordinator instances")
  func recoveryCapabilitiesAreCoordinatorScoped() async throws {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    let store = SoloPersistenceStore(modelContainer: container)
    try await makeTerminalHead(in: store)
    let first = StatsOutboxCoordinator(store: store) { _ in }
    let second = StatsOutboxCoordinator(store: store) { _ in }
    let accountID = PersistenceTestSupport.aliceID
    await first.setConfirmedAccount(accountID)
    await second.setConfirmedAccount(accountID)
    let firstHandle = try #require(
      await first.status().blockedHeadRecoveryHandle
    )

    await expectStatsPersistenceError(.sessionConflict) {
      try await second.discardBlockedHead(expectedRecoveryHandle: firstHandle)
    }
    let secondHandle = try #require(
      await second.status().blockedHeadRecoveryHandle
    )
    #expect(secondHandle != firstHandle)
    try await second.discardBlockedHead(expectedRecoveryHandle: secondHandle)
    #expect(try await store.outboxStatus(accountID: accountID) == .empty)
  }

  @Test("Concurrent triggers share one flight and drain a queued trigger")
  func concurrentTriggersAreSingleFlight() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameID = PersistenceTestSupport.guestGameID
    try await store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      saveSequence: 0,
      completedAtMilliseconds: 10
    )
    let gate = SingleFlightDeliveryGate()
    let coordinator = StatsOutboxCoordinator(store: store) { request in
      try await gate.deliver(request)
    }
    await coordinator.setConfirmedAccount(accountID)
    let first = Task { await coordinator.flush(force: true) }
    await gate.waitUntilStarted()
    let second = Task { await coordinator.trigger(.foreground) }
    for _ in 0..<5 { await Task.yield() }
    await gate.release()
    _ = await first.value
    _ = await second.value
    #expect(await gate.calls == 1)
    #expect(try await store.pendingOutboxCount(accountID: accountID) == 0)
  }

  @Test("Scheduled retry replays an unknown transport failure with the same request")
  func scheduledRetrySucceeds() async throws {
    let (container, store) = try PersistenceTestSupport.store()
    _ = container
    let terminal = try PersistenceTestSupport.terminalState()
    let accountID = PersistenceTestSupport.aliceID
    let gameID = PersistenceTestSupport.guestGameID
    try await store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
      saveSequence: 0,
      completedAtMilliseconds: 10
    )
    let clock = AdvancingRetryClock(now: 100)
    let delivery = FailOnceDelivery()
    let coordinator = StatsOutboxCoordinator(
      store: store,
      environment: StatsOutboxCoordinatorEnvironment(
        nowMilliseconds: { clock.now() },
        sleep: { duration in try clock.advance(duration) }
      )
    ) { request in
      try await delivery.deliver(request)
    }
    await coordinator.setConfirmedAccount(accountID)
    #expect(await coordinator.flush(force: true).attempted == 1)
    for _ in 0..<100 {
      if try await store.pendingOutboxCount(accountID: accountID) == 0 { break }
      try await Task<Never, Never>.sleep(for: .milliseconds(1))
    }
    #expect(try await store.pendingOutboxCount(accountID: accountID) == 0)
    #expect(await delivery.calls == 2)
    #expect(await delivery.requests == [gameID.uuidString.lowercased(), gameID.uuidString.lowercased()])
  }
}
}

private actor DeliveryCollector {
  private(set) var values: [String] = []
  func append(_ value: String) { values.append(value) }
}

private actor RetrySleepProbe {
  private var duration: Duration?
  private var waiter: CheckedContinuation<Duration, Never>?

  func recordAndStop(_ value: Duration) throws {
    duration = value
    waiter?.resume(returning: value)
    waiter = nil
    throw CancellationError()
  }

  func waitForDuration() async -> Duration {
    if let duration { return duration }
    return await withCheckedContinuation { waiter = $0 }
  }
}

private actor AccountSwitchDeliveryGate {
  private let aliceKey: String
  private var aliceStarted = false
  private var startedWaiter: CheckedContinuation<Void, Never>?
  private var releaseWaiter: CheckedContinuation<Void, Never>?

  init(aliceID: UUID) {
    aliceKey = aliceID.uuidString.lowercased()
  }

  func deliver(_ request: StatsSubmissionRequest) async throws {
    guard request.expectedAccountUserId == aliceKey else { return }
    aliceStarted = true
    startedWaiter?.resume()
    startedWaiter = nil
    await withCheckedContinuation { releaseWaiter = $0 }
  }

  func waitUntilAliceStarted() async {
    if aliceStarted { return }
    await withCheckedContinuation { startedWaiter = $0 }
  }

  func releaseAlice() {
    releaseWaiter?.resume()
    releaseWaiter = nil
  }
}

private actor PermanentDeliveryProbe {
  private let aliceKey: String
  private(set) var aliceCalls = 0
  private var shouldFailAlice = true

  init(aliceID: UUID) {
    aliceKey = aliceID.uuidString.lowercased()
  }

  func deliver(_ request: StatsSubmissionRequest) throws {
    guard request.expectedAccountUserId == aliceKey else { return }
    aliceCalls += 1
    if shouldFailAlice { throw StatsDeliveryError.permanent(.requestTooLarge) }
  }

  func allowAliceSuccess() { shouldFailAlice = false }
}

private actor RetryInvocationProbe {
  private(set) var calls = 0
  func reject(_ duration: Duration) throws {
    _ = duration
    calls += 1
    throw CancellationError()
  }
}

private actor SingleFlightDeliveryGate {
  private(set) var calls = 0
  private var started = false
  private var startedWaiter: CheckedContinuation<Void, Never>?
  private var releaseWaiter: CheckedContinuation<Void, Never>?

  func deliver(_ request: StatsSubmissionRequest) async throws {
    _ = request
    calls += 1
    started = true
    startedWaiter?.resume()
    startedWaiter = nil
    await withCheckedContinuation { releaseWaiter = $0 }
  }

  func waitUntilStarted() async {
    if started { return }
    await withCheckedContinuation { startedWaiter = $0 }
  }

  func release() {
    releaseWaiter?.resume()
    releaseWaiter = nil
  }
}

private final class AdvancingRetryClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64

  init(now: Int64) { value = now }

  func now() -> Int64 {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func advance(_ duration: Duration) throws {
    _ = duration
    lock.lock()
    value = 1_100
    lock.unlock()
  }
}

private actor FailOnceDelivery {
  private(set) var calls = 0
  private(set) var requests: [String] = []

  func deliver(_ request: StatsSubmissionRequest) throws {
    calls += 1
    requests.append(request.clientGameKey)
    if calls == 1 { throw NSError(domain: NSURLErrorDomain, code: -1009) }
  }
}

private actor AsyncPersistenceGate {
  private let checkpoint: PersistenceCheckpoint
  private var isBlocked = false
  private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiter: CheckedContinuation<Void, Never>?

  init(checkpoint: PersistenceCheckpoint) {
    self.checkpoint = checkpoint
  }

  func pause(at candidate: PersistenceCheckpoint) async {
    guard candidate == checkpoint else { return }
    isBlocked = true
    for waiter in blockedWaiters { waiter.resume() }
    blockedWaiters.removeAll()
    await withCheckedContinuation { releaseWaiter = $0 }
  }

  func waitUntilBlocked() async {
    if isBlocked { return }
    await withCheckedContinuation { blockedWaiters.append($0) }
  }

  func release() {
    releaseWaiter?.resume()
    releaseWaiter = nil
  }
}

private actor AsyncCoordinatorRecoveryGate {
  private var shouldBlock = true
  private var isBlocked = false
  private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiter: CheckedContinuation<Void, Never>?

  func pause(at checkpoint: StatsOutboxCoordinatorCheckpoint) async {
    guard checkpoint == .beforeRecoveryAuthorization, shouldBlock else { return }
    shouldBlock = false
    isBlocked = true
    for waiter in blockedWaiters { waiter.resume() }
    blockedWaiters.removeAll()
    await withCheckedContinuation { releaseWaiter = $0 }
  }

  func waitUntilBlocked() async {
    if isBlocked { return }
    await withCheckedContinuation { blockedWaiters.append($0) }
  }

  func release() {
    releaseWaiter?.resume()
    releaseWaiter = nil
  }
}

private func expectStatsPersistenceError(
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

private func writePermanentFailureStore(at url: URL) async throws {
  let container = try SkyjoPersistenceContainer.make(at: url)
  let store = SoloPersistenceStore(modelContainer: container)
  let terminal = try PersistenceTestSupport.terminalState()
  let accountID = PersistenceTestSupport.aliceID
  let gameID = PersistenceTestSupport.guestGameID
  try await store.completeSession(
    owner: .account(accountID),
    gameID: gameID,
    state: terminal,
    setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
    saveSequence: 0,
    completedAtMilliseconds: 10
  )
  let coordinator = StatsOutboxCoordinator(store: store) { _ in
    throw StatsDeliveryError.permanent(.unsupportedVersion)
  }
  await coordinator.setConfirmedAccount(accountID)
  #expect(await coordinator.flush(force: true).attempted == 1)
  await coordinator.dispose()
}

private func makeTerminalHead(in store: SoloPersistenceStore) async throws {
  let terminal = try PersistenceTestSupport.terminalState()
  let accountID = PersistenceTestSupport.aliceID
  let gameID = PersistenceTestSupport.guestGameID
  try await store.completeSession(
    owner: .account(accountID),
    gameID: gameID,
    state: terminal,
    setup: try PersistenceTestSupport.setup(for: terminal, gameID: gameID),
    saveSequence: 0,
    completedAtMilliseconds: 10
  )
  let coordinator = StatsOutboxCoordinator(store: store) { _ in
    throw StatsDeliveryError.permanent(.invalidPayload)
  }
  await coordinator.setConfirmedAccount(accountID)
  #expect(await coordinator.flush(force: true).attempted == 1)
  await coordinator.dispose()
}

private func writeCorruptOutboxStore(at url: URL) throws {
  let container = try SkyjoPersistenceContainer.make(at: url)
  let context = ModelContext(container)
  context.autosaveEnabled = false
  context.insert(
    StatsOutboxRecord(
      recordID: UUID().uuidString.lowercased(),
      ownerKey: SoloOwnerPartition.account(PersistenceTestSupport.aliceID).storageKey,
      gameID: PersistenceTestSupport.guestGameID.uuidString.lowercased(),
      payloadVersion: 99,
      payload: Data("corrupt".utf8),
      attempts: 0,
      createdAtMilliseconds: 10,
      updatedAtMilliseconds: 10,
      nextAttemptAtMilliseconds: 10
    )
  )
  try context.save()
}

private enum PoisonedFifoHead {
  case malformedIdentifiers
  case excessiveAttempts
}

private func writePoisonedFifoStore(
  at url: URL,
  poison: PoisonedFifoHead
) async throws {
  let container = try SkyjoPersistenceContainer.make(at: url)
  let store = SoloPersistenceStore(modelContainer: container)
  let terminal = try PersistenceTestSupport.terminalState()
  let accountID = PersistenceTestSupport.aliceID
  let goodGameID = PersistenceTestSupport.secondGameID
  try await store.completeSession(
    owner: .account(accountID),
    gameID: goodGameID,
    state: terminal,
    setup: try PersistenceTestSupport.setup(for: terminal, gameID: goodGameID),
    saveSequence: 0,
    completedAtMilliseconds: 20
  )

  let recordID: String
  let gameID: String
  let payloadVersion: Int
  let payload: Data
  let attempts: Int
  switch poison {
  case .malformedIdentifiers:
    recordID = "malformed-record-id"
    gameID = "malformed-game-id"
    payloadVersion = 99
    payload = Data("corrupt".utf8)
    attempts = 0
  case .excessiveAttempts:
    let poisonGameID = PersistenceTestSupport.guestGameID
    let envelope = StatsSubmissionEnvelopeV1(
      accountID: accountID,
      gameID: poisonGameID,
      state: terminal,
      setup: try PersistenceTestSupport.setup(for: terminal, gameID: poisonGameID),
      completedAtMilliseconds: 10
    )
    recordID = UUID().uuidString.lowercased()
    gameID = poisonGameID.uuidString.lowercased()
    payloadVersion = PersistenceEnvelopeCodec.currentVersion
    payload = try PersistenceEnvelopeCodec.encode(envelope)
    attempts = Int.max
  }

  let context = ModelContext(container)
  context.autosaveEnabled = false
  context.insert(
    StatsOutboxRecord(
      recordID: recordID,
      ownerKey: SoloOwnerPartition.account(accountID).storageKey,
      gameID: gameID,
      payloadVersion: payloadVersion,
      payload: payload,
      attempts: attempts,
      createdAtMilliseconds: 10,
      updatedAtMilliseconds: 10,
      nextAttemptAtMilliseconds: 10
    )
  )
  try context.save()
}
