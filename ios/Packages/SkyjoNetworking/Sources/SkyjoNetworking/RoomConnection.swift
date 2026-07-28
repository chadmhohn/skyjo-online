import Foundation
import Network

public enum RoomWebSocketMessage: Equatable, Sendable {
  case text(String)
  case data(Data)
}

public protocol RoomWebSocket: Sendable {
  func start() async
  func send(text: String) async throws
  func receive() async throws -> RoomWebSocketMessage
  func close(code: Int, reason: String) async
}

public enum RoomConnectionPhase: String, Equatable, Sendable {
  case idle
  case connecting
  case connected
  case reconnecting
  case offline
  case error
  case upgradeRequired = "upgrade-required"
}

public struct RoomConnectionStatus: Equatable, Sendable {
  public let phase: RoomConnectionPhase
  public let retryInMilliseconds: Int?
  public let synchronized: Bool
  public let hasPendingCommand: Bool
  public let revision: Int64?

  public init(
    phase: RoomConnectionPhase,
    retryInMilliseconds: Int?,
    synchronized: Bool,
    hasPendingCommand: Bool,
    revision: Int64?
  ) {
    self.phase = phase
    self.retryInMilliseconds = retryInMilliseconds
    self.synchronized = synchronized
    self.hasPendingCommand = hasPendingCommand
    self.revision = revision
  }
}

public enum RoomConnectionNotice: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case invalidServerResponse
  case synchronizationTimedOut
  case transportInterrupted
  case commandRejected(code: String, message: String)
  case commandResynchronized(reason: RoomResyncReason)
  case resetRecoveryPersistenceFailed
  case roomResetByHost
  case seatRemoved
  case upgradeRequired

  public var description: String { debugDescription }
  public var debugDescription: String {
    switch self {
    case .invalidServerResponse: return "RoomConnectionNotice.invalidServerResponse"
    case .synchronizationTimedOut: return "RoomConnectionNotice.synchronizationTimedOut"
    case .transportInterrupted: return "RoomConnectionNotice.transportInterrupted"
    case .commandRejected(let code, _):
      return "RoomConnectionNotice.commandRejected(code: \(code), message: <redacted>)"
    case .commandResynchronized(let reason):
      return "RoomConnectionNotice.commandResynchronized(reason: \(reason.rawValue))"
    case .resetRecoveryPersistenceFailed:
      return "RoomConnectionNotice.resetRecoveryPersistenceFailed"
    case .roomResetByHost: return "RoomConnectionNotice.roomResetByHost"
    case .seatRemoved: return "RoomConnectionNotice.seatRemoved"
    case .upgradeRequired: return "RoomConnectionNotice.upgradeRequired"
    }
  }
}

public struct AuthoritativeRoomSnapshot: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let playerID: String
  public let revision: Int64
  public let room: PublicRoomSnapshot

  public var description: String { debugDescription }
  public var debugDescription: String {
    "AuthoritativeRoomSnapshot(playerID: <redacted>, revision: \(revision), room: <redacted>)"
  }
}

public enum RoomConnectionEvent: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case status(RoomConnectionStatus)
  case snapshot(AuthoritativeRoomSnapshot)
  case notice(RoomConnectionNotice)

  public var description: String { debugDescription }
  public var debugDescription: String {
    switch self {
    case .status(let status): return "RoomConnectionEvent.status(\(status.phase.rawValue))"
    case .snapshot(let snapshot): return "RoomConnectionEvent.snapshot(revision: \(snapshot.revision), room: <redacted>)"
    case .notice(let notice): return "RoomConnectionEvent.notice(\(notice.debugDescription))"
    }
  }
}

public enum RoomConnectionError: Error, Equatable, Sendable {
  case invalidWebSocketURL
  case commandUnavailable
  case commandAlreadyPending
  case resetRecoveryPersistenceFailed
}

public struct RoomConnectionEnvironment: Sendable {
  public var makeSocket: @Sendable (URLRequest) throws -> any RoomWebSocket
  public var sleep: @Sendable (_ milliseconds: Int) async throws -> Void
  public var random: @Sendable () -> Double
  public var makeUUID: @Sendable () -> UUID
  public var nowMilliseconds: @Sendable () -> Int64
  public var connectivityUpdates: @Sendable () -> AsyncStream<Bool>
  public var resetRecoveryStore: any RoomResetRecoveryStore

  public init(
    makeSocket: @escaping @Sendable (URLRequest) throws -> any RoomWebSocket,
    sleep: @escaping @Sendable (_ milliseconds: Int) async throws -> Void = { milliseconds in
      guard milliseconds > 0 else { return }
      try await Task<Never, Never>.sleep(for: .milliseconds(milliseconds))
    },
    random: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
    makeUUID: @escaping @Sendable () -> UUID = UUID.init,
    nowMilliseconds: @escaping @Sendable () -> Int64 = {
      Int64(Date().timeIntervalSince1970 * 1_000)
    },
    connectivityUpdates: @escaping @Sendable () -> AsyncStream<Bool> = {
      AsyncStream { continuation in
        continuation.yield(true)
        continuation.finish()
      }
    },
    resetRecoveryStore: any RoomResetRecoveryStore = VolatileRoomResetRecoveryStore()
  ) {
    self.makeSocket = makeSocket
    self.sleep = sleep
    self.random = random
    self.makeUUID = makeUUID
    self.nowMilliseconds = nowMilliseconds
    self.connectivityUpdates = connectivityUpdates
    self.resetRecoveryStore = resetRecoveryStore
  }

  public static func live(
    session: URLSession,
    resetRecoveryStore: any RoomResetRecoveryStore = FileRoomResetRecoveryStore.applicationSupportStore()
  ) -> RoomConnectionEnvironment {
    let reachability = RoomReachabilitySource()
    return RoomConnectionEnvironment(
      makeSocket: { request in URLSessionRoomWebSocket(session: session, request: request) },
      connectivityUpdates: { reachability.updates() },
      resetRecoveryStore: resetRecoveryStore
    )
  }
}

public actor RoomConnection {
  private struct PendingCommand: Sendable {
    let commandID: UUID
    let expectedRevision: Int64
    let action: RoomCommandAction
    let wireText: String
    var acknowledgedRevision: Int64?
    var sentGeneration: UInt64?
    let admissionBeforeReset: RoomAdmission?
  }

  private let webSocketURL: URL
  private let environment: RoomConnectionEnvironment
  private let confirmedAccount: ConfirmedRoomAccount

  private var admission: RoomAdmission?
  private var admissionWasAttempted = false
  private var attempt = 0
  private var commandPreparationInProgress = false
  private var continuations: [UUID: AsyncStream<RoomConnectionEvent>.Continuation] = [:]
  private var connectivityTask: Task<Void, Never>?
  private var currentSocket: (any RoomWebSocket)?
  private var desiredVisible = true
  private var disposed = false
  private var generation: UInt64 = 0
  private var lastAcceptedRevision: Int64?
  private var lastPresenceGeneration: UInt64?
  private var lastPresenceVisible: Bool?
  private var lastResumeAt = Int64.min
  private var latestAuthoritativeSnapshot: AuthoritativeRoomSnapshot?
  private var lifecycleEpoch: UInt64 = 0
  private var online = true
  private var pendingCommand: PendingCommand?
  private var preparingResetCommandID: UUID?
  private var pendingRecoveryClearCommandID: UUID?
  private var phase: RoomConnectionPhase = .idle
  private var presenceSendSerial: UInt64 = 0
  private var receiveTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var retryInMilliseconds: Int?
  private var synchronizedGeneration: UInt64?
  private var syncTimeoutTask: Task<Void, Never>?

  public init(
    webSocketURL: URL,
    confirmedAccount: ConfirmedRoomAccount,
    environment: RoomConnectionEnvironment
  ) throws {
    guard Self.isValidWebSocketURL(webSocketURL) else {
      throw RoomConnectionError.invalidWebSocketURL
    }
    self.webSocketURL = webSocketURL
    self.confirmedAccount = confirmedAccount
    self.environment = environment
  }

  deinit {
    receiveTask?.cancel()
    reconnectTask?.cancel()
    syncTimeoutTask?.cancel()
    connectivityTask?.cancel()
  }

  public func events() -> AsyncStream<RoomConnectionEvent> {
    let identifier = UUID()
    return AsyncStream(bufferingPolicy: .bufferingNewest(4)) { continuation in
      continuations[identifier] = continuation
      continuation.yield(.status(status()))
      if let latestAuthoritativeSnapshot {
        continuation.yield(.snapshot(latestAuthoritativeSnapshot))
      }
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeContinuation(identifier) }
      }
    }
  }

  public func status() -> RoomConnectionStatus {
    RoomConnectionStatus(
      phase: phase,
      retryInMilliseconds: retryInMilliseconds,
      synchronized: synchronizedGeneration == generation,
      hasPendingCommand: pendingCommand != nil
        || commandPreparationInProgress
        || pendingRecoveryClearCommandID != nil,
      revision: lastAcceptedRevision
    )
  }

  public func snapshot() -> AuthoritativeRoomSnapshot? {
    latestAuthoritativeSnapshot
  }

  public func recoveryAdmission() -> RoomAdmission? {
    guard isRecoverable(admission) else { return nil }
    return admission
  }

  @discardableResult
  public func recoverPersistedReset() async throws -> Bool {
    let operationEpoch = lifecycleEpoch
    if let pendingRecoveryClearCommandID {
      let cleared = await clearPersistedRecovery(commandID: pendingRecoveryClearCommandID)
      guard lifecycleEpoch == operationEpoch, !disposed else { return false }
      guard cleared else { throw RoomConnectionError.resetRecoveryPersistenceFailed }
    }
    let record: RoomResetRecoveryRecord?
    do {
      record = try await environment.resetRecoveryStore.load(accountID: confirmedAccount.accountID)
    } catch {
      publish(.notice(.resetRecoveryPersistenceFailed))
      throw RoomConnectionError.resetRecoveryPersistenceFailed
    }
    guard lifecycleEpoch == operationEpoch, !disposed else { return false }
    guard let record else { return false }
    let savedAdmission = RoomAdmission.join(
      code: record.roomCode,
      displayName: confirmedAccount.displayName,
      playerID: record.playerID,
      resetRecovery: RoomResetRecovery(
        commandID: record.commandID,
        expectedRevision: record.expectedRevision
      )
    )
    if admission == savedAdmission, (currentSocket != nil || reconnectTask != nil) {
      return true
    }
    lifecycleEpoch &+= 1
    startConnectivityObservationIfNeeded()
    if admission != savedAdmission {
      retireCurrentSocket(code: 1_000, reason: "Room recovery replaced")
      cancelReconnect()
      clearPendingCommand()
      quarantineAuthoritativeState()
    }
    admission = savedAdmission
    admissionWasAttempted = false
    attempt = 0
    if online {
      scheduleReconnect()
    } else {
      transition(to: .offline)
    }
    return true
  }

  public func connect(_ nextAdmission: RoomAdmission) async throws {
    _ = try RealtimeFrameCodec.encodeAdmission(nextAdmission)
    guard admissionDisplayName(nextAdmission) == confirmedAccount.displayName,
          admissionResetRecovery(nextAdmission) == nil
    else {
      throw RoomConnectionContractError.invalidAdmission
    }
    guard !disposed else { return }
    lifecycleEpoch &+= 1
    let operationEpoch = lifecycleEpoch
    let abandonedRecoveryCommandID = activeResetRecoveryCommandID()
    startConnectivityObservationIfNeeded()
    retireCurrentSocket(code: 1_000, reason: "Room session replaced")
    cancelReconnect()
    clearPendingCommand()
    admission = nextAdmission
    admissionWasAttempted = false
    attempt = 0
    lastAcceptedRevision = nil
    latestAuthoritativeSnapshot = nil
    if let abandonedRecoveryCommandID {
      let cleared = await clearPersistedRecovery(commandID: abandonedRecoveryCommandID)
      if !cleared {
        guard lifecycleEpoch == operationEpoch else { return }
        transition(to: .error)
        throw RoomConnectionError.resetRecoveryPersistenceFailed
      }
    }
    guard lifecycleEpoch == operationEpoch, !disposed, admission == nextAdmission else { return }
    if online {
      await openSocket(recovering: false)
    } else {
      transition(to: .offline)
    }
  }

  public func recover(_ savedAdmission: RoomAdmission) async throws {
    _ = try RealtimeFrameCodec.encodeAdmission(savedAdmission)
    guard isRecoverable(savedAdmission),
          admissionDisplayName(savedAdmission) == confirmedAccount.displayName
    else {
      throw RoomConnectionContractError.invalidAdmission
    }
    guard !disposed else { return }
    if admission == savedAdmission, (currentSocket != nil || reconnectTask != nil) {
      return
    }
    lifecycleEpoch &+= 1
    let operationEpoch = lifecycleEpoch
    let activeRecoveryCommandID = activeResetRecoveryCommandID()
    let savedRecoveryCommandID = admissionResetRecovery(savedAdmission)?.commandID
    let abandonedRecoveryCommandID = activeRecoveryCommandID != savedRecoveryCommandID
      ? activeRecoveryCommandID
      : nil
    startConnectivityObservationIfNeeded()
    if admission != savedAdmission {
      retireCurrentSocket(code: 1_000, reason: "Room recovery replaced")
      cancelReconnect()
      clearPendingCommand()
      lastAcceptedRevision = nil
      latestAuthoritativeSnapshot = nil
    }
    admission = savedAdmission
    admissionWasAttempted = false
    attempt = 0
    if let abandonedRecoveryCommandID {
      let cleared = await clearPersistedRecovery(commandID: abandonedRecoveryCommandID)
      if !cleared {
        guard lifecycleEpoch == operationEpoch else { return }
        transition(to: .error)
        throw RoomConnectionError.resetRecoveryPersistenceFailed
      }
    }
    guard lifecycleEpoch == operationEpoch, !disposed, admission == savedAdmission else { return }
    if online {
      scheduleReconnect()
    } else {
      transition(to: .offline)
    }
  }

  @discardableResult
  public func send(_ action: RoomCommandAction) async throws -> UUID {
    guard !disposed,
          phase == .connected,
          synchronizedGeneration == generation,
          currentSocket != nil,
          lastAcceptedRevision != nil
    else { throw RoomConnectionError.commandUnavailable }
    guard pendingCommand == nil, !commandPreparationInProgress else {
      throw RoomConnectionError.commandAlreadyPending
    }

    let operationEpoch = lifecycleEpoch
    commandPreparationInProgress = true
    publishStatus()
    defer {
      commandPreparationInProgress = false
      preparingResetCommandID = nil
      publishStatus()
    }

    if let recoveryCommandID = pendingRecoveryClearCommandID {
      let cleared = await clearPersistedRecovery(commandID: recoveryCommandID)
      guard cleared else {
        throw RoomConnectionError.resetRecoveryPersistenceFailed
      }
    }
    try Task.checkCancellation()
    guard lifecycleEpoch == operationEpoch,
          !disposed,
          phase == .connected,
          synchronizedGeneration == generation,
          let socket = currentSocket,
          let revision = lastAcceptedRevision,
          pendingCommand == nil
    else { throw RoomConnectionError.commandUnavailable }

    let commandID = environment.makeUUID()
    let socketGeneration = generation
    let originalAdmission = admission
    let wireText = try RealtimeFrameCodec.encodeCommand(
      commandID: commandID,
      expectedRevision: revision,
      action: action
    )
    var previousAdmission: RoomAdmission?
    if action == .resetRoom {
      guard case .join(let code, let displayName, let playerID?, _) = originalAdmission else {
        throw RoomConnectionError.commandUnavailable
      }
      try Task.checkCancellation()
      let recoveryAdmission = RoomAdmission.join(
        code: code,
        displayName: displayName,
        playerID: playerID,
        resetRecovery: RoomResetRecovery(commandID: commandID, expectedRevision: revision)
      )
      let recoveryRecord: RoomResetRecoveryRecord
      preparingResetCommandID = commandID
      do {
        recoveryRecord = try RoomResetRecoveryRecord(
          accountID: confirmedAccount.accountID,
          roomCode: code,
          playerID: playerID,
          commandID: commandID,
          expectedRevision: revision
        )
        try await environment.resetRecoveryStore.save(recoveryRecord)
      } catch {
        let cleared = await clearPersistedRecovery(commandID: commandID)
        if cleared { publish(.notice(.resetRecoveryPersistenceFailed)) }
        throw RoomConnectionError.resetRecoveryPersistenceFailed
      }
      let preparationWasCancelled = Task.isCancelled
      guard !preparationWasCancelled,
            lifecycleEpoch == operationEpoch,
            !disposed,
            generation == socketGeneration,
            currentSocket != nil,
            synchronizedGeneration == socketGeneration,
            phase == .connected,
            lastAcceptedRevision == revision,
            admission == originalAdmission,
            pendingCommand == nil
      else {
        let cleared = await clearPersistedRecovery(commandID: commandID)
        if preparationWasCancelled {
          throw CancellationError()
        }
        if !cleared {
          throw RoomConnectionError.resetRecoveryPersistenceFailed
        }
        throw RoomConnectionError.commandUnavailable
      }
      previousAdmission = originalAdmission
      admission = recoveryAdmission
    }
    pendingCommand = PendingCommand(
      commandID: commandID,
      expectedRevision: revision,
      action: action,
      wireText: wireText,
      acknowledgedRevision: nil,
      sentGeneration: socketGeneration,
      admissionBeforeReset: previousAdmission
    )
    publishStatus()

    do {
      try await socket.send(text: wireText)
    } catch {
      if isCurrent(socketGeneration) {
        await handleTransportEnd(socketGeneration: socketGeneration, shouldNotify: true)
      }
    }
    return commandID
  }

  public func setVisible(_ visible: Bool) async {
    desiredVisible = visible
    guard !disposed, synchronizedGeneration == generation else { return }
    await sendPresenceIfNeeded(force: true)
  }

  public func resume() async {
    desiredVisible = true
    guard !disposed else { return }
    if !online {
      await setNetworkAvailable(false)
      return
    }
    if phase == .connected, synchronizedGeneration == generation {
      let now = environment.nowMilliseconds()
      if lastPresenceGeneration == generation,
         lastPresenceVisible == true,
         now - lastResumeAt < 250 {
        return
      }
      await sendPresenceIfNeeded(force: true)
      return
    }
    guard isRecoverable(admission) else { return }
    scheduleReconnect()
  }

  public func setNetworkAvailable(_ available: Bool) async {
    guard !disposed else { return }
    let wasOnline = online
    guard available != wasOnline else { return }
    lifecycleEpoch &+= 1
    online = available
    if !available {
      cancelReconnect()
      retireCurrentSocket(code: 4_000, reason: "Network unavailable")
      transition(to: .offline)
      return
    }
    attempt = 0
    if isRecoverable(admission) {
      scheduleReconnect()
    } else if admission != nil, !admissionWasAttempted {
      await openSocket(recovering: false)
    } else if admission == nil {
      transition(to: .idle)
    }
  }

  public func disconnect() async {
    lifecycleEpoch &+= 1
    let abandonedRecoveryCommandID = activeResetRecoveryCommandID()
    cancelReconnect()
    clearPendingCommand()
    admission = nil
    admissionWasAttempted = false
    lastAcceptedRevision = nil
    latestAuthoritativeSnapshot = nil
    attempt = 0
    retireCurrentSocket(code: 1_000, reason: "Room session ended")
    if !disposed { transition(to: .idle) }
    if let abandonedRecoveryCommandID {
      await clearPersistedRecovery(commandID: abandonedRecoveryCommandID)
    }
  }

  public func dispose() async {
    guard !disposed else { return }
    lifecycleEpoch &+= 1
    disposed = true
    connectivityTask?.cancel()
    connectivityTask = nil
    cancelReconnect()
    clearPendingCommand()
    admission = nil
    retireCurrentSocket(code: 1_000, reason: "Room connection disposed")
    for continuation in continuations.values { continuation.finish() }
    continuations.removeAll()
  }

  public static func reconnectDelayMilliseconds(attempt: Int, random: Double) -> Int {
    let normalizedAttempt = max(0, attempt)
    let index = min(normalizedAttempt, RoomProtocolV2.reconnectBaseDelayMilliseconds.count - 1)
    let normalizedRandom = random.isFinite ? min(1, max(0, random)) : 0.5
    let multiplier = 0.8 + 0.4 * normalizedRandom
    return Int((Double(RoomProtocolV2.reconnectBaseDelayMilliseconds[index]) * multiplier).rounded())
  }

  private func startConnectivityObservationIfNeeded() {
    guard connectivityTask == nil else { return }
    let updates = environment.connectivityUpdates()
    connectivityTask = Task { [weak self] in
      for await available in updates {
        guard !Task.isCancelled else { return }
        await self?.setNetworkAvailable(available)
      }
    }
  }

  private func openSocket(recovering: Bool) async {
    guard !disposed, online, let admission else { return }
    cancelReconnect()
    let wireAdmission: String
    do {
      wireAdmission = try RealtimeFrameCodec.encodeAdmission(admission)
    } catch {
      transition(to: .error)
      return
    }

    generation &+= 1
    let socketGeneration = generation
    synchronizedGeneration = nil
    lastPresenceGeneration = nil
    lastPresenceVisible = nil
    admissionWasAttempted = true
    let request = URLRequest(url: webSocketURL)
    let socket: any RoomWebSocket
    do {
      socket = try environment.makeSocket(request)
    } catch {
      if recovering && isRecoverable(admission) {
        scheduleReconnect()
      } else {
        transition(to: .error)
      }
      return
    }
    currentSocket = socket
    transition(to: recovering ? .reconnecting : .connecting)
    await socket.start()
    guard isCurrent(socketGeneration) else { return }

    startReceiveLoop(socket: socket, socketGeneration: socketGeneration)
    armSynchronizationTimeout(socketGeneration: socketGeneration)
    do {
      try await socket.send(text: wireAdmission)
    } catch {
      await handleTransportEnd(socketGeneration: socketGeneration, shouldNotify: true)
    }
  }

  private func startReceiveLoop(socket: any RoomWebSocket, socketGeneration: UInt64) {
    receiveTask?.cancel()
    receiveTask = Task { [weak self] in
      do {
        while !Task.isCancelled {
          let message = try await socket.receive()
          guard !Task.isCancelled else { return }
          await self?.receive(message, socketGeneration: socketGeneration)
        }
      } catch {
        guard !Task.isCancelled else { return }
        await self?.handleTransportEnd(socketGeneration: socketGeneration, shouldNotify: true)
      }
    }
  }

  private func receive(_ message: RoomWebSocketMessage, socketGeneration: UInt64) async {
    guard isCurrent(socketGeneration) else { return }
    let data: Data
    switch message {
    case .text(let text):
      data = Data(text.utf8)
    case .data:
      await failClosedInvalidFrame(socketGeneration: socketGeneration)
      return
    }
    let frame: RoomServerFrame
    do {
      frame = try RealtimeFrameCodec.decodeServerFrame(data)
    } catch {
      await failClosedInvalidFrame(socketGeneration: socketGeneration)
      return
    }
    do {
      try await handle(frame, socketGeneration: socketGeneration)
    } catch {
      await failClosedInvalidFrame(socketGeneration: socketGeneration)
    }
  }

  private func handle(_ frame: RoomServerFrame, socketGeneration: UInt64) async throws {
    guard isCurrent(socketGeneration) else { return }
    switch frame {
    case .snapshot(let snapshotFrame):
      try await acceptSnapshot(
        playerID: snapshotFrame.playerID,
        revision: snapshotFrame.revision,
        room: snapshotFrame.room,
        resync: nil,
        socketGeneration: socketGeneration
      )
    case .resync(let resyncFrame):
      try await acceptSnapshot(
        playerID: resyncFrame.playerID,
        revision: resyncFrame.revision,
        room: resyncFrame.room,
        resync: resyncFrame,
        socketGeneration: socketGeneration
      )
    case .acknowledgement(let acknowledgement):
      try await acceptAcknowledgement(acknowledgement, socketGeneration: socketGeneration)
    case .error(let errorFrame):
      await acceptError(errorFrame, socketGeneration: socketGeneration)
    case .upgradeRequired:
      lifecycleEpoch &+= 1
      let recoveryCommandID = activeResetRecoveryCommandID()
      clearPendingCommand()
      admission = nil
      quarantineAuthoritativeState()
      cancelReconnect()
      retireCurrentSocket(code: 1_002, reason: "Protocol upgrade required")
      transition(to: .upgradeRequired)
      publish(.notice(.upgradeRequired))
      if let recoveryCommandID {
        await clearPersistedRecovery(commandID: recoveryCommandID)
      }
    }
  }

  private func acceptSnapshot(
    playerID incomingPlayerID: String?,
    revision: Int64,
    room: PublicRoomSnapshot,
    resync: RoomResyncFrame?,
    socketGeneration: UInt64
  ) async throws {
    let establishedPlayerID = admissionPlayerID(admission)
    let wasSynchronized = synchronizedGeneration == socketGeneration
    let sharedFrame = incomingPlayerID == nil
    guard !sharedFrame || wasSynchronized,
          let viewerPlayerID = incomingPlayerID ?? establishedPlayerID,
          room.players.contains(where: { $0.id == viewerPlayerID }),
          establishedPlayerID == nil || establishedPlayerID == viewerPlayerID
    else { throw RoomConnectionContractError.invalidFrame }

    let resetTransition = isValidResetTransition(
      resync: resync,
      viewerPlayerID: viewerPlayerID,
      establishedPlayerID: establishedPlayerID
    )
    let acceptedResetCommandID = resetTransition ? resync?.commandID : nil
    if case .join(let expectedCode, _, _, _) = admission,
       !resetTransition,
       room.code != expectedCode {
      throw RoomConnectionContractError.invalidFrame
    }
    if resetTransition,
       case .join(let previousCode, _, _, _) = admission,
       room.code == previousCode {
      throw RoomConnectionContractError.invalidFrame
    }
    if sharedFrame,
       let state = room.state,
       state.hasDrawnCard,
       state.players.indices.contains(state.currentPlayerIndex),
       state.players[state.currentPlayerIndex].id == viewerPlayerID {
      throw RoomConnectionContractError.invalidFrame
    }
    if resync == nil, let lastAcceptedRevision, revision < lastAcceptedRevision {
      throw RoomConnectionContractError.invalidFrame
    }

    if resetTransition, let pendingCommand, pendingCommand.action == .resetRoom {
      self.pendingCommand?.acknowledgedRevision = pendingCommand.expectedRevision + 1
      self.pendingCommand?.sentGeneration = socketGeneration
    }

    let displayName = admissionDisplayName(admission) ?? "Player"
    admission = .join(
      code: room.code,
      displayName: displayName,
      playerID: viewerPlayerID,
      resetRecovery: nil
    )
    synchronizedGeneration = socketGeneration
    cancelSynchronizationTimeout()
    attempt = 0
    lastAcceptedRevision = revision
    let authoritative = AuthoritativeRoomSnapshot(
      playerID: viewerPlayerID,
      revision: revision,
      room: room
    )
    latestAuthoritativeSnapshot = authoritative

    if let acknowledgedRevision = pendingCommand?.acknowledgedRevision,
       revision < acknowledgedRevision {
      pendingCommand?.acknowledgedRevision = nil
      pendingCommand?.sentGeneration = nil
    }

    transition(to: .connected)
    publish(.snapshot(authoritative))

    var recoveryCommandIDToClear = acceptedResetCommandID
    if let resync,
       let pendingCommand,
       resync.commandID == pendingCommand.commandID,
       !resetTransition {
      recoveryCommandIDToClear = pendingCommand.action == .resetRoom
        ? pendingCommand.commandID
        : nil
      restoreAdmissionAfterRejectedReset(pendingCommand)
      clearPendingCommand()
      publish(.notice(.commandResynchronized(reason: resync.reason)))
    } else {
      completePendingIfConverged()
    }

    await sendPresenceIfNeeded(force: false)
    await replayPendingIfNeeded(socketGeneration: socketGeneration)
    if let recoveryCommandIDToClear {
      await clearPersistedRecovery(commandID: recoveryCommandIDToClear)
    } else {
      await retryPersistedRecoveryClearIfNeeded()
    }
  }

  private func acceptAcknowledgement(
    _ frame: RoomAcknowledgementFrame,
    socketGeneration: UInt64
  ) async throws {
    guard let pendingCommand, frame.commandID == pendingCommand.commandID else { return }
    guard frame.revision == pendingCommand.expectedRevision + 1 else {
      throw RoomConnectionContractError.invalidFrame
    }
    if frame.result == .roomLeft {
      guard pendingCommand.action == .leaveRoom else {
        throw RoomConnectionContractError.invalidFrame
      }
      lifecycleEpoch &+= 1
      clearPendingCommand()
      admission = nil
      lastAcceptedRevision = nil
      latestAuthoritativeSnapshot = nil
      cancelReconnect()
      retireCurrentSocket(code: 1_000, reason: "Room left")
      transition(to: .idle)
      return
    }
    self.pendingCommand?.acknowledgedRevision = frame.revision
    self.pendingCommand?.sentGeneration = socketGeneration
    completePendingIfConverged()
  }

  private func acceptError(_ frame: RoomErrorFrame, socketGeneration: UInt64) async {
    if frame.code == "room-reset" {
      lifecycleEpoch &+= 1
      let recoveryCommandID = activeResetRecoveryCommandID()
      clearPendingCommand()
      admission = nil
      quarantineAuthoritativeState()
      cancelReconnect()
      retireCurrentSocket(code: 1_000, reason: "Room reset by host")
      transition(to: .idle)
      publish(.notice(.roomResetByHost))
      if let recoveryCommandID {
        await clearPersistedRecovery(commandID: recoveryCommandID)
      }
      return
    }

    if frame.code == "seat-removed" || frame.code == "stale-seat" {
      lifecycleEpoch &+= 1
      let recoveryCommandID = activeResetRecoveryCommandID()
      clearPendingCommand()
      admission = nil
      quarantineAuthoritativeState()
      cancelReconnect()
      retireCurrentSocket(code: 1_000, reason: "Room seat removed")
      transition(to: .idle)
      publish(.notice(.seatRemoved))
      if let recoveryCommandID {
        await clearPersistedRecovery(commandID: recoveryCommandID)
      }
      return
    }

    var recoveryCommandIDToClear: UUID?
    if let pendingCommand, frame.commandID == pendingCommand.commandID {
      recoveryCommandIDToClear = pendingCommand.action == .resetRoom
        ? pendingCommand.commandID
        : nil
      restoreAdmissionAfterRejectedReset(pendingCommand)
      clearPendingCommand()
    }
    publish(.notice(.commandRejected(code: frame.code, message: frame.message)))

    if synchronizedGeneration != socketGeneration {
      lifecycleEpoch &+= 1
      if ["stale-room", "seat-forbidden", "room-not-found", "game-started"].contains(frame.code),
         let commandID = activeResetRecoveryCommandID() {
        recoveryCommandIDToClear = commandID
      }
      clearPendingCommand()
      admission = nil
      quarantineAuthoritativeState()
      retireCurrentSocket(code: 1_000, reason: "Room admission rejected")
      transition(to: .error)
    }
    if let recoveryCommandIDToClear {
      await clearPersistedRecovery(commandID: recoveryCommandIDToClear)
    }
  }

  private func isValidResetTransition(
    resync: RoomResyncFrame?,
    viewerPlayerID: String,
    establishedPlayerID: String?
  ) -> Bool {
    guard let resync, resync.reason == .roomReset, let commandID = resync.commandID else {
      return false
    }
    if let pendingCommand,
       pendingCommand.action == .resetRoom,
       pendingCommand.commandID == commandID,
       resync.revision == pendingCommand.expectedRevision + 1,
       establishedPlayerID == viewerPlayerID {
      return true
    }
    guard synchronizedGeneration != generation,
          case .join(_, _, let playerID?, let recovery?) = admission,
          playerID == viewerPlayerID,
          recovery.commandID == commandID,
          resync.revision >= recovery.expectedRevision + 1
    else { return false }
    return true
  }

  private func sendPresenceIfNeeded(force: Bool) async {
    guard !disposed,
          phase == .connected,
          synchronizedGeneration == generation,
          let socket = currentSocket
    else { return }
    if !force,
       lastPresenceGeneration == generation,
       lastPresenceVisible == desiredVisible {
      return
    }
    let socketGeneration = generation
    let visible = desiredVisible
    presenceSendSerial &+= 1
    let sendSerial = presenceSendSerial
    let wireText: String
    do {
      wireText = try RealtimeFrameCodec.encodePresence(visible: visible)
      try await socket.send(text: wireText)
      guard isCurrent(socketGeneration),
            presenceSendSerial == sendSerial,
            desiredVisible == visible
      else { return }
      lastPresenceGeneration = socketGeneration
      lastPresenceVisible = visible
      if visible { lastResumeAt = environment.nowMilliseconds() }
    } catch {
      guard isCurrent(socketGeneration), presenceSendSerial == sendSerial else { return }
      await handleTransportEnd(socketGeneration: socketGeneration, shouldNotify: true)
    }
  }

  private func replayPendingIfNeeded(socketGeneration: UInt64) async {
    guard let pendingCommand,
          pendingCommand.acknowledgedRevision == nil,
          pendingCommand.sentGeneration != socketGeneration,
          let socket = currentSocket,
          synchronizedGeneration == socketGeneration
    else { return }
    let commandID = pendingCommand.commandID
    let wireText = pendingCommand.wireText
    do {
      try await socket.send(text: wireText)
      guard isCurrent(socketGeneration),
            var current = self.pendingCommand,
            current.commandID == commandID,
            current.wireText == wireText,
            current.acknowledgedRevision == nil
      else { return }
      current.sentGeneration = socketGeneration
      self.pendingCommand = current
    } catch {
      guard isCurrent(socketGeneration), self.pendingCommand?.commandID == commandID else { return }
      await handleTransportEnd(socketGeneration: socketGeneration, shouldNotify: true)
    }
  }

  private func completePendingIfConverged() {
    guard let pendingCommand,
          let acknowledged = pendingCommand.acknowledgedRevision,
          let lastAcceptedRevision,
          lastAcceptedRevision >= acknowledged
    else { return }
    clearPendingCommand()
  }

  private func restoreAdmissionAfterRejectedReset(_ pending: PendingCommand) {
    guard pending.action == .resetRoom, let previous = pending.admissionBeforeReset else { return }
    admission = previous
  }

  private func activeResetRecoveryCommandID() -> UUID? {
    if let preparingResetCommandID { return preparingResetCommandID }
    if let pendingCommand, pendingCommand.action == .resetRoom {
      return pendingCommand.commandID
    }
    if case .join(_, _, _, let recovery?) = admission {
      return recovery.commandID
    }
    return pendingRecoveryClearCommandID
  }

  private func clearPendingCommand() {
    let changed = pendingCommand != nil
    pendingCommand = nil
    if changed { publishStatus() }
  }

  private func quarantineAuthoritativeState() {
    lastAcceptedRevision = nil
    latestAuthoritativeSnapshot = nil
  }

  @discardableResult
  private func clearPersistedRecovery(commandID: UUID) async -> Bool {
    let beganTrackingClear = pendingRecoveryClearCommandID != commandID
    pendingRecoveryClearCommandID = commandID
    if beganTrackingClear { publishStatus() }
    do {
      try await environment.resetRecoveryStore.clear(
        accountID: confirmedAccount.accountID,
        commandID: commandID
      )
      if pendingRecoveryClearCommandID == commandID {
        pendingRecoveryClearCommandID = nil
        publishStatus()
      }
      return true
    } catch {
      publish(.notice(.resetRecoveryPersistenceFailed))
      return false
    }
  }

  private func retryPersistedRecoveryClearIfNeeded() async {
    guard let commandID = pendingRecoveryClearCommandID else { return }
    await clearPersistedRecovery(commandID: commandID)
  }

  private func armSynchronizationTimeout(socketGeneration: UInt64) {
    cancelSynchronizationTimeout()
    let sleep = environment.sleep
    syncTimeoutTask = Task { [weak self] in
      do {
        try await sleep(RoomProtocolV2.synchronizationTimeoutMilliseconds)
      } catch { return }
      guard !Task.isCancelled else { return }
      await self?.synchronizationTimedOut(socketGeneration: socketGeneration)
    }
  }

  private func synchronizationTimedOut(socketGeneration: UInt64) async {
    guard isCurrent(socketGeneration), synchronizedGeneration != socketGeneration else { return }
    publish(.notice(.synchronizationTimedOut))
    let canRecover = isRecoverable(admission)
    retireCurrentSocket(code: 4_001, reason: "Room synchronization timed out")
    if canRecover {
      scheduleReconnect()
    } else {
      admission = nil
      transition(to: .error)
    }
  }

  private func failClosedInvalidFrame(socketGeneration: UInt64) async {
    guard isCurrent(socketGeneration) else { return }
    publish(.notice(.invalidServerResponse))
    let canRecover = isRecoverable(admission)
    retireCurrentSocket(code: 1_002, reason: "Invalid server response")
    if canRecover {
      scheduleReconnect()
    } else {
      admission = nil
      transition(to: .error)
    }
  }

  private func handleTransportEnd(socketGeneration: UInt64, shouldNotify: Bool) async {
    guard isCurrent(socketGeneration) else { return }
    if shouldNotify { publish(.notice(.transportInterrupted)) }
    retireCurrentSocket(code: 1_011, reason: "Transport interrupted")
    if !online {
      transition(to: .offline)
    } else if isRecoverable(admission) {
      scheduleReconnect()
    } else {
      admission = nil
      transition(to: .error)
    }
  }

  private func scheduleReconnect() {
    guard !disposed, online, reconnectTask == nil, currentSocket == nil, isRecoverable(admission) else {
      return
    }
    let delay = Self.reconnectDelayMilliseconds(
      attempt: attempt,
      random: environment.random()
    )
    attempt = min(attempt + 1, RoomProtocolV2.reconnectBaseDelayMilliseconds.count - 1)
    transition(to: .reconnecting, retryInMilliseconds: delay)
    let expectedAdmission = admission
    let scheduledGeneration = generation
    let sleep = environment.sleep
    reconnectTask = Task { [weak self] in
      do { try await sleep(delay) } catch { return }
      guard !Task.isCancelled else { return }
      await self?.runScheduledReconnect(
        expectedAdmission: expectedAdmission,
        scheduledGeneration: scheduledGeneration
      )
    }
  }

  private func runScheduledReconnect(
    expectedAdmission: RoomAdmission?,
    scheduledGeneration: UInt64
  ) async {
    reconnectTask = nil
    guard !disposed,
          online,
          currentSocket == nil,
          generation == scheduledGeneration,
          admission == expectedAdmission,
          isRecoverable(admission)
    else { return }
    await openSocket(recovering: true)
  }

  private func cancelReconnect() {
    reconnectTask?.cancel()
    reconnectTask = nil
    retryInMilliseconds = nil
  }

  private func cancelSynchronizationTimeout() {
    syncTimeoutTask?.cancel()
    syncTimeoutTask = nil
  }

  private func retireCurrentSocket(code: Int, reason: String) {
    cancelSynchronizationTimeout()
    receiveTask?.cancel()
    receiveTask = nil
    guard let socket = currentSocket else {
      synchronizedGeneration = nil
      return
    }
    currentSocket = nil
    synchronizedGeneration = nil
    generation &+= 1
    Task { await socket.close(code: code, reason: reason) }
  }

  private func transition(to nextPhase: RoomConnectionPhase, retryInMilliseconds: Int? = nil) {
    phase = nextPhase
    self.retryInMilliseconds = retryInMilliseconds
    publishStatus()
  }

  private func publishStatus() {
    publish(.status(status()))
  }

  private func publish(_ event: RoomConnectionEvent) {
    for continuation in continuations.values { continuation.yield(event) }
  }

  private func removeContinuation(_ identifier: UUID) {
    continuations.removeValue(forKey: identifier)
  }

  private func isCurrent(_ socketGeneration: UInt64) -> Bool {
    !disposed && currentSocket != nil && generation == socketGeneration
  }

  private func isRecoverable(_ admission: RoomAdmission?) -> Bool {
    guard case .join(_, _, let playerID?, _) = admission else { return false }
    return !playerID.isEmpty
  }

  private func admissionPlayerID(_ admission: RoomAdmission?) -> String? {
    guard case .join(_, _, let playerID, _) = admission else { return nil }
    return playerID
  }

  private func admissionDisplayName(_ admission: RoomAdmission?) -> String? {
    switch admission {
    case .create(let displayName): return displayName
    case .join(_, let displayName, _, _): return displayName
    case nil: return nil
    }
  }

  private func admissionResetRecovery(_ admission: RoomAdmission?) -> RoomResetRecovery? {
    guard case .join(_, _, _, let recovery) = admission else { return nil }
    return recovery
  }

  private static func isValidWebSocketURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
          url.host != nil, url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil, url.path == "/rooms"
    else { return false }
    return true
  }
}

private actor URLSessionRoomWebSocket: RoomWebSocket {
  private let task: URLSessionWebSocketTask
  private var closed = false

  init(session: URLSession, request: URLRequest) {
    task = session.webSocketTask(with: request)
  }

  deinit {
    task.cancel(with: .goingAway, reason: nil)
  }

  func start() {
    task.resume()
  }

  func send(text: String) async throws {
    try await task.send(.string(text))
  }

  func receive() async throws -> RoomWebSocketMessage {
    switch try await task.receive() {
    case .string(let text): return .text(text)
    case .data(let data): return .data(data)
    @unknown default: throw RoomConnectionContractError.invalidFrame
    }
  }

  func close(code: Int, reason: String) {
    guard !closed else { return }
    closed = true
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
    task.cancel(with: closeCode, reason: Data(reason.utf8.prefix(123)))
  }
}

private final class RoomReachabilitySource: @unchecked Sendable {
  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "com.groundworkrevops.skyjo.reachability")
  private let lock = NSLock()
  private var started = false
  private var continuation: AsyncStream<Bool>.Continuation?

  func updates() -> AsyncStream<Bool> {
    AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      lock.lock()
      self.continuation = continuation
      let shouldStart = !started
      started = true
      lock.unlock()

      monitor.pathUpdateHandler = { [weak self] path in
        self?.yield(path.status == .satisfied)
      }
      if shouldStart { monitor.start(queue: queue) }
      continuation.onTermination = { [weak self] _ in self?.cancel() }
    }
  }

  private func yield(_ available: Bool) {
    lock.lock()
    let continuation = continuation
    lock.unlock()
    continuation?.yield(available)
  }

  private func cancel() {
    lock.lock()
    continuation = nil
    lock.unlock()
    monitor.cancel()
  }
}
