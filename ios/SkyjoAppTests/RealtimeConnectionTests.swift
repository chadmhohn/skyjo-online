import Foundation
import SkyjoNetworking
import Testing

@Suite("Protocol-v2 realtime contracts", .serialized)
struct RealtimeContractTests {
  @Test("Every canonical client frame is accepted and every invalid frame fails closed")
  func canonicalClientFixtures() throws {
    for fixture in try realtimeFixtureCases(file: "protocol-client.valid.json") {
      let data = try fixtureData(fixture.value)
      do {
        try RealtimeFrameCodec.validateClientFrame(data)
      } catch {
        Issue.record("Valid client fixture '\(fixture.name)' was rejected: \(error)")
      }
    }

    for fixture in try realtimeFixtureCases(file: "protocol-client.invalid.json") {
      let data = try fixtureData(fixture.value)
      do {
        try RealtimeFrameCodec.validateClientFrame(data)
        Issue.record("Invalid client fixture '\(fixture.name)' was accepted.")
      } catch {
        // Expected: all malformed and wire-oversized client frames fail closed.
      }
    }
  }

  @Test("Every canonical server frame decodes and every invalid frame fails closed")
  func canonicalServerFixtures() throws {
    for fixture in try realtimeFixtureCases(file: "protocol-server.valid.json") {
      let data = try fixtureData(fixture.value)
      do {
        _ = try RealtimeFrameCodec.decodeServerFrame(data)
      } catch {
        Issue.record("Valid server fixture '\(fixture.name)' was rejected: \(error)")
      }
    }

    for fixture in try realtimeFixtureCases(file: "protocol-server.invalid.json") {
      let data = try fixtureData(fixture.value)
      do {
        _ = try RealtimeFrameCodec.decodeServerFrame(data)
        Issue.record("Invalid server fixture '\(fixture.name)' was accepted.")
      } catch {
        // Expected: schema, consumer, and privacy violations all fail closed.
      }
    }
  }

  @Test("Client frames use exact keys, canonical bytes, and UTF-16 chat bounds")
  func canonicalClientEncodingAndUnicodeBounds() throws {
    let commandID = try #require(UUID(uuidString: "40000000-0000-4000-8000-000000000047"))
    let maximumChat = String(repeating: "🃏", count: 140)
    let oversizedChat = maximumChat + "🃏"
    #expect(maximumChat.utf16.count == 280)
    #expect(oversizedChat.utf16.count == 282)

    let maximumWire = try RealtimeFrameCodec.encodeCommand(
      commandID: commandID,
      expectedRevision: 7,
      action: .sendChatMessage(maximumChat)
    )
    try RealtimeFrameCodec.validateClientFrame(Data(maximumWire.utf8))
    let maximumObject = try #require(
      JSONSerialization.jsonObject(with: Data(maximumWire.utf8)) as? [String: Any]
    )
    #expect(Set(maximumObject.keys) == ["type", "protocolVersion", "commandId", "expectedRevision", "action"])
    let action = try #require(maximumObject["action"] as? [String: Any])
    #expect(Set(action.keys) == ["type", "text"])
    #expect((action["text"] as? String)?.utf16.count == 280)

    do {
      _ = try RealtimeFrameCodec.encodeCommand(
        commandID: commandID,
        expectedRevision: 7,
        action: .sendChatMessage(oversizedChat)
      )
      Issue.record("A 282-code-unit chat command should fail before transport.")
    } catch let error as RoomConnectionContractError {
      #expect(error == .invalidAction)
    }

    let admission = try RealtimeFrameCodec.encodeAdmission(.create(displayName: "Host"))
    #expect(
      admission
        == #"{"name":"Host","protocolVersion":2,"snapshotEnvelopeVersion":2,"type":"create-room"}"#
    )
    #expect(try RealtimeFrameCodec.encodePresence(visible: false) == #"{"type":"set-presence","visible":false}"#)
  }

  @Test("UUIDs, integer extrema, and malformed Unicode fail closed without traps")
  func primitiveWireBoundaries() throws {
    let validCommandID = try #require(UUID(uuidString: "40000000-0000-4000-8000-000000000047"))
    let invalidUUIDs = [
      UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
      UUID(uuidString: "40000000-0000-0000-8000-000000000047")!,
      UUID(uuidString: "40000000-0000-4000-7000-000000000047")!,
    ]
    for invalidUUID in invalidUUIDs {
      #expect(throws: RoomConnectionContractError.invalidAction) {
        _ = try RealtimeFrameCodec.encodeCommand(
          commandID: invalidUUID,
          expectedRevision: 0,
          action: .startGame
        )
      }
      #expect(throws: RoomConnectionContractError.invalidAdmission) {
        _ = try RealtimeFrameCodec.encodeAdmission(.join(
          code: "ABCDE",
          displayName: "Host",
          playerID: "seat-1",
          resetRecovery: RoomResetRecovery(commandID: invalidUUID, expectedRevision: 0)
        ))
      }
      #expect(throws: RoomConnectionContractError.invalidAdmission) {
        _ = try RoomResetRecoveryRecord(
          accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
          roomCode: "ABCDE",
          playerID: "seat-1",
          commandID: invalidUUID,
          expectedRevision: 0
        )
      }
    }

    let revisionLiterals = [
      "9223372036854775807",
      "-9223372036854775808",
      "9007199254740992",
      "9007199254740993",
    ]
    for revision in revisionLiterals {
      let client = #"{"action":{"type":"start-game"},"commandId":"40000000-0000-4000-8000-000000000047","expectedRevision":\#(revision),"protocolVersion":2,"type":"command"}"#
      #expect(throws: RoomConnectionContractError.invalidFrame) {
        try RealtimeFrameCodec.validateClientFrame(Data(client.utf8))
      }
      let server = #"{"commandId":"40000000-0000-4000-8000-000000000047","protocolVersion":2,"revision":\#(revision),"type":"ack"}"#
      #expect(throws: RoomConnectionContractError.invalidFrame) {
        _ = try RealtimeFrameCodec.decodeServerFrame(Data(server.utf8))
      }
    }

    for escapedSurrogate in [#"\ud800"#, #"\udc00"#] {
      let raw = #"{"action":{"text":"\#(escapedSurrogate)","type":"send-chat-message"},"commandId":"40000000-0000-4000-8000-000000000047","expectedRevision":0,"protocolVersion":2,"type":"command"}"#
      #expect(throws: RoomConnectionContractError.invalidFrame) {
        try RealtimeFrameCodec.validateClientFrame(Data(raw.utf8))
      }
    }

    _ = try RealtimeFrameCodec.encodeCommand(
      commandID: validCommandID,
      expectedRevision: 9_007_199_254_740_991,
      action: .startGame
    )
  }

  @Test("WebSocket endpoint mapping is origin-bound and rejects ambiguous bases")
  func websocketEndpointMapping() throws {
    #expect(
      try SkyjoAPIClient.roomWebSocketURL(for: URL(string: "https://example.test")!).absoluteString
        == "wss://example.test/rooms"
    )
    #expect(
      try SkyjoAPIClient.roomWebSocketURL(for: URL(string: "http://127.0.0.1:4180/")!).absoluteString
        == "ws://127.0.0.1:4180/rooms"
    )

    for invalid in [
      "ftp://example.test",
      "https://user:password@example.test",
      "https://example.test/path",
      "https://example.test?redirect=elsewhere",
      "https://example.test/#fragment",
    ] {
      do {
        _ = try SkyjoAPIClient.roomWebSocketURL(for: URL(string: invalid)!)
        Issue.record("Invalid API base was accepted: \(invalid)")
      } catch let error as RoomConnectionError {
        #expect(error == .invalidWebSocketURL)
      }
    }
  }

  @Test("Public diagnostics redact room identity, player identity, chat, and private state")
  func diagnosticsAreRedacted() throws {
    let fixture = try #require(
      try realtimeFixtureCases(file: "protocol-server.valid.json")
        .first(where: { $0.name == "bounded shared snapshot" })
    )
    let frame = try RealtimeFrameCodec.decodeServerFrame(try fixtureData(fixture.value))
    let rendered = String(reflecting: frame)
    #expect(!rendered.contains("ABCDE"))
    #expect(!rendered.contains("Host"))
    #expect(!rendered.contains("TTTT"))
    #expect(!rendered.contains("10000000-0000"))

    let notice = RoomConnectionNotice.commandRejected(
      code: "illegal-move",
      message: "private server detail",
      matchedAction: .replaceCard(2)
    )
    #expect(!String(reflecting: notice).contains("private server detail"))
    #expect(!String(reflecting: RoomConnectionNotice.roomResetByHost(
      roomCode: "ABCDE"
    )).contains("ABCDE"))
  }
}

@Suite("Protocol-v2 room connection state machine", .serialized)
struct RoomConnectionStateMachineTests {
  @Test("Admission, authoritative snapshots, presence, one-command gating, replay, and convergence")
  func replayAndConvergence() async throws {
    let firstSocket = FakeRoomWebSocket()
    let secondSocket = FakeRoomWebSocket()
    let factory = FakeSocketFactory([firstSocket, secondSocket])
    let sleeper = ControlledSleeper()
    let commandID = try #require(UUID(uuidString: "40000000-0000-4000-8000-000000000041"))
    let connection = try makeTestConnection(
      factory: factory,
      sleeper: sleeper,
      commandIDs: [commandID]
    )
    do {

    try await connection.connect(.create(displayName: "Host"))
    #expect(await eventually { await firstSocket.sentTexts().count == 1 })
    #expect((await firstSocket.sentTexts()).first?.contains(#""type":"create-room""#) == true)

    await firstSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })
    #expect(await connection.snapshot()?.revision == 7)
    #expect(await eventually { await firstSocket.sentTexts().count == 2 })
    #expect((await firstSocket.sentTexts())[1] == #"{"type":"set-presence","visible":true}"#)

    let returnedID = try await connection.send(.sendChatMessage("exact replay"))
    #expect(returnedID == commandID)
    do {
      _ = try await connection.send(.startGame)
      Issue.record("A second command was accepted while one was unresolved.")
    } catch let error as RoomConnectionError {
      #expect(error == .commandAlreadyPending)
    }
    let originalCommand = try #require((await firstSocket.sentTexts()).last)

    await firstSocket.fail()
    #expect(await eventually { await sleeper.hasPending(milliseconds: 500) })
    #expect(await sleeper.release(milliseconds: 500))
    #expect(await eventually { await secondSocket.sentTexts().count == 1 })
    #expect((await secondSocket.sentTexts()).first?.contains(#""type":"join-room""#) == true)

    await secondSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await secondSocket.sentTexts().count == 3 })
    let replayedCommand = (await secondSocket.sentTexts())[2]
    #expect(replayedCommand == originalCommand)

    await secondSocket.deliver(.text(try acknowledgementText(commandID: commandID, revision: 8)))
    #expect(await eventually { await connection.status().hasPendingCommand })
    await secondSocket.deliver(.text(try personalizedSnapshotText(revision: 8)))
    #expect(await eventually { !(await connection.status().hasPendingCommand) })
    #expect(await connection.status().revision == 8)

    } catch {
      await connection.dispose()
      throw error
    }
    await connection.dispose()
  }

  @Test("Correlated stale and future resyncs release ambiguous commands")
  func staleAndFutureResync() async throws {
    for reason in [RoomResyncReason.staleRevision, .futureRevision] {
      let socket = FakeRoomWebSocket()
      let commandID = reason == .staleRevision
        ? UUID(uuidString: "40000000-0000-4000-8000-000000000042")!
        : UUID(uuidString: "40000000-0000-4000-8000-000000000043")!
      let connection = try makeTestConnection(
        factory: FakeSocketFactory([socket]),
        sleeper: ControlledSleeper(),
        commandIDs: [commandID]
      )

      try await connection.connect(.create(displayName: "Host"))
      await socket.deliver(.text(try personalizedSnapshotText(revision: 7)))
      #expect(await eventually { await connection.status().synchronized })
      _ = try await connection.send(.sendChatMessage("ambiguous"))
      await socket.deliver(.text(try resyncText(
        commandID: commandID,
        revision: 7,
        reason: reason,
        roomCode: "ABCDE"
      )))
      #expect(await eventually { !(await connection.status().hasPendingCommand) })
      #expect(await connection.snapshot()?.revision == 7)
      await connection.dispose()
    }
  }

  @Test("Ack/snapshot ordering, uncorrelated frames, and leave acknowledgement converge exactly")
  func acknowledgementOrderingAndLeave() async throws {
    let socket = FakeRoomWebSocket()
    let firstID = UUID(uuidString: "40000000-0000-4000-8000-000000000051")!
    let secondID = UUID(uuidString: "40000000-0000-4000-8000-000000000052")!
    let unrelatedID = UUID(uuidString: "40000000-0000-4000-8000-000000000053")!
    let connection = try makeTestConnection(
      factory: FakeSocketFactory([socket]),
      sleeper: ControlledSleeper(),
      commandIDs: [firstID, secondID]
    )

    try await connection.connect(.create(displayName: "Host"))
    await socket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })
    _ = try await connection.send(.sendChatMessage("snapshot first"))
    await socket.deliver(.text(try personalizedSnapshotText(revision: 8)))
    #expect(await eventually { await connection.status().revision == 8 })
    #expect(await connection.status().hasPendingCommand)

    await socket.deliver(.text(try acknowledgementText(commandID: unrelatedID, revision: 8)))
    await socket.deliver(.text(#"{"code":"room-required","message":"Auxiliary.","protocolVersion":2,"type":"error"}"#))
    #expect(await connection.status().hasPendingCommand)
    await socket.deliver(.text(try acknowledgementText(commandID: firstID, revision: 8)))
    #expect(await eventually { !(await connection.status().hasPendingCommand) })

    _ = try await connection.send(.leaveRoom)
    await socket.deliver(.text(try acknowledgementText(
      commandID: secondID,
      revision: 9,
      result: "room-left"
    )))
    #expect(await eventually { await connection.status().phase == .idle })
    #expect(await connection.snapshot() == nil)
    #expect(await connection.recoveryAdmission() == nil)
    await connection.dispose()
  }

  @Test("Room reset recovery is bound before send and converges onto the replacement code")
  func resetRecovery() async throws {
    let socket = FakeRoomWebSocket()
    let commandID = UUID(uuidString: "40000000-0000-4000-8000-000000000044")!
    let connection = try makeTestConnection(
      factory: FakeSocketFactory([socket]),
      sleeper: ControlledSleeper(),
      commandIDs: [commandID]
    )

    try await connection.connect(.create(displayName: "Host"))
    await socket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })
    _ = try await connection.send(.resetRoom)

    guard case .join(let oldCode, _, let playerID?, let recovery?) = await connection.recoveryAdmission() else {
      Issue.record("Reset recovery was not persisted before transport send.")
      await connection.dispose()
      return
    }
    #expect(oldCode == "ABCDE")
    #expect(playerID == "10000000-0000-4000-8000-000000000001")
    #expect(recovery == RoomResetRecovery(commandID: commandID, expectedRevision: 7))

    await socket.deliver(.text(try resyncText(
      commandID: commandID,
      revision: 8,
      reason: .roomReset,
      roomCode: "FGHIJ"
    )))
    #expect(await eventually { await connection.snapshot()?.room.code == "FGHIJ" })
    #expect(!(await connection.status().hasPendingCommand))
    guard case .join(let replacementCode, _, _, let recoveryAfter) = await connection.recoveryAdmission() else {
      Issue.record("Replacement room was not made recoverable.")
      await connection.dispose()
      return
    }
    #expect(replacementCode == "FGHIJ")
    #expect(recoveryAfter == nil)
    await connection.dispose()
  }

  @Test("Reset recovery survives actor recreation, is account fenced, and clears after reset resync")
  func durableResetRecoveryAcrossActors() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "skyjo-reset-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileURL = directory.appending(path: "recovery.json", directoryHint: .notDirectory)
    let storeA = FileRoomResetRecoveryStore(fileURL: fileURL)
    let resetGate = SuspendingSendGate()
    let firstSocket = FakeRoomWebSocket(sendGates: [3: resetGate])
    let commandID = UUID(uuidString: "40000000-0000-4000-8000-000000000054")!
    let first = try makeTestConnection(
      factory: FakeSocketFactory([firstSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [commandID],
      resetRecoveryStore: storeA
    )
    try await first.connect(.create(displayName: "Host"))
    await firstSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await first.status().synchronized })
    let resetTask = Task { try await first.send(.resetRoom) }
    #expect(await eventually { await resetGate.hasEntered() })

    let bytes = try Data(contentsOf: fileURL)
    let storedObject = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    #expect(Set(storedObject.keys) == ["accountID", "roomCode", "playerID", "commandID", "expectedRevision"])
    let storedText = try #require(String(data: bytes, encoding: .utf8))
    #expect(!storedText.contains("Host"))
    #expect(!storedText.contains("@"))

    let wrongAccount = UUID(uuidString: "50000000-0000-4000-8000-000000000005")!
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(
        RoomResetRecoveryRecord.self,
        from: Data(
          #"{"accountID":"30000000-0000-4000-8000-000000000003","roomCode":"abcde","playerID":"seat-1","commandID":"40000000-0000-4000-8000-000000000054","expectedRevision":7}"#.utf8
        )
      )
    }
    #expect(try await storeA.load(accountID: wrongAccount) == nil)
    try await storeA.clear(accountID: wrongAccount, commandID: commandID)
    #expect(try await storeA.load(accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!) != nil)
    try await storeA.discard(accountID: wrongAccount)
    #expect(try await storeA.load(accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!) != nil)

    let storeB = FileRoomResetRecoveryStore(fileURL: fileURL)
    let secondSocket = FakeRoomWebSocket()
    let secondSleeper = ControlledSleeper()
    let second = try makeTestConnection(
      factory: FakeSocketFactory([secondSocket]),
      sleeper: secondSleeper,
      commandIDs: [],
      resetRecoveryStore: storeB
    )
    #expect(try await second.recoverPersistedReset())
    #expect(await eventually { await secondSleeper.hasPending(milliseconds: 500) })
    #expect(await secondSleeper.release(milliseconds: 500))
    #expect(await eventually { await secondSocket.sentTexts().count == 1 })
    let recoveryWire = try #require((await secondSocket.sentTexts()).first)
    #expect(recoveryWire.contains(commandID.uuidString.lowercased()))
    #expect(recoveryWire.contains(#""recoveryCommandId""#))

    await secondSocket.deliver(.text(try resyncText(
      commandID: commandID,
      revision: 8,
      reason: .roomReset,
      roomCode: "FGHIJ"
    )))
    #expect(await eventually { await second.snapshot()?.room.code == "FGHIJ" })
    #expect(await eventually {
      (try? await storeB.load(accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!)) == nil
    })

    await resetGate.succeed()
    _ = try await resetTask.value
    await first.dispose()
    await second.dispose()

    #expect(
      FileRoomResetRecoveryStore.applicationSupportStore()
        === FileRoomResetRecoveryStore.applicationSupportStore()
    )
    let concurrentA = FileRoomResetRecoveryStore(fileURL: fileURL)
    let concurrentB = FileRoomResetRecoveryStore(fileURL: fileURL)
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    for _ in 0..<32 {
      let oldID = UUID()
      let newID = UUID()
      let oldRecord = try RoomResetRecoveryRecord(
        accountID: accountID,
        roomCode: "ABCDE",
        playerID: "seat-1",
        commandID: oldID,
        expectedRevision: 7
      )
      let newRecord = try RoomResetRecoveryRecord(
        accountID: accountID,
        roomCode: "FGHIJ",
        playerID: "seat-1",
        commandID: newID,
        expectedRevision: 8
      )
      try await concurrentA.save(oldRecord)
      async let staleClear: Void = concurrentA.clear(accountID: accountID, commandID: oldID)
      async let newerSave: Void = concurrentB.save(newRecord)
      _ = try await (staleClear, newerSave)
      #expect(try await concurrentA.load(accountID: accountID)?.commandID == newID)
    }

    try Data("not-json".utf8).write(to: fileURL, options: [.atomic])
    await #expect(throws: (any Error).self) { try await storeB.load(accountID: wrongAccount) }
    try await storeB.discard(accountID: accountID)
    #expect(try await storeB.load(accountID: accountID) == nil)
    try Data(repeating: 0x61, count: FileRoomResetRecoveryStore.maximumRecordBytes + 1)
      .write(to: fileURL, options: [.atomic])
    await #expect(throws: (any Error).self) { try await storeB.load(accountID: wrongAccount) }

    let directoryAsFile = directory.appending(path: "directory-target", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directoryAsFile, withIntermediateDirectories: true)
    let writeFailureStore = FileRoomResetRecoveryStore(fileURL: directoryAsFile)
    let validRecord = try RoomResetRecoveryRecord(
      accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
      roomCode: "ABCDE",
      playerID: "seat-1",
      commandID: commandID,
      expectedRevision: 7
    )
    await #expect(throws: (any Error).self) { try await writeFailureStore.save(validRecord) }
  }

  @Test("Ordinary disconnect is exact-fenced while explicit discard removes account recovery")
  func disconnectDoesNotBroadlyDiscardAnotherGeneration() async throws {
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    let commandID = UUID(uuidString: "40000000-0000-4000-8000-000000000075")!
    let store = VolatileRoomResetRecoveryStore()
    let newerRecord = try RoomResetRecoveryRecord(
      accountID: accountID,
      roomCode: "FGHIJ",
      playerID: "seat-new",
      commandID: commandID,
      expectedRevision: 11
    )
    try await store.save(newerRecord)
    let oldConnection = try makeTestConnection(
      factory: FakeSocketFactory([]),
      sleeper: ControlledSleeper(),
      commandIDs: [],
      resetRecoveryStore: store
    )

    try await oldConnection.disconnect()
    #expect(await store.load(accountID: accountID) == newerRecord)

    try await oldConnection.discardPersistedResetRecovery()
    #expect(await store.load(accountID: accountID) == nil)
    await oldConnection.dispose()
  }

  @Test("Persistence failures block reset wire and abandoned recoveries are retried exactly")
  func resetPersistenceFailureAndAbandonment() async throws {
    let failureSocket = FakeRoomWebSocket()
    let failureStore = FailingResetRecoveryStore(failSave: true)
    let failure = try makeTestConnection(
      factory: FakeSocketFactory([failureSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [UUID(uuidString: "40000000-0000-4000-8000-000000000055")!],
      resetRecoveryStore: failureStore
    )
    try await failure.connect(.create(displayName: "Host"))
    await failureSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await failure.status().synchronized })
    await #expect(throws: RoomConnectionError.resetRecoveryPersistenceFailed) {
      try await failure.send(.resetRoom)
    }
    #expect((await failureSocket.sentTexts()).count == 2)
    #expect(!(await failure.status().hasPendingCommand))
    await failure.dispose()

    let retryStore = FailingResetRecoveryStore(failClearCount: 1)
    let firstSocket = FakeRoomWebSocket()
    let secondSocket = FakeRoomWebSocket()
    let commandID = UUID(uuidString: "40000000-0000-4000-8000-000000000056")!
    let retrying = try makeTestConnection(
      factory: FakeSocketFactory([firstSocket, secondSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [commandID],
      resetRecoveryStore: retryStore
    )
    try await retrying.connect(.create(displayName: "Host"))
    await firstSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await retrying.status().synchronized })
    _ = try await retrying.send(.resetRoom)
    await firstSocket.deliver(.text(try resyncText(
      commandID: commandID,
      revision: 8,
      reason: .roomReset,
      roomCode: "FGHIJ"
    )))
    #expect(await eventually { await retrying.snapshot()?.room.code == "FGHIJ" })
    #expect(await retryStore.hasRecord())
    try await retrying.connect(.create(displayName: "Host"))
    #expect(!(await retryStore.hasRecord()))
    #expect(await eventually { await secondSocket.sentTexts().count == 1 })
    await retrying.dispose()

    let abandonedStore = VolatileRoomResetRecoveryStore()
    let sendGate = SuspendingSendGate()
    let abandonedFirst = FakeRoomWebSocket(sendGates: [3: sendGate])
    let abandonedSecond = FakeRoomWebSocket()
    let abandonedID = UUID(uuidString: "40000000-0000-4000-8000-000000000057")!
    let abandoned = try makeTestConnection(
      factory: FakeSocketFactory([abandonedFirst, abandonedSecond]),
      sleeper: ControlledSleeper(),
      commandIDs: [abandonedID],
      resetRecoveryStore: abandonedStore
    )
    try await abandoned.connect(.create(displayName: "Host"))
    await abandonedFirst.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await abandoned.status().synchronized })
    let suspendedReset = Task { try await abandoned.send(.resetRoom) }
    #expect(await eventually { await sendGate.hasEntered() })
    try await abandoned.connect(.create(displayName: "Host"))
    #expect(await abandonedStore.load(accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!) == nil)
    await sendGate.succeed()
    _ = try await suspendedReset.value
    #expect(!(await abandoned.status().hasPendingCommand))
    #expect(await eventually { await abandonedSecond.sentTexts().count == 1 })
    await abandoned.dispose()
  }

  @Test("Preparing resets, duplicate reachability, and failed clears cannot resurrect durability")
  func preparingResetAndConnectivityInterleavings() async throws {
    let preparingStore = SuspendingSaveResetRecoveryStore(clearFailures: 2)
    let firstSocket = FakeRoomWebSocket()
    let secondSocket = FakeRoomWebSocket()
    let commandID = UUID(uuidString: "40000000-0000-4000-8000-000000000058")!
    let preparing = try makeTestConnection(
      factory: FakeSocketFactory([firstSocket, secondSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [commandID],
      resetRecoveryStore: preparingStore
    )
    try await preparing.connect(.create(displayName: "Host"))
    await firstSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await preparing.status().synchronized })
    let resetTask = Task { try await preparing.send(.resetRoom) }
    let saveGate = preparingStore.saveGate
    #expect(await eventually { await saveGate.hasEntered() })

    await #expect(throws: RoomConnectionError.resetRecoveryPersistenceFailed) {
      try await preparing.connect(.create(displayName: "Host"))
    }
    #expect(await preparingStore.hasRecord())
    await saveGate.succeed()
    await #expect(throws: RoomConnectionError.resetRecoveryPersistenceFailed) {
      try await resetTask.value
    }
    #expect((await firstSocket.sentTexts()).count == 2)
    #expect(await preparingStore.hasRecord())

    try await preparing.connect(.create(displayName: "Host"))
    #expect(!(await preparingStore.hasRecord()))
    #expect(await eventually { await secondSocket.sentTexts().count == 1 })
    await preparing.dispose()

    let clearStore = SuspendingClearResetRecoveryStore()
    let recoveryID = UUID(uuidString: "40000000-0000-4000-8000-000000000059")!
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    try await clearStore.seed(RoomResetRecoveryRecord(
      accountID: accountID,
      roomCode: "ABCDE",
      playerID: "seat-1",
      commandID: recoveryID,
      expectedRevision: 7
    ))
    let connectivitySocket = FakeRoomWebSocket()
    let connectivitySleeper = ControlledSleeper()
    let connectivity = try makeTestConnection(
      factory: FakeSocketFactory([connectivitySocket]),
      sleeper: connectivitySleeper,
      commandIDs: [],
      resetRecoveryStore: clearStore
    )
    #expect(try await connectivity.recoverPersistedReset())
    let freshConnect = Task { try await connectivity.connect(.create(displayName: "Host")) }
    #expect(await eventually { await clearStore.clearGate.hasEntered() })
    await connectivity.setNetworkAvailable(true)
    await clearStore.clearGate.succeed()
    try await freshConnect.value
    #expect(await eventually { await connectivitySocket.sentTexts().count == 1 })
    #expect(await connectivity.status().phase == .connecting)
    await connectivity.dispose()
  }

  @Test("Cancelled and partially failed reset preparation cleans exact durability before later commands")
  func cancelledAndPartialResetPreparationCleanup() async throws {
    let cancelledStore = SuspendingSaveResetRecoveryStore(clearFailures: 0)
    let cancelledSocket = FakeRoomWebSocket()
    let cancelledResetID = UUID(uuidString: "40000000-0000-4000-8000-000000000064")!
    let afterCancellationID = UUID(uuidString: "40000000-0000-4000-8000-000000000065")!
    let cancelled = try makeTestConnection(
      factory: FakeSocketFactory([cancelledSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [cancelledResetID, afterCancellationID],
      resetRecoveryStore: cancelledStore
    )
    try await cancelled.connect(.create(displayName: "Host"))
    await cancelledSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await cancelled.status().synchronized })
    let cancelledWireBaseline = await cancelledSocket.sentTexts().count
    let cancelledReset = Task { try await cancelled.send(.resetRoom) }
    let cancelledSaveGate = cancelledStore.saveGate
    #expect(await eventually { await cancelledSaveGate.hasEntered() })
    cancelledReset.cancel()
    await cancelledSaveGate.succeed()
    await #expect(throws: CancellationError.self) {
      try await cancelledReset.value
    }
    #expect(!(await cancelledStore.hasRecord()))
    #expect(!(await cancelled.status().hasPendingCommand))
    #expect(await cancelledSocket.sentTexts().count == cancelledWireBaseline)
    _ = try await cancelled.send(.sendChatMessage("fresh after cancellation"))
    #expect(await cancelledSocket.sentTexts().count == cancelledWireBaseline + 1)
    await cancelled.dispose()

    let partialStore = SuspendingSaveResetRecoveryStore(clearFailures: 0)
    let partialSocket = FakeRoomWebSocket()
    let partialResetID = UUID(uuidString: "40000000-0000-4000-8000-000000000066")!
    let partial = try makeTestConnection(
      factory: FakeSocketFactory([partialSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [partialResetID],
      resetRecoveryStore: partialStore
    )
    try await partial.connect(.create(displayName: "Host"))
    await partialSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await partial.status().synchronized })
    let partialWireBaseline = await partialSocket.sentTexts().count
    let partialReset = Task { try await partial.send(.resetRoom) }
    let partialSaveGate = partialStore.saveGate
    #expect(await eventually { await partialSaveGate.hasEntered() })
    await partialSaveGate.fail()
    await #expect(throws: RoomConnectionError.resetRecoveryPersistenceFailed) {
      try await partialReset.value
    }
    #expect(!(await partialStore.hasRecord()))
    #expect(!(await partial.status().hasPendingCommand))
    #expect(await partialSocket.sentTexts().count == partialWireBaseline)
    await partial.dispose()

    let retryStore = SuspendingSaveResetRecoveryStore(clearFailures: 2)
    let retrySocket = FakeRoomWebSocket()
    let retryResetID = UUID(uuidString: "40000000-0000-4000-8000-000000000067")!
    let afterCleanupID = UUID(uuidString: "40000000-0000-4000-8000-000000000068")!
    let retrying = try makeTestConnection(
      factory: FakeSocketFactory([retrySocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [retryResetID, afterCleanupID],
      resetRecoveryStore: retryStore
    )
    try await retrying.connect(.create(displayName: "Host"))
    await retrySocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await retrying.status().synchronized })
    let retryWireBaseline = await retrySocket.sentTexts().count
    let retryReset = Task { try await retrying.send(.resetRoom) }
    let retrySaveGate = retryStore.saveGate
    #expect(await eventually { await retrySaveGate.hasEntered() })
    retryReset.cancel()
    await retrySaveGate.succeed()
    await #expect(throws: CancellationError.self) {
      try await retryReset.value
    }
    #expect(await retryStore.hasRecord())
    #expect(await retrying.status().hasPendingCommand)
    #expect(await retrySocket.sentTexts().count == retryWireBaseline)

    await #expect(throws: RoomConnectionError.resetRecoveryPersistenceFailed) {
      try await retrying.send(.sendChatMessage("blocked while cleanup is unresolved"))
    }
    #expect(await retryStore.hasRecord())
    #expect(await retrying.status().hasPendingCommand)
    #expect(await retrySocket.sentTexts().count == retryWireBaseline)

    _ = try await retrying.send(.sendChatMessage("fresh after exact cleanup"))
    #expect(!(await retryStore.hasRecord()))
    #expect(await retrySocket.sentTexts().count == retryWireBaseline + 1)
    await retrying.dispose()
  }

  @Test("Upgrade-required quarantines reset state and retries a failed exact durability clear")
  func upgradeRequiredResetDurabilityCleanup() async throws {
    let clearedStore = FailingResetRecoveryStore()
    let clearedSocket = FakeRoomWebSocket()
    let clearedResetID = UUID(uuidString: "40000000-0000-4000-8000-000000000069")!
    let cleared = try makeTestConnection(
      factory: FakeSocketFactory([clearedSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [clearedResetID],
      resetRecoveryStore: clearedStore
    )
    try await cleared.connect(.create(displayName: "Host"))
    await clearedSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await cleared.status().synchronized })
    _ = try await cleared.send(.resetRoom)
    #expect(await clearedStore.hasRecord())
    await clearedSocket.deliver(.text(
      #"{"message":"Upgrade now.","protocolVersion":2,"type":"upgrade-required"}"#
    ))
    #expect(await eventually { await cleared.status().phase == .upgradeRequired })
    #expect(await cleared.snapshot() == nil)
    #expect(await cleared.status().revision == nil)
    #expect(await cleared.recoveryAdmission() == nil)
    #expect(await eventually { !(await clearedStore.hasRecord()) })
    #expect(!(await cleared.status().hasPendingCommand))
    await cleared.dispose()

    let retryStore = FailingResetRecoveryStore(failClearCount: 1)
    let retrySocket = FakeRoomWebSocket()
    let retryResetID = UUID(uuidString: "40000000-0000-4000-8000-000000000070")!
    let retrying = try makeTestConnection(
      factory: FakeSocketFactory([retrySocket]),
      sleeper: ControlledSleeper(),
      commandIDs: [retryResetID],
      resetRecoveryStore: retryStore
    )
    let events = await retrying.events()
    let notices = RoomConnectionNoticeRecorder()
    let observation = Task {
      for await event in events { await notices.record(event) }
    }
    try await retrying.connect(.create(displayName: "Host"))
    await retrySocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await retrying.status().synchronized })
    _ = try await retrying.send(.resetRoom)
    await retrySocket.deliver(.text(
      #"{"message":"Upgrade now.","protocolVersion":2,"type":"upgrade-required"}"#
    ))
    #expect(await eventually { await retrying.status().phase == .upgradeRequired })
    #expect(await retrying.snapshot() == nil)
    #expect(await retrying.status().revision == nil)
    #expect(await retrying.recoveryAdmission() == nil)
    #expect(await retryStore.hasRecord())
    #expect(await retrying.status().hasPendingCommand)
    #expect(await eventually { await notices.contains(.resetRecoveryPersistenceFailed) })

    try await retrying.disconnect()
    #expect(await retrying.status().phase == .idle)
    #expect(!(await retryStore.hasRecord()))
    #expect(!(await retrying.status().hasPendingCommand))
    observation.cancel()
    await retrying.dispose()
  }

  @Test("Terminal room and seat errors quarantine snapshots, revisions, and reset durability")
  func terminalRoomAndSeatErrors() async throws {
    let terminalCommandIDs = [
      UUID(uuidString: "40000000-0000-4000-8000-000000000060")!,
      UUID(uuidString: "40000000-0000-4000-8000-000000000061")!,
      UUID(uuidString: "40000000-0000-4000-8000-000000000062")!,
    ]
    for (index, code) in ["room-reset", "seat-removed", "stale-seat"].enumerated() {
      let socket = FakeRoomWebSocket()
      let store = VolatileRoomResetRecoveryStore()
      let commandID = terminalCommandIDs[index]
      let connection = try makeTestConnection(
        factory: FakeSocketFactory([socket]),
        sleeper: ControlledSleeper(),
        commandIDs: [commandID],
        resetRecoveryStore: store
      )
      try await connection.connect(.create(displayName: "Host"))
      await socket.deliver(.text(try personalizedSnapshotText(revision: 7)))
      #expect(await eventually { await connection.status().synchronized })
      _ = try await connection.send(.resetRoom)
      await socket.deliver(.text(#"{"code":"\#(code)","message":"Sensitive detail.","protocolVersion":2,"type":"error"}"#))
      #expect(await eventually { await connection.status().phase == .idle })
      #expect(await connection.snapshot() == nil)
      #expect(await connection.status().revision == nil)
      #expect(await connection.recoveryAdmission() == nil)
      #expect(await eventually { await store.load(accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!) == nil })
      await connection.dispose()
    }

    let admissionSocket = FakeRoomWebSocket()
    let admissionStore = VolatileRoomResetRecoveryStore()
    let admissionSleeper = ControlledSleeper()
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    let recoveryID = UUID(uuidString: "40000000-0000-4000-8000-000000000063")!
    try await admissionStore.save(RoomResetRecoveryRecord(
      accountID: accountID,
      roomCode: "ABCDE",
      playerID: "seat-1",
      commandID: recoveryID,
      expectedRevision: 7
    ))
    let admission = try makeTestConnection(
      factory: FakeSocketFactory([admissionSocket]),
      sleeper: admissionSleeper,
      commandIDs: [],
      resetRecoveryStore: admissionStore
    )
    #expect(try await admission.recoverPersistedReset())
    #expect(await eventually { await admissionSleeper.hasPending(milliseconds: 500) })
    #expect(await admissionSleeper.release(milliseconds: 500))
    #expect(await eventually { await admissionSocket.sentTexts().count == 1 })
    await admissionSocket.deliver(.text(#"{"code":"stale-room","message":"Sensitive detail.","protocolVersion":2,"type":"error"}"#))
    #expect(await eventually { await admission.status().phase == .error })
    #expect(await admission.snapshot() == nil)
    #expect(await admission.status().revision == nil)
    #expect(await admission.recoveryAdmission() == nil)
    #expect(await eventually { await admissionStore.load(accountID: accountID) == nil })
    #expect(!String(reflecting: RoomConnectionNotice.admissionRejected(
      code: "stale-room",
      message: "Sensitive detail.",
      usedSavedSeat: true
    )).contains("Sensitive detail"))
    await admission.dispose()
  }

  @Test("A suspended old-socket close cannot block or mutate a replacement generation")
  func delayedCloseGenerationFence() async throws {
    let closeGate = SuspendingSendGate()
    let oldSocket = FakeRoomWebSocket(closeGate: closeGate)
    let replacementSocket = FakeRoomWebSocket()
    let connection = try makeTestConnection(
      factory: FakeSocketFactory([oldSocket, replacementSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: []
    )
    try await connection.connect(.create(displayName: "Host"))
    await oldSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })

    try await connection.connect(.create(displayName: "Host"))
    #expect(await eventually { await closeGate.hasEntered() })
    #expect(await eventually { await replacementSocket.sentTexts().count == 1 })
    await oldSocket.deliver(.text(try personalizedSnapshotText(revision: 99)))
    await replacementSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })
    #expect(await connection.status().revision == 7)
    await closeGate.succeed()
    #expect(await connection.status().revision == 7)
    await connection.dispose()
  }

  @Test("Backoff, synchronization timeout, offline hints, terminal frames, and fail-closed input")
  func recoveryAndTerminalBoundaries() async throws {
    #expect(RoomConnection.reconnectDelayMilliseconds(attempt: 0, random: 0) == 400)
    #expect(RoomConnection.reconnectDelayMilliseconds(attempt: 0, random: 0.5) == 500)
    #expect(RoomConnection.reconnectDelayMilliseconds(attempt: 0, random: 1) == 600)
    #expect(RoomConnection.reconnectDelayMilliseconds(attempt: 99, random: 0.5) == 30_000)
    #expect(RoomConnection.reconnectDelayMilliseconds(attempt: -5, random: .nan) == 500)

    let firstSocket = FakeRoomWebSocket()
    let secondSocket = FakeRoomWebSocket()
    let sleeper = ControlledSleeper()
    let connection = try makeTestConnection(
      factory: FakeSocketFactory([firstSocket, secondSocket]),
      sleeper: sleeper,
      commandIDs: []
    )
    try await connection.connect(.join(
      code: "ABCDE",
      displayName: "Host",
      playerID: "10000000-0000-4000-8000-000000000001"
    ))
    #expect(await eventually { await sleeper.hasPending(milliseconds: 8_000) })
    #expect(await sleeper.release(milliseconds: 8_000))
    #expect(await eventually { await sleeper.hasPending(milliseconds: 500) })
    #expect(await connection.status().phase == .reconnecting)

    await connection.setNetworkAvailable(false)
    #expect(await connection.status().phase == .offline)
    #expect(await eventually { !(await sleeper.hasPending(milliseconds: 500)) })
    await connection.setNetworkAvailable(true)
    #expect(await eventually { await sleeper.hasPending(milliseconds: 500) })
    #expect(await sleeper.release(milliseconds: 500))
    #expect(await eventually { await secondSocket.sentTexts().count == 1 })
    await secondSocket.deliver(.data(Data("not-json-text".utf8)))
    #expect(await eventually { (await secondSocket.closed()).contains(where: { $0.code == 1_002 }) })
    await connection.dispose()

    let terminalSocket = FakeRoomWebSocket()
    let terminal = try makeTestConnection(
      factory: FakeSocketFactory([terminalSocket]),
      sleeper: ControlledSleeper(),
      commandIDs: []
    )
    try await terminal.connect(.create(displayName: "Host"))
    await terminalSocket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await terminal.status().synchronized })
    await terminalSocket.deliver(.text(#"{"message":"Upgrade now.","protocolVersion":2,"type":"upgrade-required"}"#))
    #expect(await eventually { await terminal.status().phase == .upgradeRequired })
    #expect(await terminal.recoveryAdmission() == nil)
    await terminal.dispose()
  }

  @Test("Visibility is explicit and the public event stream stays bounded for slow consumers")
  func presenceAndBoundedEvents() async throws {
    let socket = FakeRoomWebSocket()
    let connection = try makeTestConnection(
      factory: FakeSocketFactory([socket]),
      sleeper: ControlledSleeper(),
      commandIDs: []
    )
    let events = await connection.events()
    try await connection.connect(.create(displayName: "Host"))
    await socket.deliver(.text(try personalizedSnapshotText(revision: 7)))
    #expect(await eventually { await connection.status().synchronized })

    await connection.setVisible(false)
    await connection.setVisible(true)
    let texts = await socket.sentTexts()
    #expect(texts.contains(#"{"type":"set-presence","visible":false}"#))
    #expect(texts.last == #"{"type":"set-presence","visible":true}"#)

    for index in 0..<20 {
      await connection.setNetworkAvailable(index.isMultiple(of: 2))
    }
    #expect(await connection.status().phase == .offline)
    await connection.dispose()
    var drained: [RoomConnectionEvent] = []
    for await event in events {
      drained.append(event)
    }
    #expect(drained.count <= 4)
  }
}

@Suite("Protocol-v2 mixed Swift and PWA integration", .serialized)
struct RoomConnectionNodeIntegrationTests {
  private let syntheticAccessPassword = "skyjo-ios-contract-access-v1"
  private let accountPassword = "native-realtime-password-v1"

  @Test(
    "Native invite redemption grants only outer access and rejects a reset room instance",
    .enabled(
      if: MixedPWAControlClient.networkingTestsEnabled,
      "Requires scripts/ios-build-test.sh --networking-contracts."
    )
  )
  func nativeInviteRedemptionAndStaleRoom() async throws {
    let rawBaseURL = try #require(ProcessInfo.processInfo.environment["SKYJO_IOS_TEST_SERVER_URL"])
    let baseURL = try #require(URL(string: rawBaseURL))
    let environment = SkyjoNetworkEnvironment(baseURL: baseURL)

    let hostCookies = realtimeCookieStorage(label: "invite-host")
    let hostSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: hostCookies)
    defer {
      hostSession.invalidateAndCancel()
      clearRealtimeCookies(hostCookies)
    }
    let hostAPI = SkyjoAPIClient(environment: environment, session: hostSession)
    #expect(try await hostAPI.loginAccess(password: syntheticAccessPassword).authenticated)
    let account = try await hostAPI.signup(
      email: "ios-invite-host-\(UUID().uuidString.lowercased())@example.invalid",
      displayName: "Invite Host",
      password: accountPassword,
      confirmPassword: accountPassword
    )
    let connection = try await hostAPI.makeRoomConnection(confirmedAccount: account)
    do {
      try await connection.connect(.create(displayName: account.displayName))
    #expect(await eventually(attempts: 5_000) { await connection.status().synchronized })
    let originalRoom = try #require(await connection.snapshot()).room.code

    // Creation proves the account-authenticated endpoint sees the exact cookie jar
    // already owned by SkyjoAPIClient and its realtime transport.
    let inviteClient = RoomInviteClient(environment: environment, session: hostSession)
    let invite = try await inviteClient.create(roomCode: originalRoom)
    let token = invite.url.lastPathComponent
    let productionURL = try #require(
      URL(string: "https://\(RoomInviteLink.productionHost)/invite/\(token)")
    )
    let link = try RoomInviteLink(url: productionURL)

    let guestCookies = realtimeCookieStorage(label: "invite-guest")
    let guestSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: guestCookies)
    defer {
      guestSession.invalidateAndCancel()
      clearRealtimeCookies(guestCookies)
    }
    let guestInviteClient = RoomInviteClient(environment: environment, session: guestSession)
    let redeemed = try await guestInviteClient.redeem(link)
    #expect(redeemed.roomCode == originalRoom)

    let guestAPI = SkyjoAPIClient(environment: environment, session: guestSession)
    #expect(try await guestAPI.accessStatus().authenticated)
    #expect(try await guestAPI.currentAccount() == nil)

    _ = try await connection.send(.resetRoom)
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand && snapshot.room.code != originalRoom
    })

    let staleCookies = realtimeCookieStorage(label: "invite-stale")
    let staleSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: staleCookies)
    defer {
      staleSession.invalidateAndCancel()
      clearRealtimeCookies(staleCookies)
    }
    let staleClient = RoomInviteClient(environment: environment, session: staleSession)
    await #expect(
      throws: SkyjoHTTPClientError.server(
        statusCode: 410,
        code: .inviteRoomUnavailable,
        message: "That room is no longer available. Ask the host for a new invite."
      )
    ) {
      _ = try await staleClient.redeem(link)
    }

    } catch {
      await connection.dispose()
      throw error
    }
    await connection.dispose()
  }

  @Test(
    "One PWA and seven native clients converge on an eight-player table and compact chat",
    .enabled(
      if: MixedPWAControlClient.networkingTestsEnabled,
      "Requires scripts/ios-build-test.sh --networking-contracts."
    )
  )
  func eightMixedClientsConverge() async throws {
    let control = try MixedPWAControlClient.requiredFromEnvironment()
    let cleanup = MixedNativeClientCleanup()
    do {
      try await control.health()
      try await control.reset()
      try await control.provision(displayName: "PWA Host")
      let roomCode = try await control.createRoom()

    let rawBaseURL = try #require(ProcessInfo.processInfo.environment["SKYJO_IOS_TEST_SERVER_URL"])
    let baseURL = try #require(URL(string: rawBaseURL))
    let environment = SkyjoNetworkEnvironment(baseURL: baseURL)
    var connections: [RoomConnection] = []

    for index in 1...7 {
      let cookies = realtimeCookieStorage(label: "eight-native-\(index)")
      let session = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookies)
      await cleanup.retain(session: session, cookies: cookies)
      let api = SkyjoAPIClient(environment: environment, session: session)
      #expect(try await api.loginAccess(password: syntheticAccessPassword).authenticated)
      let displayName = "Native Guest \(index)"
      let account = try await api.signup(
        email: "ios-eight-\(index)-\(UUID().uuidString.lowercased())@example.invalid",
        displayName: displayName,
        password: accountPassword,
        confirmPassword: accountPassword
      )
      let connection = try await api.makeRoomConnection(confirmedAccount: account)
      await cleanup.retain(connection: connection)
      connections.append(connection)
      try await connection.connect(.join(code: roomCode, displayName: displayName))
      #expect(await eventually(attempts: 5_000) { await connection.status().synchronized })
    }
    let roomConnections = connections

    #expect(await eventually(attempts: 7_500) {
      for connection in roomConnections {
        guard await connection.snapshot()?.room.players.count == 8 else { return false }
      }
      return true
    })
    try await control.waitPlayer(displayName: "Native Guest 7", connected: true)

    try await control.startGame()
    #expect(await eventually(attempts: 7_500) {
      for connection in roomConnections {
        guard let snapshot = await connection.snapshot(),
              snapshot.room.status == .playing,
              snapshot.room.state?.players.count == 8
        else { return false }
      }
      return true
    })

    for connection in roomConnections {
      try await revealTwoOpeningCards(on: connection)
    }
    try await control.revealOpening(count: 2)
    #expect(await eventually(attempts: 7_500) {
      for connection in roomConnections {
        guard await connection.snapshot()?.room.state?.phase == .chooseSource else { return false }
      }
      return true
    })

    let nativeMarker = "eight-client native marker"
    _ = try await roomConnections[6].send(.sendChatMessage(nativeMarker))
    #expect(await eventually(attempts: 5_000) {
      for connection in roomConnections {
        guard await connection.snapshot()?.room.chatMessages.contains(where: {
          $0.text == nativeMarker
        }) == true else { return false }
      }
      return true
    })

    try await control.sendChat(.fresh)
    #expect(await eventually(attempts: 5_000) {
      for connection in roomConnections {
        guard await connection.snapshot()?.room.chatMessages.contains(where: {
          $0.text == "mixed fresh marker"
        }) == true else { return false }
      }
      return true
    })

    } catch {
      await cleanup.dispose()
      await control.dispose()
      throw error
    }
    await cleanup.dispose()
    await control.dispose()
  }

  @Test(
    "Native create and PWA join preserve presence, seat recovery, heartbeat, and UTF-16 bounds",
    .enabled(
      if: MixedPWAControlClient.networkingTestsEnabled,
      "Requires scripts/ios-build-test.sh --networking-contracts."
    )
  )
  func nativeCreateAndPWAJoin() async throws {
    let control = try MixedPWAControlClient.requiredFromEnvironment()
    var connectionToDispose: RoomConnection?
    do {
    #expect(await control.hasCredentiallessSessionConfiguration())
    try await control.health()
    try await control.reset()
    try await control.provision(displayName: "PWA Guest")

    let rawBaseURL = try #require(ProcessInfo.processInfo.environment["SKYJO_IOS_TEST_SERVER_URL"])
    let baseURL = try #require(URL(string: rawBaseURL))
    let cookies = realtimeCookieStorage(label: "native-host")
    let session = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookies)
    defer {
      session.invalidateAndCancel()
      clearRealtimeCookies(cookies)
    }
    let api = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    #expect(try await api.loginAccess(password: syntheticAccessPassword).authenticated)
    let account = try await api.signup(
      email: "ios-realtime-host-\(UUID().uuidString.lowercased())@example.invalid",
      displayName: "Native Host",
      password: accountPassword,
      confirmPassword: accountPassword
    )
    let connection = try await api.makeRoomConnection(confirmedAccount: account)
    connectionToDispose = connection

    try await connection.connect(.create(displayName: "Native Host"))
    #expect(await eventually(attempts: 5_000) { await connection.status().synchronized })
    let initial = try #require(await connection.snapshot())
    let nativePlayerID = initial.playerID
    try await control.joinRoom(initial.room.code)
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.players.count == 2
    })
    let joined = try #require(await connection.snapshot())
    let pwaPlayerID = try #require(
      joined.room.players.first(where: { $0.name == "PWA Guest" })?.id
    )

    await connection.setVisible(false)
    try await control.waitPlayer(displayName: "Native Host", connected: false)
    await connection.setVisible(true)
    try await control.waitPlayer(displayName: "Native Host", connected: true)

    #expect(try await control.setVisible(false))
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.players.first(where: { $0.id == pwaPlayerID })?.connected == false
    })
    #expect(try await control.setVisible(true))
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.players.first(where: { $0.id == pwaPlayerID })?.connected == true
    })

    try await control.closePage()
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.players.first(where: { $0.id == pwaPlayerID })?.connected == false
    })
    #expect(try await control.reopenPage())
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.players.first(where: { $0.id == pwaPlayerID })?.connected == true
    })

    await connection.setNetworkAvailable(false)
    #expect(await connection.status().phase == .offline)
    await #expect(throws: RoomConnectionError.commandUnavailable) {
      try await connection.send(.sendChatMessage("must not cross the wire while offline"))
    }
    try await control.waitPlayer(displayName: "Native Host", connected: false)
    await connection.setNetworkAvailable(true)
    #expect(await eventually(attempts: 5_000) {
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
    })
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.playerID == nativePlayerID
    })
    try await control.waitPlayer(displayName: "Native Host", connected: true)

    // The server pings every 15 seconds and terminates a socket that has not
    // ponged by the next sweep. Both real clients remain usable beyond 31 s.
    try await Task<Never, Never>.sleep(for: .milliseconds(31_500))
    _ = try await connection.send(.sendChatMessage("mixed native heartbeat marker"))
    #expect(await eventually(attempts: 5_000) {
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
    })
    try await control.waitChat(.heartbeat)

    let maximumAstralChat = String(repeating: "🃏", count: 140)
    #expect(maximumAstralChat.utf16.count == 280)
    _ = try await connection.send(.sendChatMessage(maximumAstralChat))
    #expect(await eventually(attempts: 5_000) {
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
    })
    try await control.waitChat(.maximumAstral)

    } catch {
      await connectionToDispose?.dispose()
      await control.dispose()
      throw error
    }
    await connectionToDispose?.dispose()
    await control.dispose()
  }

  @Test(
    "PWA create and Native join converge through duplicate, stale, transfer, takeover, and reclaim",
    .enabled(
      if: MixedPWAControlClient.networkingTestsEnabled,
      "Requires scripts/ios-build-test.sh --networking-contracts."
    )
  )
  func pwaCreateAndNativeJoin() async throws {
    let control = try MixedPWAControlClient.requiredFromEnvironment()
    var connectionToDispose: RoomConnection?
    do {
    try await control.health()
    try await control.reset()
    try await control.provision(displayName: "PWA Host")
    let roomCode = try await control.createRoom()

    let rawBaseURL = try #require(ProcessInfo.processInfo.environment["SKYJO_IOS_TEST_SERVER_URL"])
    let baseURL = try #require(URL(string: rawBaseURL))
    let cookies = realtimeCookieStorage(label: "native-guest")
    let session = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookies)
    defer {
      session.invalidateAndCancel()
      clearRealtimeCookies(cookies)
    }
    let api = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    #expect(try await api.loginAccess(password: syntheticAccessPassword).authenticated)
    let account = try await api.signup(
      email: "ios-realtime-guest-\(UUID().uuidString.lowercased())@example.invalid",
      displayName: "Native Guest",
      password: accountPassword,
      confirmPassword: accountPassword
    )
    let connection = try await api.makeRoomConnection(confirmedAccount: account)
    connectionToDispose = connection
    try await connection.connect(.join(code: roomCode, displayName: "Native Guest"))
    #expect(await eventually(attempts: 5_000) { await connection.status().synchronized })
    let joined = try #require(await connection.snapshot())
    let nativePlayerID = joined.playerID
    let pwaPlayerID = try #require(
      joined.room.players.first(where: { $0.name == "PWA Host" })?.id
    )
    try await control.waitPlayer(displayName: "Native Guest", connected: true)

    let duplicateBaseline = joined.revision
    try await control.sendChat(.duplicate, duplicate: true)
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      return snapshot.revision == duplicateBaseline + 1
        && snapshot.room.chatMessages.filter({ $0.text == "mixed duplicate marker" }).count == 1
    })

    try await control.holdChat(.stale)
    _ = try await connection.send(.sendChatMessage("mixed native advance marker"))
    #expect(await eventually(attempts: 5_000) {
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
    })
    try await control.releaseHeldCommand()
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      return snapshot.room.chatMessages.contains(where: { $0.text == "mixed native advance marker" })
        && !snapshot.room.chatMessages.contains(where: { $0.text == "mixed stale marker" })
    })
    try await control.sendChat(.fresh)
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.chatMessages.filter({ $0.text == "mixed fresh marker" }).count == 1
    })

    #expect(try await control.setVisible(false))
    #expect(await eventually(attempts: 7_500) {
      guard let snapshot = await connection.snapshot() else { return false }
      let native = snapshot.room.players.first(where: { $0.id == nativePlayerID })
      let pwa = snapshot.room.players.first(where: { $0.id == pwaPlayerID })
      return native?.host == true && pwa?.connected == false
    })
    try await control.waitPlayer(displayName: "Native Guest", connected: true, host: true)
    #expect(try await control.setVisible(true))
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      let native = snapshot.room.players.first(where: { $0.id == nativePlayerID })
      let pwa = snapshot.room.players.first(where: { $0.id == pwaPlayerID })
      return native?.host == true && pwa?.connected == true
    })

    _ = try await connection.send(.startGame)
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
        && snapshot.room.status == .playing && snapshot.room.state != nil
    })
    try await revealTwoOpeningCards(on: connection)
    try await control.revealOpening(count: 2)
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.room.state?.phase == .chooseSource
    })
    try await control.closePage()
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot(),
            let pwa = snapshot.room.players.first(where: { $0.id == pwaPlayerID })
      else { return false }
      return !pwa.connected && pwa.aiTakeoverAt != nil
    })
    let disconnected = try #require(await connection.snapshot())
    let pwaDisconnected = try #require(
      disconnected.room.players.first(where: { $0.id == pwaPlayerID })
    )
    let takeoverAt = try #require(pwaDisconnected.aiTakeoverAt)
    let waitMilliseconds = max(0, takeoverAt - disconnected.room.serverNow + 200)
    try await Task<Never, Never>.sleep(for: .milliseconds(waitMilliseconds))

    _ = try await connection.send(.takeoverPlayerWithAI(pwaPlayerID))
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      let status = await connection.status()
      return status.synchronized && !status.hasPendingCommand
        && snapshot.room.players.first(where: { $0.id == pwaPlayerID })?.controller == .ai
    })
    let takeoverRevision = try #require(await connection.snapshot()).revision
    #expect(await eventually(attempts: 5_000) {
      await connection.snapshot()?.revision ?? 0 > takeoverRevision
    })

    #expect(try await control.reopenPage())
    #expect(await eventually(attempts: 5_000) {
      guard let snapshot = await connection.snapshot() else { return false }
      let native = snapshot.room.players.first(where: { $0.id == nativePlayerID })
      let pwa = snapshot.room.players.first(where: { $0.id == pwaPlayerID })
      return native?.host == true && pwa?.connected == true && pwa?.controller == .human
    })
    try await control.waitPlayer(
      displayName: "PWA Host",
      connected: true,
      controller: .human,
      host: false
    )

    } catch {
      await connectionToDispose?.dispose()
      await control.dispose()
      throw error
    }
    await connectionToDispose?.dispose()
    await control.dispose()
  }
}

private actor MixedNativeClientCleanup {
  private var connections: [RoomConnection] = []
  private var sessions: [(URLSession, HTTPCookieStorage)] = []

  func retain(connection: RoomConnection) {
    connections.append(connection)
  }

  func retain(session: URLSession, cookies: HTTPCookieStorage) {
    sessions.append((session, cookies))
  }

  func dispose() async {
    let retainedConnections = connections
    let retainedSessions = sessions
    connections = []
    sessions = []
    for connection in retainedConnections { await connection.dispose() }
    for (session, cookies) in retainedSessions {
      session.invalidateAndCancel()
      clearRealtimeCookies(cookies)
    }
  }
}

private struct RealtimeFixtureCase {
  let name: String
  let value: Any
}

private enum RealtimeTestError: Error {
  case invalidFixture
  case noSocket
  case transportEnded
}

private func realtimeFixtureCases(file: String) throws -> [RealtimeFixtureCase] {
  let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let url = repositoryRoot
    .appending(path: "contracts/v1/fixtures")
    .appending(path: file)
  let data = try Data(contentsOf: url)
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cases = root["cases"] as? [[String: Any]]
  else { throw RealtimeTestError.invalidFixture }
  return try cases.map { fixture in
    guard let name = fixture["name"] as? String, let value = fixture["value"] else {
      throw RealtimeTestError.invalidFixture
    }
    return RealtimeFixtureCase(name: name, value: value)
  }
}

private func fixtureData(_ value: Any) throws -> Data {
  guard JSONSerialization.isValidJSONObject(value) else { throw RealtimeTestError.invalidFixture }
  return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func personalizedSnapshotObject(revision: Int64, roomCode: String = "ABCDE") throws -> [String: Any] {
  let fixture = try #require(
    try realtimeFixtureCases(file: "protocol-server.valid.json")
      .first(where: { $0.name == "personalized snapshot" })
  )
  guard var frame = fixture.value as? [String: Any],
        var room = frame["room"] as? [String: Any]
  else { throw RealtimeTestError.invalidFixture }
  frame["revision"] = revision
  room["revision"] = revision
  room["code"] = roomCode
  frame["room"] = room
  return frame
}

private func personalizedSnapshotText(revision: Int64, roomCode: String = "ABCDE") throws -> String {
  let data = try fixtureData(personalizedSnapshotObject(revision: revision, roomCode: roomCode))
  return try #require(String(data: data, encoding: .utf8))
}

private func acknowledgementText(
  commandID: UUID,
  revision: Int64,
  result: String? = nil
) throws -> String {
  var object: [String: Any] = [
    "type": "ack",
    "protocolVersion": 2,
    "commandId": commandID.uuidString.lowercased(),
    "revision": revision,
  ]
  if let result { object["result"] = result }
  let data = try fixtureData(object)
  return try #require(String(data: data, encoding: .utf8))
}

private func resyncText(
  commandID: UUID,
  revision: Int64,
  reason: RoomResyncReason,
  roomCode: String
) throws -> String {
  var frame = try personalizedSnapshotObject(revision: revision, roomCode: roomCode)
  frame["type"] = "resync"
  frame["reason"] = reason.rawValue
  frame["commandId"] = commandID.uuidString.lowercased()
  let data = try fixtureData(frame)
  return try #require(String(data: data, encoding: .utf8))
}

private func makeTestConnection(
  factory: FakeSocketFactory,
  sleeper: ControlledSleeper,
  commandIDs: [UUID],
  resetRecoveryStore: any RoomResetRecoveryStore = VolatileRoomResetRecoveryStore()
) throws -> RoomConnection {
  let identifiers = LockedUUIDQueue(commandIDs)
  let environment = RoomConnectionEnvironment(
    makeSocket: { request in try factory.make(request) },
    sleep: { milliseconds in try await sleeper.sleep(milliseconds: milliseconds) },
    random: { 0.5 },
    makeUUID: { identifiers.next() },
    nowMilliseconds: { 1_784_998_800_000 },
    connectivityUpdates: {
      AsyncStream { continuation in
        continuation.yield(true)
        continuation.finish()
      }
    },
    resetRecoveryStore: resetRecoveryStore
  )
  return try RoomConnection(
    webSocketURL: URL(string: "wss://example.test/rooms")!,
    confirmedAccount: try ConfirmedRoomAccount(
      accountID: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
      displayName: "Host"
    ),
    environment: environment
  )
}

private actor FakeRoomWebSocket: RoomWebSocket {
  private var queuedMessages: [RoomWebSocketMessage] = []
  private var receiver: CheckedContinuation<RoomWebSocketMessage, Error>?
  private var ended = false
  private var sent: [String] = []
  private var closeRecords: [(code: Int, reason: String)] = []
  private var startCount = 0
  private let sendGates: [Int: SuspendingSendGate]
  private let closeGate: SuspendingSendGate?

  init(
    sendGates: [Int: SuspendingSendGate] = [:],
    closeGate: SuspendingSendGate? = nil
  ) {
    self.sendGates = sendGates
    self.closeGate = closeGate
  }

  func start() {
    startCount += 1
  }

  func send(text: String) async throws {
    sent.append(text)
    if let gate = sendGates[sent.count] {
      try await gate.wait()
    }
  }

  func receive() async throws -> RoomWebSocketMessage {
    if ended { throw RealtimeTestError.transportEnded }
    if !queuedMessages.isEmpty { return queuedMessages.removeFirst() }
    return try await withCheckedThrowingContinuation { continuation in
      receiver = continuation
    }
  }

  func close(code: Int, reason: String) async {
    closeRecords.append((code, reason))
    if let closeGate { try? await closeGate.wait() }
    ended = true
    receiver?.resume(throwing: RealtimeTestError.transportEnded)
    receiver = nil
  }

  func deliver(_ message: RoomWebSocketMessage) {
    if let receiver {
      self.receiver = nil
      receiver.resume(returning: message)
    } else {
      queuedMessages.append(message)
    }
  }

  func fail() {
    ended = true
    receiver?.resume(throwing: RealtimeTestError.transportEnded)
    receiver = nil
  }

  func sentTexts() -> [String] { sent }
  func closed() -> [(code: Int, reason: String)] { closeRecords }
}

private actor SuspendingSendGate {
  private var entered = false
  private var continuation: CheckedContinuation<Void, Error>?

  func wait() async throws {
    entered = true
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
    }
  }

  func hasEntered() -> Bool { entered }

  func succeed() {
    continuation?.resume()
    continuation = nil
  }

  func fail() {
    continuation?.resume(throwing: RealtimeTestError.transportEnded)
    continuation = nil
  }
}

private actor FailingResetRecoveryStore: RoomResetRecoveryStore {
  private var record: RoomResetRecoveryRecord?
  private let failSave: Bool
  private var remainingClearFailures: Int

  init(failSave: Bool = false, failClearCount: Int = 0) {
    self.failSave = failSave
    remainingClearFailures = failClearCount
  }

  func load(accountID: UUID) throws -> RoomResetRecoveryRecord? {
    guard record?.accountID == accountID else { return nil }
    return record
  }

  func save(_ record: RoomResetRecoveryRecord) throws {
    if failSave { throw RealtimeTestError.transportEnded }
    self.record = record
  }

  func clear(accountID: UUID, commandID: UUID) throws {
    guard record?.accountID == accountID, record?.commandID == commandID else { return }
    if remainingClearFailures > 0 {
      remainingClearFailures -= 1
      throw RealtimeTestError.transportEnded
    }
    record = nil
  }

  func discard(accountID: UUID) {
    guard record?.accountID == accountID else { return }
    record = nil
  }

  func hasRecord() -> Bool { record != nil }
}

private actor SuspendingSaveResetRecoveryStore: RoomResetRecoveryStore {
  private var record: RoomResetRecoveryRecord?
  private var remainingClearFailures: Int
  let saveGate: SuspendingSendGate

  init(clearFailures: Int) {
    remainingClearFailures = clearFailures
    saveGate = SuspendingSendGate()
  }

  func load(accountID: UUID) -> RoomResetRecoveryRecord? {
    guard record?.accountID == accountID else { return nil }
    return record
  }

  func save(_ record: RoomResetRecoveryRecord) async throws {
    self.record = record
    try await saveGate.wait()
  }

  func clear(accountID: UUID, commandID: UUID) throws {
    guard record?.accountID == accountID, record?.commandID == commandID else { return }
    if remainingClearFailures > 0 {
      remainingClearFailures -= 1
      throw RealtimeTestError.transportEnded
    }
    record = nil
  }

  func discard(accountID: UUID) {
    guard record?.accountID == accountID else { return }
    record = nil
  }

  func hasRecord() -> Bool { record != nil }
}

private actor SuspendingClearResetRecoveryStore: RoomResetRecoveryStore {
  private var record: RoomResetRecoveryRecord?
  let clearGate = SuspendingSendGate()

  func seed(_ record: RoomResetRecoveryRecord) { self.record = record }

  func load(accountID: UUID) -> RoomResetRecoveryRecord? {
    guard record?.accountID == accountID else { return nil }
    return record
  }

  func save(_ record: RoomResetRecoveryRecord) { self.record = record }

  func clear(accountID: UUID, commandID: UUID) async throws {
    guard record?.accountID == accountID, record?.commandID == commandID else { return }
    try await clearGate.wait()
    guard record?.accountID == accountID, record?.commandID == commandID else { return }
    record = nil
  }

  func discard(accountID: UUID) {
    guard record?.accountID == accountID else { return }
    record = nil
  }
}

private actor RoomConnectionNoticeRecorder {
  private var notices: [RoomConnectionNotice] = []

  func record(_ event: RoomConnectionEvent) {
    guard case .notice(let notice) = event else { return }
    notices.append(notice)
  }

  func contains(_ notice: RoomConnectionNotice) -> Bool {
    notices.contains(notice)
  }
}

private final class FakeSocketFactory: @unchecked Sendable {
  private let lock = NSLock()
  private var sockets: [FakeRoomWebSocket]
  private var requests: [URLRequest] = []

  init(_ sockets: [FakeRoomWebSocket]) {
    self.sockets = sockets
  }

  func make(_ request: URLRequest) throws -> any RoomWebSocket {
    lock.lock()
    defer { lock.unlock() }
    guard !sockets.isEmpty else { throw RealtimeTestError.noSocket }
    requests.append(request)
    return sockets.removeFirst()
  }
}

private actor ControlledSleeper {
  private struct Waiter {
    let id: UUID
    let milliseconds: Int
    let continuation: CheckedContinuation<Void, Error>
  }

  private var waiters: [Waiter] = []

  func sleep(milliseconds: Int) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        waiters.append(Waiter(id: id, milliseconds: milliseconds, continuation: continuation))
      }
    } onCancel: {
      Task { await self.cancel(id: id) }
    }
  }

  func hasPending(milliseconds: Int) -> Bool {
    waiters.contains(where: { $0.milliseconds == milliseconds })
  }

  func release(milliseconds: Int) -> Bool {
    guard let index = waiters.firstIndex(where: { $0.milliseconds == milliseconds }) else {
      return false
    }
    let waiter = waiters.remove(at: index)
    waiter.continuation.resume()
    return true
  }

  private func cancel(id: UUID) {
    guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
    let waiter = waiters.remove(at: index)
    waiter.continuation.resume(throwing: CancellationError())
  }
}

private final class LockedUUIDQueue: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UUID]

  init(_ values: [UUID]) {
    self.values = values
  }

  func next() -> UUID {
    lock.lock()
    defer { lock.unlock() }
    return values.isEmpty ? UUID() : values.removeFirst()
  }
}

private func eventually(
  attempts: Int = 500,
  _ predicate: @escaping @Sendable () async -> Bool
) async -> Bool {
  for _ in 0..<attempts {
    if await predicate() { return true }
    try? await Task<Never, Never>.sleep(for: .milliseconds(2))
  }
  return false
}

private func revealTwoOpeningCards(on connection: RoomConnection) async throws {
  for expectedCount in 1...2 {
    guard let snapshot = await connection.snapshot(),
          let game = snapshot.room.state,
          let player = game.players.first(where: { $0.id == snapshot.playerID }),
          let index = player.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    else { throw RealtimeTestError.invalidFixture }
    _ = try await connection.send(.revealOpeningCard(index))
    guard await eventually(attempts: 5_000, {
      guard let next = await connection.snapshot(), let nextGame = next.room.state else {
        return false
      }
      let status = await connection.status()
      return status.synchronized
        && !status.hasPendingCommand
        && nextGame.openingRevealCounts[snapshot.playerID, default: 0] >= expectedCount
    }) else { throw RealtimeTestError.invalidFixture }
  }
}

private func realtimeCookieStorage(label: String) -> HTTPCookieStorage {
  HTTPCookieStorage.sharedCookieStorage(
    forGroupContainerIdentifier: "com.groundworkrevops.skyjo.realtime-tests.\(label).\(UUID().uuidString)"
  )
}

private func clearRealtimeCookies(_ storage: HTTPCookieStorage) {
  for cookie in storage.cookies ?? [] { storage.deleteCookie(cookie) }
}
