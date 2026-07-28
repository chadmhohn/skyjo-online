import Foundation
import Testing

@testable import SkyjoDomain

@Suite("Pure Swift rules and invariants")
struct GameInvariantTests {
  @Test("Deck conservation holds for 2-8 players across seeded games", arguments: 2...8)
  func deckConservation(playerCount: Int) {
    for seed in -12...12 {
      var random = SeededRandom(seed: seed)
      let state = GameEngine.createMultiplayerGame(
        players: (0..<playerCount).map {
          PlayerSeed(id: "p-\($0)", name: "Player \($0)", kind: .human)
        },
        random: &random
      )
      let cards = state.players.flatMap { $0.grid.filter { !$0.removed } }
        + state.drawPile + state.discardPile + (state.drawnCard.map { [$0] } ?? [])
      #expect(cards.count == SkyjoRules.deckCardCount)
      #expect(Set(cards.map(\.id)).count == SkyjoRules.deckCardCount)
      for item in SkyjoRules.cardValueCounts {
        #expect(cards.filter { $0.value == item.value }.count == item.count)
      }
      #expect(state.phase == .openingReveal)
    }
  }

  @Test("Same seed replays exactly and a neighboring seed differs")
  func seededRandomReplay() {
    var firstRandom = SeededRandom(seed: 42)
    var replayRandom = SeededRandom(seed: 42)
    var differentRandom = SeededRandom(seed: 43)
    let first = GameEngine.startFreshGame(aiOpponentCount: 3, random: &firstRandom)
    #expect(GameEngine.startFreshGame(aiOpponentCount: 3, random: &replayRandom) == first)
    #expect(GameEngine.startFreshGame(aiOpponentCount: 3, random: &differentRandom) != first)
    #expect(GameEngine.normalizedSinglePlayerAIOpponentCount(-50) == 1)
    #expect(GameEngine.normalizedSinglePlayerAIOpponentCount(99) == 7)
    #expect(GameEngine.defaultSinglePlayerAIOpponents.count == 7)
  }

  @Test("Invalid phase, index, removed-card, and missing-source moves are inert")
  func invalidActionsAreInert() {
    var random = SeededRandom(seed: 17)
    let opening = GameEngine.createMultiplayerGame(
      players: [
        PlayerSeed(id: "a", name: "Ada", kind: .human),
        PlayerSeed(id: "g", name: "Grace", kind: .human),
      ],
      random: &random
    )
    #expect(GameEngine.revealOpeningCard(opening, at: -1) == opening)
    #expect(GameEngine.revealOpeningCard(opening, at: 12) == opening)
    #expect(GameEngine.chooseDiscard(opening) == opening)
    #expect(GameEngine.cancelDiscardSelection(opening) == opening)
    var drawRandom = SeededRandom(seed: 1)
    #expect(GameEngine.drawBlind(opening, random: &drawRandom) == opening)
    #expect(GameEngine.replaceCard(opening, at: 0) == opening)
    #expect(GameEngine.discardDrawnAndReveal(opening, at: 0) == opening)

    var malformed = opening
    malformed.phase = .chooseReplacement
    malformed.selectedSource = .draw
    malformed.drawnCard = nil
    #expect(GameEngine.replaceCard(malformed, at: 0) == malformed)
    #expect(GameEngine.discardDrawnAndReveal(malformed, at: 0) == malformed)
    malformed.selectedSource = .discard
    malformed.discardPile = []
    #expect(GameEngine.replaceCard(malformed, at: 0) == malformed)
    malformed.players[0].grid[0].removed = true
    #expect(GameEngine.replaceCard(malformed, at: 0) == malformed)
  }

  @Test("Manual and automatic opening select the documented starter")
  func openingStarters() {
    let seeds = [
      PlayerSeed(id: "a", name: "Ada", kind: .human),
      PlayerSeed(id: "g", name: "Grace", kind: .human),
    ]
    var automaticRandom = SeededRandom(seed: 4)
    let automatic = GameEngine.createGameForPlayers(
      seeds,
      round: 2,
      startPlayerId: "g",
      autoRevealOpeningCards: true,
      random: &automaticRandom
    )
    #expect(automatic.phase == .chooseSource)
    #expect(automatic.players[automatic.currentPlayerIndex].id == "g")

    var fallbackRandom = SeededRandom(seed: 4)
    let fallback = GameEngine.createGameForPlayers(
      seeds,
      round: 2,
      startPlayerId: "missing",
      autoRevealOpeningCards: true,
      random: &fallbackRandom
    )
    #expect(
      fallback.players[fallback.currentPlayerIndex].roundScore
        == fallback.players.map(\.roundScore).max()
    )
  }

  @Test("AI opening helpers advance only active AI seats")
  func aiOpeningHelpers() {
    var random = SeededRandom(seed: 73)
    var state = GameEngine.startFreshGame(aiOpponentCount: 2, random: &random)
    #expect(GameEngine.advanceSoloAIOpeningSeat(state) == state)
    #expect(GameEngine.drainSoloAIOpening(state) == state)
    state = GameEngine.revealOpeningCard(state, at: 0)
    state = GameEngine.revealOpeningCard(state, at: 1)
    let firstAI = state.players[state.currentPlayerIndex].id
    let advanced = GameEngine.advanceSoloAIOpeningSeat(state)
    #expect(advanced.openingRevealCounts[firstAI] == 2)
    let drained = GameEngine.drainSoloAIOpening(state)
    #expect(drained.phase == .chooseSource)
    #expect(drained.openingRevealCounts.values.allSatisfy { $0 == 2 })

    var noCards = state
    noCards.players[noCards.currentPlayerIndex].grid = noCards.players[noCards.currentPlayerIndex].grid.map {
      var card = $0
      card.faceUp = true
      return card
    }
    #expect(GameEngine.advanceSoloAIOpeningSeat(noCards) == noCards)
  }

  @Test("Grid scoring ignores removed cards and counts hidden cards only at finish")
  func scoringHelpers() {
    let cards = [
      Card(id: "hidden", value: 12, faceUp: false),
      Card(id: "visible", value: -2, faceUp: true),
      Card(id: "removed", value: 9, faceUp: true, removed: true),
    ]
    #expect(GameEngine.visibleScore(cards) == -2)
    #expect(GameEngine.scoreGrid(cards) == 10)
    #expect(!GameEngine.allCardsKnown(cards))
    var known = cards
    known[0].faceUp = true
    #expect(GameEngine.allCardsKnown(known))
    #expect(SkyjoRules.columnIndexes(for: 9) == [1, 5, 9])
  }
}
