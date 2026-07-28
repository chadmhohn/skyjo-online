import Foundation
import Testing

@testable import SkyjoDomain

@Suite("Multiplayer hidden-card wire safety")
struct RedactionTests {
  @Test("Face-down values always encode as explicit JSON null")
  func hiddenValueEncodesNull() throws {
    let card = PublicCardSnapshot(id: "grid-0-0", value: 12, faceUp: false, removed: false)
    #expect(card.value == nil)
    let object = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(card)) as? [String: Any]
    )
    #expect(object.keys.contains("value"))
    #expect(object["value"] is NSNull)
    #expect(!String(describing: card).contains("12"))
    #expect(!Card(id: "physical-id-12", value: 12).debugDescription.contains("12"))
  }

  @Test(
    "Malformed public card values fail closed",
    arguments: [
      #"{"id":"grid-0-0","faceUp":false,"removed":false}"#,
      #"{"id":"grid-0-0","value":12,"faceUp":false,"removed":false}"#,
      #"{"id":"grid-0-0","value":13,"faceUp":true,"removed":false}"#,
      #"{"id":"grid-0-0","value":null,"faceUp":true,"removed":false}"#,
    ]
  )
  func malformedCards(json: String) {
    #expect(throws: (any Error).self) {
      try JSONDecoder().decode(PublicCardSnapshot.self, from: Data(json.utf8))
    }
  }

  @Test("Decoded grid identifiers are positional and private identifiers fail closed")
  func gridIdentifiersFailClosed() throws {
    let valid = GameRedactor.project(authoritativeState(), viewerPlayerId: "ada")
    let privateIdentifier = "physical-private-grid-secret"
    let malformed = try snapshotData(
      from: valid,
      replacingCardID: privateIdentifier,
      at: .grid(player: 0, card: 0)
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONDecoder().decode(PublicGameStateSnapshot.self, from: malformed)
    }

    let wrongCardKind = try snapshotData(
      from: valid,
      replacingCardID: "discard-top",
      at: .grid(player: 0, card: 0)
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONDecoder().decode(PublicGameStateSnapshot.self, from: wrongCardKind)
    }

    let swapped = try snapshotData(
      from: valid,
      swappingGridCardIDsForPlayer: 0,
      firstCard: 0,
      secondCard: 1
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONDecoder().decode(PublicGameStateSnapshot.self, from: swapped)
    }
  }

  @Test("Discard and drawn identifiers require their exact sentinels")
  func pileIdentifiersFailClosed() throws {
    let publicState = GameRedactor.project(authoritativeState(), viewerPlayerId: "ada")
    let wrongDiscard = try snapshotData(
      from: publicState,
      replacingCardID: "drawn-card",
      at: .discardTop
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONDecoder().decode(PublicGameStateSnapshot.self, from: wrongDiscard)
    }

    var authoritative = authoritativeState()
    authoritative.phase = .chooseReplacement
    authoritative.selectedSource = .draw
    authoritative.drawnCard = Card(
      id: "physical-private-drawn-secret",
      value: 7,
      faceUp: true
    )
    let drawerState = GameRedactor.project(authoritative, viewerPlayerId: "ada")
    let wrongDrawn = try snapshotData(
      from: drawerState,
      replacingCardID: "discard-top",
      at: .drawnCard
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONDecoder().decode(PublicGameStateSnapshot.self, from: wrongDrawn)
    }
  }

  @Test("Viewer-private drawn card stays off debug surfaces without changing authorized wire")
  func drawnCardDebugOutputIsRedacted() throws {
    let privateIdentifier = "physical-viewer-private-drawn-secret"
    let privateValue = 11
    var authoritative = authoritativeState()
    authoritative.phase = .chooseReplacement
    authoritative.selectedSource = .draw
    authoritative.drawnCard = Card(
      id: privateIdentifier,
      value: privateValue,
      faceUp: true
    )

    let projected = GameRedactor.project(authoritative, viewerPlayerId: "ada")
    try projected.validate(viewerPlayerId: "ada")
    let drawnCard = try #require(projected.drawnCard)
    for output in [
      String(describing: drawnCard),
      drawnCard.debugDescription,
      String(reflecting: drawnCard),
      String(describing: projected),
      projected.debugDescription,
      String(reflecting: projected),
    ] {
      #expect(!output.contains(privateIdentifier))
      #expect(!output.contains(drawnCard.id))
      #expect(!output.contains(String(privateValue)))
    }

    let encoded = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(projected)) as? [String: Any]
    )
    let encodedDrawnCard = try #require(encoded["drawnCard"] as? [String: Any])
    #expect(encodedDrawnCard["id"] as? String == "drawn-card")
    #expect(encodedDrawnCard["value"] as? Int == privateValue)
    #expect(encodedDrawnCard["faceUp"] as? Bool == true)
  }

  @Test("Malformed identifiers cannot be reserialized or exposed by debug output")
  func malformedIdentifiersDoNotEscape() throws {
    let privateIdentifier = "physical-private-card-secret"
    let card = PublicCardSnapshot(
      id: privateIdentifier,
      value: 9,
      faceUp: true,
      removed: false
    )
    #expect(!card.description.contains(privateIdentifier))
    #expect(!card.debugDescription.contains(privateIdentifier))
    #expect(!String(reflecting: card).contains(privateIdentifier))
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONEncoder().encode(card)
    }

    let valid = GameRedactor.project(authoritativeState(), viewerPlayerId: "ada")
    var swappedGrid = valid.players[0].grid
    swappedGrid.swapAt(0, 1)
    let swappedPlayer = PublicPlayerSnapshot(
      id: valid.players[0].id,
      name: valid.players[0].name,
      kind: valid.players[0].kind,
      grid: swappedGrid,
      totalScore: valid.players[0].totalScore,
      roundScore: valid.players[0].roundScore
    )
    let invalidSnapshot = snapshot(
      from: valid,
      players: [swappedPlayer, valid.players[1]]
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try invalidSnapshot.validate(viewerPlayerId: "ada")
    }
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try JSONEncoder().encode(invalidSnapshot)
    }

    let malformedData = try snapshotData(
      from: valid,
      replacingCardID: privateIdentifier,
      at: .grid(player: 0, card: 0)
    )
    #expect(throws: PublicSnapshotError.invalidCardIdentifier) {
      try validatedReserialization(of: malformedData, viewerPlayerID: "ada")
    }
  }

  @Test("Generated snapshots survive decode, validation, and reserialization")
  func generatedIdentifiersRoundTrip() throws {
    var authoritative = authoritativeState()
    authoritative.phase = .chooseReplacement
    authoritative.selectedSource = .draw
    authoritative.drawnCard = Card(
      id: "physical-private-drawn-seven",
      value: 7,
      faceUp: true
    )
    let cases = [
      (GameRedactor.project(authoritative, viewerPlayerId: "ada"), "ada"),
      (GameRedactor.project(authoritative, viewerPlayerId: "grace"), "grace"),
    ]

    for (projected, viewerPlayerID) in cases {
      try projected.validate(viewerPlayerId: viewerPlayerID)
      #expect(projected.players.enumerated().allSatisfy { playerIndex, player in
        player.grid.enumerated().allSatisfy { cardIndex, card in
          card.id == "grid-\(playerIndex)-\(cardIndex)"
        }
      })
      #expect(projected.discardPile.top?.id == "discard-top")
      #expect(projected.drawnCard == nil || projected.drawnCard?.id == "drawn-card")

      let encoded = try JSONEncoder().encode(projected)
      let decoded = try JSONDecoder().decode(PublicGameStateSnapshot.self, from: encoded)
      try decoded.validate(viewerPlayerId: viewerPlayerID)
      #expect(decoded == projected)
      let reserialized = try validatedReserialization(
        of: encoded,
        viewerPlayerID: viewerPlayerID
      )
      let redecoded = try JSONDecoder().decode(
        PublicGameStateSnapshot.self,
        from: reserialized
      )
      #expect(redecoded == projected)
    }
  }

  @Test("Viewer-specific snapshots reveal only the active drawer")
  func viewerSpecificRedaction() throws {
    var state = authoritativeState()
    state.log = ["Ada drew a 12.", String(repeating: "L", count: 400)]
    state.players[0].name = String(repeating: "N", count: 40)
    state.drawnCard = Card(id: "private-drawn-12", value: 12, faceUp: true)
    state.selectedSource = .draw
    state.phase = .chooseReplacement
    state.roundHistory = (1...105).map { round in
      RoundHistoryEntry(
        round: round,
        closerId: "ada",
        scores: [
          RoundScore(
            playerId: "ada",
            name: String(repeating: "A", count: 40),
            roundScore: round,
            totalScore: round
          ),
          RoundScore(playerId: "grace", name: "Grace", roundScore: 0, totalScore: 0),
        ]
      )
    }

    let drawer = GameRedactor.project(state, viewerPlayerId: "ada")
    let spectator = GameRedactor.project(state, viewerPlayerId: "grace")
    #expect(drawer.drawnCard?.value == 12)
    #expect(spectator.drawnCard == nil)
    #expect(drawer.hasDrawnCard && spectator.hasDrawnCard)
    #expect(drawer.log[0] == "Ada drew a blind card.")
    #expect(drawer.log[1].count == 320)
    #expect(drawer.players[0].name.count == 24)
    #expect(drawer.roundHistory.count == 100)
    #expect(drawer.roundHistory[0].round == 6)
    #expect(drawer.roundHistory[0].scores[0].name.count == 24)
    #expect(drawer.drawPileCount == state.drawPile.count)
    #expect(drawer.discardPile.top?.id == "discard-top")
    #expect(drawer.players[0].grid[1].value == nil)
    #expect(drawer.players[0].grid[1].id == "grid-0-1")
    try drawer.validate(viewerPlayerId: "ada")
    try spectator.validate(viewerPlayerId: "grace")

    let drawerJSON = String(decoding: try JSONEncoder().encode(drawer), as: UTF8.self)
    #expect(!drawerJSON.contains("private-drawn"))
    #expect(!drawerJSON.contains("physical"))
    let spectatorJSON = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(spectator)) as? [String: Any]
    )
    #expect(spectatorJSON["drawnCard"] is NSNull)
    #expect(spectatorJSON["selectedSource"] as? String == "draw")
  }

  @Test("UTF-16 truncation backs off a dangling high surrogate")
  func unicodeTruncationStaysValid() throws {
    var state = authoritativeState()
    state.players[0].name = "A" + String(repeating: "😀", count: 20)

    let snapshot = GameRedactor.project(state, viewerPlayerId: "ada")
    let projectedName = snapshot.players[0].name
    #expect(projectedName == "A" + String(repeating: "😀", count: 11))
    #expect(projectedName.utf16.count == 23)
    let finalCodeUnit = try #require(projectedName.utf16.last)
    #expect(!(0xD800...0xDBFF).contains(Int(finalCodeUnit)))
  }

  @Test("Malformed snapshot invariants reject bounds and privacy mismatches")
  func malformedSnapshots() {
    let valid = GameRedactor.project(authoritativeState(), viewerPlayerId: "ada")
    #expect(throws: PublicSnapshotError.invalidCurrentPlayer) {
      try snapshot(from: valid, players: [], currentPlayerIndex: 0).validate()
    }
    let shortPlayer = PublicPlayerSnapshot(
      id: "ada",
      name: "Ada",
      kind: .human,
      grid: Array(valid.players[0].grid.dropLast()),
      totalScore: 0,
      roundScore: 0
    )
    #expect(throws: PublicSnapshotError.invalidGridSize) {
      try snapshot(from: valid, players: [shortPlayer], currentPlayerIndex: 0).validate()
    }
    #expect(throws: PublicSnapshotError.invalidCount) {
      try snapshot(
        from: valid,
        drawPileCount: 151,
        discardPile: PublicDiscardPileSnapshot(count: 0, top: valid.discardPile.top)
      ).validate()
    }
    let unexpectedDraw = PublicCardSnapshot(
      id: "drawn-card",
      value: 5,
      faceUp: true,
      removed: false
    )
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try snapshot(from: valid, hasDrawnCard: false, drawnCard: unexpectedDraw).validate()
    }
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try snapshot(
        from: valid,
        phase: .chooseReplacement,
        selectedSource: .draw,
        hasDrawnCard: false
      ).validate(viewerPlayerId: "ada")
    }
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try snapshot(
        from: valid,
        phase: .chooseReplacement,
        selectedSource: .discard,
        hasDrawnCard: true,
        drawnCard: unexpectedDraw
      ).validate(viewerPlayerId: "ada")
    }
    let privateDrawBase = snapshot(
      from: valid,
      phase: .chooseReplacement,
      selectedSource: .draw,
      hasDrawnCard: true,
      drawnCard: nil
    )
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try privateDrawBase.validate(viewerPlayerId: "ada")
    }
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try snapshot(
        from: valid,
        phase: .chooseReplacement,
        selectedSource: .draw,
        hasDrawnCard: true,
        drawnCard: unexpectedDraw
      ).validate(viewerPlayerId: "grace")
    }
    #expect(throws: PublicSnapshotError.invalidDrawnCardVisibility) {
      try snapshot(
        from: valid,
        phase: .chooseReplacement,
        selectedSource: .draw,
        hasDrawnCard: true,
        drawnCard: unexpectedDraw
      ).validate()
    }
  }

  @Test("Authoritative state encodes required nullable keys")
  func authoritativeNullEncoding() throws {
    let encoded = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(authoritativeState()))
        as? [String: Any]
    )
    for key in ["selectedSource", "drawnCard", "winnerId", "nextStarterId", "roundCloserId"] {
      #expect(encoded.keys.contains(key))
      #expect(encoded[key] is NSNull)
    }
  }

  private func authoritativeState() -> GameState {
    func player(_ id: String, _ name: String) -> Player {
      Player(
        id: id,
        name: name,
        kind: .human,
        grid: (0..<12).map { index in
          Card(
            id: "physical-\(id)-\(index)-\(index)",
            value: index,
            faceUp: index == 0
          )
        }
      )
    }
    return GameState(
      players: [player("ada", "Ada"), player("grace", "Grace")],
      drawPile: [Card(id: "physical-draw-12", value: 12)],
      discardPile: [Card(id: "physical-discard-4", value: 4, faceUp: true)],
      currentPlayerIndex: 0,
      phase: .chooseSource,
      openingRevealCounts: ["ada": 1, "grace": 1]
    )
  }

  private enum PublicCardLocation {
    case grid(player: Int, card: Int)
    case discardTop
    case drawnCard
  }

  private func snapshotData(
    from snapshot: PublicGameStateSnapshot,
    replacingCardID identifier: String,
    at location: PublicCardLocation
  ) throws -> Data {
    var object = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any]
    )
    switch location {
    case let .grid(playerIndex, cardIndex):
      var players = try #require(object["players"] as? [[String: Any]])
      var player = players[playerIndex]
      var grid = try #require(player["grid"] as? [[String: Any]])
      var card = grid[cardIndex]
      card["id"] = identifier
      grid[cardIndex] = card
      player["grid"] = grid
      players[playerIndex] = player
      object["players"] = players
    case .discardTop:
      var discardPile = try #require(object["discardPile"] as? [String: Any])
      var card = try #require(discardPile["top"] as? [String: Any])
      card["id"] = identifier
      discardPile["top"] = card
      object["discardPile"] = discardPile
    case .drawnCard:
      var card = try #require(object["drawnCard"] as? [String: Any])
      card["id"] = identifier
      object["drawnCard"] = card
    }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func snapshotData(
    from snapshot: PublicGameStateSnapshot,
    swappingGridCardIDsForPlayer playerIndex: Int,
    firstCard firstCardIndex: Int,
    secondCard secondCardIndex: Int
  ) throws -> Data {
    var object = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any]
    )
    var players = try #require(object["players"] as? [[String: Any]])
    var player = players[playerIndex]
    var grid = try #require(player["grid"] as? [[String: Any]])
    var firstCard = grid[firstCardIndex]
    var secondCard = grid[secondCardIndex]
    let firstID = try #require(firstCard["id"] as? String)
    let secondID = try #require(secondCard["id"] as? String)
    firstCard["id"] = secondID
    secondCard["id"] = firstID
    grid[firstCardIndex] = firstCard
    grid[secondCardIndex] = secondCard
    player["grid"] = grid
    players[playerIndex] = player
    object["players"] = players
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func validatedReserialization(
    of data: Data,
    viewerPlayerID: String
  ) throws -> Data {
    let decoded = try JSONDecoder().decode(PublicGameStateSnapshot.self, from: data)
    try decoded.validate(viewerPlayerId: viewerPlayerID)
    return try JSONEncoder().encode(decoded)
  }

  private func snapshot(
    from base: PublicGameStateSnapshot,
    players: [PublicPlayerSnapshot]? = nil,
    drawPileCount: Int? = nil,
    discardPile: PublicDiscardPileSnapshot? = nil,
    currentPlayerIndex: Int? = nil,
    phase: TurnPhase? = nil,
    selectedSource: SelectedSource? = nil,
    hasDrawnCard: Bool? = nil,
    drawnCard: PublicCardSnapshot? = nil
  ) -> PublicGameStateSnapshot {
    PublicGameStateSnapshot(
      players: players ?? base.players,
      drawPileCount: drawPileCount ?? base.drawPileCount,
      discardPile: discardPile ?? base.discardPile,
      currentPlayerIndex: currentPlayerIndex ?? base.currentPlayerIndex,
      phase: phase ?? base.phase,
      selectedSource: selectedSource ?? base.selectedSource,
      hasDrawnCard: hasDrawnCard ?? base.hasDrawnCard,
      drawnCard: drawnCard ?? base.drawnCard,
      round: base.round,
      log: base.log,
      winnerId: base.winnerId,
      nextStarterId: base.nextStarterId,
      roundCloserId: base.roundCloserId,
      finalTurnPlayerIds: base.finalTurnPlayerIds,
      openingRevealCounts: base.openingRevealCounts,
      roundHistory: base.roundHistory
    )
  }
}
