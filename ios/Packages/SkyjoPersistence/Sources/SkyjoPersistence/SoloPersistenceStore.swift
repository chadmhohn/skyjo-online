import Foundation
import SkyjoDomain
import SwiftData

public actor SoloPersistenceStore: ModelActor {
  public nonisolated let modelExecutor: any ModelExecutor
  public nonisolated let modelContainer: ModelContainer

  private let environment: SoloPersistenceEnvironment
  private var recoveryHandles: [PersistentIdentifier: StatsOutboxRecoveryHandle] = [:]

  public init(
    modelContainer: ModelContainer,
    environment: SoloPersistenceEnvironment = SoloPersistenceEnvironment()
  ) {
    let context = ModelContext(modelContainer)
    context.autosaveEnabled = false
    self.modelContainer = modelContainer
    modelExecutor = DefaultSerialModelExecutor(modelContext: context)
    self.environment = environment
  }

  public func loadSession(for owner: SoloOwnerPartition) throws -> SoloSessionLoadResult {
    do {
      try environment.faults.check(.beforeSessionRead)
      let records = try sessionRecords(ownerKey: owner.storageKey)
      guard !records.isEmpty else {
        return SoloSessionLoadResult(session: nil, warning: nil)
      }

      var selected: SoloSessionSnapshot?
      var recordsToDelete: [SoloSessionRecord] = []
      for record in records {
        do {
          let candidate = try decodeSession(record, expectedOwner: owner)
          guard candidate.state.phase != .gameOver, selected == nil else {
            recordsToDelete.append(record)
            continue
          }
          selected = candidate
        } catch {
          recordsToDelete.append(record)
        }
      }

      let hadDeletions = !recordsToDelete.isEmpty
      if hadDeletions {
        try modelContext.transaction {
          for record in recordsToDelete { modelContext.delete(record) }
        }
      }

      let warning: SoloPersistenceWarning? = hadDeletions
        ? (selected == nil ? .discarded : .recovered)
        : nil
      return SoloSessionLoadResult(session: selected, warning: warning)
    } catch let error as SoloPersistenceError {
      throw error
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  @discardableResult
  public func startSession(
    owner: SoloOwnerPartition,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    saveSequence: Int64 = 0,
    savedAtMilliseconds: Int64? = nil
  ) throws -> SoloSessionSnapshot {
    let snapshot = try preparedSession(
      owner: owner,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: saveSequence,
      savedAtMilliseconds: savedAtMilliseconds
    )
    let payload = try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))

    do {
      try environment.faults.check(.beforeTransaction)
      try modelContext.transaction {
        guard try sessionRecords(ownerKey: owner.storageKey).isEmpty else {
          throw SoloPersistenceError.sessionConflict
        }
        modelContext.insert(makeSessionRecord(snapshot: snapshot, payload: payload))
        try environment.faults.check(.afterNewSessionInsert)
        try environment.faults.check(.beforeCommit)
      }
      try environment.faults.check(.afterCommitAcknowledgement)
      return snapshot
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  @discardableResult
  public func replaceSession(
    owner: SoloOwnerPartition,
    expectedGameID: UUID,
    newGameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    saveSequence: Int64 = 0,
    savedAtMilliseconds: Int64? = nil
  ) throws -> SoloSessionSnapshot {
    guard expectedGameID != newGameID else { throw SoloPersistenceError.invalidSnapshot }
    let snapshot = try preparedSession(
      owner: owner,
      gameID: newGameID,
      state: state,
      setup: setup,
      saveSequence: saveSequence,
      savedAtMilliseconds: savedAtMilliseconds
    )
    let payload = try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))
    let expectedGameKey = expectedGameID.uuidString.lowercased()

    do {
      try environment.faults.check(.beforeTransaction)
      try modelContext.transaction {
        let existing = try sessionRecords(ownerKey: owner.storageKey)
        guard existing.contains(where: { $0.gameID == expectedGameKey }) else {
          throw SoloPersistenceError.sessionConflict
        }
        modelContext.insert(makeSessionRecord(snapshot: snapshot, payload: payload))
        try environment.faults.check(.afterNewSessionInsert)
        for record in existing { modelContext.delete(record) }
        try environment.faults.check(.afterPriorSessionDelete)
        try environment.faults.check(.beforeCommit)
      }
      try environment.faults.check(.afterCommitAcknowledgement)
      return snapshot
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  @discardableResult
  public func autosave(
    owner: SoloOwnerPartition,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    saveSequence: Int64,
    savedAtMilliseconds: Int64? = nil
  ) throws -> SoloSessionSnapshot {
    let snapshot = try preparedSession(
      owner: owner,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: saveSequence,
      savedAtMilliseconds: savedAtMilliseconds
    )
    let payload = try PersistenceEnvelopeCodec.encode(SoloSnapshotEnvelopeV1(snapshot: snapshot))
    let gameKey = gameID.uuidString.lowercased()
    var result = snapshot

    do {
      try environment.faults.check(.beforeTransaction)
      try modelContext.transaction {
        let existing = try sessionRecords(ownerKey: owner.storageKey)
        guard !existing.isEmpty else { throw SoloPersistenceError.missingSession }
        guard existing.allSatisfy({ $0.gameID == gameKey }), let record = existing.first else {
          throw SoloPersistenceError.sessionConflict
        }
        let persisted = try decodeSession(record, expectedOwner: owner)
        if saveSequence < persisted.saveSequence {
          throw SoloPersistenceError.staleAutosave
        }
        if saveSequence == persisted.saveSequence {
          guard state == persisted.state, setup == persisted.setup else {
            throw SoloPersistenceError.staleAutosave
          }
          result = persisted
          return
        }
        record.payloadVersion = PersistenceEnvelopeCodec.currentVersion
        record.payload = payload
        record.updatedAtMilliseconds = snapshot.savedAtMilliseconds
        record.saveSequence = snapshot.saveSequence
        try environment.faults.check(.beforeCommit)
      }
      try environment.faults.check(.afterCommitAcknowledgement)
      return result
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  public func completeSession(
    owner: SoloOwnerPartition,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    saveSequence: Int64,
    completedAtMilliseconds: Int64? = nil
  ) throws {
    let completionTime = completedAtMilliseconds ?? environment.nowMilliseconds()
    guard saveSequence >= 0,
          saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          completionTime > 0,
          completionTime <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          state.phase == .gameOver
    else {
      throw SoloPersistenceError.invalidSnapshot
    }
    do {
      try SoloGameStateValidator.validate(state, setup: setup, gameID: gameID)
    } catch {
      throw SoloPersistenceError.invalidSnapshot
    }

    let gameKey = gameID.uuidString.lowercased()
    do {
      try environment.faults.check(.beforeTransaction)
      try modelContext.transaction {
        let sessions = try sessionRecords(ownerKey: owner.storageKey)
        if sessions.contains(where: { $0.gameID != gameKey }) {
          throw SoloPersistenceError.sessionConflict
        }
        if let session = sessions.first {
          let persisted = try decodeSession(session, expectedOwner: owner)
          let sameRoster = persisted.state.players.count == state.players.count
            && zip(persisted.state.players, state.players).allSatisfy { previous, completed in
              previous.id == completed.id
                && previous.name == completed.name
                && previous.kind == completed.kind
            }
          guard saveSequence > persisted.saveSequence,
                persisted.setup == setup,
                sameRoster
          else {
            throw SoloPersistenceError.staleAutosave
          }
        }

        if case let .account(accountID) = owner {
          let outbox = try outboxRecords(ownerKey: owner.storageKey).first { $0.gameID == gameKey }
          if let outbox {
            let existing = try decodeOutbox(outbox, expectedAccountID: accountID)
            // A transaction may commit even when its acknowledgement is interrupted. A retry
            // must preserve the first immutable request (including its original completedAt)
            // while accepting the same logical completion with a newly sampled clock value.
            guard existing.request.state == state, existing.setup == setup else {
              throw SoloPersistenceError.sessionConflict
            }
          } else {
            let envelope = StatsSubmissionEnvelopeV1(
              accountID: accountID,
              gameID: gameID,
              state: state,
              setup: setup,
              completedAtMilliseconds: completionTime
            )
            let payload = try PersistenceEnvelopeCodec.encode(envelope)
            let recordID = environment.makeUUID().uuidString.lowercased()
            modelContext.insert(
              StatsOutboxRecord(
                recordID: recordID,
                ownerKey: owner.storageKey,
                gameID: gameKey,
                payloadVersion: PersistenceEnvelopeCodec.currentVersion,
                payload: payload,
                attempts: 0,
                createdAtMilliseconds: completionTime,
                updatedAtMilliseconds: completionTime,
                nextAttemptAtMilliseconds: completionTime
              )
            )
            try environment.faults.check(.afterOutboxInsert)
          }
        }

        for session in sessions { modelContext.delete(session) }
        try environment.faults.check(.afterPriorSessionDelete)
        try environment.faults.check(.beforeCommit)
      }
      try environment.faults.check(.afterCommitAcknowledgement)
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  public func deleteSession(owner: SoloOwnerPartition, expectedGameID: UUID) throws {
    let gameKey = expectedGameID.uuidString.lowercased()
    do {
      try modelContext.transaction {
        let records = try sessionRecords(ownerKey: owner.storageKey)
        guard records.allSatisfy({ $0.gameID == gameKey }) else {
          throw SoloPersistenceError.sessionConflict
        }
        for record in records { modelContext.delete(record) }
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  /// Removes every device-local save and undelivered stats item owned by an
  /// account after the server has confirmed permanent account deletion.
  public func deleteAccountData(accountID: UUID) throws {
    let ownerKey = SoloOwnerPartition.account(accountID).storageKey
    do {
      try modelContext.transaction {
        for record in try sessionRecords(ownerKey: ownerKey) {
          modelContext.delete(record)
        }
        for record in try outboxRecords(ownerKey: ownerKey) {
          recoveryHandles.removeValue(forKey: record.persistentModelID)
          modelContext.delete(record)
        }
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func eligibleOutboxItems(
    accountID: UUID,
    nowMilliseconds: Int64,
    force: Bool,
    limit: Int
  ) throws -> [StatsOutboxItem] {
    let owner = SoloOwnerPartition.account(accountID)
    do {
      let records = try outboxRecords(ownerKey: owner.storageKey)
      var valid: [StatsOutboxItem] = []
      for record in records {
        do {
          valid.append(try decodeOutbox(record, expectedAccountID: accountID))
        } catch {
          // A corrupt FIFO row remains as a safe, owner-scoped blocker until explicit recovery.
          break
        }
      }

      let deliveryLimit = min(max(limit, 1), 4)
      var eligible: [StatsOutboxItem] = []
      for item in valid {
        guard eligible.count < deliveryLimit else { break }
        guard !item.isTerminalFailure else { break }
        guard force || item.nextAttemptAtMilliseconds <= nowMilliseconds else { break }
        eligible.append(item)
      }
      return eligible
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func pendingOutboxCount(accountID: UUID) throws -> Int {
    let ownerKey = SoloOwnerPartition.account(accountID).storageKey
    do {
      return try outboxRecords(ownerKey: ownerKey).count
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  public func outboxStatus(accountID: UUID) throws -> StatsOutboxStatus {
    let ownerKey = SoloOwnerPartition.account(accountID).storageKey
    do {
      try environment.faults.check(.beforeOutboxRead)
      let records = try outboxRecords(ownerKey: ownerKey)
      var valid: [StatsOutboxItem] = []
      var corruptRecords = 0
      for record in records {
        do {
          valid.append(try decodeOutbox(record, expectedAccountID: accountID))
        } catch {
          corruptRecords += 1
        }
      }
      let terminalFailures = valid.filter(\.isTerminalFailure).count
      let firstIsCorrupt: Bool
      if let first = records.first {
        firstIsCorrupt = (try? decodeOutbox(first, expectedAccountID: accountID)) == nil
      } else {
        firstIsCorrupt = false
      }
      let blocked = firstIsCorrupt || valid.first?.isTerminalFailure == true
      let blockedHeadGameID = blocked
        ? records.first.flatMap { canonicalUUID($0.gameID) }
        : nil
      let blockedHeadRecoveryHandle = blocked
        ? records.first.map { recoveryHandle(for: $0) }
        : nil
      let blockedHeadKind: StatsOutboxBlockedHeadKind? = if firstIsCorrupt {
        .corrupt
      } else if valid.first?.isTerminalFailure == true {
        .terminal
      } else {
        nil
      }
      return StatsOutboxStatus(
        queued: records.count,
        terminalFailures: terminalFailures,
        corruptRecords: corruptRecords,
        blockedByTerminalFailure: blocked,
        blockedHeadGameID: blockedHeadGameID,
        blockedHeadRecoveryHandle: blockedHeadRecoveryHandle,
        blockedHeadKind: blockedHeadKind
      )
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func markOutboxDelivered(
    _ item: StatsOutboxItem,
    accountFence: StatsOutboxAccountFence? = nil
  ) throws {
    do {
      try environment.faults.check(.beforeOutboxDelete)
      let deletion = {
        try self.modelContext.transaction {
          guard let record = try self.exactOutboxRecord(item) else { return }
          self.recoveryHandles.removeValue(forKey: record.persistentModelID)
          self.modelContext.delete(record)
        }
      }
      if let accountFence {
        try accountFence.perform(deletion)
      } else {
        try deletion()
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  @discardableResult
  func markOutboxFailed(
    _ item: StatsOutboxItem,
    category: StatsFailureCategory,
    nowMilliseconds: Int64,
    accountFence: StatsOutboxAccountFence? = nil
  ) throws -> Int64? {
    guard nowMilliseconds > 0,
          nowMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
    else {
      throw SoloPersistenceError.storageUnavailable
    }
    do {
      try environment.faults.check(.beforeOutboxRetryUpdate)
      let update = { () throws -> Int64? in
        var nextAttempt: Int64?
        try self.modelContext.transaction {
          guard let record = try self.exactOutboxRecord(item) else { return }
          guard (0...PersistenceEnvelopeCodec.maximumOutboxAttempts).contains(record.attempts)
          else { throw SoloPersistenceError.incompatibleRecord }
          let attempts = record.attempts == PersistenceEnvelopeCodec.maximumOutboxAttempts
            ? record.attempts
            : record.attempts + 1
          let delay = Self.retryDelayMilliseconds(afterAttempts: attempts)
          let scheduled = nowMilliseconds.addingReportingOverflow(delay)
          record.attempts = attempts
          record.updatedAtMilliseconds = nowMilliseconds
          record.nextAttemptAtMilliseconds = scheduled.overflow
            ? PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
            : min(scheduled.partialValue, PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum)
          record.lastFailureCode = category.rawValue
          record.terminalFailure = false
          nextAttempt = record.nextAttemptAtMilliseconds
        }
        return nextAttempt
      }
      if let accountFence {
        return try accountFence.perform(update)
      } else {
        return try update()
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func markOutboxTerminalFailure(
    _ item: StatsOutboxItem,
    category: StatsFailureCategory,
    nowMilliseconds: Int64,
    accountFence: StatsOutboxAccountFence? = nil
  ) throws {
    guard nowMilliseconds > 0,
          nowMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
    else {
      throw SoloPersistenceError.storageUnavailable
    }
    do {
      try environment.faults.check(.beforeOutboxRetryUpdate)
      let update = {
        try self.modelContext.transaction {
          guard let record = try self.exactOutboxRecord(item) else { return }
          guard (0...PersistenceEnvelopeCodec.maximumOutboxAttempts).contains(record.attempts)
          else { throw SoloPersistenceError.incompatibleRecord }
          if record.attempts < PersistenceEnvelopeCodec.maximumOutboxAttempts {
            record.attempts += 1
          }
          record.updatedAtMilliseconds = nowMilliseconds
          record.lastFailureCode = category.rawValue
          record.terminalFailure = true
        }
      }
      if let accountFence {
        try accountFence.perform(update)
      } else {
        try update()
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func retryTerminalOutboxHead(
    accountID: UUID,
    expectedRecoveryHandle: StatsOutboxRecoveryHandle,
    nowMilliseconds: Int64
  ) async throws {
    try await retryTerminalOutboxHead(
      accountID: accountID,
      expectedRecoveryHandle: expectedRecoveryHandle,
      nowMilliseconds: nowMilliseconds,
      accountFence: nil
    )
  }

  func retryTerminalOutboxHead(
    accountID: UUID,
    expectedRecoveryHandle: StatsOutboxRecoveryHandle,
    nowMilliseconds: Int64,
    accountFence: StatsOutboxAccountFence?
  ) async throws {
    guard nowMilliseconds > 0,
          nowMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
    else {
      throw SoloPersistenceError.storageUnavailable
    }
    let ownerKey = SoloOwnerPartition.account(accountID).storageKey
    do {
      await environment.recoveryBarrier(.beforeOutboxRetryUpdate)
      try environment.faults.check(.beforeOutboxRetryUpdate)
      let update = {
        try self.modelContext.transaction {
          guard let head = try self.outboxRecords(ownerKey: ownerKey).first,
                self.recoveryHandle(for: head).matchesStoredToken(expectedRecoveryHandle),
                try self.decodeOutbox(head, expectedAccountID: accountID).isTerminalFailure
          else {
            throw SoloPersistenceError.sessionConflict
          }
          head.terminalFailure = false
          head.lastFailureCode = nil
          head.updatedAtMilliseconds = nowMilliseconds
          head.nextAttemptAtMilliseconds = nowMilliseconds
        }
      }
      if let accountFence {
        try accountFence.perform(update)
      } else {
        try update()
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

  func discardBlockedOutboxHead(
    accountID: UUID,
    expectedRecoveryHandle: StatsOutboxRecoveryHandle
  ) async throws {
    try await discardBlockedOutboxHead(
      accountID: accountID,
      expectedRecoveryHandle: expectedRecoveryHandle,
      accountFence: nil
    )
  }

  func discardBlockedOutboxHead(
    accountID: UUID,
    expectedRecoveryHandle: StatsOutboxRecoveryHandle,
    accountFence: StatsOutboxAccountFence?
  ) async throws {
    let ownerKey = SoloOwnerPartition.account(accountID).storageKey
    do {
      await environment.recoveryBarrier(.beforeOutboxDelete)
      try environment.faults.check(.beforeOutboxDelete)
      let deletion = {
        try self.modelContext.transaction {
          guard let head = try self.outboxRecords(ownerKey: ownerKey).first,
                self.recoveryHandle(for: head).matchesStoredToken(expectedRecoveryHandle)
          else {
            throw SoloPersistenceError.sessionConflict
          }
          let decoded = try? self.decodeOutbox(head, expectedAccountID: accountID)
          guard decoded == nil || decoded?.isTerminalFailure == true else {
            throw SoloPersistenceError.sessionConflict
          }
          self.recoveryHandles.removeValue(forKey: head.persistentModelID)
          self.modelContext.delete(head)
        }
      }
      if let accountFence {
        try accountFence.perform(deletion)
      } else {
        try deletion()
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }

#if DEBUG
  /// Builds a real blocked FIFO head for XCUITest. The fixture travels through the same
  /// envelope validation and opaque recovery-handle path as production data; only the final
  /// failure/corruption injection is test-only.
  public func prepareBlockedOutboxForUITesting(
    accountID: UUID,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    kind: StatsOutboxBlockedHeadKind,
    completedAtMilliseconds: Int64
  ) throws {
    let owner = SoloOwnerPartition.account(accountID)
    guard try outboxRecords(ownerKey: owner.storageKey).isEmpty else {
      throw SoloPersistenceError.sessionConflict
    }
    try completeSession(
      owner: owner,
      gameID: gameID,
      state: state,
      setup: setup,
      saveSequence: 0,
      completedAtMilliseconds: completedAtMilliseconds
    )

    do {
      try modelContext.transaction {
        guard let head = try self.outboxRecords(ownerKey: owner.storageKey).first else {
          throw SoloPersistenceError.sessionConflict
        }
        switch kind {
        case .terminal:
          head.attempts = 1
          head.updatedAtMilliseconds = completedAtMilliseconds
          head.lastFailureCode = StatsFailureCategory.unsupportedVersion.rawValue
          head.terminalFailure = true
        case .corrupt:
          head.payload = Data("skyjo-corrupt-ui-fixture".utf8)
          head.updatedAtMilliseconds = completedAtMilliseconds
        }
      }
    } catch {
      modelContext.rollback()
      throw mapStorageError(error)
    }
  }
#endif

  static func retryDelayMilliseconds(afterAttempts attempts: Int) -> Int64 {
    let exponent = min(max(attempts - 1, 0), 20)
    let uncapped = Int64(1_000).multipliedReportingOverflow(by: Int64(1) << exponent)
    return min(uncapped.overflow ? Int64.max : uncapped.partialValue, 5 * 60 * 1_000)
  }

  private func canonicalUUID(_ value: String) -> UUID? {
    guard value.utf8.count == 36,
          let id = UUID(uuidString: value),
          value == id.uuidString.lowercased()
    else {
      return nil
    }
    return id
  }

  private func preparedSession(
    owner: SoloOwnerPartition,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    saveSequence: Int64,
    savedAtMilliseconds: Int64?
  ) throws -> SoloSessionSnapshot {
    let timestamp = savedAtMilliseconds ?? environment.nowMilliseconds()
    guard saveSequence >= 0,
          saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          timestamp > 0,
          timestamp <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          state.phase != .gameOver
    else {
      throw SoloPersistenceError.invalidSnapshot
    }
    do {
      try SoloGameStateValidator.validate(state, setup: setup, gameID: gameID)
    } catch {
      throw SoloPersistenceError.invalidSnapshot
    }
    return SoloSessionSnapshot(
      owner: owner,
      gameID: gameID,
      saveSequence: saveSequence,
      state: state,
      setup: setup,
      savedAtMilliseconds: timestamp
    )
  }

  private func makeSessionRecord(snapshot: SoloSessionSnapshot, payload: Data) -> SoloSessionRecord {
    SoloSessionRecord(
      recordID: environment.makeUUID().uuidString.lowercased(),
      ownerKey: snapshot.owner.storageKey,
      gameID: snapshot.gameID.uuidString.lowercased(),
      payloadVersion: PersistenceEnvelopeCodec.currentVersion,
      payload: payload,
      updatedAtMilliseconds: snapshot.savedAtMilliseconds,
      saveSequence: snapshot.saveSequence
    )
  }

  private func sessionRecords(ownerKey: String) throws -> [SoloSessionRecord] {
    var descriptor = FetchDescriptor<SoloSessionRecord>(
      predicate: #Predicate { $0.ownerKey == ownerKey },
      sortBy: [
        SortDescriptor(\SoloSessionRecord.updatedAtMilliseconds, order: .reverse),
        SortDescriptor(\SoloSessionRecord.gameID, order: .reverse),
      ]
    )
    descriptor.includePendingChanges = true
    return try modelContext.fetch(descriptor)
  }

  private func outboxRecords(ownerKey: String) throws -> [StatsOutboxRecord] {
    var descriptor = FetchDescriptor<StatsOutboxRecord>(
      predicate: #Predicate { $0.ownerKey == ownerKey },
      sortBy: [
        SortDescriptor(\StatsOutboxRecord.createdAtMilliseconds),
        SortDescriptor(\StatsOutboxRecord.gameID),
      ]
    )
    descriptor.includePendingChanges = true
    return try modelContext.fetch(descriptor)
  }

  private func decodeSession(
    _ record: SoloSessionRecord,
    expectedOwner: SoloOwnerPartition
  ) throws -> SoloSessionSnapshot {
    guard record.payloadVersion == PersistenceEnvelopeCodec.currentVersion,
          record.ownerKey == expectedOwner.storageKey,
          let recordID = UUID(uuidString: record.recordID),
          record.recordID == recordID.uuidString.lowercased(),
          let recordGameID = UUID(uuidString: record.gameID),
          record.gameID == recordGameID.uuidString.lowercased(),
          record.saveSequence >= 0,
          record.saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          record.updatedAtMilliseconds > 0,
          record.updatedAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
    else {
      throw SoloPersistenceError.incompatibleRecord
    }
    let envelope = try PersistenceEnvelopeCodec.decode(SoloSnapshotEnvelopeV1.self, from: record.payload)
    guard let snapshot = envelope.snapshot,
          snapshot.owner == expectedOwner,
          snapshot.gameID == recordGameID,
          snapshot.saveSequence == record.saveSequence,
          snapshot.savedAtMilliseconds == record.updatedAtMilliseconds,
          snapshot.saveSequence >= 0,
          snapshot.saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          snapshot.savedAtMilliseconds > 0,
          snapshot.savedAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
    else {
      throw SoloPersistenceError.incompatibleRecord
    }
    do {
      try SoloGameStateValidator.validate(snapshot.state, setup: snapshot.setup, gameID: snapshot.gameID)
    } catch {
      throw SoloPersistenceError.incompatibleRecord
    }
    return snapshot
  }

  private func decodeOutbox(
    _ record: StatsOutboxRecord,
    expectedAccountID: UUID
  ) throws -> StatsOutboxItem {
    let expectedOwner = SoloOwnerPartition.account(expectedAccountID)
    guard record.payloadVersion == PersistenceEnvelopeCodec.currentVersion,
          record.ownerKey == expectedOwner.storageKey,
          let recordID = UUID(uuidString: record.recordID),
          record.recordID == recordID.uuidString.lowercased(),
          let gameID = UUID(uuidString: record.gameID),
          record.gameID == gameID.uuidString.lowercased(),
          (0...PersistenceEnvelopeCodec.maximumOutboxAttempts).contains(record.attempts),
          record.createdAtMilliseconds > 0,
          record.createdAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          record.updatedAtMilliseconds > 0,
          record.updatedAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          record.nextAttemptAtMilliseconds > 0,
          record.nextAttemptAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          record.lastFailureCode.map({ StatsFailureCategory(rawValue: $0) != nil }) ?? true,
          !record.terminalFailure || record.lastFailureCode != nil
    else {
      throw SoloPersistenceError.incompatibleRecord
    }
    let envelope = try PersistenceEnvelopeCodec.decode(StatsSubmissionEnvelopeV1.self, from: record.payload)
    guard envelope.version == PersistenceEnvelopeCodec.currentVersion,
          envelope.ownerKey == expectedOwner.storageKey,
          envelope.gameID == gameID,
          envelope.request.clientGameKey == gameID.uuidString.lowercased(),
          envelope.request.expectedAccountUserId == expectedAccountID.uuidString.lowercased(),
          envelope.request.completedAt > 0,
          envelope.request.completedAt <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          envelope.request.state.phase == .gameOver
    else {
      throw SoloPersistenceError.incompatibleRecord
    }
    do {
      try SoloGameStateValidator.validate(
        envelope.request.state,
        setup: envelope.setup,
        gameID: envelope.gameID
      )
    } catch {
      throw SoloPersistenceError.incompatibleRecord
    }
    return StatsOutboxItem(
      recordID: recordID,
      ownerID: expectedAccountID,
      gameID: gameID,
      envelopeData: record.payload,
      setup: envelope.setup,
      request: envelope.request,
      attempts: record.attempts,
      createdAtMilliseconds: record.createdAtMilliseconds,
      nextAttemptAtMilliseconds: record.nextAttemptAtMilliseconds,
      isTerminalFailure: record.terminalFailure
    )
  }

  private func exactOutboxRecord(_ item: StatsOutboxItem) throws -> StatsOutboxRecord? {
    let ownerKey = SoloOwnerPartition.account(item.ownerID).storageKey
    let recordID = item.recordID.uuidString.lowercased()
    let gameID = item.gameID.uuidString.lowercased()
    let records = try outboxRecords(ownerKey: ownerKey)
    guard let record = records.first(where: { $0.recordID == recordID && $0.gameID == gameID }),
          record.payload == item.envelopeData
    else {
      return nil
    }
    return record
  }

  private func recoveryHandle(for record: StatsOutboxRecord) -> StatsOutboxRecoveryHandle {
    let identifier = record.persistentModelID
    if let existing = recoveryHandles[identifier] { return existing }
    let handle = StatsOutboxRecoveryHandle(token: UUID())
    recoveryHandles[identifier] = handle
    return handle
  }

  private func mapStorageError(_ error: Error) -> SoloPersistenceError {
    if let persistenceError = error as? SoloPersistenceError { return persistenceError }
    let nsError = error as NSError
    if (nsError.domain == NSCocoaErrorDomain && nsError.code == CocoaError.fileWriteOutOfSpace.rawValue)
      || (nsError.domain == NSPOSIXErrorDomain && nsError.code == 28) {
      return .storageFull
    }
    return .storageUnavailable
  }
}
