import Foundation

public enum SkyjoRules {
  public static let rows = 3
  public static let columns = 4
  public static let winningScore = 100
  public static let strategyVersion = 1
  public static let cardValueCounts: [(value: Int, count: Int)] = [
    (-2, 5),
    (-1, 10),
    (0, 15),
  ] + (1...12).map { ($0, 10) }
  public static let deckCardCount = cardValueCounts.reduce(0) { $0 + $1.count }
  public static let deckValueTotal = cardValueCounts.reduce(0) { $0 + $1.value * $1.count }
  public static let defaultHiddenCardEstimate =
    Double(deckValueTotal) / Double(deckCardCount)

  public static func columnIndexes(for cardIndex: Int) -> [Int] {
    let column = cardIndex % columns
    return [column, column + columns, column + columns * 2]
  }
}

public struct Card: Codable, Equatable, Hashable, Sendable, CustomDebugStringConvertible {
  public var id: String
  public var value: Int
  public var faceUp: Bool
  public var removed: Bool

  public init(id: String, value: Int, faceUp: Bool = false, removed: Bool = false) {
    self.id = id
    self.value = value
    self.faceUp = faceUp
    self.removed = removed
  }

  public var debugDescription: String {
    let publicValue = faceUp || removed ? String(value) : "hidden"
    return "Card(id: <redacted>, value: \(publicValue), faceUp: \(faceUp), removed: \(removed))"
  }
}

public enum PlayerKind: String, Codable, CaseIterable, Sendable {
  case human
  case ai
}

public struct Player: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var kind: PlayerKind
  public var grid: [Card]
  public var totalScore: Int
  public var roundScore: Int

  public init(
    id: String,
    name: String,
    kind: PlayerKind,
    grid: [Card],
    totalScore: Int = 0,
    roundScore: Int = 0
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.grid = grid
    self.totalScore = totalScore
    self.roundScore = roundScore
  }
}

public struct PlayerSeed: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var kind: PlayerKind
  public var totalScore: Int?

  public init(id: String, name: String, kind: PlayerKind, totalScore: Int? = nil) {
    self.id = id
    self.name = name
    self.kind = kind
    self.totalScore = totalScore
  }
}

public enum TurnPhase: String, Codable, CaseIterable, Sendable {
  case openingReveal = "opening-reveal"
  case chooseSource = "choose-source"
  case chooseReplacement = "choose-replacement"
  case roundOver = "round-over"
  case gameOver = "game-over"
}

public enum SelectedSource: String, Codable, CaseIterable, Sendable {
  case draw
  case discard
}

public struct RoundScore: Codable, Equatable, Sendable {
  public var playerId: String
  public var name: String
  public var roundScore: Int
  public var totalScore: Int

  public init(playerId: String, name: String, roundScore: Int, totalScore: Int) {
    self.playerId = playerId
    self.name = name
    self.roundScore = roundScore
    self.totalScore = totalScore
  }
}

public struct RoundHistoryEntry: Codable, Equatable, Sendable {
  public var round: Int
  public var closerId: String
  public var scores: [RoundScore]

  public init(round: Int, closerId: String, scores: [RoundScore]) {
    self.round = round
    self.closerId = closerId
    self.scores = scores
  }
}

public struct GameState: Codable, Equatable, Sendable {
  public var players: [Player]
  public var drawPile: [Card]
  public var discardPile: [Card]
  public var currentPlayerIndex: Int
  public var phase: TurnPhase
  public var selectedSource: SelectedSource?
  public var drawnCard: Card?
  public var round: Int
  public var log: [String]
  public var winnerId: String?
  public var nextStarterId: String?
  public var roundCloserId: String?
  public var finalTurnPlayerIds: [String]
  public var openingRevealCounts: [String: Int]
  public var roundHistory: [RoundHistoryEntry]

  public init(
    players: [Player],
    drawPile: [Card],
    discardPile: [Card],
    currentPlayerIndex: Int,
    phase: TurnPhase,
    selectedSource: SelectedSource? = nil,
    drawnCard: Card? = nil,
    round: Int = 1,
    log: [String] = [],
    winnerId: String? = nil,
    nextStarterId: String? = nil,
    roundCloserId: String? = nil,
    finalTurnPlayerIds: [String] = [],
    openingRevealCounts: [String: Int] = [:],
    roundHistory: [RoundHistoryEntry] = []
  ) {
    self.players = players
    self.drawPile = drawPile
    self.discardPile = discardPile
    self.currentPlayerIndex = currentPlayerIndex
    self.phase = phase
    self.selectedSource = selectedSource
    self.drawnCard = drawnCard
    self.round = round
    self.log = log
    self.winnerId = winnerId
    self.nextStarterId = nextStarterId
    self.roundCloserId = roundCloserId
    self.finalTurnPlayerIds = finalTurnPlayerIds
    self.openingRevealCounts = openingRevealCounts
    self.roundHistory = roundHistory
  }

  private enum CodingKeys: String, CodingKey {
    case players, drawPile, discardPile, currentPlayerIndex, phase, selectedSource, drawnCard
    case round, log, winnerId, nextStarterId, roundCloserId, finalTurnPlayerIds
    case openingRevealCounts, roundHistory
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(players, forKey: .players)
    try container.encode(drawPile, forKey: .drawPile)
    try container.encode(discardPile, forKey: .discardPile)
    try container.encode(currentPlayerIndex, forKey: .currentPlayerIndex)
    try container.encode(phase, forKey: .phase)
    try container.encode(selectedSource, forKey: .selectedSource)
    try container.encode(drawnCard, forKey: .drawnCard)
    try container.encode(round, forKey: .round)
    try container.encode(log, forKey: .log)
    try container.encode(winnerId, forKey: .winnerId)
    try container.encode(nextStarterId, forKey: .nextStarterId)
    try container.encode(roundCloserId, forKey: .roundCloserId)
    try container.encode(finalTurnPlayerIds, forKey: .finalTurnPlayerIds)
    try container.encode(openingRevealCounts, forKey: .openingRevealCounts)
    try container.encode(roundHistory, forKey: .roundHistory)
  }
}

public enum GameAction: Equatable, Sendable {
  case revealOpeningCard(Int)
  case chooseDiscard
  case cancelDiscard
  case drawBlind
  case replaceCard(Int)
  case discardAndReveal(Int)
}
