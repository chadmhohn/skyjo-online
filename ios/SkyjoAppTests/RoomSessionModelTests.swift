import Foundation
import SkyjoNetworking
import Testing

@testable import SkyjoNative

@Suite("Native multiplayer session model", .serialized)
@MainActor
struct RoomSessionModelTests {
  @Test("Universal-link coordinator ignores other URLs and exposes only sanitized review state")
  func universalLinkCoordinatorRoutesSafely() async throws {
    let probe = InviteRedemptionProbe(
      response: try RedeemedRoomInvite(
        roomCode: "ABCDE",
        expiresAt: 1_784_999_100_000
      )
    )
    let coordinator = RoomInviteCoordinator { link in
      await probe.redeem(link)
    }

    let unrelated = URL(string: "https://example.invalid/invite/signed.payload")!
    #expect(!(await coordinator.accept(unrelated)))
    #expect(await probe.count() == 0)

    let link = URL(
      string: "https://skyjo.groundworkrevops.com/invite/signed_payload.signature"
    )!
    #expect(await coordinator.accept(link))
    #expect(coordinator.state == .review(
      try RedeemedRoomInvite(roomCode: "ABCDE", expiresAt: 1_784_999_100_000)
    ))
    let review = coordinator.consumeReview()
    #expect(review?.roomCode == "ABCDE")
    #expect(coordinator.state == .idle)
    #expect(!String(reflecting: review).contains("ABCDE"))
    #expect(!String(reflecting: coordinator.state).contains("signed_payload"))
  }

  @Test("Universal-link coordinator converts stale-room detail to stable safe copy")
  func universalLinkCoordinatorReportsStaleRoomSafely() async {
    let coordinator = RoomInviteCoordinator { _ in
      throw SkyjoHTTPClientError.server(
        statusCode: 410,
        code: .inviteRoomUnavailable,
        message: "untrusted room-specific detail"
      )
    }
    let link = URL(
      string: "https://skyjo.groundworkrevops.com/invite/signed_payload.signature"
    )!

    #expect(await coordinator.accept(link))
    #expect(
      coordinator.state
        == .failed(message: "That room is no longer available. Ask the host for a new invite.")
    )
    #expect(!String(reflecting: coordinator.state).contains("untrusted"))
  }

  @Test("Connection construction failure unwinds and a later create retries")
  func connectionConstructionCanRetry() async throws {
    let connection = ModelRoomConnection()
    let provider = ModelConnectionProvider(results: [
      .failure(ModelTestError.connectionUnavailable),
      .success(connection),
    ])
    let model = makeModel(connectionProvider: provider)

    await model.start()
    #expect(model.banner?.title == "Room connection unavailable")

    await model.createRoom()
    #expect(await modelEventually { await connection.admissions().count == 1 })
    #expect(await connection.admissions() == [.create(displayName: "Host")])
    await model.stop()
  }

  @Test("Stopping during connection construction retires the late socket generation")
  func stopFencesLateConnectionConstruction() async {
    let connection = ModelRoomConnection()
    let provider = SuspendedModelConnectionProvider()
    let model = RoomSessionModel(
      account: testAccount(),
      environment: RoomSessionEnvironment(
        makeConnection: { await provider.next() },
        createInvite: { _ in throw ModelTestError.inviteUnavailable },
        seatStore: RecordingSeatStore(),
        nowMilliseconds: { 1_784_998_800_000 }
      )
    )

    let startTask = Task { await model.start() }
    #expect(await modelEventually { await provider.hasEntered() })
    await model.stop()
    await provider.resume(with: connection)
    await startTask.value

    #expect(await connection.disposed())
    #expect(model.connectionStatus == idleStatus())
    #expect(!model.commandsEnabled)
  }

  @Test("A second live invite replaces review routing without retaining its token")
  func liveInviteReplacesReview() throws {
    let model = makeModel(connection: ModelRoomConnection(), now: 1_784_998_800_000)
    let first = try RedeemedRoomInvite(roomCode: "ABCDE", expiresAt: 1_784_999_000_000)
    let second = try RedeemedRoomInvite(roomCode: "FGHIJ", expiresAt: 1_784_999_100_000)

    model.applyInvite(first)
    #expect(model.pendingInviteReview == first)
    model.applyInvite(second)

    #expect(model.pendingInviteReview == second)
    #expect(model.joinCode == "FGHIJ")
    let diagnostics = String(reflecting: model.pendingInviteReview)
    #expect(!diagnostics.contains("ABCDE"))
    #expect(!diagnostics.contains("FGHIJ"))
  }

  @Test("Account switch stops the old socket and live links reach the current room model")
  func accountSwitchFencesRoomLifecycle() async throws {
    let firstAccount = testAccount()
    let secondAccount = testAccount(
      id: UUID(uuidString: "30000000-0000-4000-8000-000000000004")!,
      displayName: "Guest"
    )
    let firstConnection = ModelRoomConnection()
    let secondConnection = ModelRoomConnection()
    let host = RoomSessionHost(account: firstAccount) { account in
      let connection = account.id == firstAccount.id ? firstConnection : secondConnection
      let provider = ModelConnectionProvider(results: [.success(connection)])
      return RoomSessionModel(
        account: account,
        environment: RoomSessionEnvironment(
          makeConnection: { try provider.next() },
          createInvite: { _ in throw ModelTestError.inviteUnavailable },
          seatStore: RecordingSeatStore(),
          nowMilliseconds: { 1_784_998_800_000 }
        )
      )
    }

    await host.model.start()
    await host.synchronize(account: secondAccount)
    #expect(await firstConnection.disposed())
    #expect(host.model.account.id == secondAccount.id)

    await host.model.start()
    let invite = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )
    host.applyInvite(invite)
    #expect(host.model.pendingInviteReview == invite)
    #expect(host.model.joinCode == "FGHIJ")

    await host.stop()
    #expect(await secondConnection.disposed())
  }

  @Test("Account switch drains a retired snapshot save before replacing its model")
  func accountSwitchDrainsRetiredSnapshotPersistence() async throws {
    let firstAccount = testAccount()
    let secondAccount = testAccount(
      id: UUID(uuidString: "30000000-0000-4000-8000-000000000004")!,
      displayName: "Guest"
    )
    let firstConnection = ModelRoomConnection()
    let secondConnection = ModelRoomConnection()
    let delayedStore = SuspendedSeatSaveStore()
    let firstModel = RoomSessionModel(
      account: firstAccount,
      environment: RoomSessionEnvironment(
        makeConnection: { firstConnection },
        createInvite: { _ in throw ModelTestError.inviteUnavailable },
        seatStore: delayedStore,
        nowMilliseconds: { 1_784_998_800_000 }
      )
    )
    let host = RoomSessionHost(account: firstAccount) { account in
      if account.id == firstAccount.id { return firstModel }
      return RoomSessionModel(
        account: account,
        environment: RoomSessionEnvironment(
          makeConnection: { secondConnection },
          createInvite: { _ in throw ModelTestError.inviteUnavailable },
          seatStore: RecordingSeatStore(),
          nowMilliseconds: { 1_784_998_800_000 }
        )
      )
    }
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)

    await firstModel.start()
    await firstConnection.emit(.status(connectedStatus(revision: 7)))
    await firstConnection.emit(.snapshot(waiting))
    #expect(await modelEventually { await delayedStore.saveEntered() })

    let switchTask = Task { await host.synchronize(account: secondAccount) }
    #expect(await modelEventually { await firstConnection.disposed() })
    #expect(host.model.account.id == firstAccount.id)
    #expect(firstModel.connectionStatus == idleStatus())

    await delayedStore.resumeSaveWithFailure()
    await switchTask.value

    #expect(host.model.account.id == secondAccount.id)
    #expect(firstModel.connectionStatus == idleStatus())
    #expect(firstModel.banner == nil)
    await host.stop()
  }

  @Test("Rapid scene changes serialize presence so the final active state wins")
  func scenePresenceCoalescesToLatestState() async {
    let connection = ModelRoomConnection()
    let model = makeModel(connection: connection)

    await model.start()
    #expect(await modelEventually { await connection.visibilityUpdates() == [true] })
    await connection.suspendNextVisibilityUpdate()

    model.setSceneActive(false)
    #expect(await modelEventually { await connection.visibilityUpdateIsSuspended() })
    model.setSceneActive(true)
    await connection.resumeVisibilityUpdate()

    #expect(await modelEventually { await connection.visibilityUpdates() == [true, false, true] })
    await model.stop()
  }

  @Test("A command never mutates the board before a later authoritative snapshot")
  func boardAdvancesOnlyFromSnapshots() async throws {
    let connection = ModelRoomConnection()
    let model = makeModel(connection: connection)
    let revisionSeven = try await authoritativeFixture(revision: 7, variant: .playing)
    let revisionEight = try await authoritativeFixture(revision: 8, variant: .playing)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(revisionSeven))
    #expect(await modelEventually { model.snapshot?.revision == 7 })

    let originalGrid = model.localGamePlayer?.grid
    await model.selectLocalCard(at: 2)

    #expect(await connection.actions() == [.replaceCard(2)])
    #expect(model.snapshot?.revision == 7)
    #expect(model.localGamePlayer?.grid == originalGrid)

    await connection.emit(.status(pendingStatus(revision: 7)))
    #expect(await modelEventually { !model.commandsEnabled })
    #expect(model.snapshot?.revision == 7)

    await connection.emit(.snapshot(revisionEight))
    #expect(await modelEventually { model.snapshot?.revision == 8 })
    await model.stop()
  }

  @Test("Create, join, waiting-room, chat, reset, scoring, and takeover intents map exactly")
  func roomIntentsMapToServerCommands() async throws {
    let joinConnection = ModelRoomConnection()
    let joinModel = makeModel(connection: joinConnection)
    joinModel.joinCode = "a1-b2c-extra"
    joinModel.sanitizeJoinCode()
    #expect(joinModel.joinCode == "A1B2C")
    await joinModel.join()
    #expect(await joinConnection.admissions() == [
      .join(code: "A1B2C", displayName: "Host"),
    ])

    let waitingConnection = ModelRoomConnection()
    let waitingModel = makeModel(connection: waitingConnection)
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)
    await waitingModel.start()
    await waitingConnection.emit(.status(connectedStatus(revision: 7)))
    await waitingConnection.emit(.snapshot(waiting))
    #expect(await modelEventually { waitingModel.snapshot != nil })
    let guestID = try #require(
      waitingModel.room?.players.first(where: { $0.id != waitingModel.playerID })?.id
    )
    await waitingModel.startGame()
    await waitingModel.removePlayer(guestID)
    await waitingModel.sendChat("  hello table  ")
    await waitingModel.resetRoom()
    #expect(await waitingConnection.actions() == [
      .startGame,
      .removePlayer(guestID),
      .sendChatMessage("hello table"),
      .resetRoom,
    ])

    let scoringConnection = ModelRoomConnection()
    let scoringModel = makeModel(connection: scoringConnection)
    let scoring = try await authoritativeFixture(revision: 9, variant: .scoring(allReady: false))
    await scoringModel.start()
    await scoringConnection.emit(.status(connectedStatus(revision: 9)))
    await scoringConnection.emit(.snapshot(scoring))
    #expect(await modelEventually { scoringModel.isScoring })
    await scoringModel.toggleReady()
    #expect(await scoringConnection.actions() == [.setNextRoundReady(true)])

    let allReady = try await authoritativeFixture(revision: 10, variant: .scoring(allReady: true))
    await scoringConnection.emit(.snapshot(allReady))
    #expect(await modelEventually { scoringModel.allPlayersReady })
    await scoringModel.startGame()
    #expect(await scoringConnection.actions() == [.setNextRoundReady(true), .startGame])

    let takeoverConnection = ModelRoomConnection()
    let takeoverModel = makeModel(connection: takeoverConnection)
    let takeover = try await authoritativeFixture(revision: 11, variant: .takeoverEligible)
    await takeoverModel.start()
    await takeoverConnection.emit(.status(connectedStatus(revision: 11)))
    await takeoverConnection.emit(.snapshot(takeover))
    #expect(await modelEventually {
      takeoverModel.room?.players.contains(where: { takeoverModel.canTakeOver($0) }) == true
    })
    let takeoverID = try #require(
      takeoverModel.room?.players.first(where: { takeoverModel.canTakeOver($0) })?.id
    )
    await takeoverModel.takeOverWithAI(takeoverID)
    #expect(await takeoverConnection.actions() == [.takeoverPlayerWithAI(takeoverID)])
    await joinModel.stop()
    await waitingModel.stop()
    await scoringModel.stop()
    await takeoverModel.stop()
  }

  @Test("Recoverable notices and interleaved broadcasts preserve leave until terminal idle")
  func interleavedSnapshotThenIdleClearsSeat() async throws {
    let connection = ModelRoomConnection()
    let seatStore = RecordingSeatStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let waitingSeven = try await authoritativeFixture(revision: 7, variant: .waiting)
    let waitingEight = try await authoritativeFixture(revision: 8, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waitingSeven))
    #expect(await modelEventually { model.snapshot?.revision == 7 })
    #expect(await modelEventually { await seatStore.record() != nil })

    await model.leaveRoom()
    #expect(await connection.actions() == [.leaveRoom])

    // A transient transport notice and another player's broadcast can both arrive
    // before RoomConnection replays and receives our room-left acknowledgement.
    await connection.emit(.notice(.transportInterrupted))
    await connection.emit(.snapshot(waitingEight))
    #expect(await modelEventually { model.snapshot?.revision == 8 })
    await connection.emit(.status(idleStatus()))

    #expect(await modelEventually { await seatStore.clearCount() == 1 })
    #expect(await seatStore.record() == nil)
    #expect(model.snapshot == nil)
    #expect(model.joinCode.isEmpty)
    await model.stop()
  }

  @Test("Terminal seat cleanup failure remains actionable")
  func cleanupFailureRemainsVisible() async throws {
    let connection = ModelRoomConnection()
    let seatStore = RecordingSeatStore(failClear: true)
    let model = makeModel(connection: connection, seatStore: seatStore)
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waiting))
    #expect(await modelEventually { model.snapshot != nil })
    await model.leaveRoom()
    await connection.emit(.status(idleStatus()))

    #expect(await modelEventually { model.banner?.title == "Room left; cleanup needed" })
    #expect(await seatStore.record() != nil)
    await model.stop()
  }

  private func makeModel(
    connection: ModelRoomConnection,
    seatStore: any RoomSeatRecoveryStore = RecordingSeatStore(),
    now: Int64 = 1_784_998_800_000
  ) -> RoomSessionModel {
    let provider = ModelConnectionProvider(results: [.success(connection)])
    return makeModel(connectionProvider: provider, seatStore: seatStore, now: now)
  }

  private func makeModel(
    connectionProvider: ModelConnectionProvider,
    seatStore: any RoomSeatRecoveryStore = RecordingSeatStore(),
    now: Int64 = 1_784_998_800_000
  ) -> RoomSessionModel {
    RoomSessionModel(
      account: testAccount(),
      environment: RoomSessionEnvironment(
        makeConnection: { try connectionProvider.next() },
        createInvite: { _ in throw ModelTestError.inviteUnavailable },
        seatStore: seatStore,
        nowMilliseconds: { now }
      )
    )
  }
}

private actor InviteRedemptionProbe {
  private let response: RedeemedRoomInvite
  private var redemptionCount = 0

  init(response: RedeemedRoomInvite) {
    self.response = response
  }

  func redeem(_: RoomInviteLink) -> RedeemedRoomInvite {
    redemptionCount += 1
    return response
  }

  func count() -> Int { redemptionCount }
}

private actor ModelRoomConnection: RoomSessionConnection {
  private let stream: AsyncStream<RoomConnectionEvent>
  private let continuation: AsyncStream<RoomConnectionEvent>.Continuation
  private var receivedAdmissions: [RoomAdmission] = []
  private var receivedActions: [RoomCommandAction] = []
  private var receivedVisibilityUpdates: [Bool] = []
  private var isDisposed = false
  private var shouldSuspendNextVisibilityUpdate = false
  private var suspendedVisibilityContinuation: CheckedContinuation<Void, Never>?

  init() {
    let channel = AsyncStream<RoomConnectionEvent>.makeStream(bufferingPolicy: .unbounded)
    stream = channel.stream
    continuation = channel.continuation
  }

  func events() -> AsyncStream<RoomConnectionEvent> { stream }
  func recoverPersistedReset() -> Bool { false }

  func connect(_ admission: RoomAdmission) {
    receivedAdmissions.append(admission)
  }

  func recover(_ admission: RoomAdmission) {
    receivedAdmissions.append(admission)
  }

  func send(_ action: RoomCommandAction) throws -> UUID {
    receivedActions.append(action)
    return UUID(uuidString: "40000000-0000-4000-8000-000000000047")!
  }

  func setVisible(_ visible: Bool) async {
    receivedVisibilityUpdates.append(visible)
    guard shouldSuspendNextVisibilityUpdate else { return }
    shouldSuspendNextVisibilityUpdate = false
    await withCheckedContinuation { suspendedVisibilityContinuation = $0 }
  }

  func disconnect() {
    continuation.yield(.status(idleStatus()))
  }

  func dispose() {
    isDisposed = true
    continuation.finish()
  }

  func emit(_ event: RoomConnectionEvent) {
    continuation.yield(event)
  }

  func admissions() -> [RoomAdmission] { receivedAdmissions }
  func actions() -> [RoomCommandAction] { receivedActions }
  func visibilityUpdates() -> [Bool] { receivedVisibilityUpdates }
  func disposed() -> Bool { isDisposed }

  func suspendNextVisibilityUpdate() {
    shouldSuspendNextVisibilityUpdate = true
  }

  func visibilityUpdateIsSuspended() -> Bool {
    suspendedVisibilityContinuation != nil
  }

  func resumeVisibilityUpdate() {
    suspendedVisibilityContinuation?.resume()
    suspendedVisibilityContinuation = nil
  }
}

private final class ModelConnectionProvider: @unchecked Sendable {
  private let lock = NSLock()
  private var results: [Result<ModelRoomConnection, ModelTestError>]

  init(results: [Result<ModelRoomConnection, ModelTestError>]) {
    self.results = results
  }

  func next() throws -> any RoomSessionConnection {
    lock.lock()
    defer { lock.unlock() }
    guard !results.isEmpty else { throw ModelTestError.connectionUnavailable }
    return try results.removeFirst().get()
  }
}

private actor SuspendedModelConnectionProvider {
  private var entered = false
  private var continuation: CheckedContinuation<ModelRoomConnection, Never>?

  func next() async -> ModelRoomConnection {
    entered = true
    return await withCheckedContinuation { continuation = $0 }
  }

  func hasEntered() -> Bool { entered }

  func resume(with connection: ModelRoomConnection) {
    continuation?.resume(returning: connection)
    continuation = nil
  }
}

private actor RecordingSeatStore: RoomSeatRecoveryStore {
  private var storedRecord: RoomSeatRecoveryRecord?
  private var clears = 0
  private let failClear: Bool

  init(failClear: Bool = false) {
    self.failClear = failClear
  }

  func load(accountID: UUID) -> RoomSeatRecoveryRecord? {
    guard storedRecord?.accountID == accountID else { return nil }
    return storedRecord
  }

  func save(_ record: RoomSeatRecoveryRecord) {
    storedRecord = record
  }

  func clear(accountID: UUID) throws {
    clears += 1
    if failClear { throw ModelTestError.seatCleanupUnavailable }
    guard storedRecord?.accountID == accountID else { return }
    storedRecord = nil
  }

  func record() -> RoomSeatRecoveryRecord? { storedRecord }
  func clearCount() -> Int { clears }
}

private actor SuspendedSeatSaveStore: RoomSeatRecoveryStore {
  private var entered = false
  private var saveContinuation: CheckedContinuation<Void, Error>?

  func load(accountID _: UUID) -> RoomSeatRecoveryRecord? { nil }

  func save(_: RoomSeatRecoveryRecord) async throws {
    entered = true
    try await withCheckedThrowingContinuation { saveContinuation = $0 }
  }

  func clear(accountID _: UUID) {}

  func saveEntered() -> Bool { entered }

  func resumeSaveWithFailure() {
    saveContinuation?.resume(throwing: ModelTestError.seatCleanupUnavailable)
    saveContinuation = nil
  }
}

private actor ModelSnapshotSocket: RoomWebSocket {
  private var queued: [RoomWebSocketMessage] = []
  private var receiver: CheckedContinuation<RoomWebSocketMessage, Error>?
  private var ended = false

  func start() {}
  func send(text _: String) {}

  func receive() async throws -> RoomWebSocketMessage {
    if ended { throw ModelTestError.socketEnded }
    if !queued.isEmpty { return queued.removeFirst() }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }

  func close(code _: Int, reason _: String) {
    ended = true
    receiver?.resume(throwing: ModelTestError.socketEnded)
    receiver = nil
  }

  func deliver(_ message: RoomWebSocketMessage) {
    if let receiver {
      self.receiver = nil
      receiver.resume(returning: message)
    } else {
      queued.append(message)
    }
  }
}

private func authoritativeFixture(
  revision: Int64,
  variant: ModelSnapshotVariant
) async throws -> AuthoritativeRoomSnapshot {
  let socket = ModelSnapshotSocket()
  let environment = RoomConnectionEnvironment(
    makeSocket: { _ in socket },
    random: { 0.5 },
    makeUUID: { UUID(uuidString: "40000000-0000-4000-8000-000000000047")! },
    nowMilliseconds: { 1_784_998_800_000 },
    connectivityUpdates: {
      AsyncStream { continuation in
        continuation.yield(true)
        continuation.finish()
      }
    }
  )
  let connection = try RoomConnection(
    webSocketURL: URL(string: "wss://example.test/rooms")!,
    confirmedAccount: try ConfirmedRoomAccount(
      accountID: testAccount().id,
      displayName: "Host"
    ),
    environment: environment
  )
  try await connection.connect(.create(displayName: "Host"))
  await socket.deliver(.text(try modelSnapshotFixtureText(revision: revision, variant: variant)))
  guard await modelEventually({ await connection.status().synchronized }),
        let snapshot = await connection.snapshot()
  else { throw ModelTestError.snapshotUnavailable }
  await connection.dispose()
  return snapshot
}

private func modelSnapshotFixtureText(
  revision: Int64,
  variant: ModelSnapshotVariant
) throws -> String {
  let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let fixtureURL = repositoryRoot
    .appending(path: "contracts/v1/fixtures/protocol-server.valid.json")
  let data = try Data(contentsOf: fixtureURL)
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cases = root["cases"] as? [[String: Any]],
        let fixture = cases.first(where: { $0["name"] as? String == "personalized snapshot" }),
        var frame = fixture["value"] as? [String: Any],
        var room = frame["room"] as? [String: Any]
  else { throw ModelTestError.invalidFixture }

  frame["revision"] = revision
  room["revision"] = revision
  switch variant {
  case .playing:
    break
  case .waiting:
    room["state"] = NSNull()
    room["status"] = "waiting"
  case .scoring(let allReady):
    guard var state = room["state"] as? [String: Any],
          let players = room["players"] as? [[String: Any]]
    else { throw ModelTestError.invalidFixture }
    state["phase"] = "round-over"
    state["selectedSource"] = NSNull()
    state["hasDrawnCard"] = false
    state["drawnCard"] = NSNull()
    room["state"] = state
    room["readyForNextRoundPlayerIds"] = allReady
      ? players.compactMap { $0["id"] as? String }
      : []
  case .takeoverEligible:
    guard var players = room["players"] as? [[String: Any]], players.indices.contains(1),
          let serverNow = room["serverNow"] as? NSNumber
    else { throw ModelTestError.invalidFixture }
    var guest = players[1]
    guest["connected"] = false
    guest["disconnectedAt"] = serverNow.int64Value - 1_000
    guest["aiTakeoverAt"] = serverNow.int64Value - 1
    players[1] = guest
    room["players"] = players
  }
  frame["room"] = room
  guard JSONSerialization.isValidJSONObject(frame) else { throw ModelTestError.invalidFixture }
  let rendered = try JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])
  guard let text = String(data: rendered, encoding: .utf8) else {
    throw ModelTestError.invalidFixture
  }
  return text
}

private enum ModelSnapshotVariant {
  case playing
  case waiting
  case scoring(allReady: Bool)
  case takeoverEligible
}

private func testAccount(
  id: UUID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
  displayName: String = "Host"
) -> AccountUser {
  AccountUser(
    id: id,
    email: "host@example.test",
    displayName: displayName,
    role: .player,
    disabled: false,
    createdAt: 1_784_998_700_000,
    updatedAt: 1_784_998_700_000,
    lastLoginAt: 1_784_998_700_000
  )
}

private func connectedStatus(revision: Int64) -> RoomConnectionStatus {
  RoomConnectionStatus(
    phase: .connected,
    retryInMilliseconds: nil,
    synchronized: true,
    hasPendingCommand: false,
    revision: revision
  )
}

private func pendingStatus(revision: Int64) -> RoomConnectionStatus {
  RoomConnectionStatus(
    phase: .connected,
    retryInMilliseconds: nil,
    synchronized: true,
    hasPendingCommand: true,
    revision: revision
  )
}

private func idleStatus() -> RoomConnectionStatus {
  RoomConnectionStatus(
    phase: .idle,
    retryInMilliseconds: nil,
    synchronized: false,
    hasPendingCommand: false,
    revision: nil
  )
}

@MainActor
private func modelEventually(
  attempts: Int = 500,
  _ predicate: @escaping @MainActor @Sendable () async -> Bool
) async -> Bool {
  for _ in 0..<attempts {
    if await predicate() { return true }
    try? await Task<Never, Never>.sleep(for: .milliseconds(2))
  }
  return false
}

private enum ModelTestError: Error {
  case connectionUnavailable
  case inviteUnavailable
  case seatCleanupUnavailable
  case socketEnded
  case snapshotUnavailable
  case invalidFixture
}
