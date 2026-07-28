import Foundation

public struct ConfirmedRoomAccount: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let accountID: UUID
  public let displayName: String

  public init(accountID: UUID, displayName: String) throws {
    guard RealtimeFrameCodec.isContractUUID(accountID),
          !displayName.isEmpty,
          displayName.utf16.count <= 24
    else {
      throw RoomConnectionContractError.invalidAdmission
    }
    self.accountID = accountID
    self.displayName = displayName
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "ConfirmedRoomAccount(<redacted>)" }
}

public struct RoomResetRecoveryRecord: Codable, Equatable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible {
  public let accountID: UUID
  public let roomCode: String
  public let playerID: String
  public let commandID: UUID
  public let expectedRevision: Int64

  public init(
    accountID: UUID,
    roomCode: String,
    playerID: String,
    commandID: UUID,
    expectedRevision: Int64
  ) throws {
    guard RealtimeFrameCodec.isContractUUID(accountID),
          RealtimeFrameCodec.isContractUUID(commandID)
    else { throw RoomConnectionContractError.invalidAdmission }
    let validationAdmission = RoomAdmission.join(
      code: roomCode,
      displayName: "Validated",
      playerID: playerID,
      resetRecovery: RoomResetRecovery(
        commandID: commandID,
        expectedRevision: expectedRevision
      )
    )
    _ = try RealtimeFrameCodec.encodeAdmission(validationAdmission)
    self.accountID = accountID
    self.roomCode = roomCode
    self.playerID = playerID
    self.commandID = commandID
    self.expectedRevision = expectedRevision
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      accountID: container.decode(UUID.self, forKey: .accountID),
      roomCode: container.decode(String.self, forKey: .roomCode),
      playerID: container.decode(String.self, forKey: .playerID),
      commandID: container.decode(UUID.self, forKey: .commandID),
      expectedRevision: container.decode(Int64.self, forKey: .expectedRevision)
    )
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "RoomResetRecoveryRecord(<redacted>)" }

  private enum CodingKeys: String, CodingKey {
    case accountID
    case roomCode
    case playerID
    case commandID
    case expectedRevision
  }
}

public protocol RoomResetRecoveryStore: Sendable {
  func load(accountID: UUID) async throws -> RoomResetRecoveryRecord?
  func save(_ record: RoomResetRecoveryRecord) async throws
  func clear(accountID: UUID, commandID: UUID) async throws
  /// Explicitly discards recovery state owned by an account. Unlike `clear`, this
  /// is a user-directed escape hatch for malformed records whose command ID
  /// cannot be decoded, and must not remove a valid record for another account.
  func discard(accountID: UUID) async throws
}

public actor VolatileRoomResetRecoveryStore: RoomResetRecoveryStore {
  private var record: RoomResetRecoveryRecord?

  public init() {}

  public func load(accountID: UUID) -> RoomResetRecoveryRecord? {
    guard record?.accountID == accountID else { return nil }
    return record
  }

  public func save(_ record: RoomResetRecoveryRecord) throws {
    self.record = try RoomResetRecoveryRecord(
      accountID: record.accountID,
      roomCode: record.roomCode,
      playerID: record.playerID,
      commandID: record.commandID,
      expectedRevision: record.expectedRevision
    )
  }

  public func clear(accountID: UUID, commandID: UUID) {
    guard record?.accountID == accountID, record?.commandID == commandID else { return }
    record = nil
  }

  public func discard(accountID: UUID) {
    guard record?.accountID == accountID else { return }
    record = nil
  }
}

public actor FileRoomResetRecoveryStore: RoomResetRecoveryStore {
  public static let maximumRecordBytes = 4 * 1_024
  private static let fileSystemLock = NSLock()
  private static let sharedApplicationSupportStore: FileRoomResetRecoveryStore = {
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first ?? FileManager.default.temporaryDirectory
    return FileRoomResetRecoveryStore(
      fileURL: root
        .appending(path: "SkyjoNative", directoryHint: .isDirectory)
        .appending(path: "room-reset-recovery-v1.json", directoryHint: .notDirectory)
    )
  }()

  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public static func applicationSupportStore() -> FileRoomResetRecoveryStore {
    sharedApplicationSupportStore
  }

  public func load(accountID: UUID) throws -> RoomResetRecoveryRecord? {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    guard let stored = try loadStoredRecord(), stored.accountID == accountID else { return nil }
    return stored
  }

  public func save(_ record: RoomResetRecoveryRecord) throws {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    try validateFileURL()
    let validatedRecord = try RoomResetRecoveryRecord(
      accountID: record.accountID,
      roomCode: record.roomCode,
      playerID: record.playerID,
      commandID: record.commandID,
      expectedRevision: record.expectedRevision
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(validatedRecord)
    guard data.count <= Self.maximumRecordBytes else {
      throw RoomConnectionContractError.invalidAdmission
    }
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: nil
    )
    try data.write(to: fileURL, options: [.atomic])
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: fileURL.path
    )
  }

  public func clear(accountID: UUID, commandID: UUID) throws {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    guard let stored = try loadStoredRecord(),
          stored.accountID == accountID,
          stored.commandID == commandID
    else { return }
    do {
      try FileManager.default.removeItem(at: fileURL)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }

  public func discard(accountID: UUID) throws {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    let shouldRemove: Bool
    do {
      guard let stored = try loadStoredRecord() else { return }
      shouldRemove = stored.accountID == accountID
    } catch {
      // A malformed single-record file has no trustworthy account or command
      // identity. Explicit Forget is the only path allowed to remove it.
      shouldRemove = true
    }
    guard shouldRemove else { return }
    do {
      try FileManager.default.removeItem(at: fileURL)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }

  private func loadStoredRecord() throws -> RoomResetRecoveryRecord? {
    try validateFileURL()
    let attributes: [FileAttributeKey: Any]
    do {
      attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return nil
    }
    guard let byteCount = attributes[.size] as? NSNumber,
          byteCount.intValue >= 0,
          byteCount.intValue <= Self.maximumRecordBytes
    else { throw RoomConnectionContractError.invalidAdmission }
    let data = try Data(contentsOf: fileURL)
    guard data.count <= Self.maximumRecordBytes,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == [
            "accountID", "roomCode", "playerID", "commandID", "expectedRevision",
          ]
    else { throw RoomConnectionContractError.invalidAdmission }
    let record = try JSONDecoder().decode(RoomResetRecoveryRecord.self, from: data)
    return try RoomResetRecoveryRecord(
      accountID: record.accountID,
      roomCode: record.roomCode,
      playerID: record.playerID,
      commandID: record.commandID,
      expectedRevision: record.expectedRevision
    )
  }

  private func validateFileURL() throws {
    guard fileURL.isFileURL, fileURL.path.hasPrefix("/") else {
      throw RoomConnectionContractError.invalidAdmission
    }
  }
}
