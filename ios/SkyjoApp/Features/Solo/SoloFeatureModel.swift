import Foundation
import Observation
import SkyjoDomain
import SkyjoPersistence

enum SoloScreen: Equatable {
  case loading
  case launcher
  case setup
  case table
}

enum SoloDrawChoice: String, CaseIterable, Identifiable {
  case place = "Place"
  case discardAndReveal = "Discard & Reveal"

  var id: Self { self }
}

struct SoloSavedGameSummary: Equatable {
  let round: Int
  let opponents: Int
  let difficulty: SoloAIDifficultySelection
  let savedAtMilliseconds: Int64
}

@MainActor
@Observable
final class SoloFeatureModel {
  @ObservationIgnored private let store: SoloPersistenceStore
  @ObservationIgnored private let statsOutbox: StatsOutboxCoordinator
  @ObservationIgnored private let preferences: SoloPreferencesStore
  @ObservationIgnored private let feedback: GameFeedbackController
  @ObservationIgnored private var autosave: SoloAutosaveCoordinator?
  @ObservationIgnored private var aiTask: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var statsAuthorizationGeneration: UInt64 = 0
  @ObservationIgnored private var loadedSavedAtMilliseconds: Int64 = 0
  @ObservationIgnored private let initialWarning: SoloPersistenceWarning?

  private var loadWarning: SoloPersistenceWarning?
  private var operationWarning: SoloPersistenceWarning?
  private var autosaveWarning: SoloPersistenceWarning?
  private var outboxWarning: SoloPersistenceWarning?

  private(set) var screen: SoloScreen = .loading
  private(set) var owner: SoloOwnerPartition = .guest
  private(set) var confirmedAccountID: UUID?
  private(set) var gameID: UUID?
  private(set) var game: GameState?
  private(set) var setup: SoloGameSetup?
  private(set) var saveSequence: Int64 = 0
  private(set) var hasDurableActiveSession = false
  private(set) var outboxStatus = StatsOutboxStatus(
    queued: 0,
    terminalFailures: 0,
    blockedByTerminalFailure: false
  )
  private(set) var isWorking = false
  private(set) var completionCommitted = false
  private(set) var completionError: String?
  private(set) var lastActionError: String?

  var setupOpponentCount = 1
  var setupDifficulty: SoloAIDifficultySelection = .medium
  var isReplacementReviewPresented = false
  var isScoreSummaryPresented = false
  var isScoreSummaryMinimized = false
  var isSettingsPresented = false
  var drawChoice: SoloDrawChoice = .place
  var reduceMotion = false
  var sceneIsActive = true

  init(
    store: SoloPersistenceStore,
    statsOutbox: StatsOutboxCoordinator,
    preferences: SoloPreferencesStore,
    feedback: GameFeedbackController,
    initialWarning: SoloPersistenceWarning? = nil
  ) {
    self.store = store
    self.statsOutbox = statsOutbox
    self.preferences = preferences
    self.feedback = feedback
    self.initialWarning = initialWarning
    loadWarning = initialWarning
  }

  var persistenceWarning: SoloPersistenceWarning? {
    operationWarning ?? outboxWarning ?? autosaveWarning ?? loadWarning ?? initialWarning
  }

  var statsDeliveryIsConfirmed: Bool {
    guard let accountID = owner.accountID else { return false }
    return confirmedAccountID == accountID
  }

  var completedStatsMessage: String {
    guard owner.accountID != nil else {
      return "Guest game complete. Account stats were not recorded."
    }
    guard statsDeliveryIsConfirmed else {
      return outboxStatus.queued > 0
        ? "The result is stored on this device and will sync after this account is confirmed online."
        : "Account stats delivery is paused until this account is confirmed online."
    }
    return outboxStatus.queued > 0
      ? "Stats are safely queued for your account."
      : "The completed game was saved to your account stats."
  }

  var settingsStatsMessage: String {
    guard owner.accountID != nil else {
      return "Guest games do not save account stats. Sign in before starting a game to queue its completed result."
    }
    guard statsDeliveryIsConfirmed else {
      return outboxStatus.queued > 0
        ? "\(outboxStatus.queued) completed game result(s) are stored on this device and will sync after this account is confirmed online."
        : "Account stats delivery is paused until this account is confirmed online."
    }
    return outboxStatus.queued == 0
      ? "No pending stats"
      : "\(outboxStatus.queued) completed game result(s) are queued on this device."
  }

  var savedGameSummary: SoloSavedGameSummary? {
    guard let game, let setup, hasDurableActiveSession else { return nil }
    return SoloSavedGameSummary(
      round: game.round,
      opponents: setup.aiOpponentCount,
      difficulty: setup.difficulty,
      savedAtMilliseconds: loadedSavedAtMilliseconds
    )
  }

  var humanPlayer: Player? {
    game?.players.first { $0.kind == .human }
  }

  var currentPlayer: Player? {
    guard let game, game.players.indices.contains(game.currentPlayerIndex) else { return nil }
    return game.players[game.currentPlayerIndex]
  }

  var isHumanTurn: Bool {
    currentPlayer?.kind == .human
  }

  var actionGuidance: String {
    guard let game, let currentPlayer else { return "Choose a game to begin." }
    if isWorking { return "Saving the completed game safely." }
    if currentPlayer.kind == .ai { return "\(currentPlayer.name) is choosing a move." }
    switch game.phase {
    case .openingReveal:
      return "Reveal two of your face-down cards."
    case .chooseSource:
      return "Take the visible discard or draw a blind card."
    case .chooseReplacement:
      if game.selectedSource == .discard {
        return "Choose a card to replace, or cancel and draw blind."
      }
      return drawChoice == .place
        ? "Choose any card to replace with the drawn card."
        : "Choose a face-down card to reveal after discarding the draw."
    case .roundOver:
      return "Round \(game.round) is complete. Review the scores when ready."
    case .gameOver:
      return completionCommitted
        ? "The game is complete."
        : "The game is complete, but its durable result still needs attention."
    }
  }

  func switchOwner(
    _ nextOwner: SoloOwnerPartition,
    confirmedAccountID nextConfirmedAccountID: UUID?
  ) async {
    if nextOwner == owner, screen != .loading {
      await updateStatsAuthorization(
        nextConfirmedAccountID,
        triggerDeliveryWhenConfirmed: true
      )
      return
    }

    generation &+= 1
    let expectedGeneration = generation
    statsAuthorizationGeneration &+= 1
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let priorAutosave = autosave
    aiTask?.cancel()
    aiTask = nil
    autosave = nil
    owner = nextOwner
    confirmedAccountID = nextConfirmedAccountID
    clearVisibleSession()
    screen = .loading
    loadWarning = initialWarning
    operationWarning = nil
    autosaveWarning = nil
    outboxWarning = nil
    await statsOutbox.setConfirmedAccount(nextConfirmedAccountID)
    await priorAutosave?.cancel()
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == nextOwner
    else { return }

    do {
      let result = try await store.loadSession(for: nextOwner)
      guard generation == expectedGeneration, owner == nextOwner else { return }
      loadWarning = result.warning ?? initialWarning
      if let session = result.session {
        install(session)
        screen = .launcher
      } else {
        screen = .setup
      }
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == nextOwner else { return }
      loadWarning = error.warning
      screen = .setup
    } catch {
      guard generation == expectedGeneration, owner == nextOwner else { return }
      loadWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "Saved games are unavailable on this device right now. You can still play this session."
      )
      screen = .setup
    }
    await refreshOutboxStatus()
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == nextOwner
    else { return }
    if nextConfirmedAccountID == nextOwner.accountID, nextConfirmedAccountID != nil {
      _ = await statsOutbox.trigger(.signIn)
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == nextOwner
      else { return }
      await refreshOutboxStatus()
    }
  }

  func invalidateStatsAuthorization() async {
    await updateStatsAuthorization(nil, triggerDeliveryWhenConfirmed: false)
  }

  func continueSavedGame() {
    guard game != nil, hasDurableActiveSession else { return }
    screen = .table
    completionCommitted = false
    completionError = nil
    isScoreSummaryPresented = game?.phase == .roundOver || game?.phase == .gameOver
    isScoreSummaryMinimized = false
    if let gameID {
      feedback.baseline(gameID: gameID, saveSequence: saveSequence)
    }
    scheduleAIIfNeeded()
  }

  func showSetup() {
    setupOpponentCount = setup?.aiOpponentCount ?? 1
    setupDifficulty = setup?.difficulty ?? .medium
    screen = .setup
    isReplacementReviewPresented = false
    pauseAI()
  }

  func cancelSetup() {
    isReplacementReviewPresented = false
    if hasDurableActiveSession {
      screen = .launcher
    } else if game?.phase == .gameOver, completionCommitted {
      screen = .table
    } else {
      screen = .setup
    }
  }

  func reviewNewGame() async {
    setupOpponentCount = GameEngine.normalizedSinglePlayerAIOpponentCount(setupOpponentCount)
    if hasDurableActiveSession {
      isReplacementReviewPresented = true
    } else {
      await startConfiguredGame(replacingGameID: nil)
    }
  }

  func confirmReplacement() async {
    guard hasDurableActiveSession, let gameID else {
      isReplacementReviewPresented = false
      return
    }
    await startConfiguredGame(replacingGameID: gameID)
  }

  func leaveTable() {
    pauseAI()
    isSettingsPresented = false
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    screen = hasDurableActiveSession ? .launcher : .setup
  }

  func performHuman(_ action: GameAction) async {
    guard screen == .table,
          isHumanTurn,
          !isWorking,
          !isScoreSummaryPresented,
          !isSettingsPresented
    else { return }
    await perform(action, feedbackEvent: feedbackEvent(for: action))
  }

  func selectDrawChoice(_ choice: SoloDrawChoice) {
    drawChoice = choice
  }

  func tapHumanCard(at index: Int) async {
    guard let game, isHumanTurn else { return }
    switch game.phase {
    case .openingReveal:
      await performHuman(.revealOpeningCard(index))
    case .chooseReplacement:
      if game.selectedSource == .draw, drawChoice == .discardAndReveal {
        await performHuman(.discardAndReveal(index))
      } else {
        await performHuman(.replaceCard(index))
      }
    case .chooseSource, .roundOver, .gameOver:
      return
    }
  }

  func startNextRound() async {
    guard let current = game, current.phase == .roundOver, !isWorking else { return }
    var random = SystemSkyjoRandom()
    let next = GameEngine.startNextRound(current, random: &random)
    guard next != current else { return }
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    await accept(next, feedbackEvent: .flip)
  }

  func retryCompletion() async {
    guard game?.phase == .gameOver, !completionCommitted else { return }
    await commitCompletion()
  }

  func replay() {
    guard completionCommitted else { return }
    setupOpponentCount = setup?.aiOpponentCount ?? 1
    setupDifficulty = setup?.difficulty ?? .medium
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    screen = .setup
  }

  func setScoreSummaryPresented(_ presented: Bool) {
    isScoreSummaryPresented = presented
    isScoreSummaryMinimized = !presented
    if presented { pauseAI() } else { scheduleAIIfNeeded() }
  }

  func setSettingsPresented(_ presented: Bool) {
    isSettingsPresented = presented
    if presented { pauseAI() } else { scheduleAIIfNeeded() }
  }

  func setSceneActive(_ active: Bool) {
    sceneIsActive = active
    feedback.setSceneActive(active)
    if active {
      scheduleAIIfNeeded()
      let expectedGeneration = generation
      let expectedAuthorizationGeneration = statsAuthorizationGeneration
      let expectedOwner = owner
      let expectedConfirmedAccountID = confirmedAccountID
      Task {
        if expectedConfirmedAccountID == expectedOwner.accountID,
           expectedConfirmedAccountID != nil,
           confirmedAccountID == expectedConfirmedAccountID,
           statsAuthorizationGeneration == expectedAuthorizationGeneration
        {
          _ = await statsOutbox.trigger(.foreground)
        }
        guard generation == expectedGeneration,
              statsAuthorizationGeneration == expectedAuthorizationGeneration,
              owner == expectedOwner,
              confirmedAccountID == expectedConfirmedAccountID
        else { return }
        await refreshOutboxStatus()
      }
    } else {
      pauseAI()
      let lifecycleAutosave = autosave
      Task {
        await lifecycleAutosave?.bestEffortLifecycleFlush()
      }
    }
  }

  func setReduceMotion(_ enabled: Bool) {
    reduceMotion = enabled
    scheduleAIIfNeeded()
  }

  func refreshOutboxStatus() async {
    let expectedGeneration = generation
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedOwner = owner
    let status: StatsOutboxStatus
    let warning: SoloPersistenceWarning?
    if let accountID = expectedOwner.accountID {
      if confirmedAccountID == accountID {
        status = await statsOutbox.status()
        warning = await statsOutbox.latestWarning
      } else {
        do {
          status = try await store.outboxStatus(accountID: accountID)
          warning = status.blockedByTerminalFailure
            ? SoloPersistenceWarning(
              kind: .statsNotSaved,
              message: "This completed game could not be saved to account stats. It remains on this device for recovery."
            )
            : nil
        } catch let error as SoloPersistenceError {
          status = emptyOutboxStatus
          warning = error.warning
        } catch {
          status = emptyOutboxStatus
          warning = SoloPersistenceWarning(
            kind: .unavailable,
            message: "Saved stats are unavailable on this device right now."
          )
        }
      }
    } else {
      status = emptyOutboxStatus
      warning = nil
    }
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner
    else { return }
    outboxStatus = status
    outboxWarning = warning
  }

  func retryBlockedStats() async {
    guard statsDeliveryIsConfirmed,
          outboxStatus.blockedHeadKind == .terminal,
          let handle = outboxStatus.blockedHeadRecoveryHandle
    else { return }
    let expectedGeneration = generation
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedOwner = owner
    _ = await statsOutbox.retryTerminalHead(expectedRecoveryHandle: handle)
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner,
          statsDeliveryIsConfirmed
    else { return }
    await refreshOutboxStatus()
  }

  func discardBlockedStats() async {
    guard statsDeliveryIsConfirmed,
          let handle = outboxStatus.blockedHeadRecoveryHandle
    else { return }
    let expectedGeneration = generation
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedOwner = owner
    do {
      try await statsOutbox.discardBlockedHead(expectedRecoveryHandle: handle)
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner,
            statsDeliveryIsConfirmed
      else { return }
      outboxWarning = nil
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner
      else { return }
      outboxWarning = error.warning
    } catch {
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner
      else { return }
      outboxWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "The blocked stats item could not be removed. Nothing else was changed."
      )
    }
    await refreshOutboxStatus()
  }

  private func updateStatsAuthorization(
    _ nextConfirmedAccountID: UUID?,
    triggerDeliveryWhenConfirmed: Bool
  ) async {
    statsAuthorizationGeneration &+= 1
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedGeneration = generation
    let expectedOwner = owner
    confirmedAccountID = nextConfirmedAccountID
    await statsOutbox.setConfirmedAccount(nextConfirmedAccountID)
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner,
          confirmedAccountID == nextConfirmedAccountID
    else { return }
    await refreshOutboxStatus()
    guard triggerDeliveryWhenConfirmed,
          generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner,
          nextConfirmedAccountID == expectedOwner.accountID,
          nextConfirmedAccountID != nil
    else { return }
    _ = await statsOutbox.trigger(.signIn)
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner
    else { return }
    await refreshOutboxStatus()
  }

  private func startConfiguredGame(replacingGameID: UUID?) async {
    guard !isWorking else { return }
    let expectedGeneration = generation
    let expectedOwner = owner
    isWorking = true
    lastActionError = nil
    defer { isWorking = false }

    let newGameID = UUID()
    var random = SystemSkyjoRandom()
    let newState = GameEngine.startFreshGame(
      aiOpponentCount: setupOpponentCount,
      random: &random
    )
    let unresolved = SoloGameSetup(
      aiOpponentCount: setupOpponentCount,
      difficulty: setupDifficulty,
      strategyVersion: SkyjoRules.strategyVersion
    )
    let resolved: SoloGameSetup
    do {
      resolved = try SoloAISetup.resolve(
        unresolved,
        state: newState,
        gameId: newGameID.uuidString.lowercased()
      )
    } catch {
      lastActionError = "That setup could not be created. Review the options and try again."
      return
    }

    do {
      let snapshot: SoloSessionSnapshot
      if let replacingGameID {
        snapshot = try await store.replaceSession(
          owner: expectedOwner,
          expectedGameID: replacingGameID,
          newGameID: newGameID,
          state: newState,
          setup: resolved
        )
      } else {
        snapshot = try await store.startSession(
          owner: expectedOwner,
          gameID: newGameID,
          state: newState,
          setup: resolved
        )
      }
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      install(snapshot)
      operationWarning = nil
      autosaveWarning = nil
      isReplacementReviewPresented = false
      screen = .table
      feedback.baseline(gameID: snapshot.gameID, saveSequence: snapshot.saveSequence)
      scheduleAIIfNeeded()
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      operationWarning = error.warning
      lastActionError = replacingGameID == nil
        ? "The game could not be saved. Your setup is still here so you can try again."
        : "The replacement could not be saved. Your previous game is still recoverable."
      if error == .sessionConflict {
        await reloadAfterConflict(
          expectedGeneration: expectedGeneration,
          expectedOwner: expectedOwner
        )
      }
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      operationWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "Saved games are unavailable on this device right now."
      )
      lastActionError = replacingGameID == nil
        ? "The game could not be started safely. Try again."
        : "The replacement failed. Your previous game is still recoverable."
    }
  }

  private func reloadAfterConflict(
    expectedGeneration: UInt64,
    expectedOwner: SoloOwnerPartition
  ) async {
    do {
      let result = try await store.loadSession(for: expectedOwner)
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      if let session = result.session {
        install(session)
        screen = .launcher
      }
      operationWarning = result.warning ?? conflictWarning
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      operationWarning = conflictWarning
    }
    isReplacementReviewPresented = false
  }

  private func install(_ snapshot: SoloSessionSnapshot) {
    gameID = snapshot.gameID
    game = snapshot.state
    setup = snapshot.setup
    saveSequence = snapshot.saveSequence
    loadedSavedAtMilliseconds = snapshot.savedAtMilliseconds
    hasDurableActiveSession = true
    completionCommitted = false
    completionError = nil
    drawChoice = .place
    autosave = SoloAutosaveCoordinator(
      store: store,
      owner: snapshot.owner,
      gameID: snapshot.gameID,
      setup: snapshot.setup,
      initialSaveSequence: snapshot.saveSequence
    )
  }

  private func clearVisibleSession() {
    gameID = nil
    game = nil
    setup = nil
    saveSequence = 0
    loadedSavedAtMilliseconds = 0
    hasDurableActiveSession = false
    completionCommitted = false
    completionError = nil
    lastActionError = nil
    isReplacementReviewPresented = false
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    isSettingsPresented = false
    drawChoice = .place
    outboxStatus = StatsOutboxStatus(
      queued: 0,
      terminalFailures: 0,
      blockedByTerminalFailure: false
    )
  }

  private func perform(_ action: GameAction, feedbackEvent: GameFeedbackEvent) async {
    guard let current = game else { return }
    var random = SystemSkyjoRandom()
    let next = GameEngine.reduce(current, action: action, random: &random)
    guard next != current else { return }
    await accept(next, feedbackEvent: feedbackEvent)
  }

  private func accept(_ next: GameState, feedbackEvent: GameFeedbackEvent) async {
    guard let gameID else { return }
    let expectedGeneration = generation
    let expectedOwner = owner
    let expectedAutosave = autosave
    let previous = game
    game = next
    saveSequence += 1
    loadedSavedAtMilliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
    drawChoice = .place

    let removedBefore = previous?.players.reduce(0) { partial, player in
      partial + player.grid.filter(\.removed).count
    } ?? 0
    let removedAfter = next.players.reduce(0) { partial, player in
      partial + player.grid.filter(\.removed).count
    }
    feedback.emit(
      removedAfter > removedBefore ? .columnClear : feedbackEvent,
      gameID: gameID,
      saveSequence: saveSequence
    )

    if next.phase == .gameOver {
      isScoreSummaryPresented = true
      isScoreSummaryMinimized = false
      feedback.emit(.gameEnd, gameID: gameID, saveSequence: saveSequence)
      await commitCompletion()
      return
    }

    await expectedAutosave?.recordLegalTurn(state: next, saveSequence: saveSequence)
    guard generation == expectedGeneration,
          owner == expectedOwner,
          self.gameID == gameID,
          screen == .table,
          !Task.isCancelled
    else { return }
    if next.phase == .roundOver, screen == .table {
      isScoreSummaryPresented = true
      isScoreSummaryMinimized = false
      feedback.emit(.roundEnd, gameID: gameID, saveSequence: saveSequence)
      pauseAI()
    } else {
      scheduleAIIfNeeded()
    }
    if let expectedAutosave {
      observeAutosave(
        expectedAutosave,
        expectedGeneration: expectedGeneration,
        expectedOwner: expectedOwner,
        expectedGameID: gameID
      )
    }
  }

  private func commitCompletion() async {
    guard let gameID, let game, let setup, game.phase == .gameOver else { return }
    let expectedGeneration = generation
    let expectedOwner = owner
    let expectedConfirmedAccountID = confirmedAccountID
    let completionAutosave = autosave
    isWorking = true
    completionError = nil
    let flushWarning = await completionAutosave?.flushPending()
    guard generation == expectedGeneration, owner == expectedOwner else {
      isWorking = false
      return
    }
    await completionAutosave?.cancel()
    guard generation == expectedGeneration, owner == expectedOwner else {
      isWorking = false
      return
    }
    autosave = nil
    autosaveWarning = flushWarning
    do {
      try await store.completeSession(
        owner: expectedOwner,
        gameID: gameID,
        state: game,
        setup: setup,
        saveSequence: saveSequence
      )
      guard generation == expectedGeneration, owner == expectedOwner else {
        isWorking = false
        return
      }
      hasDurableActiveSession = false
      completionCommitted = true
      completionError = nil
      operationWarning = nil
      if expectedConfirmedAccountID == expectedOwner.accountID,
         confirmedAccountID == expectedConfirmedAccountID
      {
        _ = await statsOutbox.trigger(.completion)
        guard generation == expectedGeneration, owner == expectedOwner else {
          isWorking = false
          return
        }
      }
      await refreshOutboxStatus()
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == expectedOwner else {
        isWorking = false
        return
      }
      operationWarning = error.warning
      completionError = "The result is still recoverable on this device. Retry before starting another game."
      completionCommitted = false
      // A failed completion keeps the prior nonterminal durable snapshot. Recreate its coordinator
      // so lifecycle flush/retry can continue without creating a second game.
      autosave = SoloAutosaveCoordinator(
        store: store,
        owner: expectedOwner,
        gameID: gameID,
        setup: setup,
        initialSaveSequence: max(0, saveSequence - 1)
      )
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else {
        isWorking = false
        return
      }
      operationWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "The completed game could not be committed to device storage."
      )
      completionError = "Retry before starting another game."
      completionCommitted = false
      autosave = SoloAutosaveCoordinator(
        store: store,
        owner: expectedOwner,
        gameID: gameID,
        setup: setup,
        initialSaveSequence: max(0, saveSequence - 1)
      )
    }
    isWorking = false
  }

  private func pauseAI() {
    aiTask?.cancel()
    aiTask = nil
  }

  private func scheduleAIIfNeeded() {
    pauseAI()
    guard screen == .table,
          sceneIsActive,
          !isSettingsPresented,
          !isScoreSummaryPresented,
          !isWorking,
          let game,
          let gameID,
          game.phase != .roundOver,
          game.phase != .gameOver,
          game.players.indices.contains(game.currentPlayerIndex),
          game.players[game.currentPlayerIndex].kind == .ai
    else { return }
    let expectedGeneration = generation
    let expectedGameID = gameID
    aiTask = Task { [weak self] in
      guard let self else { return }
      if !self.reduceMotion {
        try? await Task.sleep(
          for: .milliseconds(GameEngine.soloAIOpeningSeatDelayMilliseconds)
        )
      }
      guard !Task.isCancelled else { return }
      await self.performNextAITransition(
        expectedGeneration: expectedGeneration,
        expectedGameID: expectedGameID
      )
    }
  }

  private func performNextAITransition(
    expectedGeneration: UInt64,
    expectedGameID: UUID
  ) async {
    guard generation == expectedGeneration,
          gameID == expectedGameID,
          screen == .table,
          let current = game,
          let setup,
          current.players.indices.contains(current.currentPlayerIndex),
          current.players[current.currentPlayerIndex].kind == .ai,
          !isSettingsPresented,
          !isScoreSummaryPresented,
          sceneIsActive,
          !Task.isCancelled
    else { return }

    let player = current.players[current.currentPlayerIndex]
    if current.phase == .openingReveal {
      let next = GameEngine.advanceSoloAIOpeningSeat(current)
      guard next != current else { return }
      await accept(next, feedbackEvent: .flip)
      return
    }

    guard let difficulty = try? SoloAISetup.difficulty(for: player.id, in: setup),
          let move = SkyjoAI.chooseMove(
            for: current,
            options: AIDecisionOptions(
              playerId: player.id,
              difficulty: difficulty,
              decisionKey: "\(expectedGameID.uuidString.lowercased()):\(current.round):\(current.log.first ?? "")"
            )
          ),
          let action = gameAction(for: move, phase: current.phase)
    else { return }
    await perform(action, feedbackEvent: feedbackEvent(for: action))
  }

  private func observeAutosave(
    _ coordinator: SoloAutosaveCoordinator,
    expectedGeneration: UInt64,
    expectedOwner: SoloOwnerPartition,
    expectedGameID: UUID
  ) {
    Task { @MainActor [weak self] in
      let warning = await coordinator.flushPending()
      guard let self,
            self.generation == expectedGeneration,
            self.owner == expectedOwner,
            self.gameID == expectedGameID
      else { return }
      self.autosaveWarning = warning
    }
  }

  private func gameAction(for move: AIMove, phase: TurnPhase) -> GameAction? {
    switch move.action {
    case .discard:
      return .chooseDiscard
    case .draw:
      return .drawBlind
    case .replace:
      return move.index.map(GameAction.replaceCard)
    case .reveal:
      guard let index = move.index else { return nil }
      return phase == .openingReveal
        ? .revealOpeningCard(index)
        : .discardAndReveal(index)
    }
  }

  private func feedbackEvent(for action: GameAction) -> GameFeedbackEvent {
    switch action {
    case .revealOpeningCard, .discardAndReveal:
      return .flip
    case .chooseDiscard, .drawBlind:
      return .pickup
    case .cancelDiscard:
      return .pickup
    case .replaceCard:
      return .place
    }
  }

  private var conflictWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .conflict,
      message: "A newer saved game is already active. The current game was left unchanged."
    )
  }

  private var emptyOutboxStatus: StatsOutboxStatus {
    StatsOutboxStatus(
      queued: 0,
      terminalFailures: 0,
      blockedByTerminalFailure: false
    )
  }

#if DEBUG
  @discardableResult
  func applyUITestState(arguments: [String]) -> Bool {
    guard let stateArgument = arguments.first(where: { $0.hasPrefix("--ui-state=") }) else {
      return false
    }
    let value = String(stateArgument.dropFirst("--ui-state=".count))
    guard value.hasPrefix("solo-") else { return false }
    var random = SeededRandom(seed: 18_700)
    let fixtureGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000187")!
    let state = GameEngine.startFreshGame(aiOpponentCount: 3, random: &random)
    let fixtureSetup = try! SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 3, difficulty: .mixed),
      state: state,
      gameId: fixtureGameID.uuidString.lowercased()
    )
    gameID = fixtureGameID
    game = state
    setup = fixtureSetup
    saveSequence = 4
    hasDurableActiveSession = true
    loadedSavedAtMilliseconds = 1_785_200_000_000
    completionCommitted = false
    loadWarning = nil
    operationWarning = nil
    autosaveWarning = nil
    outboxWarning = nil
    switch value {
    case "solo-launcher":
      screen = .launcher
    case "solo-setup":
      clearVisibleSession()
      screen = .setup
    case "solo-table":
      screen = .table
    case "solo-summary":
      var summaryState = state
      summaryState.phase = .roundOver
      summaryState.roundHistory = [
        RoundHistoryEntry(
          round: 1,
          closerId: "human",
          scores: summaryState.players.map {
            RoundScore(
              playerId: $0.id,
              name: $0.name,
              roundScore: GameEngine.scoreGrid($0.grid),
              totalScore: GameEngine.scoreGrid($0.grid)
            )
          }
        )
      ]
      game = summaryState
      screen = .table
      isScoreSummaryPresented = true
    case "solo-recovery":
      screen = .launcher
      loadWarning = SoloPersistenceWarning(
        kind: .recovered,
        message: "A damaged saved game was removed safely."
      )
    case "solo-replacement-error":
      screen = .setup
      isReplacementReviewPresented = true
      lastActionError = "The replacement could not be saved. Your previous game is still recoverable."
      operationWarning = SoloPersistenceWarning(
        kind: .quota,
        message: "This device is low on storage. Your previous game remains recoverable."
      )
    case "solo-offline-account":
      screen = .launcher
      outboxStatus = StatsOutboxStatus(
        queued: 1,
        terminalFailures: 0,
        blockedByTerminalFailure: false
      )
    default:
      return false
    }
    return true
  }
#endif
}
