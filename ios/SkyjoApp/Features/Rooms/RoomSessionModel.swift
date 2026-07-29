import Foundation
import Observation
import SkyjoDomain
import SkyjoNetworking

enum RoomDrawChoice: String, CaseIterable, Identifiable {
  case place = "Place"
  case discardAndReveal = "Discard & Reveal"

  var id: Self { self }
}

struct RoomBanner: Equatable, Identifiable {
  enum Tone: Equatable {
    case information
    case warning
    case error
  }

  let id = UUID()
  let title: String
  let message: String
  let tone: Tone
  let survivesAuthoritativeSnapshot: Bool

  init(
    title: String,
    message: String,
    tone: Tone,
    survivesAuthoritativeSnapshot: Bool = false
  ) {
    self.title = title
    self.message = message
    self.tone = tone
    self.survivesAuthoritativeSnapshot = survivesAuthoritativeSnapshot
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.title == rhs.title
      && lhs.message == rhs.message
      && lhs.tone == rhs.tone
      && lhs.survivesAuthoritativeSnapshot == rhs.survivesAuthoritativeSnapshot
  }
}

protocol RoomSessionConnection: Sendable {
  func events() async -> AsyncStream<RoomConnectionEvent>
  func currentAuthoritativeSnapshot() async -> AuthoritativeRoomSnapshot?
  func recoverPersistedReset() async throws -> Bool
  func connect(_ admission: RoomAdmission) async throws
  func recover(_ admission: RoomAdmission) async throws
  func send(_ action: RoomCommandAction) async throws -> UUID
  func setVisible(_ visible: Bool) async
  func resume() async
  func disconnect() async throws
  func discardPersistedResetRecovery() async throws
  func dispose() async
}

extension RoomConnection: RoomSessionConnection {
  func currentAuthoritativeSnapshot() -> AuthoritativeRoomSnapshot? { snapshot() }
}

struct RoomSessionEnvironment: Sendable {
  let makeConnection: @Sendable () async throws -> any RoomSessionConnection
  let createInvite: @Sendable (String) async throws -> NativeRoomInvite
  let seatStore: any RoomSeatRecoveryStore
  let nowMilliseconds: @Sendable () -> Int64

  init(
    makeConnection: @escaping @Sendable () async throws -> any RoomSessionConnection,
    createInvite: @escaping @Sendable (String) async throws -> NativeRoomInvite,
    seatStore: any RoomSeatRecoveryStore,
    nowMilliseconds: @escaping @Sendable () -> Int64
  ) {
    self.makeConnection = makeConnection
    self.createInvite = createInvite
    self.seatStore = SerializedRoomSeatRecoveryStore(base: seatStore)
    self.nowMilliseconds = nowMilliseconds
  }

  static func live(
    apiClient: SkyjoAPIClient,
    inviteClient: RoomInviteClient,
    account: AccountUser,
    seatStore: any RoomSeatRecoveryStore = FileRoomSeatRecoveryStore.applicationSupportStore()
  ) -> Self {
    Self(
      makeConnection: {
        try await apiClient.makeRoomConnection(confirmedAccount: account)
      },
      createInvite: { roomCode in
        try await inviteClient.create(roomCode: roomCode)
      },
      seatStore: seatStore,
      nowMilliseconds: { Int64(Date().timeIntervalSince1970 * 1_000) }
    )
  }
}

/// Serializes the async recovery-store protocol even when a test or future store
/// suspends internally. Explicit forget/terminal cleanup therefore cannot race an
/// older snapshot save and resurrect or erase routing state out of order.
private actor SerializedRoomSeatRecoveryStore: RoomSeatRecoveryStore {
  private let base: any RoomSeatRecoveryStore
  private var isLocked = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  init(base: any RoomSeatRecoveryStore) {
    self.base = base
  }

  func load(accountID: UUID) async throws -> RoomSeatRecoveryRecord? {
    await acquire()
    do {
      let record = try await base.load(accountID: accountID)
      release()
      return record
    } catch {
      release()
      throw error
    }
  }

  func save(_ record: RoomSeatRecoveryRecord) async throws {
    await acquire()
    do {
      try await base.save(record)
      release()
    } catch {
      release()
      throw error
    }
  }

  func clear(accountID: UUID) async throws {
    await acquire()
    do {
      try await base.clear(accountID: accountID)
      release()
    } catch {
      release()
      throw error
    }
  }

  private func acquire() async {
    if !isLocked {
      isLocked = true
      return
    }
    await withCheckedContinuation { waiters.append($0) }
  }

  private func release() {
    guard !waiters.isEmpty else {
      isLocked = false
      return
    }
    waiters.removeFirst().resume()
  }
}

/// Owns the account-scoped room model across navigation while fencing account switches.
/// A new authenticated account never inherits the prior account's socket or saved seat.
@MainActor
@Observable
final class RoomSessionHost {
  @ObservationIgnored
  private let makeModel: @MainActor @Sendable (AccountUser) -> RoomSessionModel

  private(set) var model: RoomSessionModel
  private var lifecycleGeneration: UInt64 = 0
  private var intendedAccount: AccountUser
  private var transitionInProgress = false
  private var queuedInvite: RedeemedRoomInvite?
  private var sceneIsActive = true

  init(
    account: AccountUser,
    makeModel: @escaping @MainActor @Sendable (AccountUser) -> RoomSessionModel
  ) {
    self.makeModel = makeModel
    intendedAccount = account
    model = makeModel(account)
  }

  convenience init(
    account: AccountUser,
    apiClient: SkyjoAPIClient,
    inviteClient: RoomInviteClient,
    seatStore: any RoomSeatRecoveryStore = FileRoomSeatRecoveryStore.applicationSupportStore()
  ) {
    self.init(account: account) { nextAccount in
      RoomSessionModel(
        account: nextAccount,
        environment: .live(
          apiClient: apiClient,
          inviteClient: inviteClient,
          account: nextAccount,
          seatStore: seatStore
        )
      )
    }
  }

  func synchronize(account: AccountUser) async {
    guard intendedAccount != account else { return }
    intendedAccount = account
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    let previous = model
    transitionInProgress = true
    await previous.stop()
    guard lifecycleGeneration == generation else { return }
    let pendingInvite = queuedInvite ?? previous.pendingInviteReview
    queuedInvite = nil
    let nextModel = makeModel(account)
    nextModel.setSceneActive(sceneIsActive)
    if let pendingInvite { nextModel.applyInvite(pendingInvite) }
    model = nextModel
    transitionInProgress = false
  }

  func applyInvite(_ invite: RedeemedRoomInvite) {
    if transitionInProgress {
      // A link received while the current account model drains must never route
      // into that retiring socket. Keep only the latest sanitized redemption.
      queuedInvite = invite
    } else {
      model.applyInvite(invite)
    }
  }

  func setSceneActive(_ active: Bool) {
    guard sceneIsActive != active else { return }
    sceneIsActive = active
    model.setSceneActive(active)
  }

  var hasPendingInviteForPresentation: Bool {
    queuedInvite != nil || model.pendingInviteReview != nil
  }

  /// Removes the latest sanitized review from a host that is about to retire.
  /// An invite queued during a profile-driven model transition is newer than a
  /// review still held by the old model.
  func drainPendingInviteForRetirement() -> RedeemedRoomInvite? {
    let invite = queuedInvite ?? model.pendingInviteReview
    queuedInvite = nil
    return invite
  }

  func stop() async {
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    intendedAccount = model.account
    transitionInProgress = true
    queuedInvite = nil
    await model.stop()
    if lifecycleGeneration == generation {
      queuedInvite = nil
      transitionInProgress = false
    }
  }
}

@MainActor
@Observable
final class RoomSessionModel {
  let account: AccountUser

  var joinCode = ""
  var drawChoice = RoomDrawChoice.place
  var isChatPresented = false {
    didSet {
      if isChatPresented { markChatRead() }
    }
  }
  var isRoomOptionsPresented = false
  var isScorePresented = false

  private(set) var connectionStatus = RoomConnectionStatus(
    phase: .idle,
    retryInMilliseconds: nil,
    synchronized: false,
    hasPendingCommand: false,
    revision: nil
  )
  private(set) var snapshot: AuthoritativeRoomSnapshot?
  private(set) var banner: RoomBanner?
  private(set) var pendingInviteReview: RedeemedRoomInvite?
  private(set) var shareInvite: NativeRoomInvite?
  private(set) var isCreatingInvite = false
  private(set) var isPreparingConnection = false
  private(set) var isAdmissionOperationPending = false
  private(set) var isSeatCleanupPending = false

  private let environment: RoomSessionEnvironment
  private var connection: (any RoomSessionConnection)?
  private var eventTask: Task<Void, Never>?
  private var presenceTask: Task<Void, Never>?
  private var started = false
  private var lifecycleGeneration: UInt64 = 0
  private var sceneIsActive = true
  private var lastSeenChatMessageID: String?
  private var lastChatRoomCode: String?
  private var serverClockOffset: Int64 = 0
  private var pendingTerminalAction: RoomCommandAction?
  private var shareRequestID: UUID?
  private var recoveryGeneration: UInt64 = 0
  private var activeAdmissionOperationID: UUID?
  private var activeAdmissionRecoveryGeneration: UInt64?
  private var resetRecoveryInitiated = false
  private var resetRecoveryCleanupRequired = false
  private var resetRecoveryCleanupVerified = false
  private var isResetRecoveryCleanupInProgress = false
  @ObservationIgnored
  private var resetRecoveryCleanupWaiters: [CheckedContinuation<Void, Never>] = []
  private var acceptsSeatPersistence = true
  private var awaitsFreshAdmissionSnapshot = false
  private var expectedFreshAdmissionRoomCode: String?
  private var routingClearOperationID: UUID?
  private var routingClearRoomCode: String?
  private var bufferedSnapshotDuringRoutingClear: AuthoritativeRoomSnapshot?
  private var inviteSupersededAdmission = false
  private var supersededAdmissionSnapshot: AuthoritativeRoomSnapshot?
  private var seatCleanupID: UUID?

  init(
    account: AccountUser,
    environment: RoomSessionEnvironment,
    invite: RedeemedRoomInvite? = nil
  ) {
    self.account = account
    self.environment = environment
    if let invite, !invite.isExpired(at: environment.nowMilliseconds()) {
      pendingInviteReview = invite
      joinCode = invite.roomCode
    }
  }

  var room: PublicRoomSnapshot? { snapshot?.room }
  var game: PublicGameStateSnapshot? { room?.state }
  var playerID: String? { snapshot?.playerID }

  var localRoomPlayer: PublicRoomPlayerSnapshot? {
    guard let playerID else { return nil }
    return room?.players.first(where: { $0.id == playerID })
  }

  var localGamePlayer: PublicPlayerSnapshot? {
    guard let playerID else { return nil }
    return game?.players.first(where: { $0.id == playerID })
  }

  var opponentGamePlayers: [PublicPlayerSnapshot] {
    guard let playerID else { return game?.players ?? [] }
    return game?.players.filter { $0.id != playerID } ?? []
  }

  var isLocalTurn: Bool {
    guard let game, game.players.indices.contains(game.currentPlayerIndex), let playerID else {
      return false
    }
    return game.players[game.currentPlayerIndex].id == playerID
  }

  var isLocalHost: Bool {
    guard let playerID else { return false }
    return room?.hostId == playerID
  }

  var commandsEnabled: Bool {
    snapshot != nil
      && localRoomPlayer != nil
      && !resetRecoveryCleanupRequired
      && connectionStatus.phase == .connected
      && connectionStatus.synchronized
      && !connectionStatus.hasPendingCommand
      && connectionStatus.revision == snapshot?.revision
      && localRoomPlayer?.controller != .ai
  }

  var canSubmitAdmission: Bool {
    !isPreparingConnection
      && !isAdmissionOperationPending
      && !isSeatCleanupPending
      && !resetRecoveryInitiated
      && !resetRecoveryCleanupRequired
      && !connectionStatus.hasPendingCommand
      && (connectionStatus.phase == .idle || connectionStatus.phase == .error)
  }

  var canAcceptInvite: Bool {
    pendingInviteReview != nil
      && !isPreparingConnection
      && !isAdmissionOperationPending
      && !isSeatCleanupPending
      && !resetRecoveryInitiated
      && !resetRecoveryCleanupRequired
      && !connectionStatus.hasPendingCommand
      && pendingTerminalAction == nil
      && connectionStatus.phase != .upgradeRequired
      && !inviteRequiresLeavingCurrentRoom
  }

  var inviteRequiresLeavingCurrentRoom: Bool {
    guard let invite = pendingInviteReview, let room else { return false }
    return room.code != invite.roomCode && room.status == .waiting
  }

  var canForgetSavedSeat: Bool {
    !isPreparingConnection
      && !isAdmissionOperationPending
      && !isSeatCleanupPending
      && (
        resetRecoveryCleanupRequired
          || connectionStatus.phase == .idle
          || connectionStatus.phase == .error
      )
  }

  var interactionDisabledReason: String? {
    if resetRecoveryCleanupRequired {
      return "Saved room recovery must be cleared before multiplayer can continue."
    }
    if localRoomPlayer?.controller == .ai {
      return "AI is controlling your seat. Keep this app active to reclaim it."
    }
    if connectionStatus.hasPendingCommand {
      return "Waiting for the server to confirm the previous action."
    }
    if connectionStatus.phase == .offline {
      return "Room actions are unavailable while offline."
    }
    if connectionStatus.phase != .connected || !connectionStatus.synchronized {
      return "Room actions are paused until the table is synchronized."
    }
    return nil
  }

  var unreadChatCount: Int {
    guard let room, let playerID else { return 0 }
    let lastSeenIndex = room.chatMessages.firstIndex(where: { $0.id == lastSeenChatMessageID }) ?? -1
    return room.chatMessages.enumerated().reduce(into: 0) { count, item in
      if item.offset > lastSeenIndex && item.element.playerId != playerID { count += 1 }
    }
  }

  var connectedHumanCount: Int {
    room?.players.filter { $0.connected && $0.controller == .human }.count ?? 0
  }

  var canStartWaitingRoom: Bool {
    commandsEnabled && isLocalHost && room?.status == .waiting && connectedHumanCount >= 2
  }

  var canLeaveWaitingRoom: Bool {
    guard commandsEnabled, isLocalHost || localRoomPlayer != nil, room?.status == .waiting else {
      return false
    }
    if isLocalHost, (room?.players.count ?? 0) > 1, connectedHumanCount < 2 { return false }
    return true
  }

  var isScoring: Bool {
    game?.phase == .roundOver || game?.phase == .gameOver
  }

  var readyPlayerIDs: [String] {
    game?.players.map(\.id) ?? []
  }

  var readyCount: Int {
    let ready = Set(room?.readyForNextRoundPlayerIds ?? [])
    return readyPlayerIDs.filter(ready.contains).count
  }

  var allPlayersReady: Bool {
    !readyPlayerIDs.isEmpty && readyCount == readyPlayerIDs.count
  }

  var localIsReady: Bool {
    guard let playerID else { return false }
    return room?.readyForNextRoundPlayerIds.contains(playerID) == true
  }

  var canAdvanceAfterScoring: Bool {
    commandsEnabled && isLocalHost && isScoring && allPlayersReady
  }

  var canCreateShareInvite: Bool {
    room != nil
      && localRoomPlayer != nil
      && !resetRecoveryCleanupRequired
      && connectionStatus.phase == .connected
      && connectionStatus.synchronized
      && !connectionStatus.hasPendingCommand
      && connectionStatus.revision == snapshot?.revision
      && !isCreatingInvite
  }

  var estimatedServerNow: Int64 {
    environment.nowMilliseconds() - serverClockOffset
  }

  func start() async {
    guard !started else { return }
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    let automaticRecoveryGeneration = recoveryGeneration
    connectionStatus = Self.idleConnectionStatus
    resetRecoveryInitiated = false
    resetRecoveryCleanupVerified = false
    isResetRecoveryCleanupInProgress = false
    acceptsSeatPersistence = true
    awaitsFreshAdmissionSnapshot = false
    expectedFreshAdmissionRoomCode = nil
    routingClearOperationID = nil
    routingClearRoomCode = nil
    bufferedSnapshotDuringRoutingClear = nil
    isPreparingConnection = true
    started = true
    defer {
      if lifecycleGeneration == generation {
        isPreparingConnection = false
      }
    }
    let nextConnection: any RoomSessionConnection
    do {
      nextConnection = try await environment.makeConnection()
    } catch {
      guard lifecycleGeneration == generation, started else { return }
      started = false
      connection = nil
      eventTask?.cancel()
      eventTask = nil
      banner = RoomBanner(
        title: "Room connection unavailable",
        message: "Skyjo could not initialize multiplayer. Try again.",
        tone: .warning
      )
      return
    }
    guard lifecycleGeneration == generation, started else {
      await nextConnection.dispose()
      return
    }

    connection = nextConnection
    schedulePresenceFlushIfNeeded()
    let events = await nextConnection.events()
    guard lifecycleGeneration == generation, started else {
      await nextConnection.dispose()
      return
    }
    eventTask = Task { [weak self] in
      for await event in events {
        guard !Task.isCancelled else { return }
        await self?.consume(event, generation: generation)
      }
    }
    do {
      let recoveredPersistedReset = try await nextConnection.recoverPersistedReset()
      guard lifecycleGeneration == generation, started else { return }
      // A successful read verifies that an earlier undecodable/unavailable
      // recovery is no longer unresolved. An actual recovered command remains
      // gated separately until its authoritative convergence.
      let clearedRecoveryCleanupBlocker = resetRecoveryCleanupRequired
      resetRecoveryCleanupRequired = false
      if clearedRecoveryCleanupBlocker,
         let bannerTitle = banner?.title,
         [
           "Room reset recovery unavailable",
           "Room reset cleanup needed",
           "Room reset paused",
         ].contains(bannerTitle) {
        banner = nil
      }
      if recoveredPersistedReset {
        resetRecoveryInitiated = true
        return
      }
    } catch {
      guard lifecycleGeneration == generation, started else { return }
      requireResetRecoveryCleanup()
      banner = RoomBanner(
        title: "Room reset recovery unavailable",
        message: "Skyjo could not safely finish the pending room reset. Reopen multiplayer and try again.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
      return
    }

    guard lifecycleGeneration == generation,
          started,
          recoveryGeneration == automaticRecoveryGeneration,
          activeAdmissionOperationID == nil,
          pendingInviteReview == nil
    else { return }
    var recoveringRoomCode: String?
    do {
      if let saved = try await environment.seatStore.load(accountID: account.id) {
        guard lifecycleGeneration == generation,
              started,
              recoveryGeneration == automaticRecoveryGeneration,
              activeAdmissionOperationID == nil,
              pendingInviteReview == nil
        else { return }
        recoveringRoomCode = saved.roomCode
        joinCode = saved.roomCode
        acceptsSeatPersistence = false
        awaitsFreshAdmissionSnapshot = true
        expectedFreshAdmissionRoomCode = saved.roomCode
        try await nextConnection.recover(
          .join(
            code: saved.roomCode,
            displayName: account.displayName,
            playerID: saved.playerID
          )
        )
      }
    } catch {
      guard lifecycleGeneration == generation,
            started,
            recoveryGeneration == automaticRecoveryGeneration,
            activeAdmissionOperationID == nil,
            pendingInviteReview == nil
      else { return }
      if let recoveringRoomCode,
         expectedFreshAdmissionRoomCode == recoveringRoomCode {
        acceptsSeatPersistence = false
        awaitsFreshAdmissionSnapshot = false
        expectedFreshAdmissionRoomCode = nil
      }
      banner = RoomBanner(
        title: "Saved room unavailable",
        message: "Your saved seat could not be restored. You can create or join a room again.",
        tone: .warning
      )
    }
  }

  func stop() async {
    lifecycleGeneration &+= 1
    recoveryGeneration &+= 1
    started = false
    isPreparingConnection = false
    resetRecoveryInitiated = false
    resetRecoveryCleanupVerified = false
    acceptsSeatPersistence = false
    awaitsFreshAdmissionSnapshot = false
    expectedFreshAdmissionRoomCode = nil
    routingClearRoomCode = nil
    bufferedSnapshotDuringRoutingClear = nil
    inviteSupersededAdmission = false
    supersededAdmissionSnapshot = nil
    isSeatCleanupPending = false
    seatCleanupID = nil
    let retiredEventTask = eventTask
    retiredEventTask?.cancel()
    eventTask = nil
    let retiredPresenceTask = presenceTask
    retiredPresenceTask?.cancel()
    presenceTask = nil
    let retiredConnection = connection
    connection = nil
    connectionStatus = Self.idleConnectionStatus
    pendingTerminalAction = nil
    invalidateShareInvite()
    if let retiredConnection { await retiredConnection.dispose() }
    await waitForResetRecoveryCleanup()
    isAdmissionOperationPending = false
    activeAdmissionOperationID = nil
    activeAdmissionRecoveryGeneration = nil
    if let retiredEventTask { await retiredEventTask.value }
    if let retiredPresenceTask { await retiredPresenceTask.value }
  }

  func setSceneActive(_ active: Bool) {
    guard sceneIsActive != active else { return }
    sceneIsActive = active
    schedulePresenceFlushIfNeeded()
  }

  func applyInvite(_ invite: RedeemedRoomInvite) {
    // Opening a newer redeemed link always supersedes older invite intent,
    // even when local time says the newer link has already expired.
    pendingInviteReview = nil
    joinCode = ""
    recoveryGeneration &+= 1
    if snapshot == nil, awaitsFreshAdmissionSnapshot {
      acceptsSeatPersistence = false
      awaitsFreshAdmissionSnapshot = false
      expectedFreshAdmissionRoomCode = nil
      inviteSupersededAdmission = true
      supersededAdmissionSnapshot = nil
    }
    guard !invite.isExpired(at: environment.nowMilliseconds()) else {
      banner = RoomBanner(
        title: "Invite expired",
        message: "Ask the host for a new room invite.",
        tone: .warning
      )
      return
    }
    // A universal link can arrive while a create, join, or saved-seat recovery
    // is awaiting socket admission. Invalidate that operation's first-snapshot
    // fence so its late room cannot become visible or repopulate saved routing.
    // An already-authoritative current room is intentionally retained for the
    // explicit same-room/leave-or-switch review below.
    pendingInviteReview = invite
    joinCode = invite.roomCode
  }

  func dismissInviteReview() async {
    pendingInviteReview = nil
    guard inviteSupersededAdmission else { return }

    let generation = lifecycleGeneration
    let supersededConnection = connection
    let bufferedSnapshot = supersededAdmissionSnapshot
    activeAdmissionOperationID = nil
    activeAdmissionRecoveryGeneration = nil
    isAdmissionOperationPending = false
    guard let cancellationID = beginAdmissionOperation() else { return }
    defer { finishAdmissionOperation(cancellationID) }
    awaitsFreshAdmissionSnapshot = false
    expectedFreshAdmissionRoomCode = nil

    let authoritativeSnapshot = if let bufferedSnapshot {
      bufferedSnapshot
    } else {
      await supersededConnection?.currentAuthoritativeSnapshot()
    }
    guard lifecycleGeneration == generation,
          admissionOperationIsCurrent(cancellationID),
          pendingInviteReview == nil
    else { return }
    inviteSupersededAdmission = false
    supersededAdmissionSnapshot = nil

    if let authoritativeSnapshot {
      acceptsSeatPersistence = true
      await consume(.snapshot(authoritativeSnapshot), generation: generation)
      return
    }

    acceptsSeatPersistence = false
    do {
      try await supersededConnection?.disconnect()
    } catch {
      guard lifecycleGeneration == generation, started else { return }
      requireResetRecoveryCleanup()
      banner = RoomBanner(
        title: "Saved room cleanup needed",
        message: "Skyjo canceled the room connection, but saved reset recovery still needs explicit cleanup.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
    }
    guard lifecycleGeneration == generation,
          admissionOperationIsCurrent(cancellationID)
    else { return }
    clearVisibleRoom()
  }

  func acceptInviteAndJoin() async {
    guard let invite = pendingInviteReview else { return }
    guard !resetRecoveryCleanupRequired else {
      banner = RoomBanner(
        title: "Room reset cleanup needed",
        message: "Use Forget Saved Seat before joining this invite.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
      return
    }
    guard !invite.isExpired(at: environment.nowMilliseconds()) else {
      await dismissInviteReview()
      banner = RoomBanner(
        title: "Invite expired",
        message: "Ask the host for a new room invite.",
        tone: .warning
      )
      return
    }
    if room?.code == invite.roomCode {
      pendingInviteReview = nil
      banner = RoomBanner(
        title: "Already in this room",
        message: "Your current multiplayer table already uses that invite.",
        tone: .information
      )
      return
    }
    guard !inviteRequiresLeavingCurrentRoom else {
      banner = RoomBanner(
        title: "Leave the waiting room first",
        message: "Cancel this review, leave the current waiting room, then accept the invite. Skyjo will keep the reviewed invite ready.",
        tone: .warning
      )
      return
    }
    let connectionHasAdmission = connectionStatus.phase != .idle
      && connectionStatus.phase != .error
    if await join(
      code: invite.roomCode,
      replacingCurrentRoom: room != nil || connectionHasAdmission
    ) {
      inviteSupersededAdmission = false
      supersededAdmissionSnapshot = nil
      pendingInviteReview = nil
    }
  }

  func sanitizeJoinCode() {
    joinCode = Self.cleanRoomCode(joinCode)
  }

  func createRoom() async {
    guard let operationID = beginAdmissionOperation() else { return }
    defer { finishAdmissionOperation(operationID) }
    guard await prepareConnection(), admissionOperationIsCurrent(operationID) else { return }
    guard await clearRoutingForFreshAdmission(operationID) else { return }
    replaceVisibleSession(awaitingRoomCode: nil)
    do {
      guard let connection else { return }
      try await connection.connect(.create(displayName: account.displayName))
      guard admissionOperationIsCurrent(operationID) else { return }
      pendingInviteReview = nil
    } catch {
      guard admissionOperationIsCurrent(operationID) else { return }
      awaitsFreshAdmissionSnapshot = false
      expectedFreshAdmissionRoomCode = nil
      showCommandError(error)
    }
  }

  @discardableResult
  func join(code: String? = nil, replacingCurrentRoom: Bool = false) async -> Bool {
    let cleanedCode = Self.cleanRoomCode(code ?? joinCode)
    joinCode = cleanedCode
    guard cleanedCode.count == 5 else {
      banner = RoomBanner(
        title: "Room code needed",
        message: "Enter the five-character room code.",
        tone: .warning
      )
      return false
    }
    guard let operationID = beginAdmissionOperation() else { return false }
    defer { finishAdmissionOperation(operationID) }
    guard await prepareConnection(allowReplacingCurrentRoom: replacingCurrentRoom),
          admissionOperationIsCurrent(operationID)
    else { return false }
    guard await clearRoutingForFreshAdmission(operationID) else { return false }
    do {
      replaceVisibleSession(awaitingRoomCode: cleanedCode)
      guard let connection else { return false }
      try await connection.connect(
        .join(
          code: cleanedCode,
          displayName: account.displayName,
          playerID: nil
        )
      )
      guard admissionOperationIsCurrent(operationID) else { return false }
      pendingInviteReview = nil
      return true
    } catch {
      guard admissionOperationIsCurrent(operationID) else { return false }
      awaitsFreshAdmissionSnapshot = false
      expectedFreshAdmissionRoomCode = nil
      showCommandError(error)
      return false
    }
  }

  func retrySavedSeat() async {
    guard let operationID = beginAdmissionOperation() else { return }
    let operationRecoveryGeneration = recoveryGeneration
    var recoveringRoomCode: String?
    defer { finishAdmissionOperation(operationID) }
    guard await prepareConnection(), admissionOperationIsCurrent(operationID) else { return }
    do {
      guard let saved = try await environment.seatStore.load(accountID: account.id) else {
        guard admissionOperationIsCurrent(operationID) else { return }
        banner = RoomBanner(
          title: "No saved seat",
          message: "Create or join a room to continue.",
          tone: .information
        )
        return
      }
      guard admissionOperationIsCurrent(operationID),
            recoveryGeneration == operationRecoveryGeneration,
            pendingInviteReview == nil,
            let connection
      else { return }
      recoveringRoomCode = saved.roomCode
      joinCode = saved.roomCode
      acceptsSeatPersistence = false
      awaitsFreshAdmissionSnapshot = true
      expectedFreshAdmissionRoomCode = saved.roomCode
      try await connection.recover(
        .join(
          code: saved.roomCode,
          displayName: account.displayName,
          playerID: saved.playerID
        )
      )
    } catch {
      guard admissionOperationIsCurrent(operationID) else { return }
      if let recoveringRoomCode,
         expectedFreshAdmissionRoomCode == recoveringRoomCode {
        acceptsSeatPersistence = false
        awaitsFreshAdmissionSnapshot = false
        expectedFreshAdmissionRoomCode = nil
      }
      showCommandError(error)
    }
  }

  func forgetSavedSeat() async {
    guard let operationID = beginAdmissionOperation() else { return }
    isResetRecoveryCleanupInProgress = true
    defer {
      finishResetRecoveryCleanup()
      finishAdmissionOperation(operationID)
    }
    acceptsSeatPersistence = false
    pendingTerminalAction = nil
    invalidateShareInvite()
    isChatPresented = false
    isRoomOptionsPresented = false
    isScorePresented = false
    clearVisibleRoom()
    let cleanupConnection = connection
    var resetRecoveryWasCleared = true
    if let cleanupConnection {
      do {
        try await cleanupConnection.disconnect()
      } catch {
        resetRecoveryWasCleared = false
      }
    } else if resetRecoveryCleanupRequired {
      resetRecoveryWasCleared = false
    }
    guard admissionOperationIsCurrent(operationID) else { return }
    if resetRecoveryCleanupRequired || !resetRecoveryWasCleared {
      if let cleanupConnection {
        guard admissionOperationIsCurrent(operationID) else { return }
        do {
          try await cleanupConnection.discardPersistedResetRecovery()
          guard admissionOperationIsCurrent(operationID) else { return }
          resetRecoveryWasCleared = true
          resetRecoveryCleanupRequired = false
          // RoomConnection can enqueue the failure that made disconnect throw
          // before this broad discard finishes. Treat the verified discard as
          // the resolution boundary for those already-produced notices.
          resetRecoveryCleanupVerified = true
        } catch {
          guard admissionOperationIsCurrent(operationID) else { return }
          resetRecoveryWasCleared = false
          resetRecoveryCleanupRequired = true
          resetRecoveryCleanupVerified = false
        }
      } else {
        resetRecoveryWasCleared = false
        resetRecoveryCleanupRequired = true
      }
    }
    guard admissionOperationIsCurrent(operationID) else { return }
    let savedSeatWasCleared: Bool
    do {
      try await environment.seatStore.clear(accountID: account.id)
      guard admissionOperationIsCurrent(operationID) else { return }
      savedSeatWasCleared = true
    } catch {
      guard admissionOperationIsCurrent(operationID) else { return }
      savedSeatWasCleared = false
    }
    guard admissionOperationIsCurrent(operationID) else { return }
    if resetRecoveryWasCleared, savedSeatWasCleared {
      banner = nil
    } else {
      banner = RoomBanner(
        title: "Saved room cleanup needed",
        message: "Skyjo disconnected, but could not clear all saved routing data. Try forgetting the seat again.",
        tone: .error
      )
    }
  }

  func startGame() async {
    guard canStartWaitingRoom || canAdvanceAfterScoring else { return }
    await send(.startGame)
  }

  func toggleReady() async {
    guard commandsEnabled, isScoring else { return }
    await send(.setNextRoundReady(!localIsReady))
  }

  func leaveRoom() async {
    guard canLeaveWaitingRoom, pendingTerminalAction == nil else { return }
    pendingTerminalAction = .leaveRoom
    await send(.leaveRoom, ownsTerminalIntent: true)
  }

  func resetRoom() async {
    guard commandsEnabled, isLocalHost, pendingTerminalAction == nil else { return }
    // A new reset is the first operation that can create fresh reset-recovery
    // durability, so failures from this point forward must be actionable again.
    resetRecoveryCleanupVerified = false
    pendingTerminalAction = .resetRoom
    await send(.resetRoom, ownsTerminalIntent: true)
  }

  func removePlayer(_ playerID: String) async {
    guard commandsEnabled, isLocalHost, room?.status == .waiting, playerID != self.playerID else {
      return
    }
    await send(.removePlayer(playerID))
  }

  func canTakeOver(_ player: PublicRoomPlayerSnapshot) -> Bool {
    commandsEnabled
      && isLocalHost
      && room?.status != .waiting
      && !player.connected
      && player.controller == .human
      && player.aiTakeoverAt.map { $0 <= estimatedServerNow } == true
  }

  func takeOverWithAI(_ playerID: String) async {
    guard let player = room?.players.first(where: { $0.id == playerID }), canTakeOver(player) else {
      return
    }
    await send(.takeoverPlayerWithAI(playerID))
  }

  func chooseDiscard() async {
    guard commandsEnabled, isLocalTurn, let game else { return }
    if game.phase == .chooseReplacement, game.selectedSource == .discard {
      await send(.cancelDiscard)
    } else if game.phase == .chooseSource, game.discardPile.top != nil {
      await send(.chooseDiscard)
    }
  }

  func drawBlind() async {
    guard commandsEnabled, isLocalTurn, game?.phase == .chooseSource else { return }
    await send(.drawBlind)
  }

  func selectLocalCard(at index: Int) async {
    guard commandsEnabled,
          isLocalTurn,
          let game,
          let local = localGamePlayer,
          local.grid.indices.contains(index),
          !local.grid[index].removed
    else { return }
    switch game.phase {
    case .openingReveal:
      guard game.openingRevealCounts[local.id, default: 0] < 2,
            !local.grid[index].faceUp
      else { return }
      await send(.revealOpeningCard(index))
    case .chooseReplacement:
      if game.selectedSource == .draw,
         game.drawnCard != nil,
         drawChoice == .discardAndReveal {
        guard !local.grid[index].faceUp else { return }
        await send(.discardAndReveal(index))
      } else {
        await send(.replaceCard(index))
      }
    case .chooseSource, .roundOver, .gameOver:
      return
    }
  }

  func isLocalCardEnabled(at index: Int) -> Bool {
    guard commandsEnabled,
          isLocalTurn,
          let game,
          let local = localGamePlayer,
          local.grid.indices.contains(index),
          !local.grid[index].removed
    else { return false }
    switch game.phase {
    case .openingReveal:
      return game.openingRevealCounts[local.id, default: 0] < 2
        && !local.grid[index].faceUp
    case .chooseReplacement:
      if game.selectedSource == .draw,
         game.drawnCard != nil,
         drawChoice == .discardAndReveal {
        return !local.grid[index].faceUp
      }
      return true
    case .chooseSource, .roundOver, .gameOver:
      return false
    }
  }

  func sendChat(_ text: String) async {
    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard commandsEnabled, !cleaned.isEmpty, cleaned.utf16.count <= 280 else { return }
    await send(.sendChatMessage(cleaned))
  }

  func markChatRead() {
    lastSeenChatMessageID = room?.chatMessages.last?.id
  }

  func createShareInvite() async {
    guard let room, canCreateShareInvite else { return }
    let expectedRoomCode = room.code
    let requestID = UUID()
    shareRequestID = requestID
    isCreatingInvite = true
    do {
      let invite = try await environment.createInvite(expectedRoomCode)
      guard shareRequestID == requestID,
            self.room?.code == expectedRoomCode,
            invite.roomCode == expectedRoomCode
      else {
        finishShareRequest(requestID)
        return
      }
      shareInvite = invite
    } catch {
      guard shareRequestID == requestID, self.room?.code == expectedRoomCode else { return }
      banner = RoomBanner(
        title: "Invite unavailable",
        message: Self.safeMessage(for: error),
        tone: .warning
      )
    }
    finishShareRequest(requestID)
  }

  func clearShareInvite() {
    invalidateShareInvite()
  }

  func dismissBanner() {
    banner = nil
  }

  private func prepareConnection(allowReplacingCurrentRoom: Bool = false) async -> Bool {
    if !started { await start() }
    guard !isPreparingConnection else {
      banner = RoomBanner(
        title: "Room connection is still preparing",
        message: "Wait for saved-room recovery to finish, then try again.",
        tone: .information
      )
      return false
    }
    guard !resetRecoveryCleanupRequired else {
      banner = RoomBanner(
        title: "Room reset cleanup needed",
        message: "Use Forget Saved Seat to clear unresolved reset recovery before creating or joining a room.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
      return false
    }
    guard !resetRecoveryInitiated else {
      banner = RoomBanner(
        title: "Room reset recovered",
        message: "Review the recovered room before starting another admission.",
        tone: .information
      )
      return false
    }
    guard !connectionStatus.hasPendingCommand, pendingTerminalAction == nil else {
      banner = RoomBanner(
        title: "Room cleanup is still pending",
        message: "Retry Forget Saved Seat before creating or joining another room.",
        tone: .warning
      )
      return false
    }
    guard connectionStatus.phase != .upgradeRequired else {
      banner = RoomBanner(
        title: "Update required",
        message: "Update Skyjo before creating or joining a multiplayer room.",
        tone: .error
      )
      return false
    }
    let phaseIsAvailable = allowReplacingCurrentRoom
      || connectionStatus.phase == .idle
      || connectionStatus.phase == .error
    guard connection != nil, phaseIsAvailable else {
      banner = RoomBanner(
        title: "Room connection unavailable",
        message: "Wait for the current room connection to settle, then try again.",
        tone: .error
      )
      return false
    }
    return true
  }

  private func replaceVisibleSession(awaitingRoomCode: String?) {
    acceptsSeatPersistence = false
    awaitsFreshAdmissionSnapshot = true
    expectedFreshAdmissionRoomCode = awaitingRoomCode
    snapshot = nil
    pendingTerminalAction = nil
    banner = nil
    invalidateShareInvite()
    lastSeenChatMessageID = nil
    lastChatRoomCode = nil
  }

  private func beginAdmissionOperation() -> UUID? {
    guard activeAdmissionOperationID == nil,
          !isAdmissionOperationPending,
          !isPreparingConnection,
          !isSeatCleanupPending
    else { return nil }
    recoveryGeneration &+= 1
    let operationID = UUID()
    activeAdmissionOperationID = operationID
    activeAdmissionRecoveryGeneration = recoveryGeneration
    isAdmissionOperationPending = true
    return operationID
  }

  private func admissionOperationIsCurrent(_ operationID: UUID) -> Bool {
    started
      && activeAdmissionOperationID == operationID
      && activeAdmissionRecoveryGeneration == recoveryGeneration
  }

  private func finishAdmissionOperation(_ operationID: UUID) {
    guard activeAdmissionOperationID == operationID else { return }
    activeAdmissionOperationID = nil
    activeAdmissionRecoveryGeneration = nil
    isAdmissionOperationPending = false
  }

  private func waitForResetRecoveryCleanup() async {
    guard isResetRecoveryCleanupInProgress else { return }
    await withCheckedContinuation { resetRecoveryCleanupWaiters.append($0) }
  }

  private func finishResetRecoveryCleanup() {
    isResetRecoveryCleanupInProgress = false
    let waiters = resetRecoveryCleanupWaiters
    resetRecoveryCleanupWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func finishShareRequest(_ requestID: UUID) {
    guard shareRequestID == requestID else { return }
    shareRequestID = nil
    isCreatingInvite = false
  }

  private func invalidateShareInvite() {
    shareRequestID = nil
    shareInvite = nil
    isCreatingInvite = false
  }

  private func dismissRoomScopedPresentation() {
    isChatPresented = false
    isRoomOptionsPresented = false
    isScorePresented = false
    invalidateShareInvite()
  }

  private func clearVisibleRoom() {
    snapshot = nil
    joinCode = ""
    dismissRoomScopedPresentation()
    lastSeenChatMessageID = nil
    lastChatRoomCode = nil
    resetRecoveryInitiated = false
    awaitsFreshAdmissionSnapshot = false
    expectedFreshAdmissionRoomCode = nil
    routingClearOperationID = nil
    routingClearRoomCode = nil
    bufferedSnapshotDuringRoutingClear = nil
    inviteSupersededAdmission = false
    supersededAdmissionSnapshot = nil
  }

  private func clearRoutingForFreshAdmission(_ operationID: UUID) async -> Bool {
    let generation = lifecycleGeneration
    let accountID = account.id
    acceptsSeatPersistence = false
    routingClearOperationID = operationID
    routingClearRoomCode = snapshot?.room.code
    bufferedSnapshotDuringRoutingClear = nil
    do {
      try await environment.seatStore.clear(accountID: account.id)
    } catch {
      await restoreRoutingAfterCanceledClear(
        operationID: operationID,
        generation: generation,
        accountID: accountID
      )
      guard admissionOperationIsCurrent(operationID) else { return false }
      banner = RoomBanner(
        title: "Saved room could not be replaced",
        message: "Skyjo kept the current room because its saved routing data could not be cleared. Try again.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
      return false
    }
    guard admissionOperationIsCurrent(operationID) else {
      await restoreRoutingAfterCanceledClear(
        operationID: operationID,
        generation: generation,
        accountID: accountID
      )
      return false
    }
    routingClearOperationID = nil
    routingClearRoomCode = nil
    bufferedSnapshotDuringRoutingClear = nil
    return true
  }

  private func restoreRoutingAfterCanceledClear(
    operationID: UUID,
    generation: UInt64,
    accountID: UUID
  ) async {
    guard lifecycleGeneration == generation,
          started,
          account.id == accountID,
          routingClearOperationID == operationID
    else { return }
    let authoritativeSnapshot = bufferedSnapshotDuringRoutingClear ?? snapshot
    routingClearOperationID = nil
    routingClearRoomCode = nil
    bufferedSnapshotDuringRoutingClear = nil
    guard let authoritativeSnapshot else {
      acceptsSeatPersistence = false
      return
    }
    acceptsSeatPersistence = true
    // Reconsume even the already-visible snapshot: the clear may have succeeded
    // before a newer invite invalidated the admission operation, so the current
    // account's recovery record must be written back under the original lifecycle.
    await consume(.snapshot(authoritativeSnapshot), generation: generation)
  }

  private func requireResetRecoveryCleanup() {
    resetRecoveryCleanupVerified = false
    if !resetRecoveryCleanupRequired {
      recoveryGeneration &+= 1
      activeAdmissionOperationID = nil
      activeAdmissionRecoveryGeneration = nil
      isAdmissionOperationPending = false
      if snapshot == nil, awaitsFreshAdmissionSnapshot {
        acceptsSeatPersistence = false
        awaitsFreshAdmissionSnapshot = false
        expectedFreshAdmissionRoomCode = nil
      }
    }
    resetRecoveryCleanupRequired = true
    invalidateShareInvite()
  }

  private func beginSeatCleanup() -> UUID {
    acceptsSeatPersistence = false
    let cleanupID = UUID()
    seatCleanupID = cleanupID
    isSeatCleanupPending = true
    return cleanupID
  }

  private func finishSeatCleanup(_ cleanupID: UUID) {
    guard seatCleanupID == cleanupID else { return }
    seatCleanupID = nil
    isSeatCleanupPending = false
  }

  private func send(_ action: RoomCommandAction, ownsTerminalIntent: Bool = false) async {
    guard let connection else { return }
    do {
      _ = try await connection.send(action)
    } catch {
      if ownsTerminalIntent, pendingTerminalAction == action {
        pendingTerminalAction = nil
      }
      showCommandError(error)
    }
  }

  private func consume(_ event: RoomConnectionEvent, generation: UInt64) async {
    guard lifecycleGeneration == generation, started else { return }
    switch event {
    case .status(let status):
      connectionStatus = status
      if status.phase == .idle, pendingTerminalAction == .leaveRoom {
        pendingTerminalAction = nil
        await clearSeatAfterTerminal(
          generation: generation,
          success: nil,
          failure: RoomBanner(
            title: "Room left; cleanup needed",
            message: "The server removed the seat, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
            tone: .warning
          )
        )
      }
    case .snapshot(let nextSnapshot):
      if !acceptsSeatPersistence {
        if inviteSupersededAdmission, snapshot == nil {
          if nextSnapshot.revision >= (supersededAdmissionSnapshot?.revision ?? 0) {
            supersededAdmissionSnapshot = nextSnapshot
          }
          return
        }
        if let routingClearRoomCode,
           snapshot?.room.code == routingClearRoomCode,
           nextSnapshot.room.code == routingClearRoomCode,
           nextSnapshot.revision >= (bufferedSnapshotDuringRoutingClear?.revision ?? snapshot?.revision ?? 0) {
          bufferedSnapshotDuringRoutingClear = nextSnapshot
        }
        guard awaitsFreshAdmissionSnapshot,
              expectedFreshAdmissionRoomCode.map({ $0 == nextSnapshot.room.code }) != false
        else { return }
        acceptsSeatPersistence = true
        awaitsFreshAdmissionSnapshot = false
        expectedFreshAdmissionRoomCode = nil
      }
      let previousCode = lastChatRoomCode
      if let visibleRoomCode = snapshot?.room.code,
         visibleRoomCode != nextSnapshot.room.code {
        dismissRoomScopedPresentation()
      }
      if banner?.survivesAuthoritativeSnapshot != true {
        banner = nil
      }
      snapshot = nextSnapshot
      resetRecoveryInitiated = false
      joinCode = nextSnapshot.room.code
      serverClockOffset = environment.nowMilliseconds() - nextSnapshot.room.serverNow
      if previousCode != nextSnapshot.room.code {
        lastSeenChatMessageID = nextSnapshot.room.chatMessages.last?.id
      } else if isChatPresented || nextSnapshot.room.chatMessages.last?.playerId == nextSnapshot.playerID {
        lastSeenChatMessageID = nextSnapshot.room.chatMessages.last?.id
      }
      lastChatRoomCode = nextSnapshot.room.code
      if !isScoring { isScorePresented = false }
      if game?.selectedSource != .draw || game?.drawnCard == nil {
        drawChoice = .place
      }
      // Ordinary broadcasts can race ahead of the leave acknowledgement. Keep the
      // leave intent until RoomConnection publishes its terminal idle status so
      // persisted seat routing is cleared exactly once after the server confirms it.
      if pendingTerminalAction != .leaveRoom {
        pendingTerminalAction = nil
      }
      do {
        try await environment.seatStore.save(
          RoomSeatRecoveryRecord(
            accountID: account.id,
            roomCode: nextSnapshot.room.code,
            playerID: nextSnapshot.playerID
          )
        )
      } catch {
        guard lifecycleGeneration == generation, started else { return }
        banner = RoomBanner(
          title: "Seat recovery unavailable",
          message: "This room works now, but its seat may not restore after relaunch.",
          tone: .warning
        )
      }
    case .notice(let notice):
      await consume(notice, generation: generation)
    }
  }

  private func consume(_ notice: RoomConnectionNotice, generation: UInt64) async {
    guard lifecycleGeneration == generation, started else { return }
    switch notice {
    case .commandResynchronized:
      pendingTerminalAction = nil
      banner = RoomBanner(
        title: "Table resynchronized",
        message: "The room changed before that action was accepted. Review the table and try again.",
        tone: .warning
      )
    case .commandRejected(let code, _, let matchedAction):
      if matchedAction == pendingTerminalAction {
        pendingTerminalAction = nil
      }
      banner = RoomBanner(
        title: "Action not accepted",
        message: Self.safeCommandMessage(code: code),
        tone: .warning
      )
    case .admissionRejected(let code, _, let usedSavedSeat):
      pendingTerminalAction = nil
      if !usedSavedSeat {
        acceptsSeatPersistence = false
        awaitsFreshAdmissionSnapshot = false
        expectedFreshAdmissionRoomCode = nil
      }
      let shouldForgetRejectedSeat = usedSavedSeat
        && ["room-not-found", "seat-forbidden", "stale-room", "stale-seat"].contains(code)
      guard shouldForgetRejectedSeat else {
        banner = RoomBanner(
          title: "Room admission not accepted",
          message: Self.safeCommandMessage(code: code),
          tone: .warning
        )
        return
      }
      await clearSeatAfterTerminal(
        generation: generation,
        success: RoomBanner(
          title: "Saved seat unavailable",
          message: "That saved room or seat ended. Create or join a room to continue.",
          tone: .warning
        ),
        failure: RoomBanner(
          title: "Saved seat cleanup needed",
          message: "That saved room ended, but its routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
          tone: .error
        )
      )
    case .roomResetByHost(let roomCode):
      guard !terminalNoticePredatesFreshAdmission(roomCode: roomCode) else { return }
      pendingTerminalAction = nil
      await clearSeatAfterTerminal(
        generation: generation,
        success: RoomBanner(
          title: "Room reset",
          message: "The host replaced this room. Ask for the new room code or invite.",
          tone: .information
        ),
        failure: RoomBanner(
          title: "Room reset; cleanup needed",
          message: "The old room ended, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
          tone: .warning
        )
      )
    case .seatRemoved(let roomCode):
      guard !terminalNoticePredatesFreshAdmission(roomCode: roomCode) else { return }
      pendingTerminalAction = nil
      await clearSeatAfterTerminal(
        generation: generation,
        success: RoomBanner(
          title: "Seat unavailable",
          message: "That saved seat is no longer available. Join the room again if it is still open.",
          tone: .warning
        ),
        failure: RoomBanner(
          title: "Seat unavailable; cleanup needed",
          message: "The seat ended, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
          tone: .warning
        )
      )
    case .upgradeRequired:
      pendingTerminalAction = nil
      acceptsSeatPersistence = false
      // RoomConnection quarantines its authoritative snapshot for this terminal
      // admission. Mirror that fail-closed boundary in the presentation model.
      clearVisibleRoom()
      banner = RoomBanner(
        title: "Update required",
        message: "Update Skyjo before continuing multiplayer.",
        tone: .error
      )
    case .invalidServerResponse:
      banner = RoomBanner(
        title: "Invalid room response",
        message: "The connection closed safely. Retry your saved seat.",
        tone: .error
      )
    case .synchronizationTimedOut:
      banner = RoomBanner(
        title: "Room sync timed out",
        message: "Check the connection and retry your saved seat.",
        tone: .warning
      )
    case .freshAdmissionInterrupted:
      acceptsSeatPersistence = false
      awaitsFreshAdmissionSnapshot = false
      expectedFreshAdmissionRoomCode = nil
      banner = RoomBanner(
        title: "Room not confirmed",
        message: "The network changed before Skyjo confirmed that room. Create or join again.",
        tone: .warning
      )
    case .transportInterrupted:
      banner = RoomBanner(
        title: "Connection interrupted",
        message: "Skyjo is reconnecting to the authoritative table.",
        tone: .information
      )
    case .resetRecoveryPersistenceFailed:
      guard !resetRecoveryCleanupVerified,
            !isResetRecoveryCleanupInProgress
      else { return }
      if banner?.title == "Saved room cleanup needed" { return }
      requireResetRecoveryCleanup()
      banner = RoomBanner(
        title: "Room reset cleanup needed",
        message: "Saved reset recovery data could not be cleared. Use Forget Saved Seat before continuing multiplayer.",
        tone: .error,
        survivesAuthoritativeSnapshot: true
      )
    }
  }

  private func clearSeatAfterTerminal(
    generation: UInt64,
    success: RoomBanner?,
    failure: RoomBanner
  ) async {
    let cleanupID = beginSeatCleanup()
    clearVisibleRoom()
    defer { finishSeatCleanup(cleanupID) }
    do {
      try await environment.seatStore.clear(accountID: account.id)
      guard lifecycleGeneration == generation,
            started,
            seatCleanupID == cleanupID
      else { return }
      banner = success
    } catch {
      guard lifecycleGeneration == generation,
            started,
            seatCleanupID == cleanupID
      else { return }
      banner = failure
    }
  }

  private func terminalNoticePredatesFreshAdmission(roomCode: String?) -> Bool {
    guard awaitsFreshAdmissionSnapshot, let roomCode else { return false }
    if let expectedFreshAdmissionRoomCode {
      return roomCode != expectedFreshAdmissionRoomCode
    }
    // A create admission has no room code until its first snapshot. Any coded
    // terminal notice crossing that fence necessarily belongs to the retired room.
    return true
  }

  private func schedulePresenceFlushIfNeeded() {
    guard presenceTask == nil, let connection, started else { return }
    let generation = lifecycleGeneration
    presenceTask = Task { [weak self] in
      await self?.flushScenePresence(on: connection, generation: generation)
    }
  }

  private func flushScenePresence(
    on connection: any RoomSessionConnection,
    generation: UInt64
  ) async {
    defer {
      if lifecycleGeneration == generation {
        presenceTask = nil
      }
    }
    while lifecycleGeneration == generation, started, self.connection != nil {
      let requestedVisibility = sceneIsActive
      if requestedVisibility {
        await connection.resume()
      } else {
        await connection.setVisible(false)
      }
      guard lifecycleGeneration == generation, started, self.connection != nil else { return }
      if sceneIsActive == requestedVisibility { return }
    }
  }

  private func showCommandError(_ error: any Error) {
    banner = RoomBanner(
      title: "Room action unavailable",
      message: Self.safeMessage(for: error),
      tone: .warning
    )
  }

  private static func safeMessage(for error: any Error) -> String {
    if let error = error as? SkyjoHTTPClientError { return error.localizedDescription }
    if let error = error as? RoomInviteContractError { return error.localizedDescription }
    if let error = error as? RoomConnectionError {
      switch error {
      case .commandAlreadyPending:
        return "Wait for the server to confirm the previous action."
      case .commandUnavailable:
        return "Wait for the room to reconnect and synchronize."
      case .resetRecoveryPersistenceFailed:
        return "Recovery data could not be saved, so the room was not reset."
      case .invalidWebSocketURL:
        return "The room service is not configured correctly."
      }
    }
    return "The room action could not be completed."
  }

  private static func safeCommandMessage(code: String) -> String {
    switch code {
    case "host-required", "not-host": return "Only the room host can do that."
    case "illegal-move", "not-your-turn":
      return "The active turn changed. Review the table and try again."
    case "active-game-required", "invalid-phase", "invalid-state", "no-active-game",
         "not-scoring", "waiting-room-required":
      return "That action is no longer available in the current room state."
    case "room-full": return "This room already has eight players."
    case "game-started": return "This game has already started."
    case "room-not-found", "stale-room", "stale-seat":
      return "That room or saved seat is no longer available."
    case "seat-forbidden": return "This account cannot reclaim that saved seat."
    case "players-required": return "At least two connected human players are required."
    case "players-not-ready": return "Every player must confirm they are ready first."
    case "active-seat-reserved":
      return "Active game seats remain reserved for reconnecting players."
    case "host-transfer-unavailable":
      return "The host can leave after another human player reconnects."
    case "takeover-unavailable": return "That player's reconnect window is still active."
    case "empty-chat": return "Enter a message before sending."
    case "invalid-player": return "Choose a current non-host player."
    case "room-code-unavailable": return "A new room code could not be created. Try again."
    case "ai-controls-seat": return "AI is still completing an action for that seat."
    case "player-away": return "Return to the active room before sending an action."
    case "already-in-room", "room-required":
      return "Reconnect to the active room and try again."
    case "command-id-conflict":
      return "The table could not safely replay that action. Review it and try again."
    case "history-save-failed":
      return "The completed game could not be saved. Try again before continuing."
    case "revision-exhausted":
      return "This room reached its revision limit. Reset it to continue."
    case "unchanged-command": return "That setting is already current."
    default: return "The server did not accept that action. Review the table and try again."
    }
  }

  private static func cleanRoomCode(_ input: String) -> String {
    let allowed = input.unicodeScalars.filter {
      $0.isASCII && ($0.properties.isAlphabetic || $0.properties.numericType != nil)
    }
    return String(String.UnicodeScalarView(allowed.prefix(5))).uppercased()
  }

  private static var idleConnectionStatus: RoomConnectionStatus {
    RoomConnectionStatus(
      phase: .idle,
      retryInMilliseconds: nil,
      synchronized: false,
      hasPendingCommand: false,
      revision: nil
    )
  }
}
