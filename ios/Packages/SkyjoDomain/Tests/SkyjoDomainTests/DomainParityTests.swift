import Foundation
import Testing

@testable import SkyjoDomain

@Suite("TypeScript and Swift golden parity")
struct DomainParityTests {
  @Test("Seeded deck, roster, and themed-name parity")
  func seededGames() throws {
    let fixture = try DomainFixture.load()
    for testCase in fixture.seededGames {
      var random = SeededRandom(seed: testCase.input.seed)
      let actual: GameState
      switch testCase.input.kind {
      case .solo:
        actual = GameEngine.startFreshGame(
          aiOpponentCount: try #require(testCase.input.aiOpponentCount),
          random: &random
        )
      case .multiplayer:
        actual = GameEngine.createMultiplayerGame(
          players: try #require(testCase.input.players).map {
            PlayerSeed(id: $0.id, name: $0.name, kind: .human)
          },
          round: testCase.input.round ?? 1,
          startPlayerId: testCase.input.previousCloserId,
          random: &random
        )
      }
      #expect(actual == testCase.expectedState, Comment(rawValue: testCase.name))
    }
  }

  @Test("Named rule transcripts cover every IOS-3 branch gate")
  func namedRuleScenarios() throws {
    let fixture = try DomainFixture.load()
    let requiredNames = [
      "opening, discard cancellation, blind reveal, and replacement",
      "matching column clears above the replaced card in discard order",
      "every opponent gets a final turn, tied closer doubles, and closer starts next round",
      "three-player final turns advance in seat order before scoring",
      "strict-low positive closer does not double",
      "nonpositive tied closer does not double",
      "game threshold selects the lowest-total winner",
      "empty draw pile deterministically recycles below the discard top",
    ]
    #expect(fixture.scenarios.map(\.name) == requiredNames)

    for scenario in fixture.scenarios {
      var state = scenario.initialState
      #expect(scenario.actions.count == scenario.expectedStates.count)
      for (step, action) in scenario.actions.enumerated() {
        switch action.type {
        case "reveal-opening-card":
          state = GameEngine.revealOpeningCard(state, at: try #require(action.cardIndex))
        case "choose-discard":
          state = GameEngine.chooseDiscard(state)
        case "cancel-discard":
          state = GameEngine.cancelDiscardSelection(state)
        case "draw-blind":
          var random = SeededRandom(seed: action.randomSeed ?? 0)
          state = GameEngine.drawBlind(state, random: &random)
        case "replace-card":
          state = GameEngine.replaceCard(state, at: try #require(action.cardIndex))
        case "discard-and-reveal":
          state = GameEngine.discardDrawnAndReveal(state, at: try #require(action.cardIndex))
        case "start-next-round":
          var random = SeededRandom(seed: try #require(action.randomSeed))
          state = GameEngine.startNextRound(state, random: &random)
        default:
          Issue.record("Unknown fixture action \(action.type)")
        }
        #expect(
          state == scenario.expectedStates[step],
          Comment(rawValue: "\(scenario.name), step \(step + 1): \(action.type)")
        )
      }
    }
  }

  @Test("Easy, Medium, Hard, and Ultra decisions match strategy version 1")
  func aiDecisions() throws {
    let fixture = try DomainFixture.load()
    #expect(fixture.aiStrategyVersion == SkyjoRules.strategyVersion)
    #expect(Set(fixture.aiCases.map(\.difficulty)) == Set(AIDifficulty.allCases))
    for testCase in fixture.aiCases {
      let actual = SkyjoAI.chooseMove(
        testCase.knowledge,
        options: AIDecisionOptions(
          playerId: testCase.playerId,
          difficulty: testCase.difficulty,
          decisionKey: testCase.decisionKey
        )
      )
      #expect(actual == testCase.expectedMove, Comment(rawValue: testCase.name))
    }
  }

  @Test("Authoritative-state projection matches drawer-specific redaction")
  func aiProjection() throws {
    let fixture = try DomainFixture.load()
    for testCase in fixture.redactionCases {
      let actual = AIProjection.knowledge(
        from: testCase.authoritativeState,
        playerId: testCase.viewerId
      )
      #expect(actual == testCase.expectedKnowledge, Comment(rawValue: testCase.name))
      let publicSnapshot = GameRedactor.project(
        testCase.authoritativeState,
        viewerPlayerId: testCase.viewerId
      )
      #expect(
        publicSnapshot == testCase.expectedPublicSnapshot,
        Comment(rawValue: testCase.name)
      )
      try publicSnapshot.validate(viewerPlayerId: testCase.viewerId)
      let encoded = String(decoding: try JSONEncoder().encode(publicSnapshot), as: UTF8.self)
      #expect(!encoded.contains("-card-"), Comment(rawValue: testCase.name))
      #expect(!encoded.contains("private-draw"), Comment(rawValue: testCase.name))
      for (playerIndex, player) in publicSnapshot.players.enumerated() {
        for (cardIndex, card) in player.grid.enumerated() {
          #expect(card.id == "grid-\(playerIndex)-\(cardIndex)")
          if !card.faceUp && !card.removed { #expect(card.value == nil) }
        }
      }
    }
  }

  @Test("Mixed assignments and all fixed profiles match 1-7 bot fixtures")
  func soloSetups() throws {
    let fixture = try DomainFixture.load()
    let games = Dictionary(uniqueKeysWithValues: fixture.seededGames.map { ($0.name, $0.expectedState) })
    for testCase in fixture.soloSetupCases {
      let game = try #require(games[testCase.seededGame])
      #expect(
        game.players.filter { $0.kind == .ai }.map(\.id).sorted() == testCase.aiPlayerIds
      )
      let actual = try SoloAISetup.resolve(
        testCase.inputSetup,
        state: game,
        gameId: testCase.gameId
      )
      #expect(actual == testCase.expectedSetup, Comment(rawValue: testCase.name))
      #expect(SoloAISetup.isResolved(actual, state: game))
      for playerID in testCase.aiPlayerIds {
        #expect(
          try SoloAISetup.difficulty(for: playerID, in: actual)
            == testCase.expectedSetup.playerDifficulties?[playerID]
              ?? testCase.expectedSetup.difficulty.fixedDifficulty
        )
      }
    }
  }
}

private struct DomainFixture: Decodable {
  let contractVersion: Int
  let domainRulesVersion: Int
  let aiStrategyVersion: Int
  let seededGames: [SeededGameCase]
  let scenarios: [RuleScenario]
  let aiCases: [AICase]
  let redactionCases: [RedactionCase]
  let soloSetupCases: [SoloSetupCase]

  static func load() throws -> DomainFixture {
    var repositoryRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<5 { repositoryRoot.deleteLastPathComponent() }
    let fixtureURL = repositoryRoot
      .appendingPathComponent("contracts/v1/fixtures/domain-parity.json")
    let fixture = try JSONDecoder().decode(DomainFixture.self, from: Data(contentsOf: fixtureURL))
    #expect(fixture.contractVersion == 1)
    #expect(fixture.domainRulesVersion == 1)
    return fixture
  }
}

private struct SeededGameCase: Decodable {
  let name: String
  let input: SeededGameInput
  let expectedState: GameState
}

private struct SeededGameInput: Decodable {
  enum Kind: String, Decodable { case solo, multiplayer }
  let kind: Kind
  let seed: UInt32
  let aiOpponentCount: Int?
  let players: [FixturePlayer]?
  let round: Int?
  let previousCloserId: String?
}

private struct FixturePlayer: Decodable {
  let id: String
  let name: String
}

private struct RuleScenario: Decodable {
  let name: String
  let initialState: GameState
  let actions: [FixtureAction]
  let expectedStates: [GameState]
}

private struct FixtureAction: Decodable {
  let type: String
  let cardIndex: Int?
  let randomSeed: UInt32?
}

private struct AICase: Decodable {
  let name: String
  let difficulty: AIDifficulty
  let decisionKey: String
  let playerId: String
  let knowledge: AIKnowledgeState
  let expectedMove: AIMove
}

private struct RedactionCase: Decodable {
  let name: String
  let viewerId: String
  let authoritativeState: GameState
  let expectedKnowledge: AIKnowledgeState
  let expectedPublicSnapshot: PublicGameStateSnapshot
}

private struct SoloSetupCase: Decodable {
  let name: String
  let seededGame: String
  let aiPlayerIds: [String]
  let gameId: String
  let inputSetup: SoloGameSetup
  let expectedSetup: SoloGameSetup
}
