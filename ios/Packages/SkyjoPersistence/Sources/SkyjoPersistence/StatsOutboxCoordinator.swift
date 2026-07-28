import Foundation

public typealias StatsOutboxDelivery = @Sendable (StatsSubmissionRequest) async throws -> Void

public struct StatsOutboxCoordinatorEnvironment: Sendable {
  public var nowMilliseconds: @Sendable () -> Int64
  public var sleep: @Sendable (Duration) async throws -> Void

  public init(
    nowMilliseconds: @escaping @Sendable () -> Int64 = {
      Int64(Date().timeIntervalSince1970 * 1_000)
    },
    sleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task<Never, Never>.sleep(for: $0)
    }
  ) {
    self.nowMilliseconds = nowMilliseconds
    self.sleep = sleep
  }
}

/// Serializes stats delivery and fences every await with the confirmed account generation.
public actor StatsOutboxCoordinator {
  private let store: SoloPersistenceStore
  private let deliver: StatsOutboxDelivery
  private let environment: StatsOutboxCoordinatorEnvironment

  private var confirmedAccountID: UUID?
  private var accountGeneration: UInt64 = 0
  private var accountFence = StatsOutboxAccountFence()
  private var nextRunID: UInt64 = 0
  private var activeRunID: UInt64?
  private var activeTask: Task<StatsFlushResult, Never>?
  private var retryTask: Task<Void, Never>?
  private var queued = false
  private var queuedForce = false

  public private(set) var latestWarning: SoloPersistenceWarning?

  public init(
    store: SoloPersistenceStore,
    environment: StatsOutboxCoordinatorEnvironment = StatsOutboxCoordinatorEnvironment(),
    deliver: @escaping StatsOutboxDelivery
  ) {
    self.store = store
    self.environment = environment
    self.deliver = deliver
  }

  /// Only a currently confirmed account authorizes delivery. Offline owner hints never call this.
  public func setConfirmedAccount(_ accountID: UUID?) {
    guard confirmedAccountID != accountID else { return }
    accountFence.invalidate()
    accountFence = StatsOutboxAccountFence()
    confirmedAccountID = accountID
    accountGeneration &+= 1
    activeTask?.cancel()
    activeTask = nil
    activeRunID = nil
    retryTask?.cancel()
    retryTask = nil
    queued = false
    queuedForce = false
    latestWarning = nil
  }

  @discardableResult
  public func trigger(_ trigger: StatsOutboxTrigger) async -> StatsFlushResult {
    _ = trigger
    return await flush(force: false)
  }

  @discardableResult
  public func flush(force: Bool = false) async -> StatsFlushResult {
    guard let accountID = confirmedAccountID else { return .idle }
    let generation = accountGeneration
    if let activeTask, let activeRunID {
      queued = true
      queuedForce = queuedForce || force
      return await finish(
        activeTask,
        runID: activeRunID,
        accountID: accountID,
        generation: generation
      )
    }
    return await startRun(force: force)
  }

  public func dispose() {
    accountFence.invalidate()
    accountFence = StatsOutboxAccountFence()
    confirmedAccountID = nil
    accountGeneration &+= 1
    activeTask?.cancel()
    activeTask = nil
    activeRunID = nil
    retryTask?.cancel()
    retryTask = nil
    queued = false
    queuedForce = false
  }

  public func status() async -> StatsOutboxStatus {
    guard let accountID = confirmedAccountID else { return .empty }
    let generation = accountGeneration
    do {
      let status = try await store.outboxStatus(accountID: accountID)
      guard isCurrent(accountID: accountID, generation: generation) else { return .empty }
      return status
    } catch let error as SoloPersistenceError {
      guard isCurrent(accountID: accountID, generation: generation) else { return .empty }
      latestWarning = error.warning
      return .empty
    } catch {
      guard isCurrent(accountID: accountID, generation: generation) else { return .empty }
      latestWarning = .unavailable
      return .empty
    }
  }

  /// Reclassifies only the confirmed owner's exact terminal FIFO head, then retries its immutable body.
  public func retryTerminalHead(
    expectedRecoveryHandle: StatsOutboxRecoveryHandle
  ) async -> StatsFlushResult {
    guard let accountID = confirmedAccountID else { return .idle }
    let generation = accountGeneration
    let fence = accountFence
    guard isCurrent(accountID: accountID, generation: generation) else {
      return sanitizedAbortedResult
    }
    do {
      try await store.retryTerminalOutboxHead(
        accountID: accountID,
        expectedRecoveryHandle: expectedRecoveryHandle,
        nowMilliseconds: environment.nowMilliseconds(),
        accountFence: fence
      )
      guard isCurrent(accountID: accountID, generation: generation) else {
        return sanitizedAbortedResult
      }
      latestWarning = nil
      let result = await flush(force: true)
      guard isCurrent(accountID: accountID, generation: generation) else {
        return sanitizedAbortedResult
      }
      return result
    } catch let error as SoloPersistenceError {
      guard isCurrent(accountID: accountID, generation: generation) else {
        return sanitizedAbortedResult
      }
      latestWarning = error.warning
      return .idle
    } catch {
      guard isCurrent(accountID: accountID, generation: generation) else {
        return sanitizedAbortedResult
      }
      latestWarning = .unavailable
      return .idle
    }
  }

  /// Deletes a corrupt or terminal FIFO head only after the UI returns its opaque capability.
  public func discardBlockedHead(
    expectedRecoveryHandle: StatsOutboxRecoveryHandle
  ) async throws {
    guard let accountID = confirmedAccountID else {
      throw SoloPersistenceError.sessionConflict
    }
    let generation = accountGeneration
    let fence = accountFence
    guard isCurrent(accountID: accountID, generation: generation) else {
      throw SoloPersistenceError.sessionConflict
    }
    do {
      try await store.discardBlockedOutboxHead(
        accountID: accountID,
        expectedRecoveryHandle: expectedRecoveryHandle,
        accountFence: fence
      )
    } catch {
      guard isCurrent(accountID: accountID, generation: generation) else {
        throw SoloPersistenceError.sessionConflict
      }
      throw error
    }
    guard isCurrent(accountID: accountID, generation: generation) else {
      throw SoloPersistenceError.sessionConflict
    }
    latestWarning = nil
  }

  private func startRun(force: Bool) async -> StatsFlushResult {
    guard let accountID = confirmedAccountID else { return .idle }
    nextRunID &+= 1
    let runID = nextRunID
    let generation = accountGeneration
    let fence = accountFence
    let task = Task { [weak self] in
      guard let self else { return StatsFlushResult.idle }
      return await self.runFlush(
        accountID: accountID,
        generation: generation,
        accountFence: fence,
        force: force
      )
    }
    activeRunID = runID
    activeTask = task
    return await finish(
      task,
      runID: runID,
      accountID: accountID,
      generation: generation
    )
  }

  private func finish(
    _ task: Task<StatsFlushResult, Never>,
    runID: UInt64,
    accountID: UUID,
    generation: UInt64
  ) async -> StatsFlushResult {
    let result = await task.value
    guard isCurrent(accountID: accountID, generation: generation) else {
      return sanitizedAbortedResult
    }
    guard activeRunID == runID else { return result }
    activeTask = nil
    activeRunID = nil

    guard queued, confirmedAccountID != nil else { return result }
    let force = queuedForce
    queued = false
    queuedForce = false
    return await startRun(force: force)
  }

  private func runFlush(
    accountID: UUID,
    generation: UInt64,
    accountFence: StatsOutboxAccountFence,
    force: Bool
  ) async -> StatsFlushResult {
    guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
      return sanitizedAbortedResult
    }

    let now = environment.nowMilliseconds()
    let items: [StatsOutboxItem]
    do {
      items = try await store.eligibleOutboxItems(
        accountID: accountID,
        nowMilliseconds: now,
        force: force,
        limit: 4
      )
      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
    } catch let error as SoloPersistenceError {
      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
      latestWarning = error.warning
      return .idle
    } catch {
      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
      latestWarning = .unavailable
      return .idle
    }

    if items.isEmpty {
      let status = (try? await store.outboxStatus(accountID: accountID)) ?? .empty
      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
      if status.blockedByTerminalFailure {
        latestWarning = .statsNotSaved
      } else if latestWarning?.kind == .statsNotSaved {
        latestWarning = nil
      }
      if status.queued > 0, !status.blockedByTerminalFailure {
        let head = try? await store.eligibleOutboxItems(
           accountID: accountID,
           nowMilliseconds: now,
           force: true,
           limit: 1
         ).first
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        if let head {
          scheduleRetry(
            atMilliseconds: head.nextAttemptAtMilliseconds,
            accountID: accountID,
            generation: generation
          )
        }
      }
      return StatsFlushResult(
        attempted: 0,
        delivered: 0,
        pending: status.queued,
        aborted: false
      )
    }

    var attempted = 0
    var deliveredCount = 0
    for item in items {
      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
      attempted += 1
      do {
        try await deliver(item.request)
      } catch {
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        if case let StatsDeliveryError.permanent(category) = error {
          do {
            try await store.markOutboxTerminalFailure(
              item,
              category: category,
              nowMilliseconds: environment.nowMilliseconds(),
              accountFence: accountFence
            )
            guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
              return sanitizedAbortedResult
            }
            latestWarning = .statsNotSaved
          } catch let persistenceError as SoloPersistenceError {
            guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
              return sanitizedAbortedResult
            }
            latestWarning = persistenceError.warning
          } catch {
            guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
              return sanitizedAbortedResult
            }
            latestWarning = .unavailable
          }
        } else {
          let category: StatsFailureCategory
          if case let StatsDeliveryError.retryable(value) = error {
            category = value
          } else {
            category = .transport
          }
          do {
            if let nextAttempt = try await store.markOutboxFailed(
              item,
              category: category,
              nowMilliseconds: environment.nowMilliseconds(),
              accountFence: accountFence
            ) {
              guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
                return sanitizedAbortedResult
              }
              scheduleRetry(
                atMilliseconds: nextAttempt,
                accountID: accountID,
                generation: generation
              )
            }
          } catch let persistenceError as SoloPersistenceError {
            guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
              return sanitizedAbortedResult
            }
            latestWarning = persistenceError.warning
          } catch {
            guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
              return sanitizedAbortedResult
            }
            latestWarning = .unavailable
          }
        }
        let pending = (try? await store.pendingOutboxCount(accountID: accountID)) ?? 0
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        return StatsFlushResult(
          attempted: attempted,
          delivered: deliveredCount,
          pending: pending,
          aborted: false
        )
      }

      guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
        return sanitizedAbortedResult
      }
      do {
        try await store.markOutboxDelivered(item, accountFence: accountFence)
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        deliveredCount += 1
        latestWarning = nil
      } catch let error as SoloPersistenceError {
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        latestWarning = error.warning
        break
      } catch {
        guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
          return sanitizedAbortedResult
        }
        latestWarning = .unavailable
        break
      }
    }

    let pending = (try? await store.pendingOutboxCount(accountID: accountID)) ?? 0
    guard isCurrent(accountID: accountID, generation: generation), !Task.isCancelled else {
      return sanitizedAbortedResult
    }
    return StatsFlushResult(
      attempted: attempted,
      delivered: deliveredCount,
      pending: pending,
      aborted: false
    )
  }

  private var sanitizedAbortedResult: StatsFlushResult {
    StatsFlushResult(attempted: 0, delivered: 0, pending: 0, aborted: true)
  }

  private func isCurrent(accountID: UUID, generation: UInt64) -> Bool {
    confirmedAccountID == accountID && accountGeneration == generation
  }

  private func scheduleRetry(
    atMilliseconds target: Int64,
    accountID: UUID,
    generation: UInt64
  ) {
    guard isCurrent(accountID: accountID, generation: generation) else { return }
    retryTask?.cancel()
    let delay = max(target - environment.nowMilliseconds(), 0)
    let sleep = environment.sleep
    retryTask = Task { [weak self] in
      do {
        try await sleep(.milliseconds(delay))
      } catch {
        return
      }
      guard !Task.isCancelled, let self else { return }
      await self.fireScheduledRetry(accountID: accountID, generation: generation)
    }
  }

  private func fireScheduledRetry(accountID: UUID, generation: UInt64) async {
    guard isCurrent(accountID: accountID, generation: generation) else { return }
    retryTask = nil
    _ = await flush(force: false)
  }
}
