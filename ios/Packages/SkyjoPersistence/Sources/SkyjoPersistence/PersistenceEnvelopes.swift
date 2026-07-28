import Foundation
import SkyjoDomain

enum PersistenceEnvelopeCodec {
  static let currentVersion = 1
  static let javascriptSafeIntegerMaximum: Int64 = 9_007_199_254_740_991
  // SwiftData persists `Int` using the host integer width. Bound the durable counter to a
  // portable signed 32-bit range and saturate legitimate retry updates at this value. Values
  // outside the bound are treated as corrupt rows that require explicit recovery.
  static let maximumOutboxAttempts = Int(Int32.max)
  // The contract permits 256 rounds, eight 128-character player identifiers, and 64-character
  // Unicode names repeated in every score entry. Two MiB retains that legal worst-case state;
  // the HTTP transport's separate 256 KiB request limit remains a networking concern.
  static let maximumPayloadBytes = 2 * 1_024 * 1_024

  static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    guard data.count <= maximumPayloadBytes else {
      throw SoloPersistenceError.invalidSnapshot
    }
    return data
  }

  static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    guard !data.isEmpty, data.count <= maximumPayloadBytes else {
      throw SoloPersistenceError.incompatibleRecord
    }
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw SoloPersistenceError.incompatibleRecord
    }
  }
}

struct SoloSnapshotEnvelopeV1: Codable, Equatable, Sendable {
  let version: Int
  let ownerKey: String
  let gameID: UUID
  let saveSequence: Int64
  let state: GameState
  let setup: SoloGameSetup
  let savedAtMilliseconds: Int64

  init(snapshot: SoloSessionSnapshot) {
    version = PersistenceEnvelopeCodec.currentVersion
    ownerKey = snapshot.owner.storageKey
    gameID = snapshot.gameID
    saveSequence = snapshot.saveSequence
    state = snapshot.state
    setup = snapshot.setup
    savedAtMilliseconds = snapshot.savedAtMilliseconds
  }

  var snapshot: SoloSessionSnapshot? {
    guard version == PersistenceEnvelopeCodec.currentVersion,
          let owner = SoloOwnerPartition(storageKey: ownerKey)
    else {
      return nil
    }
    return SoloSessionSnapshot(
      owner: owner,
      gameID: gameID,
      saveSequence: saveSequence,
      state: state,
      setup: setup,
      savedAtMilliseconds: savedAtMilliseconds
    )
  }
}

struct StatsSubmissionEnvelopeV1: Codable, Equatable, Sendable {
  let version: Int
  let ownerKey: String
  let gameID: UUID
  let setup: SoloGameSetup
  let request: StatsSubmissionRequest

  init(
    accountID: UUID,
    gameID: UUID,
    state: GameState,
    setup: SoloGameSetup,
    completedAtMilliseconds: Int64
  ) {
    version = PersistenceEnvelopeCodec.currentVersion
    ownerKey = SoloOwnerPartition.account(accountID).storageKey
    self.gameID = gameID
    self.setup = setup
    request = StatsSubmissionRequest(
      state: state,
      gameID: gameID,
      completedAt: completedAtMilliseconds,
      accountID: accountID
    )
  }
}

struct StatsOutboxItem: Equatable, Sendable {
  let recordID: UUID
  let ownerID: UUID
  let gameID: UUID
  let envelopeData: Data
  let setup: SoloGameSetup
  let request: StatsSubmissionRequest
  let attempts: Int
  let createdAtMilliseconds: Int64
  let nextAttemptAtMilliseconds: Int64
  let isTerminalFailure: Bool
}
