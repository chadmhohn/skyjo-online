import Foundation
import Testing

@testable import SkyjoDomain

@Suite("Deterministic AI and solo setup")
struct AIAndSetupTests {
  @Test("Knowledge projection excludes hidden values, physical ids, and draw order")
  func projectionPrivacyAndInvariance() {
    var state = sampleState(faceUp: false)
    let cleared = Card(id: "cleared-secret-8", value: 8, faceUp: true, removed: true)
    state.players[0].grid[0] = cleared
    state.discardPile = [
      Card(id: cleared.id, value: 8, faceUp: true),
      Card(id: "older-secret-1", value: 1, faceUp: true),
    ]
    state.drawnCard = Card(id: "drawn-secret-6", value: 6, faceUp: true)
    state.phase = .chooseReplacement
    state.selectedSource = .draw

    let drawer = AIProjection.knowledge(from: state, playerId: "bot")
    let encoded = String(decoding: try! JSONEncoder().encode(drawer), as: UTF8.self)
    #expect(!encoded.contains("secret"))
    #expect(drawer.players[0].grid[1].value == nil)
    #expect(drawer.knownValues.filter { $0 == 8 }.count == 1)
    #expect(drawer.knownValues.contains(6))
    #expect(drawer.drawPileCount == state.drawPile.count)

    let spectator = AIProjection.knowledge(from: state, playerId: "human")
    #expect(spectator.drawnCardValue == nil)
    #expect(!spectator.knownValues.contains(6))

    var mutated = state
    for playerIndex in mutated.players.indices {
      for cardIndex in mutated.players[playerIndex].grid.indices
      where !mutated.players[playerIndex].grid[cardIndex].faceUp
        && !mutated.players[playerIndex].grid[cardIndex].removed {
        mutated.players[playerIndex].grid[cardIndex] = Card(
          id: "changed-hidden-\(playerIndex)-\(cardIndex)",
          value: 12 - cardIndex,
          faceUp: false
        )
      }
    }
    mutated.drawPile.reverse()
    mutated.drawPile = mutated.drawPile.enumerated().map {
      Card(id: "changed-draw-\($0.offset)", value: $0.offset - 2)
    }
    #expect(
      AIProjection.knowledge(from: mutated, playerId: "bot")
        == AIProjection.knowledge(from: state, playerId: "bot")
    )
  }

  @Test("Legal AI action surface is phase-complete and fail closed")
  func legalActions() {
    var opening = AIProjection.knowledge(from: sampleState(faceUp: false), playerId: "bot")
    opening.phase = .openingReveal
    #expect(SkyjoAI.legalMoves(opening).allSatisfy { $0.action == .reveal })
    opening.players[0].grid[0].faceUp = true
    opening.players[0].grid[0].value = 2
    opening.players[0].grid[1].faceUp = true
    opening.players[0].grid[1].value = 3
    #expect(SkyjoAI.legalMoves(opening).isEmpty)

    var source = AIProjection.knowledge(from: sampleState(), playerId: "bot")
    #expect(Set(SkyjoAI.legalMoves(source).map(\.action)) == [.draw, .discard])
    source.drawPileCount = 0
    source.discardPileCount = 1
    source.discardTopValue = nil
    #expect(SkyjoAI.legalMoves(source).isEmpty)

    var discard = AIProjection.knowledge(from: sampleState(), playerId: "bot")
    discard.phase = .chooseReplacement
    discard.selectedSource = .discard
    #expect(SkyjoAI.legalMoves(discard).allSatisfy { $0.action == .replace })
    discard.discardTopValue = nil
    #expect(SkyjoAI.legalMoves(discard).isEmpty)

    var drawn = discard
    drawn.selectedSource = .draw
    drawn.drawnCardValue = 12
    drawn.players[0].grid[0].faceUp = false
    drawn.players[0].grid[0].value = nil
    #expect(Set(SkyjoAI.legalMoves(drawn).map(\.action)) == [.replace, .reveal])
    drawn.selectedSource = nil
    #expect(SkyjoAI.legalMoves(drawn).isEmpty)
    drawn.phase = .roundOver
    #expect(SkyjoAI.legalMoves(drawn).isEmpty)
    drawn.phase = .gameOver
    #expect(SkyjoAI.legalMoves(drawn).isEmpty)
    drawn.currentPlayerIndex = 99
    #expect(SkyjoAI.legalMoves(drawn).isEmpty)
  }

  @Test("Every profile is deterministic and produces only a legal move", arguments: AIDifficulty.allCases)
  func deterministicLegalMoves(difficulty: AIDifficulty) {
    let state = sampleState(faceUp: false)
    let options = AIDecisionOptions(
      playerId: "bot",
      difficulty: difficulty,
      decisionKey: "repeatable"
    )
    let first = SkyjoAI.chooseMove(for: state, options: options)
    #expect(first == SkyjoAI.chooseMove(for: state, options: options))
    #expect(first.map { SkyjoAI.legalMoves(for: state, playerId: "bot").contains($0) } == true)
    #expect(SkyjoAI.chooseMove(for: state, options: .init(
      playerId: "human",
      difficulty: difficulty,
      decisionKey: "wrong"
    )) == nil)
    #expect(SkyjoAI.legalMoves(for: state, playerId: "human").isEmpty)
  }

  @Test("Hidden estimate honors remaining deck composition and exhausted fallback")
  func hiddenEstimate() {
    var knowledge = AIProjection.knowledge(from: sampleState(faceUp: false), playerId: "bot")
    let baseline = SkyjoAI.estimateHiddenCardValue(knowledge)
    #expect(baseline >= -2 && baseline <= 12)
    knowledge.knownValues = SkyjoRules.cardValueCounts.flatMap {
      Array(repeating: $0.value, count: $0.count)
    }
    #expect(SkyjoAI.estimateHiddenCardValue(knowledge) == SkyjoRules.defaultHiddenCardEstimate)
    #expect(SkyjoAI.ultraDrawOutcomeLimit == 15)
  }

  @Test("Fixed and Mixed setup validation rejects every malformed branch")
  func malformedSoloSetup() throws {
    #expect(throws: SoloAISetupError.invalidOpponentCount) { try SoloAISetup.create(aiOpponentCount: 0) }
    #expect(throws: SoloAISetupError.invalidOpponentCount) { try SoloAISetup.create(aiOpponentCount: 8) }

    var random = SeededRandom(seed: 30)
    let state = GameEngine.startFreshGame(aiOpponentCount: 4, random: &random)
    let fixed = try SoloAISetup.create(aiOpponentCount: 4, difficulty: .hard)
    #expect(try SoloAISetup.resolve(fixed, state: state, gameId: "fixed").difficulty == .hard)
    #expect(throws: SoloAISetupError.unsupportedStrategyVersion) {
      try SoloAISetup.resolve(
        SoloGameSetup(aiOpponentCount: 4, difficulty: .hard, strategyVersion: 2),
        state: state,
        gameId: "bad-version"
      )
    }
    #expect(throws: SoloAISetupError.fixedSetupContainsAssignments) {
      try SoloAISetup.resolve(
        SoloGameSetup(
          aiOpponentCount: 4,
          difficulty: .hard,
          playerDifficulties: ["ai-1": .hard]
        ),
        state: state,
        gameId: "bad-fixed"
      )
    }
    #expect(throws: SoloAISetupError.rosterMismatch) {
      try SoloAISetup.resolve(
        SoloGameSetup(aiOpponentCount: 3, difficulty: .mixed),
        state: state,
        gameId: "wrong-count"
      )
    }
    let aiIDs = state.players.filter { $0.kind == .ai }.map(\.id).sorted()
    #expect(throws: SoloAISetupError.mixedAssignmentsRosterMismatch) {
      try SoloAISetup.resolve(
        SoloGameSetup(
          aiOpponentCount: 4,
          difficulty: .mixed,
          playerDifficulties: Dictionary(
            uniqueKeysWithValues: aiIDs.dropFirst().map { ($0, AIDifficulty.hard) }
          )
        ),
        state: state,
        gameId: "missing-id"
      )
    }
    let unbalanced = Dictionary(uniqueKeysWithValues: aiIDs.map { ($0, AIDifficulty.hard) })
    #expect(throws: SoloAISetupError.mixedAssignmentsUnbalanced) {
      try SoloAISetup.resolve(
        SoloGameSetup(
          aiOpponentCount: 4,
          difficulty: .mixed,
          playerDifficulties: unbalanced
        ),
        state: state,
        gameId: "unbalanced"
      )
    }
    #expect(!SoloAISetup.isResolved(
      SoloGameSetup(aiOpponentCount: 4, difficulty: .mixed),
      state: state
    ))
    #expect(!SoloAISetup.isResolved(
      SoloGameSetup(aiOpponentCount: 4, difficulty: .hard, strategyVersion: 99),
      state: state
    ))
    #expect(throws: SoloAISetupError.missingPlayerDifficulty("missing")) {
      try SoloAISetup.difficulty(
        for: "missing",
        in: SoloGameSetup(
          aiOpponentCount: 4,
          difficulty: .mixed,
          playerDifficulties: unbalanced
        )
      )
    }
  }

  @Test("Solo continuation retains identity and scores; explicit resize reshuffles")
  func continuationAndResize() {
    let existing = [
      samplePlayer(id: "human", kind: .human, totalScore: 12),
      samplePlayer(id: "bot", kind: .ai, totalScore: 34),
    ]
    var continuationRandom = SeededRandom(seed: 2)
    let continued = GameEngine.createSoloGame(
      existingPlayers: existing,
      round: 3,
      startPlayerId: "bot",
      random: &continuationRandom
    )
    #expect(continued.players.map(\.id) == ["human", "bot"])
    #expect(continued.players.map(\.totalScore) == [12, 34])
    var resizeRandom = SeededRandom(seed: 3)
    let resized = GameEngine.createSoloGame(
      existingPlayers: existing,
      round: 2,
      aiOpponentCount: 1,
      random: &resizeRandom
    )
    #expect(resized.players[0].id == "human")
    #expect(resized.players[0].totalScore == 12)
  }

  private func sampleState(faceUp: Bool = true) -> GameState {
    GameState(
      players: [
        samplePlayer(id: "bot", kind: .ai, faceUp: faceUp),
        samplePlayer(id: "human", kind: .human, faceUp: false),
      ],
      drawPile: [
        Card(id: "draw-secret-12", value: 12),
        Card(id: "draw-secret-minus-2", value: -2),
      ],
      discardPile: [Card(id: "discard-secret-4", value: 4, faceUp: true)],
      currentPlayerIndex: 0,
      phase: .chooseSource,
      openingRevealCounts: ["bot": faceUp ? 12 : 0, "human": 0]
    )
  }

  private func samplePlayer(
    id: String,
    kind: PlayerKind,
    faceUp: Bool = true,
    totalScore: Int = 0
  ) -> Player {
    let grid = (0..<12).map {
      Card(id: "grid-secret-\(id)-\($0)", value: 12 - $0, faceUp: faceUp)
    }
    return Player(
      id: id,
      name: id,
      kind: kind,
      grid: grid,
      totalScore: totalScore,
      roundScore: faceUp ? grid.reduce(0) { $0 + $1.value } : 0
    )
  }
}
