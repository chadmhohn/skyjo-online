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

private enum CompletionReloadReason: Sendable {
  case conflict
  case invalidResult
}

private struct PendingSessionReconciliation: Sendable {
  let owner: SoloOwnerPartition
  let attemptedGameID: UUID
  let replacingGameID: UUID?
  let acknowledgementWasIndeterminate: Bool
}

private struct PendingTerminalCompletion: Equatable, Sendable {
  let owner: SoloOwnerPartition
  let gameID: UUID
  let state: GameState
  let setup: SoloGameSetup
  let saveSequence: Int64
}

private struct SoloWorkingOperation: Equatable, Sendable {
  let id: UUID
  let generation: UInt64
  let owner: SoloOwnerPartition
}

@MainActor
@Observable
final class SoloFeatureModel {
  @ObservationIgnored private let store: SoloPersistenceStore
  @ObservationIgnored private let statsOutbox: StatsOutboxCoordinator
  @ObservationIgnored private let preferences: SoloPreferencesStore
  @ObservationIgnored private let feedback: GameFeedbackController
  @ObservationIgnored private let persistenceIsDurable: Bool
  @ObservationIgnored private let replacementCommitBarrier: @Sendable () async -> Void
  @ObservationIgnored private let completionCommitBarrier: @Sendable () async -> Void
  @ObservationIgnored private let completionStatusReadBarrier: @Sendable () async -> Void
  @ObservationIgnored private let aiTurnDelay: @Sendable () async throws -> Void
  @ObservationIgnored private var autosave: SoloAutosaveCoordinator?
  @ObservationIgnored private var aiTask: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var statsAuthorizationGeneration: UInt64 = 0
  @ObservationIgnored private var loadedSavedAtMilliseconds: Int64 = 0
  @ObservationIgnored private var loadedSavedRound = 0
  @ObservationIgnored private var loadedSavedSequence: Int64 = 0
  @ObservationIgnored private var completionReloadReason: CompletionReloadReason?
  @ObservationIgnored private var pendingSessionReconciliation: PendingSessionReconciliation?
  @ObservationIgnored private var pendingTerminalCompletions: [
    SoloOwnerPartition: PendingTerminalCompletion
  ] = [:]
  @ObservationIgnored private var workingOperation: SoloWorkingOperation?
  @ObservationIgnored private let initialWarning: SoloPersistenceWarning?
#if DEBUG
  @ObservationIgnored private var usesUITestState = false
#endif

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
  private(set) var completionRequiresSavedGameReload = false
  private(set) var sessionReconciliationRequired = false
  private(set) var completionError: String?
  private(set) var lastActionError: String?
  private(set) var outboxRecoveryMessage: String?

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
    initialWarning: SoloPersistenceWarning? = nil,
    persistenceIsDurable: Bool = true,
    replacementCommitBarrier: @escaping @Sendable () async -> Void = {},
    completionCommitBarrier: @escaping @Sendable () async -> Void = {},
    completionStatusReadBarrier: @escaping @Sendable () async -> Void = {},
    aiTurnDelay: @escaping @Sendable () async throws -> Void = {
      try await Task.sleep(
        for: .milliseconds(GameEngine.soloAIOpeningSeatDelayMilliseconds)
      )
    }
  ) {
    self.store = store
    self.statsOutbox = statsOutbox
    self.preferences = preferences
    self.feedback = feedback
    self.persistenceIsDurable = persistenceIsDurable
    self.replacementCommitBarrier = replacementCommitBarrier
    self.completionCommitBarrier = completionCommitBarrier
    self.completionStatusReadBarrier = completionStatusReadBarrier
    self.aiTurnDelay = aiTurnDelay
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

  var sessionStorageIsPersistent: Bool { persistenceIsDurable }

  var activeSessionIsPersistent: Bool {
    hasDurableActiveSession && persistenceIsDurable
  }

  var hasUncommittedTerminalCompletion: Bool {
    game?.phase == .gameOver && !completionCommitted
  }

  var completedStatsMessage: String {
    guard owner.accountID != nil else {
      return "Guest game complete. Account stats were not recorded."
    }
    if !persistenceIsDurable, outboxStatus.queued > 0 {
      return "This result is queued only for the current app session. Recover or deliver it before closing Skyjo."
    }
    if !persistenceIsDurable, outboxWarning != nil {
      return "Account stats delivery status is unavailable. Any recoverable result lasts only while Skyjo remains open; try again before closing the app."
    }
    if let blockedHeadKind = outboxStatus.blockedHeadKind {
      let attention = blockedHeadKind == .terminal
        ? "The oldest completed result needs attention before stats delivery can continue."
        : "The oldest completed result is damaged and needs recovery before stats delivery can continue."
      return statsDeliveryIsConfirmed
        ? attention
        : "\(attention) Confirm this account online before changing its stored result."
    }
    if outboxWarning != nil {
      return "Account stats delivery status is unavailable. Keep this result on this device and try again later."
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
    if !persistenceIsDurable, outboxStatus.queued > 0 {
      return "Pending stats exist only for the current app session. Keep Skyjo open and restore connectivity before relying on delivery."
    }
    if !persistenceIsDurable, outboxWarning != nil {
      return "Account stats delivery status is unavailable. Any recoverable results last only while Skyjo remains open; try again before closing the app."
    }
    if let blockedHeadKind = outboxStatus.blockedHeadKind {
      let attention = blockedHeadKind == .terminal
        ? "The oldest completed result was rejected and needs recovery before delivery can continue."
        : "The oldest completed result is damaged and needs recovery before delivery can continue."
      return statsDeliveryIsConfirmed
        ? attention
        : "\(attention) Confirm this account online before changing it."
    }
    if outboxWarning != nil {
      return "Account stats delivery status is unavailable. Stored results will remain on this device until it can be checked again."
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

  var statsDeliverySystemImage: String {
    if owner.accountID == nil { return "person.crop.circle.badge.questionmark" }
    if !persistenceIsDurable, outboxStatus.queued > 0 {
      return "exclamationmark.triangle.fill"
    }
    if outboxStatus.blockedHeadKind != nil || outboxWarning != nil {
      return "exclamationmark.triangle.fill"
    }
    return statsDeliveryIsConfirmed ? "checkmark.circle.fill" : "icloud.slash"
  }

  var savedGameSummary: SoloSavedGameSummary? {
    guard game != nil, let setup, hasDurableActiveSession else { return nil }
    return SoloSavedGameSummary(
      round: loadedSavedRound,
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

  var tableStatus: String {
    guard let game else { return "Table paused" }
    switch game.phase {
    case .roundOver:
      return "Round complete"
    case .gameOver:
      return "Game complete"
    case .openingReveal, .chooseSource, .chooseReplacement:
      guard let currentPlayer else { return "Table paused" }
      return currentPlayer.kind == .human ? "Your turn" : "\(currentPlayer.name)'s turn"
    }
  }

  var actionGuidance: String {
    guard let game else { return "Choose a game to begin." }
    if isWorking { return "Saving the completed game safely." }
    switch game.phase {
    case .roundOver:
      return "Round \(game.round) is complete. Review the scores when ready."
    case .gameOver:
      return completionCommitted
        ? "The game is complete."
        : "The game is complete, but its durable result still needs attention."
    case .openingReveal:
      guard let currentPlayer else { return "Table paused." }
      if currentPlayer.kind == .ai { return "\(currentPlayer.name) is choosing opening cards." }
      return "Reveal two of your face-down cards."
    case .chooseSource:
      guard let currentPlayer else { return "Table paused." }
      if currentPlayer.kind == .ai { return "\(currentPlayer.name) is choosing a move." }
      return "Take the visible discard or draw a blind card."
    case .chooseReplacement:
      guard let currentPlayer else { return "Table paused." }
      if currentPlayer.kind == .ai { return "\(currentPlayer.name) is choosing a move." }
      if game.selectedSource == .discard {
        return "Choose a card to replace, or cancel and draw blind."
      }
      return drawChoice == .place
        ? "Choose any card to replace with the drawn card."
        : "Choose a face-down card to reveal after discarding the draw."
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
      }
      if let pendingCompletion = pendingTerminalCompletions[nextOwner] {
        restorePendingTerminalCompletion(pendingCompletion)
      } else if result.session != nil {
        screen = .launcher
      } else {
        screen = .setup
      }
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == nextOwner else { return }
      loadWarning = error.warning
      if let pendingCompletion = pendingTerminalCompletions[nextOwner] {
        restorePendingTerminalCompletion(pendingCompletion)
      } else {
        screen = .setup
      }
    } catch {
      guard generation == expectedGeneration, owner == nextOwner else { return }
      loadWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "Saved games are unavailable on this device right now. You can still play this session."
      )
      if let pendingCompletion = pendingTerminalCompletions[nextOwner] {
        restorePendingTerminalCompletion(pendingCompletion)
      } else {
        screen = .setup
      }
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
    guard !sessionReconciliationRequired, game != nil, hasDurableActiveSession else { return }
    screen = .table
    completionCommitted = false
    if game?.phase != .gameOver {
      completionError = nil
    }
    isScoreSummaryPresented = game?.phase == .roundOver || game?.phase == .gameOver
    isScoreSummaryMinimized = false
    if let gameID {
      feedback.baseline(gameID: gameID, saveSequence: saveSequence)
    }
    scheduleAIIfNeeded()
  }

  func showSetup() {
    guard !hasUncommittedTerminalCompletion else {
      presentUncommittedCompletionForRecovery()
      return
    }
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
    guard !hasUncommittedTerminalCompletion else {
      presentUncommittedCompletionForRecovery()
      return
    }
    guard !sessionReconciliationRequired else { return }
    setupOpponentCount = GameEngine.normalizedSinglePlayerAIOpponentCount(setupOpponentCount)
    if hasDurableActiveSession {
      isReplacementReviewPresented = true
    } else {
      await startConfiguredGame(replacingGameID: nil)
    }
  }

  @discardableResult
  func confirmReplacement() -> Task<Void, Never>? {
    guard !hasUncommittedTerminalCompletion else {
      presentUncommittedCompletionForRecovery()
      return nil
    }
    guard hasDurableActiveSession, let gameID else {
      isReplacementReviewPresented = false
      return nil
    }
    guard !sessionReconciliationRequired,
          let operation = beginWorking()
    else { return nil }

    // Claim the working operation synchronously in the button action. SwiftUI
    // can therefore disable Cancel and interactive dismissal before this task
    // gets its first actor turn.
    return Task { @MainActor [weak self] in
      guard let self else { return }
      await startConfiguredGame(
        replacingGameID: gameID,
        operation: operation
      )
    }
  }

  @discardableResult
  func cancelReplacementReview() -> Bool {
    guard !isWorking else { return false }
    isReplacementReviewPresented = false
    return true
  }

  func leaveTable() {
    // Terminal completion owns the durable session until its transaction
    // resolves. Ignoring navigation cleanup during that narrow window prevents
    // a successful commit from returning to a launcher whose session was just
    // retired and therefore cannot be continued.
    guard !isWorking else { return }
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
    guard game?.phase == .gameOver,
          !completionCommitted,
          !completionRequiresSavedGameReload,
          !isWorking
    else { return }
    await commitCompletion()
  }

  func retrySessionReconciliation() async {
    guard let pendingSessionReconciliation,
          pendingSessionReconciliation.owner == owner,
          let operation = beginWorking()
    else { return }
    defer {
      finishWorking(operation, scheduleAI: true)
    }
    await reconcileAfterSessionWriteFailure(
      expectedGeneration: operation.generation,
      expectedOwner: operation.owner,
      attemptedGameID: pendingSessionReconciliation.attemptedGameID,
      replacingGameID: pendingSessionReconciliation.replacingGameID,
      acknowledgementWasIndeterminate: pendingSessionReconciliation.acknowledgementWasIndeterminate
    )
  }

  func reloadSavedGameAfterCompletionFailure() async {
    guard completionRequiresSavedGameReload,
          let completionReloadReason,
          let operation = beginWorking()
    else { return }
    defer { finishWorking(operation) }
    await recoverSavedGameAfterCompletionFailure(
      expectedGeneration: operation.generation,
      expectedOwner: operation.owner,
      reason: completionReloadReason
    )
  }

  func playAgain() async {
    guard completionCommitted else { return }
    setupOpponentCount = setup?.aiOpponentCount ?? 1
    setupDifficulty = setup?.difficulty ?? .medium
    await startConfiguredGame(replacingGameID: nil)
  }

  func changeSetup() {
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
      && (game?.phase == .roundOver || game?.phase == .gameOver)
    if presented { pauseAI() } else { scheduleAIIfNeeded() }
  }

  func setSettingsPresented(_ presented: Bool) {
    isSettingsPresented = presented
    if presented { pauseAI() } else { scheduleAIIfNeeded() }
  }

  private func presentUncommittedCompletionForRecovery() {
    guard hasUncommittedTerminalCompletion else { return }
    isReplacementReviewPresented = false
    isSettingsPresented = false
    screen = .table
    isScoreSummaryPresented = true
    isScoreSummaryMinimized = false
    pauseAI()
  }

  func setSceneActive(_ active: Bool) {
    sceneIsActive = active
    feedback.setSceneActive(active)
    if active {
      scheduleAIIfNeeded()
#if DEBUG
      if usesUITestState { return }
#endif
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
    outboxRecoveryMessage = nil
    outboxStatus = status
    outboxWarning = warning
  }

  func retryBlockedStats() async {
    guard statsDeliveryIsConfirmed,
          outboxStatus.blockedHeadKind == .terminal,
          let handle = outboxStatus.blockedHeadRecoveryHandle
    else { return }
    outboxRecoveryMessage = nil
    let expectedGeneration = generation
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedOwner = owner
#if DEBUG
    if usesUITestState, let accountID = expectedOwner.accountID {
      // The UI fixture owns a genuine terminal row in the in-memory store. A dedicated
      // successful coordinator exercises the same opaque-handle retry and delivery path
      // without depending on a simulator's network or account cookies.
      let fixtureCoordinator = StatsOutboxCoordinator(store: store) { _ in }
      await fixtureCoordinator.setConfirmedAccount(accountID)
      _ = await fixtureCoordinator.retryTerminalHead(expectedRecoveryHandle: handle)
      await fixtureCoordinator.dispose()
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner,
            statsDeliveryIsConfirmed
      else { return }
      await refreshOutboxStatus()
      if outboxStatus.blockedHeadKind == nil, outboxWarning == nil {
        outboxRecoveryMessage = "The oldest result was retried and delivered."
      }
      return
    }
#endif
    _ = await statsOutbox.retryTerminalHead(expectedRecoveryHandle: handle)
    guard generation == expectedGeneration,
          statsAuthorizationGeneration == expectedAuthorizationGeneration,
          owner == expectedOwner,
          statsDeliveryIsConfirmed
    else { return }
    await refreshOutboxStatus()
    if outboxStatus.blockedHeadKind == nil, outboxWarning == nil {
      outboxRecoveryMessage = outboxStatus.queued == 0
        ? "The oldest result was retried and delivered."
        : "The oldest result is ready to send again."
    }
  }

  func discardBlockedStats(expectedRecoveryHandle: StatsOutboxRecoveryHandle) async {
    guard statsDeliveryIsConfirmed,
          outboxStatus.blockedHeadRecoveryHandle == expectedRecoveryHandle
    else { return }
    let handle = expectedRecoveryHandle
    outboxRecoveryMessage = nil
    let expectedGeneration = generation
    let expectedAuthorizationGeneration = statsAuthorizationGeneration
    let expectedOwner = owner
    var didDiscard = false
    do {
      try await statsOutbox.discardBlockedHead(expectedRecoveryHandle: handle)
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner,
            statsDeliveryIsConfirmed
      else { return }
      outboxWarning = nil
      didDiscard = true
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
    if didDiscard {
      _ = await statsOutbox.trigger(.completion)
      guard generation == expectedGeneration,
            statsAuthorizationGeneration == expectedAuthorizationGeneration,
            owner == expectedOwner,
            statsDeliveryIsConfirmed
      else { return }
    }
    await refreshOutboxStatus()
    if didDiscard, outboxStatus.blockedHeadKind == nil, outboxWarning == nil {
      outboxRecoveryMessage = "The oldest stored result was discarded."
    }
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
    guard !hasUncommittedTerminalCompletion else {
      presentUncommittedCompletionForRecovery()
      return
    }
    guard !sessionReconciliationRequired,
          let operation = beginWorking()
    else { return }
    await startConfiguredGame(replacingGameID: replacingGameID, operation: operation)
  }

  private func startConfiguredGame(
    replacingGameID: UUID?,
    operation: SoloWorkingOperation
  ) async {
    guard workingOperation == operation, isWorking else { return }
    let expectedGeneration = operation.generation
    let expectedOwner = operation.owner
    lastActionError = nil
    defer {
      finishWorking(operation, scheduleAI: true)
    }
    guard !hasUncommittedTerminalCompletion,
          !sessionReconciliationRequired,
          generation == expectedGeneration,
          owner == expectedOwner
    else { return }

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
        await replacementCommitBarrier()
        guard generation == expectedGeneration, owner == expectedOwner else { return }
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
      isScoreSummaryPresented = false
      isScoreSummaryMinimized = false
      screen = .table
      feedback.baseline(gameID: snapshot.gameID, saveSequence: snapshot.saveSequence)
      scheduleAIIfNeeded()
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      operationWarning = error.warning
      lastActionError = replacingGameID == nil
        ? "The game could not be saved. Your setup is still here so you can try again."
        : "The replacement could not be saved. Your previous game is still recoverable."
      if error == .sessionConflict || error == .writeInterrupted {
        await reconcileAfterSessionWriteFailure(
          expectedGeneration: expectedGeneration,
          expectedOwner: expectedOwner,
          attemptedGameID: newGameID,
          replacingGameID: replacingGameID,
          acknowledgementWasIndeterminate: error == .writeInterrupted
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

  private func reconcileAfterSessionWriteFailure(
    expectedGeneration: UInt64,
    expectedOwner: SoloOwnerPartition,
    attemptedGameID: UUID,
    replacingGameID: UUID?,
    acknowledgementWasIndeterminate: Bool
  ) async {
    let pending = PendingSessionReconciliation(
      owner: expectedOwner,
      attemptedGameID: attemptedGameID,
      replacingGameID: replacingGameID,
      acknowledgementWasIndeterminate: acknowledgementWasIndeterminate
    )
    let staleAutosave = autosave
    do {
      var result = try await store.loadSession(for: expectedOwner)
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      if let session = result.session {
        if let replacingGameID,
           session.gameID == replacingGameID,
           gameID == replacingGameID,
           let staleAutosave
        {
          let pendingWarning = await staleAutosave.flushPending()
          let coordinatorSnapshot = await staleAutosave.latestPersistedSnapshot
          guard generation == expectedGeneration, owner == expectedOwner else { return }

          // The first read can become stale while a pending turn is being flushed. Read again
          // before exposing any table so a sibling writer's newer snapshot always wins.
          result = try await store.loadSession(for: expectedOwner)
          guard generation == expectedGeneration, owner == expectedOwner else { return }
          if let refreshed = result.session,
             refreshed.gameID == replacingGameID,
             let localGame = game,
             let localSetup = setup
          {
            let localMatchesAuthority = refreshed.saveSequence == saveSequence
              && refreshed.state == localGame
              && refreshed.setup == localSetup
            if localMatchesAuthority {
              autosave = staleAutosave
              loadedSavedSequence = refreshed.saveSequence
              loadedSavedAtMilliseconds = refreshed.savedAtMilliseconds
              loadedSavedRound = refreshed.state.round
              hasDurableActiveSession = true
              autosaveWarning = pendingWarning
              finishRolledBackReplacementReconciliation(
                warning: pendingWarning
                  ?? result.warning
                  ?? (acknowledgementWasIndeterminate
                    ? interruptedRollbackWarning
                    : conflictWarning),
                acknowledgementWasIndeterminate: acknowledgementWasIndeterminate,
                pendingTurnsAreDurable: true
              )
              return
            }

            if refreshed.saveSequence < saveSequence {
              let isRecoverableUncommittedCompletion = localGame.phase == .gameOver
                && completionError != nil
                && refreshed.saveSequence == loadedSavedSequence
                && refreshed.setup == localSetup
              if isRecoverableUncommittedCompletion {
                autosave = staleAutosave
                loadedSavedSequence = refreshed.saveSequence
                loadedSavedAtMilliseconds = refreshed.savedAtMilliseconds
                loadedSavedRound = refreshed.state.round
                hasDurableActiveSession = true
                autosaveWarning = pendingWarning
                finishRolledBackReplacementReconciliation(
                  warning: pendingWarning
                    ?? result.warning
                    ?? interruptedRollbackWarning,
                  acknowledgementWasIndeterminate: acknowledgementWasIndeterminate,
                  pendingTurnsAreDurable: false
                )
                return
              }

              let coordinatorAcknowledgedLocal = coordinatorSnapshot?.saveSequence == saveSequence
                && coordinatorSnapshot?.state == localGame
                && coordinatorSnapshot?.setup == localSetup
              // A local state newer than the fresh store read is safe to retain only after its
              // exact snapshot is acknowledged. Any disagreement remains blocked for retry.
              if !coordinatorAcknowledgedLocal || pendingWarning != nil {
                requireSessionReconciliation(
                  pending,
                  autosave: staleAutosave,
                  autosaveWarning: pendingWarning
                )
                return
              }
              requireSessionReconciliation(
                pending,
                autosave: staleAutosave,
                autosaveWarning: SoloPersistenceWarning(
                  kind: .unavailable,
                  message: "Device storage returned inconsistent saved-game metadata. Reload it before continuing."
                )
              )
              return
            }

            // A higher sequence, or equal sequence with different content, is authoritative.
            await staleAutosave.cancel()
            guard generation == expectedGeneration, owner == expectedOwner else { return }
            autosave = nil
            install(refreshed)
            finishRestoredSessionReconciliation(
              resultWarning: result.warning,
              acknowledgementWasIndeterminate: acknowledgementWasIndeterminate,
              attemptedGameID: attemptedGameID,
              replacingGameID: replacingGameID
            )
            return
          }

          // The authoritative identity changed (or was removed) while pending turns were being
          // settled. Never fall back to the stale snapshot captured by the first read.
          await staleAutosave.cancel()
          guard generation == expectedGeneration, owner == expectedOwner else { return }
          autosave = nil
          if let refreshed = result.session {
            install(refreshed)
            finishRestoredSessionReconciliation(
              resultWarning: result.warning,
              acknowledgementWasIndeterminate: acknowledgementWasIndeterminate,
              attemptedGameID: attemptedGameID,
              replacingGameID: replacingGameID
            )
          } else {
            let preservedOutboxStatus = outboxStatus
            clearVisibleSession()
            outboxStatus = preservedOutboxStatus
            screen = .setup
            lastActionError = acknowledgementWasIndeterminate
              ? "Neither game remained after storage recovery. Review this setup and start again."
              : "The saved game was removed before replacement. No replacement was written; review this setup and start again."
            operationWarning = result.warning
              ?? (acknowledgementWasIndeterminate
                ? interruptedRollbackWarning
                : missingSessionConflictWarning)
          }
          return
        }
        await staleAutosave?.cancel()
        guard generation == expectedGeneration, owner == expectedOwner else { return }
        autosave = nil
        install(session)
        finishRestoredSessionReconciliation(
          resultWarning: result.warning,
          acknowledgementWasIndeterminate: acknowledgementWasIndeterminate,
          attemptedGameID: attemptedGameID,
          replacingGameID: replacingGameID
        )
      } else {
        await staleAutosave?.cancel()
        guard generation == expectedGeneration, owner == expectedOwner else { return }
        autosave = nil
        let preservedOutboxStatus = outboxStatus
        clearVisibleSession()
        outboxStatus = preservedOutboxStatus
        screen = .setup
        if acknowledgementWasIndeterminate {
          lastActionError = replacingGameID == nil
            ? "The game was not committed. Review this setup and start again."
            : "Neither game remained after storage recovery. Review this setup and start again."
          operationWarning = result.warning ?? interruptedRollbackWarning
        } else {
          lastActionError = "The saved game was removed before replacement. No replacement was written; review this setup and start again."
          operationWarning = result.warning ?? missingSessionConflictWarning
        }
      }
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      requireSessionReconciliation(pending, autosave: staleAutosave)
    }
    isReplacementReviewPresented = false
  }

  private func finishRolledBackReplacementReconciliation(
    warning: SoloPersistenceWarning,
    acknowledgementWasIndeterminate: Bool,
    pendingTurnsAreDurable: Bool
  ) {
    sessionReconciliationRequired = false
    pendingSessionReconciliation = nil
    screen = .launcher
    operationWarning = warning
    if acknowledgementWasIndeterminate {
      lastActionError = pendingTurnsAreDurable
        ? "The replacement was not committed. The previous game and its accepted turns were restored."
        : "The replacement was not committed. The previous game and its pending turns remain recoverable."
    } else {
      lastActionError = "The previous saved game remains authoritative and recoverable."
    }
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    isSettingsPresented = false
    isReplacementReviewPresented = false
  }

  private func finishRestoredSessionReconciliation(
    resultWarning: SoloPersistenceWarning?,
    acknowledgementWasIndeterminate: Bool,
    attemptedGameID: UUID,
    replacingGameID: UUID?
  ) {
    sessionReconciliationRequired = false
    pendingSessionReconciliation = nil
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    isSettingsPresented = false
    isReplacementReviewPresented = false
    if acknowledgementWasIndeterminate, gameID == attemptedGameID {
      screen = .table
      operationWarning = resultWarning ?? interruptedAcknowledgementWarning
      lastActionError = nil
      if let gameID {
        feedback.baseline(gameID: gameID, saveSequence: saveSequence)
      }
      scheduleAIIfNeeded()
    } else {
      screen = .launcher
      operationWarning = resultWarning ?? conflictWarning
      if acknowledgementWasIndeterminate {
        lastActionError = replacingGameID == nil
          ? "The attempted game was not authoritative. The existing saved game was restored."
          : "The replacement was not authoritative. The previous saved game was restored."
      }
    }
  }

  private func requireSessionReconciliation(
    _ pending: PendingSessionReconciliation,
    autosave staleAutosave: SoloAutosaveCoordinator?,
    autosaveWarning warning: SoloPersistenceWarning? = nil
  ) {
    autosave = staleAutosave
    pendingSessionReconciliation = pending
    sessionReconciliationRequired = true
    if let warning { self.autosaveWarning = warning }
    operationWarning = sessionReconciliationWarning
    lastActionError = "Skyjo could not verify which saved game is authoritative. Reload Saved Game before continuing."
    isReplacementReviewPresented = false
  }

  private func install(_ snapshot: SoloSessionSnapshot) {
    gameID = snapshot.gameID
    game = snapshot.state
    setup = snapshot.setup
    saveSequence = snapshot.saveSequence
    loadedSavedAtMilliseconds = snapshot.savedAtMilliseconds
    loadedSavedRound = snapshot.state.round
    loadedSavedSequence = snapshot.saveSequence
    hasDurableActiveSession = true
    sessionReconciliationRequired = false
    pendingSessionReconciliation = nil
    completionCommitted = false
    completionRequiresSavedGameReload = false
    completionReloadReason = nil
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

  private func restorePendingTerminalCompletion(_ pending: PendingTerminalCompletion) {
    guard pending.owner == owner else { return }
    gameID = pending.gameID
    game = pending.state
    setup = pending.setup
    saveSequence = pending.saveSequence
    completionCommitted = false
    completionRequiresSavedGameReload = false
    completionReloadReason = nil
    completionError = "The completed result is still recoverable on this device. Retry saving it before starting another game."
    lastActionError = nil
    isReplacementReviewPresented = false
    isSettingsPresented = false
    screen = .table
    isScoreSummaryPresented = true
    isScoreSummaryMinimized = false
    pauseAI()
  }

  private func clearPendingTerminalCompletion(_ pending: PendingTerminalCompletion) {
    guard pendingTerminalCompletions[pending.owner] == pending else { return }
    pendingTerminalCompletions[pending.owner] = nil
  }

  private func beginWorking() -> SoloWorkingOperation? {
    guard workingOperation == nil, !isWorking else { return nil }
    let operation = SoloWorkingOperation(
      id: UUID(),
      generation: generation,
      owner: owner
    )
    workingOperation = operation
    isWorking = true
    return operation
  }

  private func finishWorking(
    _ operation: SoloWorkingOperation,
    scheduleAI: Bool = false
  ) {
    guard workingOperation == operation,
          generation == operation.generation,
          owner == operation.owner
    else { return }
    workingOperation = nil
    isWorking = false
    if scheduleAI { scheduleAIIfNeeded() }
  }

  private func invalidateWorkingOperation() {
    workingOperation = nil
    isWorking = false
  }

  private func clearVisibleSession() {
    gameID = nil
    game = nil
    setup = nil
    saveSequence = 0
    loadedSavedAtMilliseconds = 0
    loadedSavedRound = 0
    loadedSavedSequence = 0
    hasDurableActiveSession = false
    sessionReconciliationRequired = false
    pendingSessionReconciliation = nil
    invalidateWorkingOperation()
    completionCommitted = false
    completionRequiresSavedGameReload = false
    completionReloadReason = nil
    completionError = nil
    lastActionError = nil
    isReplacementReviewPresented = false
    isScoreSummaryPresented = false
    isScoreSummaryMinimized = false
    isSettingsPresented = false
    drawChoice = .place
    outboxRecoveryMessage = nil
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
          screen == .table
    else { return }
    if next.phase == .roundOver {
      let canPresentSummary = sceneIsActive && !isSettingsPresented
      isScoreSummaryPresented = canPresentSummary
      isScoreSummaryMinimized = !canPresentSummary
      feedback.emit(.roundEnd, gameID: gameID, saveSequence: saveSequence)
      pauseAI()
    } else {
      guard !Task.isCancelled else { return }
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
    guard let gameID,
          let game,
          let setup,
          game.phase == .gameOver,
          let operation = beginWorking()
    else { return }
    defer { finishWorking(operation) }
    let expectedGeneration = operation.generation
    let expectedOwner = operation.owner
    let pendingCompletion = PendingTerminalCompletion(
      owner: expectedOwner,
      gameID: gameID,
      state: game,
      setup: setup,
      saveSequence: saveSequence
    )
    pendingTerminalCompletions[expectedOwner] = pendingCompletion
    let completionAutosave = autosave
    completionError = nil
    let flushWarning = await completionAutosave?.flushPending()
    guard generation == expectedGeneration, owner == expectedOwner else { return }
    autosaveWarning = flushWarning
    await completionCommitBarrier()
    guard generation == expectedGeneration, owner == expectedOwner else { return }
    do {
      try await store.completeSession(
        owner: expectedOwner,
        gameID: gameID,
        state: game,
        setup: setup,
        saveSequence: pendingCompletion.saveSequence
      )
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      await completionAutosave?.cancel()
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      autosave = nil
      hasDurableActiveSession = false
      completionRequiresSavedGameReload = false
      completionReloadReason = nil
      completionError = nil
      operationWarning = nil
      autosaveWarning = nil

      // The local transaction has already removed the active session and, for accounts, queued
      // the immutable result. Publish that durable queue state before releasing the score UI;
      // network delivery is opportunistic and must never block replay, setup, or minimization.
      await refreshCompletionOutboxStatus(
        expectedGeneration: expectedGeneration,
        expectedOwner: expectedOwner
      )
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      clearPendingTerminalCompletion(pendingCompletion)
      let expectedAuthorizationGeneration = statsAuthorizationGeneration
      let expectedConfirmedAccountID = confirmedAccountID
      completionCommitted = true
      scheduleCompletionStatsDelivery(
        expectedGeneration: expectedGeneration,
        expectedAuthorizationGeneration: expectedAuthorizationGeneration,
        expectedOwner: expectedOwner,
        expectedConfirmedAccountID: expectedConfirmedAccountID
      )
      return
    } catch let error as SoloPersistenceError {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      if error == .sessionConflict || error == .staleAutosave {
        clearPendingTerminalCompletion(pendingCompletion)
        await completionAutosave?.cancel()
        guard generation == expectedGeneration, owner == expectedOwner else { return }
        autosave = nil
        await recoverSavedGameAfterCompletionFailure(
          expectedGeneration: expectedGeneration,
          expectedOwner: expectedOwner,
          reason: .conflict
        )
        return
      }
      if error == .invalidSnapshot || error == .incompatibleRecord {
        clearPendingTerminalCompletion(pendingCompletion)
        await completionAutosave?.cancel()
        guard generation == expectedGeneration, owner == expectedOwner else { return }
        autosave = nil
        await recoverSavedGameAfterCompletionFailure(
          expectedGeneration: expectedGeneration,
          expectedOwner: expectedOwner,
          reason: .invalidResult
        )
        return
      }
      operationWarning = error.warning
      completionError = "The result is still recoverable on this device. Retry before starting another game."
      completionCommitted = false
      completionRequiresSavedGameReload = false
      completionReloadReason = nil
      // Preserve this coordinator: a failed flush deliberately retains its latest nonterminal
      // candidate so lifecycle or manual completion retry can durably recover every accepted turn.
      autosave = completionAutosave
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      operationWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "The completed game could not be committed to device storage."
      )
      completionError = "Retry before starting another game."
      completionCommitted = false
      completionRequiresSavedGameReload = false
      completionReloadReason = nil
      autosave = completionAutosave
    }
  }

  private func scheduleCompletionStatsDelivery(
    expectedGeneration: UInt64,
    expectedAuthorizationGeneration: UInt64,
    expectedOwner: SoloOwnerPartition,
    expectedConfirmedAccountID: UUID?
  ) {
    guard expectedConfirmedAccountID != nil,
          expectedConfirmedAccountID == expectedOwner.accountID
    else { return }
    Task { @MainActor [weak self] in
      guard let self,
            self.generation == expectedGeneration,
            self.statsAuthorizationGeneration == expectedAuthorizationGeneration,
            self.owner == expectedOwner,
            self.confirmedAccountID == expectedConfirmedAccountID
      else { return }
      _ = await self.statsOutbox.trigger(.completion)
      guard self.generation == expectedGeneration,
            self.statsAuthorizationGeneration == expectedAuthorizationGeneration,
            self.owner == expectedOwner,
            self.confirmedAccountID == expectedConfirmedAccountID
      else { return }
      await self.refreshOutboxStatus()
    }
  }

  private func refreshCompletionOutboxStatus(
    expectedGeneration: UInt64,
    expectedOwner: SoloOwnerPartition
  ) async {
    let status: StatsOutboxStatus
    let warning: SoloPersistenceWarning?
    if let accountID = expectedOwner.accountID {
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
    } else {
      status = emptyOutboxStatus
      warning = nil
    }
    await completionStatusReadBarrier()
    guard generation == expectedGeneration, owner == expectedOwner else { return }
    // Completion truth comes from owner-local durable storage, not mutable login authorization.
    outboxStatus = status
    outboxWarning = warning
  }

  private func recoverSavedGameAfterCompletionFailure(
    expectedGeneration: UInt64,
    expectedOwner: SoloOwnerPartition,
    reason: CompletionReloadReason
  ) async {
    do {
      let result = try await store.loadSession(for: expectedOwner)
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      isScoreSummaryPresented = false
      isScoreSummaryMinimized = false
      completionError = nil
      completionRequiresSavedGameReload = false
      completionReloadReason = nil
      if let session = result.session {
        install(session)
        screen = .launcher
        switch reason {
        case .conflict:
          operationWarning = result.warning ?? conflictWarning
          lastActionError = "The saved game changed elsewhere. The authoritative saved round was restored."
        case .invalidResult:
          operationWarning = result.warning ?? invalidCompletionWarning
          lastActionError = "The completed result failed validation. The last valid saved round was restored."
        }
      } else {
        let preservedOutboxStatus = outboxStatus
        clearVisibleSession()
        outboxStatus = preservedOutboxStatus
        screen = .setup
        switch reason {
        case .conflict:
          operationWarning = result.warning ?? missingSessionConflictWarning
          lastActionError = "The saved game changed or was removed. No stale completion was written."
        case .invalidResult:
          operationWarning = result.warning ?? invalidCompletionWarning
          lastActionError = "The completed result failed validation and no prior saved round remained. Start a new game when ready."
        }
      }
    } catch {
      guard generation == expectedGeneration, owner == expectedOwner else { return }
      completionReloadReason = reason
      completionRequiresSavedGameReload = true
      switch reason {
      case .conflict:
        operationWarning = conflictWarning
        completionError = "The saved game changed elsewhere, but it could not be reloaded yet. Try Reload Saved Game again."
      case .invalidResult:
        operationWarning = invalidCompletionWarning
        completionError = "The completed result could not be validated, and the last saved game could not be reloaded yet. Try Reload Saved Game again."
      }
      completionCommitted = false
    }
  }

  private func pauseAI() {
    aiTask?.cancel()
    aiTask = nil
  }

  private func scheduleAIIfNeeded() {
#if DEBUG
    if usesUITestState { return }
#endif
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
        try? await self.aiTurnDelay()
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
      let persistedSnapshot = await coordinator.latestPersistedSnapshot
      guard let self,
            self.generation == expectedGeneration,
            self.owner == expectedOwner,
            self.gameID == expectedGameID,
            self.autosave === coordinator
      else { return }
      self.autosaveWarning = warning
      if warning == nil,
         let persistedSnapshot,
         persistedSnapshot.saveSequence >= self.loadedSavedSequence
      {
        self.loadedSavedSequence = persistedSnapshot.saveSequence
        self.loadedSavedAtMilliseconds = persistedSnapshot.savedAtMilliseconds
        self.loadedSavedRound = persistedSnapshot.state.round
      }
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

  private var missingSessionConflictWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .conflict,
      message: "The saved game changed or was removed. No replacement was written, and this setup remains ready to start."
    )
  }

  private var invalidCompletionWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .unavailable,
      message: "The completed result failed local validation. The last valid saved game was left unchanged."
    )
  }

  private var interruptedAcknowledgementWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .recovered,
      message: "Device storage completed or rejected the change before its acknowledgement was interrupted. The authoritative saved game was reloaded."
    )
  }

  private var interruptedRollbackWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .recovered,
      message: "Device storage did not commit the attempted game. No existing saved game was changed."
    )
  }

  private var sessionReconciliationWarning: SoloPersistenceWarning {
    SoloPersistenceWarning(
      kind: .unavailable,
      message: "Skyjo cannot verify the authoritative saved game while device storage is unavailable. Reload it before continuing."
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
  func acceptForTesting(_ state: GameState) async {
    await accept(state, feedbackEvent: .place)
  }

  func setStatsAuthorizationForTesting(_ accountID: UUID?) async {
    statsAuthorizationGeneration &+= 1
    confirmedAccountID = accountID
    await statsOutbox.setConfirmedAccount(accountID)
  }

  @discardableResult
  func applyUITestState(arguments: [String]) async -> Bool {
    guard let stateArgument = arguments.first(where: { $0.hasPrefix("--ui-state=") }) else {
      return false
    }
    let value = String(stateArgument.dropFirst("--ui-state=".count))
    guard value.hasPrefix("solo-") else { return false }
    usesUITestState = true
    generation &+= 1
    statsAuthorizationGeneration &+= 1
    aiTask?.cancel()
    aiTask = nil
    let fixtureOpponentCount = value == "solo-table-one-bot" ? 1 : 3
    var random = SeededRandom(seed: 18_700)
    let fixtureGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000187")!
    var state = GameEngine.startFreshGame(
      aiOpponentCount: fixtureOpponentCount,
      random: &random
    )
    if value == "solo-table-one-bot",
       let aiIndex = state.players.firstIndex(where: { $0.kind == .ai })
    {
      state.players[aiIndex].grid[0].value = 12
      state.players[aiIndex].grid[0].faceUp = true
    }
    let fixtureSetup = try! SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: fixtureOpponentCount, difficulty: .mixed),
      state: state,
      gameId: fixtureGameID.uuidString.lowercased()
    )
    gameID = fixtureGameID
    game = state
    setup = fixtureSetup
    saveSequence = 4
    hasDurableActiveSession = true
    loadedSavedAtMilliseconds = 1_785_200_000_000
    loadedSavedRound = state.round
    loadedSavedSequence = saveSequence
    completionCommitted = false
    completionRequiresSavedGameReload = false
    completionReloadReason = nil
    sessionReconciliationRequired = false
    pendingSessionReconciliation = nil
    loadWarning = nil
    operationWarning = nil
    autosaveWarning = nil
    outboxWarning = nil
    outboxRecoveryMessage = nil
    switch value {
    case "solo-launcher", "solo-launcher-volatile":
      screen = .launcher
    case "solo-reconciliation":
      screen = .launcher
      pendingSessionReconciliation = PendingSessionReconciliation(
        owner: .guest,
        attemptedGameID: UUID(uuidString: "70000000-0000-4000-8000-000000000188")!,
        replacingGameID: fixtureGameID,
        acknowledgementWasIndeterminate: true
      )
      sessionReconciliationRequired = true
      operationWarning = sessionReconciliationWarning
      lastActionError = "Skyjo could not verify which saved game is authoritative. Reload Saved Game before continuing."
    case "solo-setup":
      clearVisibleSession()
      screen = .setup
    case "solo-setup-blocked-outbox":
      clearVisibleSession()
      let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
      owner = .account(accountID)
      confirmedAccountID = accountID
      guard await seedBlockedOutboxUITestFixture(
        accountID: accountID,
        gameID: fixtureGameID,
        kind: .terminal
      ) else { return false }
      screen = .setup
    case "solo-table", "solo-table-one-bot":
      screen = .table
    case "solo-turn":
      var turnState = GameEngine.revealOpeningCard(state, at: 0)
      turnState = GameEngine.revealOpeningCard(turnState, at: 1)
      turnState = GameEngine.drainSoloAIOpening(turnState)
      turnState.currentPlayerIndex = turnState.players.firstIndex(where: { $0.kind == .human }) ?? 0
      game = turnState
      screen = .table
    case "solo-ai-discard":
      var turnState = GameEngine.revealOpeningCard(state, at: 0)
      turnState = GameEngine.revealOpeningCard(turnState, at: 1)
      turnState = GameEngine.drainSoloAIOpening(turnState)
      guard let aiIndex = turnState.players.firstIndex(where: { $0.kind == .ai }) else {
        return false
      }
      turnState.currentPlayerIndex = aiIndex
      turnState.phase = .chooseSource
      turnState = GameEngine.chooseDiscard(turnState)
      guard turnState.phase == .chooseReplacement,
            turnState.selectedSource == .discard
      else { return false }
      game = turnState
      screen = .table
    case "solo-ai-private-draw":
      var turnState = GameEngine.revealOpeningCard(state, at: 0)
      turnState = GameEngine.revealOpeningCard(turnState, at: 1)
      turnState = GameEngine.drainSoloAIOpening(turnState)
      guard let aiIndex = turnState.players.firstIndex(where: { $0.kind == .ai }) else {
        return false
      }
      turnState.currentPlayerIndex = aiIndex
      turnState.phase = .chooseReplacement
      turnState.selectedSource = .draw
      turnState.drawnCard = Card(
        id: "private-ai-drawn-ui-sentinel",
        value: 99,
        faceUp: true
      )
      game = turnState
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
    case "solo-game-summary":
      var summaryState = state
      summaryState.phase = .gameOver
      summaryState.currentPlayerIndex = summaryState.players.lastIndex(where: { $0.kind == .ai }) ?? 0
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
      hasDurableActiveSession = false
      completionCommitted = true
      screen = .table
      isScoreSummaryPresented = true
    case "solo-game-summary-uncommitted":
      var summaryState = state
      summaryState.phase = .gameOver
      summaryState.currentPlayerIndex = summaryState.players.lastIndex(where: { $0.kind == .ai }) ?? 0
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
      completionCommitted = false
      completionError = "The result is still recoverable on this device. Retry before starting another game."
      screen = .table
      isScoreSummaryPresented = true
    case "solo-game-summary-outbox-unknown":
      var summaryState = state
      summaryState.phase = .gameOver
      summaryState.currentPlayerIndex = summaryState.players.lastIndex(where: { $0.kind == .ai }) ?? 0
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
      hasDurableActiveSession = false
      completionCommitted = true
      outboxWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "Saved stats are unavailable on this device right now."
      )
      screen = .table
      isScoreSummaryPresented = true
    case "solo-setup-corrupt-outbox":
      clearVisibleSession()
      let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
      owner = .account(accountID)
      confirmedAccountID = accountID
      guard await seedBlockedOutboxUITestFixture(
        accountID: accountID,
        gameID: fixtureGameID,
        kind: .corrupt
      ) else { return false }
      screen = .setup
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
    if let countArgument = arguments.first(where: { $0.hasPrefix("--ui-solo-opponents=") }),
       let count = Int(countArgument.dropFirst("--ui-solo-opponents=".count))
    {
      setupOpponentCount = GameEngine.normalizedSinglePlayerAIOpponentCount(count)
    }
    if let difficultyArgument = arguments.first(where: { $0.hasPrefix("--ui-solo-difficulty=") }),
       let difficulty = SoloAIDifficultySelection(
         rawValue: String(difficultyArgument.dropFirst("--ui-solo-difficulty=".count))
       )
    {
      setupDifficulty = difficulty
    }
    return true
  }

  private func seedBlockedOutboxUITestFixture(
    accountID: UUID,
    gameID: UUID,
    kind: StatsOutboxBlockedHeadKind
  ) async -> Bool {
    guard let terminalState = makeUITestTerminalState(),
          let terminalSetup = try? SoloAISetup.resolve(
            SoloGameSetup(aiOpponentCount: 1, difficulty: .hard),
            state: terminalState,
            gameId: gameID.uuidString.lowercased()
          )
    else {
      outboxWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "The recovery fixture could not be prepared."
      )
      return false
    }
    do {
      try await store.prepareBlockedOutboxForUITesting(
        accountID: accountID,
        gameID: gameID,
        state: terminalState,
        setup: terminalSetup,
        kind: kind,
        completedAtMilliseconds: 1_785_200_000_000
      )
    } catch {
      outboxWarning = SoloPersistenceWarning(
        kind: .unavailable,
        message: "The recovery fixture could not be prepared."
      )
      return false
    }

    await statsOutbox.setConfirmedAccount(accountID)
    await refreshOutboxStatus()
    guard outboxStatus.blockedHeadKind == kind,
          outboxStatus.blockedHeadRecoveryHandle != nil
    else { return false }
    outboxWarning = kind == .terminal
      ? SoloPersistenceWarning(
        kind: .statsNotSaved,
        message: "This completed game could not be saved to account stats. It remains on this device for recovery."
      )
      : SoloPersistenceWarning(
        kind: .statsNotSaved,
        message: "The oldest completed result is damaged. It remains on this device until you discard that item."
      )
    return true
  }

  private func makeUITestTerminalState() -> GameState? {
    var openingRandom = SeededRandom(seed: 18_703)
    var state = GameEngine.startFreshGame(aiOpponentCount: 1, random: &openingRandom)
    var turnRandom = SeededRandom(seed: 18_704)
    for _ in 0..<20 {
      for _ in 0..<1_000 where state.phase != .roundOver && state.phase != .gameOver {
        switch state.phase {
        case .openingReveal:
          guard state.players.indices.contains(state.currentPlayerIndex),
                let index = state.players[state.currentPlayerIndex].grid.firstIndex(where: {
                  !$0.faceUp && !$0.removed
                })
          else { return nil }
          state = GameEngine.revealOpeningCard(state, at: index)
        case .chooseSource:
          state = GameEngine.drawBlind(state, random: &turnRandom)
        case .chooseReplacement:
          guard state.players.indices.contains(state.currentPlayerIndex) else { return nil }
          if state.selectedSource == .draw,
             let hiddenIndex = state.players[state.currentPlayerIndex].grid.firstIndex(where: {
               !$0.faceUp && !$0.removed
             })
          {
            state = GameEngine.discardDrawnAndReveal(state, at: hiddenIndex)
          } else if let replaceIndex = state.players[state.currentPlayerIndex].grid.firstIndex(where: {
            !$0.removed
          }) {
            state = GameEngine.replaceCard(state, at: replaceIndex)
          } else {
            return nil
          }
        case .roundOver, .gameOver:
          break
        }
      }
      if state.phase == .gameOver { return state }
      guard state.phase == .roundOver else { return nil }
      state = GameEngine.startNextRound(state, random: &turnRandom)
    }
    return state.phase == .gameOver ? state : nil
  }
#endif
}
