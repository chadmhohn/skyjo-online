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
  @Test("Compact table geometry requires landscape and enough horizontal room")
  func tableLayoutSelectionRejectsShortPortraits() {
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 375, height: 550),
        usesAccessibilityText: false
      ) == .standard
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 390, height: 620),
        usesAccessibilityText: false
      ) == .standard
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 640, height: 360),
        usesAccessibilityText: false
      ) == .compactLandscape
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 667, height: 375),
        usesAccessibilityText: false
      ) == .compactLandscape
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 667, height: 375),
        usesAccessibilityText: true
      ) == .accessibilityLandscape
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 844, height: 390),
        usesAccessibilityText: true
      ) == .accessibilityLandscape
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 1366, height: 1024),
        usesAccessibilityText: true
      ) == .accessibility
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 390, height: 667),
        usesAccessibilityText: true
      ) == .accessibility
    )
    #expect(
      SoloTableLayoutMode.resolve(
        size: CGSize(width: 600, height: 320),
        usesAccessibilityText: false
      ) == .standard
    )
  }

  @Test("Human actions cannot cancel an AI-owned discard selection")
  func aiDiscardSelectionRejectsHumanActions() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    harness.model.setSceneActive(false)

    var state = try #require(harness.model.game)
    state = GameEngine.revealOpeningCard(state, at: 0)
    state = GameEngine.revealOpeningCard(state, at: 1)
    state = GameEngine.drainSoloAIOpening(state)
    state.currentPlayerIndex = try #require(state.players.firstIndex(where: { $0.kind == .ai }))
    state.phase = .chooseSource
    state = GameEngine.chooseDiscard(state)
    try #require(state.phase == .chooseReplacement)
    try #require(state.selectedSource == .discard)
    await harness.model.acceptForTesting(state)

    let before = try #require(harness.model.game)
    #expect(!harness.model.isHumanTurn)
    await harness.model.performHuman(.cancelDiscard)
    #expect(harness.model.game == before)
  }

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

  @Test("Interrupted start acknowledgement reloads the committed authoritative game")
  func interruptedStartAcknowledgementReconcilesCommittedGame() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .afterCommitAcknowledgement, faults.isFailing {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)

    faults.setFailing(true)
    await harness.model.reviewNewGame()

    let authoritative = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID == authoritative.gameID)
    #expect(harness.model.game == authoritative.state)
    #expect(harness.model.hasDurableActiveSession)
    #expect(harness.model.persistenceWarning?.kind == .recovered)
    #expect(harness.model.lastActionError == nil)
  }

  @Test("Interrupted Play Again acknowledgement dismisses the old score summary")
  func interruptedPlayAgainAcknowledgementStartsCleanTable() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .afterCommitAcknowledgement, faults.isFailing {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let completedGameID = try #require(harness.model.gameID)
    await harness.model.acceptForTesting(try makeTerminalState(from: #require(harness.model.game)))
    #expect(harness.model.completionCommitted)
    #expect(harness.model.isScoreSummaryPresented)

    faults.setFailing(true)
    await harness.model.playAgain()

    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID != completedGameID)
    #expect(harness.model.game?.phase == .openingReveal)
    #expect(!harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isScoreSummaryMinimized)
    #expect(!harness.model.isSettingsPresented)
    #expect(harness.model.lastActionError == nil)
  }

  @Test("Interrupted replacement acknowledgement reloads the committed replacement")
  func interruptedReplacementAcknowledgementReconcilesCommittedGame() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .afterCommitAcknowledgement, faults.isFailing {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalGameID = try #require(harness.model.gameID)

    harness.model.showSetup()
    harness.model.setupOpponentCount = 3
    harness.model.setupDifficulty = .hard
    await harness.model.reviewNewGame()
    #expect(harness.model.isReplacementReviewPresented)

    faults.setFailing(true)
    await harness.model.confirmReplacement()

    let authoritative = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(authoritative.gameID != originalGameID)
    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID == authoritative.gameID)
    #expect(harness.model.game == authoritative.state)
    #expect(harness.model.setup?.aiOpponentCount == 3)
    #expect(!harness.model.isReplacementReviewPresented)
    #expect(harness.model.persistenceWarning?.kind == .recovered)
    #expect(harness.model.lastActionError == nil)
  }

  @Test("Interrupted replacement blocks stale play until authoritative reload succeeds")
  func interruptedReplacementReadFailureCanBeRetried() async throws {
    let acknowledgementFault = MutablePersistenceFault()
    let readFault = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .afterCommitAcknowledgement, acknowledgementFault.isFailing {
            throw SoloPersistenceError.writeInterrupted
          }
          if checkpoint == .beforeSessionRead, readFault.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let staleGameID = try #require(harness.model.gameID)

    harness.model.showSetup()
    harness.model.setupOpponentCount = 3
    await harness.model.reviewNewGame()
    acknowledgementFault.setFailing(true)
    readFault.setFailing(true)
    await harness.model.confirmReplacement()

    #expect(harness.model.sessionReconciliationRequired)
    #expect(harness.model.gameID == staleGameID)
    #expect(!harness.model.isReplacementReviewPresented)
    #expect(harness.model.lastActionError?.contains("Reload Saved Game") == true)
    harness.model.continueSavedGame()
    #expect(harness.model.screen == .setup)

    acknowledgementFault.setFailing(false)
    readFault.setFailing(false)
    await harness.model.retrySessionReconciliation()

    let authoritative = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(authoritative.gameID != staleGameID)
    #expect(!harness.model.sessionReconciliationRequired)
    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID == authoritative.gameID)
    #expect(harness.model.game == authoritative.state)
  }

  @Test("Rolled-back replacement preserves and flushes pending turns from the prior game")
  func rolledBackReplacementPreservesPendingPriorTurns() async throws {
    let faults = CountingPersistenceFault()
    let timestamps = IncreasingMilliseconds(startingAt: 18_700)
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        nowMilliseconds: { timestamps.next() },
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalGameID = try #require(harness.model.gameID)
    let originalSummary = try #require(harness.model.savedGameSummary)

    faults.arm(2)
    let firstCard = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: firstCard)
    #expect(await waitUntil { harness.model.persistenceWarning != nil })
    let pendingState = try #require(harness.model.game)

    harness.model.showSetup()
    harness.model.setupOpponentCount = 3
    await harness.model.reviewNewGame()
    await harness.model.confirmReplacement()

    let authoritative = try #require(try await harness.store.loadSession(for: .guest).session)
    #expect(authoritative.gameID == originalGameID)
    #expect(authoritative.saveSequence == 1)
    #expect(authoritative.state == pendingState)
    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == originalGameID)
    #expect(harness.model.game == pendingState)
    let reconciledSummary = try #require(harness.model.savedGameSummary)
    #expect(reconciledSummary.savedAtMilliseconds == authoritative.savedAtMilliseconds)
    #expect(reconciledSummary.savedAtMilliseconds > originalSummary.savedAtMilliseconds)
    #expect(!harness.model.sessionReconciliationRequired)
    #expect(harness.model.lastActionError?.contains("accepted turns were restored") == true)
  }

  @Test("A newer sibling snapshot for the same game wins replacement reconciliation")
  func newerSiblingSameGameSnapshotWinsReplacementReconciliation() async throws {
    let faults = CountingPersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalGameID = try #require(harness.model.gameID)
    let originalState = try #require(harness.model.game)
    let originalSetup = try #require(harness.model.setup)
    let firstCard = try #require(
      originalState.players.first?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    let siblingState = GameEngine.revealOpeningCard(originalState, at: firstCard)
    _ = try await harness.store.autosave(
      owner: .guest,
      gameID: originalGameID,
      state: siblingState,
      setup: originalSetup,
      saveSequence: 1,
      savedAtMilliseconds: 18_799
    )

    harness.model.showSetup()
    harness.model.setupOpponentCount = 3
    await harness.model.reviewNewGame()
    faults.arm(1)
    await harness.model.confirmReplacement()

    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == originalGameID)
    #expect(harness.model.game == siblingState)
    #expect(harness.model.saveSequence == 1)
    #expect(harness.model.setup == originalSetup)
    #expect(!harness.model.sessionReconciliationRequired)
  }

  @Test("Session conflict blocks stale play until authoritative reload succeeds")
  func sessionConflictReadFailureCanBeRetried() async throws {
    let readFault = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeSessionRead, readFault.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let staleGameID = try #require(harness.model.gameID)
    try await harness.store.deleteSession(owner: .guest, expectedGameID: staleGameID)

    let authoritativeGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000199")!
    var random = SeededRandom(seed: 18_799)
    let authoritativeState = GameEngine.startFreshGame(aiOpponentCount: 2, random: &random)
    let authoritativeSetup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 2, difficulty: .hard),
      state: authoritativeState,
      gameId: authoritativeGameID.uuidString.lowercased()
    )
    _ = try await harness.store.startSession(
      owner: .guest,
      gameID: authoritativeGameID,
      state: authoritativeState,
      setup: authoritativeSetup
    )

    harness.model.showSetup()
    await harness.model.reviewNewGame()
    readFault.setFailing(true)
    await harness.model.confirmReplacement()

    #expect(harness.model.sessionReconciliationRequired)
    #expect(harness.model.gameID == staleGameID)
    #expect(harness.model.lastActionError?.contains("Reload Saved Game") == true)

    readFault.setFailing(false)
    await harness.model.retrySessionReconciliation()

    #expect(!harness.model.sessionReconciliationRequired)
    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == authoritativeGameID)
    #expect(harness.model.game == authoritativeState)
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

  @Test("Reduce Motion bypasses the AI pacing delay")
  func reduceMotionBypassesAIPacingDelay() async throws {
    let delay = AIPacingDelayProbe()
    let harness = try SoloHarness(
      aiTurnDelay: {
        try await delay.suspend()
      }
    )
    defer {
      harness.model.leaveTable()
      harness.dispose()
    }

    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    let aiID = try #require(
      harness.model.game?.players.first(where: { $0.kind == .ai })?.id
    )
    for _ in 0..<2 {
      let cardIndex = try #require(
        harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
      )
      await harness.model.tapHumanCard(at: cardIndex)
    }

    try #require(await waitUntil { await delay.invocationCount == 1 })
    #expect((harness.model.game?.openingRevealCounts[aiID] ?? 0) == 0)

    harness.model.setReduceMotion(true)

    try #require(
      await waitUntil {
        (harness.model.game?.openingRevealCounts[aiID] ?? 0) > 0
      }
    )
    #expect(await delay.invocationCount == 1)
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
    let harness = try SoloHarness(deliver: { _ in
      throw StatsDeliveryError.permanent(.unsupportedVersion)
    })
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
    #expect(harness.model.completedStatsMessage.contains("needs attention"))
    #expect(harness.model.settingsStatsMessage.contains("needs recovery"))
    #expect(harness.model.statsDeliverySystemImage == "exclamationmark.triangle.fill")
  }

  @Test("A completion conflict restores the authoritative saved game instead of trapping scores")
  func completionConflictRestoresAuthoritativeSession() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let staleGameID = try #require(harness.model.gameID)
    let staleTerminal = try makeTerminalState(from: #require(harness.model.game))

    try await harness.store.deleteSession(owner: .guest, expectedGameID: staleGameID)
    let authoritativeGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000196")!
    var random = SeededRandom(seed: 18_796)
    let authoritativeState = GameEngine.startFreshGame(aiOpponentCount: 2, random: &random)
    let authoritativeSetup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 2, difficulty: .hard),
      state: authoritativeState,
      gameId: authoritativeGameID.uuidString.lowercased()
    )
    _ = try await harness.store.startSession(
      owner: .guest,
      gameID: authoritativeGameID,
      state: authoritativeState,
      setup: authoritativeSetup,
      savedAtMilliseconds: 200
    )

    await harness.model.acceptForTesting(staleTerminal)

    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == authoritativeGameID)
    #expect(harness.model.game == authoritativeState)
    #expect(!harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isScoreSummaryMinimized)
    #expect(harness.model.completionError == nil)
    #expect(harness.model.persistenceWarning?.kind == .conflict)
  }

  @Test("A completion conflict whose reload fails exposes a retry that restores the saved game")
  func completionConflictReloadCanBeRetried() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeSessionRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let staleGameID = try #require(harness.model.gameID)
    let staleTerminal = try makeTerminalState(from: #require(harness.model.game))

    try await harness.store.deleteSession(owner: .guest, expectedGameID: staleGameID)
    let authoritativeGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000198")!
    var random = SeededRandom(seed: 18_798)
    let authoritativeState = GameEngine.startFreshGame(aiOpponentCount: 2, random: &random)
    let authoritativeSetup = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 2, difficulty: .hard),
      state: authoritativeState,
      gameId: authoritativeGameID.uuidString.lowercased()
    )
    _ = try await harness.store.startSession(
      owner: .guest,
      gameID: authoritativeGameID,
      state: authoritativeState,
      setup: authoritativeSetup,
      savedAtMilliseconds: 200
    )

    faults.setFailing(true)
    await harness.model.acceptForTesting(staleTerminal)

    #expect(harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError?.contains("Reload Saved Game") == true)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(!harness.model.completionCommitted)
    #expect(!harness.model.isWorking)

    harness.model.leaveTable()
    harness.model.continueSavedGame()
    #expect(harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError?.contains("Reload Saved Game") == true)

    await harness.model.reloadSavedGameAfterCompletionFailure()
    #expect(harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError?.contains("Reload Saved Game") == true)
    #expect(!harness.model.isWorking)

    faults.setFailing(false)
    await harness.model.reloadSavedGameAfterCompletionFailure()

    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == authoritativeGameID)
    #expect(harness.model.game == authoritativeState)
    #expect(!harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError == nil)
    #expect(!harness.model.isWorking)
  }

  @Test("An invalid completion whose reload fails remains recoverable")
  func invalidCompletionReloadCanBeRetried() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeSessionRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let savedGameID = try #require(harness.model.gameID)
    let savedState = try #require(harness.model.game)
    var invalidTerminal = try makeTerminalState(from: savedState)
    invalidTerminal.currentPlayerIndex = invalidTerminal.players.count

    faults.setFailing(true)
    await harness.model.acceptForTesting(invalidTerminal)

    #expect(harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError?.contains("Reload Saved Game") == true)
    #expect(!harness.model.completionCommitted)
    #expect(!harness.model.isWorking)

    faults.setFailing(false)
    await harness.model.reloadSavedGameAfterCompletionFailure()

    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == savedGameID)
    #expect(harness.model.game == savedState)
    #expect(!harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError == nil)
    #expect(!harness.model.isWorking)
  }

  @Test("An invalid terminal result restores the last valid saved round instead of retrying forever")
  func invalidCompletionRestoresLastValidSession() async throws {
    let harness = try makeHarness()
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let savedGameID = try #require(harness.model.gameID)
    let savedState = try #require(harness.model.game)
    var invalidTerminal = try makeTerminalState(from: savedState)
    invalidTerminal.currentPlayerIndex = invalidTerminal.players.count

    await harness.model.acceptForTesting(invalidTerminal)

    #expect(harness.model.screen == .launcher)
    #expect(harness.model.gameID == savedGameID)
    #expect(harness.model.game == savedState)
    #expect(harness.model.game?.phase != .gameOver)
    #expect(!harness.model.isScoreSummaryPresented)
    #expect(!harness.model.completionRequiresSavedGameReload)
    #expect(harness.model.completionError == nil)
    #expect(harness.model.persistenceWarning?.kind == .unavailable)
    #expect(harness.model.lastActionError?.contains("failed validation") == true)
  }

  @Test("Account confirmation racing completion cannot strand the new outbox row")
  func confirmationCompletionRaceRetriggersDelivery() async throws {
    let gate = CompletionCommitGate()
    let delivery = StatsDeliveryCounter()
    let harness = try SoloHarness(
      completionCommitBarrier: { await gate.wait() },
      deliver: { request in await delivery.record(request) }
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000197")!
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let terminal = try makeTerminalState(from: #require(harness.model.game))

    let completion = Task { @MainActor in
      await harness.model.acceptForTesting(terminal)
    }
    await gate.waitUntilEntered()
    #expect(await delivery.count == 0)

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(await delivery.count == 0)
    await gate.release()
    await completion.value

    #expect(harness.model.completionCommitted)
    #expect(await waitUntil { await delivery.count == 1 })
    #expect(await waitUntil { harness.model.outboxStatus.queued == 0 })
    #expect(try await harness.store.outboxStatus(accountID: accountID).queued == 0)
  }

  @Test("Local completion releases score actions while account delivery remains queued")
  func completionDeliveryDoesNotBlockScoreActions() async throws {
    let delivery = StatsDeliveryGate()
    let harness = try SoloHarness(deliver: { request in await delivery.deliver(request) })
    defer {
      Task { await delivery.release() }
      harness.dispose()
    }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000188")!
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    await harness.model.reviewNewGame()
    let completedGameID = try #require(harness.model.gameID)
    let terminal = try makeTerminalState(from: #require(harness.model.game))

    await harness.model.acceptForTesting(terminal)
    await delivery.waitUntilEntered()

    #expect(harness.model.completionCommitted)
    #expect(!harness.model.isWorking)
    #expect(harness.model.outboxStatus.queued == 1)
    #expect(harness.model.completedStatsMessage.contains("queued"))
    #expect(!harness.model.completedStatsMessage.contains("saved to your account stats"))

    harness.model.setScoreSummaryPresented(false)
    #expect(harness.model.isScoreSummaryMinimized)
    await harness.model.playAgain()
    #expect(harness.model.screen == .table)
    #expect(harness.model.gameID != completedGameID)
    #expect(harness.model.game?.phase == .openingReveal)

    await delivery.release()
    #expect(
      await waitUntil {
        (try? await harness.store.outboxStatus(accountID: accountID).queued) == 0
      }
    )
  }

  @Test("Authorization changing during completion status read cannot publish false delivery")
  func completionStatusReadIsIndependentOfAuthorizationRace() async throws {
    let statusGate = CompletionCommitGate()
    let delivery = StatsDeliveryGate()
    let harness = try SoloHarness(
      completionStatusReadBarrier: { await statusGate.wait() },
      deliver: { request in await delivery.deliver(request) }
    )
    defer {
      Task {
        await statusGate.release()
        await delivery.release()
      }
      harness.dispose()
    }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000189")!
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let terminal = try makeTerminalState(from: #require(harness.model.game))

    let completion = Task { @MainActor in
      await harness.model.acceptForTesting(terminal)
    }
    await statusGate.waitUntilEntered()
    await harness.model.setStatsAuthorizationForTesting(accountID)
    #expect(harness.model.outboxStatus.queued == 0)
    await statusGate.release()
    await completion.value
    await delivery.waitUntilEntered()

    #expect(harness.model.completionCommitted)
    #expect(!harness.model.isWorking)
    #expect(harness.model.outboxStatus.queued == 1)
    #expect(harness.model.completedStatsMessage.contains("queued"))
    #expect(!harness.model.completedStatsMessage.contains("saved to your account stats"))

    await delivery.release()
    #expect(
      await waitUntil {
        (try? await harness.store.outboxStatus(accountID: accountID).queued) == 0
      }
    )
  }

  @Test("Unknown outbox status never reports a confirmed account result as saved")
  func unknownOutboxStatusIsTruthful() async throws {
    let faults = MutablePersistenceFault()
    let delivery = MutableStatsDelivery(mode: .permanentFailure)
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeOutboxRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      ),
      deliver: { request in try await delivery.deliver(request) }
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000192")!
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000192")!
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

    faults.setFailing(true)
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.outboxStatus.queued == 0)
    #expect(harness.model.persistenceWarning?.kind == .unavailable)
    #expect(harness.model.completedStatsMessage.contains("status is unavailable"))
    #expect(!harness.model.completedStatsMessage.contains("saved to your account stats"))
    #expect(harness.model.settingsStatsMessage.contains("status is unavailable"))
    #expect(harness.model.statsDeliverySystemImage == "exclamationmark.triangle.fill")

    faults.setFailing(false)
    await harness.model.refreshOutboxStatus()
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    #expect(harness.model.completedStatsMessage.contains("needs attention"))

    await delivery.setMode(.success)
    await harness.model.retryBlockedStats()
    #expect(harness.model.outboxStatus.queued == 0)
    #expect(harness.model.outboxStatus.blockedHeadKind == nil)
    #expect(harness.model.outboxStatus.blockedHeadRecoveryHandle == nil)
    #expect(harness.model.persistenceWarning == nil)
    #expect(harness.model.statsDeliverySystemImage == "checkmark.circle.fill")
    #expect(harness.model.completedStatsMessage.contains("saved to your account stats"))
  }

  @Test("Terminal stats retry reports the transition only until a later accepted refresh")
  func blockedStatsRetryIsActionable() async throws {
    let faults = MutablePersistenceFault()
    let delivery = MutableStatsDelivery(mode: .permanentFailure)
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeOutboxRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      ),
      deliver: { request in try await delivery.deliver(request) }
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000190")!
    let terminal = try makeTerminalState()
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000190")!
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
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    #expect(harness.model.outboxStatus.blockedHeadRecoveryHandle != nil)

    await delivery.setMode(.success)
    await harness.model.retryBlockedStats()

    #expect(harness.model.outboxStatus.queued == 0)
    #expect(harness.model.outboxStatus.blockedHeadKind == nil)
    #expect(harness.model.outboxRecoveryMessage == "The oldest result was retried and delivered.")

    faults.setFailing(true)
    await harness.model.refreshOutboxStatus()
    #expect(harness.model.outboxRecoveryMessage == nil)
    #expect(harness.model.persistenceWarning?.kind == .unavailable)
    #expect(harness.model.completedStatsMessage.contains("status is unavailable"))
  }

  @Test("A successful retry never reports delivery when its refreshed status is unknown")
  func retrySuccessCopyRequiresKnownStatus() async throws {
    let faults = MutablePersistenceFault()
    let delivery = MutableStatsDelivery(mode: .permanentFailure)
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeOutboxRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      ),
      deliver: { request in try await delivery.deliver(request) }
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000198")!
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000198")!
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
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)

    await delivery.setMode(.success)
    faults.setFailing(true)
    await harness.model.retryBlockedStats()
    #expect(harness.model.outboxRecoveryMessage == nil)
    #expect(harness.model.persistenceWarning?.kind == .unavailable)
    #expect(harness.model.completedStatsMessage.contains("status is unavailable"))

    faults.setFailing(false)
    await harness.model.refreshOutboxStatus()
    #expect(harness.model.outboxStatus.queued == 0)
    #expect(harness.model.persistenceWarning == nil)
  }

  @Test("Blocked stats discard uses its recovery handle and reports the transition")
  func blockedStatsDiscardIsActionable() async throws {
    let delivery = MutableStatsDelivery(mode: .permanentFailure)
    let harness = try SoloHarness(
      deliver: { request in try await delivery.deliver(request) }
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000191")!
    let terminal = try makeTerminalState()
    let gameIDs = [
      UUID(uuidString: "70000000-0000-4000-8000-000000000191")!,
      UUID(uuidString: "70000000-0000-4000-8000-000000000194")!,
    ]
    for (index, gameID) in gameIDs.enumerated() {
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
        completedAtMilliseconds: Int64(100 + index)
      )
    }

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    let recoveryHandle = try #require(harness.model.outboxStatus.blockedHeadRecoveryHandle)

    await delivery.setMode(.success)
    await harness.model.discardBlockedStats(expectedRecoveryHandle: recoveryHandle)

    #expect(harness.model.outboxStatus.queued == 0)
    #expect(try await harness.store.outboxStatus(accountID: accountID).queued == 0)
    #expect(harness.model.outboxStatus.blockedHeadKind == nil)
    #expect(harness.model.outboxRecoveryMessage == "The oldest stored result was discarded.")
  }

  @Test("A stale discard confirmation cannot delete a refreshed FIFO head")
  func staleBlockedStatsHandleCannotDeleteNewHead() async throws {
    let harness = try SoloHarness(deliver: { _ in
      throw StatsDeliveryError.permanent(.invalidPayload)
    })
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000192")!
    let terminal = try makeTerminalState()
    let firstGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000192")!
    let secondGameID = UUID(uuidString: "70000000-0000-4000-8000-000000000193")!
    for (gameID, completedAt) in [(firstGameID, Int64(100)), (secondGameID, Int64(200))] {
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
        completedAtMilliseconds: completedAt
      )
    }

    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)
    let staleHandle = try #require(harness.model.outboxStatus.blockedHeadRecoveryHandle)
    await harness.model.discardBlockedStats(expectedRecoveryHandle: staleHandle)
    #expect(harness.model.outboxStatus.queued == 1)
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    let currentHandle = try #require(harness.model.outboxStatus.blockedHeadRecoveryHandle)
    #expect(currentHandle != staleHandle)

    await harness.model.discardBlockedStats(expectedRecoveryHandle: staleHandle)

    #expect(harness.model.outboxStatus.queued == 1)
    #expect(harness.model.outboxStatus.blockedHeadKind == .terminal)
    #expect(harness.model.outboxStatus.blockedHeadRecoveryHandle == currentHandle)
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

  @Test("Volatile fallback never claims a session or pending stats will survive termination")
  func volatileFallbackCopyIsTruthful() async throws {
    let harness = try SoloHarness(persistenceIsDurable: false)
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    #expect(harness.model.hasDurableActiveSession)
    #expect(!harness.model.activeSessionIsPersistent)
    #expect(!harness.model.sessionStorageIsPersistent)

    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000195")!
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000195")!
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
    #expect(harness.model.completedStatsMessage.contains("only for the current app session"))
    #expect(harness.model.settingsStatsMessage.contains("only for the current app session"))
    #expect(harness.model.statsDeliverySystemImage == "exclamationmark.triangle.fill")
  }

  @Test("Volatile fallback keeps outbox-read failure recovery scoped to the open app")
  func volatileFallbackReadFailureCopyIsTruthful() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeOutboxRead, faults.isFailing {
            throw SoloPersistenceError.storageUnavailable
          }
        }
      ),
      persistenceIsDurable: false
    )
    defer { harness.dispose() }
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000200")!
    let gameID = UUID(uuidString: "70000000-0000-4000-8000-000000000200")!
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

    faults.setFailing(true)
    await harness.model.switchOwner(.account(accountID), confirmedAccountID: accountID)

    #expect(harness.model.outboxStatus.queued == 0)
    #expect(harness.model.persistenceWarning?.kind == .unavailable)
    #expect(harness.model.completedStatsMessage.contains("only while Skyjo remains open"))
    #expect(harness.model.settingsStatsMessage.contains("only while Skyjo remains open"))
    #expect(!harness.model.completedStatsMessage.contains("Keep this result on this device"))
    #expect(!harness.model.settingsStatsMessage.contains("will remain on this device"))
    #expect(harness.model.statsDeliverySystemImage == "exclamationmark.triangle.fill")
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

  @Test("Launcher metadata reports the last acknowledged save after autosave failure")
  func launcherMetadataNeverClaimsPendingStateWasSaved() async throws {
    let faults = MutablePersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.isFailing {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let acknowledged = try #require(harness.model.savedGameSummary)

    let roundOver = try makeRoundOverState()
    faults.setFailing(true)
    await harness.model.acceptForTesting(roundOver)
    await harness.model.startNextRound()
    #expect(harness.model.game?.round == acknowledged.round + 1)
    #expect(await waitUntil { harness.model.persistenceWarning != nil })

    harness.model.leaveTable()
    let launcher = try #require(harness.model.savedGameSummary)
    #expect(harness.model.screen == .launcher)
    #expect(launcher.round == acknowledged.round)
    #expect(launcher.savedAtMilliseconds == acknowledged.savedAtMilliseconds)
    #expect(launcher.round != harness.model.game?.round)
  }

  @Test("Successful terminal commit clears an autosave warning it superseded")
  func successfulCompletionClearsSupersededAutosaveWarning() async throws {
    let faults = CountingPersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    faults.arm(1)
    let firstCard = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: firstCard)
    #expect(await waitUntil { harness.model.persistenceWarning != nil })

    faults.arm(1)
    let terminal = try makeTerminalState(from: #require(harness.model.game))
    await harness.model.acceptForTesting(terminal)

    #expect(harness.model.completionCommitted)
    #expect(harness.model.completionError == nil)
    #expect(harness.model.persistenceWarning == nil)
  }

  @Test("A failed completion preserves pending autosave recovery through lifecycle flush")
  func failedCompletionPreservesPendingAutosaveRecovery() async throws {
    let faults = CountingPersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    faults.arm(3)
    let firstCard = try #require(
      harness.model.humanPlayer?.grid.firstIndex(where: { !$0.faceUp && !$0.removed })
    )
    await harness.model.tapHumanCard(at: firstCard)
    #expect(await waitUntil { harness.model.persistenceWarning != nil })
    let latestNonterminal = try #require(harness.model.game)
    #expect(harness.model.saveSequence == 1)

    let terminal = try makeTerminalState(from: latestNonterminal)
    await harness.model.acceptForTesting(terminal)
    #expect(!harness.model.completionCommitted)
    #expect(harness.model.completionError != nil)
    #expect(harness.model.game?.phase == .gameOver)

    harness.model.setSceneActive(false)
    #expect(
      await waitUntil {
        let restored = try? await harness.store.loadSession(for: .guest).session
        return restored?.saveSequence == 1 && restored?.state == latestNonterminal
      }
    )

    let relaunched = harness.makeSiblingModel()
    await relaunched.switchOwner(.guest, confirmedAccountID: nil)
    #expect(relaunched.screen == .launcher)
    #expect(relaunched.game == latestNonterminal)
    #expect(relaunched.saveSequence == 1)
  }

  @Test("A completion save failure remains retryable after leaving and continuing")
  func failedCompletionRemainsRetryableAfterContinue() async throws {
    let faults = CountingPersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()

    faults.arm(1)
    await harness.model.acceptForTesting(
      try makeTerminalState(from: #require(harness.model.game))
    )
    #expect(!harness.model.completionCommitted)
    #expect(harness.model.completionError?.contains("Retry") == true)

    harness.model.setScoreSummaryPresented(false)
    harness.model.leaveTable()
    #expect(harness.model.screen == .launcher)
    harness.model.continueSavedGame()

    #expect(harness.model.screen == .table)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(harness.model.completionError?.contains("Retry") == true)
    await harness.model.retryCompletion()
    #expect(harness.model.completionCommitted)
    #expect(harness.model.completionError == nil)
    #expect(!harness.model.isWorking)
  }

  @Test("An uncommitted terminal result blocks every replacement route until retry succeeds")
  func uncommittedCompletionBlocksReplacementWithoutLosingSavedGame() async throws {
    let faults = CountingPersistenceFault()
    let harness = try SoloHarness(
      persistenceEnvironment: SoloPersistenceEnvironment(
        faults: PersistenceFaultInjector { checkpoint in
          if checkpoint == .beforeCommit, faults.shouldFail() {
            throw SoloPersistenceError.writeInterrupted
          }
        }
      )
    )
    defer { harness.dispose() }
    await harness.model.switchOwner(.guest, confirmedAccountID: nil)
    await harness.model.reviewNewGame()
    let originalGameID = try #require(harness.model.gameID)
    let durableBeforeCompletion = try #require(
      try await harness.store.loadSession(for: .guest).session
    )

    faults.arm(1)
    await harness.model.acceptForTesting(
      try makeTerminalState(from: #require(harness.model.game))
    )
    #expect(harness.model.hasUncommittedTerminalCompletion)
    #expect(harness.model.completionError?.contains("Retry") == true)

    harness.model.setScoreSummaryPresented(false)
    harness.model.leaveTable()
    #expect(harness.model.screen == .launcher)

    harness.model.showSetup()
    #expect(harness.model.screen == .table)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isReplacementReviewPresented)

    harness.model.setupOpponentCount = 3
    await harness.model.reviewNewGame()
    #expect(harness.model.screen == .table)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isReplacementReviewPresented)

    await harness.model.confirmReplacement()
    #expect(harness.model.screen == .table)
    #expect(harness.model.isScoreSummaryPresented)
    #expect(!harness.model.isReplacementReviewPresented)
    #expect(harness.model.gameID == originalGameID)
    #expect(harness.model.game?.phase == .gameOver)
    #expect(harness.model.completionError?.contains("Retry") == true)
    #expect(
      try await harness.store.loadSession(for: .guest).session == durableBeforeCompletion
    )

    await harness.model.retryCompletion()
    #expect(harness.model.completionCommitted)
    #expect(harness.model.completionError == nil)
    #expect(try await harness.store.loadSession(for: .guest).session == nil)
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
    persistenceIsDurable: Bool = true,
    completionCommitBarrier: @escaping @Sendable () async -> Void = {},
    completionStatusReadBarrier: @escaping @Sendable () async -> Void = {},
    aiTurnDelay: @escaping @Sendable () async throws -> Void = {
      try await Task.sleep(
        for: .milliseconds(GameEngine.soloAIOpeningSeatDelayMilliseconds)
      )
    },
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
      feedback: feedback,
      persistenceIsDurable: persistenceIsDurable,
      completionCommitBarrier: completionCommitBarrier,
      completionStatusReadBarrier: completionStatusReadBarrier,
      aiTurnDelay: aiTurnDelay
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

private actor AIPacingDelayProbe {
  private(set) var invocationCount = 0

  func suspend() async throws {
    invocationCount += 1
    try await Task.sleep(for: .seconds(30))
  }
}

private actor StatsDeliveryCounter {
  private(set) var count = 0

  func record(_ request: StatsSubmissionRequest) {
    _ = request
    count += 1
  }
}

private actor CompletionCommitGate {
  private var entered = false
  private var entryWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func wait() async {
    entered = true
    for waiter in entryWaiters { waiter.resume() }
    entryWaiters.removeAll()
    await withCheckedContinuation { continuation in
      releaseContinuation = continuation
    }
  }

  func waitUntilEntered() async {
    if entered { return }
    await withCheckedContinuation { continuation in
      entryWaiters.append(continuation)
    }
  }

  func release() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }
}

private actor StatsDeliveryGate {
  private var entered = false
  private var released = false
  private var entryWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

  func deliver(_ request: StatsSubmissionRequest) async {
    _ = request
    entered = true
    for waiter in entryWaiters { waiter.resume() }
    entryWaiters.removeAll()
    guard !released else { return }
    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }
  }

  func waitUntilEntered() async {
    if entered { return }
    await withCheckedContinuation { continuation in
      entryWaiters.append(continuation)
    }
  }

  func release() {
    released = true
    for waiter in releaseWaiters { waiter.resume() }
    releaseWaiters.removeAll()
  }
}

private actor MutableStatsDelivery {
  enum Mode: Equatable, Sendable {
    case success
    case permanentFailure
  }

  private var mode: Mode

  init(mode: Mode) {
    self.mode = mode
  }

  func setMode(_ mode: Mode) {
    self.mode = mode
  }

  func deliver(_ request: StatsSubmissionRequest) throws {
    _ = request
    if mode == .permanentFailure {
      throw StatsDeliveryError.permanent(.unsupportedVersion)
    }
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

private final class CountingPersistenceFault: @unchecked Sendable {
  private let lock = NSLock()
  private var remaining = 0

  func arm(_ count: Int) {
    lock.lock()
    remaining = max(0, count)
    lock.unlock()
  }

  func shouldFail() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard remaining > 0 else { return false }
    remaining -= 1
    return true
  }
}

private final class IncreasingMilliseconds: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64

  init(startingAt value: Int64) {
    self.value = value
  }

  func next() -> Int64 {
    lock.lock()
    defer { lock.unlock() }
    value += 1
    return value
  }
}
