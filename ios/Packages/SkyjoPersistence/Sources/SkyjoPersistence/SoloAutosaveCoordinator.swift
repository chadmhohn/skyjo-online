import Foundation
import SkyjoDomain

/// Queues durable work after the pure reducer has already accepted a legal turn.
///
/// The coordinator never makes the in-memory game wait on SwiftData. Scene lifecycle hooks call
/// `bestEffortLifecycleFlush()` and may inspect `latestWarning` later; explicit tests or feature
/// models may await `flushPending()` when they need deterministic completion.
public actor SoloAutosaveCoordinator {
  private struct PendingSave: Sendable {
    let state: GameState
    let sequence: Int64
    let savedAtMilliseconds: Int64?
  }

  private let store: SoloPersistenceStore
  private let owner: SoloOwnerPartition
  private let gameID: UUID
  private let setup: SoloGameSetup
  private var pending: PendingSave?
  private var worker: Task<Void, Never>?
  private var highestSequence: Int64
  private var isCancelled = false

  public private(set) var latestWarning: SoloPersistenceWarning?
  public private(set) var latestPersistedSnapshot: SoloSessionSnapshot?

  public init(
    store: SoloPersistenceStore,
    owner: SoloOwnerPartition,
    gameID: UUID,
    setup: SoloGameSetup,
    initialSaveSequence: Int64
  ) {
    self.store = store
    self.owner = owner
    self.gameID = gameID
    self.setup = setup
    highestSequence = initialSaveSequence
  }

  /// Records an already-accepted turn and returns without awaiting storage.
  public func recordLegalTurn(
    state: GameState,
    saveSequence: Int64,
    savedAtMilliseconds: Int64? = nil
  ) {
    guard !isCancelled, saveSequence > highestSequence else { return }
    highestSequence = saveSequence
    pending = PendingSave(
      state: state,
      sequence: saveSequence,
      savedAtMilliseconds: savedAtMilliseconds
    )
    startWorkerIfNeeded()
  }

  /// Starts a best-effort flush suitable for background/termination callbacks and returns at once.
  public func bestEffortLifecycleFlush() {
    guard !isCancelled else { return }
    startWorkerIfNeeded()
  }

  /// Waits for the currently coalesced saves to settle. A warning is returned instead of throwing.
  @discardableResult
  public func flushPending() async -> SoloPersistenceWarning? {
    guard !isCancelled else { return latestWarning }
    startWorkerIfNeeded()
    let activeWorker = worker
    await activeWorker?.value
    return latestWarning
  }

  /// Permanently stops this game-scoped coordinator. Create a new instance for another game.
  public func cancel() {
    isCancelled = true
    pending = nil
    worker?.cancel()
    worker = nil
  }

  private func startWorkerIfNeeded() {
    guard !isCancelled, pending != nil, worker == nil else { return }
    worker = Task { [weak self] in
      await self?.drainPendingSaves()
    }
  }

  private func drainPendingSaves() async {
    while !Task.isCancelled, let candidate = pending {
      pending = nil
      do {
        let snapshot = try await store.autosave(
          owner: owner,
          gameID: gameID,
          state: candidate.state,
          setup: setup,
          saveSequence: candidate.sequence,
          savedAtMilliseconds: candidate.savedAtMilliseconds
        )
        guard !isCancelled else { break }
        latestPersistedSnapshot = snapshot
        latestWarning = nil
      } catch let error as SoloPersistenceError {
        guard !isCancelled else { break }
        if pending == nil || candidate.sequence > (pending?.sequence ?? Int64.min) {
          pending = candidate
        }
        latestWarning = error.warning
        break
      } catch {
        guard !isCancelled else { break }
        if pending == nil || candidate.sequence > (pending?.sequence ?? Int64.min) {
          pending = candidate
        }
        latestWarning = .unavailable
        break
      }
    }
    worker = nil
  }
}
