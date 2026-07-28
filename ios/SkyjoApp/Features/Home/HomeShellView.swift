import SkyjoNetworking
import SwiftUI

@MainActor
struct HomeShellView: View {
  @Bindable var model: AppModel
  let user: AccountUser

  var body: some View {
    TabView(selection: $model.selectedTab) {
      Tab("Home", systemImage: "house", value: .home) {
        NavigationStack {
          HomeView(model: model, user: user)
        }
      }

      Tab("Stats", systemImage: "chart.bar", value: .stats) {
        NavigationStack {
          StatsView(model: model)
        }
      }

      Tab("Account", systemImage: "person.crop.circle", value: .account) {
        NavigationStack {
          AccountView(model: model, user: user)
        }
      }
    }
    .accessibilityIdentifier("shell.tabs")
  }
}

@MainActor
private struct HomeView: View {
  @Bindable var model: AppModel
  let user: AccountUser
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var columns: [GridItem] {
    if dynamicTypeSize.isAccessibilitySize {
      return [GridItem(.flexible(), spacing: 12)]
    }
    return [GridItem(.adaptive(minimum: 145), spacing: 12)]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Welcome, \(user.displayName)")
            .font(.largeTitle.bold())
            .accessibilityIdentifier("home.welcome")
          Text("Your native Skyjo table is ready.")
            .foregroundStyle(.primary)
        }

        LazyVGrid(columns: columns, spacing: 12) {
          FeatureCard(
            title: "Single Player",
            detail: "Native game play arrives in IOS-7.",
            systemImage: "person.fill",
            accessibilityIdentifier: "home.solo-disabled"
          )
          FeatureCard(
            title: "Multiplayer",
            detail: "Native rooms arrive in IOS-8.",
            systemImage: "person.3.fill",
            accessibilityIdentifier: "home.rooms-disabled"
          )
        }

        GroupBox("Account snapshot") {
          VStack(alignment: .leading, spacing: 12) {
            if let summary = model.statsSummary {
              HStack {
                StatValue(label: "Games", value: "\(summary.`self`.gamesPlayed)")
                Spacer()
                StatValue(label: "Wins", value: "\(summary.`self`.wins)")
                Spacer()
                StatValue(label: "Win rate", value: summary.`self`.winRate.formatted(.number.precision(.fractionLength(0))) + "%")
              }
            } else if model.statsState == .loading {
              ProgressView("Loading account stats")
            } else {
              Text("Stats will appear after a successful refresh.")
                .foregroundStyle(.secondary)
            }

            Button("View Stats") {
              model.selectedTab = .stats
            }
            .accessibilityIdentifier("home.view-stats")
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .frame(maxWidth: 760, alignment: .leading)
      .padding()
    }
    .navigationTitle("Home")
    .accessibilityIdentifier("home.screen")
  }
}

private struct FeatureCard: View {
  let title: String
  let detail: String
  let systemImage: String
  let accessibilityIdentifier: String

  var body: some View {
    Button {} label: {
      VStack(alignment: .leading, spacing: 12) {
        Image(systemName: systemImage)
          .font(.title)
        Text(title)
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
        Text(detail)
          .font(.subheadline)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
      .padding()
    }
    .buttonStyle(AccessibleBorderedButtonStyle(addsContentPadding: false))
    .disabled(true)
    .accessibilityIdentifier(accessibilityIdentifier)
    .accessibilityHint("Unavailable in this foundation release")
  }
}

struct AccessibleBorderedButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  private let addsContentPadding: Bool

  init(addsContentPadding: Bool = true) {
    self.addsContentPadding = addsContentPadding
  }

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(
        addsContentPadding
          ? EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
          : EdgeInsets()
      )
      .frame(minWidth: 44, minHeight: 44)
      .foregroundStyle(isEnabled ? Color.accentColor : Color.primary)
      .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
      .overlay {
        RoundedRectangle(cornerRadius: 10)
          .stroke(isEnabled ? Color.accentColor : Color.primary, lineWidth: 1)
      }
      .opacity(configuration.isPressed ? 0.72 : 1)
  }
}

struct StatValue: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(value)
        .font(.title2.bold())
      Text(label)
        .font(.caption)
        .foregroundStyle(.primary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(label)
    .accessibilityValue(value)
  }
}
