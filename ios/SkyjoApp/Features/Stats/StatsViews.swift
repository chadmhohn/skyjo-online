import SkyjoNetworking
import SwiftUI

@MainActor
struct StatsView: View {
  @Bindable var model: AppModel

  var body: some View {
    Group {
      switch model.statsState {
      case .idle, .loading:
        VStack(spacing: 16) {
          ProgressView()
            .controlSize(.large)
          Text("Loading stats")
            .font(.headline)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stats.loading")
      case .empty:
        ScrollView {
          VStack(spacing: 20) {
            if let summary = model.statsSummary {
              StatsSummaryView(summary: summary)
            }
            StateMessageView(
              title: "No games yet",
              systemImage: "chart.bar.xaxis",
              message: "Completed signed-in games will appear here.",
              accessibilityIdentifier: "stats.empty"
            ) {
              Button("Refresh") { Task { await model.loadStats() } }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("stats.retry")
            }
          }
          .padding()
        }
      case .offline(let message):
        StateMessageView(
          title: "Stats are offline",
          systemImage: "wifi.slash",
          message: message,
          accessibilityIdentifier: "stats.offline"
        ) {
          Button("Retry") { Task { await model.loadStats() } }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("stats.retry")
        }
      case .failed(let message):
        StateMessageView(
          title: "Stats unavailable",
          systemImage: "exclamationmark.triangle",
          message: message,
          accessibilityIdentifier: "stats.failed"
        ) {
          Button("Retry") { Task { await model.loadStats() } }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("stats.retry")
        }
      case .loaded:
        StatsLoadedView(model: model)
      }
    }
    .navigationTitle("Stats")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Refresh", systemImage: "arrow.clockwise") {
          Task { await model.loadStats() }
        }
        .disabled(model.statsState == .loading || model.isRefreshingStats)
        .accessibilityIdentifier("stats.refresh")
      }
    }
    .accessibilityIdentifier("stats.screen")
  }
}

@MainActor
private struct StatsLoadedView: View {
  @Bindable var model: AppModel

  var body: some View {
    List {
      if let summary = model.statsSummary {
        Section("Summary") {
          StatsSummaryView(summary: summary)
            .listRowInsets(EdgeInsets())
        }

        if !summary.coPlayers.isEmpty {
          Section("Players") {
            ForEach(summary.coPlayers) { player in
              NavigationLink {
                PlayerHistoryView(model: model, userID: player.userId)
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(player.displayName)
                    .font(.headline)
                  Text("\(player.gamesTogether) games together")
                    .foregroundStyle(.secondary)
                }
              }
              .accessibilityIdentifier("stats.player.\(player.userId.uuidString.lowercased())")
            }
          }
        }
      }

      Section("Game history") {
        ForEach(model.games) { game in
          NavigationLink {
            GameDetailView(model: model, gameID: game.id)
          } label: {
            GameRow(game: game)
          }
          .accessibilityIdentifier("stats.game.\(game.id.uuidString.lowercased())")
        }
      }
    }
    .refreshable { await model.loadStats() }
    .accessibilityIdentifier("stats.loaded")
  }
}

struct StatsSummaryView: View {
  let summary: StatsSummary

  private let columns = [GridItem(.adaptive(minimum: 105), spacing: 12)]

  var body: some View {
    LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
      StatValue(label: "Games", value: "\(summary.`self`.gamesPlayed)")
      StatValue(label: "Wins", value: "\(summary.`self`.wins)")
      StatValue(
        label: "Win rate",
        value: summary.`self`.winRate.formatted(.number.precision(.fractionLength(0))) + "%"
      )
      StatValue(
        label: "Best score",
        value: summary.`self`.bestTotalScore.map(String.init) ?? "—"
      )
    }
    .padding()
    .accessibilityIdentifier("stats.summary")
  }
}

private struct GameRow: View {
  let game: StatsGame

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 8) {
        Image(systemName: game.mode == .single ? "person" : "person.3")
          .accessibilityHidden(true)
        Text(game.mode == .single ? "Single player" : "Multiplayer")
          .font(.headline)
          .frame(minWidth: 130, alignment: .leading)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(game.completedDate, format: .dateTime.month(.abbreviated).day().year())
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("Winner: \(game.winnerName)")
      Text("\(game.roundCount) \(game.roundCount == 1 ? "round" : "rounds")")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }
}

@MainActor
private struct GameDetailView: View {
  @Bindable var model: AppModel
  let gameID: UUID

  var body: some View {
    Group {
      switch model.gameDetailState {
      case .idle, .loading:
        ProgressView("Loading game")
          .accessibilityIdentifier("stats.game-detail.loading")
      case .failed(let message):
        StateMessageView(
          title: "Game unavailable",
          systemImage: "exclamationmark.triangle",
          message: message,
          accessibilityIdentifier: "stats.game-detail.failed"
        ) {
          Button("Retry") { Task { await model.loadGame(id: gameID) } }
        }
      case .loaded(let game):
        if game.id == gameID {
          List {
            Section("Game") {
              LabeledContent("Mode", value: game.mode == .single ? "Single player" : "Multiplayer")
              LabeledContent("Completed") {
                Text(game.completedDate, format: .dateTime)
              }
              LabeledContent("Winner", value: game.winnerName)
              LabeledContent("Rounds", value: "\(game.roundCount)")
              if game.finishedByAi {
                Label("Finished by an AI player", systemImage: "cpu")
              }
            }

            Section("Final standings") {
              ForEach(game.participants) { participant in
                VStack(alignment: .leading, spacing: 4) {
                  HStack {
                    Text("#\(participant.rank) \(participant.displayName)")
                      .font(.headline)
                    Spacer()
                    Text("\(participant.totalScore)")
                      .font(.headline.monospacedDigit())
                  }
                  Text(participant.kind == .ai ? "AI player" : "Human player")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Rank \(participant.rank), \(participant.displayName), total score \(participant.totalScore)")
              }
            }

            Section("Round history") {
              ForEach(game.rounds) { score in
                LabeledContent("Round \(score.round), \(score.displayName)", value: "\(score.roundScore)")
              }
            }
          }
          .accessibilityIdentifier("stats.game-detail.loaded")
        } else {
          ProgressView("Loading game")
            .accessibilityIdentifier("stats.game-detail.loading")
        }
      }
    }
    .navigationTitle("Game Detail")
    .task(id: gameID) { await model.loadGame(id: gameID) }
  }
}

@MainActor
private struct PlayerHistoryView: View {
  @Bindable var model: AppModel
  let userID: UUID

  var body: some View {
    Group {
      switch model.playerHistoryState {
      case .idle, .loading:
        ProgressView("Loading player history")
          .accessibilityIdentifier("stats.player-history.loading")
      case .failed(let message):
        StateMessageView(
          title: "Player history unavailable",
          systemImage: "exclamationmark.triangle",
          message: message,
          accessibilityIdentifier: "stats.player-history.failed"
        ) {
          Button("Retry") { Task { await model.loadPlayerHistory(userID: userID) } }
        }
      case .empty(let history):
        if history.user.id == userID {
          VStack(spacing: 20) {
            PlayerSummaryHeader(history: history)
            StateMessageView(
              title: "No shared games",
              systemImage: "person.2.slash",
              message: "No visible game history is available for this player.",
              accessibilityIdentifier: "stats.player-history.empty"
            )
          }
        } else {
          ProgressView("Loading player history")
            .accessibilityIdentifier("stats.player-history.loading")
        }
      case .loaded(let history):
        if history.user.id == userID {
          List {
            Section {
              PlayerSummaryHeader(history: history)
            }
            Section("Visible games") {
              ForEach(history.games) { game in
                NavigationLink {
                  GameDetailView(model: model, gameID: game.id)
                } label: {
                  GameRow(game: game)
                }
              }
            }
          }
          .accessibilityIdentifier("stats.player-history.loaded")
        } else {
          ProgressView("Loading player history")
            .accessibilityIdentifier("stats.player-history.loading")
        }
      }
    }
    .navigationTitle("Player History")
    .task(id: userID) { await model.loadPlayerHistory(userID: userID) }
  }
}

private struct PlayerSummaryHeader: View {
  let history: PlayerStats

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(history.user.displayName)
        .font(.title2.bold())
      HStack {
        StatValue(label: "Games", value: "\(history.summary.gamesPlayed)")
        Spacer()
        StatValue(label: "Wins", value: "\(history.summary.wins)")
        Spacer()
        StatValue(
          label: "Win rate",
          value: history.summary.winRate.formatted(.number.precision(.fractionLength(0))) + "%"
        )
      }
    }
    .padding(.vertical, 8)
    .accessibilityIdentifier("stats.player-history.summary")
  }
}

private extension StatsGame {
  var completedDate: Date {
    Date(timeIntervalSince1970: TimeInterval(completedAt) / 1_000)
  }
}
