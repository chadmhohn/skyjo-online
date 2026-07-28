import SkyjoDesignSystem
import SkyjoNetworking
import SkyjoPersistence
import SwiftUI

@MainActor
struct HomeShellView: View {
  @Bindable var model: AppModel
  let user: AccountUser?
  @Bindable var solo: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore
  let offlineMessage: String?

  var body: some View {
    TabView(selection: $model.selectedTab) {
      Tab("Home", systemImage: "house", value: .home) {
        NavigationStack {
          HomeView(
            model: model,
            user: user,
            solo: solo,
            preferences: preferences,
            offlineMessage: offlineMessage
          )
        }
      }

      Tab("Stats", systemImage: "chart.bar", value: .stats) {
        NavigationStack {
          if user != nil {
            StatsView(model: model)
          } else {
            SignedOutFeatureView(
              title: "Sign in for stats",
              message: "Guest solo games stay on this device and do not add account stats.",
              model: model
            )
          }
        }
      }

      Tab("Account", systemImage: "person.crop.circle", value: .account) {
        NavigationStack {
          if let user {
            AccountView(model: model, user: user)
          } else {
            AuthenticationView(model: model, embedsNavigation: false)
          }
        }
      }
    }
    .accessibilityIdentifier("shell.tabs")
  }
}

@MainActor
private struct HomeView: View {
  @Bindable var model: AppModel
  let user: AccountUser?
  @Bindable var solo: SoloFeatureModel
  @Bindable var preferences: SoloPreferencesStore
  let offlineMessage: String?
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
          Text(user.map { "Welcome, \($0.displayName)" } ?? "Welcome to Skyjo")
            .font(.largeTitle.bold())
            .accessibilityIdentifier("home.welcome")
          Text(homeSubtitle)
            .foregroundStyle(.primary)
        }

        if let offlineMessage {
          VStack(alignment: .leading, spacing: 10) {
            SkyjoStatusBanner(
              title: "Offline solo is available",
              message: offlineMessage,
              systemImage: "wifi.slash"
            )
            .accessibilityIdentifier("home.offline-banner")
            Button {
              Task { await model.bootstrap() }
            } label: {
              Text("Check Connection")
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("home.offline-retry")
          }
        }

        LazyVGrid(columns: columns, spacing: 12) {
          NavigationLink {
            SoloRootView(model: solo, preferences: preferences)
          } label: {
            FeatureCardLabel(
              title: "Single Player",
              detail: solo.savedGameSummary == nil
                ? "Start a native offline game with 1–7 bots."
                : "Continue your saved round or review a new setup.",
              systemImage: "person.fill"
            )
          }
          .buttonStyle(AccessibleBorderedButtonStyle(addsContentPadding: false))
          .accessibilityIdentifier("home.solo")
          .accessibilityValue(
            solo.outboxStatus.blockedHeadKind == nil
              ? ""
              : "Stats delivery needs attention"
          )
          .accessibilityHint("Opens the native single-player table")
          FeatureCard(
            title: "Multiplayer",
            detail: "Native rooms arrive in IOS-8.",
            systemImage: "person.3.fill",
            accessibilityIdentifier: "home.rooms-disabled"
          )
        }

        GroupBox(accountSnapshotTitle) {
          VStack(alignment: .leading, spacing: 12) {
            if user == nil, solo.owner.accountID == nil {
              Text("Your active guest save restores on this device. Completed guest games are not uploaded to account stats.")
                .foregroundStyle(.secondary)
            } else if user == nil {
              Text("This account-owned solo save remains available offline. Completed results stay on this device until the account is confirmed online.")
                .foregroundStyle(.secondary)
            } else if let summary = model.statsSummary {
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

            Button(user == nil ? "Sign In" : "View Stats") {
              model.selectedTab = user == nil ? .account : .stats
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

  private var accountSnapshotTitle: String {
    if user != nil { return "Account snapshot" }
    return solo.owner.accountID == nil ? "Guest play" : "Offline account save"
  }

  private var homeSubtitle: String {
    if user != nil { return "Your native Skyjo table is ready." }
    if solo.owner.accountID != nil {
      return "Continue your account-owned solo save offline; results will sync after account confirmation."
    }
    return "Play solo as a guest, or sign in when you want account stats."
  }
}

private struct FeatureCard: View {
  let title: String
  let detail: String
  let systemImage: String
  let accessibilityIdentifier: String

  var body: some View {
    Button {} label: {
      FeatureCardLabel(title: title, detail: detail, systemImage: systemImage)
    }
    .buttonStyle(AccessibleBorderedButtonStyle(addsContentPadding: false))
    .disabled(true)
    .accessibilityIdentifier(accessibilityIdentifier)
    .accessibilityHint("Unavailable in this foundation release")
  }
}

private struct FeatureCardLabel: View {
  let title: String
  let detail: String
  let systemImage: String

  var body: some View {
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
}

@MainActor
private struct SignedOutFeatureView: View {
  let title: String
  let message: String
  @Bindable var model: AppModel

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: "person.crop.circle.badge.plus")
    } description: {
      Text(message)
    } actions: {
      Button("Open Account") { model.selectedTab = .account }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
    }
    .navigationTitle("Stats")
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
