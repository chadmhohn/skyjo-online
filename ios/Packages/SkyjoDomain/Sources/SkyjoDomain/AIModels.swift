import Foundation

public struct AIKnowledgeCard: Codable, Equatable, Sendable {
  public var faceUp: Bool
  public var removed: Bool
  public var value: Int?

  public init(faceUp: Bool, removed: Bool, value: Int?) {
    self.faceUp = faceUp
    self.removed = removed
    self.value = value
  }
}

public struct AIKnowledgePlayer: Codable, Equatable, Sendable {
  public var id: String
  public var totalScore: Int
  public var grid: [AIKnowledgeCard]

  public init(id: String, totalScore: Int, grid: [AIKnowledgeCard]) {
    self.id = id
    self.totalScore = totalScore
    self.grid = grid
  }
}

public struct AIKnowledgeState: Codable, Equatable, Sendable {
  public var players: [AIKnowledgePlayer]
  public var currentPlayerIndex: Int
  public var phase: TurnPhase
  public var selectedSource: SelectedSource?
  public var drawnCardValue: Int?
  public var discardTopValue: Int?
  public var discardPileCount: Int
  public var drawPileCount: Int
  public var knownValues: [Int]
  public var roundCloserId: String?
  public var finalTurnPlayerIds: [String]

  public init(
    players: [AIKnowledgePlayer],
    currentPlayerIndex: Int,
    phase: TurnPhase,
    selectedSource: SelectedSource? = nil,
    drawnCardValue: Int? = nil,
    discardTopValue: Int? = nil,
    discardPileCount: Int,
    drawPileCount: Int,
    knownValues: [Int],
    roundCloserId: String? = nil,
    finalTurnPlayerIds: [String] = []
  ) {
    self.players = players
    self.currentPlayerIndex = currentPlayerIndex
    self.phase = phase
    self.selectedSource = selectedSource
    self.drawnCardValue = drawnCardValue
    self.discardTopValue = discardTopValue
    self.discardPileCount = discardPileCount
    self.drawPileCount = drawPileCount
    self.knownValues = knownValues
    self.roundCloserId = roundCloserId
    self.finalTurnPlayerIds = finalTurnPlayerIds
  }
}

public enum AIMoveAction: String, Codable, CaseIterable, Sendable {
  case discard
  case draw
  case replace
  case reveal
}

public struct AIMove: Codable, Equatable, Sendable {
  public var action: AIMoveAction
  public var index: Int?

  public init(action: AIMoveAction, index: Int? = nil) {
    self.action = action
    self.index = index
  }
}

public struct AIDecisionOptions: Codable, Equatable, Sendable {
  public var playerId: String
  public var difficulty: AIDifficulty
  public var decisionKey: String

  public init(playerId: String, difficulty: AIDifficulty, decisionKey: String) {
    self.playerId = playerId
    self.difficulty = difficulty
    self.decisionKey = decisionKey
  }
}

public enum AIProjection {
  public static func knowledge(from state: GameState, playerId: String) -> AIKnowledgeState {
    var seenIDs: Set<String> = []
    var knownValues: [Int] = []
    func remember(_ card: Card) {
      guard seenIDs.insert(card.id).inserted else { return }
      knownValues.append(card.value)
    }

    for player in state.players {
      for card in player.grid where card.faceUp || card.removed { remember(card) }
    }
    for card in state.discardPile { remember(card) }
    let currentPlayer = state.players.indices.contains(state.currentPlayerIndex)
      ? state.players[state.currentPlayerIndex]
      : nil
    let maySeeDrawnCard = currentPlayer?.id == playerId
    if maySeeDrawnCard, let drawnCard = state.drawnCard { remember(drawnCard) }

    return AIKnowledgeState(
      players: state.players.map { player in
        AIKnowledgePlayer(
          id: player.id,
          totalScore: player.totalScore,
          grid: player.grid.map { card in
            AIKnowledgeCard(
              faceUp: card.faceUp,
              removed: card.removed,
              value: card.faceUp || card.removed ? card.value : nil
            )
          }
        )
      },
      currentPlayerIndex: state.currentPlayerIndex,
      phase: state.phase,
      selectedSource: state.selectedSource,
      drawnCardValue: maySeeDrawnCard ? state.drawnCard?.value : nil,
      discardTopValue: state.discardPile.first?.value,
      discardPileCount: state.discardPile.count,
      drawPileCount: state.drawPile.count,
      knownValues: knownValues,
      roundCloserId: state.roundCloserId,
      finalTurnPlayerIds: state.finalTurnPlayerIds
    )
  }
}
