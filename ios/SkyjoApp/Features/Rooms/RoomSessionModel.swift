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

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.title == rhs.title && lhs.message == rhs.message && lhs.tone == rhs.tone
  }
}

protocol RoomSessionConnection: Sendable {
  func events() async -> AsyncStream<RoomConnectionEvent>
  func recoverPersistedReset() async throws -> Bool
  func connect(_ admission: RoomAdmission) async throws
  func recover(_ admission: RoomAdmission) async throws
  func send(_ action: RoomCommandAction) async throws -> UUID
  func setVisible(_ visible: Bool) async
  func disconnect() async
  func dispose() async
}

extension RoomConnection: RoomSessionConnection {}

struct RoomSessionEnvironment: Sendable {
  let makeConnection: @Sendable () async throws -> any RoomSessionConnection
  let createInvite: @Sendable (String) async throws -> NativeRoomInvite
  let seatStore: any RoomSeatRecoveryStore
  let nowMilliseconds: @Sendable () -> Int64

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

/// Owns the account-scoped room model across navigation while fencing account switches.
/// A new authenticated account never inherits the prior account's socket or saved seat.
@MainActor
@Observable
final class RoomSessionHost {
  @ObservationIgnored
  private let makeModel: @MainActor @Sendable (AccountUser) -> RoomSessionModel

  private(set) var model: RoomSessionModel
  private var lifecycleGeneration: UInt64 = 0

  init(
    account: AccountUser,
    makeModel: @escaping @MainActor @Sendable (AccountUser) -> RoomSessionModel
  ) {
    self.makeModel = makeModel
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
    guard model.account != account else { return }
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    let previous = model
    await previous.stop()
    guard lifecycleGeneration == generation else { return }
    model = makeModel(account)
  }

  func applyInvite(_ invite: RedeemedRoomInvite) {
    model.applyInvite(invite)
  }

  func stop() async {
    lifecycleGeneration &+= 1
    await model.stop()
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
    connectionStatus.phase == .connected
      && connectionStatus.synchronized
      && !connectionStatus.hasPendingCommand
      && localRoomPlayer?.controller != .ai
  }

  var interactionDisabledReason: String? {
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

  var estimatedServerNow: Int64 {
    environment.nowMilliseconds() - serverClockOffset
  }

  func start() async {
    guard !started else { return }
    lifecycleGeneration &+= 1
    let generation = lifecycleGeneration
    connectionStatus = Self.idleConnectionStatus
    started = true
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
      if try await nextConnection.recoverPersistedReset() {
        return
      }
      guard lifecycleGeneration == generation, started else { return }
      if let saved = try await environment.seatStore.load(accountID: account.id) {
        guard lifecycleGeneration == generation, started else { return }
        joinCode = saved.roomCode
        try await nextConnection.recover(
          .join(
            code: saved.roomCode,
            displayName: account.displayName,
            playerID: saved.playerID
          )
        )
      }
    } catch {
      guard lifecycleGeneration == generation, started else { return }
      banner = RoomBanner(
        title: "Saved room unavailable",
        message: "Your saved seat could not be restored. You can create or join a room again.",
        tone: .warning
      )
    }
  }

  func stop() async {
    lifecycleGeneration &+= 1
    let retiredEventTask = eventTask
    retiredEventTask?.cancel()
    eventTask = nil
    let retiredPresenceTask = presenceTask
    retiredPresenceTask?.cancel()
    presenceTask = nil
    let retiredConnection = connection
    connection = nil
    started = false
    connectionStatus = Self.idleConnectionStatus
    pendingTerminalAction = nil
    if let retiredConnection { await retiredConnection.dispose() }
    if let retiredEventTask { await retiredEventTask.value }
    if let retiredPresenceTask { await retiredPresenceTask.value }
  }

  func setSceneActive(_ active: Bool) {
    sceneIsActive = active
    schedulePresenceFlushIfNeeded()
  }

  func applyInvite(_ invite: RedeemedRoomInvite) {
    guard !invite.isExpired(at: environment.nowMilliseconds()) else {
      banner = RoomBanner(
        title: "Invite expired",
        message: "Ask the host for a new room invite.",
        tone: .warning
      )
      return
    }
    pendingInviteReview = invite
    joinCode = invite.roomCode
  }

  func dismissInviteReview() {
    pendingInviteReview = nil
  }

  func acceptInviteAndJoin() async {
    guard let invite = pendingInviteReview else { return }
    guard !invite.isExpired(at: environment.nowMilliseconds()) else {
      pendingInviteReview = nil
      banner = RoomBanner(
        title: "Invite expired",
        message: "Ask the host for a new room invite.",
        tone: .warning
      )
      return
    }
    pendingInviteReview = nil
    await join(code: invite.roomCode)
  }

  func sanitizeJoinCode() {
    joinCode = Self.cleanRoomCode(joinCode)
  }

  func createRoom() async {
    guard await prepareConnection() else { return }
    replaceVisibleSession()
    do {
      try await connection?.connect(.create(displayName: account.displayName))
    } catch {
      showCommandError(error)
    }
  }

  func join(code: String? = nil) async {
    guard await prepareConnection() else { return }
    let cleanedCode = Self.cleanRoomCode(code ?? joinCode)
    guard cleanedCode.count == 5 else {
      banner = RoomBanner(
        title: "Room code needed",
        message: "Enter the five-character room code.",
        tone: .warning
      )
      return
    }
    joinCode = cleanedCode
    do {
      let saved = try await environment.seatStore.load(accountID: account.id)
      replaceVisibleSession()
      try await connection?.connect(
        .join(
          code: cleanedCode,
          displayName: account.displayName,
          playerID: saved?.roomCode == cleanedCode ? saved?.playerID : nil
        )
      )
    } catch {
      showCommandError(error)
    }
  }

  func retrySavedSeat() async {
    guard await prepareConnection() else { return }
    do {
      guard let saved = try await environment.seatStore.load(accountID: account.id) else {
        banner = RoomBanner(
          title: "No saved seat",
          message: "Create or join a room to continue.",
          tone: .information
        )
        return
      }
      try await connection?.recover(
        .join(
          code: saved.roomCode,
          displayName: account.displayName,
          playerID: saved.playerID
        )
      )
    } catch {
      showCommandError(error)
    }
  }

  func forgetSavedSeat() async {
    pendingTerminalAction = nil
    await connection?.disconnect()
    do {
      try await environment.seatStore.clear(accountID: account.id)
      snapshot = nil
      joinCode = ""
      banner = nil
    } catch {
      banner = RoomBanner(
        title: "Saved seat still on device",
        message: "Skyjo disconnected, but could not clear its saved routing data. Try forgetting the seat again.",
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
    guard canLeaveWaitingRoom else { return }
    pendingTerminalAction = .leaveRoom
    await send(.leaveRoom)
  }

  func resetRoom() async {
    guard commandsEnabled, isLocalHost else { return }
    pendingTerminalAction = .resetRoom
    await send(.resetRoom)
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
      guard !local.grid[index].faceUp else { return }
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
      return !local.grid[index].faceUp
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
    guard let room, !isCreatingInvite else { return }
    isCreatingInvite = true
    defer { isCreatingInvite = false }
    do {
      shareInvite = try await environment.createInvite(room.code)
    } catch {
      banner = RoomBanner(
        title: "Invite unavailable",
        message: Self.safeMessage(for: error),
        tone: .warning
      )
    }
  }

  func clearShareInvite() {
    shareInvite = nil
  }

  func dismissBanner() {
    banner = nil
  }

  private func prepareConnection() async -> Bool {
    if !started { await start() }
    guard connection != nil else {
      banner = RoomBanner(
        title: "Room connection unavailable",
        message: "Try again after the app reconnects.",
        tone: .error
      )
      return false
    }
    return true
  }

  private func replaceVisibleSession() {
    snapshot = nil
    pendingTerminalAction = nil
    banner = nil
    shareInvite = nil
    lastSeenChatMessageID = nil
    lastChatRoomCode = nil
  }

  private func send(_ action: RoomCommandAction) async {
    guard let connection else { return }
    do {
      _ = try await connection.send(action)
    } catch {
      pendingTerminalAction = nil
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
        snapshot = nil
        joinCode = ""
        do {
          try await environment.seatStore.clear(accountID: account.id)
        } catch {
          guard lifecycleGeneration == generation, started else { return }
          banner = RoomBanner(
            title: "Room left; cleanup needed",
            message: "The server removed the seat, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
            tone: .warning
          )
        }
      }
    case .snapshot(let nextSnapshot):
      let previousCode = lastChatRoomCode
      banner = nil
      snapshot = nextSnapshot
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
    case .commandRejected(let code, _):
      pendingTerminalAction = nil
      banner = RoomBanner(
        title: "Action not accepted",
        message: Self.safeCommandMessage(code: code),
        tone: .warning
      )
    case .roomResetByHost:
      pendingTerminalAction = nil
      snapshot = nil
      joinCode = ""
      do {
        try await environment.seatStore.clear(accountID: account.id)
        guard lifecycleGeneration == generation, started else { return }
        banner = RoomBanner(
          title: "Room reset",
          message: "The host replaced this room. Ask for the new room code or invite.",
          tone: .information
        )
      } catch {
        guard lifecycleGeneration == generation, started else { return }
        banner = RoomBanner(
          title: "Room reset; cleanup needed",
          message: "The old room ended, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
          tone: .warning
        )
      }
    case .seatRemoved:
      pendingTerminalAction = nil
      snapshot = nil
      joinCode = ""
      do {
        try await environment.seatStore.clear(accountID: account.id)
        guard lifecycleGeneration == generation, started else { return }
        banner = RoomBanner(
          title: "Seat unavailable",
          message: "That saved seat is no longer available. Join the room again if it is still open.",
          tone: .warning
        )
      } catch {
        guard lifecycleGeneration == generation, started else { return }
        banner = RoomBanner(
          title: "Seat unavailable; cleanup needed",
          message: "The seat ended, but saved routing data could not be cleared. Use Forget Saved Seat to retry cleanup.",
          tone: .warning
        )
      }
    case .upgradeRequired:
      pendingTerminalAction = nil
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
    case .transportInterrupted:
      banner = RoomBanner(
        title: "Connection interrupted",
        message: "Skyjo is reconnecting to the authoritative table.",
        tone: .information
      )
    case .resetRecoveryPersistenceFailed:
      banner = RoomBanner(
        title: "Room reset paused",
        message: "Recovery data could not be saved, so the room was not reset.",
        tone: .error
      )
    }
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
      await connection.setVisible(requestedVisibility)
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
    case "not-host": return "Only the room host can do that."
    case "not-your-turn": return "The active player changed. Review the table and try again."
    case "invalid-state": return "That action is no longer available in the current room state."
    case "room-full": return "This room already has eight players."
    case "game-started": return "This game has already started."
    case "room-not-found", "stale-room": return "That room is no longer available."
    case "seat-forbidden": return "This account cannot reclaim that saved seat."
    default: return "The server did not accept that action. Review the table and try again."
    }
  }

  private static func cleanRoomCode(_ input: String) -> String {
    let allowed = input.uppercased().unicodeScalars.filter {
      $0.isASCII && ($0.properties.isUppercase || $0.properties.numericType != nil)
    }
    return String(String.UnicodeScalarView(allowed.prefix(5)))
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
