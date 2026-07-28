import Foundation
import Testing

@testable import SkyjoDomain

@Suite("Authoritative solo persistence validation")
struct SoloGameStateValidationTests {
  private let gameID = UUID(uuidString: "0A1B2C3D-4E5F-4678-9ABC-DEF012345678")!

  @Test("Canonical engine states validate across every persistence phase")
  func acceptsCanonicalStates() throws {
    for aiCount in GameEngine.singlePlayerAIOpponentRange {
      var random = SeededRandom(seed: UInt32(aiCount * 101))
      let state = GameEngine.startFreshGame(aiOpponentCount: aiCount, random: &random)
      try SoloGameStateValidator.validate(
        state,
        setup: try fixedSetup(for: state),
        gameID: gameID
      )
    }

    let source = try chooseSourceState(aiCount: 2)
    var drawRandom = SeededRandom(seed: 123)
    let phaseStates = [
      source,
      GameEngine.chooseDiscard(source),
      GameEngine.drawBlind(source, random: &drawRandom),
      try clearedColumnState(),
      try finalTurnState(aiCount: 2),
      try terminalState(aiCount: 2),
      try gameOverState(aiCount: 2),
    ]
    for state in phaseStates {
      try SoloGameStateValidator.validate(
        state,
        setup: try fixedSetup(for: state),
        gameID: gameID
      )
    }
    var nextRoundRandom = SeededRandom(seed: 124)
    let nextRound = GameEngine.startNextRound(try terminalState(aiCount: 2), random: &nextRoundRandom)
    try SoloGameStateValidator.validate(
      nextRound,
      setup: try fixedSetup(for: nextRound),
      gameID: gameID
    )

    var mixedRandom = SeededRandom(seed: 54)
    let mixedState = GameEngine.startFreshGame(aiOpponentCount: 4, random: &mixedRandom)
    let mixed = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 4, difficulty: .mixed),
      state: mixedState,
      gameId: gameID.uuidString.lowercased()
    )
    try SoloGameStateValidator.validate(mixedState, setup: mixed, gameID: gameID)
  }

  @Test("Decoded private state and resolved setup revalidate at the storage boundary")
  func validatesDecodedPayload() throws {
    let source = try gameOverState(aiCount: 2)
    let sourceSetup = try fixedSetup(for: source)
    let state = try JSONDecoder().decode(GameState.self, from: JSONEncoder().encode(source))
    let setup = try JSONDecoder().decode(SoloGameSetup.self, from: JSONEncoder().encode(sourceSetup))
    try SoloGameStateValidator.validate(state, setup: setup, gameID: gameID)
  }

  @Test("Roster requires one human, one through seven bots, unique stable identities, and 12-card grids")
  func rejectsMalformedRoster() throws {
    let valid = try openingState(aiCount: 2)
    let setup = try fixedSetup(for: valid)

    var extraHuman = valid
    extraHuman.players[1].kind = .human
    expectFailure(.invalidRoster, state: extraHuman, setup: setup)

    var duplicateID = valid
    duplicateID.players[1].id = duplicateID.players[0].id
    expectFailure(.invalidPlayerIdentity, state: duplicateID, setup: setup)

    var duplicateName = valid
    duplicateName.players[1].name = valid.players[0].name.uppercased()
    expectFailure(.invalidPlayerIdentity, state: duplicateName, setup: setup)

    var canonicallyEquivalentNames = valid
    canonicallyEquivalentNames.players[0].name = "Caf\u{00E9}"
    canonicallyEquivalentNames.players[1].name = "Cafe\u{0301}"
    expectFailure(.invalidPlayerIdentity, state: canonicallyEquivalentNames, setup: setup)

    var paddedID = valid
    paddedID.players[1].id += " "
    expectFailure(.invalidPlayerIdentity, state: paddedID, setup: setup)

    var shortGrid = valid
    shortGrid.players[0].grid.removeLast()
    expectFailure(.invalidGrid, state: shortGrid, setup: setup)

    var invalidCurrentPlayer = valid
    invalidCurrentPlayer.currentPlayerIndex = valid.players.count
    expectFailure(.invalidRoster, state: invalidCurrentPlayer, setup: setup)
  }

  @Test("Committed game-state schema bounds are enforced after Codable decoding")
  func rejectsValuesOutsideContractBounds() throws {
    let valid = try openingState(aiCount: 2)
    let setup = try fixedSetup(for: valid)

    var maximumLog = valid
    maximumLog.log = [String(repeating: "🙂", count: 512)]
    try SoloGameStateValidator.validate(maximumLog, setup: setup, gameID: gameID)

    var oversizedLogEntry = valid
    oversizedLogEntry.log = [String(repeating: "🙂", count: 513)]
    expectFailure(.invalidContractBounds, state: oversizedLogEntry, setup: setup)

    var oversizedLog = valid
    oversizedLog.log = Array(repeating: "bounded", count: 9)
    expectFailure(.invalidContractBounds, state: oversizedLog, setup: setup)

    var oversizedName = valid
    oversizedName.players[0].name = String(repeating: "N", count: 65)
    expectFailure(.invalidContractBounds, state: oversizedName, setup: setup)

    var forbiddenPlayerName = valid
    forbiddenPlayerName.players[0].name = "invalid\nname"
    expectFailure(.invalidContractBounds, state: forbiddenPlayerName, setup: setup)

    var allowedInternalTab = valid
    allowedInternalTab.players[0].name = "valid\tname"
    try SoloGameStateValidator.validate(allowedInternalTab, setup: setup, gameID: gameID)

    var oversizedIdentifier = valid
    renamePlayerID(in: &oversizedIdentifier, playerIndex: 0, to: String(repeating: "i", count: 129))
    expectFailure(.invalidContractBounds, state: oversizedIdentifier, setup: setup)

    var controlledIdentifier = valid
    renamePlayerID(in: &controlledIdentifier, playerIndex: 0, to: "invalid\tid")
    expectFailure(.invalidContractBounds, state: controlledIdentifier, setup: setup)

    var outOfRangePlayerScore = valid
    outOfRangePlayerScore.players[0].totalScore = 1_000_000_001
    expectFailure(.invalidContractBounds, state: outOfRangePlayerScore, setup: setup)

    var unsafeRound = valid
    unsafeRound.round = 9_007_199_254_740_992
    expectFailure(.invalidContractBounds, state: unsafeRound, setup: setup)

    var oversizedDrawPile = valid
    while oversizedDrawPile.drawPile.count <= SkyjoRules.deckCardCount {
      oversizedDrawPile.drawPile.append(valid.drawPile[0])
    }
    expectFailure(.invalidContractBounds, state: oversizedDrawPile, setup: setup)

    var oversizedFinalTurnList = valid
    oversizedFinalTurnList.finalTurnPlayerIds = Array(repeating: valid.players[0].id, count: 9)
    expectFailure(.invalidContractBounds, state: oversizedFinalTurnList, setup: setup)

    var oversizedOpeningMap = valid
    for index in 0..<6 { oversizedOpeningMap.openingRevealCounts["extra-\(index)"] = 0 }
    expectFailure(.invalidContractBounds, state: oversizedOpeningMap, setup: setup)

    let terminal = try gameOverState(aiCount: 2)
    let terminalSetup = try fixedSetup(for: terminal)
    var oversizedHistory = terminal
    let historyEntry = try #require(terminal.roundHistory.last)
    oversizedHistory.roundHistory = Array(repeating: historyEntry, count: 257)
    oversizedHistory.round = 257
    expectFailure(.invalidContractBounds, state: oversizedHistory, setup: terminalSetup)

    var unsafeEntryRound = terminal
    unsafeEntryRound.roundHistory[0].round = 9_007_199_254_740_992
    expectFailure(.invalidContractBounds, state: unsafeEntryRound, setup: terminalSetup)

    var oversizedRoundScoreName = terminal
    oversizedRoundScoreName.roundHistory[0].scores[0].name = String(repeating: "S", count: 65)
    expectFailure(.invalidContractBounds, state: oversizedRoundScoreName, setup: terminalSetup)

    var outOfRangeHistoryScore = terminal
    outOfRangeHistoryScore.roundHistory[0].scores[0].roundScore = -1_000_000_001
    expectFailure(.invalidContractBounds, state: outOfRangeHistoryScore, setup: terminalSetup)

    var controlledReference = terminal
    controlledReference.nextStarterId = "invalid\u{007f}reference"
    expectFailure(.invalidContractBounds, state: controlledReference, setup: terminalSetup)
  }

  @Test("Canonical card identities, flags, uniqueness, and all 150 physical cards are required")
  func rejectsMalformedDeck() throws {
    let valid = try openingState(aiCount: 2)
    let setup = try fixedSetup(for: valid)

    var badID = valid
    badID.drawPile[0].id = "not-a-canonical-card"
    expectFailure(.invalidCard, state: badID, setup: setup)

    var badValue = valid
    badValue.drawPile[0].value += 1
    expectFailure(.invalidCard, state: badValue, setup: setup)

    var visibleDrawPile = valid
    visibleDrawPile.drawPile[0].faceUp = true
    expectFailure(.invalidDeck, state: visibleDrawPile, setup: setup)

    var hiddenDiscard = valid
    hiddenDiscard.discardPile[0].faceUp = false
    expectFailure(.invalidDeck, state: hiddenDiscard, setup: setup)

    var duplicate = valid
    duplicate.drawPile[1] = duplicate.drawPile[0]
    expectFailure(.invalidDeck, state: duplicate, setup: setup)

    var missing = valid
    missing.drawPile.removeLast()
    expectFailure(.invalidDeck, state: missing, setup: setup)

    var noDiscard = valid
    noDiscard.discardPile.removeAll()
    expectFailure(.invalidDeck, state: noDiscard, setup: setup)

    var drawRandom = SeededRandom(seed: 91)
    let source = try chooseSourceState(aiCount: 2)
    var replacement = GameEngine.drawBlind(source, random: &drawRandom)
    #expect(replacement.drawnCard != nil)
    replacement.drawnCard?.faceUp = false
    expectFailure(.invalidDeck, state: replacement, setup: try fixedSetup(for: source))
  }

  @Test("Ongoing column clears retain canonical grid tombstones and active discard copies")
  func acceptsOngoingPostClearState() throws {
    let state = try clearedColumnState()
    let removedIDs = Set(state.players.flatMap(\.grid).filter(\.removed).map(\.id))
    let activeIDs = Set(
      state.drawPile.map(\.id) + state.discardPile.map(\.id)
        + state.players.flatMap(\.grid).filter { !$0.removed }.map(\.id)
    )
    #expect(activeIDs.count == SkyjoRules.deckCardCount)
    #expect(removedIDs.count >= SkyjoRules.rows)
    #expect(removedIDs.isSubset(of: activeIDs))
    try SoloGameStateValidator.validate(
      state,
      setup: try fixedSetup(for: state),
      gameID: gameID
    )
  }

  @Test("Removed cards form complete coherent columns and matching visible columns cannot remain uncleared")
  func rejectsMalformedRemovedColumns() throws {
    let cleared = try clearedColumnState()
    let setup = try fixedSetup(for: cleared)
    try SoloGameStateValidator.validate(cleared, setup: setup, gameID: gameID)

    var partial = cleared
    let removedPlayerIndex = try #require(partial.players.firstIndex {
      $0.grid.contains(where: { $0.removed })
    })
    let removedIndex = try #require(partial.players[removedPlayerIndex].grid.firstIndex {
      $0.removed
    })
    let removedID = partial.players[removedPlayerIndex].grid[removedIndex].id
    partial.players[removedPlayerIndex].grid[removedIndex].removed = false
    let discardIndex = try #require(partial.discardPile.firstIndex(where: { $0.id == removedID }))
    partial.discardPile.remove(at: discardIndex)
    partial.players[removedPlayerIndex].roundScore = GameEngine.visibleScore(
      partial.players[removedPlayerIndex].grid
    )
    expectFailure(.invalidRemovedColumns, state: partial, setup: setup)

    var openingRemoval = cleared
    openingRemoval.phase = .openingReveal
    expectFailure(.invalidRemovedColumns, state: openingRemoval, setup: setup)

    var uncleared = try chooseSourceState(aiCount: 2)
    makeVisibleMatchingColumn(in: &uncleared, playerIndex: 0)
    expectFailure(
      .invalidRemovedColumns,
      state: uncleared,
      setup: try fixedSetup(for: uncleared)
    )
  }

  @Test("Opening counts match the grid and seats advance in order")
  func rejectsMalformedOpeningState() throws {
    let valid = try openingState(aiCount: 2)
    let setup = try fixedSetup(for: valid)

    var countMismatch = valid
    countMismatch.openingRevealCounts[countMismatch.players[0].id] = 2
    expectFailure(.invalidOpeningState, state: countMismatch, setup: setup)

    var wrongSeat = valid
    wrongSeat.currentPlayerIndex = 1
    expectFailure(.invalidOpeningState, state: wrongSeat, setup: setup)

    var laterSeatStarted = valid
    laterSeatStarted.players[1].grid[0].faceUp = true
    laterSeatStarted.players[1].roundScore = laterSeatStarted.players[1].grid[0].value
    laterSeatStarted.openingRevealCounts[laterSeatStarted.players[1].id] = 1
    expectFailure(.invalidOpeningState, state: laterSeatStarted, setup: setup)

    var active = try chooseSourceState(aiCount: 2)
    active.openingRevealCounts[active.players[1].id] = 1
    expectFailure(.invalidOpeningState, state: active, setup: try fixedSetup(for: active))
  }

  @Test("Known-card and cumulative round-history invariants fail closed")
  func rejectsKnownCardAndHistoryCorruption() throws {
    let active = try chooseSourceState(aiCount: 2)
    let setup = try fixedSetup(for: active)

    var tooFewKnown = active
    let botIndex = 1
    let visibleIndexes = tooFewKnown.players[botIndex].grid.indices.filter {
      tooFewKnown.players[botIndex].grid[$0].faceUp
    }
    tooFewKnown.players[botIndex].grid[visibleIndexes[0]].faceUp = false
    tooFewKnown.players[botIndex].roundScore = GameEngine.visibleScore(tooFewKnown.players[botIndex].grid)
    expectFailure(.invalidKnownCards, state: tooFewKnown, setup: setup)

    var fullyKnown = active
    for index in fullyKnown.players[0].grid.indices {
      fullyKnown.players[0].grid[index].faceUp = true
    }
    fullyKnown.players[0].roundScore = GameEngine.visibleScore(fullyKnown.players[0].grid)
    expectFailure(.invalidKnownCards, state: fullyKnown, setup: setup)

    let terminal = try terminalState(aiCount: 2)
    let terminalSetup = try fixedSetup(for: terminal)

    var badName = terminal
    badName.roundHistory[0].scores[0].name += " changed"
    expectFailure(.invalidRoundHistory, state: badName, setup: terminalSetup)

    var badTotal = terminal
    badTotal.roundHistory[0].scores[0].totalScore += 1
    expectFailure(.invalidRoundHistory, state: badTotal, setup: terminalSetup)

    var badCurrentRoundScore = active
    badCurrentRoundScore.players[0].roundScore += 1
    expectFailure(.invalidRoundHistory, state: badCurrentRoundScore, setup: setup)
  }

  @Test("Phase selection tuples and final-turn order must be internally consistent")
  func rejectsMalformedPhaseAndFinalTurns() throws {
    let source = try chooseSourceState(aiCount: 2)
    let sourceSetup = try fixedSetup(for: source)

    var selectedAtSource = source
    selectedAtSource.selectedSource = .discard
    expectFailure(.invalidPhase, state: selectedAtSource, setup: sourceSetup)

    var incompleteReplacement = source
    incompleteReplacement.phase = .chooseReplacement
    incompleteReplacement.selectedSource = .draw
    expectFailure(.invalidPhase, state: incompleteReplacement, setup: sourceSetup)

    let ordered = try finalTurnState(aiCount: 2)
    let orderedSetup = try fixedSetup(for: ordered)
    try SoloGameStateValidator.validate(ordered, setup: orderedSetup, gameID: gameID)

    var wrongOrder = ordered
    wrongOrder.finalTurnPlayerIds.reverse()
    expectFailure(.invalidFinalTurnOrder, state: wrongOrder, setup: orderedSetup)

    var hiddenCloser = ordered
    let closerIndex = try #require(hiddenCloser.players.firstIndex {
      $0.id == hiddenCloser.roundCloserId
    })
    hiddenCloser.players[closerIndex].grid[0].faceUp = false
    hiddenCloser.players[closerIndex].roundScore = GameEngine.visibleScore(
      hiddenCloser.players[closerIndex].grid
    )
    expectFailure(.invalidFinalTurnOrder, state: hiddenCloser, setup: orderedSetup)
  }

  @Test("Terminal grids, closer doubling, threshold, and winner must reproduce scoring")
  func rejectsMalformedTerminalScoring() throws {
    let roundOver = try terminalState(aiCount: 2)
    let roundSetup = try fixedSetup(for: roundOver)

    var hiddenTerminalCard = roundOver
    let visibleIndex = try #require(hiddenTerminalCard.players[0].grid.firstIndex {
      $0.faceUp && !$0.removed
    })
    hiddenTerminalCard.players[0].grid[visibleIndex].faceUp = false
    expectFailure(.invalidTerminalState, state: hiddenTerminalCard, setup: roundSetup)

    var wrongCloserScore = roundOver
    let closerID = try #require(wrongCloserScore.nextStarterId)
    let closerIndex = try #require(wrongCloserScore.players.firstIndex { $0.id == closerID })
    wrongCloserScore.players[closerIndex].roundScore += 1
    wrongCloserScore.players[closerIndex].totalScore += 1
    let latestHistoryIndex = wrongCloserScore.roundHistory.count - 1
    let scoreIndex = try #require(wrongCloserScore.roundHistory[latestHistoryIndex].scores.firstIndex {
      $0.playerId == closerID
    })
    wrongCloserScore.roundHistory[latestHistoryIndex].scores[scoreIndex].roundScore += 1
    wrongCloserScore.roundHistory[latestHistoryIndex].scores[scoreIndex].totalScore += 1
    expectFailure(.invalidTerminalState, state: wrongCloserScore, setup: roundSetup)

    let gameOver = try gameOverState(aiCount: 2)
    let gameSetup = try fixedSetup(for: gameOver)
    var wrongWinner = gameOver
    wrongWinner.winnerId = gameOver.players.first { $0.id != gameOver.winnerId }?.id
    expectFailure(.invalidTerminalState, state: wrongWinner, setup: gameSetup)

    var wrongCloser = roundOver
    wrongCloser.nextStarterId = roundOver.players.first { $0.id != roundOver.nextStarterId }?.id
    expectFailure(.invalidTerminalState, state: wrongCloser, setup: roundSetup)
  }

  @Test("Persisted AI setup must be resolved for the exact roster, strategy version, and game UUID")
  func rejectsMalformedSetup() throws {
    let state = try openingState(aiCount: 4)
    let fixed = try fixedSetup(for: state)

    expectFailure(
      .invalidSetup,
      state: state,
      setup: SoloGameSetup(aiOpponentCount: 3, difficulty: .hard)
    )
    expectFailure(
      .invalidSetup,
      state: state,
      setup: SoloGameSetup(aiOpponentCount: 4, difficulty: .hard, strategyVersion: nil)
    )
    expectFailure(
      .invalidSetup,
      state: state,
      setup: SoloGameSetup(
        aiOpponentCount: 4,
        difficulty: .hard,
        playerDifficulties: [state.players[1].id: .hard]
      )
    )

    let mixed = try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: 4, difficulty: .mixed),
      state: state,
      gameId: gameID.uuidString.lowercased()
    )
    var missingAssignment = mixed
    missingAssignment.playerDifficulties?.removeValue(forKey: state.players[1].id)
    expectFailure(.invalidSetup, state: state, setup: missingAssignment)

    var unbalanced = mixed
    unbalanced.playerDifficulties = Dictionary(
      uniqueKeysWithValues: state.players.filter { $0.kind == .ai }.map { ($0.id, .hard) }
    )
    expectFailure(.invalidSetup, state: state, setup: unbalanced)

    try SoloGameStateValidator.validate(state, setup: fixed, gameID: gameID)
  }

  private func openingState(aiCount: Int) throws -> GameState {
    var random = SeededRandom(seed: UInt32(700 + aiCount))
    return GameEngine.startFreshGame(aiOpponentCount: aiCount, random: &random)
  }

  private func chooseSourceState(aiCount: Int) throws -> GameState {
    var state = try openingState(aiCount: aiCount)
    state = GameEngine.revealOpeningCard(state, at: 0)
    state = GameEngine.revealOpeningCard(state, at: 1)
    state = GameEngine.drainSoloAIOpening(state)
    #expect(state.phase == .chooseSource)
    return state
  }

  private func fixedSetup(for state: GameState) throws -> SoloGameSetup {
    try SoloAISetup.resolve(
      SoloGameSetup(
        aiOpponentCount: state.players.filter { $0.kind == .ai }.count,
        difficulty: .hard
      ),
      state: state,
      gameId: gameID.uuidString.lowercased()
    )
  }

  private func renamePlayerID(in state: inout GameState, playerIndex: Int, to newID: String) {
    let oldID = state.players[playerIndex].id
    state.players[playerIndex].id = newID
    if let count = state.openingRevealCounts.removeValue(forKey: oldID) {
      state.openingRevealCounts[newID] = count
    }
    if state.winnerId == oldID { state.winnerId = newID }
    if state.nextStarterId == oldID { state.nextStarterId = newID }
    if state.roundCloserId == oldID { state.roundCloserId = newID }
    state.finalTurnPlayerIds = state.finalTurnPlayerIds.map { $0 == oldID ? newID : $0 }
    for historyIndex in state.roundHistory.indices {
      if state.roundHistory[historyIndex].closerId == oldID {
        state.roundHistory[historyIndex].closerId = newID
      }
      for scoreIndex in state.roundHistory[historyIndex].scores.indices
      where state.roundHistory[historyIndex].scores[scoreIndex].playerId == oldID {
        state.roundHistory[historyIndex].scores[scoreIndex].playerId = newID
      }
    }
  }

  private func expectFailure(
    _ expected: SoloGameStateValidationError,
    state: GameState,
    setup: SoloGameSetup
  ) {
    do {
      try SoloGameStateValidator.validate(state, setup: setup, gameID: gameID)
      Issue.record("Expected authoritative solo state validation to fail")
    } catch let error as SoloGameStateValidationError {
      #expect(error == expected)
    } catch {
      Issue.record("Expected a typed authoritative solo validation failure")
    }
  }

  private func clearedColumnState() throws -> GameState {
    var state = try chooseSourceState(aiCount: 2)
    makeVisibleMatchingColumn(in: &state, playerIndex: state.currentPlayerIndex)
    state = GameEngine.chooseDiscard(state)
    state = GameEngine.replaceCard(state, at: 1)
    #expect(state.players.flatMap(\.grid).filter(\.removed).count >= SkyjoRules.rows)
    return state
  }

  private func finalTurnState(aiCount: Int) throws -> GameState {
    var state = try openingState(aiCount: aiCount)
    var random = SeededRandom(seed: 8_800 + UInt32(aiCount))
    for _ in 0..<500 {
      state = advance(state, random: &random)
      if state.roundCloserId != nil, state.phase == .chooseSource || state.phase == .chooseReplacement {
        return state
      }
    }
    Issue.record("Deterministic solo transcript did not enter the final lap")
    return state
  }

  private func terminalState(aiCount: Int) throws -> GameState {
    var state = try openingState(aiCount: aiCount)
    var random = SeededRandom(seed: 9_100 + UInt32(aiCount))
    for _ in 0..<500 {
      if state.phase == .roundOver || state.phase == .gameOver { return state }
      state = advance(state, random: &random)
    }
    Issue.record("Deterministic solo transcript did not finish its round")
    return state
  }

  private func gameOverState(aiCount: Int) throws -> GameState {
    var state = try openingState(aiCount: aiCount)
    for roundAttempt in 0..<20 {
      var turnRandom = SeededRandom(seed: 10_000 + UInt32(roundAttempt * 97 + aiCount))
      for _ in 0..<500 {
        if state.phase == .roundOver || state.phase == .gameOver { break }
        state = advance(state, random: &turnRandom)
      }
      if state.phase == .gameOver { return state }
      guard state.phase == .roundOver else { break }
      var nextRoundRandom = SeededRandom(seed: 20_000 + UInt32(roundAttempt * 131 + aiCount))
      state = GameEngine.startNextRound(state, random: &nextRoundRandom)
    }
    Issue.record("Deterministic solo transcript did not reach the game threshold")
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
         }) {
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

  private func makeVisibleMatchingColumn(in state: inout GameState, playerIndex: Int) {
    let groupedIndexes = Dictionary(grouping: state.drawPile.indices) { state.drawPile[$0].value }
    let drawIndexes = Array(groupedIndexes.values.first { $0.count >= SkyjoRules.rows }!.prefix(3))
    let gridIndexes = SkyjoRules.columnIndexes(for: 0)
    for (gridIndex, drawIndex) in zip(gridIndexes, drawIndexes) {
      let gridCard = state.players[playerIndex].grid[gridIndex]
      var replacement = state.drawPile[drawIndex]
      replacement.faceUp = true
      state.players[playerIndex].grid[gridIndex] = replacement
      state.drawPile[drawIndex] = Card(
        id: gridCard.id,
        value: gridCard.value,
        faceUp: false,
        removed: false
      )
    }
    state.players[playerIndex].roundScore = GameEngine.visibleScore(state.players[playerIndex].grid)
  }
}
