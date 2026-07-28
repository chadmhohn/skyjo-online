import Foundation

private func publicUTF16Prefix(_ value: String, maximumCodeUnits: Int) -> String {
  guard value.utf16.count > maximumCodeUnits else { return value }
  var codeUnits = Array(value.utf16.prefix(maximumCodeUnits))
  if let finalCodeUnit = codeUnits.last,
     (0xD800...0xDBFF).contains(Int(finalCodeUnit)) {
    codeUnits.removeLast()
  }
  return String(decoding: codeUnits, as: UTF16.self)
}

private func isPublicCardIdentifierShape(_ value: String) -> Bool {
  if value == "discard-top" || value == "drawn-card" { return true }
  let components = value.split(separator: "-", omittingEmptySubsequences: false)
  guard components.count == 3, components[0] == "grid" else { return false }
  return components[1].utf8.allSatisfy { (48...57).contains($0) }
    && !components[1].isEmpty
    && components[2].utf8.allSatisfy { (48...57).contains($0) }
    && !components[2].isEmpty
}

public enum PublicSnapshotError: Error, Equatable, Sendable {
  case missingValueKey
  case hiddenValueLeak
  case invalidCardValue
  case invalidCardIdentifier
  case invalidGridSize
  case invalidCurrentPlayer
  case invalidDrawnCardVisibility
  case invalidCount
}

public struct PublicCardSnapshot: Codable, Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let id: String
  public let value: Int?
  public let faceUp: Bool
  public let removed: Bool

  public init(id: String, value: Int?, faceUp: Bool, removed: Bool) {
    self.id = id
    self.value = faceUp ? value : nil
    self.faceUp = faceUp
    self.removed = removed
  }

  private enum CodingKeys: String, CodingKey { case id, value, faceUp, removed }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard container.contains(.value) else { throw PublicSnapshotError.missingValueKey }
    let decodedID = try container.decode(String.self, forKey: .id)
    guard isPublicCardIdentifierShape(decodedID) else {
      throw PublicSnapshotError.invalidCardIdentifier
    }
    id = decodedID
    faceUp = try container.decode(Bool.self, forKey: .faceUp)
    removed = try container.decode(Bool.self, forKey: .removed)
    let decodedValue = try container.decodeIfPresent(Int.self, forKey: .value)
    guard decodedValue == nil || (-2...12).contains(decodedValue!) else {
      throw PublicSnapshotError.invalidCardValue
    }
    guard faceUp || decodedValue == nil else { throw PublicSnapshotError.hiddenValueLeak }
    guard !faceUp || decodedValue != nil else { throw PublicSnapshotError.invalidCardValue }
    value = decodedValue
  }

  public func encode(to encoder: Encoder) throws {
    guard isPublicCardIdentifierShape(id) else {
      throw PublicSnapshotError.invalidCardIdentifier
    }
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(faceUp ? value : nil, forKey: .value)
    try container.encode(faceUp, forKey: .faceUp)
    try container.encode(removed, forKey: .removed)
  }

  public var description: String { debugDescription }

  public var debugDescription: String {
    "PublicCardSnapshot(id: <redacted>, value: <redacted>, faceUp: \(faceUp), removed: \(removed))"
  }
}

public struct PublicPlayerSnapshot: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let kind: PlayerKind
  public let grid: [PublicCardSnapshot]
  public let totalScore: Int
  public let roundScore: Int

  public init(
    id: String,
    name: String,
    kind: PlayerKind,
    grid: [PublicCardSnapshot],
    totalScore: Int,
    roundScore: Int
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.grid = grid
    self.totalScore = totalScore
    self.roundScore = roundScore
  }
}

public struct PublicDiscardPileSnapshot: Codable, Equatable, Sendable {
  public let count: Int
  public let top: PublicCardSnapshot?

  public init(count: Int, top: PublicCardSnapshot?) {
    self.count = count
    self.top = top
  }

  private enum CodingKeys: String, CodingKey { case count, top }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(count, forKey: .count)
    try container.encode(top, forKey: .top)
  }
}

public struct PublicGameStateSnapshot: Codable, Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let players: [PublicPlayerSnapshot]
  public let drawPileCount: Int
  public let discardPile: PublicDiscardPileSnapshot
  public let currentPlayerIndex: Int
  public let phase: TurnPhase
  public let selectedSource: SelectedSource?
  public let hasDrawnCard: Bool
  public let drawnCard: PublicCardSnapshot?
  public let round: Int
  public let log: [String]
  public let winnerId: String?
  public let nextStarterId: String?
  public let roundCloserId: String?
  public let finalTurnPlayerIds: [String]
  public let openingRevealCounts: [String: Int]
  public let roundHistory: [RoundHistoryEntry]

  public init(
    players: [PublicPlayerSnapshot],
    drawPileCount: Int,
    discardPile: PublicDiscardPileSnapshot,
    currentPlayerIndex: Int,
    phase: TurnPhase,
    selectedSource: SelectedSource?,
    hasDrawnCard: Bool,
    drawnCard: PublicCardSnapshot?,
    round: Int,
    log: [String],
    winnerId: String?,
    nextStarterId: String?,
    roundCloserId: String?,
    finalTurnPlayerIds: [String],
    openingRevealCounts: [String: Int],
    roundHistory: [RoundHistoryEntry]
  ) {
    self.players = players
    self.drawPileCount = drawPileCount
    self.discardPile = discardPile
    self.currentPlayerIndex = currentPlayerIndex
    self.phase = phase
    self.selectedSource = selectedSource
    self.hasDrawnCard = hasDrawnCard
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

  public var description: String { debugDescription }

  public var debugDescription: String {
    "PublicGameStateSnapshot(<redacted>, playerCount: \(players.count), phase: \(phase.rawValue), hasDrawnCard: \(hasDrawnCard))"
  }

  public func validate(viewerPlayerId: String? = nil) throws {
    guard (1...8).contains(players.count), players.indices.contains(currentPlayerIndex) else {
      throw PublicSnapshotError.invalidCurrentPlayer
    }
    guard players.allSatisfy({ $0.grid.count == 12 }) else {
      throw PublicSnapshotError.invalidGridSize
    }
    try validateCardIdentifiers()
    guard (0...150).contains(drawPileCount),
          (0...150).contains(discardPile.count),
          discardPile.count == 0 ? discardPile.top == nil : discardPile.top != nil
    else { throw PublicSnapshotError.invalidCount }
    guard hasDrawnCard == (phase == .chooseReplacement && selectedSource == .draw) else {
      throw PublicSnapshotError.invalidDrawnCardVisibility
    }
    guard hasDrawnCard || drawnCard == nil else {
      throw PublicSnapshotError.invalidDrawnCardVisibility
    }
    let activeID = players[currentPlayerIndex].id
    if let viewerPlayerId {
      let viewerShouldSeeDrawnCard = hasDrawnCard && activeID == viewerPlayerId
      guard viewerShouldSeeDrawnCard == (drawnCard != nil),
            drawnCard == nil || drawnCard?.value != nil
      else {
        throw PublicSnapshotError.invalidDrawnCardVisibility
      }
    } else if drawnCard != nil {
      throw PublicSnapshotError.invalidDrawnCardVisibility
    }
  }

  private enum CodingKeys: String, CodingKey {
    case players, drawPileCount, discardPile, currentPlayerIndex, phase, selectedSource
    case hasDrawnCard, drawnCard, round, log, winnerId, nextStarterId, roundCloserId
    case finalTurnPlayerIds, openingRevealCounts, roundHistory
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    players = try container.decode([PublicPlayerSnapshot].self, forKey: .players)
    drawPileCount = try container.decode(Int.self, forKey: .drawPileCount)
    discardPile = try container.decode(PublicDiscardPileSnapshot.self, forKey: .discardPile)
    currentPlayerIndex = try container.decode(Int.self, forKey: .currentPlayerIndex)
    phase = try container.decode(TurnPhase.self, forKey: .phase)
    selectedSource = try container.decodeIfPresent(SelectedSource.self, forKey: .selectedSource)
    hasDrawnCard = try container.decode(Bool.self, forKey: .hasDrawnCard)
    drawnCard = try container.decodeIfPresent(PublicCardSnapshot.self, forKey: .drawnCard)
    round = try container.decode(Int.self, forKey: .round)
    log = try container.decode([String].self, forKey: .log)
    winnerId = try container.decodeIfPresent(String.self, forKey: .winnerId)
    nextStarterId = try container.decodeIfPresent(String.self, forKey: .nextStarterId)
    roundCloserId = try container.decodeIfPresent(String.self, forKey: .roundCloserId)
    finalTurnPlayerIds = try container.decode([String].self, forKey: .finalTurnPlayerIds)
    openingRevealCounts = try container.decode([String: Int].self, forKey: .openingRevealCounts)
    roundHistory = try container.decode([RoundHistoryEntry].self, forKey: .roundHistory)
    try validateCardIdentifiers()
  }

  public func encode(to encoder: Encoder) throws {
    try validateCardIdentifiers()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(players, forKey: .players)
    try container.encode(drawPileCount, forKey: .drawPileCount)
    try container.encode(discardPile, forKey: .discardPile)
    try container.encode(currentPlayerIndex, forKey: .currentPlayerIndex)
    try container.encode(phase, forKey: .phase)
    try container.encode(selectedSource, forKey: .selectedSource)
    try container.encode(hasDrawnCard, forKey: .hasDrawnCard)
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

  private func validateCardIdentifiers() throws {
    for (playerIndex, player) in players.enumerated() {
      for (cardIndex, card) in player.grid.enumerated() {
        guard card.id == "grid-\(playerIndex)-\(cardIndex)" else {
          throw PublicSnapshotError.invalidCardIdentifier
        }
      }
    }
    guard discardPile.top == nil || discardPile.top?.id == "discard-top",
          drawnCard == nil || drawnCard?.id == "drawn-card"
    else {
      throw PublicSnapshotError.invalidCardIdentifier
    }
  }
}

public enum GameRedactor {
  public static func hasPrivateDrawnCardVisibility(
    _ state: GameState?,
    viewerPlayerId: String
  ) -> Bool {
    guard let state,
          state.selectedSource == .draw,
          state.drawnCard != nil,
          state.players.indices.contains(state.currentPlayerIndex)
    else { return false }
    return state.players[state.currentPlayerIndex].id == viewerPlayerId
  }

  public static func project(
    _ state: GameState,
    viewerPlayerId: String
  ) -> PublicGameStateSnapshot {
    let viewerMaySeeDrawnCard = hasPrivateDrawnCardVisibility(
      state,
      viewerPlayerId: viewerPlayerId
    )
    let logs = state.log.prefix(8).map { entry in
      let redacted = entry.replacingOccurrences(
        of: #"^(.+) drew a -?\d+\.$"#,
        with: "$1 drew a blind card.",
        options: .regularExpression
      )
      return publicUTF16Prefix(redacted, maximumCodeUnits: 320)
    }
    let discardTop = state.discardPile.first.map {
      publicCard($0, id: "discard-top", reveal: true)
    }
    return PublicGameStateSnapshot(
      players: state.players.enumerated().map { playerIndex, player in
        PublicPlayerSnapshot(
          id: player.id,
          name: publicUTF16Prefix(player.name, maximumCodeUnits: 24),
          kind: player.kind,
          grid: player.grid.enumerated().map { cardIndex, card in
            publicCard(
              card,
              id: "grid-\(playerIndex)-\(cardIndex)",
              reveal: card.faceUp || card.removed
            )
          },
          totalScore: player.totalScore,
          roundScore: player.roundScore
        )
      },
      drawPileCount: state.drawPile.count,
      discardPile: PublicDiscardPileSnapshot(count: state.discardPile.count, top: discardTop),
      currentPlayerIndex: state.currentPlayerIndex,
      phase: state.phase,
      selectedSource: state.selectedSource,
      hasDrawnCard: state.drawnCard != nil,
      drawnCard: viewerMaySeeDrawnCard
        ? state.drawnCard.map { publicCard($0, id: "drawn-card", reveal: true) }
        : nil,
      round: state.round,
      log: logs,
      winnerId: state.winnerId,
      nextStarterId: state.nextStarterId,
      roundCloserId: state.roundCloserId,
      finalTurnPlayerIds: state.finalTurnPlayerIds,
      openingRevealCounts: state.openingRevealCounts,
      roundHistory: state.roundHistory.suffix(100).map { entry in
        RoundHistoryEntry(
          round: entry.round,
          closerId: entry.closerId,
          scores: entry.scores.map { score in
            RoundScore(
              playerId: score.playerId,
              name: publicUTF16Prefix(score.name, maximumCodeUnits: 24),
              roundScore: score.roundScore,
              totalScore: score.totalScore
            )
          }
        )
      }
    )
  }

  private static func publicCard(_ card: Card, id: String, reveal: Bool) -> PublicCardSnapshot {
    PublicCardSnapshot(
      id: id,
      value: reveal && card.faceUp ? card.value : nil,
      faceUp: card.faceUp,
      removed: card.removed
    )
  }
}
