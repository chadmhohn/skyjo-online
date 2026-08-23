import Foundation

public enum GameEngine {
  public static let singlePlayerAIOpponentRange = 1...7
  public static let soloAIOpeningSeatDelayMilliseconds = 225
  public static let singlePlayerAINames = [
    "Acorn", "Alder", "Aster", "Aspen", "Birch", "Bramble", "Breeze", "Brook", "Canyon",
    "Cedar", "Clover", "Coral", "Cove", "Cypress", "Dahlia", "Dawn", "Dune", "Echo", "Elm",
    "Ember", "Fawn", "Fern", "Finch", "Fjord", "Flint", "Forest", "Gale", "Garnet", "Glade",
    "Harbor", "Hazel", "Heather", "Indigo", "Ivy", "Jade", "Juniper", "Kestrel", "Lake", "Lark",
    "Laurel", "Linden", "Lotus", "Maple", "Marigold", "Meadow", "Mica", "Mist", "Moss", "Moon",
    "Olive", "Onyx", "Opal", "Orchid", "Pebble", "Pine", "Poppy", "Prairie", "Quartz", "Rain",
    "Reef", "Ridge", "River", "Robin", "Rowan", "Ruby", "Sage", "Saffron", "Sequoia", "Sky",
    "Slate", "Sol", "Sparrow", "Spruce", "Starling", "Stone", "Storm", "Summit", "Sunny", "Terra",
    "Thistle", "Tide", "Topaz", "Vale", "Violet", "Willow", "Wren", "Zephyr",
  ]

  public static var defaultSinglePlayerAIOpponents: [PlayerSeed] {
    Array(singlePlayerAINames.prefix(7).enumerated()).map { index, name in
      PlayerSeed(id: "ai-\(index + 1)", name: name, kind: .ai)
    }
  }

  public static func normalizedSinglePlayerAIOpponentCount(_ count: Int) -> Int {
    min(singlePlayerAIOpponentRange.upperBound, max(singlePlayerAIOpponentRange.lowerBound, count))
  }

  public static func makeDeck<R: SkyjoRandomNumberGenerator>(using random: inout R) -> [Card] {
    var values: [Int] = []
    values.reserveCapacity(SkyjoRules.deckCardCount)
    for item in SkyjoRules.cardValueCounts {
      values.append(contentsOf: repeatElement(item.value, count: item.count))
    }
    var cards = values.enumerated().map { index, value in
      Card(id: "card-\(index)-\(value)", value: value)
    }
    cards.skyjoShuffle(using: &random)
    return cards
  }

  public static func createGameForPlayers<R: SkyjoRandomNumberGenerator>(
    _ seeds: [PlayerSeed],
    round: Int = 1,
    startPlayerId: String? = nil,
    autoRevealOpeningCards: Bool = true,
    random: inout R
  ) -> GameState {
    var deck = makeDeck(using: &random)
    var players: [Player] = []
    players.reserveCapacity(seeds.count)

    for seed in seeds {
      let dealt = makePlayer(
        seed: seed,
        deck: deck,
        autoRevealOpeningCards: autoRevealOpeningCards,
        random: &random
      )
      players.append(dealt.player)
      deck = dealt.deck
    }

    let openingIndex = firstPlayerNeedingOpeningReveal(players)
    let hasOpeningReveals = openingIndex == nil
    let currentPlayerIndex = hasOpeningReveals
      ? openingStarterIndex(players, startPlayerId: round > 1 ? startPlayerId : nil)
      : openingIndex ?? 0
    let starter = players[currentPlayerIndex]
    let discard = Card(
      id: deck[0].id,
      value: deck[0].value,
      faceUp: true,
      removed: deck[0].removed
    )

    return GameState(
      players: players,
      drawPile: Array(deck.dropFirst()),
      discardPile: [discard],
      currentPlayerIndex: currentPlayerIndex,
      phase: hasOpeningReveals ? .chooseSource : .openingReveal,
      round: round,
      log: [
        hasOpeningReveals
          ? "\(starter.name) starts round \(round). Pick from the discard pile or draw blind."
          : "\(starter.name): reveal 2 cards."
      ],
      nextStarterId: hasOpeningReveals ? nil : (round > 1 ? startPlayerId : nil),
      openingRevealCounts: openingRevealCounts(players)
    )
  }

  public static func createMultiplayerGame<R: SkyjoRandomNumberGenerator>(
    players: [PlayerSeed],
    round: Int = 1,
    startPlayerId: String? = nil,
    random: inout R
  ) -> GameState {
    createGameForPlayers(
      players.map {
        PlayerSeed(id: $0.id, name: $0.name, kind: .human, totalScore: $0.totalScore ?? 0)
      },
      round: round,
      startPlayerId: startPlayerId,
      autoRevealOpeningCards: false,
      random: &random
    )
  }

  public static func createSoloGame<R: SkyjoRandomNumberGenerator>(
    existingPlayers: [Player]? = nil,
    round: Int = 1,
    startPlayerId: String? = nil,
    aiOpponentCount: Int? = nil,
    random: inout R
  ) -> GameState {
    let previousScores = Dictionary(
      uniqueKeysWithValues: (existingPlayers ?? []).map { ($0.id, $0.totalScore) }
    )
    let seeds: [PlayerSeed]
    if let existingPlayers, !existingPlayers.isEmpty, aiOpponentCount == nil {
      seeds = existingPlayers.map {
        PlayerSeed(id: $0.id, name: $0.name, kind: $0.kind, totalScore: $0.totalScore)
      }
    } else {
      let inferredCount = existingPlayers?.filter { $0.kind == .ai }.count
      seeds = createSinglePlayerRoster(
        aiOpponentCount: aiOpponentCount ?? inferredCount ?? 1,
        previousScores: previousScores,
        random: &random
      )
    }
    return createGameForPlayers(
      seeds,
      round: round,
      startPlayerId: startPlayerId,
      autoRevealOpeningCards: false,
      random: &random
    )
  }

  public static func startFreshGame<R: SkyjoRandomNumberGenerator>(
    aiOpponentCount: Int = 1,
    random: inout R
  ) -> GameState {
    createSoloGame(aiOpponentCount: aiOpponentCount, random: &random)
  }

  public static func startNextRound<R: SkyjoRandomNumberGenerator>(
    _ state: GameState,
    random: inout R
  ) -> GameState {
    var next = createSoloGame(
      existingPlayers: state.players,
      round: state.round + 1,
      startPlayerId: state.nextStarterId,
      random: &random
    )
    next.roundHistory = state.roundHistory
    return next
  }

  public static func revealOpeningCard(_ state: GameState, at cardIndex: Int) -> GameState {
    guard state.phase == .openingReveal,
          state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].grid.indices.contains(cardIndex)
    else { return state }
    let player = state.players[state.currentPlayerIndex]
    let card = player.grid[cardIndex]
    let currentCount = openingRevealCount(player)
    guard !card.faceUp, !card.removed, currentCount < 2 else { return state }

    var nextPlayer = player
    nextPlayer.grid[cardIndex].faceUp = true
    nextPlayer.roundScore = visibleScore(nextPlayer.grid)
    var updated = updatePlayer(state, player: nextPlayer)
    updated.openingRevealCounts = openingRevealCounts(updated.players)

    if currentCount + 1 < 2 {
      return withLog(updated, "\(player.name) revealed an opening card.")
    }
    if let nextPlayerIndex = firstPlayerNeedingOpeningReveal(updated.players) {
      let nextPlayerName = updated.players[nextPlayerIndex].name
      updated.currentPlayerIndex = nextPlayerIndex
      return withLog(
        updated,
        "\(player.name) finished. \(nextPlayerName): reveal 2 cards."
      )
    }

    let starterIndex = openingStarterIndex(updated.players, startPlayerId: updated.nextStarterId)
    let starter = updated.players[starterIndex]
    updated.currentPlayerIndex = starterIndex
    updated.phase = .chooseSource
    updated.selectedSource = nil
    updated.drawnCard = nil
    updated.nextStarterId = nil
    return withLog(
      updated,
      "\(starter.name) starts round \(state.round). Pick from the discard pile or draw blind."
    )
  }

  public static func chooseDiscard(_ state: GameState) -> GameState {
    guard state.phase == .chooseSource else { return state }
    var next = state
    next.selectedSource = .discard
    next.phase = .chooseReplacement
    return next
  }

  public static func cancelDiscardSelection(_ state: GameState) -> GameState {
    guard state.phase == .chooseReplacement, state.selectedSource == .discard else { return state }
    var next = state
    next.selectedSource = nil
    next.drawnCard = nil
    next.phase = .chooseSource
    return next
  }

  public static func drawBlind<R: SkyjoRandomNumberGenerator>(
    _ state: GameState,
    random: inout R
  ) -> GameState {
    guard state.phase == .chooseSource,
          let result = drawCard(
            drawPile: state.drawPile,
            discardPile: state.discardPile,
            random: &random
          ),
          state.players.indices.contains(state.currentPlayerIndex)
    else { return state }
    var next = state
    next.drawPile = result.drawPile
    next.discardPile = result.discardPile
    next.drawnCard = result.card
    next.selectedSource = .draw
    next.phase = .chooseReplacement
    return withLog(next, "\(state.players[state.currentPlayerIndex].name) drew a blind card.")
  }

  public static func replaceCard(_ state: GameState, at cardIndex: Int) -> GameState {
    guard state.phase == .chooseReplacement,
          let selectedSource = state.selectedSource,
          state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].grid.indices.contains(cardIndex)
    else { return state }
    let player = state.players[state.currentPlayerIndex]
    let oldCard = player.grid[cardIndex]
    guard !oldCard.removed else { return state }

    let replacement: Card
    var remainingDiscard = state.discardPile
    switch selectedSource {
    case .discard:
      guard !remainingDiscard.isEmpty else { return state }
      replacement = remainingDiscard.removeFirst()
    case .draw:
      guard let drawnCard = state.drawnCard else { return state }
      replacement = drawnCard
    }

    var nextPlayer = player
    nextPlayer.grid[cardIndex] = Card(
      id: replacement.id,
      value: replacement.value,
      faceUp: true,
      removed: false
    )
    var next = state
    next.discardPile = [
      Card(id: oldCard.id, value: oldCard.value, faceUp: true, removed: false)
    ] + remainingDiscard
    next = withLog(next, "\(player.name) replaced a card with \(replacement.value).")
    return finishTurn(next, player: nextPlayer)
  }

  public static func discardDrawnAndReveal(_ state: GameState, at cardIndex: Int) -> GameState {
    guard state.phase == .chooseReplacement,
          state.selectedSource == .draw,
          let drawnCard = state.drawnCard,
          state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].grid.indices.contains(cardIndex)
    else { return state }
    let player = state.players[state.currentPlayerIndex]
    let card = player.grid[cardIndex]
    guard !card.faceUp, !card.removed else { return state }

    var nextPlayer = player
    nextPlayer.grid[cardIndex].faceUp = true
    var next = state
    next.discardPile = [drawnCard] + state.discardPile
    next = withLog(
      next,
      "\(player.name) discarded \(drawnCard.value) and revealed a card."
    )
    return finishTurn(next, player: nextPlayer)
  }

  public static func reduce<R: SkyjoRandomNumberGenerator>(
    _ state: GameState,
    action: GameAction,
    random: inout R
  ) -> GameState {
    switch action {
    case .revealOpeningCard(let index): revealOpeningCard(state, at: index)
    case .chooseDiscard: chooseDiscard(state)
    case .cancelDiscard: cancelDiscardSelection(state)
    case .drawBlind: drawBlind(state, random: &random)
    case .replaceCard(let index): replaceCard(state, at: index)
    case .discardAndReveal(let index): discardDrawnAndReveal(state, at: index)
    }
  }

  public static func advanceSoloAIOpeningSeat(_ state: GameState) -> GameState {
    guard state.phase == .openingReveal,
          state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].kind == .ai
    else { return state }
    let seatID = state.players[state.currentPlayerIndex].id
    var next = state
    for _ in 0..<2 {
      guard next.phase == .openingReveal,
            next.players.indices.contains(next.currentPlayerIndex),
            next.players[next.currentPlayerIndex].id == seatID,
            next.players[next.currentPlayerIndex].kind == .ai,
            let cardIndex = next.players[next.currentPlayerIndex].grid.firstIndex(where: {
              !$0.faceUp && !$0.removed
            })
      else { break }
      let advanced = revealOpeningCard(next, at: cardIndex)
      guard advanced != next else { break }
      next = advanced
    }
    return next
  }

  public static func drainSoloAIOpening(_ state: GameState) -> GameState {
    var next = state
    for _ in state.players.indices {
      guard next.phase == .openingReveal,
            next.players.indices.contains(next.currentPlayerIndex),
            next.players[next.currentPlayerIndex].kind == .ai
      else { break }
      let advanced = advanceSoloAIOpeningSeat(next)
      guard advanced != next else { break }
      next = advanced
    }
    return next
  }

  public static func scoreGrid(_ grid: [Card]) -> Int {
    grid.reduce(0) { $0 + ($1.removed ? 0 : $1.value) }
  }

  public static func visibleScore(_ grid: [Card]) -> Int {
    grid.reduce(0) { $0 + ($1.removed || !$1.faceUp ? 0 : $1.value) }
  }

  public static func allCardsKnown(_ grid: [Card]) -> Bool {
    grid.allSatisfy { $0.faceUp || $0.removed }
  }

  private static func createSinglePlayerRoster<R: SkyjoRandomNumberGenerator>(
    aiOpponentCount: Int,
    previousScores: [String: Int],
    random: inout R
  ) -> [PlayerSeed] {
    let count = normalizedSinglePlayerAIOpponentCount(aiOpponentCount)
    var names = singlePlayerAINames
    names.skyjoShuffle(using: &random)
    return [
      PlayerSeed(
        id: "human",
        name: "You",
        kind: .human,
        totalScore: previousScores["human"] ?? 0
      )
    ] + Array(names.prefix(count).enumerated()).map { index, name in
      let id = "ai-\(index + 1)"
      return PlayerSeed(
        id: id,
        name: name,
        kind: .ai,
        totalScore: previousScores[id] ?? 0
      )
    }
  }

  private static func makePlayer<R: SkyjoRandomNumberGenerator>(
    seed: PlayerSeed,
    deck: [Card],
    autoRevealOpeningCards: Bool,
    random: inout R
  ) -> (player: Player, deck: [Card]) {
    var grid = Array(deck.prefix(SkyjoRules.rows * SkyjoRules.columns))
    if autoRevealOpeningCards {
      var indexes = Array(grid.indices)
      indexes.skyjoShuffle(using: &random)
      for index in indexes.prefix(2) { grid[index].faceUp = true }
    }
    return (
      Player(
        id: seed.id,
        name: seed.name,
        kind: seed.kind,
        grid: grid,
        totalScore: seed.totalScore ?? 0,
        roundScore: visibleScore(grid)
      ),
      Array(deck.dropFirst(SkyjoRules.rows * SkyjoRules.columns))
    )
  }

  private static func drawCard<R: SkyjoRandomNumberGenerator>(
    drawPile: [Card],
    discardPile: [Card],
    random: inout R
  ) -> (card: Card, drawPile: [Card], discardPile: [Card])? {
    if let first = drawPile.first {
      var card = first
      card.faceUp = true
      return (card, Array(drawPile.dropFirst()), discardPile)
    }
    let topDiscard = discardPile.first
    var recycled = discardPile.dropFirst().map {
      Card(id: $0.id, value: $0.value, faceUp: false, removed: false)
    }
    recycled.skyjoShuffle(using: &random)
    guard let first = recycled.first else { return nil }
    var card = first
    card.faceUp = true
    return (card, Array(recycled.dropFirst()), topDiscard.map { [$0] } ?? [])
  }

  private static func clearMatchingColumnsWithDiscards(
    _ grid: [Card]
  ) -> (grid: [Card], clearedCards: [Card]) {
    var next = grid
    var clearedCards: [Card] = []
    for column in 0..<SkyjoRules.columns {
      let indexes = [column, column + SkyjoRules.columns, column + SkyjoRules.columns * 2]
      guard indexes.allSatisfy(next.indices.contains) else { continue }
      let cards = indexes.map { next[$0] }
      guard let first = cards.first,
            cards.allSatisfy({ $0.faceUp && !$0.removed && $0.value == first.value })
      else { continue }
      clearedCards.append(contentsOf: cards.map {
        Card(id: $0.id, value: $0.value, faceUp: true, removed: false)
      })
      for index in indexes { next[index].removed = true }
    }
    return (next, clearedCards)
  }

  private static func clearMatchingColumns(_ grid: [Card]) -> [Card] {
    clearMatchingColumnsWithDiscards(grid).grid
  }

  private static func updatePlayer(_ state: GameState, player: Player) -> GameState {
    var next = state
    next.players = state.players.map { $0.id == player.id ? player : $0 }
    return next
  }

  private static func openingStarterIndex(
    _ players: [Player],
    startPlayerId: String?
  ) -> Int {
    if let startPlayerId, let index = players.firstIndex(where: { $0.id == startPlayerId }) {
      return index
    }
    guard !players.isEmpty else { return 0 }
    return players.indices.dropFirst().reduce(0) { bestIndex, index in
      visibleScore(players[index].grid) > visibleScore(players[bestIndex].grid)
        ? index
        : bestIndex
    }
  }

  private static func openingRevealCount(_ player: Player) -> Int {
    player.grid.filter { $0.faceUp && !$0.removed }.count
  }

  private static func openingRevealCounts(_ players: [Player]) -> [String: Int] {
    Dictionary(uniqueKeysWithValues: players.map { ($0.id, openingRevealCount($0)) })
  }

  private static func firstPlayerNeedingOpeningReveal(_ players: [Player]) -> Int? {
    players.firstIndex { openingRevealCount($0) < 2 }
  }

  private static func withLog(_ state: GameState, _ message: String) -> GameState {
    var next = state
    next.log = Array(([message] + state.log).prefix(8))
    return next
  }

  private static func possessiveName(_ name: String) -> String {
    if name.lowercased() == "you" { return "Your" }
    return name.hasSuffix("s") ? "\(name)'" : "\(name)'s"
  }

  private static func finalTurnOrder(_ players: [Player], closerId: String) -> [String] {
    guard let closerIndex = players.firstIndex(where: { $0.id == closerId }) else {
      return players.map(\.id)
    }
    guard players.count > 1 else { return [] }
    return (0..<(players.count - 1)).map { offset in
      players[(closerIndex + offset + 1) % players.count].id
    }
  }

  private static func finishTurn(_ state: GameState, player: Player) -> GameState {
    let cleared = clearMatchingColumnsWithDiscards(player.grid)
    var updatedPlayer = player
    updatedPlayer.grid = cleared.grid
    updatedPlayer.roundScore = visibleScore(cleared.grid)
    var updatedState = state
    if !cleared.clearedCards.isEmpty {
      updatedState.discardPile = cleared.clearedCards + state.discardPile
    }
    updatedState = updatePlayer(updatedState, player: updatedPlayer)

    if state.roundCloserId != nil {
      return finishFinalTurn(updatedState, player: updatedPlayer)
    }
    if allCardsKnown(cleared.grid) {
      let finalTurns = finalTurnOrder(updatedState.players, closerId: updatedPlayer.id)
      if finalTurns.isEmpty { return finishRound(updatedState, closer: updatedPlayer) }
      let nextPlayerId = finalTurns[0]
      let nextIndex = updatedState.players.firstIndex(where: { $0.id == nextPlayerId })
        ?? updatedState.currentPlayerIndex
      updatedState.currentPlayerIndex = nextIndex
      updatedState.selectedSource = nil
      updatedState.drawnCard = nil
      updatedState.phase = .chooseSource
      updatedState.roundCloserId = updatedPlayer.id
      updatedState.finalTurnPlayerIds = finalTurns
      return withLog(
        updatedState,
        "\(updatedPlayer.name) revealed their last card. Everyone else gets one final turn."
      )
    }
    updatedState.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.count
    updatedState.selectedSource = nil
    updatedState.drawnCard = nil
    updatedState.phase = .chooseSource
    return updatedState
  }

  private static func finishFinalTurn(_ state: GameState, player: Player) -> GameState {
    let remaining = state.finalTurnPlayerIds.filter { $0 != player.id }
    if remaining.isEmpty {
      let closer = state.players.first { $0.id == state.roundCloserId } ?? player
      var final = state
      final.finalTurnPlayerIds = []
      return finishRound(final, closer: closer)
    }
    let nextPlayerId = remaining[0]
    let nextIndex = state.players.firstIndex { $0.id == nextPlayerId }
    var next = state
    next.currentPlayerIndex = nextIndex ?? state.currentPlayerIndex
    next.selectedSource = nil
    next.drawnCard = nil
    next.phase = .chooseSource
    next.finalTurnPlayerIds = remaining
    let nextName = nextIndex.map { state.players[$0].name } ?? "Next player"
    return withLog(next, "\(nextName) gets a final turn.")
  }

  private static func finishRound(_ state: GameState, closer: Player) -> GameState {
    var scoredPlayers = state.players.map { player -> Player in
      var revealedGrid = player.grid.map { card -> Card in
        guard !card.removed else { return card }
        var revealed = card
        revealed.faceUp = true
        return revealed
      }
      revealedGrid = clearMatchingColumns(revealedGrid)
      let score = scoreGrid(revealedGrid)
      var scored = player
      scored.grid = revealedGrid
      scored.roundScore = score
      scored.totalScore += score
      return scored
    }
    let closerScore = scoredPlayers.first { $0.id == closer.id }?.roundScore ?? 0
    let closerIsStrictLowest = scoredPlayers.allSatisfy {
      $0.id == closer.id || closerScore < $0.roundScore
    }
    let shouldDouble = !closerIsStrictLowest && closerScore > 0
    if shouldDouble, let index = scoredPlayers.firstIndex(where: { $0.id == closer.id }) {
      let original = scoredPlayers[index].roundScore
      scoredPlayers[index].roundScore = original * 2
      scoredPlayers[index].totalScore = scoredPlayers[index].totalScore - original + original * 2
    }
    let leader = scoredPlayers.enumerated().min {
      $0.element.totalScore < $1.element.totalScore
    }?.element ?? closer
    let gameOver = scoredPlayers.contains { $0.totalScore >= SkyjoRules.winningScore }
    let doubledNote = shouldDouble
      ? " \(possessiveName(closer.name)) round score doubled to \(closerScore * 2)."
      : ""
    let history = RoundHistoryEntry(
      round: state.round,
      closerId: closer.id,
      scores: scoredPlayers.map {
        RoundScore(
          playerId: $0.id,
          name: $0.name,
          roundScore: $0.roundScore,
          totalScore: $0.totalScore
        )
      }
    )
    var next = state
    next.players = scoredPlayers
    next.phase = gameOver ? .gameOver : .roundOver
    next.selectedSource = nil
    next.drawnCard = nil
    next.winnerId = gameOver ? leader.id : nil
    next.nextStarterId = closer.id
    next.roundCloserId = nil
    next.finalTurnPlayerIds = []
    next.roundHistory.append(history)
    return withLog(
      next,
      "\(closer.name) ended the round.\(doubledNote) \(leader.name) leads with \(leader.totalScore)."
    )
  }
}
