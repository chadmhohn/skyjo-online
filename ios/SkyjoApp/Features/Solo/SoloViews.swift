import SkyjoDesignSystem
import SkyjoDomain
import SkyjoPersistence
import SwiftUI

@MainActor
struct SoloRootView: View {
  @Bindable var model: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore

  var body: some View {
    Group {
      switch model.screen {
      case .loading:
        ProgressView("Loading saved game")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityIdentifier("solo.loading")
      case .launcher:
        SoloLauncherView(model: model)
      case .setup:
        SoloSetupView(model: model)
      case .table:
        SoloGameView(model: model, preferences: preferences)
      }
    }
    .navigationTitle(model.screen == .table ? "Solo Table" : "Single Player")
    .navigationBarTitleDisplayMode(model.screen == .table ? .inline : .automatic)
    .sheet(isPresented: $model.isReplacementReviewPresented) {
      SoloReplacementReviewView(model: model)
        .presentationDetents([.medium, .large])
    }
    .onDisappear {
      if model.screen == .table {
        model.leaveTable()
      }
    }
  }
}

@MainActor
private struct SoloLauncherView: View {
  @Bindable var model: SoloFeatureModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let warning = model.persistenceWarning {
          SkyjoStatusBanner(
            title: warningTitle(warning.kind),
            message: warning.message,
            systemImage: warning.kind == .recovered ? "checkmark.shield.fill" : "externaldrive.badge.exclamationmark"
          )
          .accessibilityIdentifier("solo.persistence-warning")
        }

        GroupBox {
          VStack(alignment: .leading, spacing: 14) {
            Label("Saved game", systemImage: "arrow.clockwise.circle.fill")
              .font(.title2.bold())
            if let summary = model.savedGameSummary {
              LabeledContent("Round", value: summary.round.formatted())
              LabeledContent("Opponents", value: summary.opponents.formatted())
              LabeledContent("Difficulty", value: summary.difficulty.displayName)
              LabeledContent(
                "Saved",
                value: Date(timeIntervalSince1970: Double(summary.savedAtMilliseconds) / 1_000)
                  .formatted(date: .abbreviated, time: .shortened)
              )
            }
            Button {
              model.continueSavedGame()
            } label: {
              Text("Continue Game")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("solo.continue")

            Button {
              model.showSetup()
            } label: {
              Text("Set Up New Game")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("solo.new-game")
            .accessibilityHint("Reviews the replacement before changing this saved game")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        SoloRecoveryView(model: model)
      }
      .frame(maxWidth: 680, alignment: .leading)
      .padding()
    }
    .accessibilityIdentifier("solo.launcher")
  }
}

@MainActor
private struct SoloSetupView: View {
  @Bindable var model: SoloFeatureModel

  var body: some View {
    Form {
      if let warning = model.persistenceWarning {
        Section {
          SkyjoStatusBanner(title: warningTitle(warning.kind), message: warning.message)
        }
      }

      Section("Opponents") {
        Stepper(value: $model.setupOpponentCount, in: GameEngine.singlePlayerAIOpponentRange) {
          LabeledContent("Bots", value: model.setupOpponentCount.formatted())
        }
        .accessibilityIdentifier("solo.setup.bot-count")
        Text("Choose from 1 to 7 computer opponents. More opponents create a busier table and a longer round.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }

      Section("Difficulty") {
        Picker("Bot difficulty", selection: $model.setupDifficulty) {
          ForEach(SoloAIDifficultySelection.allCases, id: \.self) { difficulty in
            Text(difficulty.displayName).tag(difficulty)
          }
        }
        .pickerStyle(.navigationLink)
        .accessibilityIdentifier("solo.setup.difficulty")

        Label(model.setupDifficulty.explanation, systemImage: model.setupDifficulty.systemImage)
          .font(.callout)
          .foregroundStyle(.secondary)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("solo.setup.difficulty-explanation")
      }

      Section {
        Button(model.hasDurableActiveSession ? "Review New Game" : "Start Game") {
          Task { await model.reviewNewGame() }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isWorking)
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityIdentifier("solo.setup.start")

        if model.hasDurableActiveSession {
          Button("Keep Saved Game") {
            model.cancelSetup()
          }
          .frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityIdentifier("solo.setup.cancel")
        }
      }

      if let error = model.lastActionError {
        Section {
          Label(error, systemImage: "exclamationmark.circle.fill")
            .foregroundStyle(.red)
            .accessibilityIdentifier("solo.setup.error")
        }
      }

      Section {
        Text("Nothing is created or written until you press Start Game and any required replacement is confirmed.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityIdentifier("solo.setup")
  }
}

@MainActor
private struct SoloReplacementReviewView: View {
  @Bindable var model: SoloFeatureModel
  @Environment(\.dismiss) private var dismiss
  @AccessibilityFocusState private var errorFocused: Bool

  var body: some View {
    NavigationStack {
      List {
        Section("Current saved game") {
          if let summary = model.savedGameSummary {
            LabeledContent("Round", value: summary.round.formatted())
            LabeledContent("Opponents", value: summary.opponents.formatted())
            LabeledContent("Difficulty", value: summary.difficulty.displayName)
          }
        }
        Section("Replacement") {
          LabeledContent("Opponents", value: model.setupOpponentCount.formatted())
          LabeledContent("Difficulty", value: model.setupDifficulty.displayName)
          Text("The current save is removed only after the replacement is fully validated and saved. A failure leaves the current game recoverable.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("solo.replace.recovery-copy")
        }
        if let error = model.lastActionError {
          Section("Replacement not saved") {
            SkyjoStatusBanner(
              title: "Previous game preserved",
              message: error,
              systemImage: "externaldrive.badge.exclamationmark"
            )
            .accessibilityIdentifier("solo.replace.error")
            .accessibilityFocused($errorFocused)
          }
        }
        Section {
          Button("Replace Saved Game", role: .destructive) {
            Task {
              await model.confirmReplacement()
              if !model.isReplacementReviewPresented { dismiss() }
            }
          }
          .disabled(model.isWorking)
          .frame(minHeight: 44)
          .accessibilityIdentifier("solo.replace.confirm")
        }
      }
      .navigationTitle("Review Replacement")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            model.isReplacementReviewPresented = false
            dismiss()
          }
          .accessibilityIdentifier("solo.replace.cancel")
        }
      }
    }
    .interactiveDismissDisabled(model.isWorking)
    .onAppear { errorFocused = model.lastActionError != nil }
    .onChange(of: model.lastActionError) { _, error in
      errorFocused = error != nil
    }
  }
}

@MainActor
private struct SoloGameView: View {
  @Bindable var model: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @AccessibilityFocusState private var drawnDecisionFocused: Bool

  var body: some View {
    GeometryReader { proxy in
      let wide = proxy.size.width >= 700
      let compactHeight = proxy.size.height < 650
      Group {
        if dynamicTypeSize.isAccessibilitySize {
          accessibleTable(size: proxy.size)
        } else if compactHeight {
          compactLandscapeTable(size: proxy.size)
        } else {
          standardTable(size: proxy.size, wide: wide)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .background(Color(uiColor: .systemGroupedBackground))
    }
    .accessibilityIdentifier("solo.table")
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        if model.isScoreSummaryMinimized {
          Button {
            model.setScoreSummaryPresented(true)
          } label: {
            Label("Scores", systemImage: "list.number")
              .labelStyle(.iconOnly)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .accessibilityLabel("Scores")
          .accessibilityIdentifier("solo.summary.restore")
        }
        Button {
          model.setSettingsPresented(true)
        } label: {
          Label("Settings", systemImage: "gearshape")
            .labelStyle(.iconOnly)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Settings")
        .accessibilityIdentifier("solo.settings.open")
      }
    }
    .sheet(isPresented: $model.isScoreSummaryPresented) {
      SoloScoreSummaryView(model: model)
        .interactiveDismissDisabled(model.game?.phase == .gameOver && !model.completionCommitted)
    }
    .sheet(isPresented: $model.isSettingsPresented) {
      SoloSettingsView(model: model, preferences: preferences)
    }
    .onChange(of: model.isScoreSummaryPresented) { _, value in
      if !value { model.setScoreSummaryPresented(false) }
    }
    .onChange(of: model.isSettingsPresented) { _, value in
      if !value { model.setSettingsPresented(false) }
    }
    .onChange(of: model.game?.drawnCard?.id) {
      drawnDecisionFocused = model.game?.drawnCard != nil && model.isHumanTurn
    }
    .onChange(of: reduceMotion, initial: true) { _, value in
      model.setReduceMotion(value)
    }
  }

  private func standardTable(size: CGSize, wide: Bool) -> some View {
    let bandHeight = min(max(size.height * 0.18, 120), 150)
    let localBoardHeight = min(max(size.height * 0.44, 270), 340)
    return VStack(spacing: 10) {
      gameHeader
      opponentRegion(wide: wide)
        .frame(maxHeight: .infinity)
      actionBand(wide: wide)
        .frame(height: bandHeight)
        .accessibilitySortPriority(4)
      humanBoard(compact: false)
        .frame(maxWidth: 520)
        .frame(height: localBoardHeight)
        .frame(maxWidth: .infinity)
        .accessibilitySortPriority(2)
    }
    .padding(.horizontal, wide ? 20 : 8)
    .padding(.vertical, 6)
  }

  private func accessibleTable(size: CGSize) -> some View {
    ScrollView(.vertical) {
      VStack(spacing: 12) {
        gameHeader
        opponentRegion(wide: size.width >= 700, boardsPerViewport: 1)
          .frame(height: min(max(size.width * 0.88, 330), 390))
        actionBand(wide: false)
          .accessibilitySortPriority(4)
        humanBoard(compact: false)
          .frame(maxWidth: 520)
          .frame(maxWidth: .infinity)
          .accessibilitySortPriority(2)
      }
      .padding(.horizontal, size.width >= 700 ? 20 : 8)
      .padding(.vertical, 6)
    }
    .scrollIndicators(.visible)
    .accessibilityIdentifier("solo.table.accessible-scroll")
  }

  private func compactLandscapeTable(size: CGSize) -> some View {
    let opponentWidth = min(max(size.width * 0.26, 214), 240)
    let localWidth = min(max(size.width * 0.32, 210), 320)
    return VStack(spacing: 6) {
      gameHeader
      HStack(spacing: 8) {
        opponentRegion(wide: false, boardsPerViewport: 1)
          .frame(width: opponentWidth)
          .frame(maxHeight: .infinity)
        actionBand(wide: true)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilitySortPriority(4)
        humanBoard(compact: true)
          .frame(width: localWidth)
          .frame(maxHeight: .infinity)
          .accessibilitySortPriority(2)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
  }

  @ViewBuilder
  private func humanBoard(compact: Bool) -> some View {
    if let human = model.humanPlayer {
      PlayerBoardView(
        player: human,
        isLocal: true,
        isCompact: compact,
        differentiateWithoutColor: differentiateWithoutColor,
        actionForIndex: { index in
          Task { await model.tapHumanCard(at: index) }
        },
        isEnabledAtIndex: isHumanCardEnabled
      )
    }
  }

  private var gameHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Round \(model.game?.round ?? 1)")
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("solo.table.round")
        Text(model.currentPlayer.map { $0.kind == .human ? "Your turn" : "\($0.name)'s turn" } ?? "Table paused")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if model.owner.accountID == nil {
        Label("Guest", systemImage: "person.crop.circle.badge.questionmark")
          .font(.caption.bold())
          .labelStyle(.iconOnly)
          .accessibilityLabel("Guest game. Completed games are not added to account stats.")
      }
      if model.persistenceWarning != nil {
        Button {
          model.setSettingsPresented(true)
        } label: {
          Label("Save warning", systemImage: "externaldrive.badge.exclamationmark")
            .font(.caption.bold())
        }
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityHint("Opens recovery details without interrupting the current turn")
        .accessibilityIdentifier("solo.table.persistence-warning")
      }
      Button {
        model.leaveTable()
      } label: {
        Label("Exit", systemImage: "xmark.circle")
          .labelStyle(.iconOnly)
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Exit")
      .accessibilityIdentifier("solo.table.exit")
    }
    .accessibilityElement(children: .contain)
    .accessibilitySortPriority(5)
  }

  @ViewBuilder
  private func opponentRegion(wide: Bool, boardsPerViewport: Int = 2) -> some View {
    let opponents = model.game?.players.filter { $0.kind == .ai } ?? []
    if wide {
      ScrollView(.vertical) {
        LazyVGrid(
          // Three boards across in iPad portrait and four in landscape keeps
          // every 3x4 grid legible while honoring uncapped accessibility text.
          columns: [GridItem(.adaptive(minimum: 260, maximum: 320), spacing: 10)],
          spacing: 10
        ) {
          ForEach(opponents, id: \.id) { player in
            PlayerBoardView(
              player: player,
              isLocal: false,
              isCompact: true,
              differentiateWithoutColor: differentiateWithoutColor,
              actionForIndex: { _ in },
              isEnabledAtIndex: { _ in false }
            )
          }
        }
      }
      .accessibilityIdentifier("solo.opponents.scroll")
    } else {
      ScrollView(.horizontal) {
        LazyHStack(spacing: 6) {
          ForEach(opponents, id: \.id) { player in
            PlayerBoardView(
              player: player,
              isLocal: false,
              isCompact: true,
              differentiateWithoutColor: differentiateWithoutColor,
              actionForIndex: { _ in },
              isEnabledAtIndex: { _ in false }
            )
            .containerRelativeFrame(
              .horizontal,
              count: opponents.count == 1 ? 1 : boardsPerViewport,
              spacing: 6
            )
          }
        }
        .scrollTargetLayout()
      }
      .scrollTargetBehavior(.viewAligned)
      .scrollIndicators(.visible)
      .accessibilityIdentifier("solo.opponents.scroll")
    }
  }

  @ViewBuilder
  private func actionBand(wide: Bool) -> some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
          GridRow {
            drawSlot
            discardSlot
          }
          GridRow {
            drawnSlot
            guidanceSlot
          }
        }
      } else {
        HStack(spacing: wide ? 12 : 6) {
          drawSlot
          discardSlot
          drawnSlot
          guidanceSlot
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("solo.action-band")
  }

  private var drawSlot: some View {
    SkyjoActionSlot {
      Button {
        Task { await model.performHuman(.drawBlind) }
      } label: {
        VStack(spacing: 4) {
          Image(systemName: "rectangle.stack.fill")
          Text(dynamicTypeSize.isAccessibilitySize ? "Deck" : "Draw")
            .lineLimit(1)
            .minimumScaleFactor(0.5)
          Text(model.game?.drawPile.count.formatted() ?? "0")
            .font(.caption.monospacedDigit())
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
      }
      .buttonStyle(.bordered)
      .disabled(!canChooseSource)
      .accessibilityLabel("Draw blind")
      .accessibilityValue("\(model.game?.drawPile.count ?? 0) cards remain")
      .accessibilityIdentifier("solo.action.draw")
    }
  }

  private var discardSlot: some View {
    SkyjoActionSlot {
      Button {
        Task {
          if model.game?.selectedSource == .discard {
            await model.performHuman(.cancelDiscard)
          } else {
            await model.performHuman(.chooseDiscard)
          }
        }
      } label: {
        VStack(spacing: 4) {
          Image(systemName: "rectangle.portrait.fill")
          Text(dynamicTypeSize.isAccessibilitySize ? "Pile" : "Discard")
            .lineLimit(1)
            .minimumScaleFactor(0.5)
          Text(model.game?.discardPile.first?.value.formatted() ?? "Empty")
            .font(.headline.monospacedDigit())
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
      }
      .buttonStyle(.bordered)
      .disabled(!(canChooseSource || model.game?.selectedSource == .discard))
      .accessibilityLabel(
        model.game?.discardPile.first.map { "Discard pile, top card \(spokenValue($0.value))" }
          ?? "Discard pile, empty"
      )
      .accessibilityHint(
        model.game?.selectedSource == .discard
          ? "Cancels the discard selection"
          : "Takes the visible card"
      )
      .accessibilityIdentifier("solo.action.discard")
    }
  }

  @ViewBuilder
  private var drawnSlot: some View {
    SkyjoActionSlot(isOccupied: model.isHumanTurn && model.game?.drawnCard != nil) {
      Group {
        if model.isHumanTurn, let drawnCard = model.game?.drawnCard {
          VStack(spacing: 4) {
            Text("Drawn").font(.caption)
            Text(drawnCard.value.formatted())
              .font(.title2.monospacedDigit().bold())
            Picker("Drawn card action", selection: $model.drawChoice) {
              ForEach(SoloDrawChoice.allCases) { Text($0.rawValue).tag($0) }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .accessibilityFocused($drawnDecisionFocused)
            .accessibilityIdentifier("solo.action.drawn-choice")
          }
        } else {
          Color.clear.accessibilityHidden(true)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var guidanceSlot: some View {
    SkyjoActionSlot {
      VStack(spacing: 6) {
        Image(systemName: guidanceImage)
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
        Text(dynamicTypeSize.isAccessibilitySize ? compactActionGuidance : model.actionGuidance)
          .font(dynamicTypeSize.isAccessibilitySize ? .caption : .footnote)
          .foregroundStyle(.primary)
          .multilineTextAlignment(.center)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? 5 : 4)
          .minimumScaleFactor(0.75)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(6)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(model.actionGuidance)
      .accessibilityIdentifier("solo.action.guidance")
    }
  }

  private var canChooseSource: Bool {
    model.isHumanTurn && model.game?.phase == .chooseSource
  }

  private var guidanceImage: String {
    switch model.game?.phase {
    case .openingReveal: "hand.tap"
    case .chooseSource: "arrow.triangle.branch"
    case .chooseReplacement: "rectangle.2.swap"
    case .roundOver: "list.number"
    case .gameOver: "trophy.fill"
    case nil: "pause.circle"
    }
  }

  private var compactActionGuidance: String {
    switch model.game?.phase {
    case .openingReveal: "Reveal 2 cards"
    case .chooseSource: "Choose a pile"
    case .chooseReplacement: "Choose a card"
    case .roundOver: "Round complete"
    case .gameOver: "Game complete"
    case nil: "Paused"
    }
  }

  private func isHumanCardEnabled(_ index: Int) -> Bool {
    guard model.isHumanTurn,
          let game = model.game,
          let human = model.humanPlayer,
          human.grid.indices.contains(index),
          !human.grid[index].removed
    else { return false }
    switch game.phase {
    case .openingReveal:
      return !human.grid[index].faceUp
    case .chooseReplacement:
      if game.selectedSource == .draw, model.drawChoice == .discardAndReveal {
        return !human.grid[index].faceUp
      }
      return true
    case .chooseSource, .roundOver, .gameOver:
      return false
    }
  }
}

struct PlayerBoardView: View {
  let player: Player
  let isLocal: Bool
  let isCompact: Bool
  let differentiateWithoutColor: Bool
  let actionForIndex: (Int) -> Void
  let isEnabledAtIndex: (Int) -> Bool

  var body: some View {
    VStack(spacing: isCompact ? 2 : 7) {
      HStack {
        Text(isLocal ? "You" : player.name)
          .font(isCompact ? .caption2.bold() : .headline)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        Text("\(player.totalScore) pts")
          .font((isCompact ? Font.caption2 : Font.caption).monospacedDigit())
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("solo.board.header.\(isLocal ? "local" : "opponent").\(player.id)")
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: isCompact ? 1 : 6), count: 4),
        spacing: isCompact ? 1 : 6
      ) {
        ForEach(Array(player.grid.enumerated()), id: \.offset) { index, card in
          let row = index / SkyjoRules.columns + 1
          let column = index % SkyjoRules.columns + 1
          SkyjoCardView(
            face: presentation(for: card),
            label: cardLabel(card, row: row, column: column),
            hint: cardHint(card, index: index),
            isEnabled: isEnabledAtIndex(index),
            aspectRatio: isCompact ? 1 : 1.35,
            action: { actionForIndex(index) }
          )
          .overlay(alignment: .topTrailing) {
            if differentiateWithoutColor, card.faceUp, !card.removed {
              Image(systemName: card.value >= 9 ? "exclamationmark" : "checkmark")
                .font(.caption2.bold())
                .padding(3)
                .accessibilityHidden(true)
            }
          }
          .accessibilityIdentifier("solo.card.\(isLocal ? "local" : "opponent").\(player.id).r\(row).c\(column)")
        }
      }
    }
    .padding(isCompact ? 3 : 10)
    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12).stroke(.secondary, lineWidth: 1)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(isLocal ? "Your board" : "\(player.name)'s board")
    .accessibilityIdentifier("solo.board.\(isLocal ? "local" : "opponent").\(player.id)")
  }

  private func presentation(for card: Card) -> SkyjoCardFace {
    if card.removed { return .removed }
    if card.faceUp { return .faceUp(card.value) }
    return .faceDown
  }

  private func cardLabel(_ card: Card, row: Int, column: Int) -> String {
    let prefix = isLocal ? "Your card" : "\(player.name)'s card"
    if card.removed { return "\(prefix), row \(row), column \(column), cleared" }
    if card.faceUp {
      return "\(prefix), row \(row), column \(column), \(spokenValue(card.value))"
    }
    return "\(prefix), row \(row), column \(column), face down"
  }

  private func cardHint(_ card: Card, index: Int) -> String? {
    guard isEnabledAtIndex(index) else { return nil }
    return card.faceUp ? "Replaces this card" : "Selects this face-down card for the current action"
  }
}

@MainActor
private struct SoloScoreSummaryView: View {
  @Bindable var model: SoloFeatureModel
  @AccessibilityFocusState private var headingFocused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(model.game?.phase == .gameOver ? "Game complete" : "Round complete")
            .font(.largeTitle.bold())
            .accessibilityFocused($headingFocused)
            .accessibilityIdentifier("solo.summary.heading")

          if let entry = model.game?.roundHistory.last {
            ForEach(entry.scores, id: \.playerId) { score in
              HStack {
                VStack(alignment: .leading) {
                  Text(score.name).font(.headline)
                  Text("Round \(score.roundScore)").foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(score.totalScore) total")
                  .font(.title3.monospacedDigit().bold())
              }
              .padding()
              .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
              .accessibilityElement(children: .combine)
            }
          }

          if let error = model.completionError {
            SkyjoStatusBanner(title: "Result needs attention", message: error)
            Button("Retry Saving Result") {
              Task { await model.retryCompletion() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isWorking)
            .frame(minHeight: 44)
            .accessibilityIdentifier("solo.summary.retry-completion")
          } else if model.game?.phase == .gameOver {
            Label(
              model.completedStatsMessage,
              systemImage: model.owner.accountID == nil
                ? "person.crop.circle.badge.questionmark"
                : (model.statsDeliveryIsConfirmed ? "checkmark.circle.fill" : "icloud.slash")
            )
            .accessibilityIdentifier("solo.summary.stats-state")
          }

          SoloRecoveryView(model: model)

          if model.game?.phase == .roundOver {
            Button {
              Task { await model.startNextRound() }
            } label: {
              Text("Start Next Round")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("solo.summary.next-round")
          } else if model.completionCommitted {
            Button { model.replay() } label: {
              Text("Play Again")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
              .buttonStyle(.borderedProminent)
              .accessibilityIdentifier("solo.summary.replay")
            Button { model.replay() } label: {
              Text("Change Setup")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
              .buttonStyle(.bordered)
              .accessibilityIdentifier("solo.summary.change-setup")
          }
        }
        .padding()
      }
      .navigationTitle("Scores")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Minimize") {
            model.setScoreSummaryPresented(false)
          }
          .disabled(model.game?.phase == .gameOver && !model.completionCommitted)
          .accessibilityIdentifier("solo.summary.minimize")
        }
      }
    }
    .onAppear { headingFocused = true }
  }
}

@MainActor
private struct SoloSettingsView: View {
  @Bindable var model: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        if let warning = model.persistenceWarning {
          Section("Local recovery") {
            SkyjoStatusBanner(title: warningTitle(warning.kind), message: warning.message)
              .accessibilityIdentifier("solo.settings.persistence-warning")
          }
        }
        Section("Feedback") {
          Toggle("Sound effects", isOn: $preferences.soundEffectsEnabled)
            .accessibilityIdentifier("solo.settings.sound")
          Toggle("Haptics", isOn: $preferences.hapticsEnabled)
            .accessibilityIdentifier("solo.settings.haptics")
          Toggle("Music", isOn: .constant(false))
            .disabled(true)
            .accessibilityIdentifier("solo.settings.music")
          Text("Music defaults off and remains unavailable until an original or licensed track is approved. Sound effects use the bundled CC0 card cues.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        if let setup = model.setup {
          Section("Current game") {
            LabeledContent("Opponents", value: setup.aiOpponentCount.formatted())
            LabeledContent("Difficulty", value: setup.difficulty.displayName)
            Button("Set Up Another Game") {
              dismiss()
              model.setSettingsPresented(false)
              model.showSetup()
            }
            .frame(minHeight: 44)
            .accessibilityIdentifier("solo.settings.new-game")
          }
        }

        Section("How to play") {
          Text("Reveal two cards. On each turn, take the discard or draw blind, then replace a card or discard the draw and reveal. Three matching revealed cards in a column clear for zero points.")
          Text("When someone reveals every remaining card, each other player gets one final turn. The lowest total wins; reaching 100 ends the game.")
        }

        Section("Move log") {
          ForEach(Array((model.game?.log ?? []).prefix(20).enumerated()), id: \.offset) { _, entry in
            Text(entry)
          }
        }

        Section("Stats delivery") {
          Label(
            model.settingsStatsMessage,
            systemImage: model.owner.accountID == nil
              ? "person.crop.circle.badge.questionmark"
              : (model.statsDeliveryIsConfirmed ? "checkmark.circle" : "icloud.slash")
          )
          SoloRecoveryView(model: model)
        }
      }
      .navigationTitle("Game Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            dismiss()
            model.setSettingsPresented(false)
          }
        }
      }
      .task { await model.refreshOutboxStatus() }
    }
  }
}

@MainActor
private struct SoloRecoveryView: View {
  @Bindable var model: SoloFeatureModel
  @State private var confirmDiscard = false

  var body: some View {
    if let kind = model.outboxStatus.blockedHeadKind {
      GroupBox("Stats delivery needs attention") {
        VStack(alignment: .leading, spacing: 10) {
          Text(kind == .terminal
            ? "The oldest result was rejected permanently. Retry after a compatibility fix, or discard only after confirming it is no longer needed."
            : "The oldest queued result is damaged and cannot be submitted. Discarding only this blocked item lets later results continue.")
          if kind == .terminal {
            Button("Retry Oldest Result") {
              Task { await model.retryBlockedStats() }
            }
            .disabled(!model.statsDeliveryIsConfirmed)
            .frame(minHeight: 44)
            .accessibilityIdentifier("solo.outbox.retry")
          }
          Button("Discard Oldest Result", role: .destructive) {
            confirmDiscard = true
          }
          .disabled(!model.statsDeliveryIsConfirmed)
          .frame(minHeight: 44)
            .accessibilityIdentifier("solo.outbox.discard")
          if !model.statsDeliveryIsConfirmed {
            Text("Confirm this account online before retrying or discarding its stored result.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .confirmationDialog(
        "Discard this completed result?",
        isPresented: $confirmDiscard,
        titleVisibility: .visible
      ) {
        Button("Discard Result", role: .destructive) {
          Task { await model.discardBlockedStats() }
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This removes only the blocked local stats item. It cannot be recovered afterward.")
      }
    }
  }
}

extension SoloAIDifficultySelection {
  var displayName: String {
    switch self {
    case .easy: "Easy"
    case .medium: "Medium"
    case .hard: "Hard"
    case .ultra: "Ultra Hard"
    case .mixed: "Mixed"
    }
  }

  var explanation: String {
    switch self {
    case .easy:
      "Relaxed choices with more variety; a friendly place to learn."
    case .medium:
      "Balanced decisions and the default for a new player."
    case .hard:
      "Tracks revealed information and replaces cards more aggressively."
    case .ultra:
      "Evaluates deck outcomes and closing risk for the strongest challenge."
    case .mixed:
      "Deterministically balances Easy, Medium, Hard, and Ultra opponents for this game."
    }
  }

  var systemImage: String {
    switch self {
    case .easy: "leaf"
    case .medium: "scale.3d"
    case .hard: "brain"
    case .ultra: "bolt.brain"
    case .mixed: "shuffle"
    }
  }
}

private func spokenValue(_ value: Int) -> String {
  value < 0 ? "minus \(abs(value))" : value.formatted()
}

private func warningTitle(_ kind: SoloPersistenceWarningKind) -> String {
  switch kind {
  case .conflict: "Saved game changed"
  case .quota: "Device storage is low"
  case .recovered: "Saved game recovered"
  case .unavailable: "Saving is unavailable"
  case .statsNotSaved: "Stats are not saved yet"
  }
}
