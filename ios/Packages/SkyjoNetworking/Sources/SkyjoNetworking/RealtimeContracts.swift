import CoreFoundation
import Foundation
import SkyjoDomain

public enum RoomProtocolV2: Sendable {
  public static let protocolVersion = 2
  public static let presenceVersion = 1
  public static let snapshotEnvelopeVersion = 2
  public static let maximumClientFrameBytes = 16_384
  public static let maximumServerFrameBytes = 1_024 * 1_024
  public static let synchronizationTimeoutMilliseconds = 8_000
  public static let reconnectBaseDelayMilliseconds = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
}

public enum RoomConnectionContractError: Error, Equatable, Sendable {
  case invalidAdmission
  case invalidAction
  case invalidFrame
  case oversizedClientFrame
  case oversizedServerFrame
  case binaryServerFrame
}

public struct RoomResetRecovery: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let commandID: UUID
  public let expectedRevision: Int64

  public init(commandID: UUID, expectedRevision: Int64) {
    self.commandID = commandID
    self.expectedRevision = expectedRevision
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "RoomResetRecovery(<redacted>)" }
}

public enum RoomAdmission: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case create(displayName: String)
  case join(
    code: String,
    displayName: String,
    playerID: String? = nil,
    resetRecovery: RoomResetRecovery? = nil
  )


  public var description: String { debugDescription }
  public var debugDescription: String {
    switch self {
    case .create: return "RoomAdmission.create(<redacted>)"
    case .join(_, _, let playerID, let recovery):
      return "RoomAdmission.join(code: <redacted>, name: <redacted>, hasPlayerID: \(playerID != nil), hasResetRecovery: \(recovery != nil))"
    }
  }
}

public enum RoomCommandAction: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case revealOpeningCard(Int)
  case chooseDiscard
  case cancelDiscard
  case drawBlind
  case replaceCard(Int)
  case discardAndReveal(Int)
  case setNextRoundReady(Bool)
  case startGame
  case resetRoom
  case leaveRoom
  case removePlayer(String)
  case takeoverPlayerWithAI(String)
  case sendChatMessage(String)

  public var description: String { debugDescription }
  public var debugDescription: String {
    switch self {
    case .revealOpeningCard: return "RoomCommandAction.revealOpeningCard"
    case .chooseDiscard: return "RoomCommandAction.chooseDiscard"
    case .cancelDiscard: return "RoomCommandAction.cancelDiscard"
    case .drawBlind: return "RoomCommandAction.drawBlind"
    case .replaceCard: return "RoomCommandAction.replaceCard"
    case .discardAndReveal: return "RoomCommandAction.discardAndReveal"
    case .setNextRoundReady: return "RoomCommandAction.setNextRoundReady"
    case .startGame: return "RoomCommandAction.startGame"
    case .resetRoom: return "RoomCommandAction.resetRoom"
    case .leaveRoom: return "RoomCommandAction.leaveRoom"
    case .removePlayer: return "RoomCommandAction.removePlayer(<redacted>)"
    case .takeoverPlayerWithAI: return "RoomCommandAction.takeoverPlayerWithAI(<redacted>)"
    case .sendChatMessage(let text):
      return "RoomCommandAction.sendChatMessage(<redacted>, utf16Count: \(text.utf16.count))"
    }
  }
}

public enum RoomPlayerController: String, Codable, Equatable, Sendable {
  case human
  case ai
}

public enum PublicRoomStatus: String, Codable, Equatable, Sendable {
  case waiting
  case playing
  case finished
}

public struct PublicRoomPlayerSnapshot: Codable, Equatable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible {
  public let id: String
  public let name: String
  public let connected: Bool
  public let host: Bool
  public let joinedAt: Int64?
  public let lastSeenAt: Int64?
  public let controller: RoomPlayerController
  public let disconnectedAt: Int64?
  public let aiTakeoverAt: Int64?

  public var description: String { debugDescription }
  public var debugDescription: String {
    "PublicRoomPlayerSnapshot(id: <redacted>, name: <redacted>, connected: \(connected), host: \(host), controller: \(controller.rawValue))"
  }
}

public struct PublicRoomChatMessageSnapshot: Codable, Equatable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible {
  public let id: String
  public let playerId: String
  public let playerName: String
  public let text: String
  public let createdAt: Int64

  public var description: String { debugDescription }
  public var debugDescription: String {
    "PublicRoomChatMessageSnapshot(<redacted>, utf16Count: \(text.utf16.count))"
  }
}

public struct PublicRoomSnapshot: Codable, Equatable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible {
  public let code: String
  public let hostId: String
  public let players: [PublicRoomPlayerSnapshot]
  public let chatMessages: [PublicRoomChatMessageSnapshot]
  public let readyForNextRoundPlayerIds: [String]
  public let state: PublicGameStateSnapshot?
  public let status: PublicRoomStatus
  public let updatedAt: Int64
  public let completedGameId: String?
  public let finishedByAi: Bool
  public let hostTransferAt: Int64?
  public let revision: Int64
  public let serverNow: Int64

  public var description: String { debugDescription }
  public var debugDescription: String {
    "PublicRoomSnapshot(code: <redacted>, playerCount: \(players.count), status: \(status.rawValue), revision: \(revision), state: <redacted>)"
  }
}

public enum RoomResyncReason: String, Codable, Equatable, Sendable {
  case revisionMismatch = "revision-mismatch"
  case staleRevision = "stale-revision"
  case futureRevision = "future-revision"
  case roomReset = "room-reset"
  case completionRecovered = "completion-recovered"
}

public enum RoomAcknowledgementResult: String, Codable, Equatable, Sendable {
  case roomLeft = "room-left"
}

public struct RoomSnapshotFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let playerID: String?
  public let revision: Int64
  public let room: PublicRoomSnapshot

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RoomSnapshotFrame(playerID: <redacted>, revision: \(revision), room: <redacted>)"
  }
}

public struct RoomResyncFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let playerID: String
  public let revision: Int64
  public let room: PublicRoomSnapshot
  public let reason: RoomResyncReason
  public let commandID: UUID?

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RoomResyncFrame(playerID: <redacted>, revision: \(revision), reason: \(reason.rawValue), commandID: <redacted>, room: <redacted>)"
  }
}

public struct RoomAcknowledgementFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let commandID: UUID
  public let revision: Int64
  public let result: RoomAcknowledgementResult?

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RoomAcknowledgementFrame(commandID: <redacted>, revision: \(revision), result: \(result?.rawValue ?? "none"))"
  }
}

public struct RoomErrorFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let code: String
  public let message: String
  public let commandID: UUID?

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RoomErrorFrame(code: \(code), message: <redacted>, commandID: <redacted>)"
  }
}

public struct RoomUpgradeRequiredFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let message: String
  public let commandID: UUID?

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RoomUpgradeRequiredFrame(message: <redacted>, commandID: <redacted>)"
  }
}

public enum RoomServerFrame: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case snapshot(RoomSnapshotFrame)
  case resync(RoomResyncFrame)
  case acknowledgement(RoomAcknowledgementFrame)
  case error(RoomErrorFrame)
  case upgradeRequired(RoomUpgradeRequiredFrame)

  public var description: String { debugDescription }
  public var debugDescription: String {
    switch self {
    case .snapshot(let frame):
      return "RoomServerFrame.snapshot(revision: \(frame.revision), room: <redacted>)"
    case .resync(let frame):
      return "RoomServerFrame.resync(revision: \(frame.revision), reason: \(frame.reason.rawValue), room: <redacted>)"
    case .acknowledgement(let frame):
      return "RoomServerFrame.acknowledgement(commandID: <redacted>, revision: \(frame.revision))"
    case .error(let frame):
      return "RoomServerFrame.error(code: \(frame.code), commandID: <redacted>)"
    case .upgradeRequired:
      return "RoomServerFrame.upgradeRequired"
    }
  }
}

public enum RealtimeFrameCodec {
  public static func encodeAdmission(_ admission: RoomAdmission) throws -> String {
    let value: [String: Any]
    switch admission {
    case .create(let displayName):
      guard isBoundedString(displayName, maximum: 24) else {
        throw RoomConnectionContractError.invalidAdmission
      }
      value = [
        "type": "create-room",
        "protocolVersion": RoomProtocolV2.protocolVersion,
        "snapshotEnvelopeVersion": RoomProtocolV2.snapshotEnvelopeVersion,
        "name": displayName,
      ]
    case .join(let code, let displayName, let playerID, let resetRecovery):
      guard isRoomCode(code), isBoundedString(displayName, maximum: 24) else {
        throw RoomConnectionContractError.invalidAdmission
      }
      if let playerID, !isIdentifier(playerID) {
        throw RoomConnectionContractError.invalidAdmission
      }
      guard resetRecovery == nil || playerID != nil,
            resetRecovery.map({
              isSafeInteger($0.expectedRevision) && isContractUUID($0.commandID)
            }) ?? true
      else {
        throw RoomConnectionContractError.invalidAdmission
      }
      var join: [String: Any] = [
        "type": "join-room",
        "protocolVersion": RoomProtocolV2.protocolVersion,
        "presenceVersion": RoomProtocolV2.presenceVersion,
        "snapshotEnvelopeVersion": RoomProtocolV2.snapshotEnvelopeVersion,
        "code": code,
        "name": displayName,
      ]
      if let playerID { join["playerId"] = playerID }
      if let resetRecovery {
        join["recoveryCommandId"] = resetRecovery.commandID.uuidString.lowercased()
      }
      value = join
    }
    return try encodeClientObject(value)
  }

  public static func encodePresence(visible: Bool) throws -> String {
    try encodeClientObject(["type": "set-presence", "visible": visible])
  }

  public static func encodeCommand(
    commandID: UUID,
    expectedRevision: Int64,
    action: RoomCommandAction
  ) throws -> String {
    guard isContractUUID(commandID), isSafeInteger(expectedRevision) else {
      throw RoomConnectionContractError.invalidAction
    }
    let value: [String: Any] = [
      "type": "command",
      "protocolVersion": RoomProtocolV2.protocolVersion,
      "commandId": commandID.uuidString.lowercased(),
      "expectedRevision": expectedRevision,
      "action": try actionObject(action),
    ]
    return try encodeClientObject(value)
  }

  public static func validateClientFrame(_ data: Data) throws {
    guard data.count <= RoomProtocolV2.maximumClientFrameBytes else {
      throw RoomConnectionContractError.oversizedClientFrame
    }
    let root = try object(from: data)
    guard let type = root["type"] as? String else {
      throw RoomConnectionContractError.invalidFrame
    }
    switch type {
    case "create-room":
      let keys = Set(root.keys)
      guard keys == ["type", "protocolVersion", "name"] ||
              keys == ["type", "protocolVersion", "snapshotEnvelopeVersion", "name"],
            int(root["protocolVersion"]) == 2,
            root["snapshotEnvelopeVersion"] == nil || int(root["snapshotEnvelopeVersion"]) == 2,
            isBoundedString(root["name"], maximum: 24)
      else { throw RoomConnectionContractError.invalidFrame }
    case "join-room":
      var expected: Set<String> = ["type", "protocolVersion", "code", "name"]
      for key in ["presenceVersion", "snapshotEnvelopeVersion", "playerId", "recoveryCommandId"] {
        if root[key] != nil { expected.insert(key) }
      }
      guard Set(root.keys) == expected,
            int(root["protocolVersion"]) == 2,
            root["presenceVersion"] == nil || int(root["presenceVersion"]) == 1,
            root["snapshotEnvelopeVersion"] == nil || int(root["snapshotEnvelopeVersion"]) == 2,
            isRoomCode(root["code"]),
            isBoundedString(root["name"], maximum: 24),
            root["playerId"] == nil || isIdentifier(root["playerId"]),
            root["recoveryCommandId"] == nil ||
              (isUUID(root["recoveryCommandId"]) && root["playerId"] != nil)
      else { throw RoomConnectionContractError.invalidFrame }
    case "set-presence":
      guard exactKeys(root, ["type", "visible"]), root["visible"] is Bool else {
        throw RoomConnectionContractError.invalidFrame
      }
    case "command":
      guard exactKeys(root, ["type", "protocolVersion", "commandId", "expectedRevision", "action"]),
            int(root["protocolVersion"]) == 2,
            isUUID(root["commandId"]),
            isSafeInteger(int64(root["expectedRevision"])),
            let action = root["action"] as? [String: Any]
      else { throw RoomConnectionContractError.invalidFrame }
      try validateActionObject(action)
    default:
      throw RoomConnectionContractError.invalidFrame
    }
  }

  public static func decodeServerFrame(_ data: Data) throws -> RoomServerFrame {
    guard data.count <= RoomProtocolV2.maximumServerFrameBytes else {
      throw RoomConnectionContractError.oversizedServerFrame
    }
    let root = try object(from: data)
    guard int(root["protocolVersion"]) == RoomProtocolV2.protocolVersion,
          let type = root["type"] as? String
    else { throw RoomConnectionContractError.invalidFrame }

    let decoder = JSONDecoder()
    switch type {
    case "snapshot":
      let personalized = root["playerId"] != nil
      guard exactKeys(
        root,
        personalized
          ? ["type", "protocolVersion", "playerId", "revision", "room"]
          : ["type", "protocolVersion", "revision", "room"]
      ), let revision = safeInteger(root["revision"]),
         let roomObject = root["room"] as? [String: Any]
      else { throw RoomConnectionContractError.invalidFrame }
      let playerID = root["playerId"] as? String
      if personalized && !isIdentifier(playerID) {
        throw RoomConnectionContractError.invalidFrame
      }
      try validateRoom(roomObject, revision: revision, viewerPlayerID: playerID)
      let roomData = try JSONSerialization.data(withJSONObject: roomObject, options: [.sortedKeys])
      let room = try decoder.decode(PublicRoomSnapshot.self, from: roomData)
      do {
        try room.state?.validate(viewerPlayerId: playerID)
      } catch {
        throw RoomConnectionContractError.invalidFrame
      }
      return .snapshot(RoomSnapshotFrame(playerID: playerID, revision: revision, room: room))
    case "resync":
      var keys = ["type", "protocolVersion", "playerId", "revision", "room", "reason"]
      if root["commandId"] != nil { keys.append("commandId") }
      guard exactKeys(root, keys),
            let playerID = root["playerId"] as? String, isIdentifier(playerID),
            let revision = safeInteger(root["revision"]),
            let reasonRaw = root["reason"] as? String,
            let reason = RoomResyncReason(rawValue: reasonRaw),
            root["commandId"] == nil || isUUID(root["commandId"]),
            let roomObject = root["room"] as? [String: Any]
      else { throw RoomConnectionContractError.invalidFrame }
      try validateRoom(roomObject, revision: revision, viewerPlayerID: playerID)
      let roomData = try JSONSerialization.data(withJSONObject: roomObject, options: [.sortedKeys])
      let room = try decoder.decode(PublicRoomSnapshot.self, from: roomData)
      do {
        try room.state?.validate(viewerPlayerId: playerID)
      } catch {
        throw RoomConnectionContractError.invalidFrame
      }
      let commandID = (root["commandId"] as? String).flatMap(UUID.init(uuidString:))
      return .resync(RoomResyncFrame(
        playerID: playerID,
        revision: revision,
        room: room,
        reason: reason,
        commandID: commandID
      ))
    case "ack":
      var keys = ["type", "protocolVersion", "commandId", "revision"]
      if root["result"] != nil { keys.append("result") }
      guard exactKeys(root, keys),
            let commandRaw = root["commandId"] as? String,
            isUUID(commandRaw),
            let commandID = UUID(uuidString: commandRaw),
            let revision = safeInteger(root["revision"]),
            root["result"] == nil || root["result"] as? String == RoomAcknowledgementResult.roomLeft.rawValue
      else { throw RoomConnectionContractError.invalidFrame }
      return .acknowledgement(RoomAcknowledgementFrame(
        commandID: commandID,
        revision: revision,
        result: (root["result"] as? String).flatMap(RoomAcknowledgementResult.init(rawValue:))
      ))
    case "error":
      var keys = ["type", "protocolVersion", "code", "message"]
      if root["commandId"] != nil { keys.append("commandId") }
      guard exactKeys(root, keys),
            let code = root["code"] as? String, isErrorCode(code),
            let message = root["message"] as? String, isBoundedString(message, maximum: 512),
            root["commandId"] == nil || isUUID(root["commandId"])
      else { throw RoomConnectionContractError.invalidFrame }
      return .error(RoomErrorFrame(
        code: code,
        message: message,
        commandID: (root["commandId"] as? String).flatMap(UUID.init(uuidString:))
      ))
    case "upgrade-required":
      var keys = ["type", "protocolVersion", "message"]
      if root["commandId"] != nil { keys.append("commandId") }
      guard exactKeys(root, keys),
            let message = root["message"] as? String, isBoundedString(message, maximum: 512),
            root["commandId"] == nil || isUUID(root["commandId"])
      else { throw RoomConnectionContractError.invalidFrame }
      return .upgradeRequired(RoomUpgradeRequiredFrame(
        message: message,
        commandID: (root["commandId"] as? String).flatMap(UUID.init(uuidString:))
      ))
    default:
      throw RoomConnectionContractError.invalidFrame
    }
  }

  private static func actionObject(_ action: RoomCommandAction) throws -> [String: Any] {
    switch action {
    case .revealOpeningCard(let index):
      guard (0..<12).contains(index) else { throw RoomConnectionContractError.invalidAction }
      return ["type": "reveal-opening-card", "cardIndex": index]
    case .chooseDiscard: return ["type": "choose-discard"]
    case .cancelDiscard: return ["type": "cancel-discard"]
    case .drawBlind: return ["type": "draw-blind"]
    case .replaceCard(let index):
      guard (0..<12).contains(index) else { throw RoomConnectionContractError.invalidAction }
      return ["type": "replace-card", "cardIndex": index]
    case .discardAndReveal(let index):
      guard (0..<12).contains(index) else { throw RoomConnectionContractError.invalidAction }
      return ["type": "discard-and-reveal", "cardIndex": index]
    case .setNextRoundReady(let ready):
      return ["type": "set-next-round-ready", "ready": ready]
    case .startGame: return ["type": "start-game"]
    case .resetRoom: return ["type": "reset-room"]
    case .leaveRoom: return ["type": "leave-room"]
    case .removePlayer(let playerID):
      guard isIdentifier(playerID) else { throw RoomConnectionContractError.invalidAction }
      return ["type": "remove-player", "playerId": playerID]
    case .takeoverPlayerWithAI(let playerID):
      guard isIdentifier(playerID) else { throw RoomConnectionContractError.invalidAction }
      return ["type": "takeover-player-with-ai", "playerId": playerID]
    case .sendChatMessage(let text):
      guard text.utf16.count <= 280 else {
        throw RoomConnectionContractError.invalidAction
      }
      return ["type": "send-chat-message", "text": text]
    }
  }

  private static func validateActionObject(_ action: [String: Any]) throws {
    guard let type = action["type"] as? String else {
      throw RoomConnectionContractError.invalidFrame
    }
    switch type {
    case "reveal-opening-card", "replace-card", "discard-and-reveal":
      guard exactKeys(action, ["type", "cardIndex"]),
            let index = int(action["cardIndex"]), (0..<12).contains(index)
      else { throw RoomConnectionContractError.invalidFrame }
    case "choose-discard", "cancel-discard", "draw-blind", "start-game", "reset-room", "leave-room":
      guard exactKeys(action, ["type"]) else { throw RoomConnectionContractError.invalidFrame }
    case "set-next-round-ready":
      guard exactKeys(action, ["type", "ready"]), action["ready"] is Bool else {
        throw RoomConnectionContractError.invalidFrame
      }
    case "remove-player", "takeover-player-with-ai":
      guard exactKeys(action, ["type", "playerId"]), isIdentifier(action["playerId"]) else {
        throw RoomConnectionContractError.invalidFrame
      }
    case "send-chat-message":
      guard exactKeys(action, ["type", "text"]),
            let text = action["text"] as? String, text.utf16.count <= 280
      else { throw RoomConnectionContractError.invalidFrame }
    default:
      throw RoomConnectionContractError.invalidFrame
    }
  }

  private static func validateRoom(
    _ room: [String: Any],
    revision: Int64,
    viewerPlayerID: String?
  ) throws {
    guard exactKeys(room, [
      "code", "hostId", "players", "chatMessages", "readyForNextRoundPlayerIds",
      "state", "status", "updatedAt", "completedGameId", "finishedByAi",
      "hostTransferAt", "revision", "serverNow",
    ]), isRoomCode(room["code"]), isIdentifier(room["hostId"]),
      let roomRevision = safeInteger(room["revision"]), roomRevision == revision,
      let updatedAt = safeInteger(room["updatedAt"]), updatedAt >= 0,
      let serverNow = safeInteger(room["serverNow"]), serverNow >= 0,
      room["completedGameId"] is NSNull || isIdentifier(room["completedGameId"]),
      room["hostTransferAt"] is NSNull || safeInteger(room["hostTransferAt"]) != nil,
      room["finishedByAi"] is Bool,
      let statusRaw = room["status"] as? String, PublicRoomStatus(rawValue: statusRaw) != nil,
      let players = room["players"] as? [[String: Any]], (1...8).contains(players.count)
    else { throw RoomConnectionContractError.invalidFrame }

    try players.forEach(validateRoomPlayer)
    let playerIDs = players.compactMap { $0["id"] as? String }
    guard playerIDs.count == players.count, Set(playerIDs).count == playerIDs.count,
          let hostID = room["hostId"] as? String, playerIDs.contains(hostID),
          players.filter({ $0["host"] as? Bool == true }).count == 1,
          players.first(where: { $0["host"] as? Bool == true })?["id"] as? String == hostID,
          viewerPlayerID == nil || playerIDs.contains(viewerPlayerID!)
    else { throw RoomConnectionContractError.invalidFrame }

    guard let chat = room["chatMessages"] as? [[String: Any]], chat.count <= 80 else {
      throw RoomConnectionContractError.invalidFrame
    }
    try chat.forEach { try validateChatMessage($0, playerIDs: Set(playerIDs)) }

    guard let ready = room["readyForNextRoundPlayerIds"] as? [Any], ready.count <= 8,
          ready.allSatisfy({ isIdentifier($0) && playerIDs.contains($0 as! String) }),
          Set(ready.compactMap { $0 as? String }).count == ready.count
    else { throw RoomConnectionContractError.invalidFrame }

    if room["state"] is NSNull { return }
    guard let state = room["state"] as? [String: Any] else {
      throw RoomConnectionContractError.invalidFrame
    }
    try validateGameState(state, roomPlayerIDs: playerIDs, viewerPlayerID: viewerPlayerID)
  }

  private static func validateRoomPlayer(_ player: [String: Any]) throws {
    var keys: Set<String> = [
      "id", "name", "connected", "host", "controller", "disconnectedAt", "aiTakeoverAt",
    ]
    if player["joinedAt"] != nil { keys.insert("joinedAt") }
    if player["lastSeenAt"] != nil { keys.insert("lastSeenAt") }
    guard Set(player.keys) == keys, isIdentifier(player["id"]),
          isBoundedString(player["name"], maximum: 24),
          let connected = player["connected"] as? Bool, player["host"] is Bool,
          let controller = player["controller"] as? String,
          RoomPlayerController(rawValue: controller) != nil,
          player["joinedAt"] == nil || safeInteger(player["joinedAt"]) != nil,
          player["lastSeenAt"] == nil || safeInteger(player["lastSeenAt"]) != nil,
          player["disconnectedAt"] is NSNull || safeInteger(player["disconnectedAt"]) != nil,
          player["aiTakeoverAt"] is NSNull || safeInteger(player["aiTakeoverAt"]) != nil,
          connected ? player["disconnectedAt"] is NSNull : !(player["disconnectedAt"] is NSNull)
    else { throw RoomConnectionContractError.invalidFrame }
    if !(player["aiTakeoverAt"] is NSNull) {
      guard connected == false, controller == "human",
            let takeover = safeInteger(player["aiTakeoverAt"]),
            let disconnected = safeInteger(player["disconnectedAt"]), takeover >= disconnected
      else { throw RoomConnectionContractError.invalidFrame }
    }
  }

  private static func validateChatMessage(
    _ message: [String: Any],
    playerIDs: Set<String>
  ) throws {
    guard exactKeys(message, ["id", "playerId", "playerName", "text", "createdAt"]),
          isIdentifier(message["id"]),
          let playerID = message["playerId"] as? String, isIdentifier(playerID), playerIDs.contains(playerID),
          isBoundedString(message["playerName"], maximum: 24),
          isBoundedString(message["text"], maximum: 280),
          safeInteger(message["createdAt"]) != nil
    else { throw RoomConnectionContractError.invalidFrame }
  }

  private static func validateGameState(
    _ state: [String: Any],
    roomPlayerIDs: [String],
    viewerPlayerID: String?
  ) throws {
    guard exactKeys(state, [
      "players", "drawPileCount", "discardPile", "currentPlayerIndex", "phase",
      "selectedSource", "hasDrawnCard", "drawnCard", "round", "log", "winnerId",
      "nextStarterId", "roundCloserId", "finalTurnPlayerIds", "openingRevealCounts",
      "roundHistory",
    ]), let players = state["players"] as? [[String: Any]], (1...8).contains(players.count),
      let currentIndex = int(state["currentPlayerIndex"]), players.indices.contains(currentIndex),
      let phase = state["phase"] as? String,
      ["opening-reveal", "choose-source", "choose-replacement", "round-over", "game-over"].contains(phase),
      state["selectedSource"] is NSNull || ["draw", "discard"].contains(state["selectedSource"] as? String),
      let hasDrawnCard = state["hasDrawnCard"] as? Bool,
      let round = safeInteger(state["round"]), round >= 1,
      let drawCount = safeInteger(state["drawPileCount"]), (0...150).contains(drawCount),
      let discard = state["discardPile"] as? [String: Any],
      exactKeys(discard, ["count", "top"]),
      let discardCount = safeInteger(discard["count"]), (0...150).contains(discardCount)
    else { throw RoomConnectionContractError.invalidFrame }

    for (playerIndex, player) in players.enumerated() {
      try validateGamePlayer(player, playerIndex: playerIndex)
    }
    let gamePlayerIDs = players.compactMap { $0["id"] as? String }
    guard gamePlayerIDs == roomPlayerIDs else { throw RoomConnectionContractError.invalidFrame }

    if discardCount == 0 {
      guard discard["top"] is NSNull else { throw RoomConnectionContractError.invalidFrame }
    } else {
      guard let top = discard["top"] as? [String: Any] else {
        throw RoomConnectionContractError.invalidFrame
      }
      try validateCard(top, expectedID: "discard-top")
    }

    let selectedSource = state["selectedSource"] as? String
    guard hasDrawnCard == (phase == "choose-replacement" && selectedSource == "draw") else {
      throw RoomConnectionContractError.invalidFrame
    }
    let activeID = gamePlayerIDs[currentIndex]
    let viewerShouldSeeDrawn = hasDrawnCard && viewerPlayerID == activeID
    if state["drawnCard"] is NSNull {
      guard !viewerShouldSeeDrawn else { throw RoomConnectionContractError.invalidFrame }
    } else {
      guard viewerShouldSeeDrawn, let drawn = state["drawnCard"] as? [String: Any] else {
        throw RoomConnectionContractError.invalidFrame
      }
      try validateCard(drawn, expectedID: "drawn-card")
    }

    guard let log = state["log"] as? [Any], log.count <= 8,
          log.allSatisfy({ item in
            guard let item = item as? String, item.utf16.count <= 320 else { return false }
            return item.range(
              of: #"^.+ drew a -?\d+\.$"#,
              options: .regularExpression
            ) == nil
          }),
          nullableIdentifier(state["winnerId"]), nullableIdentifier(state["nextStarterId"]),
          nullableIdentifier(state["roundCloserId"]),
          let finalIDs = state["finalTurnPlayerIds"] as? [Any], finalIDs.count <= 8,
          finalIDs.allSatisfy({ isIdentifier($0) && gamePlayerIDs.contains($0 as! String) }),
          Set(finalIDs.compactMap { $0 as? String }).count == finalIDs.count,
          let opening = state["openingRevealCounts"] as? [String: Any], opening.count <= 8,
          opening.allSatisfy({ gamePlayerIDs.contains($0.key) && (0...2).contains(int($0.value) ?? -1) }),
          let history = state["roundHistory"] as? [[String: Any]], history.count <= 100
    else { throw RoomConnectionContractError.invalidFrame }
    try history.forEach { try validateRoundHistory($0, playerIDs: gamePlayerIDs) }
  }

  private static func validateGamePlayer(_ player: [String: Any], playerIndex: Int) throws {
    guard exactKeys(player, ["id", "name", "kind", "grid", "totalScore", "roundScore"]),
          isIdentifier(player["id"]), isBoundedString(player["name"], maximum: 24),
          ["human", "ai"].contains(player["kind"] as? String),
          score(player["totalScore"]) != nil, score(player["roundScore"]) != nil,
          let grid = player["grid"] as? [[String: Any]], grid.count == 12
    else { throw RoomConnectionContractError.invalidFrame }
    for (cardIndex, card) in grid.enumerated() {
      try validateCard(card, expectedID: "grid-\(playerIndex)-\(cardIndex)")
    }
  }

  private static func validateCard(_ card: [String: Any], expectedID: String) throws {
    guard exactKeys(card, ["id", "value", "faceUp", "removed"]),
          card["id"] as? String == expectedID,
          let faceUp = card["faceUp"] as? Bool, card["removed"] is Bool
    else { throw RoomConnectionContractError.invalidFrame }
    if faceUp {
      guard let value = int(card["value"]), (-2...12).contains(value) else {
        throw RoomConnectionContractError.invalidFrame
      }
    } else if !(card["value"] is NSNull) {
      throw RoomConnectionContractError.invalidFrame
    }
  }

  private static func validateRoundHistory(_ entry: [String: Any], playerIDs: [String]) throws {
    guard exactKeys(entry, ["round", "closerId", "scores"]),
          let round = safeInteger(entry["round"]), round >= 1,
          let closer = entry["closerId"] as? String, playerIDs.contains(closer),
          let scores = entry["scores"] as? [[String: Any]], (1...8).contains(scores.count)
    else { throw RoomConnectionContractError.invalidFrame }
    for value in scores {
      guard exactKeys(value, ["playerId", "name", "roundScore", "totalScore"]),
            let playerID = value["playerId"] as? String, playerIDs.contains(playerID),
            isBoundedString(value["name"], maximum: 24),
            score(value["roundScore"]) != nil, score(value["totalScore"]) != nil
      else { throw RoomConnectionContractError.invalidFrame }
    }
  }

  private static func encodeClientObject(_ object: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    guard data.count <= RoomProtocolV2.maximumClientFrameBytes else {
      throw RoomConnectionContractError.oversizedClientFrame
    }
    return String(decoding: data, as: UTF8.self)
  }

  private static func object(from data: Data) throws -> [String: Any] {
    do {
      guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw RoomConnectionContractError.invalidFrame
      }
      return value
    } catch let error as RoomConnectionContractError {
      throw error
    } catch {
      throw RoomConnectionContractError.invalidFrame
    }
  }

  private static func exactKeys(_ value: [String: Any], _ keys: [String]) -> Bool {
    Set(value.keys) == Set(keys) && value.keys.count == keys.count
  }

  private static func isBoundedString(_ value: Any?, maximum: Int) -> Bool {
    guard let value = value as? String else { return false }
    return isBoundedString(value, maximum: maximum)
  }

  private static func isBoundedString(_ value: String, maximum: Int) -> Bool {
    !value.isEmpty && value.utf16.count <= maximum
  }

  private static func isIdentifier(_ value: Any?) -> Bool {
    guard let value = value as? String else { return false }
    return isIdentifier(value)
  }

  private static func isIdentifier(_ value: String?) -> Bool {
    guard let value, isBoundedString(value, maximum: 128) else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
      scalar.value > 0x1F && scalar.value != 0x7F
    }
  }

  private static func nullableIdentifier(_ value: Any?) -> Bool {
    value is NSNull || isIdentifier(value)
  }

  private static func isRoomCode(_ value: Any?) -> Bool {
    guard let value = value as? String else { return false }
    return isRoomCode(value)
  }

  private static func isRoomCode(_ value: String) -> Bool {
    value.utf8.count == 5 && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0)
    }
  }

  private static func isUUID(_ value: Any?) -> Bool {
    guard let value = value as? String else { return false }
    return isUUID(value)
  }

  static func isContractUUID(_ value: UUID) -> Bool {
    isUUID(value.uuidString)
  }

  private static func isUUID(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 36,
          bytes[8] == 45, bytes[13] == 45, bytes[18] == 45, bytes[23] == 45,
          (49...56).contains(bytes[14]),
          [56, 57, 65, 66, 97, 98].contains(bytes[19])
    else { return false }
    return bytes.enumerated().allSatisfy { index, byte in
      if [8, 13, 18, 23].contains(index) { return byte == 45 }
      return (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte)
    }
  }

  private static func isErrorCode(_ value: String) -> Bool {
    guard (1...128).contains(value.utf8.count),
          let first = value.utf8.first, (97...122).contains(first)
    else { return false }
    return value.utf8.dropFirst().allSatisfy {
      (97...122).contains($0) || (48...57).contains($0) || $0 == 45
    }
  }

  private static func int(_ value: Any?) -> Int? {
    guard let integer = int64(value),
          integer >= Int64(Int.min), integer <= Int64(Int.max)
    else { return nil }
    return Int(integer)
  }

  private static func int64(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
    var decimal = number.decimalValue
    guard !NSDecimalIsNotANumber(&decimal) else { return nil }
    var integral = Decimal()
    NSDecimalRound(&integral, &decimal, 0, .plain)
    guard integral == decimal,
          integral >= Decimal(Int64.min), integral <= Decimal(Int64.max)
    else { return nil }
    return NSDecimalNumber(decimal: integral).int64Value
  }

  private static func safeInteger(_ value: Any?) -> Int64? {
    guard let value = int64(value), isSafeInteger(value) else { return nil }
    return value
  }

  private static func isSafeInteger(_ value: Int64?) -> Bool {
    guard let value else { return false }
    return (0...9_007_199_254_740_991).contains(value)
  }

  private static func score(_ value: Any?) -> Int64? {
    guard let value = int64(value), (-1_000_000_000...1_000_000_000).contains(value) else {
      return nil
    }
    return value
  }
}
