import Foundation
import SkyjoDomain
import SwiftData

enum SkyjoPersistenceSchemaV1: VersionedSchema {
  static let versionIdentifier = Schema.Version(1, 0, 0)
  static let models: [any PersistentModel.Type] = [
    SoloSessionRecord.self,
    StatsOutboxRecord.self,
  ]

  @Model
  final class SoloSessionRecord {
    @Attribute(.unique) var recordID: String
    var ownerKey: String
    var gameID: String
    var payloadVersion: Int
    var payload: Data
    var updatedAtMilliseconds: Int64

    init(
      recordID: String,
      ownerKey: String,
      gameID: String,
      payloadVersion: Int,
      payload: Data,
      updatedAtMilliseconds: Int64
    ) {
      self.recordID = recordID
      self.ownerKey = ownerKey
      self.gameID = gameID
      self.payloadVersion = payloadVersion
      self.payload = payload
      self.updatedAtMilliseconds = updatedAtMilliseconds
    }
  }

  @Model
  final class StatsOutboxRecord {
    @Attribute(.unique) var recordID: String
    var ownerKey: String
    var gameID: String
    var payloadVersion: Int
    var payload: Data
    var attempts: Int
    var createdAtMilliseconds: Int64
    var updatedAtMilliseconds: Int64
    var nextAttemptAtMilliseconds: Int64

    init(
      recordID: String,
      ownerKey: String,
      gameID: String,
      payloadVersion: Int,
      payload: Data,
      attempts: Int,
      createdAtMilliseconds: Int64,
      updatedAtMilliseconds: Int64,
      nextAttemptAtMilliseconds: Int64
    ) {
      self.recordID = recordID
      self.ownerKey = ownerKey
      self.gameID = gameID
      self.payloadVersion = payloadVersion
      self.payload = payload
      self.attempts = attempts
      self.createdAtMilliseconds = createdAtMilliseconds
      self.updatedAtMilliseconds = updatedAtMilliseconds
      self.nextAttemptAtMilliseconds = nextAttemptAtMilliseconds
    }
  }
}

enum SkyjoPersistenceSchemaV2: VersionedSchema {
  static let versionIdentifier = Schema.Version(2, 0, 0)
  static let models: [any PersistentModel.Type] = [
    SoloSessionRecord.self,
    StatsOutboxRecord.self,
  ]

  @Model
  final class SoloSessionRecord {
    #Unique<SoloSessionRecord>([\.ownerKey])
    #Index<SoloSessionRecord>([\.ownerKey, \.updatedAtMilliseconds], [\.ownerKey, \.gameID])

    @Attribute(.unique) var recordID: String
    var ownerKey: String
    var gameID: String
    var payloadVersion: Int
    var payload: Data
    var updatedAtMilliseconds: Int64
    var saveSequence: Int64 = 0

    init(
      recordID: String,
      ownerKey: String,
      gameID: String,
      payloadVersion: Int,
      payload: Data,
      updatedAtMilliseconds: Int64,
      saveSequence: Int64
    ) {
      self.recordID = recordID
      self.ownerKey = ownerKey
      self.gameID = gameID
      self.payloadVersion = payloadVersion
      self.payload = payload
      self.updatedAtMilliseconds = updatedAtMilliseconds
      self.saveSequence = saveSequence
    }
  }

  @Model
  final class StatsOutboxRecord {
    #Unique<StatsOutboxRecord>([\.ownerKey, \.gameID])
    #Index<StatsOutboxRecord>([\.ownerKey, \.createdAtMilliseconds], [\.ownerKey, \.nextAttemptAtMilliseconds])

    @Attribute(.unique) var recordID: String
    var ownerKey: String
    var gameID: String
    var payloadVersion: Int
    var payload: Data
    var attempts: Int
    var createdAtMilliseconds: Int64
    var updatedAtMilliseconds: Int64
    var nextAttemptAtMilliseconds: Int64
    var lastFailureCode: String?
    var terminalFailure: Bool = false

    init(
      recordID: String,
      ownerKey: String,
      gameID: String,
      payloadVersion: Int,
      payload: Data,
      attempts: Int,
      createdAtMilliseconds: Int64,
      updatedAtMilliseconds: Int64,
      nextAttemptAtMilliseconds: Int64,
      lastFailureCode: String? = nil,
      terminalFailure: Bool = false
    ) {
      self.recordID = recordID
      self.ownerKey = ownerKey
      self.gameID = gameID
      self.payloadVersion = payloadVersion
      self.payload = payload
      self.attempts = attempts
      self.createdAtMilliseconds = createdAtMilliseconds
      self.updatedAtMilliseconds = updatedAtMilliseconds
      self.nextAttemptAtMilliseconds = nextAttemptAtMilliseconds
      self.lastFailureCode = lastFailureCode
      self.terminalFailure = terminalFailure
    }
  }
}

enum SkyjoPersistenceMigrationPlan: SchemaMigrationPlan {
  static let schemas: [any VersionedSchema.Type] = [
    SkyjoPersistenceSchemaV1.self,
    SkyjoPersistenceSchemaV2.self,
  ]

  static let stages: [MigrationStage] = [
    .custom(
      fromVersion: SkyjoPersistenceSchemaV1.self,
      toVersion: SkyjoPersistenceSchemaV2.self,
      willMigrate: prepareV1ForUniqueness,
      didMigrate: restoreV2DerivedFields
    ),
  ]

  private struct V1OutboxKey: Hashable {
    let ownerKey: String
    let gameID: String
  }

  /// V1 permitted multiple session games for one owner and multiple outbox rows for one
  /// owner/game pair. Resolve those impossible states before V2 installs database uniqueness.
  /// Prefer the newest valid session and the oldest valid FIFO item; retain one corrupt row for
  /// a valid owner so normal recovery can surface it instead of silently discarding user data.
  private static let prepareV1ForUniqueness: @Sendable (ModelContext) throws -> Void = { context in
    let sessions = try context.fetch(FetchDescriptor<SkyjoPersistenceSchemaV1.SoloSessionRecord>())
    for (ownerKey, candidates) in Dictionary(grouping: sessions, by: \.ownerKey) {
      guard SoloOwnerPartition(storageKey: ownerKey) != nil else {
        for record in candidates { context.delete(record) }
        continue
      }
      let ordered = candidates.sorted {
        if $0.updatedAtMilliseconds != $1.updatedAtMilliseconds {
          return $0.updatedAtMilliseconds > $1.updatedAtMilliseconds
        }
        return $0.gameID > $1.gameID
      }
      let retained = ordered.first(where: validV1Session) ?? ordered.first
      for record in ordered where record !== retained { context.delete(record) }
    }

    let outbox = try context.fetch(FetchDescriptor<SkyjoPersistenceSchemaV1.StatsOutboxRecord>())
    let grouped = Dictionary(grouping: outbox) {
      V1OutboxKey(ownerKey: $0.ownerKey, gameID: $0.gameID)
    }
    for candidates in grouped.values {
      let ordered = candidates.sorted {
        if $0.createdAtMilliseconds != $1.createdAtMilliseconds {
          return $0.createdAtMilliseconds < $1.createdAtMilliseconds
        }
        return $0.recordID < $1.recordID
      }
      let retained = ordered.first(where: validV1Outbox) ?? ordered.first
      for record in ordered where record !== retained { context.delete(record) }
    }
    try context.save()
  }

  /// `saveSequence` did not have a V1 column: its authority is the already-versioned payload.
  /// Restore it after SwiftData has installed the V2 model instead of accepting the new field's
  /// zero default, which would otherwise quarantine every migrated nonzero autosave.
  private static let restoreV2DerivedFields: @Sendable (ModelContext) throws -> Void = { context in
    let records = try context.fetch(FetchDescriptor<SkyjoPersistenceSchemaV2.SoloSessionRecord>())
    for record in records {
      guard record.payloadVersion == PersistenceEnvelopeCodec.currentVersion,
            let owner = SoloOwnerPartition(storageKey: record.ownerKey),
            let gameID = canonicalUUID(record.gameID),
            record.updatedAtMilliseconds > 0,
            record.updatedAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
            let envelope = try? PersistenceEnvelopeCodec.decode(
              SoloSnapshotEnvelopeV1.self,
              from: record.payload
            ),
            let snapshot = envelope.snapshot,
            snapshot.owner == owner,
            snapshot.gameID == gameID,
            snapshot.savedAtMilliseconds == record.updatedAtMilliseconds,
            snapshot.saveSequence >= 0,
            snapshot.saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
      else {
        continue
      }
      record.saveSequence = snapshot.saveSequence
    }
    try context.save()
  }

  private static func validV1Session(
    _ record: SkyjoPersistenceSchemaV1.SoloSessionRecord
  ) -> Bool {
    guard record.payloadVersion == PersistenceEnvelopeCodec.currentVersion,
          canonicalUUID(record.recordID) != nil,
          let owner = SoloOwnerPartition(storageKey: record.ownerKey),
          let gameID = canonicalUUID(record.gameID),
          record.updatedAtMilliseconds > 0,
          record.updatedAtMilliseconds <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          let envelope = try? PersistenceEnvelopeCodec.decode(
            SoloSnapshotEnvelopeV1.self,
            from: record.payload
          ),
          let snapshot = envelope.snapshot,
          snapshot.owner == owner,
          snapshot.gameID == gameID,
          snapshot.savedAtMilliseconds == record.updatedAtMilliseconds,
          snapshot.saveSequence >= 0,
          snapshot.saveSequence <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum,
          snapshot.state.phase != .gameOver,
          (try? SoloGameStateValidator.validate(
            snapshot.state,
            setup: snapshot.setup,
            gameID: snapshot.gameID
          )) != nil
    else {
      return false
    }
    return true
  }

  private static func validV1Outbox(
    _ record: SkyjoPersistenceSchemaV1.StatsOutboxRecord
  ) -> Bool {
    guard record.payloadVersion == PersistenceEnvelopeCodec.currentVersion,
          canonicalUUID(record.recordID) != nil,
          case let .account(accountID)? = SoloOwnerPartition(storageKey: record.ownerKey),
          let gameID = canonicalUUID(record.gameID),
          (0...PersistenceEnvelopeCodec.maximumOutboxAttempts).contains(record.attempts),
          validTimestamp(record.createdAtMilliseconds),
          validTimestamp(record.updatedAtMilliseconds),
          validTimestamp(record.nextAttemptAtMilliseconds),
          let envelope = try? PersistenceEnvelopeCodec.decode(
            StatsSubmissionEnvelopeV1.self,
            from: record.payload
          ),
          envelope.version == PersistenceEnvelopeCodec.currentVersion,
          envelope.ownerKey == record.ownerKey,
          envelope.gameID == gameID,
          envelope.request.clientGameKey == gameID.uuidString.lowercased(),
          envelope.request.expectedAccountUserId == accountID.uuidString.lowercased(),
          validTimestamp(envelope.request.completedAt),
          envelope.request.state.phase == .gameOver,
          (try? SoloGameStateValidator.validate(
            envelope.request.state,
            setup: envelope.setup,
            gameID: envelope.gameID
          )) != nil
    else {
      return false
    }
    return true
  }

  private static func canonicalUUID(_ value: String) -> UUID? {
    guard value.utf8.count == 36,
          let id = UUID(uuidString: value),
          value == id.uuidString.lowercased()
    else {
      return nil
    }
    return id
  }

  private static func validTimestamp(_ value: Int64) -> Bool {
    value > 0 && value <= PersistenceEnvelopeCodec.javascriptSafeIntegerMaximum
  }
}

typealias SoloSessionRecord = SkyjoPersistenceSchemaV2.SoloSessionRecord
typealias StatsOutboxRecord = SkyjoPersistenceSchemaV2.StatsOutboxRecord

public enum SkyjoPersistenceSchemaMetadata: Sendable {
  public static let currentVersion = 2
  public static let payloadEnvelopeVersion = PersistenceEnvelopeCodec.currentVersion
  public static let cloudKitEnabled = false
}

public enum SkyjoPersistenceContainer {
  public static func makeInMemory() throws -> ModelContainer {
    let schema = Schema(versionedSchema: SkyjoPersistenceSchemaV2.self)
    let configuration = ModelConfiguration(
      "SkyjoPersistence",
      schema: schema,
      isStoredInMemoryOnly: true,
      allowsSave: true,
      groupContainer: .none,
      cloudKitDatabase: .none
    )
    return try ModelContainer(
      for: schema,
      migrationPlan: SkyjoPersistenceMigrationPlan.self,
      configurations: [configuration]
    )
  }

  public static func make(at storeURL: URL, allowsSave: Bool = true) throws -> ModelContainer {
    let schema = Schema(versionedSchema: SkyjoPersistenceSchemaV2.self)
    let configuration = ModelConfiguration(
      "SkyjoPersistence",
      schema: schema,
      url: storeURL,
      allowsSave: allowsSave,
      cloudKitDatabase: .none
    )
    return try ModelContainer(
      for: schema,
      migrationPlan: SkyjoPersistenceMigrationPlan.self,
      configurations: [configuration]
    )
  }
}
