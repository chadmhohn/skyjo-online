import Accessibility
import SkyjoDesignSystem
import SkyjoDomain
import SkyjoNetworking
import SwiftUI

enum RoomLayoutMetrics {
  static let minimumCardTarget: CGFloat = 44
  static let compactGridSpacing: CGFloat = 1
  static let compactBoardPadding: CGFloat = 4
  static let compactOpponentBoardWidth =
    minimumCardTarget * CGFloat(SkyjoRules.columns)
      + compactGridSpacing * CGFloat(SkyjoRules.columns - 1)
      + compactBoardPadding * 2

  static func opponentBoardWidth(
    availableWidth: CGFloat,
    usesShortLandscapeLayout: Bool
  ) -> CGFloat {
    if usesShortLandscapeLayout { return compactOpponentBoardWidth }
    return availableWidth >= 700 ? 240 : max(158, min(230, availableWidth * 0.48))
  }
}

enum RoomConfirmationCopy {
  static let forgetSavedSeatTitle = "Forget saved seat?"
  static let forgetSavedSeatMessage =
    "Saved room and reset recovery routing for this account will be removed from this device. The server room and other players are not changed."
}

struct RoomPlayerRemovalConfirmation: Equatable, Identifiable {
  let playerID: String
  let playerName: String

  var id: String { playerID }
  var title: String { "Remove \(playerName)?" }
  var message: String {
    "\(playerName)'s waiting-room seat will be removed. They can join again while the room is waiting."
  }
}

@MainActor
struct RoomRootView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.scenePhase) private var scenePhase

  init(model: RoomSessionModel) {
    self.model = model
  }

  var body: some View {
    Group {
      if model.room == nil {
        RoomJoinView(model: model)
      } else if model.game == nil {
        RoomWaitingView(model: model)
      } else {
        RoomTableView(model: model)
      }
    }
    .navigationTitle(model.room.map { "Room \($0.code)" } ?? "Multiplayer")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if model.room != nil {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task { await model.createShareInvite() }
          } label: {
            Label("Share room", systemImage: "square.and.arrow.up")
          }
          .disabled(!model.canCreateShareInvite)
          .accessibilityIdentifier("rooms.share")

          Button {
            model.isRoomOptionsPresented = true
          } label: {
            Label("Room options", systemImage: "ellipsis.circle")
          }
          .accessibilityIdentifier("rooms.options")
        }
      }
    }
    .task { await model.start() }
    .onChange(of: scenePhase, initial: true) { _, phase in
      model.setSceneActive(phase == .active)
    }
    .sheet(isPresented: $model.isChatPresented) {
      RoomChatView(model: model)
    }
    .sheet(isPresented: $model.isRoomOptionsPresented) {
      RoomOptionsView(model: model)
    }
    .sheet(isPresented: $model.isScorePresented) {
      RoomScoreView(model: model)
    }
    .sheet(
      isPresented: Binding(
        get: { model.pendingInviteReview != nil },
        set: { if !$0 { Task { await model.dismissInviteReview() } } }
      )
    ) {
      RoomInviteReviewView(model: model)
    }
    .sheet(
      isPresented: Binding(
        get: { model.shareInvite != nil },
        set: { if !$0 { model.clearShareInvite() } }
      )
    ) {
      RoomShareView(model: model)
    }
  }
}

@MainActor
private struct RoomJoinView: View {
  @Bindable var model: RoomSessionModel
  @State private var confirmsForgetSavedSeat = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Play with friends")
            .font(.largeTitle.bold())
          Text("Create a room or enter a five-character code. Every move is confirmed by the shared Skyjo server.")
            .foregroundStyle(.secondary)
        }

        RoomConnectionBanner(model: model, alwaysVisible: true)

        if let banner = model.banner {
          RoomUserBanner(banner: banner, onDismiss: model.dismissBanner)
        }

        GroupBox("Signed-in player") {
          Label(model.account.displayName, systemImage: "person.crop.circle.fill")
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .accessibilityIdentifier("rooms.account")
        }

        GroupBox("Join a room") {
          VStack(alignment: .leading, spacing: 12) {
            TextField("Room code", text: $model.joinCode)
              .textInputAutocapitalization(.characters)
              .autocorrectionDisabled()
              .textContentType(.oneTimeCode)
              .font(.title2.monospaced().bold())
              .onChange(of: model.joinCode) { model.sanitizeJoinCode() }
              .accessibilityIdentifier("rooms.join-code")
            Button {
              Task { await model.join() }
            } label: {
              Text("Join Room")
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.joinCode.count != 5 || connectionRequestDisabled)
            .accessibilityIdentifier("rooms.join")
          }
        }

        Button {
          Task { await model.createRoom() }
        } label: {
          Label("Create New Room", systemImage: "plus.circle.fill")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(connectionRequestDisabled)
        .accessibilityIdentifier("rooms.create")

        if model.connectionStatus.phase == .error || model.connectionStatus.phase == .idle {
          HStack(spacing: 12) {
            Button("Retry Saved Seat") {
              Task { await model.retrySavedSeat() }
            }
            .disabled(!model.canSubmitAdmission)
            .frame(minHeight: 44)
            .accessibilityIdentifier("rooms.retry-seat")

            Button("Forget Saved Seat", role: .destructive) {
              confirmsForgetSavedSeat = true
            }
            .disabled(!model.canForgetSavedSeat)
            .frame(minHeight: 44)
            .accessibilityIdentifier("rooms.forget-seat")
            .accessibilityHint("Requires confirmation before removing saved routing data")
          }
        }
      }
      .frame(maxWidth: 620, alignment: .leading)
      .padding()
    }
    .accessibilityIdentifier("rooms.join-screen")
    .alert(RoomConfirmationCopy.forgetSavedSeatTitle, isPresented: $confirmsForgetSavedSeat) {
      Button("Forget Saved Seat", role: .destructive) {
        Task { await model.forgetSavedSeat() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(RoomConfirmationCopy.forgetSavedSeatMessage)
    }
  }

  private var connectionRequestDisabled: Bool {
    !model.canSubmitAdmission
  }
}

@MainActor
private struct RoomWaitingView: View {
  @Bindable var model: RoomSessionModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        RoomConnectionBanner(model: model, alwaysVisible: true)
        if let banner = model.banner {
          RoomUserBanner(banner: banner, onDismiss: model.dismissBanner)
        }

        if let room = model.room {
          GroupBox {
            VStack(alignment: .leading, spacing: 10) {
              Text("Room code")
                .font(.caption)
                .foregroundStyle(.secondary)
              Text(room.code)
                .font(.system(.largeTitle, design: .monospaced, weight: .black))
                .accessibilityLabel("Room code \(room.code)")
                .accessibilityIdentifier("rooms.code")
              Text("Waiting for players. The host can start after at least two human players are connected.")
                .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }

          RoomRoster(model: model, showsManagement: true)

          if model.isLocalHost {
            Button {
              Task { await model.startGame() }
            } label: {
              Text("Start Game")
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canStartWaitingRoom)
            .accessibilityHint(
              model.connectedHumanCount < 2
                ? "At least two connected human players are required"
                : "Starts the authoritative multiplayer game"
            )
            .accessibilityIdentifier("rooms.start")
          }
        }
      }
      .frame(maxWidth: 720, alignment: .leading)
      .padding()
    }
    .safeAreaInset(edge: .bottom) {
      RoomChatButton(model: model)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }
    .accessibilityIdentifier("rooms.waiting-screen")
  }
}

@MainActor
private struct RoomTableView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    GeometryReader { proxy in
      if dynamicTypeSize.isAccessibilitySize {
        accessibleTable(width: proxy.size.width, height: proxy.size.height)
      } else {
        standardTable(width: proxy.size.width, height: proxy.size.height)
      }
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .overlay(alignment: .top) {
      VStack(spacing: 6) {
        RoomConnectionBanner(model: model, alwaysVisible: false)
        if let banner = model.banner {
          RoomUserBanner(banner: banner, onDismiss: model.dismissBanner)
        }
      }
      .frame(maxWidth: 620)
      .padding(.horizontal, 10)
      .allowsHitTesting(model.banner != nil)
    }
    .overlay(alignment: .topTrailing) {
      RoomChatButton(model: model)
        .padding(.top, 72)
        .padding(.trailing, 12)
    }
    .onChange(of: model.isScoring, initial: true) { _, scoring in
      if scoring { model.isScorePresented = true }
    }
    .accessibilityIdentifier("rooms.table")
  }

  private var activePlayerID: String? {
    guard let game = model.game, game.players.indices.contains(game.currentPlayerIndex) else {
      return nil
    }
    return game.players[game.currentPlayerIndex].id
  }

  private func standardTable(width: CGFloat, height: CGFloat) -> some View {
    let usesShortLandscapeLayout = height < 520
    return VStack(spacing: 8) {
      opponentRail(width: width, usesShortLandscapeLayout: usesShortLandscapeLayout)
        .frame(maxHeight: .infinity)

      RoomTableBand(model: model)
        .frame(maxWidth: 680)
        .frame(
          height: usesShortLandscapeLayout
            ? 88
            : min(max(height * 0.21, 112), 170)
        )

      localBoard
        .frame(maxWidth: usesShortLandscapeLayout ? 280 : 560)
        .frame(
          maxHeight: usesShortLandscapeLayout
            ? 182
            : min(max(height * 0.39, 210), 360)
        )
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 8)
    .padding(.bottom, 6)
  }

  private func accessibleTable(width: CGFloat, height: CGFloat) -> some View {
    ScrollView(.vertical) {
      VStack(spacing: 14) {
        opponentRail(width: width, usesShortLandscapeLayout: false)
          .frame(height: min(max(height * 0.38, 220), 360))

        RoomTableBand(model: model)
          .frame(maxWidth: .infinity, minHeight: 150)

        localBoard
          .frame(maxWidth: min(max(width - 16, 280), 620))
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 8)
      .padding(.vertical, 12)
    }
    .accessibilityIdentifier("rooms.table.accessible-layout")
  }

  private func opponentRail(width: CGFloat, usesShortLandscapeLayout: Bool) -> some View {
    RoomOpponentRail(
      players: model.opponentGamePlayers,
      activePlayerID: activePlayerID,
      width: width,
      usesShortLandscapeLayout: usesShortLandscapeLayout,
      differentiateWithoutColor: differentiateWithoutColor
    )
  }

  @ViewBuilder
  private var localBoard: some View {
    if let player = model.localGamePlayer {
      PublicRoomPlayerBoard(
        player: player,
        isLocal: true,
        opponentIndex: nil,
        isCompact: false,
        isActive: model.isLocalTurn,
        differentiateWithoutColor: differentiateWithoutColor,
        actionForIndex: { index in Task { await model.selectLocalCard(at: index) } },
        isEnabledAtIndex: model.isLocalCardEnabled
      )
    }
  }
}

private struct RoomOpponentRail: View {
  let players: [PublicPlayerSnapshot]
  let activePlayerID: String?
  let width: CGFloat
  let usesShortLandscapeLayout: Bool
  let differentiateWithoutColor: Bool

  var body: some View {
    ScrollView(.horizontal) {
      LazyHStack(alignment: .center, spacing: 8) {
        ForEach(Array(players.enumerated()), id: \.element.id) { index, player in
          PublicRoomPlayerBoard(
            player: player,
            isLocal: false,
            opponentIndex: index,
            isCompact: true,
            isActive: player.id == activePlayerID,
            differentiateWithoutColor: differentiateWithoutColor,
            actionForIndex: { _ in },
            isEnabledAtIndex: { _ in false }
          )
          .frame(width: opponentWidth)
        }
      }
      .scrollTargetLayout()
      .padding(.horizontal, 4)
    }
    .scrollTargetBehavior(.viewAligned)
    .contentMargins(.vertical, 4, for: .scrollContent)
    .accessibilityLabel("Opponent boards")
    .accessibilityIdentifier("rooms.opponents")
  }

  private var opponentWidth: CGFloat {
    RoomLayoutMetrics.opponentBoardWidth(
      availableWidth: width,
      usesShortLandscapeLayout: usesShortLandscapeLayout
    )
  }
}

private struct PublicRoomPlayerBoard: View {
  let player: PublicPlayerSnapshot
  let isLocal: Bool
  let opponentIndex: Int?
  let isCompact: Bool
  let isActive: Bool
  let differentiateWithoutColor: Bool
  let actionForIndex: (Int) -> Void
  let isEnabledAtIndex: (Int) -> Bool

  var body: some View {
    VStack(spacing: isCompact ? 2 : 7) {
      HStack(spacing: 6) {
        if isActive {
          Image(systemName: "play.circle.fill")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
        Text(isLocal ? "You" : player.name)
          .font(isCompact ? .caption2.bold() : .headline)
          .lineLimit(1)
          .minimumScaleFactor(0.65)
        Spacer(minLength: 2)
        Text("\(player.totalScore) pts")
          .font((isCompact ? Font.caption2 : Font.caption).monospacedDigit())
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        "\(isLocal ? "Your" : player.name) board, \(player.totalScore) points\(isActive ? ", active turn" : "")"
      )

      LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: isCompact ? 1 : 5), count: 4),
        spacing: isCompact ? 1 : 5
      ) {
        ForEach(Array(player.grid.enumerated()), id: \.offset) { index, card in
          let row = index / SkyjoRules.columns + 1
          let column = index % SkyjoRules.columns + 1
          SkyjoCardView(
            face: cardFace(card),
            label: cardLabel(card, row: row, column: column),
            hint: isEnabledAtIndex(index) ? "Selects this card for the current action" : nil,
            isEnabled: isEnabledAtIndex(index),
            aspectRatio: isCompact ? 1 : 1.34,
            action: { actionForIndex(index) }
          )
          .overlay(alignment: .topTrailing) {
            if differentiateWithoutColor, card.faceUp, !card.removed, let value = card.value {
              Image(systemName: value >= 9 ? "exclamationmark" : "checkmark")
                .font(.caption2.bold())
                .padding(2)
                .accessibilityHidden(true)
            }
          }
          .accessibilityIdentifier(
            "rooms.card.\(boardIdentifier).r\(row).c\(column)"
          )
        }
      }
    }
    .padding(isCompact ? 4 : 9)
    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12)
        .stroke(isActive ? Color.accentColor : Color.secondary, lineWidth: isActive ? 2 : 1)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("rooms.board.\(boardIdentifier)")
  }

  private var boardIdentifier: String {
    isLocal ? "local" : "opponent.\(opponentIndex ?? 0)"
  }

  private func cardFace(_ card: PublicCardSnapshot) -> SkyjoCardFace {
    if card.removed { return .removed }
    if card.faceUp, let value = card.value { return .faceUp(value) }
    return .faceDown
  }

  private func cardLabel(_ card: PublicCardSnapshot, row: Int, column: Int) -> String {
    let owner = isLocal ? "Your card" : "\(player.name)'s card"
    if card.removed { return "\(owner), row \(row), column \(column), cleared" }
    if card.faceUp, let value = card.value {
      return "\(owner), row \(row), column \(column), \(spokenValue(value))"
    }
    return "\(owner), row \(row), column \(column), face down"
  }
}

@MainActor
private struct RoomTableBand: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    if dynamicTypeSize.isAccessibilitySize {
      ScrollView(.horizontal) {
        band
          .frame(minWidth: 620, minHeight: 140)
          .padding(.horizontal, 4)
      }
      .accessibilityLabel("Table actions")
    } else {
      band
    }
  }

  private var band: some View {
    HStack(spacing: 7) {
      SkyjoActionSlot {
        Button {
          Task { await model.drawBlind() }
        } label: {
          VStack(spacing: 4) {
            Image(systemName: "rectangle.stack.fill")
            Text("Deck")
              .font(.caption.bold())
            Text("\(model.game?.drawPileCount ?? 0)")
              .font(.caption2.monospacedDigit())
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(!canDraw)
        .accessibilityLabel("Draw pile, \(model.game?.drawPileCount ?? 0) cards")
        .accessibilityHint(canDraw ? "Draws one hidden card" : disabledReason)
        .accessibilityIdentifier("rooms.action.deck")
      }

      SkyjoActionSlot {
        Button {
          Task { await model.chooseDiscard() }
        } label: {
          VStack(spacing: 4) {
            Text("Discard")
              .font(.caption.bold())
            if let value = model.game?.discardPile.top?.value {
              Text(value.formatted())
                .font(.title2.monospacedDigit().bold())
            } else {
              Image(systemName: "rectangle.dashed")
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(!canChooseDiscard)
        .accessibilityLabel(discardLabel)
        .accessibilityHint(
          model.game?.selectedSource == .discard
            ? "Returns the discard card to the pile"
            : (canChooseDiscard ? "Takes the visible discard card" : disabledReason)
        )
        .accessibilityIdentifier("rooms.action.discard")
      }

      SkyjoActionSlot(isOccupied: drawnValue != nil) {
        if let drawnValue {
          VStack(spacing: 3) {
            Text("Drawn")
              .font(.caption.bold())
            Text(drawnValue.formatted())
              .font(.title2.monospacedDigit().bold())
            Picker("Drawn card action", selection: $model.drawChoice) {
              ForEach(RoomDrawChoice.allCases) { Text($0.rawValue).tag($0) }
            }
            .labelsHidden()
            .pickerStyle(.menu)
          }
          .accessibilityElement(children: .contain)
        } else {
          Color.clear
        }
      }

      SkyjoActionSlot {
        VStack(spacing: 5) {
          if model.connectionStatus.hasPendingCommand {
            ProgressView()
              .accessibilityLabel("Action pending")
          } else {
            Image(systemName: guidanceImage)
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
          }
          Text(guidance)
            .font(.caption)
            .multilineTextAlignment(.center)
            .lineLimit(4)
            .minimumScaleFactor(0.7)
        }
        .padding(4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(guidance)
        .accessibilityIdentifier("rooms.action.guidance")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("rooms.table-band")
  }

  private var canDraw: Bool {
    model.commandsEnabled && model.isLocalTurn && model.game?.phase == .chooseSource
  }

  private var canChooseDiscard: Bool {
    guard model.commandsEnabled, model.isLocalTurn, let game = model.game else { return false }
    return (game.phase == .chooseSource && game.discardPile.top != nil)
      || (game.phase == .chooseReplacement && game.selectedSource == .discard)
  }

  private var drawnValue: Int? {
    guard model.isLocalTurn else { return nil }
    return model.game?.drawnCard?.value
  }

  private var discardLabel: String {
    guard let top = model.game?.discardPile.top, let value = top.value else {
      return "Discard pile, empty"
    }
    return "Discard pile, top card \(spokenValue(value))"
  }

  private var disabledReason: String {
    model.interactionDisabledReason ?? "This action is unavailable in the current turn."
  }

  private var guidance: String {
    guard let game = model.game else { return "Waiting for the authoritative table." }
    if !model.isLocalTurn {
      let active = game.players.indices.contains(game.currentPlayerIndex)
        ? game.players[game.currentPlayerIndex].name
        : "the current player"
      return "Waiting for \(active)."
    }
    switch game.phase {
    case .openingReveal: return "Reveal two face-down cards."
    case .chooseSource: return "Choose the deck or discard pile."
    case .chooseReplacement:
      return model.drawChoice == .discardAndReveal
        ? "Select a face-down card to reveal."
        : "Select a card to replace."
    case .roundOver: return "Review scores and mark ready."
    case .gameOver: return "Review the final scores."
    }
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
}

@MainActor
private struct RoomConnectionBanner: View {
  let model: RoomSessionModel
  let alwaysVisible: Bool

  var body: some View {
    if alwaysVisible || model.connectionStatus.phase != .connected
      || model.connectionStatus.hasPendingCommand {
      SkyjoStatusBanner(
        title: title,
        message: message,
        systemImage: image,
        tint: tint
      )
      .accessibilityAddTraits(.updatesFrequently)
      .accessibilityIdentifier("rooms.connection.\(model.connectionStatus.phase.rawValue)")
      .transition(.opacity)
      .onAppear(perform: announceStatus)
      .onChange(of: model.connectionStatus) {
        announceStatus()
      }
    }
  }

  private func announceStatus() {
    AccessibilityNotification.Announcement("\(title). \(message)").post()
  }

  private var title: String {
    if model.connectionStatus.hasPendingCommand { return "Action pending" }
    return switch model.connectionStatus.phase {
    case .idle: "Not connected"
    case .connecting: "Connecting"
    case .connected: "Table synchronized"
    case .reconnecting: "Reconnecting"
    case .offline: "Offline"
    case .error: "Connection error"
    case .upgradeRequired: "Update required"
    }
  }

  private var message: String {
    if model.connectionStatus.hasPendingCommand {
      return "Waiting for an acknowledgement and authoritative snapshot."
    }
    switch model.connectionStatus.phase {
    case .idle: return model.room == nil ? "Create or join a room." : "Retry the saved seat or leave it."
    case .connecting: return "Opening the room and waiting for its first personalized snapshot."
    case .connected: return "Room actions use the latest server revision."
    case .reconnecting:
      if let delay = model.connectionStatus.retryInMilliseconds {
        let delaySeconds = (Double(delay) / 1_000).formatted(
          .number.precision(.fractionLength(1))
        )
        return "The table is read-only. Retrying in \(delaySeconds) seconds."
      }
      return "The table is read-only while Skyjo reconnects."
    case .offline: return "The last table remains visible and read-only until the network returns."
    case .error: return "The last table is read-only. Retry the saved seat."
    case .upgradeRequired: return "Install a compatible Skyjo version before continuing."
    }
  }

  private var image: String {
    switch model.connectionStatus.phase {
    case .connected: "checkmark.circle.fill"
    case .offline: "wifi.slash"
    case .error, .upgradeRequired: "exclamationmark.triangle.fill"
    case .idle: "pause.circle"
    case .connecting, .reconnecting: "arrow.triangle.2.circlepath"
    }
  }

  private var tint: Color {
    switch model.connectionStatus.phase {
    case .connected: .green
    case .offline, .error, .upgradeRequired: .red
    case .idle, .connecting, .reconnecting: .orange
    }
  }
}

private struct RoomUserBanner: View {
  let banner: RoomBanner
  let onDismiss: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      SkyjoStatusBanner(
        title: banner.title,
        message: banner.message,
        systemImage: banner.tone == .information ? "info.circle.fill" : "exclamationmark.triangle.fill",
        tint: banner.tone == .error ? .red : (banner.tone == .warning ? .orange : .blue)
      )
      Button("Dismiss", systemImage: "xmark.circle.fill", action: onDismiss)
        .labelStyle(.iconOnly)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityIdentifier("rooms.banner.dismiss")
    }
    .accessibilityIdentifier("rooms.banner")
    .onAppear {
      AccessibilityNotification.Announcement("\(banner.title). \(banner.message)").post()
    }
  }
}

@MainActor
private struct RoomRoster: View {
  @Bindable var model: RoomSessionModel
  let showsManagement: Bool
  @State private var removalConfirmation: RoomPlayerRemovalConfirmation?

  var body: some View {
    GroupBox("Players") {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        VStack(spacing: 8) {
          ForEach(Array((model.room?.players ?? []).enumerated()), id: \.offset) { _, player in
            HStack(alignment: .center, spacing: 8) {
              VStack(alignment: .leading, spacing: 3) {
                Text(player.id == model.playerID ? "You" : player.name)
                  .font(.headline)
                Text(status(for: player))
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if player.id == model.room?.hostId {
                Label("Host", systemImage: "crown.fill")
                  .labelStyle(.iconOnly)
                  .foregroundStyle(.yellow)
                  .accessibilityLabel("Room host")
              }
              if showsManagement, model.isLocalHost, player.id != model.playerID {
                if model.room?.status == .waiting {
                  Button("Remove", role: .destructive) {
                    removalConfirmation = RoomPlayerRemovalConfirmation(
                      playerID: player.id,
                      playerName: player.name
                    )
                  }
                  .disabled(!model.commandsEnabled)
                  .frame(minHeight: 44)
                  .accessibilityLabel("Remove \(player.name) from room")
                  .accessibilityHint("Requires confirmation before removing this seat")
                } else if model.canTakeOver(player) {
                  Button("Hand to AI") { Task { await model.takeOverWithAI(player.id) } }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Hand \(player.name)'s seat to AI")
                }
              }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
          }
        }
      }
    }
    .accessibilityIdentifier("rooms.roster")
    .alert(item: $removalConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text("Remove Player")) {
          Task { await model.removePlayer(confirmation.playerID) }
        },
        secondaryButton: .cancel()
      )
    }
  }

  private func status(for player: PublicRoomPlayerSnapshot) -> String {
    let presence = player.connected ? "Connected" : "Disconnected"
    let controller = player.controller == .ai ? "AI controlled" : "Human controlled"
    if !player.connected,
       player.controller == .human,
       let deadline = player.aiTakeoverAt,
       deadline > model.estimatedServerNow {
      let remaining = max(0, Int((deadline - model.estimatedServerNow + 999) / 1_000))
      return "\(presence), \(controller), reconnect window \(remaining) seconds"
    }
    return "\(presence), \(controller)"
  }
}

@MainActor
private struct RoomChatButton: View {
  @Bindable var model: RoomSessionModel

  var body: some View {
    Button {
      model.isChatPresented = true
    } label: {
      Label {
        Text(model.unreadChatCount > 0 ? "Chat, \(model.unreadChatCount) unread" : "Chat")
      } icon: {
        ZStack(alignment: .topTrailing) {
          Image(systemName: "bubble.left.and.bubble.right.fill")
          if model.unreadChatCount > 0 {
            Text("\(min(model.unreadChatCount, 99))")
              .font(.caption2.bold())
              .foregroundStyle(.white)
              .padding(4)
              .background(.red, in: Circle())
              .offset(x: 9, y: -9)
              .accessibilityHidden(true)
          }
        }
      }
      .frame(minWidth: 52, minHeight: 52)
    }
    .buttonStyle(.borderedProminent)
    .clipShape(Circle())
    .shadow(radius: 4)
    .accessibilityIdentifier("rooms.chat.open")
  }
}

@MainActor
private struct RoomChatView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = ""

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
              if model.room?.chatMessages.isEmpty != false {
                ContentUnavailableView(
                  "No messages yet",
                  systemImage: "bubble.left",
                  description: Text("Say hello when friends join the table.")
                )
              }
              ForEach(model.room?.chatMessages ?? [], id: \.id) { message in
                VStack(alignment: .leading, spacing: 3) {
                  HStack {
                    Text(message.playerId == model.playerID ? "You" : message.playerName)
                      .font(.caption.bold())
                    Spacer()
                    Text(Date(timeIntervalSince1970: Double(message.createdAt) / 1_000), style: .time)
                      .font(.caption2)
                      .foregroundStyle(.secondary)
                  }
                  Text(message.text)
                    .textSelection(.disabled)
                }
                .padding(10)
                .background(
                  message.playerId == model.playerID
                    ? Color.accentColor.opacity(0.12)
                    : Color.secondary.opacity(0.1),
                  in: RoundedRectangle(cornerRadius: 10)
                )
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                  "\(message.playerId == model.playerID ? "You" : message.playerName): \(message.text)"
                )
                .id(message.id)
              }
            }
            .padding()
          }
          .onAppear {
            model.markChatRead()
            if let identifier = model.room?.chatMessages.last?.id {
              proxy.scrollTo(identifier, anchor: .bottom)
            }
          }
          .onChange(of: model.room?.chatMessages.count) {
            model.markChatRead()
            if let identifier = model.room?.chatMessages.last?.id {
              if reduceMotion {
                proxy.scrollTo(identifier, anchor: .bottom)
              } else {
                withAnimation { proxy.scrollTo(identifier, anchor: .bottom) }
              }
            }
          }
        }

        Divider()
        HStack(alignment: .bottom, spacing: 8) {
          TextField("Message players", text: $draft, axis: .vertical)
            .lineLimit(1...4)
            .onChange(of: draft) { _, value in
              let bounded = boundedChatDraft(value)
              if bounded != value { draft = bounded }
            }
            .accessibilityIdentifier("rooms.chat.message")
          Button("Send") {
            let message = draft
            draft = ""
            Task { await model.sendChat(message) }
          }
          .buttonStyle(.borderedProminent)
          .disabled(!model.commandsEnabled || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .frame(minHeight: 44)
          .accessibilityIdentifier("rooms.chat.send")
        }
        .padding()
      }
      .navigationTitle("Table Chat")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("rooms.chat.sheet")
  }
}

@MainActor
private struct RoomOptionsView: View {
  enum Confirmation: String, Identifiable {
    case leave
    case reset
    case forgetSavedSeat

    var id: Self { self }
  }

  @Bindable var model: RoomSessionModel
  @Environment(\.dismiss) private var dismiss
  @State private var confirmation: Confirmation?

  var body: some View {
    NavigationStack {
      Form {
        if let room = model.room {
          Section("Room") {
            LabeledContent("Code", value: room.code)
            LabeledContent("Status", value: room.status.rawValue.capitalized)
            Button("Share Invite") {
              dismiss()
              Task { await model.createShareInvite() }
            }
            .disabled(!model.canCreateShareInvite)
          }
        }

        Section {
          RoomRoster(model: model, showsManagement: true)
        }

        Section("Actions") {
          if model.isLocalHost, model.room?.status == .waiting {
            Button("Start Game") {
              dismiss()
              Task { await model.startGame() }
            }
            .disabled(!model.canStartWaitingRoom)
          }
          if model.canLeaveWaitingRoom {
            Button("Leave Room", role: .destructive) { confirmation = .leave }
          }
          if model.isLocalHost {
            Button("Reset Room", role: .destructive) { confirmation = .reset }
              .disabled(!model.commandsEnabled)
          }
          if model.connectionStatus.phase == .error || model.connectionStatus.phase == .idle {
            Button("Retry Saved Seat") {
              dismiss()
              Task { await model.retrySavedSeat() }
            }
            .disabled(!model.canSubmitAdmission)
          }
          if model.canForgetSavedSeat {
            Button("Forget Saved Seat", role: .destructive) {
              confirmation = .forgetSavedSeat
            }
            .disabled(!model.canForgetSavedSeat)
            .accessibilityHint("Requires confirmation before removing saved routing data")
          }
        }
      }
      .navigationTitle("Room Options")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .alert(item: $confirmation) { value in
        switch value {
        case .leave:
          Alert(
            title: Text("Leave this room?"),
            message: Text("Your waiting-room seat will be removed."),
            primaryButton: .destructive(Text("Leave")) {
              dismiss()
              Task { await model.leaveRoom() }
            },
            secondaryButton: .cancel()
          )
        case .reset:
          Alert(
            title: Text("Reset for everyone?"),
            message: Text("The current room and game will be replaced with a new room code."),
            primaryButton: .destructive(Text("Reset Room")) {
              dismiss()
              Task { await model.resetRoom() }
            },
            secondaryButton: .cancel()
          )
        case .forgetSavedSeat:
          Alert(
            title: Text(RoomConfirmationCopy.forgetSavedSeatTitle),
            message: Text(RoomConfirmationCopy.forgetSavedSeatMessage),
            primaryButton: .destructive(Text("Forget Saved Seat")) {
              dismiss()
              Task { await model.forgetSavedSeat() }
            },
            secondaryButton: .cancel()
          )
        }
      }
    }
    .presentationDetents([.medium, .large])
    .accessibilityIdentifier("rooms.options.sheet")
  }
}

@MainActor
private struct RoomScoreView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text(model.game?.phase == .gameOver ? "Game complete" : "Round complete")
            .font(.largeTitle.bold())

          if let scores = model.game?.roundHistory.last?.scores {
            ForEach(scores, id: \.playerId) { score in
              HStack {
                VStack(alignment: .leading) {
                  Text(score.name).font(.headline)
                  Text("Round \(score.roundScore)").foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(score.totalScore) total")
                  .font(.headline.monospacedDigit())
              }
              .padding()
              .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
              .accessibilityElement(children: .combine)
            }
          }

          Text("\(model.readyCount)/\(model.readyPlayerIDs.count) ready")
            .font(.headline)
            .accessibilityIdentifier("rooms.score.ready-count")

          Button(model.localIsReady ? "Mark Not Ready" : "I'm Ready") {
            Task { await model.toggleReady() }
          }
          .buttonStyle(.borderedProminent)
          .disabled(!model.commandsEnabled)
          .frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityIdentifier("rooms.score.ready")

          if model.isLocalHost {
            Button(model.game?.phase == .gameOver ? "Restart Game" : "Start Next Round") {
              dismiss()
              Task { await model.startGame() }
            }
            .buttonStyle(.bordered)
            .disabled(!model.canAdvanceAfterScoring)
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityIdentifier("rooms.score.advance")
          }
        }
        .padding()
      }
      .navigationTitle("Scores")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Minimize") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .interactiveDismissDisabled(false)
    .accessibilityIdentifier("rooms.score.sheet")
  }
}

@MainActor
private struct RoomInviteReviewView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 20) {
        Label("Skyjo room invite", systemImage: "person.3.fill")
          .font(.largeTitle.bold())
        if let invite = model.pendingInviteReview {
          if let banner = model.banner {
            RoomUserBanner(banner: banner, onDismiss: model.dismissBanner)
          }
          Text("Room \(invite.roomCode)")
            .font(.title.monospaced().bold())
          Text("This link grants Skyjo access only. Your signed-in account and the room server still decide whether you may join or reclaim a seat.")
            .foregroundStyle(.secondary)
          if let currentRoom = model.room, currentRoom.code != invite.roomCode {
            Text(
              currentRoom.status == .waiting
                ? "Leave room \(currentRoom.code) first so its seat and host handoff are confirmed. This invite will stay ready while the server acknowledges the leave."
                : "Switching disconnects you from the active game in room \(currentRoom.code). Your reserved seat may be controlled by AI while you are away."
            )
            .font(.callout.weight(.semibold))
            .foregroundStyle(.orange)
            .accessibilityIdentifier("rooms.invite.switch-warning")
          }
          LabeledContent(
            "Expires",
            value: Date(timeIntervalSince1970: Double(invite.expiresAt) / 1_000).formatted()
          )
          Button {
            if model.inviteRequiresLeavingCurrentRoom {
              Task { await model.leaveRoom() }
            } else {
              Task { await model.acceptInviteAndJoin() }
            }
          } label: {
            Text(
              model.inviteRequiresLeavingCurrentRoom
                ? "Leave Current Room to Continue"
                : model.room == nil ? "Join This Room" : "Switch to This Room"
            )
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .disabled(
            invite.isExpired(at: Int64(Date().timeIntervalSince1970 * 1_000))
              || (
                model.inviteRequiresLeavingCurrentRoom
                  ? !model.canLeaveWaitingRoom
                  : !model.canAcceptInvite
              )
          )
          .accessibilityIdentifier("rooms.invite.join")
        }
        Spacer()
      }
      .padding()
      .navigationTitle("Review Invite")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            Task { await model.dismissInviteReview() }
            dismiss()
          }
        }
      }
    }
    .presentationDetents([.medium])
    .interactiveDismissDisabled()
    .accessibilityIdentifier("rooms.invite.review")
  }
}

@MainActor
private struct RoomShareView: View {
  @Bindable var model: RoomSessionModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 20) {
        if let invite = model.shareInvite {
          Label("Invite to room \(invite.roomCode)", systemImage: "link")
            .font(.title.bold())
          Text("Friends with the app installed can open this link in Skyjo. Everyone else keeps the existing browser fallback.")
            .foregroundStyle(.secondary)
          ShareLink(
            item: invite.url,
            subject: Text("Skyjo room \(invite.roomCode)"),
            message: Text("Join my Skyjo room \(invite.roomCode).")
          ) {
            Label("Share Invite", systemImage: "square.and.arrow.up")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("rooms.share.system")
        }
        Spacer()
      }
      .padding()
      .navigationTitle("Share Room")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
    .onDisappear { model.clearShareInvite() }
    .accessibilityIdentifier("rooms.share.sheet")
  }
}

private func spokenValue(_ value: Int) -> String {
  value < 0 ? "minus \(abs(value))" : value.formatted()
}

private func boundedChatDraft(_ value: String) -> String {
  var utf16Count = 0
  return String(value.prefix { character in
    let nextCount = utf16Count + String(character).utf16.count
    guard nextCount <= 280 else { return false }
    utf16Count = nextCount
    return true
  })
}
