import Foundation
import Testing
@testable import SkyjoPersistence

@Test("persistence package identity remains stable")
func persistencePackageIdentity() {
  #expect(SkyjoPersistenceModule.name == "SkyjoPersistence")
  #expect(SkyjoPersistenceSchemaMetadata.currentVersion == 2)
  #expect(!SkyjoPersistenceSchemaMetadata.cloudKitEnabled)
}

@Test("public persistence types expose only safe owner and warning metadata")
func persistenceValueTypes() async throws {
  let accountID = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
  #expect(SoloOwnerPartition.account(accountID).accountID == accountID)
  #expect(SoloOwnerPartition.guest.accountID == nil)
  #expect(SoloOwnerPartition(storageKey: "account:not-a-uuid") == nil)

  #expect(SoloPersistenceError.sessionConflict.warning.kind == .conflict)
  #expect(SoloPersistenceError.staleAutosave.warning.kind == .conflict)
  #expect(SoloPersistenceError.missingSession.warning.kind == .conflict)
  #expect(SoloPersistenceError.storageFull.warning.kind == .quota)
  #expect(SoloPersistenceError.invalidSnapshot.warning.kind == .unavailable)
  #expect(SoloPersistenceError.incompatibleRecord.warning.kind == .unavailable)
  #expect(SoloPersistenceError.storageUnavailable.warning.kind == .unavailable)
  #expect(SoloPersistenceError.writeInterrupted.warning.kind == .unavailable)

  let recoveryHandle = StatsOutboxRecoveryHandle(token: accountID)
  #expect(String(describing: recoveryHandle) == "StatsOutboxRecoveryHandle(redacted)")
  #expect(String(reflecting: recoveryHandle) == "StatsOutboxRecoveryHandle(redacted)")

  let persistenceEnvironment = SoloPersistenceEnvironment()
  #expect(persistenceEnvironment.nowMilliseconds() > 0)
  let coordinatorEnvironment = StatsOutboxCoordinatorEnvironment()
  try await coordinatorEnvironment.sleep(.zero)
}
