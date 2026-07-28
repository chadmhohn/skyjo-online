import Foundation
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
    #Unique<SoloSessionRecord>([\.ownerKey, \.gameID])
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
    .lightweight(fromVersion: SkyjoPersistenceSchemaV1.self, toVersion: SkyjoPersistenceSchemaV2.self),
  ]
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
