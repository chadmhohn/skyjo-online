import Foundation
import Testing

@testable import SkyjoNetworking
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

  @Test("Malformed in-scope universal links fail visibly without redeeming or retaining tokens")
  func malformedUniversalLinkFailsVisibly() async throws {
    let probe = InviteRedemptionProbe(
      response: try RedeemedRoomInvite(roomCode: "ABCDE", expiresAt: 1_784_999_100_000)
    )
    let coordinator = RoomInviteCoordinator { link in await probe.redeem(link) }
    let malformed = URL(
      string: "https://skyjo.groundworkrevops.com/invite/private%2Ftoken?unexpected=1"
    )!

    #expect(await coordinator.accept(malformed))
    #expect(
      coordinator.state
        == .failed(message: "This Skyjo invite link is invalid. Ask the host for a new link.")
    )
    #expect(await probe.count() == 0)
    #expect(!String(reflecting: coordinator.state).contains("private"))
    #expect(!String(reflecting: coordinator.state).contains("token"))
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

  @Test("A live invite supersedes an automatic seat load that was already in flight")
  func liveInviteWinsAutomaticRecoveryRace() async throws {
    let connection = ModelRoomConnection()
    let saved = try RoomSeatRecoveryRecord(
      accountID: testAccount().id,
      roomCode: "ABCDE",
      playerID: "seat-old"
    )
    let seatStore = SuspendedSeatLoadStore(record: saved)
    let model = makeModel(connection: connection, seatStore: seatStore)
    let startTask = Task { await model.start() }
    #expect(await modelEventually { await seatStore.loadIsSuspended() })

    let invite = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )
    model.applyInvite(invite)
    await seatStore.resumeLoad()
    await startTask.value

    #expect(await connection.admissions().isEmpty)
    #expect(model.pendingInviteReview == invite)
    #expect(model.joinCode == "FGHIJ")
    await model.acceptInviteAndJoin()
    #expect(await connection.admissions() == [
      .join(code: "FGHIJ", displayName: "Host", playerID: nil),
    ])
    await model.stop()
  }

  @Test("A live invite quarantines an explicit admission that was already in flight")
  func liveInviteWinsExplicitAdmissionRace() async throws {
    let connection = ModelRoomConnection()
    let seatStore = RecordingSeatStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let oldRoom = try await authoritativeFixture(revision: 7, variant: .waiting)
    let invite = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )

    await model.start()
    await connection.suspendNextConnect()
    let oldJoin = Task { await model.join(code: "ABCDE") }
    #expect(await modelEventually { await connection.connectIsSuspended() })

    model.applyInvite(invite)
    await connection.resumeConnect()
    #expect(await oldJoin.value == false)
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(oldRoom))
    #expect(!(await modelEventually(attempts: 30) { model.room != nil }))
    #expect(await seatStore.record() == nil)

    #expect(model.pendingInviteReview == invite)
    await model.acceptInviteAndJoin()

    #expect(await connection.admissions() == [
      .join(code: "ABCDE", displayName: "Host", playerID: nil),
      .join(code: "FGHIJ", displayName: "Host", playerID: nil),
    ])
    #expect(model.pendingInviteReview == nil)
    #expect(model.room == nil)
    await model.stop()
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

  @Test("An eight-player opening table exposes one local reveal intent and seven opponents")
  func eightPlayerOpeningIntentIsAuthoritative() async throws {
    let connection = ModelRoomConnection()
    let model = makeModel(connection: connection)
    let opening = try await authoritativeFixture(revision: 7, variant: .openingEightPlayer)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(opening))
    #expect(await modelEventually { model.game?.phase == .openingReveal })
    #expect(model.opponentGamePlayers.count == 7)
    #expect(model.isLocalCardEnabled(at: 0))
    let originalGrid = model.localGamePlayer?.grid

    await model.selectLocalCard(at: 0)
    #expect(await connection.actions() == [.revealOpeningCard(0)])
    #expect(model.localGamePlayer?.grid == originalGrid)

    await connection.emit(.status(pendingStatus(revision: 7)))
    #expect(await modelEventually { !model.isLocalCardEnabled(at: 1) })
    await model.selectLocalCard(at: 1)
    #expect(await connection.actions() == [.revealOpeningCard(0)])
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
    await connection.emit(.notice(.commandRejected(
      code: "room-required",
      message: "Untrusted detail",
      matchedAction: .sendChatMessage("other command")
    )))
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

  @Test("Reviewed invites switch rooms without inheriting the old seat or accepting late snapshots")
  func reviewedInviteSwitchesWithFreshAdmission() async throws {
    let connection = ModelRoomConnection()
    let seatStore = RecordingSeatStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let oldRoom = try await authoritativeFixture(revision: 7, variant: .playing)
    let lateOldRoom = try await authoritativeFixture(revision: 8, variant: .playing)
    let newRoom = try await authoritativeFixture(
      revision: 9,
      variant: .waiting,
      roomCode: "FGHIJ"
    )

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(oldRoom))
    #expect(await modelEventually { await seatStore.record()?.roomCode == "ABCDE" })

    let invite = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )
    model.applyInvite(invite)
    #expect(model.canAcceptInvite)
    await model.acceptInviteAndJoin()

    #expect(await connection.admissions() == [
      .join(code: "FGHIJ", displayName: "Host", playerID: nil),
    ])
    #expect(model.pendingInviteReview == nil)
    #expect(model.room == nil)
    #expect(await seatStore.record() == nil)

    await connection.emit(.snapshot(lateOldRoom))
    #expect(!(await modelEventually(attempts: 30) { model.room != nil }))

    await connection.emit(.status(connectedStatus(revision: 9)))
    await connection.emit(.snapshot(newRoom))
    #expect(await modelEventually { model.room?.code == "FGHIJ" })
    #expect(await modelEventually { await seatStore.record()?.roomCode == "FGHIJ" })
    await model.stop()
  }

  @Test("A same-room invite dismisses without disconnecting or sending another admission")
  func sameRoomInviteIsANoop() async throws {
    let connection = ModelRoomConnection()
    let model = makeModel(connection: connection)
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waiting))
    #expect(await modelEventually { model.room?.code == "ABCDE" })
    model.applyInvite(try RedeemedRoomInvite(
      roomCode: "ABCDE",
      expiresAt: 1_784_999_100_000
    ))

    await model.acceptInviteAndJoin()

    #expect(await connection.admissions().isEmpty)
    #expect(model.room?.code == "ABCDE")
    #expect(model.pendingInviteReview == nil)
    #expect(model.banner?.title == "Already in this room")
    await model.stop()
  }

  @Test("A retired-room terminal notice cannot erase a newer invite admission fence")
  func retiredTerminalNoticeCannotEraseTargetAdmission() async throws {
    let connection = ModelRoomConnection()
    let seatStore = SuspendedSeatClearStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let oldRoom = try await authoritativeFixture(revision: 7, variant: .playing)
    let targetRoom = try await authoritativeFixture(
      revision: 8,
      variant: .waiting,
      roomCode: "FGHIJ"
    )

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(oldRoom))
    #expect(await modelEventually { await seatStore.record()?.roomCode == "ABCDE" })
    model.applyInvite(try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    ))

    await connection.suspendNextConnect()
    let switchTask = Task { await model.acceptInviteAndJoin() }
    #expect(await modelEventually { await seatStore.clearIsSuspended() })
    await seatStore.resumeClear()
    #expect(await modelEventually { await connection.connectIsSuspended() })

    await connection.emit(.notice(.roomResetByHost(roomCode: "ABCDE")))
    await connection.emit(.status(RoomConnectionStatus(
      phase: .connecting,
      retryInMilliseconds: nil,
      synchronized: false,
      hasPendingCommand: false,
      revision: nil
    )))
    #expect(await modelEventually { model.connectionStatus.phase == .connecting })
    await connection.resumeConnect()
    await switchTask.value

    await connection.emit(.status(connectedStatus(revision: 8)))
    await connection.emit(.snapshot(targetRoom))
    #expect(await modelEventually { model.room?.code == "FGHIJ" })
    #expect(await modelEventually { await seatStore.record()?.roomCode == "FGHIJ" })
    #expect(model.pendingInviteReview == nil)
    await model.stop()
  }

  @Test("A different waiting-room invite requires an acknowledged leave before switching")
  func waitingRoomInviteDoesNotOrphanCurrentSeat() async throws {
    let connection = ModelRoomConnection()
    let model = makeModel(connection: connection)
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waiting))
    #expect(await modelEventually { model.room?.code == "ABCDE" })
    let invite = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )
    model.applyInvite(invite)

    #expect(model.inviteRequiresLeavingCurrentRoom)
    #expect(!model.canAcceptInvite)
    await model.acceptInviteAndJoin()
    #expect(await connection.admissions().isEmpty)
    #expect(model.pendingInviteReview == invite)
    #expect(model.room?.code == "ABCDE")
    #expect(model.banner?.title == "Leave the waiting room first")

    await model.leaveRoom()
    #expect(await connection.actions() == [.leaveRoom])
    await connection.emit(.status(idleStatus()))
    #expect(await modelEventually { model.room == nil && model.pendingInviteReview == invite })
    #expect(model.canAcceptInvite)
    await model.acceptInviteAndJoin()
    #expect(await connection.admissions() == [
      .join(code: "FGHIJ", displayName: "Host", playerID: nil),
    ])
    await model.stop()
  }

  @Test("A failed target-seat save cannot silently restore the room that was replaced")
  func failedSwitchPersistenceDoesNotRestoreOldRoom() async throws {
    let connection = ModelRoomConnection()
    let seatStore = RecordingSeatStore(failSaveRoomCode: "FGHIJ")
    let model = makeModel(connection: connection, seatStore: seatStore)
    let oldRoom = try await authoritativeFixture(revision: 7, variant: .playing)
    let newRoom = try await authoritativeFixture(
      revision: 8,
      variant: .waiting,
      roomCode: "FGHIJ"
    )

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(oldRoom))
    #expect(await modelEventually { await seatStore.record()?.roomCode == "ABCDE" })
    model.applyInvite(try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    ))
    await model.acceptInviteAndJoin()
    #expect(await seatStore.record() == nil)

    await connection.emit(.status(connectedStatus(revision: 8)))
    await connection.emit(.snapshot(newRoom))
    #expect(await modelEventually { model.banner?.title == "Seat recovery unavailable" })
    #expect(model.room?.code == "FGHIJ")
    #expect(await seatStore.record() == nil)
    await model.stop()
  }

  @Test("A canceled failing room switch restores the newest authoritative current-room snapshot")
  func canceledFailingSwitchRestoresBufferedCurrentRoom() async throws {
    let connection = ModelRoomConnection()
    let seatStore = SuspendedSeatClearStore(failClear: true)
    let model = makeModel(connection: connection, seatStore: seatStore)
    let roomSeven = try await authoritativeFixture(revision: 7, variant: .playing)
    let roomEight = try await authoritativeFixture(revision: 8, variant: .playing)
    let inviteB = try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    )
    let inviteC = try RedeemedRoomInvite(
      roomCode: "KLMNO",
      expiresAt: 1_784_999_200_000
    )

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(roomSeven))
    #expect(await modelEventually { await seatStore.record()?.roomCode == "ABCDE" })

    model.applyInvite(inviteB)
    let switchTask = Task { await model.acceptInviteAndJoin() }
    #expect(await modelEventually { await seatStore.clearIsSuspended() })
    await connection.emit(.status(connectedStatus(revision: 8)))
    await connection.emit(.snapshot(roomEight))

    model.applyInvite(inviteC)
    model.dismissInviteReview()
    await seatStore.resumeClear()
    await switchTask.value

    #expect(await modelEventually { model.snapshot?.revision == 8 })
    #expect(model.room?.code == "ABCDE")
    #expect(model.commandsEnabled)
    #expect(await seatStore.record()?.roomCode == "ABCDE")
    #expect(await connection.admissions().isEmpty)
    await model.stop()
  }

  @Test("A failed room switch restores a snapshot broadcast while routing was quarantined")
  func failedSwitchRestoresBufferedCurrentRoom() async throws {
    let connection = ModelRoomConnection()
    let seatStore = SuspendedSeatClearStore(failClear: true)
    let model = makeModel(connection: connection, seatStore: seatStore)
    let roomSeven = try await authoritativeFixture(revision: 7, variant: .playing)
    let roomEight = try await authoritativeFixture(revision: 8, variant: .playing)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(roomSeven))
    #expect(await modelEventually { model.snapshot?.revision == 7 })
    model.applyInvite(try RedeemedRoomInvite(
      roomCode: "FGHIJ",
      expiresAt: 1_784_999_100_000
    ))

    let switchTask = Task { await model.acceptInviteAndJoin() }
    #expect(await modelEventually { await seatStore.clearIsSuspended() })
    await connection.emit(.status(connectedStatus(revision: 8)))
    await connection.emit(.snapshot(roomEight))
    await seatStore.resumeClear()
    await switchTask.value

    #expect(await modelEventually { model.snapshot?.revision == 8 })
    #expect(model.commandsEnabled)
    #expect(model.banner?.title == "Saved room could not be replaced")
    #expect(await connection.admissions().isEmpty)
    await model.stop()
  }

  @Test("Forget drains an older seat save and quarantines buffered room snapshots")
  func forgetWinsAgainstInFlightSnapshotPersistence() async throws {
    let connection = ModelRoomConnection()
    let seatStore = SuspendedSeatSaveStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let waitingSeven = try await authoritativeFixture(revision: 7, variant: .waiting)
    let waitingEight = try await authoritativeFixture(revision: 8, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waitingSeven))
    #expect(await modelEventually { await seatStore.saveEntered() })
    await connection.suspendNextDisconnect()

    let forgetTask = Task { await model.forgetSavedSeat() }
    #expect(await modelEventually { await connection.disconnectIsSuspended() })
    await connection.emit(.snapshot(waitingEight))
    await connection.resumeDisconnect()
    await seatStore.resumeSave()
    await forgetTask.value

    #expect(await modelEventually { await seatStore.record() == nil })
    #expect(model.room == nil)
    #expect(model.joinCode.isEmpty)
    await model.stop()
  }

  @Test("A share response from a replaced room can never publish into the new room")
  func staleShareResponseIsDiscarded() async throws {
    let connection = ModelRoomConnection()
    let inviteFactory = SuspendedInviteFactory()
    let model = RoomSessionModel(
      account: testAccount(),
      environment: RoomSessionEnvironment(
        makeConnection: { connection },
        createInvite: { code in try await inviteFactory.create(roomCode: code) },
        seatStore: RecordingSeatStore(),
        nowMilliseconds: { 1_784_998_800_000 }
      )
    )
    let roomA = try await authoritativeFixture(revision: 7, variant: .waiting)
    let roomB = try await authoritativeFixture(
      revision: 8,
      variant: .waiting,
      roomCode: "FGHIJ"
    )

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(roomA))
    #expect(await modelEventually { model.canCreateShareInvite })
    let shareTask = Task { await model.createShareInvite() }
    #expect(await modelEventually { await inviteFactory.isSuspended() })

    await connection.emit(.status(connectedStatus(revision: 8)))
    await connection.emit(.snapshot(roomB))
    #expect(await modelEventually { model.room?.code == "FGHIJ" })
    await inviteFactory.resume(with: NativeRoomInvite(
      roomCode: "ABCDE",
      url: URL(string: "https://skyjo.groundworkrevops.com/invite/redacted")!,
      expiresAt: 1_784_999_100_000
    ))
    await shareTask.value

    #expect(model.shareInvite == nil)
    #expect(!model.isCreatingInvite)
    await model.stop()
  }

  @Test("Terminal seat cleanup blocks a new admission until the clear finishes")
  func terminalCleanupSerializesNextAdmission() async throws {
    let connection = ModelRoomConnection()
    let seatStore = SuspendedSeatClearStore()
    let model = makeModel(connection: connection, seatStore: seatStore)
    let waiting = try await authoritativeFixture(revision: 7, variant: .waiting)

    await model.start()
    await connection.emit(.status(connectedStatus(revision: 7)))
    await connection.emit(.snapshot(waiting))
    #expect(await modelEventually { model.room != nil })
    await connection.emit(.status(idleStatus()))
    await connection.emit(.notice(.roomResetByHost(roomCode: "ABCDE")))
    #expect(await modelEventually { model.isSeatCleanupPending })
    #expect(await seatStore.clearIsSuspended())

    model.joinCode = "FGHIJ"
    await model.join()
    #expect(await connection.admissions().isEmpty)

    await seatStore.resumeClear()
    #expect(await modelEventually { !model.isSeatCleanupPending })
    await model.join()
    #expect(await connection.admissions() == [
      .join(code: "FGHIJ", displayName: "Host", playerID: nil),
    ])
    await model.stop()
  }

  @Test("Forget discards undecodable reset recovery and clears both routing stores")
  func forgetEscapesFailedResetRecoveryLoad() async throws {
    let connection = ModelRoomConnection()
    await connection.failPersistedResetRecovery(.seatCleanupUnavailable)
    let seatStore = RecordingSeatStore()
    let account = testAccount()
    try await seatStore.save(RoomSeatRecoveryRecord(
      accountID: account.id,
      roomCode: "ABCDE",
      playerID: "seat-old"
    ))
    let model = makeModel(connection: connection, seatStore: seatStore)

    await model.start()
    #expect(model.banner?.title == "Room reset recovery unavailable")
    await model.forgetSavedSeat()

    #expect(await connection.disconnectCount() == 1)
    #expect(await connection.discardCount() == 1)
    #expect(await seatStore.record() == nil)
    #expect(model.banner == nil)
    await model.stop()
  }

  @Test("Forget attempts seat cleanup even when reset cleanup fails and remains retryable")
  func forgetRetriesBothRecoveryStores() async throws {
    let connection = ModelRoomConnection()
    await connection.failDisconnect(.seatCleanupUnavailable)
    await connection.failDiscard(.seatCleanupUnavailable)
    let seatStore = RecordingSeatStore()
    let account = testAccount()
    try await seatStore.save(RoomSeatRecoveryRecord(
      accountID: account.id,
      roomCode: "ABCDE",
      playerID: "seat-old"
    ))
    let model = makeModel(connection: connection, seatStore: seatStore)

    await model.start()
    await model.forgetSavedSeat()
    #expect(await seatStore.record() == nil)
    #expect(model.banner?.title == "Saved room cleanup needed")
    #expect(model.canForgetSavedSeat)

    await connection.failDisconnect(nil)
    await connection.failDiscard(nil)
    await model.forgetSavedSeat()
    #expect(await connection.disconnectCount() == 2)
    #expect(await connection.discardCount() == 2)
    #expect(model.banner == nil)
    await model.stop()
  }

  @Test("An A to B to A account race installs a fresh usable A room model")
  func accountSwitchABARetiresTheStoppedModel() async {
    let accountA = testAccount()
    let accountB = testAccount(
      id: UUID(uuidString: "30000000-0000-4000-8000-000000000004")!,
      displayName: "Guest"
    )
    let firstAConnection = ModelRoomConnection()
    let secondAConnection = ModelRoomConnection()
    let bConnection = ModelRoomConnection()
    let factory = HostRoomModelFactory(
      connectionsByAccount: [
        accountA.id: [firstAConnection, secondAConnection],
        accountB.id: [bConnection],
      ]
    )
    let host = RoomSessionHost(account: accountA) { factory.makeModel(for: $0) }
    let stoppedModel = host.model

    await stoppedModel.start()
    await firstAConnection.suspendNextDispose()
    let switchToB = Task { await host.synchronize(account: accountB) }
    #expect(await modelEventually { await firstAConnection.disposeIsSuspended() })

    await host.synchronize(account: accountA)
    let freshModel = host.model
    #expect(freshModel !== stoppedModel)
    #expect(freshModel.account.id == accountA.id)
    await freshModel.start()
    await freshModel.createRoom()
    #expect(await secondAConnection.admissions() == [.create(displayName: "Host")])

    await firstAConnection.resumeDispose()
    await switchToB.value
    #expect(host.model === freshModel)
    #expect(!(await secondAConnection.disposed()))
    await host.stop()
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

private actor SuspendedInviteFactory {
  private var requestedRoomCode: String?
  private var continuation: CheckedContinuation<NativeRoomInvite, Error>?

  func create(roomCode: String) async throws -> NativeRoomInvite {
    requestedRoomCode = roomCode
    return try await withCheckedThrowingContinuation { continuation = $0 }
  }

  func isSuspended() -> Bool { requestedRoomCode != nil && continuation != nil }

  func resume(with invite: NativeRoomInvite) {
    continuation?.resume(returning: invite)
    continuation = nil
  }
}

private actor ModelRoomConnection: RoomSessionConnection {
  private let stream: AsyncStream<RoomConnectionEvent>
  private let continuation: AsyncStream<RoomConnectionEvent>.Continuation
  private var receivedAdmissions: [RoomAdmission] = []
  private var receivedActions: [RoomCommandAction] = []
  private var receivedVisibilityUpdates: [Bool] = []
  private var isDisposed = false
  private var persistedResetFailure: ModelTestError?
  private var disconnectFailure: ModelTestError?
  private var discardFailure: ModelTestError?
  private var disconnectCalls = 0
  private var discardCalls = 0
  private var shouldSuspendNextConnect = false
  private var shouldSuspendNextDisconnect = false
  private var shouldSuspendNextDispose = false
  private var suspendedConnectContinuation: CheckedContinuation<Void, Never>?
  private var suspendedDisconnectContinuation: CheckedContinuation<Void, Never>?
  private var suspendedDisposeContinuation: CheckedContinuation<Void, Never>?
  private var shouldSuspendNextVisibilityUpdate = false
  private var suspendedVisibilityContinuation: CheckedContinuation<Void, Never>?

  init() {
    let channel = AsyncStream<RoomConnectionEvent>.makeStream(bufferingPolicy: .unbounded)
    stream = channel.stream
    continuation = channel.continuation
  }

  func events() -> AsyncStream<RoomConnectionEvent> { stream }
  func recoverPersistedReset() throws -> Bool {
    if let persistedResetFailure { throw persistedResetFailure }
    return false
  }

  func connect(_ admission: RoomAdmission) async {
    receivedAdmissions.append(admission)
    guard shouldSuspendNextConnect else { return }
    shouldSuspendNextConnect = false
    await withCheckedContinuation { suspendedConnectContinuation = $0 }
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

  func disconnect() async throws {
    disconnectCalls += 1
    continuation.yield(.status(idleStatus()))
    if shouldSuspendNextDisconnect {
      shouldSuspendNextDisconnect = false
      await withCheckedContinuation { suspendedDisconnectContinuation = $0 }
    }
    if let disconnectFailure { throw disconnectFailure }
  }

  func discardPersistedResetRecovery() throws {
    discardCalls += 1
    if let discardFailure { throw discardFailure }
  }

  func dispose() async {
    isDisposed = true
    if shouldSuspendNextDispose {
      shouldSuspendNextDispose = false
      await withCheckedContinuation { suspendedDisposeContinuation = $0 }
    }
    continuation.finish()
  }

  func emit(_ event: RoomConnectionEvent) {
    continuation.yield(event)
  }

  func admissions() -> [RoomAdmission] { receivedAdmissions }
  func actions() -> [RoomCommandAction] { receivedActions }
  func visibilityUpdates() -> [Bool] { receivedVisibilityUpdates }
  func disposed() -> Bool { isDisposed }

  func failPersistedResetRecovery(_ error: ModelTestError?) { persistedResetFailure = error }
  func failDisconnect(_ error: ModelTestError?) { disconnectFailure = error }
  func failDiscard(_ error: ModelTestError?) { discardFailure = error }
  func disconnectCount() -> Int { disconnectCalls }
  func discardCount() -> Int { discardCalls }

  func suspendNextConnect() { shouldSuspendNextConnect = true }
  func connectIsSuspended() -> Bool { suspendedConnectContinuation != nil }
  func resumeConnect() {
    suspendedConnectContinuation?.resume()
    suspendedConnectContinuation = nil
  }

  func suspendNextDisconnect() { shouldSuspendNextDisconnect = true }
  func disconnectIsSuspended() -> Bool { suspendedDisconnectContinuation != nil }
  func resumeDisconnect() {
    suspendedDisconnectContinuation?.resume()
    suspendedDisconnectContinuation = nil
  }

  func suspendNextDispose() { shouldSuspendNextDispose = true }
  func disposeIsSuspended() -> Bool { suspendedDisposeContinuation != nil }
  func resumeDispose() {
    suspendedDisposeContinuation?.resume()
    suspendedDisposeContinuation = nil
  }

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

@MainActor
private final class HostRoomModelFactory: @unchecked Sendable {
  private var connectionsByAccount: [UUID: [ModelRoomConnection]]

  init(connectionsByAccount: [UUID: [ModelRoomConnection]]) {
    self.connectionsByAccount = connectionsByAccount
  }

  func makeModel(for account: AccountUser) -> RoomSessionModel {
    guard var connections = connectionsByAccount[account.id], !connections.isEmpty else {
      preconditionFailure("Missing model connection fixture")
    }
    let connection = connections.removeFirst()
    connectionsByAccount[account.id] = connections
    return RoomSessionModel(
      account: account,
      environment: RoomSessionEnvironment(
        makeConnection: { connection },
        createInvite: { _ in throw ModelTestError.inviteUnavailable },
        seatStore: RecordingSeatStore(),
        nowMilliseconds: { 1_784_998_800_000 }
      )
    )
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
  private let failSaveRoomCode: String?

  init(failClear: Bool = false, failSaveRoomCode: String? = nil) {
    self.failClear = failClear
    self.failSaveRoomCode = failSaveRoomCode
  }

  func load(accountID: UUID) -> RoomSeatRecoveryRecord? {
    guard storedRecord?.accountID == accountID else { return nil }
    return storedRecord
  }

  func save(_ record: RoomSeatRecoveryRecord) throws {
    if record.roomCode == failSaveRoomCode { throw ModelTestError.seatCleanupUnavailable }
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
  private var storedRecord: RoomSeatRecoveryRecord?
  private var saveContinuation: CheckedContinuation<Void, Error>?

  func load(accountID _: UUID) -> RoomSeatRecoveryRecord? { nil }

  func save(_ record: RoomSeatRecoveryRecord) async throws {
    entered = true
    try await withCheckedThrowingContinuation { saveContinuation = $0 }
    storedRecord = record
  }

  func clear(accountID: UUID) {
    guard storedRecord?.accountID == accountID else { return }
    storedRecord = nil
  }

  func saveEntered() -> Bool { entered }

  func resumeSaveWithFailure() {
    saveContinuation?.resume(throwing: ModelTestError.seatCleanupUnavailable)
    saveContinuation = nil
  }

  func resumeSave() {
    saveContinuation?.resume()
    saveContinuation = nil
  }

  func record() -> RoomSeatRecoveryRecord? { storedRecord }
}

private actor SuspendedSeatLoadStore: RoomSeatRecoveryStore {
  private var storedRecord: RoomSeatRecoveryRecord?
  private var loadContinuation: CheckedContinuation<Void, Never>?

  init(record: RoomSeatRecoveryRecord?) { storedRecord = record }

  func load(accountID: UUID) async -> RoomSeatRecoveryRecord? {
    await withCheckedContinuation { loadContinuation = $0 }
    guard storedRecord?.accountID == accountID else { return nil }
    return storedRecord
  }

  func save(_ record: RoomSeatRecoveryRecord) { storedRecord = record }

  func clear(accountID: UUID) {
    guard storedRecord?.accountID == accountID else { return }
    storedRecord = nil
  }

  func loadIsSuspended() -> Bool { loadContinuation != nil }
  func resumeLoad() {
    loadContinuation?.resume()
    loadContinuation = nil
  }
}

private actor SuspendedSeatClearStore: RoomSeatRecoveryStore {
  private var storedRecord: RoomSeatRecoveryRecord?
  private let failClear: Bool
  private var shouldSuspendNextClear = true
  private var clearContinuation: CheckedContinuation<Void, Never>?

  init(failClear: Bool = false) {
    self.failClear = failClear
  }

  func load(accountID: UUID) -> RoomSeatRecoveryRecord? {
    guard storedRecord?.accountID == accountID else { return nil }
    return storedRecord
  }

  func save(_ record: RoomSeatRecoveryRecord) { storedRecord = record }

  func clear(accountID: UUID) async throws {
    if shouldSuspendNextClear {
      shouldSuspendNextClear = false
      await withCheckedContinuation { clearContinuation = $0 }
    }
    if failClear { throw ModelTestError.seatCleanupUnavailable }
    guard storedRecord?.accountID == accountID else { return }
    storedRecord = nil
  }

  func clearIsSuspended() -> Bool { clearContinuation != nil }
  func resumeClear() {
    clearContinuation?.resume()
    clearContinuation = nil
  }
  func record() -> RoomSeatRecoveryRecord? { storedRecord }
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
  variant: ModelSnapshotVariant,
  roomCode: String = "ABCDE"
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
  await socket.deliver(.text(try modelSnapshotFixtureText(
    revision: revision,
    variant: variant,
    roomCode: roomCode
  )))
  guard await modelEventually({ await connection.status().synchronized }),
        let snapshot = await connection.snapshot()
  else { throw ModelTestError.snapshotUnavailable }
  await connection.dispose()
  return snapshot
}

private func modelSnapshotFixtureText(
  revision: Int64,
  variant: ModelSnapshotVariant,
  roomCode: String
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
        let fixture = cases.first(where: {
          $0["name"] as? String
            == (variant.isEightPlayerOpening ? "bounded shared snapshot" : "personalized snapshot")
        }),
        var frame = fixture["value"] as? [String: Any],
        var room = frame["room"] as? [String: Any]
  else { throw ModelTestError.invalidFixture }

  frame["revision"] = revision
  if variant.isEightPlayerOpening {
    frame["playerId"] = "10000000-0000-4000-8000-000000000001"
  }
  room["revision"] = revision
  room["code"] = roomCode
  switch variant {
  case .openingEightPlayer:
    break
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
  case openingEightPlayer
  case playing
  case waiting
  case scoring(allReady: Bool)
  case takeoverEligible

  var isEightPlayerOpening: Bool {
    if case .openingEightPlayer = self { return true }
    return false
  }
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
