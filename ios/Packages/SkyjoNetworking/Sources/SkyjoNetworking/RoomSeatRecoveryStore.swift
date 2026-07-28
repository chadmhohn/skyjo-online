import Foundation

/// The minimum nonsecret routing state needed to ask the server to reclaim an account-owned seat.
/// Room snapshots, chat, cards, cookies, and invite material are never persisted here.
public struct RoomSeatRecoveryRecord: Codable, Equatable, Sendable,
  CustomStringConvertible, CustomDebugStringConvertible {
  public let accountID: UUID
  public let roomCode: String
  public let playerID: String

  public init(accountID: UUID, roomCode: String, playerID: String) throws {
    guard RealtimeFrameCodec.isContractUUID(accountID) else {
      throw RoomConnectionContractError.invalidAdmission
    }
    _ = try RealtimeFrameCodec.encodeAdmission(
      .join(code: roomCode, displayName: "Validated", playerID: playerID)
    )
    self.accountID = accountID
    self.roomCode = roomCode
    self.playerID = playerID
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "RoomSeatRecoveryRecord(<redacted>)" }
}

public protocol RoomSeatRecoveryStore: Sendable {
  func load(accountID: UUID) async throws -> RoomSeatRecoveryRecord?
  func save(_ record: RoomSeatRecoveryRecord) async throws
  func clear(accountID: UUID) async throws
}

public actor VolatileRoomSeatRecoveryStore: RoomSeatRecoveryStore {
  private var record: RoomSeatRecoveryRecord?

  public init(record: RoomSeatRecoveryRecord? = nil) {
    self.record = record
  }

  public func load(accountID: UUID) -> RoomSeatRecoveryRecord? {
    guard record?.accountID == accountID else { return nil }
    return record
  }

  public func save(_ record: RoomSeatRecoveryRecord) {
    self.record = record
  }

  public func clear(accountID: UUID) {
    guard record?.accountID == accountID else { return }
    record = nil
  }
}

public actor FileRoomSeatRecoveryStore: RoomSeatRecoveryStore {
  public static let maximumRecordBytes = 2 * 1_024
  private static let fileSystemLock = NSLock()
  private static let sharedApplicationSupportStore: FileRoomSeatRecoveryStore = {
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first ?? FileManager.default.temporaryDirectory
    return FileRoomSeatRecoveryStore(
      fileURL: root
        .appending(path: "SkyjoNative", directoryHint: .isDirectory)
        .appending(path: "room-seat-v1.json", directoryHint: .notDirectory)
    )
  }()

  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public static func applicationSupportStore() -> FileRoomSeatRecoveryStore {
    sharedApplicationSupportStore
  }

  public func load(accountID: UUID) throws -> RoomSeatRecoveryRecord? {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    guard let record = try loadStoredRecord(), record.accountID == accountID else { return nil }
    return record
  }

  public func save(_ record: RoomSeatRecoveryRecord) throws {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    try validateFileURL()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(record)
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

  public func clear(accountID: UUID) throws {
    Self.fileSystemLock.lock()
    defer { Self.fileSystemLock.unlock() }
    try validateFileURL()
    let stored: RoomSeatRecoveryRecord?
    do {
      stored = try loadStoredRecord()
    } catch {
      // The user explicitly asked to forget this single app-owned routing file.
      // If corruption makes its account fence unreadable, remove only that exact
      // nonsecret record so recovery does not require an app reinstall.
      try removeStoredFileIfPresent()
      return
    }
    guard let stored, stored.accountID == accountID else { return }
    try removeStoredFileIfPresent()
  }

  private func loadStoredRecord() throws -> RoomSeatRecoveryRecord? {
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
          Set(object.keys) == ["accountID", "roomCode", "playerID"]
    else { throw RoomConnectionContractError.invalidAdmission }
    let decoded = try JSONDecoder().decode(RoomSeatRecoveryRecord.self, from: data)
    return try RoomSeatRecoveryRecord(
      accountID: decoded.accountID,
      roomCode: decoded.roomCode,
      playerID: decoded.playerID
    )
  }

  private func validateFileURL() throws {
    guard fileURL.isFileURL, fileURL.path.hasPrefix("/") else {
      throw RoomConnectionContractError.invalidAdmission
    }
  }

  private func removeStoredFileIfPresent() throws {
    do {
      try FileManager.default.removeItem(at: fileURL)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      return
    }
  }
}
