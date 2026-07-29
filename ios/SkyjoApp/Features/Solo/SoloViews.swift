import Foundation
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
      if model.sessionReconciliationRequired {
        SoloSessionReconciliationView(model: model)
      } else {
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
    }
    .navigationTitle(
      !model.sessionReconciliationRequired && model.screen == .table
        ? "Solo Table"
        : "Single Player"
    )
    .navigationBarTitleDisplayMode(
      !model.sessionReconciliationRequired && model.screen == .table
        ? .inline
        : .automatic
    )
    .sheet(isPresented: $model.isReplacementReviewPresented) {
      SoloReplacementReviewView(model: model)
        .presentationDetents([.large])
    }
    .onDisappear {
      if model.screen == .table {
        model.leaveTable()
      }
    }
  }
}

@MainActor
private struct SoloSessionReconciliationView: View {
  @Bindable var model: SoloFeatureModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        SkyjoStatusBanner(
          title: "Saved game status unknown",
          message: "Skyjo must reload the authoritative saved game before play can continue.",
          systemImage: "externaldrive.badge.exclamationmark"
        )
        if let error = model.lastActionError {
          Text(error)
            .foregroundStyle(.secondary)
        }
        Button {
          Task { await model.retrySessionReconciliation() }
        } label: {
          HStack {
            if model.isWorking { ProgressView() }
            Text("Reload Saved Game")
              .frame(maxWidth: .infinity, minHeight: 44)
              .contentShape(Rectangle())
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isWorking)
        .accessibilityIdentifier("solo.reconciliation.reload")
      }
      .frame(maxWidth: 680, alignment: .leading)
      .padding()
    }
    .accessibilityIdentifier("solo.reconciliation")
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
            Label(
              model.activeSessionIsPersistent ? "Saved game" : "Temporary game",
              systemImage: model.activeSessionIsPersistent
                ? "arrow.clockwise.circle.fill"
                : "hourglass"
            )
              .font(.title2.bold())
            if let summary = model.savedGameSummary {
              LabeledContent("Round", value: summary.round.formatted())
              LabeledContent("Opponents", value: summary.opponents.formatted())
              LabeledContent("Difficulty", value: summary.difficulty.displayName)
              LabeledContent(
                model.activeSessionIsPersistent ? "Saved" : "Updated",
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
            .buttonStyle(SoloSecondaryButtonStyle())
            .disabled(model.hasUncommittedTerminalCompletion)
            .accessibilityIdentifier("solo.new-game")
            .accessibilityHint(
              model.activeSessionIsPersistent
                ? "Reviews the replacement before changing this saved game"
                : "Reviews the replacement before changing this temporary game"
            )

            if model.hasUncommittedTerminalCompletion {
              Text("Save or recover the completed result before setting up another game.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("solo.launcher.completion-blocked")
            }
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

      if model.outboxStatus.blockedHeadKind != nil {
        Section {
          SoloRecoveryView(model: model)
        }
      }

      if let message = model.outboxRecoveryMessage {
        Section {
          HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
              .accessibilityHidden(true)
            Text(message)
          }
            .foregroundStyle(.green)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(message)
            .accessibilityIdentifier("solo.outbox.status")
        }
      }

      Section {
        Stepper(value: $model.setupOpponentCount, in: GameEngine.singlePlayerAIOpponentRange) {
          LabeledContent("Bots", value: model.setupOpponentCount.formatted())
        }
        .accessibilityIdentifier("solo.setup.bot-count")
        Text("Choose from 1 to 7 computer opponents. More opponents create a busier table and a longer round.")
          .font(.footnote)
          .foregroundStyle(.primary)
      } header: {
        Text("Opponents")
          .font(.caption.weight(.black))
          .foregroundStyle(Color.primary)
      }

      Section {
        Picker("Bot difficulty", selection: $model.setupDifficulty) {
          ForEach(SoloAIDifficultySelection.allCases, id: \.self) { difficulty in
            Text(difficulty.displayName)
              .tag(difficulty)
              .accessibilityIdentifier("solo.setup.difficulty.\(difficulty.rawValue)")
          }
        }
        .pickerStyle(.navigationLink)
        .accessibilityIdentifier("solo.setup.difficulty")

        Label(model.setupDifficulty.explanation, systemImage: model.setupDifficulty.systemImage)
          .font(.callout)
          .foregroundStyle(.primary)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("solo.setup.difficulty-explanation")
      } header: {
        Text("Difficulty")
          .font(.caption.weight(.black))
          .foregroundStyle(Color.primary)
      }

      Section {
        Button(model.hasDurableActiveSession ? "Review New Game" : "Start Game") {
          Task { await model.reviewNewGame() }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isWorking || model.hasUncommittedTerminalCompletion)
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityIdentifier("solo.setup.start")

        if model.hasUncommittedTerminalCompletion {
          Text("Save or recover the completed result before setting up another game.")
            .font(.footnote)
            .foregroundStyle(.primary)
            .accessibilityIdentifier("solo.setup.completion-blocked")
        }

        if model.hasDurableActiveSession {
          Button(model.activeSessionIsPersistent ? "Keep Saved Game" : "Keep Temporary Game") {
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
          .foregroundStyle(.primary)
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
        Section {
          if let summary = model.savedGameSummary {
            LabeledContent("Round", value: summary.round.formatted())
              .accessibilityElement(children: .combine)
              .accessibilityLabel("Round")
              .accessibilityValue(summary.round.formatted())
              .accessibilityIdentifier("solo.replace.current-round")
            LabeledContent("Opponents", value: summary.opponents.formatted())
              .accessibilityElement(children: .combine)
              .accessibilityLabel("Opponents")
              .accessibilityValue(summary.opponents.formatted())
              .accessibilityIdentifier("solo.replace.current-opponents")
            LabeledContent("Difficulty", value: summary.difficulty.displayName)
              .accessibilityElement(children: .combine)
              .accessibilityLabel("Difficulty")
              .accessibilityValue(summary.difficulty.displayName)
              .accessibilityIdentifier("solo.replace.current-difficulty")
          }
        } header: {
          Text(model.activeSessionIsPersistent ? "Current saved game" : "Current temporary game")
            .foregroundStyle(Color.primary)
        }
        Section {
          LabeledContent("Opponents", value: model.setupOpponentCount.formatted())
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Opponents")
            .accessibilityValue(model.setupOpponentCount.formatted())
            .accessibilityIdentifier("solo.replace.new-opponents")
          LabeledContent("Difficulty", value: model.setupDifficulty.displayName)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Difficulty")
            .accessibilityValue(model.setupDifficulty.displayName)
            .accessibilityIdentifier("solo.replace.new-difficulty")
          Text(
            model.activeSessionIsPersistent
              ? "The current save is removed only after the replacement is fully validated and saved. A failure leaves the current game recoverable."
              : "The temporary game changes only after the replacement is fully validated in memory. It will not survive closing Skyjo while device storage is unavailable."
          )
            .foregroundStyle(Color.primary)
            .accessibilityIdentifier("solo.replace.recovery-copy")
        } header: {
          Text("Replacement")
            .foregroundStyle(Color.primary)
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
          Button(
            model.activeSessionIsPersistent ? "Replace Saved Game" : "Replace Temporary Game"
          ) {
            Task {
              await model.confirmReplacement()
              if !model.isReplacementReviewPresented { dismiss() }
            }
          }
          .disabled(model.isWorking || model.hasUncommittedTerminalCompletion)
          .frame(minHeight: 44)
          .buttonStyle(SoloDestructiveButtonStyle())
          .accessibilityIdentifier("solo.replace.confirm")

          if model.hasUncommittedTerminalCompletion {
            Text("Save or recover the completed result before replacing this game.")
              .font(.footnote)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("solo.replace.completion-blocked")
          }
        }
      }
      .navigationTitle("Review Replacement")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            model.isReplacementReviewPresented = false
            dismiss()
          }
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
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
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @AccessibilityFocusState private var drawnDecisionFocused: Bool
  @State private var isAccessibilityTableStatusPresented = false

  var body: some View {
    GeometryReader { proxy in
      let size = requestedLayoutSize(fallback: proxy.size)
      let wide = size.width >= 700
      let layout = SoloTableLayoutMode.resolve(
        size: size,
        usesAccessibilityText: usesUnscaledTextLayout
      )
      ZStack(alignment: .top) {
#if DEBUG
        Color.clear
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("Solo table safe-area test boundary")
          .accessibilityIdentifier("solo.table.safe-area")
          .allowsHitTesting(false)
#endif
        switch layout {
        case .accessibility:
          accessibleTable(size: size)
        case .accessibilityLandscape:
          compactLandscapeTable(
            size: size,
            accessibilityIdentifier: "solo.table.layout.accessibility-landscape"
          )
        case .compactLandscape:
          compactLandscapeTable(
            size: size,
            accessibilityIdentifier: "solo.table.layout.compact-landscape"
          )
        case .standard:
          standardTable(size: size, wide: wide)
        }
      }
      .frame(width: size.width, height: size.height)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Color(uiColor: .systemGroupedBackground))
    }
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
    .sheet(isPresented: $isAccessibilityTableStatusPresented) {
      accessibilityTableStatusSheet
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

  private var accessibilityTableStatusSheet: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Text("Round \(model.game?.round ?? 1)")
            .font(.largeTitle.bold())
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("solo.accessibility-table-status.round")
          Text(model.tableStatus)
            .font(.title.bold())
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("solo.accessibility-table-status.turn-state")

          VStack(alignment: .leading, spacing: 10) {
            Text("Current action")
              .font(.headline)
            Text(model.actionGuidance)
              .font(.title2.weight(.semibold))
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("solo.accessibility-table-status.guidance")
          }

          VStack(alignment: .leading, spacing: 12) {
            Text("Visible table information")
              .font(.headline)
            Text("Deck: \(model.game?.drawPile.count ?? 0) cards")
              .font(.body)
              .accessibilityIdentifier("solo.accessibility-table-status.deck")
            Text(
              "Discard top: \(model.game?.discardPile.first.map { spokenValue($0.value) } ?? "empty")"
            )
              .font(.body)
              .accessibilityIdentifier("solo.accessibility-table-status.discard")
            if model.isHumanTurn, let drawnCard = model.game?.drawnCard {
              Text("Drawn card: \(spokenValue(drawnCard.value)); action: \(model.drawChoice.rawValue)")
                .font(.body)
                .accessibilityIdentifier("solo.accessibility-table-status.drawn")
            }
          }

          VStack(alignment: .leading, spacing: 16) {
            Text("Players and scores")
              .font(.headline)
            ForEach(model.game?.players ?? [], id: \.id) { player in
              VStack(alignment: .leading, spacing: 4) {
                Text(player.kind == .human ? "You" : player.name)
                  .font(.title2.bold())
                Text("Score: \(player.totalScore) points")
                  .font(.body.monospacedDigit())
                ForEach(Array(player.grid.enumerated()), id: \.offset) { index, card in
                  let row = index / SkyjoRules.columns + 1
                  let column = index % SkyjoRules.columns + 1
                  Text(accessibilityCardSummary(card, row: row, column: column))
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(
                      "solo.accessibility-table-status.card.\(player.id).r\(row).c\(column)"
                    )
                }
              }
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityElement(children: .contain)
              .accessibilityIdentifier("solo.accessibility-table-status.player.\(player.id)")
            }
          }
        }
        .frame(maxWidth: 680, alignment: .leading)
        .padding()
      }
      .navigationTitle("Table Status")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            isAccessibilityTableStatusPresented = false
          }
          .accessibilityIdentifier("solo.accessibility-table-status.done")
        }
      }
    }
    .presentationDetents([.large])
    .accessibilityIdentifier("solo.accessibility-table-status")
  }

  private func standardTable(size: CGSize, wide: Bool) -> some View {
    let isShortPortrait = size.width < size.height && size.height < 720
    let usesSingleOpponentPage = !wide && size.width < 400
    let opponentCount = model.game?.players.lazy.filter { $0.kind == .ai }.count ?? 0
    // A single board would otherwise consume the full Pro Max viewport width,
    // becoming taller than the fixed opponent region while that region scrolls
    // horizontally only. Keep a lone compact board fully revealable.
    let opponentBoardMaxWidth: CGFloat? = usesSingleOpponentPage
      ? 185
      : (opponentCount == 1 && !wide ? 220 : nil)
    let bandHeight = isShortPortrait ? 76 : min(max(size.height * 0.18, 120), 150)
    // At the 550-point debug floor, 270 points of width gives every local card
    // its 44-point minimum while reducing the board's intrinsic height enough
    // to keep a complete 185-point opponent board inside the only scroll region.
    let localBoardHeight: CGFloat
    if isShortPortrait {
      localBoardHeight = 195
    } else if wide {
      localBoardHeight = min(max(size.height * 0.44, 270), 340)
    } else {
      localBoardHeight = min(max(size.height * 0.42, 270), 300)
    }
    return VStack(spacing: 10) {
      gameHeader()
      opponentRegion(
        wide: wide,
        boardsPerViewport: usesSingleOpponentPage ? 1 : 2,
        boardMaxWidth: opponentBoardMaxWidth,
        allowsVerticalScrolling: isShortPortrait
      )
        .frame(maxHeight: .infinity)
      actionBand(wide: wide, compactGuidance: isShortPortrait)
        .frame(height: bandHeight)
        .accessibilityIdentifier("solo.action-band")
        .accessibilitySortPriority(4)
      humanBoard(compact: false)
        .frame(maxWidth: isShortPortrait ? 270 : 520)
        .frame(height: localBoardHeight)
        .frame(maxWidth: .infinity)
        .accessibilitySortPriority(2)
    }
    .padding(.horizontal, wide ? 20 : 8)
    .padding(.vertical, 6)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("solo.table.layout.standard")
  }

  private func accessibleTable(size: CGSize) -> some View {
    let wide = size.width >= 700
    let isShortPortrait = size.width < size.height && size.height < 650
    // Dense presentation fixes only non-text card glyph geometry and enriches
    // semantics; every user-facing string still uses its uncapped relative font.
    let usesDenseAccessibilityPresentation = true
    // Accessibility text keeps its requested size. The stable four-slot band
    // scrolls horizontally, two slots at a time, so its tallest real label
    // determines height without pushing the local board below the safe area.
    let actionHeight: CGFloat = wide ? 190 : 170
    let localBoardHeight: CGFloat = isShortPortrait
      ? 240
      : min(max(size.height * 0.3, 240), wide ? 320 : 240)
    let localBoardMaxWidth = min(
      wide ? 360 : 220,
      max(185, ((localBoardHeight - 80) / 3 * 4) + 8)
    )
    return VStack(spacing: isShortPortrait ? 4 : 8) {
      gameHeader(
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
      )
      opponentRegion(
        wide: wide,
        boardsPerViewport: 1,
        allowsVerticalScrolling: true,
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
      )
        .frame(minHeight: 44, maxHeight: .infinity)
        .layoutPriority(-1)
      actionBand(
        wide: false,
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
      )
        .frame(height: actionHeight)
        .accessibilityIdentifier("solo.action-band")
        .accessibilitySortPriority(4)
      humanBoard(
        compact: true,
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
      )
        .frame(maxWidth: localBoardMaxWidth)
        .frame(height: localBoardHeight)
        .frame(maxWidth: .infinity)
        .accessibilitySortPriority(2)
    }
    .padding(.horizontal, wide ? 20 : 8)
    .padding(.vertical, isShortPortrait ? 2 : 6)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("solo.table.layout.accessibility-fixed")
  }

  private func compactLandscapeTable(
    size: CGSize,
    accessibilityIdentifier: String
  ) -> some View {
    // At the 640-point phone-landscape floor, preserve enough width for four
    // 44-point actions and four 44-point local-card columns. The opponent strip
    // owns the only scrolling region and can therefore use the remaining sliver.
    let opponentWidth = min(max(size.width * 0.28, 185), 200)
    let localWidth = min(max(size.width * 0.33, 210), 280)
    let usesDenseAccessibilityPresentation = true
    let verticalPadding: CGFloat = accessibilityIdentifier
      == "solo.table.layout.accessibility-landscape" ? 2 : 4
    return VStack(spacing: 6) {
      gameHeader(
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
      )
      GeometryReader { bodyProxy in
        HStack(alignment: .bottom, spacing: 8) {
          opponentRegion(
            wide: false,
            boardsPerViewport: 1,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
          )
            .frame(width: opponentWidth, height: bodyProxy.size.height)
          actionBand(
            wide: true,
            compactGuidance: true,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
          )
            .frame(maxWidth: .infinity)
            .frame(height: bodyProxy.size.height, alignment: .bottom)
            .accessibilityIdentifier("solo.action-band")
            .accessibilitySortPriority(4)
          humanBoard(
            compact: true,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
          )
            .frame(width: localWidth)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .accessibilitySortPriority(2)
        }
        .frame(
          width: bodyProxy.size.width,
          height: bodyProxy.size.height,
          alignment: .bottom
        )
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, verticalPadding)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(accessibilityIdentifier)
  }

  @ViewBuilder
  private func humanBoard(
    compact: Bool,
    usesDenseAccessibilityPresentation: Bool = false
  ) -> some View {
    if let human = model.humanPlayer {
      PlayerBoardView(
        player: human,
        isLocal: true,
        isCompact: compact,
        usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation,
        differentiateWithoutColor: differentiateWithoutColor,
        actionForIndex: { index in
          Task { await model.tapHumanCard(at: index) }
        },
        isEnabledAtIndex: isHumanCardEnabled
      )
    }
  }

  private func gameHeader(
    usesDenseAccessibilityPresentation: Bool = false
  ) -> some View {
    let usesDensePresentation = usesAccessibilityLandscapeDensity
      || usesDenseAccessibilityPresentation
    return HStack(alignment: .center, spacing: 8) {
      Group {
        if usesUnscaledTextLayout {
          ScrollView(.horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              gameRoundLabel
              gameTurnStateLabel
            }
            .fixedSize(horizontal: true, vertical: true)
          }
          .defaultScrollAnchor(.leading)
          .scrollIndicators(.visible)
          .fixedSize(horizontal: false, vertical: true)
        } else {
          VStack(alignment: .leading, spacing: usesDensePresentation ? 0 : 2) {
            gameRoundLabel
            gameTurnStateLabel
          }
        }
      }
      .layoutPriority(1)
      Spacer()
      if model.owner.accountID == nil {
        Image(systemName: "person.crop.circle.badge.questionmark")
          .resizable()
          .scaledToFit()
          .frame(width: 24, height: 24)
          .frame(width: 44, height: 44)
          .accessibilityLabel("Guest game. Completed games are not added to account stats.")
          .accessibilityIdentifier("solo.table.guest")
      }
      if model.persistenceWarning != nil {
        Button {
          model.setSettingsPresented(true)
        } label: {
          Image(systemName: "externaldrive.badge.exclamationmark")
            .resizable()
            .scaledToFit()
            .frame(width: 24, height: 24)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Save warning")
        .accessibilityHint("Opens recovery details without interrupting the current turn")
        .accessibilityIdentifier("solo.table.persistence-warning")
      }
      Button {
        model.leaveTable()
      } label: {
        Image(systemName: "xmark.circle")
          .resizable()
          .scaledToFit()
          .frame(width: 28, height: 28)
          .foregroundStyle(.primary)
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Exit")
      .disabled(model.isWorking)
      .accessibilityIdentifier("solo.table.exit")
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("solo.table.header")
    .accessibilitySortPriority(5)
  }

  private var gameRoundLabel: some View {
    Text("Round \(model.game?.round ?? 1)")
      .font(.caption.weight(.black))
      .foregroundStyle(Color.primary)
      .lineLimit(usesUnscaledTextLayout ? 1 : nil)
      .fixedSize(horizontal: usesUnscaledTextLayout, vertical: true)
      .accessibilityIdentifier("solo.table.round")
  }

  private var gameTurnStateLabel: some View {
    Text(model.tableStatus)
      .font(.caption2)
      .foregroundStyle(.primary)
      .lineLimit(usesUnscaledTextLayout ? 1 : nil)
      .fixedSize(horizontal: usesUnscaledTextLayout, vertical: true)
      .accessibilityIdentifier("solo.table.turn-state")
  }

  @ViewBuilder
  private func opponentRegion(
    wide: Bool,
    boardsPerViewport: Int = 2,
    boardMaxWidth: CGFloat? = nil,
    allowsVerticalScrolling: Bool = false,
    usesDenseAccessibilityPresentation: Bool = false
  ) -> some View {
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
              usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation,
              differentiateWithoutColor: differentiateWithoutColor,
              actionForIndex: { _ in },
              isEnabledAtIndex: { _ in false }
            )
          }
        }
      }
      .accessibilityIdentifier("solo.opponents.scroll")
    } else if allowsVerticalScrolling {
      ScrollView(.vertical) {
        LazyVStack(alignment: .leading, spacing: 20) {
          ForEach(opponents, id: \.id) { player in
            PlayerBoardView(
              player: player,
              isLocal: false,
              isCompact: true,
              usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation,
              differentiateWithoutColor: differentiateWithoutColor,
              actionForIndex: { _ in },
              isEnabledAtIndex: { _ in false }
            )
            .frame(maxWidth: boardMaxWidth ?? .infinity, alignment: .leading)
          }
        }
      }
      .defaultScrollAnchor(.top)
      .scrollIndicators(.visible)
      .accessibilityIdentifier("solo.opponents.scroll")
    } else {
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 6) {
          ForEach(opponents, id: \.id) { player in
            PlayerBoardView(
              player: player,
              isLocal: false,
              isCompact: true,
              usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation,
              differentiateWithoutColor: differentiateWithoutColor,
              actionForIndex: { _ in },
              isEnabledAtIndex: { _ in false }
            )
            .frame(maxWidth: boardMaxWidth ?? .infinity, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .containerRelativeFrame(
              .horizontal,
              count: opponents.count == 1 ? 1 : boardsPerViewport,
              spacing: 6
            )
          }
        }
        .scrollTargetLayout()
      }
      .defaultScrollAnchor(.leading)
      .scrollTargetBehavior(.viewAligned)
      .scrollIndicators(.visible)
      .accessibilityIdentifier("solo.opponents.scroll")
    }
  }

  @ViewBuilder
  private func actionBand(
    wide: Bool,
    compactGuidance: Bool = false,
    usesDenseAccessibilityPresentation: Bool = false
  ) -> some View {
    Group {
      if usesUnscaledTextLayout {
        VStack(spacing: usesAccessibilityLandscapeDensity ? 0 : 6) {
          guidanceSlot(
            compact: true,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
          )
            .frame(height: usesAccessibilityLandscapeDensity ? 44 : 60)
          GeometryReader { proxy in
            let slotWidth = max(88, (proxy.size.width - 8) / 2)
            ScrollViewReader { reader in
              ScrollView(.horizontal) {
                HStack(spacing: 8) {
                  drawSlot(
                    usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
                  )
                    .frame(width: slotWidth)
                    .id("solo.action.page.draw")
                  discardSlot(
                    usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
                  )
                    .frame(width: slotWidth)
                    .id("solo.action.page.discard")
                  drawnSlot(
                    usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
                  )
                    .frame(width: slotWidth)
                    .id("solo.action.page.drawn")
                }
                .frame(height: proxy.size.height)
              }
              .defaultScrollAnchor(.leading)
              .scrollIndicators(.visible)
              .accessibilityIdentifier("solo.action.scroll")
              .onChange(
                of: model.isHumanTurn && model.game?.drawnCard != nil,
                initial: true
              ) { _, isOccupied in
                let target = isOccupied ? "solo.action.page.drawn" : "solo.action.page.draw"
                if reduceMotion {
                  reader.scrollTo(target, anchor: isOccupied ? .trailing : .leading)
                } else {
                  withAnimation(.easeInOut(duration: 0.15)) {
                    reader.scrollTo(target, anchor: isOccupied ? .trailing : .leading)
                  }
                }
              }
            }
          }
        }
      } else {
        HStack(spacing: compactGuidance ? 8 : (wide ? 12 : 6)) {
          drawSlot(usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation)
            .frame(maxHeight: .infinity)
          discardSlot(usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation)
            .frame(maxHeight: .infinity)
          drawnSlot(usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation)
            .frame(maxHeight: .infinity)
          guidanceSlot(
            compact: compactGuidance,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityPresentation
          )
            .frame(maxHeight: .infinity)
        }
      }
    }
    .accessibilityElement(children: .contain)
  }

  private func drawSlot(
    usesDenseAccessibilityPresentation: Bool
  ) -> some View {
    let usesDensePresentation = usesAccessibilityLandscapeDensity
      || usesDenseAccessibilityPresentation
    return SkyjoActionSlot {
      Button {
        Task { await model.performHuman(.drawBlind) }
      } label: {
        VStack(spacing: 4) {
          if !usesUnscaledTextLayout {
            Image(systemName: "rectangle.stack.fill")
          }
          Text("Deck")
            .font(.caption2.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
          Text(model.game?.drawPile.count.formatted() ?? "0")
            .font(.caption2.monospacedDigit().bold())
            .fixedSize(horizontal: true, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
      }
      .buttonStyle(.plain)
      .disabled(!canChooseSource)
      .allowsHitTesting(canChooseSource)
      .accessibilityLabel("Draw blind")
      .accessibilityValue(
        usesDensePresentation
          ? "Visible deck count: \(model.game?.drawPile.count ?? 0); \(model.game?.drawPile.count ?? 0) cards remain"
          : "\(model.game?.drawPile.count ?? 0) cards remain"
      )
      .accessibilityIdentifier("solo.action.draw")
    }
    .accessibilitySortPriority(4)
  }

  private func discardSlot(
    usesDenseAccessibilityPresentation: Bool
  ) -> some View {
    let usesDensePresentation = usesAccessibilityLandscapeDensity
      || usesDenseAccessibilityPresentation
    return SkyjoActionSlot {
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
          if !usesUnscaledTextLayout {
            Image(systemName: "rectangle.portrait.fill")
          }
          Text("Discard")
            .font(.caption2.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
          Text(model.game?.discardPile.first?.value.formatted() ?? "Empty")
            .font(.caption2.monospacedDigit().bold())
            .fixedSize(horizontal: true, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityHidden(true)
      }
      .buttonStyle(.plain)
      .disabled(!canUseDiscardAction)
      .allowsHitTesting(canUseDiscardAction)
      .accessibilityLabel(
        model.game?.discardPile.first.map { "Discard pile, top card \(spokenValue($0.value))" }
          ?? "Discard pile, empty"
      )
      .accessibilityValue(
        discardActionAccessibilityValue(usesDensePresentation: usesDensePresentation)
      )
      .accessibilityHint(discardActionAccessibilityHint)
      .accessibilityIdentifier("solo.action.discard")
    }
    .accessibilitySortPriority(3)
  }

  @ViewBuilder
  private func drawnSlot(
    usesDenseAccessibilityPresentation: Bool
  ) -> some View {
    let isOccupied = model.isHumanTurn && model.game?.drawnCard != nil
    SkyjoActionSlot(isOccupied: isOccupied) {
      // Keep the complete decision control in the layout even while hidden. Its intrinsic
      // height reserves the Accessibility XXXL Grid row before a draw, so revealing the
      // picker cannot move the action band or local board.
      Menu {
        ForEach(SoloDrawChoice.allCases) { choice in
          Button(choice.rawValue) { model.selectDrawChoice(choice) }
        }
      } label: {
        VStack(spacing: 4) {
          Text("Drawn")
            .font(.caption2.weight(.semibold))
            .fixedSize(horizontal: true, vertical: true)
          HStack(spacing: 6) {
            Text(isOccupied ? (model.game?.drawnCard?.value.formatted() ?? "—") : "—")
              .font(.caption2.monospacedDigit().bold())
              .fixedSize(horizontal: true, vertical: true)
            Text(accessibilityLandscapeDrawChoice.capitalized)
              .font(.caption2.weight(.semibold))
              .fixedSize(horizontal: true, vertical: true)
          }
        }
        .frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityLabel("Drawn card action")
      .accessibilityValue(
        "Visible card: \(model.game?.drawnCard.map { spokenValue($0.value) } ?? "unavailable"); visible action: \(model.drawChoice.rawValue)"
      )
      .accessibilityFocused($drawnDecisionFocused)
      .accessibilityIdentifier("solo.action.drawn-choice")
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .accessibilitySortPriority(2)
  }

  @ViewBuilder
  private func guidanceSlot(
    compact: Bool,
    usesDenseAccessibilityPresentation: Bool
  ) -> some View {
    let usesCompactCopy = compact || usesUnscaledTextLayout
    let visibleGuidance = usesCompactCopy ? compactActionGuidance : model.actionGuidance
    Group {
      if usesUnscaledTextLayout {
        SkyjoActionSlot {
          Button {
            isAccessibilityTableStatusPresented = true
          } label: {
            Text(visibleGuidance)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.primary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
              .layoutPriority(1)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .contentShape(Rectangle())
              .accessibilityHidden(true)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(model.actionGuidance)
          .accessibilityValue(
            "Visible guidance: \(visibleGuidance)"
          )
          .accessibilityHint("Shows complete table status")
          .accessibilityIdentifier("solo.action.guidance")
        }
      } else {
        SkyjoActionSlot {
          VStack(spacing: 6) {
            Image(systemName: guidanceImage)
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
            Text(visibleGuidance)
              .font(.footnote)
              .foregroundStyle(.primary)
              .multilineTextAlignment(.center)
              .lineLimit(usesCompactCopy ? nil : 4)
              .fixedSize(horizontal: false, vertical: true)
              .layoutPriority(1)
          }
          .padding(6)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.actionGuidance)
        .accessibilityValue("Visible guidance: \(visibleGuidance)")
        .accessibilityIdentifier("solo.action.guidance")
      }
    }
    .accessibilitySortPriority(1)
  }

  private var canChooseSource: Bool {
    model.isHumanTurn && model.game?.phase == .chooseSource
  }

  private func accessibilityCardSummary(_ card: Card, row: Int, column: Int) -> String {
    let position = "Row \(row), column \(column)"
    if card.removed { return "\(position): cleared" }
    if card.faceUp { return "\(position): \(spokenValue(card.value))" }
    return "\(position): face down"
  }

  private var usesAccessibilityLandscapeDensity: Bool {
    usesUnscaledTextLayout && verticalSizeClass == .compact
  }

  private var usesUnscaledTextLayout: Bool {
    dynamicTypeSize >= .xxxLarge
  }

  private var accessibilityLandscapeDrawChoice: String {
    model.drawChoice == .place ? "PLACE" : "REVEAL"
  }

  private var canUseDiscardAction: Bool {
    model.isHumanTurn && (canChooseSource || model.game?.selectedSource == .discard)
  }

  private func discardActionAccessibilityValue(
    usesDensePresentation: Bool
  ) -> String {
    let availability: String
    if !model.isHumanTurn {
      availability = "Unavailable while another player is choosing"
    } else if model.game?.selectedSource == .discard {
      availability = "Selected"
    } else {
      availability = canChooseSource ? "Available" : "Unavailable for the current action"
    }
    guard usesDensePresentation else { return availability }
    return "Visible top card: \(model.game?.discardPile.first.map { spokenValue($0.value) } ?? "empty"); \(availability)"
  }

  private var discardActionAccessibilityHint: String {
    if !model.isHumanTurn { return "Wait for your turn" }
    if model.game?.selectedSource == .discard { return "Cancels the discard selection" }
    return canChooseSource ? "Takes the visible card" : "Finish the current action first"
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

  private var accessibilityLandscapeGuidance: String {
    switch model.game?.phase {
    case .openingReveal: "REVEAL\n2 CARDS"
    case .chooseSource: "CHOOSE\nPILE OR DECK"
    case .chooseReplacement: "CHOOSE\nBOARD CARD"
    case .roundOver: "REVIEW\nSCORES"
    case .gameOver: "GAME\nCOMPLETE"
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

  private func requestedLayoutSize(fallback: CGSize) -> CGSize {
#if DEBUG
    guard let argument = ProcessInfo.processInfo.arguments.first(where: {
      $0.hasPrefix("--ui-solo-geometry=")
    }) else { return fallback }
    let value = argument.dropFirst("--ui-solo-geometry=".count)
    let dimensions = value.split(separator: "x", maxSplits: 1)
    guard dimensions.count == 2,
          let width = Double(dimensions[0]),
          let height = Double(dimensions[1]),
          width > 0,
          height > 0
    else { return fallback }
    return CGSize(
      width: min(CGFloat(width), fallback.width),
      height: min(CGFloat(height), fallback.height)
    )
#else
    return fallback
#endif
  }
}

enum SoloTableLayoutMode: Equatable {
  case standard
  case compactLandscape
  case accessibility
  case accessibilityLandscape

  static func resolve(size: CGSize, usesAccessibilityText: Bool) -> Self {
    let isLandscape = size.width > size.height
    let hasThreeColumnWidth = size.width >= 620
    if usesAccessibilityText {
      return isLandscape && hasThreeColumnWidth && size.height < 650
        ? .accessibilityLandscape
        : .accessibility
    }
    return isLandscape && hasThreeColumnWidth && size.height < 650
      ? .compactLandscape
      : .standard
  }
}

struct PlayerBoardView: View {
  @Environment(\.layoutDirection) private var layoutDirection
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  let player: Player
  let isLocal: Bool
  let isCompact: Bool
  let usesDenseAccessibilityPresentation: Bool
  let differentiateWithoutColor: Bool
  let actionForIndex: (Int) -> Void
  let isEnabledAtIndex: (Int) -> Bool

  var body: some View {
    VStack(spacing: isCompact ? 1 : 7) {
      boardHeader
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isHeader)
      .accessibilityRespondsToUserInteraction(false)
      .accessibilityLabel(isLocal ? "You" : player.name)
      .accessibilityValue(
        usesDenseAccessibilityLayout
          ? "Visible player: \(isLocal ? "You" : player.name); visible score: \(player.totalScore) points"
          : "\(player.totalScore) points"
      )
      .accessibilityIdentifier("solo.board.header.\(isLocal ? "local" : "opponent").\(player.id)")
      .accessibilitySortPriority(Double(player.grid.count + 1))
      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: isCompact ? 1 : 6), count: 4),
        spacing: isCompact ? 1 : 6
      ) {
        ForEach(visualGridIndices, id: \.self) { index in
          let card = player.grid[index]
          let row = index / SkyjoRules.columns + 1
          let column = index % SkyjoRules.columns + 1
          SkyjoCardView(
            face: presentation(for: card),
            label: cardLabel(card, row: row, column: column),
            hint: cardHint(card, index: index),
            isEnabled: isEnabledAtIndex(index),
            aspectRatio: isCompact ? 1 : 1.35,
            usesDenseAccessibilityPresentation: usesDenseAccessibilityLayout,
            action: { actionForIndex(index) }
          )
          .accessibilityIdentifier("solo.card.\(isLocal ? "local" : "opponent").\(player.id).r\(row).c\(column)")
          .overlay(alignment: .topTrailing) {
            if differentiateWithoutColor, card.faceUp, !card.removed {
              Image(systemName: card.value >= 9 ? "exclamationmark" : "checkmark")
                .font(.caption2.bold())
                .padding(3)
                .allowsHitTesting(false)
#if DEBUG
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                  card.value >= 9 ? "Visible exclamation mark marker" : "Visible checkmark marker"
                )
                .accessibilityIdentifier(
                  "solo.card-marker.\(isLocal ? "local" : "opponent").\(player.id).r\(row).c\(column)"
                )
                .accessibilityRespondsToUserInteraction(false)
#else
                .accessibilityHidden(true)
#endif
            }
          }
          .accessibilitySortPriority(Double(player.grid.count - index))
        }
      }
      // Keep column placement deterministic and mirror logical columns ourselves.
      // LazyVGrid does not provide a stable item-ordering contract across layout directions.
      .environment(\.layoutDirection, .leftToRight)
    }
    .padding(isCompact ? 1 : 10)
    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12).stroke(.secondary, lineWidth: 1)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(isLocal ? "Your board" : "\(player.name)'s board")
    .accessibilityIdentifier("solo.board.\(isLocal ? "local" : "opponent").\(player.id)")
  }

  @ViewBuilder
  private var boardHeader: some View {
    if usesUnscaledHeaderLayout {
      // Preserve the requested Dynamic Type size and a single readable line for
      // both fields. Narrow boards expose the small amount of horizontal
      // overflow explicitly instead of wrapping the header until it collides
      // with the fixed local-board and action regions.
      ScrollView(.horizontal) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          boardName
          boardScore
        }
        .fixedSize(horizontal: true, vertical: true)
      }
      .defaultScrollAnchor(.leading)
      .scrollIndicators(.visible)
      .fixedSize(horizontal: false, vertical: true)
    } else {
      HStack(alignment: .top, spacing: 4) {
        boardName
        Spacer(minLength: 2)
        boardScore
      }
    }
  }

  private var boardName: some View {
    Text(isLocal ? "You" : player.name)
      .font(isCompact ? .caption2.weight(.black) : .headline.weight(.black))
      .foregroundStyle(Color.primary)
      .lineLimit(1)
      .fixedSize(horizontal: usesUnscaledHeaderLayout, vertical: true)
  }

  private var boardScore: some View {
    Text("\(player.totalScore) pts")
      .font((isCompact ? Font.caption2 : Font.caption).weight(.black).monospacedDigit())
      .foregroundStyle(Color.primary)
      .lineLimit(1)
      .fixedSize(horizontal: usesUnscaledHeaderLayout, vertical: true)
  }

  private var visualGridIndices: [Int] {
    let indices = Array(player.grid.indices)
    guard usesRightToLeftLayout else { return indices }
    return stride(from: 0, to: indices.count, by: SkyjoRules.columns).flatMap { rowStart in
      indices[rowStart..<min(rowStart + SkyjoRules.columns, indices.count)].reversed()
    }
  }

  private var usesRightToLeftLayout: Bool {
#if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--ui-layout-direction=rtl") { return true }
#endif
    return layoutDirection == .rightToLeft
  }

  private var usesDenseAccessibilityLayout: Bool {
    usesDenseAccessibilityPresentation
  }

  private var usesUnscaledHeaderLayout: Bool {
    usesDenseAccessibilityLayout || dynamicTypeSize >= .xxxLarge
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
      let marker = differentiateWithoutColor
        ? "; visual marker: \(card.value >= 9 ? "exclamation mark" : "checkmark")"
        : ""
      return "\(prefix), row \(row), column \(column), \(spokenValue(card.value))\(marker)"
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
          Button {
            model.setScoreSummaryPresented(false)
          } label: {
            Text("Minimize")
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(SoloSecondaryButtonStyle())
          .disabled(model.isWorking)
          .accessibilityIdentifier("solo.summary.minimize")

          Text(model.game?.phase == .gameOver ? "Game complete" : "Round complete")
            .font(.largeTitle.bold())
            .accessibilityFocused($headingFocused)
            .accessibilityIdentifier("solo.summary.heading")

          if let entry = model.game?.roundHistory.last {
            ForEach(entry.scores, id: \.playerId) { score in
              HStack {
                VStack(alignment: .leading) {
                  Text(score.name).font(.headline)
                  Text("Round \(score.roundScore)").foregroundStyle(.primary)
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
            Button(
              model.completionRequiresSavedGameReload
                ? "Reload Saved Game"
                : "Retry Saving Result"
            ) {
              Task {
                if model.completionRequiresSavedGameReload {
                  await model.reloadSavedGameAfterCompletionFailure()
                } else {
                  await model.retryCompletion()
                }
              }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isWorking)
            .frame(minHeight: 44)
            .accessibilityIdentifier(
              model.completionRequiresSavedGameReload
                ? "solo.summary.reload-saved-game"
                : "solo.summary.retry-completion"
            )
          } else if model.game?.phase == .gameOver {
            Label(
              model.completedStatsMessage,
              systemImage: model.statsDeliverySystemImage
            )
            .accessibilityIdentifier("solo.summary.stats-state")
          }

          if let error = model.lastActionError, model.completionError == nil {
            SkyjoStatusBanner(title: "New game not started", message: error)
              .accessibilityIdentifier("solo.summary.new-game-error")
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
            Button {
              Task { await model.playAgain() }
            } label: {
              Text("Play Again")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isWorking)
            .accessibilityIdentifier("solo.summary.replay")
            Button { model.changeSetup() } label: {
              Text("Change Setup")
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(SoloSecondaryButtonStyle())
            .disabled(model.isWorking)
            .accessibilityIdentifier("solo.summary.change-setup")
          }
        }
        .padding()
      }
      .navigationTitle("Scores")
    }
    .onAppear { headingFocused = true }
  }
}

@MainActor
private struct SoloSettingsView: View {
  @Bindable var model: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
  @Environment(\.colorSchemeContrast) private var colorSchemeContrast

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
            .foregroundStyle(.primary)
        }

        Section("System accessibility") {
          VStack(alignment: .leading, spacing: 4) {
            Text("Adaptations")
              .font(.body)
            Text(accessibilityAdaptationSummary)
              .font(.body)
              .foregroundStyle(.primary)
              .fixedSize(horizontal: false, vertical: true)
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("System accessibility adaptations")
          .accessibilityValue(accessibilityAdaptationSummary)
          .accessibilityIdentifier("solo.settings.accessibility-adaptations")
          Text("Skyjo follows the system settings for motion, contrast, and color-independent card markers.")
            .font(.footnote)
            .foregroundStyle(.primary)
        }

        if let setup = model.setup {
          Section("Current game") {
            HStack {
              Text("Opponents")
                .font(.body)
                .accessibilityIdentifier("solo.settings.current-opponents.label")
                .accessibilityHidden(true)
              Spacer()
              Text(setup.aiOpponentCount.formatted())
                .font(.body)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("solo.settings.current-opponents.value")
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Opponents")
            .accessibilityValue(setup.aiOpponentCount.formatted())
            .accessibilityIdentifier("solo.settings.current-opponents")
            HStack {
              Text("Difficulty")
                .font(.body)
                .accessibilityIdentifier("solo.settings.current-difficulty.label")
                .accessibilityHidden(true)
              Spacer()
              Text(setup.difficulty.displayName)
                .font(.body)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("solo.settings.current-difficulty.value")
                .accessibilityHidden(true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Difficulty")
            .accessibilityValue(setup.difficulty.displayName)
            .accessibilityIdentifier("solo.settings.current-difficulty")
            Button("Set Up Another Game") {
              dismiss()
              model.setSettingsPresented(false)
              model.showSetup()
            }
            .frame(minHeight: 44)
            .disabled(model.hasUncommittedTerminalCompletion)
            .accessibilityIdentifier("solo.settings.new-game")
            if model.hasUncommittedTerminalCompletion {
              Text("Save or recover the completed result before setting up another game.")
                .font(.footnote)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("solo.settings.completion-blocked")
            }
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
            systemImage: model.statsDeliverySystemImage
          )
          SoloRecoveryView(model: model)
        }
      }
      .navigationTitle("Game Settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button {
            dismiss()
            model.setSettingsPresented(false)
          } label: {
            Text("Done")
              .font(.body.weight(.semibold))
              .foregroundStyle(Color.primary)
              .fixedSize(horizontal: true, vertical: true)
          }
          .accessibilityIdentifier("solo.settings.done")
        }
      }
      .task { await model.refreshOutboxStatus() }
    }
  }

  private var accessibilityAdaptationSummary: String {
    "Reduce Motion \(reduceMotion ? "on" : "off"); Increase Contrast \(colorSchemeContrast == .increased ? "on" : "off"); Differentiate Without Color \(differentiateWithoutColor ? "on" : "off")"
  }
}

@MainActor
private struct SoloRecoveryView: View {
  @Bindable var model: SoloFeatureModel
  @State private var confirmDiscard = false
  @State private var confirmedDiscardHandle: StatsOutboxRecoveryHandle?

  var body: some View {
    if let kind = model.outboxStatus.blockedHeadKind {
      VStack(alignment: .leading, spacing: 10) {
        Text("Stats delivery needs attention")
          .font(.headline)
          .accessibilityIdentifier("solo.outbox.heading")
        Text(kind == .terminal
          ? "The oldest result was rejected permanently. Retry after a compatibility fix, or discard only after confirming it is no longer needed."
          : "The oldest queued result is damaged and cannot be submitted. Discarding only this blocked item lets later results continue.")
          .font(.body)
          .accessibilityIdentifier("solo.outbox.message")
        if kind == .terminal {
          Button {
            Task { await model.retryBlockedStats() }
          } label: {
            Text("Retry Oldest Result")
              .frame(maxWidth: .infinity, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(SoloSecondaryButtonStyle())
          .disabled(!recoveryIsAvailable)
          .allowsHitTesting(recoveryIsAvailable)
          .accessibilityIdentifier("solo.outbox.retry")
        }
        Button(role: .destructive) {
          confirmedDiscardHandle = model.outboxStatus.blockedHeadRecoveryHandle
          confirmDiscard = confirmedDiscardHandle != nil
        } label: {
          Text("Discard Oldest Result")
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(SoloDestructiveButtonStyle())
        .disabled(!recoveryIsAvailable)
        .allowsHitTesting(recoveryIsAvailable)
        .accessibilityIdentifier("solo.outbox.discard")
        if !model.statsDeliveryIsConfirmed {
          Text("Confirm this account online before retrying or discarding its stored result.")
            .font(.footnote)
            .foregroundStyle(.primary)
        } else if model.outboxStatus.blockedHeadRecoveryHandle == nil {
          Text("Recovery details changed. Close and reopen this screen before trying again.")
            .font(.footnote)
            .foregroundStyle(.primary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(
        Color(uiColor: .secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("solo.outbox.recovery")
      .confirmationDialog(
        "Discard this completed result?",
        isPresented: $confirmDiscard,
        titleVisibility: .visible
      ) {
        Button("Discard Result", role: .destructive) {
          guard let handle = confirmedDiscardHandle else { return }
          Task {
            await model.discardBlockedStats(expectedRecoveryHandle: handle)
            confirmedDiscardHandle = nil
          }
        }
        Button("Cancel", role: .cancel) {
          confirmedDiscardHandle = nil
        }
      } message: {
        Text("This removes only the blocked local stats item. It cannot be recovered afterward.")
      }
    }
  }

  private var recoveryIsAvailable: Bool {
    model.statsDeliveryIsConfirmed && model.outboxStatus.blockedHeadRecoveryHandle != nil
  }
}

private struct SoloSecondaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 12)
      .foregroundStyle(isEnabled ? Color.primary : Color.secondary)
      .background(
        Color(uiColor: .secondarySystemBackground),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(
            isEnabled ? Color.primary.opacity(0.72) : Color.secondary.opacity(0.4),
            lineWidth: 1.5
          )
      }
      .opacity(configuration.isPressed ? 0.78 : 1)
  }
}

private struct SoloDestructiveButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 12)
      .foregroundStyle(isEnabled ? Color.primary : Color.secondary)
      .background(
        Color(uiColor: .secondarySystemBackground),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(
            isEnabled ? Color.primary.opacity(0.85) : Color.secondary.opacity(0.4),
            lineWidth: 2
          )
      }
      .opacity(configuration.isPressed ? 0.78 : 1)
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
