import CryptoKit
import Foundation
import SkyjoDomain
import SkyjoPersistence
import SwiftData
import Testing

@testable import SkyjoNative

@Suite("Native solo feature model", .serialized)
@MainActor
struct SoloFeatureModelTests {
  @Test("Setup defaults to Medium and writes only after Start Game")
  func setupIsExplicitAndDurable() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }

    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    #expect(harness.model.screen == .setup)
    #expect(harness.model.setupOpponentCount == 1)
    #expect(harness.model.setupDifficulty == .medium)
    #expect(try await harness.store.loadSession(for: .guest).session == nil)

    harness.model.setupOpponentCount = 7
    harness.model.setupDifficulty = .mixed
    #expect(try await harness.store.loadSession(for: .guest).session == nil)

    await harness.model.reviewNewGame()
    #expect(harness.model.screen == .table)
    #expect(harness.model.hasDurableActiveSession)
    #expect(harness.model.setup?.aiOpponentCount == 7)
    #expect(harness.model.setup?.difficulty == .mixed)
    #expect(harness.model.setup?.playerDifficulties?.count == 7)
    #expect(try await harness.store.loadSession(for: .guest).session?.gameID == harness.model.gameID)
  }

  @Test("Continue and replacement preserve the old game until confirmation succeeds")
  func continueAndReplacementAreRecoverable() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalID = try #require(harness.model.gameID)

    let restored = harness.makeSiblingModel()
    await restored.switchOwner(.guest, confirmedAccountID: nil)
    #expect(restored.screen == .launcher)
    #expect(restored.savedGameSummary != nil)
    restored.continueSavedGame()
    #expect(restored.screen == .table)

    restored.showSetup()
    restored.setupOpponentCount = 3
    restored.setupDifficulty = .hard
    await restored.reviewNewGame()
    #expect(restored.isReplacementReviewPresented)
    #expect(restored.gameID == originalID)
    #expect(try await harness.store.loadSession(for: .guest).session?.gameID == originalID)

    await restored.confirmReplacement()
    let replacementID = try #require(restored.gameID)
    #expect(replacementID != originalID)
    #expect(!restored.isReplacementReviewPresented)
    #expect(restored.screen == .table)
    let durable = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(durable.gameID == replacementID)
    #expect(durable.setup.aiOpponentCount == 3)
    #expect(durable.setup.difficulty == .hard)
  }

  @Test("Owner switches never expose another partition or authorize hinted stats")
  func ownerPartitionsStayFenced() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!

    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let guestID = try #require(harness.model.gameID)

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: nil)
    #expect(harness.model.screen == .setup)
    #expect(harness.model.game == nil)
    #expect(harness.model.owner == .account(accountID))
    #expect(harness.model.confirmedAccountID == nil)
    await harness.model.reviewNewGame()
    let accountGameID = try #require(harness.model.gameID)
    #expect(accountGameID != guestID)

    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == guestID)
    #expect(try await harness.store.loadSession(for: .account(accountID)).session?.gameID == accountGameID)
  }

  @Test("Accepted human transitions advance the monotonic save sequence")
  func legalTransitionsAdvanceSaveSequence() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    harness.model.setSceneActive(false)
    let firstIndex = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )

    await harness.model.tapHumanCard(at: firstIndex)
    #expect(harness.model.saveSequence == 1)
    #expect(harness.model.humanPlayer?.grid[firstIndex].faceUp == true)

    let secondIndex = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: secondIndex)
    #expect(harness.model.saveSequence == 2)
    #expect(harness.model.game?.openingRevealCounts["human"] == 2)
  }

  @Test("Same-owner authorization changes preserve accepted gameplay and its autosave")
  func sameOwnerAuthorizationChangePreservesGame() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    await harness.model.reviewNewGame()
    harness.model.setSceneActive(false)
    let cardIndex = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: cardIndex)
    let acceptedGame = try #require(harness.model.game)
    let acceptedGameID = try #require(harness.model.gameID)
    let acceptedSequence = harness.model.saveSequence

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: nil)
    #expect(harness.model.owner == .account(accountID))
    #expect(harness.model.confirmedAccountID == nil)
    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID == acceptedGameID)
    #expect(harness.model.game == acceptedGame)
    #expect(harness.model.saveSequence == acceptedSequence)

    let durable = try #require(
      try await harness.store.loadSession(for: .account(accountID)).session
    )
    #expect(durable.gameID == acceptedGameID)
    #expect(durable.saveSequence == acceptedSequence)

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.screen == .table)
    #expect(harness.model.game == acceptedGame)
    #expect(harness.model.saveSequence == acceptedSequence)
  }

  @Test("Leaving the table cancels the current AI seat and every successor")
  func leavingTableStopsAI() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    for _ in 0..<2 {
      let cardIndex = try #require(
        harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
      )
      await harness.model.tapHumanCard(at: cardIndex)
    }
    #expect(harness.model.currentPlayer?.kind == .ai)
    harness.model.leaveTable()
    let gameAtExit = try #require(harness.model.game)
    let sequenceAtExit = harness.model.saveSequence

    try await Task.sleep(for: .milliseconds(900))
    #expect(harness.model.screen == .launcher)
    #expect(harness.model.game == gameAtExit)
    #expect(harness.model.saveSequence == sequenceAtExit)
  }

  @Test("A restored round-over save immediately exposes scores and advances durably")
  func restoredRoundOverCanAdvance() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000187")!
    let roundOver = try makeRoundOverState()
    let setup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 1, difficulty: .hard),
      state: roundOver,
      gameId: gameID.uuidString.lowercased()
    )
    _ = try await harness.store.startSession(
      owner: .guest,
      gameID: gameID,
      state: roundOver,
      setup: setup,
      saveSequence: 41,
      savedAtMilliseconds: 100
    )

    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    #expect(harness.model.screen == .launcher)
    harness.model.continueSavedGame()
    #expect(harness.model.screen == .table)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isScoreSummaryMinimized)

    await harness.model.startNextRound()
    #expect(harness.model.game?.phase == .openingReveal)
    #expect(harness.model.game?.round == roundOver.round + 1)
    #expect(!harness.model.isScoreSummaryPresented)
    #expect(harness.model.saveSequence == 42)
    #expect(
      await waitUntil {
        (try? await harness.store.loadSession(for: .guest).session)?.saveSequence == 42
      }
    )
  }

  @Test("A failed replacement remains reviewable and preserves the prior snapshot")
  func failedReplacementStaysRecoverable() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalID = try #require(harness.model.gameID)
    let original = try #require(try await harness.store.loadSession(for: .guest).session)

    let interruptedStore = SoloPersistenceStore(
      modelContainer: harness.container,
      environment: SoloPersistenceEnvironment(
        faults: .failing(
          at: .afterNewSessionInsert,
          with: CocoaError(.fileWriteOutOfSpace)
        )
      )
    )
    let interruptedOutbox = StatsOutboxCoordinator(store: interruptedStore) { _ in }
    defer { Task { await interruptedOutbox.dispose() } }
    let interrupted = SoloFeatureModel(
      store: interruptedStore,
      statsOutbox: interruptedOutbox,
      preferences: harness.preferences,
      feedback: harness.feedback
    )
    await interrupted.switchOwner(.guest, confirmedAccountID: nil)
    interrupted.showSetup()
    interrupted.setupOpponentCount = 3
    interrupted.setupDifficulty = .ultra
    await interrupted.reviewNewGame()
    #expect(interrupted.isReplacementReviewPresented)

    await interrupted.confirmReplacement()
    #expect(interrupted.isReplacementReviewPresented)
    #expect(interrupted.gameID == originalID)
    #expect(interrupted.lastActionError?.contains("previous game") == true)
    #expect(interrupted.persistenceWarning?.kind == .quota)
    let preserved = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(preserved.gameID == originalID)
    #expect(preserved.state == original.state)
    #expect(preserved.setup == original.setup)
  }

  @Test("A replacement conflict with no authoritative save retires the phantom session")
  func missingReplacementConflictReturnsToFreshSetup() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let removedID = try #require(harness.model.gameID)

    harness.model.showSetup()
    harness.model.setupOpponentCount = 3
    harness.model.setupDifficulty = .ultra
    await harness.model.reviewNewGame()
    #expect(harness.model.isReplacementReviewPresented)
    try await harness.store.deleteSession(owner: .guest, expectedGameID: removedID)

    await harness.model.confirmReplacement()
    #expect(harness.model.screen == .setup)
    #expect(harness.model.game == nil)
    #expect(harness.model.gameID == nil)
    #expect(!harness.model.hasDurableActiveSession)
    #expect(!harness.model.isReplacementReviewPresented)
    #expect(harness.model.lastActionError?.contains("removed before replacement") == true)

    await harness.model.reviewNewGame()
    #expect(harness.model.screen == .table)
    #expect(harness.model.hasDurableActiveSession)
    #expect(!harness.model.isReplacementReviewPresented)
    #expect(harness.model.gameID != removedID)
  }

  @Test("Cancellation after an accepted round end keeps scoring recoverable")
  func cancelledRoundEndStillPresentsScoring() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let roundOver = try makeRoundOverState()

    let cancelled = Task { @MainActor in
      withUnsafeCurrentTask { $0?.cancel() }
      await harness.model.acceptForTesting(roundOver)
    }
    await cancelled.value

    #expect(harness.model.game?.phase == .roundOver)
    #expect(harness.model.isScoreSummaryPresented || harness.model.isScoreSummaryMinimized)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(harness.model.tableStatus == "Round complete")
    #expect(harness.model.actionGuidance.hasPrefix("Round "))
    #expect(!harness.model.actionGuidance.contains("choosing"))
  }

  @Test("Play Again starts the same setup while Change Setup remains an explicit edit route")
  func completedGameRoutesAreDistinct() async throws {
    let changeHarness = try makeHarness()
    defer { changeHarness.dispose() }
    await changeHarness.model.switchOwner(.guest, confirmedAccountID: nil)
    changeHarness.model.setupOpponentCount = 1
    changeHarness.model.setupDifficulty = .ultra
    await changeHarness.model.reviewNewGame()
    await changeHarness.model.acceptForTesting(
      try makeTerminalState(from: #require(changeHarness.model.game))
    )
    #expect(changeHarness.model.completionCommitted)
    #expect(changeHarness.model.game?.phase == .gameOver)
    #expect(changeHarness.model.tableStatus == "Game complete")
    #expect(!changeHarness.model.actionGuidance.contains("turn"))

    changeHarness.model.changeSetup()
    #expect(changeHarness.model.screen == .setup)
    #expect(changeHarness.model.setupOpponentCount == 1)
    #expect(changeHarness.model.setupDifficulty == .ultra)
    #expect(changeHarness.model.game?.phase == .gameOver)

    let replayHarness = try makeHarness()
    defer { replayHarness.dispose() }
    await replayHarness.model.switchOwner(.guest, confirmedAccountID: nil)
    replayHarness.model.setupOpponentCount = 1
    replayHarness.model.setupDifficulty = .hard
    await replayHarness.model.reviewNewGame()
    let completedGameID = try #require(replayHarness.model.gameID)
    await replayHarness.model.acceptForTesting(
      try makeTerminalState(from: #require(replayHarness.model.game))
    )
    #expect(replayHarness.model.completionCommitted)

    await replayHarness.model.playAgain()
    #expect(replayHarness.model.screen == .table)
    #expect(replayHarness.model.game?.phase == .openingReveal)
    #expect(replayHarness.model.gameID != completedGameID)
    #expect(replayHarness.model.setup?.aiOpponentCount == 1)
    #expect(replayHarness.model.setup?.difficulty == .hard)
    #expect(replayHarness.model.hasDurableActiveSession)
    #expect(!replayHarness.model.isScoreSummaryPresented)
    #expect(!replayHarness.model.isScoreSummaryMinimized)
  }

  @Test("Blocked stats remain recoverable from setup when no active save exists")
  func blockedStatsRemainVisibleWithoutActiveSave() async throws {
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
    let harness = try SoloHarness { _ in
      throw StatsDeliveryError.permanent(.unsupportedVersion)
    }
    defer { harness.dispose() }
    let terminal = try makeTerminalState()
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000189")!
    let setup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 1, difficulty: .hard),
      state: terminal,
      gameId: gameID.uuidString.lowercased()
    )
    try await harness.store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: setup,
      saveSequence: 0,
      completedAtMilliseconds: 100
    )

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.screen == .setup)
    #expect(harness.model.game == nil)
    #expect(!harness.model.hasDurableActiveSession)
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    #expect(harness.model.outboxStatus.blockedHeadRecoveryHandle != nil)
    #expect(harness.model.statsDeliveryIsConfirmed)
  }

  @Test("Unconfirmed account rows stay local and become deliverable only after confirmation")
  func offlineAccountStatsAreTruthfulAndFenced() async throws {
    let delivery = StatsDeliveryCounter()
    let harness = try SoloHarness(deliver: { request in await delivery.record(request) })
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000188")!
    let terminal = try makeTerminalState()
    let setup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 1, difficulty: .hard),
      state: terminal,
      gameId: gameID.uuidString.lowercased()
    )
    try await harness.store.completeSession(
      owner: .account(accountID),
      gameID: gameID,
      state: terminal,
      setup: setup,
      saveSequence: 0,
      completedAtMilliseconds: 100
    )

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: nil)
    #expect(harness.model.outboxStatus.queued == 1)
    #expect(!harness.model.statsDeliveryIsConfirmed)
    #expect(harness.model.completedStatsMessage.contains("stored on this device"))
    #expect(harness.model.settingsStatsMessage.contains("sync after this account is confirmed"))
    #expect(await delivery.count == 0)
    #expect(try await harness.store.outboxStatus(accountID: accountID).queued == 1)

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.statsDeliveryIsConfirmed)
    #expect(await delivery.count == 1)
    #expect(harness.model.outboxStatus.queued == 0)
    #expect(try await harness.store.outboxStatus(accountID: accountID).queued == 0)
  }

  @Test("A later successful autosave clears only its resolved warning source")
  func successfulAutosaveClearsAutosaveWarning() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.isFailing {
            throw CocoaError(.fileWriteOutOfSpace)
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    faults.setFailing(true)
    var cardIndex = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: cardIndex)
    #expect(await waitUntil { harness.model.persistenceWarning?.kind == .quota })

    faults.setFailing(false)
    cardIndex = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: cardIndex)
    #expect(await waitUntil { harness.model.persistenceWarning == nil })
    #expect(
      await waitUntil {
        (try? await harness.store.loadSession(for: .guest).session)?.saveSequence == 2
      }
    )
  }

  @Test("Sound and haptics default on, music stays off, and user choices persist")
  func preferencesAreExplicitAndPersistent() throws {
    let suiteName = "skyjo.solo-preferences.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let initial = SoloPreferencesStore(defaults: defaults)
    #expect(initial.soundEffectsEnabled)
    #expect(initial.hapticsEnabled)
    #expect(!initial.musicEnabled)
    initial.soundEffectsEnabled = false
    initial.hapticsEnabled = false

    let restored = SoloPreferencesStore(defaults: defaults)
    #expect(!restored.soundEffectsEnabled)
    #expect(!restored.hapticsEnabled)
    #expect(!restored.musicEnabled)
  }

  @Test("Every fixed and Mixed profile has distinct player-facing guidance")
  func difficultyGuidanceIsComplete() {
    let expectedNames = ["Easy", "Medium", "Hard", "Ultra Hard", "Mixed"]
    #expect(SoloAIDifficultySelection.allCases.map(\.displayName) == expectedNames)
    #expect(Set(SoloAIDifficultySelection.allCases.map(\.explanation)).count == expectedNames.count)
    for difficulty in SoloAIDifficultySelection.allCases {
      #expect(!difficulty.explanation.isEmpty)
      #expect(!difficulty.systemImage.isEmpty)
    }
    #expect(SoloAIDifficultySelection.medium.explanation.contains("default"))
    #expect(SoloAIDifficultySelection.mixed.explanation.contains("Deterministically"))
  }

  @Test("Approved CC0 cues are present and pinned in the native app bundle")
  func nativeAudioResourcesArePinned() throws {
    let expected = [
      "card-flip": (24_004, "dc9c08e4b172d404ce2f1ba8380d552fdd1d302419e2872f067f0d761147df90"),
      "card-pickup": (4_225, "5d6b866eb280804f86aae1d5d795da1a2260075a5c18b11472b84b33d31f68de"),
      "card-place": (3_702, "37f3fb1cd7a08f741eb7431de2cde4ad5eef129aa18496d379221461926373b8"),
    ]
    for (name, artifact) in expected {
      let url = try #require(Bundle.main.url(forResource: name, withExtension: "mp3"))
      let data = try Data(contentsOf: url)
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      #expect(data.count == artifact.0)
      #expect(digest == artifact.1)
    }
  }

  private func makeHarness() throws -> SoloHarness {
    try SoloHarness()
  }

  private func makeRoundOverState() throws -> GameState {
    for seed in UInt32(18_701)...UInt32(18_800) {
      var random = SeededRandom(seed: seed)
      var state = GameEngine.startFreshGame(aiOpponentCount: 1, random: &random)
      for _ in 0..<1_000 where state.phase != .roundOver && state.phase != .gameOver {
        state = advance(state, random: &random)
      }
      if state.phase == .roundOver { return state }
    }
    Issue.record("Deterministic transcript did not produce a round-over snapshot")
    var fallbackRandom = SeededRandom(seed: 18_701)
    return GameEngine.startFreshGame(aiOpponentCount: 1, random: &fallbackRandom)
  }

  private func makeTerminalState() throws -> GameState {
    var random = SeededRandom(seed: 18_702)
    return try makeTerminalState(
      from: GameEngine.startFreshGame(aiOpponentCount: 1, random: &random)
    )
  }

  private func makeTerminalState(from initial: GameState) throws -> GameState {
    var random = SeededRandom(seed: 18_702)
    var state = initial
    for _ in 0..<20 {
      for _ in 0..<1_000 where state.phase != .roundOver && state.phase != .gameOver {
        state = advance(state, random: &random)
      }
      if state.phase == .gameOver { return state }
      try #require(state.phase == .roundOver)
      state = GameEngine.startNextRound(state, random: &random)
    }
    try #require(state.phase == .gameOver)
    return state
  }

  private func advance<R: SkyjoRandomNumberGenerator>(
    _ source: GameState,
    random: inout R
  ) -> GameState {
    switch source.phase {
    case .openingReveal:
      guard source.players.indices.contains(source.currentPlayerIndex),
            let index = source.players[source.currentPlayerIndex].grid.firstIndex(where: {
              !$0.faceUp && !$0.removed
            })
      else { return source }
      return GameEngine.revealOpeningCard(source, at: index)
    case .chooseSource:
      return GameEngine.drawBlind(source, random: &random)
    case .chooseReplacement:
      guard source.players.indices.contains(source.currentPlayerIndex) else { return source }
      if source.selectedSource == .draw,
         let hiddenIndex = source.players[source.currentPlayerIndex].grid.firstIndex(where: {
           !$0.faceUp && !$0.removed
         })
      {
        return GameEngine.discardDrawnAndReveal(source, at: hiddenIndex)
      }
      guard let replaceIndex = source.players[source.currentPlayerIndex].grid.firstIndex(where: {
        !$0.removed
      }) else { return source }
      return GameEngine.replaceCard(source, at: replaceIndex)
    case .roundOver, .gameOver:
      return source
    }
  }

  private func waitUntil(
    timeout: Duration = .seconds(2),
    condition: @escaping @MainActor () async -> Bool
  ) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if await condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return await condition()
  }
}

@MainActor
private final class SoloHarness {
  let container: ModelContainer
  let store: SoloPersistenceStore
  let outbox: StatsOutboxCoordinator
  let preferences: SoloPreferencesStore
  let feedback: GameFeedbackController
  let model: SoloFeatureModel
  private let suiteName: String
  private let defaults: UserDefaults

  init(
    persistenceEnvironment: SoloPersistenceEnvironment = SoloPersistenceEnvironment(),
    deliver: @escaping StatsOutboxDelivery = { _ in }
  ) throws {
    container = try SkyjoPersistenceContainer.makeInMemory()
    store = SoloPersistenceStore(
      modelContainer: container,
      environment: persistenceEnvironment
    )
    outbox = StatsOutboxCoordinator(store: store, deliver: deliver)
    suiteName = "skyjo.solo-model.\(UUID().uuidString)"
    defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    preferences = SoloPreferencesStore(defaults: defaults)
    preferences.soundEffectsEnabled = false
    preferences.hapticsEnabled = false
    feedback = GameFeedbackController(preferences: preferences)
    model = SoloFeatureModel(
      store: store,
      statsOutbox: outbox,
      preferences: preferences,
      feedback: feedback
    )
  }

  func makeSiblingModel() -> SoloFeatureModel {
    SoloFeatureModel(
      store: store,
      statsOutbox: outbox,
      preferences: preferences,
      feedback: feedback
    )
  }

  func dispose() {
    defaults.removePersistentDomain(forName: suiteName)
    Task { await outbox.dispose() }
  }
}

private actor StatsDeliveryCounter {
  private(set) var count = 0

  func record(_ request: StatsSubmissionRequest) {
    _ = request
    count += 1
  }
}

private final class MutablePersistenceFault: @unchecked Sendable {
  private let lock = NSLock()
  private var failing = false

  var isFailing: Bool {
    lock.lock()
    defer { lock.unlock() }
    return failing
  }

  func setFailing(_ value: Bool) {
    lock.lock()
    failing = value
    lock.unlock()
  }
}
