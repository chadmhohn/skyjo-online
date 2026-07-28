import Foundation
import SkyjoDomain
import SwiftData
import Testing

@testable import SkyjoPersistence

enum PersistenceTestSupport {
  static let guestGameID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
  static let secondGameID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
  static let aliceID = UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!
  static let bobID = UUID(uuidString: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!

  static func activeState(aiOpponentCount: Int = 1) throws -> GameState {
    let fixture = try DomainFixture.load()
    return try #require(fixture.seededGames.first(where: {
      $0.input.kind == .solo && $0.input.aiOpponentCount == aiOpponentCount
    })?.expectedState)
  }

  static func terminalState() throws -> GameState {
    try completedGame().terminal
  }

  static func completedGame(aiOpponentCount: Int = 2) throws -> (initial: GameState, terminal: GameState) {
    var openingRandom = SeededRandom(seed: 7_000 + UInt32(aiOpponentCount))
    let initial = GameEngine.startFreshGame(
      aiOpponentCount: aiOpponentCount,
      random: &openingRandom
    )
    var state = initial
    for roundAttempt in 0..<20 {
      var turnRandom = SeededRandom(seed: 10_000 + UInt32(roundAttempt * 97 + aiOpponentCount))
      for _ in 0..<500 {
        if state.phase == .roundOver || state.phase == .gameOver { break }
        state = advance(state, random: &turnRandom)
      }
      if state.phase == .gameOver { return (initial, state) }
      guard state.phase == .roundOver else { break }
      var nextRoundRandom = SeededRandom(seed: 20_000 + UInt32(roundAttempt * 131 + aiOpponentCount))
      state = GameEngine.startNextRound(state, random: &nextRoundRandom)
    }
    Issue.record("Deterministic solo transcript did not reach game over")
    return (initial, state)
  }

  static func setup(for state: GameState, gameID: UUID) throws -> SoloGameSetup {
    let count = state.players.filter { $0.kind == .ai }.count
    return try SoloAISetup.resolve(
      SoloGameSetup(aiOpponentCount: count, difficulty: .hard),
      state: state,
      gameId: gameID.uuidString.lowercased()
    )
  }

  static func store(
    environment: SoloPersistenceEnvironment = SoloPersistenceEnvironment()
  ) throws -> (ModelContainer, SoloPersistenceStore) {
    let container = try SkyjoPersistenceContainer.makeInMemory()
    return (container, SoloPersistenceStore(modelContainer: container, environment: environment))
  }

  static func temporaryStoreURL() throws -> (directory: URL, store: URL) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("SkyjoPersistenceTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return (directory, directory.appendingPathComponent("Skyjo.store"))
  }

  private static func advance<R: SkyjoRandomNumberGenerator>(
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
}

private struct DomainFixture: Decodable {
  let seededGames: [SeededGameCase]

  static func load() throws -> DomainFixture {
    var repositoryRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<5 { repositoryRoot.deleteLastPathComponent() }
    let fixtureURL = repositoryRoot
      .appendingPathComponent("contracts/v1/fixtures/domain-parity.json")
    return try JSONDecoder().decode(DomainFixture.self, from: Data(contentsOf: fixtureURL))
  }
}

private struct SeededGameCase: Decodable {
  let input: SeededGameInput
  let expectedState: GameState
}

private struct SeededGameInput: Decodable {
  enum Kind: String, Decodable { case solo, multiplayer }
  let kind: Kind
  let aiOpponentCount: Int?
}
