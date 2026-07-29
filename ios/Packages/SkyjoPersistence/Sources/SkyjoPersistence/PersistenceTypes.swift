import Foundation
import SkyjoDomain

public enum SoloOwnerPartition: Codable, Equatable, Hashable, Sendable {
  case guest
  case account(UUID)

  public var accountID: UUID? {
    guard case let .account(id) = self else { return nil }
    return id
  }

  var storageKey: String {
    switch self {
    case .guest:
      return "guest"
    case let .account(id):
      return "account:\(id.uuidString.lowercased())"
    }
  }

  init?(storageKey: String) {
    if storageKey == "guest" {
      self = .guest
      return
    }
    let prefix = "account:"
    guard storageKey.hasPrefix(prefix),
          let id = UUID(uuidString: String(storageKey.dropFirst(prefix.count))),
          storageKey == "account:\(id.uuidString.lowercased())"
    else {
      return nil
    }
    self = .account(id)
  }
}

public struct SoloSessionSnapshot: Equatable, Sendable {
  public let owner: SoloOwnerPartition
  public let gameID: UUID
  public let saveSequence: Int64
  public let state: GameState
  public let setup: SoloGameSetup
  public let savedAtMilliseconds: Int64

  public init(
    owner: SoloOwnerPartition,
    gameID: UUID,
    saveSequence: Int64,
    state: GameState,
    setup: SoloGameSetup,
    savedAtMilliseconds: Int64
  ) {
    self.owner = owner
    self.gameID = gameID
    self.saveSequence = saveSequence
    self.state = state
    self.setup = setup
    self.savedAtMilliseconds = savedAtMilliseconds
  }
}

public enum SoloPersistenceWarningKind: String, Codable, Sendable {
  case conflict
  case quota
  case recovered
  case unavailable
  case statsNotSaved = "stats-not-saved"
}

public struct SoloPersistenceWarning: Equatable, Sendable {
  public let kind: SoloPersistenceWarningKind
  public let message: String

  public init(kind: SoloPersistenceWarningKind, message: String) {
    self.kind = kind
    self.message = message
  }

  static let recovered = SoloPersistenceWarning(
    kind: .recovered,
    message: "A saved game was damaged or created by an incompatible version. The newest usable game was recovered safely."
  )

  static let discarded = SoloPersistenceWarning(
    kind: .recovered,
    message: "A saved game was damaged or created by an incompatible version, so it was removed safely."
  )

  static let quota = SoloPersistenceWarning(
    kind: .quota,
    message: "This device is low on storage. You can keep playing, but this game may not restore after closing Skyjo."
  )

  static let unavailable = SoloPersistenceWarning(
    kind: .unavailable,
    message: "Saved games are unavailable on this device right now. You can keep playing normally."
  )

  static let conflict = SoloPersistenceWarning(
    kind: .conflict,
    message: "A newer saved game is already active. Your current game was left unchanged."
  )

  static let statsNotSaved = SoloPersistenceWarning(
    kind: .statsNotSaved,
    message: "This completed game could not be saved to account stats. It remains on this device for recovery."
  )
}

public struct SoloSessionLoadResult: Equatable, Sendable {
  public let session: SoloSessionSnapshot?
  public let warning: SoloPersistenceWarning?

  public init(session: SoloSessionSnapshot?, warning: SoloPersistenceWarning?) {
    self.session = session
    self.warning = warning
  }
}

public enum SoloPersistenceError: Error, Equatable, Sendable {
  case invalidSnapshot
  case missingSession
  case sessionConflict
  case staleAutosave
  case incompatibleRecord
  case storageFull
  case storageUnavailable
  case writeInterrupted

  public var warning: SoloPersistenceWarning {
    switch self {
    case .sessionConflict, .staleAutosave, .missingSession:
      return .conflict
    case .storageFull:
      return .quota
    case .invalidSnapshot, .incompatibleRecord, .storageUnavailable, .writeInterrupted:
      return .unavailable
    }
  }
}

public enum PersistenceCheckpoint: String, CaseIterable, Sendable {
  case beforeSessionRead
  case beforeTransaction
  case afterNewSessionInsert
  case afterPriorSessionDelete
  case afterOutboxInsert
  case beforeCommit
  case afterCommitAcknowledgement
  case beforeOutboxRead
  case beforeOutboxDelete
  case beforeOutboxRetryUpdate
}

public struct PersistenceFaultInjector: Sendable {
  private let operation: @Sendable (PersistenceCheckpoint) throws -> Void

  public init(operation: @escaping @Sendable (PersistenceCheckpoint) throws -> Void) {
    self.operation = operation
  }

  public func check(_ checkpoint: PersistenceCheckpoint) throws {
    try operation(checkpoint)
  }

  public static let none = PersistenceFaultInjector { _ in }

  public static func failing(
    at checkpoint: PersistenceCheckpoint,
    with error: any Error & Sendable = SoloPersistenceError.writeInterrupted
  ) -> PersistenceFaultInjector {
    PersistenceFaultInjector { candidate in
      if candidate == checkpoint { throw error }
    }
  }
}

public struct SoloPersistenceEnvironment: Sendable {
  public var nowMilliseconds: @Sendable () -> Int64
  public var makeUUID: @Sendable () -> UUID
  public var faults: PersistenceFaultInjector
  public var recoveryBarrier: @Sendable (PersistenceCheckpoint) async -> Void

  public init(
    nowMilliseconds: @escaping @Sendable () -> Int64 = {
      Int64(Date().timeIntervalSince1970 * 1_000)
    },
    makeUUID: @escaping @Sendable () -> UUID = UUID.init,
    faults: PersistenceFaultInjector = .none,
    recoveryBarrier: @escaping @Sendable (PersistenceCheckpoint) async -> Void = { _ in }
  ) {
    self.nowMilliseconds = nowMilliseconds
    self.makeUUID = makeUUID
    self.faults = faults
    self.recoveryBarrier = recoveryBarrier
  }
}

public struct StatsSubmissionRequest: Codable, Equatable, Sendable {
  public let state: GameState
  public let clientGameKey: String
  public let completedAt: Int64
  public let expectedAccountUserId: String

  init(state: GameState, gameID: UUID, completedAt: Int64, accountID: UUID) {
    self.state = state
    clientGameKey = gameID.uuidString.lowercased()
    self.completedAt = completedAt
    expectedAccountUserId = accountID.uuidString.lowercased()
  }
}

public enum StatsFailureCategory: String, Codable, CaseIterable, Sendable {
  case transport
  case server
  case unavailable
  case unknown
  case requestTooLarge = "request-too-large"
  case invalidPayload = "invalid-payload"
  case unsupportedVersion = "unsupported-version"
}

public enum StatsDeliveryError: Error, Equatable, Sendable {
  case retryable(StatsFailureCategory)
  case permanent(StatsFailureCategory)
  /// The live account/access session changed while a request was in flight. The queue remains
  /// untouched until the app confirms an account again; this is neither a payload failure nor a
  /// retryable transport failure.
  case authorizationChanged
}

/// An opaque capability for the exact blocked FIFO head. The coordinator additionally binds the
/// value to the account-authorization generation that exposed it to the UI. None of those tokens
/// are available as strings, identifiers, or persistence details; callers can only return the
/// complete value after confirming recovery with the user.
public struct StatsOutboxRecoveryHandle: Equatable, Hashable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible
{
  private let token: UUID
  private let authorizationScope: UUID?
  private let authorizationAccountID: UUID?
  private let authorizationGeneration: UInt64?

  init(token: UUID) {
    self.token = token
    authorizationScope = nil
    authorizationAccountID = nil
    authorizationGeneration = nil
  }

  private init(
    token: UUID,
    authorizationScope: UUID,
    authorizationAccountID: UUID,
    authorizationGeneration: UInt64
  ) {
    self.token = token
    self.authorizationScope = authorizationScope
    self.authorizationAccountID = authorizationAccountID
    self.authorizationGeneration = authorizationGeneration
  }

  func authorized(
    scope: UUID,
    accountID: UUID,
    generation: UInt64
  ) -> StatsOutboxRecoveryHandle {
    StatsOutboxRecoveryHandle(
      token: token,
      authorizationScope: scope,
      authorizationAccountID: accountID,
      authorizationGeneration: generation
    )
  }

  func authorizes(scope: UUID, accountID: UUID, generation: UInt64) -> Bool {
    authorizationScope == scope
      && authorizationAccountID == accountID
      && authorizationGeneration == generation
  }

  func matchesStoredToken(_ other: StatsOutboxRecoveryHandle) -> Bool {
    token == other.token
  }

  public var description: String { "StatsOutboxRecoveryHandle(redacted)" }
  public var debugDescription: String { description }
}

public enum StatsOutboxBlockedHeadKind: String, Equatable, Sendable {
  case terminal
  case corrupt
}

public struct StatsOutboxStatus: Equatable, Sendable {
  public let queued: Int
  public let terminalFailures: Int
  public let corruptRecords: Int
  public let blockedByTerminalFailure: Bool
  /// The canonical game identifier for the blocked FIFO head, when its safe metadata is readable.
  /// This intentionally exposes neither account metadata nor the persisted request body.
  public let blockedHeadGameID: UUID?
  /// Opaque capability required to retry or discard the exact currently blocked FIFO head.
  /// Unlike `blockedHeadGameID`, this remains available when persisted identifiers are corrupt.
  public let blockedHeadRecoveryHandle: StatsOutboxRecoveryHandle?
  /// Safe recovery classification for the FIFO head. Aggregate failure counts cannot determine
  /// which recovery action is valid for the first record.
  public let blockedHeadKind: StatsOutboxBlockedHeadKind?

  public init(
    queued: Int,
    terminalFailures: Int,
    corruptRecords: Int = 0,
    blockedByTerminalFailure: Bool,
    blockedHeadGameID: UUID? = nil,
    blockedHeadRecoveryHandle: StatsOutboxRecoveryHandle? = nil,
    blockedHeadKind: StatsOutboxBlockedHeadKind? = nil
  ) {
    self.queued = queued
    self.terminalFailures = terminalFailures
    self.corruptRecords = corruptRecords
    self.blockedByTerminalFailure = blockedByTerminalFailure
    self.blockedHeadGameID = blockedHeadGameID
    self.blockedHeadRecoveryHandle = blockedHeadRecoveryHandle
    self.blockedHeadKind = blockedHeadKind
  }

  static let empty = StatsOutboxStatus(
    queued: 0,
    terminalFailures: 0,
    corruptRecords: 0,
    blockedByTerminalFailure: false,
    blockedHeadGameID: nil,
    blockedHeadRecoveryHandle: nil,
    blockedHeadKind: nil
  )

  func authorizingRecoveryHandle(
    scope: UUID,
    accountID: UUID,
    generation: UInt64
  ) -> StatsOutboxStatus {
    guard let blockedHeadRecoveryHandle else { return self }
    return StatsOutboxStatus(
      queued: queued,
      terminalFailures: terminalFailures,
      corruptRecords: corruptRecords,
      blockedByTerminalFailure: blockedByTerminalFailure,
      blockedHeadGameID: blockedHeadGameID,
      blockedHeadRecoveryHandle: blockedHeadRecoveryHandle.authorized(
        scope: scope,
        accountID: accountID,
        generation: generation
      ),
      blockedHeadKind: blockedHeadKind
    )
  }
}

struct StatsOutboxAuthorizationLease: Sendable {
  let accountID: UUID
  let generation: UInt64
}

/// The synchronous source of truth for account-authorized outbox mutations.
///
/// Account transitions take the same lock that a persistence mutation holds for its transaction.
/// A transition therefore either revokes the lease before the mutation begins or waits until an
/// already-authorized mutation finishes. The generation prevents a stale task from restoring a
/// prior login for the same account UUID.
public final class StatsOutboxAuthorizationController: @unchecked Sendable {
  private let lock = NSLock()
  private var confirmedAccountID: UUID?
  private var generation: UInt64 = 0

  public init() {}

  public func setConfirmedAccount(_ accountID: UUID?) {
    lock.lock()
    defer { lock.unlock() }
    guard confirmedAccountID != accountID else { return }
    confirmedAccountID = accountID
    generation &+= 1
  }

  func currentLease() -> StatsOutboxAuthorizationLease? {
    lock.lock()
    defer { lock.unlock() }
    guard let accountID = confirmedAccountID else { return nil }
    return StatsOutboxAuthorizationLease(accountID: accountID, generation: generation)
  }

  func perform<T>(
    with lease: StatsOutboxAuthorizationLease,
    operation: () throws -> T
  ) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    guard confirmedAccountID == lease.accountID, generation == lease.generation else {
      throw SoloPersistenceError.sessionConflict
    }
    return try operation()
  }
}

/// A coordinator-local capability paired with the relay's exact account authorization lease.
/// The store holds both locks only around its synchronous SwiftData transaction.
final class StatsOutboxAccountFence: @unchecked Sendable {
  private let authorizationController: StatsOutboxAuthorizationController
  private let authorizationLease: StatsOutboxAuthorizationLease
  private let lock = NSLock()
  private var isValid = true

  init(
    authorizationController: StatsOutboxAuthorizationController,
    authorizationLease: StatsOutboxAuthorizationLease
  ) {
    self.authorizationController = authorizationController
    self.authorizationLease = authorizationLease
  }

  func invalidate() {
    lock.lock()
    isValid = false
    lock.unlock()
  }

  func perform<T>(_ operation: () throws -> T) throws -> T {
    try authorizationController.perform(with: authorizationLease) {
      lock.lock()
      defer { lock.unlock() }
      guard isValid else { throw SoloPersistenceError.sessionConflict }
      return try operation()
    }
  }

  func isCurrent() -> Bool {
    (try? authorizationController.perform(with: authorizationLease) {
      lock.lock()
      defer { lock.unlock() }
      return isValid
    }) ?? false
  }
}

public struct StatsFlushResult: Equatable, Sendable {
  public let attempted: Int
  public let delivered: Int
  public let pending: Int
  public let aborted: Bool

  public init(attempted: Int, delivered: Int, pending: Int, aborted: Bool) {
    self.attempted = attempted
    self.delivered = delivered
    self.pending = pending
    self.aborted = aborted
  }

  static let idle = StatsFlushResult(attempted: 0, delivered: 0, pending: 0, aborted: false)
}

public enum StatsOutboxTrigger: Sendable {
  case launch
  case signIn
  case connectivityRestored
  case foreground
  case completion
  case scheduledRetry
}
