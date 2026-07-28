import Foundation

public enum AIDifficulty: String, Codable, CaseIterable, Sendable {
  case easy
  case medium
  case hard
  case ultra
}

public enum SoloAIDifficultySelection: String, Codable, CaseIterable, Sendable {
  case easy
  case medium
  case hard
  case ultra
  case mixed

  public var fixedDifficulty: AIDifficulty? {
    AIDifficulty(rawValue: rawValue)
  }
}

public struct SoloGameSetup: Codable, Equatable, Sendable {
  public var aiOpponentCount: Int
  public var difficulty: SoloAIDifficultySelection
  public var strategyVersion: Int?
  public var playerDifficulties: [String: AIDifficulty]?

  public init(
    aiOpponentCount: Int,
    difficulty: SoloAIDifficultySelection = .hard,
    strategyVersion: Int? = SkyjoRules.strategyVersion,
    playerDifficulties: [String: AIDifficulty]? = nil
  ) {
    self.aiOpponentCount = aiOpponentCount
    self.difficulty = difficulty
    self.strategyVersion = strategyVersion
    self.playerDifficulties = playerDifficulties
  }
}

public enum SoloAISetupError: Error, Equatable, Sendable {
  case invalidOpponentCount
  case rosterMismatch
  case unsupportedStrategyVersion
  case fixedSetupContainsAssignments
  case mixedAssignmentsMissing
  case mixedAssignmentsRosterMismatch
  case mixedAssignmentsUnbalanced
  case missingPlayerDifficulty(String)
}

public enum SoloAISetup {
  public static func create(
    aiOpponentCount: Int,
    difficulty: SoloAIDifficultySelection = .hard
  ) throws -> SoloGameSetup {
    try validateOpponentCount(aiOpponentCount)
    return SoloGameSetup(aiOpponentCount: aiOpponentCount, difficulty: difficulty)
  }

  public static func resolve(
    _ setup: SoloGameSetup,
    state: GameState,
    gameId: String
  ) throws -> SoloGameSetup {
    let playerIDs = try soloAIPlayerIDs(state, count: setup.aiOpponentCount)
    if let version = setup.strategyVersion, version != SkyjoRules.strategyVersion {
      throw SoloAISetupError.unsupportedStrategyVersion
    }
    guard setup.difficulty == .mixed else {
      guard setup.playerDifficulties == nil else {
        throw SoloAISetupError.fixedSetupContainsAssignments
      }
      return SoloGameSetup(
        aiOpponentCount: setup.aiOpponentCount,
        difficulty: setup.difficulty,
        strategyVersion: SkyjoRules.strategyVersion
      )
    }

    let assignments = setup.playerDifficulties
      ?? createMixedAssignments(gameId: gameId, playerIDs: playerIDs)
    try validateMixedAssignments(assignments, playerIDs: playerIDs)
    return SoloGameSetup(
      aiOpponentCount: setup.aiOpponentCount,
      difficulty: .mixed,
      strategyVersion: SkyjoRules.strategyVersion,
      playerDifficulties: assignments
    )
  }

  public static func isResolved(_ setup: SoloGameSetup, state: GameState) -> Bool {
    do {
      let playerIDs = try soloAIPlayerIDs(state, count: setup.aiOpponentCount)
      if let version = setup.strategyVersion, version != SkyjoRules.strategyVersion { return false }
      if setup.difficulty == .mixed {
        guard let assignments = setup.playerDifficulties else { return false }
        try validateMixedAssignments(assignments, playerIDs: playerIDs)
      } else if setup.playerDifficulties != nil {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  public static func difficulty(
    for playerID: String,
    in setup: SoloGameSetup
  ) throws -> AIDifficulty {
    if let fixed = setup.difficulty.fixedDifficulty { return fixed }
    guard let difficulty = setup.playerDifficulties?[playerID] else {
      throw SoloAISetupError.missingPlayerDifficulty(playerID)
    }
    return difficulty
  }

  private static func validateOpponentCount(_ count: Int) throws {
    guard GameEngine.singlePlayerAIOpponentRange.contains(count) else {
      throw SoloAISetupError.invalidOpponentCount
    }
  }

  private static func soloAIPlayerIDs(_ state: GameState, count: Int) throws -> [String] {
    try validateOpponentCount(count)
    let ids = state.players.filter { $0.kind == .ai }.map(\.id)
    guard ids.count == count, state.players.count == count + 1 else {
      throw SoloAISetupError.rosterMismatch
    }
    return ids.sorted()
  }

  private static func createMixedAssignments(
    gameId: String,
    playerIDs: [String]
  ) -> [String: AIDifficulty] {
    var shuffled = playerIDs
    var random = SeededRandom(
      seed: StableHash.fnv1a("\(gameId):\(playerIDs.joined(separator: ":")):\(SkyjoRules.strategyVersion)")
    )
    shuffled.skyjoShuffle(using: &random)
    let difficulties = AIDifficulty.allCases
    let offset = Swift.min(
      Int(random.nextUnitInterval() * Double(difficulties.count)),
      difficulties.count - 1
    )
    return Dictionary(uniqueKeysWithValues: shuffled.enumerated().map { index, playerID in
      (playerID, difficulties[(offset + index) % difficulties.count])
    })
  }

  private static func validateMixedAssignments(
    _ assignments: [String: AIDifficulty],
    playerIDs: [String]
  ) throws {
    guard assignments.keys.sorted() == playerIDs else {
      throw SoloAISetupError.mixedAssignmentsRosterMismatch
    }
    let counts = AIDifficulty.allCases.map { difficulty in
      assignments.values.filter { $0 == difficulty }.count
    }
    guard let minimum = counts.min(), let maximum = counts.max(), maximum - minimum <= 1 else {
      throw SoloAISetupError.mixedAssignmentsUnbalanced
    }
  }
}
