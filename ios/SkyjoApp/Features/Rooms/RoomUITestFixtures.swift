#if DEBUG
import Foundation
import SkyjoNetworking

/// Repository-owned room states for deterministic XCUITest evidence. These fixtures
/// intentionally enter through `RoomConnection` as protocol-v2 server frames so the
/// app keeps exercising production decoding, redaction, revision, and pending-command
/// behavior. No room snapshot is injected directly into `RoomSessionModel`.
enum RoomUITestFixtureMode: String, Sendable {
  case admission
  case recoveryUnavailable = "recovery-unavailable"
  case cleanupRequired = "cleanup-required"
  case waiting
  case active
  case scoring
  case pending
  case offline
  case resync

  static func launchMode(arguments: [String]) -> Self? {
    guard let argument = arguments.first(where: { $0.hasPrefix("--ui-room-fixture=") }) else {
      return nil
    }
    return Self(rawValue: String(argument.dropFirst("--ui-room-fixture=".count)))
  }

  var startsWaiting: Bool {
    self == .admission || self == .cleanupRequired || self == .waiting
  }
  var startsScoring: Bool { self == .scoring }
  var startsWithSavedSeat: Bool {
    self != .admission && self != .cleanupRequired
  }
}

@MainActor
enum RoomUITestFixtureFactory {
  static func makeSessionHost(
    account: AccountUser,
    mode: RoomUITestFixtureMode
  ) -> RoomSessionHost {
    RoomSessionHost(account: account) { nextAccount in
      makeModel(account: nextAccount, mode: mode)
    }
  }

  private static func makeModel(
    account: AccountUser,
    mode: RoomUITestFixtureMode
  ) -> RoomSessionModel {
    let playerID = account.id.uuidString.lowercased()
    let seatStore: VolatileRoomSeatRecoveryStore
    if mode.startsWithSavedSeat {
      let record: RoomSeatRecoveryRecord
      do {
        record = try RoomSeatRecoveryRecord(
          accountID: account.id,
          roomCode: RoomUITestFixtureSnapshot.roomCode,
          playerID: playerID
        )
      } catch {
        preconditionFailure("The committed room UI fixture must use valid seat routing.")
      }
      seatStore = VolatileRoomSeatRecoveryStore(record: record)
    } else {
      seatStore = VolatileRoomSeatRecoveryStore()
    }

    return RoomSessionModel(
      account: account,
      environment: RoomSessionEnvironment(
        makeConnection: {
          let socket = RoomUITestFixtureSocket(mode: mode, localPlayerID: playerID)
          let connection = try RoomConnection(
            webSocketURL: URL(string: "wss://fixture.invalid/rooms")!,
            confirmedAccount: try ConfirmedRoomAccount(
              accountID: account.id,
              displayName: account.displayName
            ),
            environment: RoomConnectionEnvironment(
              makeSocket: { _ in socket },
              random: { 0.5 },
              makeUUID: {
                UUID(uuidString: "40000000-0000-4000-8000-000000000188")!
              },
              nowMilliseconds: { RoomUITestFixtureSnapshot.serverNow },
              connectivityUpdates: {
                AsyncStream { continuation in
                  continuation.yield(true)
                  continuation.finish()
                }
              }
            )
          )
          return RoomUITestFixtureConnection(base: connection, mode: mode)
        },
        createInvite: { _ in throw RoomUITestFixtureError.unavailable },
        seatStore: seatStore,
        nowMilliseconds: { RoomUITestFixtureSnapshot.serverNow }
      )
    )
  }
}

private enum RoomUITestFixtureError: Error {
  case socketClosed
  case invalidClientFrame
  case unavailable
}

/// Adapts deterministic connection-local failure states while every server-shaped
/// fixture still enters through the production connection actor and strict codec.
/// Offline yields the authoritative table before withdrawing availability. Cleanup
/// failure suppresses the validated table and connection status, then exposes the
/// same persistence-failure notice the production connection publishes.
private actor RoomUITestFixtureConnection: RoomSessionConnection {
  private let base: RoomConnection
  private let mode: RoomUITestFixtureMode

  init(base: RoomConnection, mode: RoomUITestFixtureMode) {
    self.base = base
    self.mode = mode
  }

  func events() async -> AsyncStream<RoomConnectionEvent> {
    let source = await base.events()
    let shouldBecomeOffline = mode == .offline
    let shouldRequireCleanup = mode == .cleanupRequired
    return AsyncStream(bufferingPolicy: .bufferingNewest(8)) { continuation in
      let forwardingTask = Task {
        var hasDeliveredOfflineSnapshot = false
        var hasDeliveredCleanupNotice = false
        for await event in source {
          guard !Task.isCancelled else { break }
          if shouldRequireCleanup {
            switch event {
            case .status:
              continue
            case .snapshot:
              if !hasDeliveredCleanupNotice {
                hasDeliveredCleanupNotice = true
                continuation.yield(.notice(.resetRecoveryPersistenceFailed))
              }
              continue
            case .notice:
              break
            }
          }
          continuation.yield(event)
          if shouldBecomeOffline,
             !hasDeliveredOfflineSnapshot,
             case .snapshot = event {
            hasDeliveredOfflineSnapshot = true
            await base.setNetworkAvailable(false)
          }
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in forwardingTask.cancel() }
    }
  }

  func currentAuthoritativeSnapshot() async -> AuthoritativeRoomSnapshot? {
    await base.snapshot()
  }

  func recoverPersistedReset(admissionAttemptID: UUID) async throws -> Bool {
    try await base.recoverPersistedReset(admissionAttemptID: admissionAttemptID)
  }

  func connect(_ admission: RoomAdmission, admissionAttemptID: UUID) async throws {
    try await base.connect(admission, admissionAttemptID: admissionAttemptID)
  }

  func recover(_ admission: RoomAdmission, admissionAttemptID: UUID) async throws {
    guard mode != .recoveryUnavailable else {
      throw RoomUITestFixtureError.unavailable
    }
    try await base.recover(admission, admissionAttemptID: admissionAttemptID)
  }

  func send(_ action: RoomCommandAction) async throws -> UUID {
    try await base.send(action)
  }

  func setVisible(_ visible: Bool) async {
    await base.setVisible(visible)
  }

  func resume() async {
    await base.resume()
  }

  func disconnect() async throws {
    try await base.disconnect()
  }

  func discardPersistedResetRecovery() async throws {
    try await base.discardPersistedResetRecovery()
  }

  func dispose() async {
    await base.dispose()
  }
}

private actor RoomUITestFixtureSocket: RoomWebSocket {
  private let mode: RoomUITestFixtureMode
  private let localPlayerID: String
  private var revision: Int64 = RoomUITestFixtureSnapshot.initialRevision
  private var readyPlayerIDs: [String]
  private var localChatMessages: [String] = []
  private var queuedMessages: [RoomWebSocketMessage] = []
  private var receiver: CheckedContinuation<RoomWebSocketMessage, Error>?
  private var isClosed = false

  init(mode: RoomUITestFixtureMode, localPlayerID: String) {
    self.mode = mode
    self.localPlayerID = localPlayerID
    readyPlayerIDs = mode.startsScoring
      ? RoomUITestFixtureSnapshot.playerIDs(localPlayerID: localPlayerID).filter {
        $0 != localPlayerID
      }
      : []
  }

  func start() {}

  func send(text: String) throws {
    guard let data = text.data(using: .utf8),
          let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = frame["type"] as? String
    else { throw RoomUITestFixtureError.invalidClientFrame }

    switch type {
    case "create-room", "join-room":
      if type == "join-room" {
        guard frame["code"] as? String == RoomUITestFixtureSnapshot.roomCode else {
          throw RoomUITestFixtureError.invalidClientFrame
        }
      }
      try enqueue(
        RoomUITestFixtureSnapshot.frame(
          mode: mode,
          localPlayerID: localPlayerID,
          revision: revision,
          readyPlayerIDs: readyPlayerIDs,
          includesChat: mode == .offline
        )
      )
      if mode != .offline {
        revision += 1
        try enqueue(
          RoomUITestFixtureSnapshot.frame(
            mode: mode,
            localPlayerID: localPlayerID,
            revision: revision,
            readyPlayerIDs: readyPlayerIDs,
            includesChat: true
          )
        )
      }
    case "set-presence":
      break
    case "command":
      try receiveCommand(frame)
    default:
      throw RoomUITestFixtureError.invalidClientFrame
    }
  }

  func receive() async throws -> RoomWebSocketMessage {
    if isClosed { throw RoomUITestFixtureError.socketClosed }
    if !queuedMessages.isEmpty { return queuedMessages.removeFirst() }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }

  func close(code _: Int, reason _: String) {
    isClosed = true
    receiver?.resume(throwing: RoomUITestFixtureError.socketClosed)
    receiver = nil
  }

  private func receiveCommand(_ frame: [String: Any]) throws {
    guard let commandID = frame["commandId"] as? String,
          let action = frame["action"] as? [String: Any],
          let actionType = action["type"] as? String
    else { throw RoomUITestFixtureError.invalidClientFrame }

    if mode == .pending { return }

    revision += 1
    if mode == .resync {
      try enqueue(
        RoomUITestFixtureSnapshot.frame(
          mode: .active,
          localPlayerID: localPlayerID,
          revision: revision,
          readyPlayerIDs: readyPlayerIDs,
          resyncCommandID: commandID
        )
      )
      return
    }

    if actionType == "set-next-round-ready", action["ready"] as? Bool == true {
      readyPlayerIDs = RoomUITestFixtureSnapshot.playerIDs(localPlayerID: localPlayerID)
    }
    if actionType == "send-chat-message" {
      guard let text = action["text"] as? String, !text.isEmpty else {
        throw RoomUITestFixtureError.invalidClientFrame
      }
      localChatMessages.append(text)
      localChatMessages = Array(localChatMessages.suffix(79))
    }

    try enqueue([
      "type": "ack",
      "protocolVersion": 2,
      "commandId": commandID,
      "revision": revision,
    ])
    try enqueue(
      RoomUITestFixtureSnapshot.frame(
        mode: mode,
        localPlayerID: localPlayerID,
        revision: revision,
        readyPlayerIDs: readyPlayerIDs,
        localChatMessages: localChatMessages
      )
    )
  }

  private func enqueue(_ object: [String: Any]) throws {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw RoomUITestFixtureError.invalidClientFrame
    }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let message = RoomWebSocketMessage.text(String(decoding: data, as: UTF8.self))
    if let receiver {
      self.receiver = nil
      receiver.resume(returning: message)
    } else {
      queuedMessages.append(message)
    }
  }
}

private enum RoomUITestFixtureSnapshot {
  static let roomCode = "ABCDE"
  static let initialRevision: Int64 = 7
  static let serverNow: Int64 = 1_900_000_000_000

  static func playerIDs(localPlayerID: String) -> [String] {
    [localPlayerID] + (2...8).map { "fixture-guest-\($0)" }
  }

  static func frame(
    mode: RoomUITestFixtureMode,
    localPlayerID: String,
    revision: Int64,
    readyPlayerIDs: [String],
    resyncCommandID: String? = nil,
    includesChat: Bool = true,
    localChatMessages: [String] = []
  ) -> [String: Any] {
    var value: [String: Any] = [
      "type": resyncCommandID == nil ? "snapshot" : "resync",
      "protocolVersion": 2,
      "playerId": localPlayerID,
      "revision": revision,
      "room": room(
        mode: mode,
        localPlayerID: localPlayerID,
        revision: revision,
        readyPlayerIDs: readyPlayerIDs,
        includesChat: includesChat,
        localChatMessages: localChatMessages
      ),
    ]
    if let resyncCommandID {
      value["reason"] = "stale-revision"
      value["commandId"] = resyncCommandID
    }
    return value
  }

  private static func room(
    mode: RoomUITestFixtureMode,
    localPlayerID: String,
    revision: Int64,
    readyPlayerIDs: [String],
    includesChat: Bool,
    localChatMessages: [String]
  ) -> [String: Any] {
    let ids = playerIDs(localPlayerID: localPlayerID)
    let names = ["Fixture User"] + (2...8).map { "Guest \($0)" }
    let players: [[String: Any]] = ids.enumerated().map { index, id in
      [
        "id": id,
        "name": names[index],
        "connected": true,
        "host": index == 0,
        "joinedAt": serverNow - Int64((8 - index) * 1_000),
        "lastSeenAt": serverNow,
        "controller": "human",
        "disconnectedAt": NSNull(),
        "aiTakeoverAt": NSNull(),
      ]
    }

    var chatMessages: [[String: Any]] = includesChat
      ? [[
        "id": "fixture-chat-1",
        "playerId": ids[1],
        "playerName": names[1],
        "text": "Eight-player table is ready.",
        "createdAt": serverNow - 2_000,
      ]]
      : []
    chatMessages += localChatMessages.enumerated().map { index, text in
      [
        "id": "fixture-local-chat-\(index + 1)",
        "playerId": localPlayerID,
        "playerName": names[0],
        "text": text,
        "createdAt": serverNow - 1_000 + Int64(index),
      ]
    }

    return [
      "code": roomCode,
      "hostId": localPlayerID,
      "players": players,
      "chatMessages": chatMessages,
      "readyForNextRoundPlayerIds": readyPlayerIDs,
      "state": mode.startsWaiting
        ? NSNull()
        : gameState(
          scoring: mode.startsScoring,
          playerIDs: ids,
          playerNames: names
        ),
      "status": mode.startsWaiting ? "waiting" : "playing",
      "updatedAt": serverNow,
      "completedGameId": NSNull(),
      "finishedByAi": false,
      "hostTransferAt": NSNull(),
      "revision": revision,
      "serverNow": serverNow,
    ]
  }

  private static func gameState(
    scoring: Bool,
    playerIDs: [String],
    playerNames: [String]
  ) -> [String: Any] {
    let players: [[String: Any]] = playerIDs.enumerated().map { playerIndex, playerID in
      let roundScore = scoring ? 12 + playerIndex : 0
      return [
        "id": playerID,
        "name": playerNames[playerIndex],
        "kind": "human",
        "grid": (0..<12).map { cardIndex in
          let faceUp = scoring || cardIndex < 2
          return [
            "id": "grid-\(playerIndex)-\(cardIndex)",
            "value": faceUp ? ((playerIndex + cardIndex) % 13) : NSNull(),
            "faceUp": faceUp,
            "removed": false,
          ] as [String: Any]
        },
        "totalScore": scoring ? 20 + roundScore : playerIndex * 3,
        "roundScore": roundScore,
      ]
    }
    let scoreRows: [[String: Any]] = playerIDs.enumerated().map { index, id in
      let roundScore = 12 + index
      return [
        "playerId": id,
        "name": playerNames[index],
        "roundScore": roundScore,
        "totalScore": 20 + roundScore,
      ]
    }

    return [
      "players": players,
      "drawPileCount": 47,
      "discardPile": [
        "count": 4,
        "top": [
          "id": "discard-top",
          "value": 9,
          "faceUp": true,
          "removed": false,
        ],
      ],
      "currentPlayerIndex": 0,
      "phase": scoring ? "round-over" : "choose-source",
      "selectedSource": NSNull(),
      "hasDrawnCard": false,
      "drawnCard": NSNull(),
      "round": 1,
      "log": [scoring ? "Round 1 is complete." : "Fixture User is choosing a card source."],
      "winnerId": NSNull(),
      "nextStarterId": scoring ? playerIDs[1] : NSNull(),
      "roundCloserId": scoring ? playerIDs[0] : NSNull(),
      "finalTurnPlayerIds": [],
      "openingRevealCounts": Dictionary(
        uniqueKeysWithValues: playerIDs.map { ($0, 2) }
      ),
      "roundHistory": scoring
        ? [["round": 1, "closerId": playerIDs[0], "scores": scoreRows]]
        : [],
    ]
  }
}
#endif
