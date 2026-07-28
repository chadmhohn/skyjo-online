import Foundation

public enum SkyjoAI {
  public static let ultraDrawOutcomeLimit = SkyjoRules.cardValueCounts.count

  public static func estimateHiddenCardValue(_ knowledge: AIKnowledgeState) -> Double {
    remainingValueDistribution(knownValues: knowledge.knownValues).reduce(0) {
      $0 + $1.value * $1.probability
    }
  }

  public static func legalMoves(_ knowledge: AIKnowledgeState) -> [AIMove] {
    guard knowledge.players.indices.contains(knowledge.currentPlayerIndex) else { return [] }
    let player = knowledge.players[knowledge.currentPlayerIndex]
    switch knowledge.phase {
    case .openingReveal:
      let revealedCount = player.grid.filter { $0.faceUp && !$0.removed }.count
      guard revealedCount < 2 else { return [] }
      return player.grid.enumerated().compactMap { index, card in
        card.value == nil && !card.removed ? AIMove(action: .reveal, index: index) : nil
      }
    case .chooseSource:
      var moves: [AIMove] = []
      if knowledge.drawPileCount > 0 || knowledge.discardPileCount > 1 {
        moves.append(AIMove(action: .draw))
      }
      if knowledge.discardTopValue != nil { moves.append(AIMove(action: .discard)) }
      return moves
    case .chooseReplacement:
      let replacements = player.grid.enumerated().compactMap { index, card in
        !card.removed ? AIMove(action: .replace, index: index) : nil
      }
      if knowledge.selectedSource == .discard, knowledge.discardTopValue != nil {
        return replacements
      }
      guard knowledge.selectedSource == .draw, knowledge.drawnCardValue != nil else { return [] }
      return replacements + player.grid.enumerated().compactMap { index, card in
        card.value == nil && !card.removed ? AIMove(action: .reveal, index: index) : nil
      }
    case .roundOver, .gameOver:
      return []
    }
  }

  public static func chooseMove(
    _ knowledge: AIKnowledgeState,
    options: AIDecisionOptions
  ) -> AIMove? {
    guard knowledge.players.indices.contains(knowledge.currentPlayerIndex),
          knowledge.players[knowledge.currentPlayerIndex].id == options.playerId
    else { return nil }
    let legal = legalMoves(knowledge)
    guard !legal.isEmpty else { return nil }
    let player = knowledge.players[knowledge.currentPlayerIndex]
    let context = roundContext(knowledge, player: player)
    let hiddenEstimate = options.difficulty == .easy || options.difficulty == .medium
      ? SkyjoRules.defaultHiddenCardEstimate
      : estimateHiddenCardValue(knowledge)
    var random = decisionRandom(knowledge, options: options)

    switch knowledge.phase {
    case .openingReveal:
      let index = chooseRevealIndex(
        player: player,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: options.difficulty,
        random: &random
      )
      return legalChoice(index.map { AIMove(action: .reveal, index: $0) }, legal: legal)
    case .chooseSource:
      return legalChoice(
        chooseSource(
          knowledge: knowledge,
          player: player,
          context: context,
          hiddenEstimate: hiddenEstimate,
          difficulty: options.difficulty,
          random: &random
        ),
        legal: legal
      )
    case .chooseReplacement:
      if knowledge.selectedSource == .discard {
        let target = knowledge.discardTopValue.map {
          chooseReplacementTarget(
            player: player,
            replacementValue: $0,
            hiddenEstimate: hiddenEstimate,
            context: context,
            difficulty: options.difficulty,
            random: &random
          )
        } ?? nil
        return legalChoice(
          AIMove(
            action: .replace,
            index: target?.index ?? firstAvailableReplacementIndex(player)
          ),
          legal: legal
        )
      }
      if knowledge.selectedSource == .draw, let drawnValue = knowledge.drawnCardValue {
        let target = chooseReplacementTarget(
          player: player,
          replacementValue: drawnValue,
          hiddenEstimate: hiddenEstimate,
          context: context,
          difficulty: options.difficulty,
          random: &random
        )
        let threshold = drawnCardPlacementThreshold(
          drawnValue: drawnValue,
          hiddenEstimate: hiddenEstimate,
          context: context,
          difficulty: options.difficulty
        )
        if let target, target.gain >= threshold {
          return legalChoice(AIMove(action: .replace, index: target.index), legal: legal)
        }
        let riskyClosingReveal = options.difficulty == .ultra
          && context.hiddenCount == 1
          && projectedDoublingRisk(
            projectedScore: context.visibleTotal + hiddenEstimate,
            context: context
          ) > 0
        if riskyClosingReveal {
          let safeFaceUpTarget = replacementTargets(
            player: player,
            replacementValue: Double(drawnValue),
            hiddenEstimate: hiddenEstimate,
            context: context,
            difficulty: .ultra
          ).first { $0.faceUp }
          if let safeFaceUpTarget {
            return legalChoice(
              AIMove(action: .replace, index: safeFaceUpTarget.index),
              legal: legal
            )
          }
        }
        if let revealIndex = chooseRevealIndex(
          player: player,
          hiddenEstimate: hiddenEstimate,
          context: context,
          difficulty: options.difficulty,
          random: &random
        ) {
          return legalChoice(AIMove(action: .reveal, index: revealIndex), legal: legal)
        }
        return legalChoice(
          AIMove(
            action: .replace,
            index: target?.index ?? firstAvailableReplacementIndex(player)
          ),
          legal: legal
        )
      }
      return legalChoice(
        AIMove(action: .replace, index: firstAvailableReplacementIndex(player)),
        legal: legal
      )
    case .roundOver, .gameOver:
      return nil
    }
  }

  public static func chooseMove(
    for state: GameState,
    options: AIDecisionOptions
  ) -> AIMove? {
    guard state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].id == options.playerId
    else { return nil }
    return chooseMove(AIProjection.knowledge(from: state, playerId: options.playerId), options: options)
  }

  public static func legalMoves(for state: GameState, playerId: String) -> [AIMove] {
    guard state.players.indices.contains(state.currentPlayerIndex),
          state.players[state.currentPlayerIndex].id == playerId
    else { return [] }
    return legalMoves(AIProjection.knowledge(from: state, playerId: playerId))
  }

  private struct ValueProbability {
    let value: Double
    let probability: Double
  }

  private struct RoundContext {
    let hiddenCount: Int
    let isFinalTurn: Bool
    let isLateRound: Bool
    let roundHasCloser: Bool
    let visibleTotal: Double
    let opponentEstimatedTotals: [Double]
  }

  private struct ReplacementTarget {
    let index: Int
    let estimatedCurrentValue: Double
    let gain: Double
    let score: Double
    let faceUp: Bool
  }

  private static func clamp(_ value: Double, minimum: Double, maximum: Double) -> Double {
    Swift.min(maximum, Swift.max(minimum, value))
  }

  private static func knowledgeFingerprint(_ knowledge: AIKnowledgeState) -> String {
    let grids = knowledge.players.map { player in
      player.grid.map { card in
        if card.removed { return "x" }
        return card.value.map(String.init) ?? "?"
      }.joined(separator: ",")
    }.joined(separator: "|")
    return [
      knowledge.phase.rawValue,
      knowledge.selectedSource?.rawValue ?? "-",
      String(knowledge.currentPlayerIndex),
      knowledge.discardTopValue.map(String.init) ?? "-",
      knowledge.drawnCardValue.map(String.init) ?? "-",
      String(knowledge.drawPileCount),
      grids,
    ].joined(separator: ":")
  }

  private static func decisionRandom(
    _ knowledge: AIKnowledgeState,
    options: AIDecisionOptions
  ) -> SeededRandom {
    SeededRandom(
      seed: StableHash.fnv1a(
        "\(SkyjoRules.strategyVersion):\(options.difficulty.rawValue):\(options.playerId):\(options.decisionKey):\(knowledgeFingerprint(knowledge))"
      )
    )
  }

  private static func remainingValueDistribution(knownValues: [Int]) -> [ValueProbability] {
    var counts = Dictionary(
      uniqueKeysWithValues: SkyjoRules.cardValueCounts.map { ($0.value, $0.count) }
    )
    for value in knownValues {
      let count = counts[value] ?? 0
      if count > 0 { counts[value] = count - 1 }
    }
    let ordered = SkyjoRules.cardValueCounts.compactMap { item -> (Int, Int)? in
      guard let count = counts[item.value], count > 0 else { return nil }
      return (item.value, count)
    }
    let total = ordered.reduce(0) { $0 + $1.1 }
    guard total > 0 else {
      return [ValueProbability(value: SkyjoRules.defaultHiddenCardEstimate, probability: 1)]
    }
    return ordered.map {
      ValueProbability(value: Double($0.0), probability: Double($0.1) / Double(total))
    }
  }

  private static func legalChoice(_ preferred: AIMove?, legal: [AIMove]) -> AIMove? {
    if let preferred, legal.contains(preferred) { return preferred }
    return legal.first
  }

  private static func roundContext(
    _ knowledge: AIKnowledgeState,
    player: AIKnowledgePlayer
  ) -> RoundContext {
    let hiddenCount = player.grid.filter { $0.value == nil && !$0.removed }.count
    let opponentHiddenCounts = knowledge.players.filter { $0.id != player.id }.map { opponent in
      opponent.grid.filter { $0.value == nil && !$0.removed }.count
    }
    let fewestOpponentHiddenCount = opponentHiddenCounts.min() ?? hiddenCount
    let isFinalTurn = knowledge.roundCloserId != nil
      && knowledge.finalTurnPlayerIds.contains(player.id)
    let visibleTotal = player.grid.reduce(0.0) { total, card in
      total + (card.removed ? 0 : Double(card.value ?? 0))
    }
    return RoundContext(
      hiddenCount: hiddenCount,
      isFinalTurn: isFinalTurn,
      isLateRound: isFinalTurn || hiddenCount <= 2 || fewestOpponentHiddenCount <= 1,
      roundHasCloser: knowledge.roundCloserId != nil,
      visibleTotal: visibleTotal,
      opponentEstimatedTotals: knowledge.players.filter { $0.id != player.id }.map { opponent in
        opponent.grid.reduce(0.0) { total, card in
          total + (card.removed
            ? 0
            : card.value.map(Double.init) ?? SkyjoRules.defaultHiddenCardEstimate)
        }
      }
    )
  }

  private static func visibleColumnPartners(
    _ player: AIKnowledgePlayer,
    cardIndex: Int
  ) -> [AIKnowledgeCard] {
    SkyjoRules.columnIndexes(for: cardIndex).filter { $0 != cardIndex }.compactMap { index in
      guard player.grid.indices.contains(index) else { return nil }
      let card = player.grid[index]
      return card.faceUp && !card.removed && card.value != nil ? card : nil
    }
  }

  private static func estimateHiddenSlotValue(
    player: AIKnowledgePlayer,
    cardIndex: Int,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> Double {
    if difficulty == .easy || difficulty == .medium {
      return SkyjoRules.defaultHiddenCardEstimate
    }
    let partners = visibleColumnPartners(player, cardIndex: cardIndex)
    let partnerAverage = partners.isEmpty
      ? hiddenEstimate
      : partners.reduce(0.0) { $0 + Double($1.value ?? 0) } / Double(partners.count)
    let columnPressure = (partnerAverage - hiddenEstimate) * 0.18
    let adjustedColumnPressure = context.isFinalTurn ? Swift.max(0, columnPressure) : columnPressure
    let lateRoundRisk = context.isFinalTurn ? 0.55 : context.isLateRound ? 0.25 : 0
    return clamp(
      hiddenEstimate + adjustedColumnPressure + lateRoundRisk,
      minimum: 3.75,
      maximum: 6.75
    )
  }

  private static func estimatedSlotValue(
    player: AIKnowledgePlayer,
    cardIndex: Int,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> Double {
    guard player.grid.indices.contains(cardIndex), !player.grid[cardIndex].removed else {
      return -.infinity
    }
    return player.grid[cardIndex].value.map(Double.init) ?? estimateHiddenSlotValue(
      player: player,
      cardIndex: cardIndex,
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    )
  }

  private static func replacementClearsColumn(
    player: AIKnowledgePlayer,
    cardIndex: Int,
    replacementValue: Double
  ) -> Bool {
    SkyjoRules.columnIndexes(for: cardIndex).allSatisfy { index in
      guard player.grid.indices.contains(index), !player.grid[index].removed else { return false }
      if index == cardIndex { return true }
      return player.grid[index].faceUp && player.grid[index].value.map(Double.init) == replacementValue
    }
  }

  private static func estimatedColumnValue(
    player: AIKnowledgePlayer,
    cardIndex: Int,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> Double {
    SkyjoRules.columnIndexes(for: cardIndex).reduce(0) {
      $0 + estimatedSlotValue(
        player: player,
        cardIndex: $1,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: difficulty
      )
    }
  }

  private static func scoreReplacementTarget(
    player: AIKnowledgePlayer,
    cardIndex: Int,
    replacementValue: Double,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> ReplacementTarget? {
    guard player.grid.indices.contains(cardIndex), !player.grid[cardIndex].removed else { return nil }
    let card = player.grid[cardIndex]
    let currentValue = estimatedSlotValue(
      player: player,
      cardIndex: cardIndex,
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    )
    let clearsColumn = replacementClearsColumn(
      player: player,
      cardIndex: cardIndex,
      replacementValue: replacementValue
    )
    let gain = clearsColumn
      ? estimatedColumnValue(
        player: player,
        cardIndex: cardIndex,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: difficulty
      )
      : currentValue - replacementValue
    let clearBonus = difficulty == .medium ? 0.2 : 0.35
    let closesRound = card.value == nil && context.hiddenCount == 1 && !context.roundHasCloser
    let partners = visibleColumnPartners(player, cardIndex: cardIndex)
    let projectedClosingScore = clearsColumn
      ? context.visibleTotal - partners.reduce(0.0) { $0 + Double($1.value ?? 0) }
      : context.visibleTotal + replacementValue
    let closerRisk = difficulty == .ultra && closesRound
      ? projectedDoublingRisk(projectedScore: projectedClosingScore, context: context)
      : 0
    return ReplacementTarget(
      index: cardIndex,
      estimatedCurrentValue: currentValue,
      gain: gain,
      score: gain + (clearsColumn ? clearBonus : 0) + (card.faceUp ? 0.05 : 0) - closerRisk,
      faceUp: card.faceUp
    )
  }

  private static func replacementTargets(
    player: AIKnowledgePlayer,
    replacementValue: Double,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> [ReplacementTarget] {
    player.grid.indices.compactMap { index in
      scoreReplacementTarget(
        player: player,
        cardIndex: index,
        replacementValue: replacementValue,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: difficulty
      )
    }.sorted { left, right in
      if left.score != right.score { return left.score > right.score }
      if left.estimatedCurrentValue != right.estimatedCurrentValue {
        return left.estimatedCurrentValue > right.estimatedCurrentValue
      }
      if left.faceUp != right.faceUp { return left.faceUp }
      return left.index < right.index
    }
  }

  private static func weightedTarget<R: SkyjoRandomNumberGenerator>(
    _ targets: [ReplacementTarget],
    temperature: Double,
    random: inout R
  ) -> ReplacementTarget? {
    guard let first = targets.first else { return nil }
    guard temperature > 0 else { return first }
    let weighted = targets.map { target in
      (target, Foundation.exp((target.score - first.score) / temperature))
    }
    let total = weighted.reduce(0.0) { $0 + $1.1 }
    var cursor = random.nextUnitInterval() * total
    for item in weighted {
      cursor -= item.1
      if cursor <= 0 { return item.0 }
    }
    return weighted.last?.0
  }

  private static func chooseReplacementTarget<R: SkyjoRandomNumberGenerator>(
    player: AIKnowledgePlayer,
    replacementValue: Int,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty,
    random: inout R
  ) -> ReplacementTarget? {
    let targets = replacementTargets(
      player: player,
      replacementValue: Double(replacementValue),
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    )
    switch difficulty {
    case .easy: return weightedTarget(targets, temperature: 3.4, random: &random)
    case .medium: return weightedTarget(targets, temperature: 1.25, random: &random)
    case .hard, .ultra: return targets.first
    }
  }

  private static func firstAvailableReplacementIndex(_ player: AIKnowledgePlayer) -> Int {
    player.grid.firstIndex { !$0.removed } ?? 0
  }

  private static func revealCandidates(
    player: AIKnowledgePlayer,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> [(index: Int, score: Double)] {
    player.grid.indices.compactMap { index -> (Int, Double)? in
      let card = player.grid[index]
      guard card.value == nil, !card.removed else { return nil }
      let partners = visibleColumnPartners(player, cardIndex: index)
      let positivePartnerTotal = partners.reduce(0.0) {
        $0 + Swift.max(0, Double($1.value ?? 0))
      }
      let matchingPairBonus = partners.count == 2 && partners[0].value == partners[1].value
        ? Swift.max(0, Double(partners[0].value ?? 0)) * 0.2
        : 0
      let score = estimateHiddenSlotValue(
        player: player,
        cardIndex: index,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: difficulty
      ) + positivePartnerTotal * (difficulty == .ultra ? 0.12 : 0.08)
        + matchingPairBonus + (context.isLateRound ? 0.3 : 0)
      return (index, score)
    }.sorted {
      $0.score == $1.score ? $0.index < $1.index : $0.score > $1.score
    }
  }

  private static func chooseRevealIndex<R: SkyjoRandomNumberGenerator>(
    player: AIKnowledgePlayer,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty,
    random: inout R
  ) -> Int? {
    let candidates = revealCandidates(
      player: player,
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    )
    guard !candidates.isEmpty else { return nil }
    switch difficulty {
    case .easy:
      let index = Swift.min(
        Int(random.nextUnitInterval() * Double(candidates.count)),
        candidates.count - 1
      )
      return candidates[index].index
    case .medium:
      let index = Swift.min(
        Int(random.nextUnitInterval() * 3),
        candidates.count - 1
      )
      return candidates[index].index
    case .hard, .ultra:
      return candidates[0].index
    }
  }

  private static func drawSourceScore(
    player: AIKnowledgePlayer,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> Double {
    let expectedTarget = replacementTargets(
      player: player,
      replacementValue: hiddenEstimate,
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    ).first
    let revealFallback = context.hiddenCount > 0
      ? (context.isLateRound ? 1.1 : 0.65)
      : -.infinity
    return Swift.max(expectedTarget?.gain ?? -.infinity, revealFallback)
  }

  private static func ultraDrawSourceScore(
    player: AIKnowledgePlayer,
    knowledge: AIKnowledgeState,
    hiddenEstimate: Double,
    context: RoundContext
  ) -> Double {
    remainingValueDistribution(knownValues: knowledge.knownValues).reduce(0) { expected, item in
      let target = replacementTargets(
        player: player,
        replacementValue: item.value,
        hiddenEstimate: hiddenEstimate,
        context: context,
        difficulty: .ultra
      ).first
      let revealValue = context.hiddenCount > 0
        ? (context.isLateRound ? 0.95 : 0.5)
        : -.infinity
      return expected + item.probability * Swift.max(target?.gain ?? -.infinity, revealValue)
    }
  }

  private static func discardSourceMargin(
    discardValue: Int,
    hiddenEstimate: Double,
    context: RoundContext
  ) -> Double {
    let base = context.isFinalTurn ? 0.1 : context.isLateRound ? 0.45 : 0.85
    if discardValue <= 1 { return Swift.max(0.05, base - 0.35) }
    if Double(discardValue) >= hiddenEstimate + 3 { return base + 0.75 }
    return base
  }

  private static func drawnCardPlacementThreshold(
    drawnValue: Int,
    hiddenEstimate: Double,
    context: RoundContext,
    difficulty: AIDifficulty
  ) -> Double {
    let visiblePressure = context.visibleTotal >= 24 ? -0.35 : 0
    let base = context.isFinalTurn
      ? 0.2
      : context.isLateRound
        ? 0.55
        : Double(drawnValue) <= hiddenEstimate ? 1 : 1.45
    let adjustment = difficulty == .easy ? -0.65 : difficulty == .medium ? -0.2 : 0
    let minimum = difficulty == .easy ? 0.05 : 0.2
    return Swift.max(minimum, base + visiblePressure + adjustment)
  }

  private static func chooseSource<R: SkyjoRandomNumberGenerator>(
    knowledge: AIKnowledgeState,
    player: AIKnowledgePlayer,
    context: RoundContext,
    hiddenEstimate: Double,
    difficulty: AIDifficulty,
    random: inout R
  ) -> AIMove {
    guard let discardValue = knowledge.discardTopValue else { return AIMove(action: .draw) }
    let discardTarget = replacementTargets(
      player: player,
      replacementValue: Double(discardValue),
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty
    ).first
    guard let discardTarget, discardTarget.gain > 0 else { return AIMove(action: .draw) }
    let bias = clamp(
      (hiddenEstimate - Double(discardValue)) * 0.15,
      minimum: -0.8,
      maximum: 0.8
    )
    let discardScore = discardTarget.score + bias
    let drawScore = drawSourceScore(
      player: player,
      hiddenEstimate: hiddenEstimate,
      context: context,
      difficulty: difficulty == .ultra ? .hard : difficulty
    )
    let hardMargin = discardSourceMargin(
      discardValue: discardValue,
      hiddenEstimate: hiddenEstimate,
      context: context
    )
    if difficulty == .hard {
      return AIMove(action: discardScore >= drawScore + hardMargin ? .discard : .draw)
    }
    if difficulty == .ultra {
      if discardScore >= drawScore + hardMargin { return AIMove(action: .discard) }
      let exactDrawScore = ultraDrawSourceScore(
        player: player,
        knowledge: knowledge,
        hiddenEstimate: hiddenEstimate,
        context: context
      )
      return AIMove(action: discardScore >= exactDrawScore + 0.2 ? .discard : .draw)
    }
    let temperature = difficulty == .easy ? 3.25 : 1.45
    let margin = difficulty == .easy ? hardMargin * 0.2 : hardMargin * 0.55
    let discardProbability = 1 / (1 + Foundation.exp(
      -(discardScore - drawScore - margin) / temperature
    ))
    return AIMove(action: random.nextUnitInterval() < discardProbability ? .discard : .draw)
  }

  private static func projectedDoublingRisk(
    projectedScore: Double,
    context: RoundContext
  ) -> Double {
    if context.roundHasCloser || projectedScore <= 0 { return 0 }
    if context.opponentEstimatedTotals.allSatisfy({ projectedScore < $0 }) { return 0 }
    let lowestOpponent = context.opponentEstimatedTotals.min() ?? .infinity
    return projectedScore * 0.85 + Swift.max(0, projectedScore - lowestOpponent) * 0.15
  }
}
