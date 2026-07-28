import Foundation

/// Safe, coarse-grained reasons that an authoritative solo snapshot cannot be persisted.
///
/// The cases intentionally contain no player, card, or game identifiers so callers can surface or
/// record a failure category without leaking authoritative state.
public enum SoloGameStateValidationError: String, Error, Equatable, Sendable {
  case invalidContractBounds
  case invalidRoster
  case invalidPlayerIdentity
  case invalidGrid
  case invalidCard
  case invalidDeck
  case invalidRemovedColumns
  case invalidOpeningState
  case invalidKnownCards
  case invalidRoundHistory
  case invalidPhase
  case invalidFinalTurnOrder
  case invalidTerminalState
  case invalidSetup
}

/// Validates a decoded authoritative solo state before it crosses the persistence boundary.
///
/// This validator is deliberately stricter than the game reducers. Reducers fail closed for an
/// individual illegal action; persisted state must prove that the complete private 150-card deck,
/// score history, turn state, and resolved AI setup are mutually coherent.
public enum SoloGameStateValidator {
  public static func validate(
    _ state: GameState,
    setup: SoloGameSetup,
    gameID: UUID
  ) throws {
    try validateState(state)
    try validateSetup(setup, for: state, gameID: gameID)
  }

  public static func validateState(_ state: GameState) throws {
    try validateContractBounds(state)
    let playersByID = try validateRoster(state)
    try validateDeck(state)
    try validateRemovedColumns(state)
    try validateOpeningState(state)
    try validateKnownCards(state)
    try validateRoundHistory(state, playersByID: playersByID)
    try validatePhase(state, playersByID: playersByID)
    try validateTerminalState(state, playersByID: playersByID)
  }

  public static func validateSetup(
    _ setup: SoloGameSetup,
    for state: GameState,
    gameID: UUID
  ) throws {
    let aiPlayerIDs = state.players.filter { $0.kind == .ai }.map(\.id).sorted()
    guard GameEngine.singlePlayerAIOpponentRange.contains(setup.aiOpponentCount),
          setup.aiOpponentCount == aiPlayerIDs.count,
          state.players.count == setup.aiOpponentCount + 1,
          setup.strategyVersion == SkyjoRules.strategyVersion
    else {
      throw SoloGameStateValidationError.invalidSetup
    }

    if setup.difficulty == .mixed {
      guard let assignments = setup.playerDifficulties,
            assignments.keys.sorted() == aiPlayerIDs
      else {
        throw SoloGameStateValidationError.invalidSetup
      }
      let counts = AIDifficulty.allCases.map { difficulty in
        assignments.values.filter { $0 == difficulty }.count
      }
      guard let minimum = counts.min(), let maximum = counts.max(), maximum - minimum <= 1 else {
        throw SoloGameStateValidationError.invalidSetup
      }
    } else if setup.playerDifficulties != nil {
      throw SoloGameStateValidationError.invalidSetup
    }

    do {
      let resolved = try SoloAISetup.resolve(
        setup,
        state: state,
        gameId: gameID.uuidString.lowercased()
      )
      guard resolved == setup else { throw SoloGameStateValidationError.invalidSetup }
    } catch let error as SoloGameStateValidationError {
      throw error
    } catch {
      throw SoloGameStateValidationError.invalidSetup
    }
  }

  private static let canonicalCards: [String: Int] = {
    let values = SkyjoRules.cardValueCounts.flatMap { item in
      Array(repeating: item.value, count: item.count)
    }
    return Dictionary(uniqueKeysWithValues: values.enumerated().map { index, value in
      ("card-\(index)-\(value)", value)
    })
  }()

  private static let maximumSafeInteger = 9_007_199_254_740_991
  private static let validScoreRange = -1_000_000_000...1_000_000_000

  private static func validateContractBounds(_ state: GameState) throws {
    guard (2...8).contains(state.players.count),
          state.drawPile.count <= SkyjoRules.deckCardCount,
          state.discardPile.count <= SkyjoRules.deckCardCount,
          (0...7).contains(state.currentPlayerIndex),
          (1...maximumSafeInteger).contains(state.round),
          state.log.count <= 8,
          state.log.allSatisfy({ codePointCount($0) <= 512 }),
          state.finalTurnPlayerIds.count <= 8,
          state.openingRevealCounts.count <= 8,
          state.roundHistory.count <= 256
    else {
      throw SoloGameStateValidationError.invalidContractBounds
    }

    let cards = state.players.flatMap(\.grid) + state.drawPile + state.discardPile
      + (state.drawnCard.map { [$0] } ?? [])
    guard cards.allSatisfy({ isIdentifier($0.id) && (-2...12).contains($0.value) }),
          state.players.allSatisfy({ player in
            isIdentifier(player.id)
              && isPlayerName(player.name)
              && validScoreRange.contains(player.totalScore)
              && validScoreRange.contains(player.roundScore)
          })
    else {
      throw SoloGameStateValidationError.invalidContractBounds
    }

    let nullableReferences = [state.winnerId, state.nextStarterId, state.roundCloserId]
      .compactMap { $0 }
    guard nullableReferences.allSatisfy(isIdentifier),
          state.finalTurnPlayerIds.allSatisfy(isIdentifier),
          state.openingRevealCounts.allSatisfy({ key, value in
            isIdentifier(key) && (0...2).contains(value)
          })
    else {
      throw SoloGameStateValidationError.invalidContractBounds
    }

    for entry in state.roundHistory {
      guard (1...maximumSafeInteger).contains(entry.round),
            isIdentifier(entry.closerId),
            (2...8).contains(entry.scores.count),
            entry.scores.allSatisfy({ score in
              isIdentifier(score.playerId)
                && isBoundedName(score.name)
                && validScoreRange.contains(score.roundScore)
                && validScoreRange.contains(score.totalScore)
            })
      else {
        throw SoloGameStateValidationError.invalidContractBounds
      }
    }
  }

  private static func isIdentifier(_ value: String) -> Bool {
    let scalars = value.unicodeScalars
    return (1...128).contains(scalars.count) && scalars.allSatisfy { scalar in
      scalar.value > 0x1f && scalar.value != 0x7f
    }
  }

  private static func isPlayerName(_ value: String) -> Bool {
    isBoundedName(value) && value.unicodeScalars.allSatisfy { scalar in
      scalar.value != 0 && scalar.value != 0x0a && scalar.value != 0x0d
    }
  }

  private static func isBoundedName(_ value: String) -> Bool {
    (1...64).contains(codePointCount(value))
  }

  private static func codePointCount(_ value: String) -> Int {
    value.unicodeScalars.count
  }

  private static func validateRoster(_ state: GameState) throws -> [String: Player] {
    guard (2...8).contains(state.players.count), state.players.indices.contains(state.currentPlayerIndex),
          state.round >= 1, state.log.count <= 8
    else {
      throw SoloGameStateValidationError.invalidRoster
    }

    let humanCount = state.players.filter { $0.kind == .human }.count
    let aiCount = state.players.filter { $0.kind == .ai }.count
    guard humanCount == 1, GameEngine.singlePlayerAIOpponentRange.contains(aiCount) else {
      throw SoloGameStateValidationError.invalidRoster
    }

    var playerIDs: Set<String> = []
    var playerNames: Set<String> = []
    for player in state.players {
      let id = player.id.trimmingCharacters(in: .whitespacesAndNewlines)
      let name = player.name.trimmingCharacters(in: .whitespacesAndNewlines)
      let normalizedName = name.precomposedStringWithCanonicalMapping.lowercased()
      guard !id.isEmpty, id == player.id, playerIDs.insert(id).inserted,
            !name.isEmpty, name == player.name, playerNames.insert(normalizedName).inserted
      else {
        throw SoloGameStateValidationError.invalidPlayerIdentity
      }
      guard player.grid.count == SkyjoRules.rows * SkyjoRules.columns else {
        throw SoloGameStateValidationError.invalidGrid
      }
    }

    let playersByID = Dictionary(uniqueKeysWithValues: state.players.map { ($0.id, $0) })
    let referencedIDs = [state.winnerId, state.nextStarterId, state.roundCloserId].compactMap { $0 }
      + state.finalTurnPlayerIds
    guard referencedIDs.allSatisfy({ playersByID[$0] != nil }),
          Set(state.finalTurnPlayerIds).count == state.finalTurnPlayerIds.count
    else {
      throw SoloGameStateValidationError.invalidRoster
    }
    return playersByID
  }

  private static func validateDeck(_ state: GameState) throws {
    guard !state.discardPile.isEmpty,
          state.drawPile.allSatisfy({ !$0.faceUp && !$0.removed }),
          state.discardPile.allSatisfy({ $0.faceUp && !$0.removed }),
          state.drawnCard.map({ $0.faceUp && !$0.removed }) ?? true
    else {
      throw SoloGameStateValidationError.invalidDeck
    }

    let gridCards = state.players.flatMap(\.grid)
    for card in gridCards + state.drawPile + state.discardPile + (state.drawnCard.map { [$0] } ?? []) {
      guard canonicalCards[card.id] == card.value else {
        throw SoloGameStateValidationError.invalidCard
      }
    }

    let activeCards = state.drawPile + state.discardPile
      + (state.drawnCard.map { [$0] } ?? [])
      + gridCards.filter { !$0.removed }
    let terminal = state.phase == .roundOver || state.phase == .gameOver
    guard terminal || activeCards.count == SkyjoRules.deckCardCount else {
      throw SoloGameStateValidationError.invalidDeck
    }

    var activeIDs: Set<String> = []
    for card in activeCards where !activeIDs.insert(card.id).inserted {
      throw SoloGameStateValidationError.invalidDeck
    }

    var removedIDs: Set<String> = []
    for card in gridCards where card.removed {
      guard card.faceUp, removedIDs.insert(card.id).inserted else {
        throw SoloGameStateValidationError.invalidDeck
      }
    }
    guard activeIDs.union(removedIDs).count == SkyjoRules.deckCardCount else {
      throw SoloGameStateValidationError.invalidDeck
    }
  }

  private static func validateRemovedColumns(_ state: GameState) throws {
    for player in state.players {
      for column in 0..<SkyjoRules.columns {
        let cards = SkyjoRules.columnIndexes(for: column).map { player.grid[$0] }
        let removedCards = cards.filter(\.removed)
        if removedCards.isEmpty {
          if let first = cards.first,
             cards.allSatisfy({ $0.faceUp && $0.value == first.value }) {
            throw SoloGameStateValidationError.invalidRemovedColumns
          }
          continue
        }
        guard state.phase != .openingReveal,
              removedCards.count == SkyjoRules.rows,
              Set(removedCards.map(\.id)).count == SkyjoRules.rows,
              removedCards.allSatisfy({ $0.faceUp && $0.value == removedCards[0].value })
        else {
          throw SoloGameStateValidationError.invalidRemovedColumns
        }
      }
    }
  }

  private static func validateOpeningState(_ state: GameState) throws {
    let playerIDs = Set(state.players.map(\.id))
    guard Set(state.openingRevealCounts.keys) == playerIDs else {
      throw SoloGameStateValidationError.invalidOpeningState
    }

    var visibleCounts: [Int] = []
    for player in state.players {
      let visible = player.grid.filter { $0.faceUp && !$0.removed }.count
      visibleCounts.append(visible)
      guard let recorded = state.openingRevealCounts[player.id], (0...2).contains(recorded),
            state.phase == .openingReveal ? recorded == visible : recorded == 2
      else {
        throw SoloGameStateValidationError.invalidOpeningState
      }
    }

    guard state.phase == .openingReveal else { return }
    guard let firstIncompleteIndex = visibleCounts.firstIndex(where: { $0 < 2 }),
          state.currentPlayerIndex == firstIncompleteIndex,
          visibleCounts[..<firstIncompleteIndex].allSatisfy({ $0 == 2 }),
          visibleCounts[(firstIncompleteIndex + 1)...].allSatisfy({ $0 == 0 })
    else {
      throw SoloGameStateValidationError.invalidOpeningState
    }
  }

  private static func validateKnownCards(_ state: GameState) throws {
    guard state.phase != .openingReveal else { return }
    guard state.players.allSatisfy({ player in
      player.grid.filter { $0.faceUp || $0.removed }.count >= 2
    }) else {
      throw SoloGameStateValidationError.invalidKnownCards
    }
    if state.phase == .roundOver || state.phase == .gameOver || state.roundCloserId != nil {
      return
    }
    guard state.players.allSatisfy({ player in
      player.grid.contains { !$0.faceUp && !$0.removed }
    }) else {
      throw SoloGameStateValidationError.invalidKnownCards
    }
  }

  private static func validateRoundHistory(
    _ state: GameState,
    playersByID: [String: Player]
  ) throws {
    let terminal = state.phase == .roundOver || state.phase == .gameOver
    let expectedCount = terminal ? state.round : state.round - 1
    guard state.roundHistory.count == expectedCount else {
      throw SoloGameStateValidationError.invalidRoundHistory
    }

    var totals = Dictionary(uniqueKeysWithValues: state.players.map { ($0.id, 0) })
    for (index, entry) in state.roundHistory.enumerated() {
      guard entry.round == index + 1, playersByID[entry.closerId] != nil,
            entry.scores.count == state.players.count
      else {
        throw SoloGameStateValidationError.invalidRoundHistory
      }
      var scoreIDs: Set<String> = []
      for score in entry.scores {
        guard let player = playersByID[score.playerId], score.name == player.name,
              scoreIDs.insert(score.playerId).inserted, let previous = totals[score.playerId]
        else {
          throw SoloGameStateValidationError.invalidRoundHistory
        }
        let addition = previous.addingReportingOverflow(score.roundScore)
        guard !addition.overflow, score.totalScore == addition.partialValue else {
          throw SoloGameStateValidationError.invalidRoundHistory
        }
        totals[score.playerId] = score.totalScore
      }
      guard scoreIDs.count == state.players.count else {
        throw SoloGameStateValidationError.invalidRoundHistory
      }
    }

    for player in state.players {
      guard player.totalScore == totals[player.id] else {
        throw SoloGameStateValidationError.invalidRoundHistory
      }
      if !terminal, player.roundScore != visibleScore(player) {
        throw SoloGameStateValidationError.invalidRoundHistory
      }
    }
    guard terminal else { return }
    let latestScores = Dictionary(
      uniqueKeysWithValues: (state.roundHistory.last?.scores ?? []).map { ($0.playerId, $0) }
    )
    guard state.players.allSatisfy({ latestScores[$0.id]?.roundScore == $0.roundScore }) else {
      throw SoloGameStateValidationError.invalidRoundHistory
    }
  }

  private static func validatePhase(
    _ state: GameState,
    playersByID: [String: Player]
  ) throws {
    let noSelection = state.selectedSource == nil && state.drawnCard == nil
    let noFinalTurn = state.roundCloserId == nil && state.finalTurnPlayerIds.isEmpty
    switch state.phase {
    case .openingReveal:
      let expectedStarter = state.round == 1 ? nil : state.roundHistory.last?.closerId
      guard noSelection, noFinalTurn, state.winnerId == nil,
            state.nextStarterId == expectedStarter
      else {
        throw SoloGameStateValidationError.invalidPhase
      }
      return
    case .roundOver:
      guard noSelection, noFinalTurn, state.winnerId == nil, state.nextStarterId != nil else {
        throw SoloGameStateValidationError.invalidPhase
      }
      return
    case .gameOver:
      guard noSelection, noFinalTurn, state.winnerId != nil, state.nextStarterId != nil else {
        throw SoloGameStateValidationError.invalidPhase
      }
      return
    case .chooseSource:
      guard state.winnerId == nil, state.nextStarterId == nil, noSelection else {
        throw SoloGameStateValidationError.invalidPhase
      }
    case .chooseReplacement:
      let validDraw = state.selectedSource == .draw && state.drawnCard != nil
      let validDiscard = state.selectedSource == .discard && state.drawnCard == nil
      guard state.winnerId == nil, state.nextStarterId == nil, validDraw != validDiscard else {
        throw SoloGameStateValidationError.invalidPhase
      }
    }

    guard let closerID = state.roundCloserId else {
      guard state.finalTurnPlayerIds.isEmpty else {
        throw SoloGameStateValidationError.invalidFinalTurnOrder
      }
      return
    }
    guard let closerIndex = state.players.firstIndex(where: { $0.id == closerID }),
          let closer = playersByID[closerID],
          closer.grid.allSatisfy({ $0.faceUp || $0.removed })
    else {
      throw SoloGameStateValidationError.invalidFinalTurnOrder
    }

    let fullOrder = (0..<(state.players.count - 1)).map { offset in
      state.players[(closerIndex + offset + 1) % state.players.count].id
    }
    let currentID = state.players[state.currentPlayerIndex].id
    guard let remainingStart = fullOrder.firstIndex(of: currentID),
          state.finalTurnPlayerIds == Array(fullOrder[remainingStart...])
    else {
      throw SoloGameStateValidationError.invalidFinalTurnOrder
    }
  }

  private static func validateTerminalState(
    _ state: GameState,
    playersByID: [String: Player]
  ) throws {
    guard state.phase == .roundOver || state.phase == .gameOver else { return }
    guard state.players.allSatisfy({ player in
      player.grid.allSatisfy { $0.removed || $0.faceUp }
    }), let closerID = state.nextStarterId, let closer = playersByID[closerID],
          state.roundHistory.last?.closerId == closerID
    else {
      throw SoloGameStateValidationError.invalidTerminalState
    }

    let rawScores = Dictionary(uniqueKeysWithValues: state.players.map { ($0.id, finalScore($0)) })
    guard let closerRawScore = rawScores[closer.id] else {
      throw SoloGameStateValidationError.invalidTerminalState
    }
    let lowestOtherScore = state.players.compactMap { player in
      player.id == closer.id ? nil : rawScores[player.id]
    }.min()
    guard let lowestOtherScore else {
      throw SoloGameStateValidationError.invalidTerminalState
    }
    let shouldDouble = closerRawScore >= lowestOtherScore && closerRawScore > 0
    let doubled = closerRawScore.multipliedReportingOverflow(by: 2)
    guard !shouldDouble || !doubled.overflow else {
      throw SoloGameStateValidationError.invalidTerminalState
    }
    for player in state.players {
      let expected = player.id == closer.id && shouldDouble ? doubled.partialValue : rawScores[player.id]
      guard player.roundScore == expected else {
        throw SoloGameStateValidationError.invalidTerminalState
      }
    }

    let thresholdReached = state.players.contains { $0.totalScore >= SkyjoRules.winningScore }
    if state.phase == .roundOver {
      guard !thresholdReached, state.winnerId == nil else {
        throw SoloGameStateValidationError.invalidTerminalState
      }
      return
    }
    guard thresholdReached, let winnerID = state.winnerId,
          let lowestTotal = state.players.map(\.totalScore).min(),
          state.players.first(where: { $0.totalScore == lowestTotal })?.id == winnerID
    else {
      throw SoloGameStateValidationError.invalidTerminalState
    }
  }

  private static func visibleScore(_ player: Player) -> Int {
    player.grid.reduce(0) { total, card in
      total + (card.faceUp && !card.removed ? card.value : 0)
    }
  }

  private static func finalScore(_ player: Player) -> Int {
    player.grid.reduce(0) { total, card in total + (card.removed ? 0 : card.value) }
  }
}
