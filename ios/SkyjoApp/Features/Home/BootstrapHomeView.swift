import SkyjoDesignSystem
import SwiftUI

@MainActor
struct BootstrapHomeView: View {
  @State private var model: AppModel?
  private let configurationError: AppConfigurationError?

  init(configuration: Result<AppConfiguration, AppConfigurationError>) {
    switch configuration {
    case .success(let configuration):
      _model = State(initialValue: AppModel(configuration: configuration))
      configurationError = nil
    case .failure(let error):
      _model = State(initialValue: nil)
      configurationError = error
    }
  }

  var body: some View {
    Group {
      if let model {
        NativeRootView(model: model)
      } else {
        NavigationStack {
          StateMessageView(
            title: "Configuration unavailable",
            systemImage: "exclamationmark.triangle",
            message: configurationError?.localizedDescription ?? "The app is not configured.",
            accessibilityIdentifier: "bootstrap.configuration-error"
          )
          .navigationTitle("Skyjo")
        }
      }
    }
    .tint(Color("AccentColor"))
  }
}

@MainActor
private struct NativeRootView: View {
  @Bindable var model: AppModel

  var body: some View {
    Group {
      switch model.rootState {
      case .loading:
        NavigationStack {
          VStack(spacing: 20) {
            ProgressView()
              .controlSize(.large)
            Text("Loading Skyjo")
              .font(.headline)
            Text("Checking service and session status.")
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("state.loading")
          .navigationTitle("Skyjo")
        }
      case .accessRequired:
        AccessGateView(model: model)
      case .accountRequired:
        AuthenticationView(model: model)
      case .authenticated:
        if let user = model.user {
          HomeShellView(model: model, user: user)
        } else {
          StateMessageView(
            title: "Account unavailable",
            systemImage: "person.crop.circle.badge.exclamationmark",
            message: "Sign in again to continue.",
            accessibilityIdentifier: "state.account-missing"
          ) {
            Button("Retry") { Task { await model.bootstrap() } }
          }
        }
      case .offline(let message):
        NavigationStack {
          StateMessageView(
            title: "You're offline",
            systemImage: "wifi.slash",
            message: message,
            accessibilityIdentifier: "state.offline"
          ) {
            Button("Retry") { Task { await model.bootstrap() } }
              .buttonStyle(.borderedProminent)
              .accessibilityIdentifier("state.retry")
          }
          .navigationTitle("Skyjo")
        }
      case .serviceNotReady:
        NavigationStack {
          StateMessageView(
            title: "Service not ready",
            systemImage: "wrench.and.screwdriver",
            message: "Skyjo is temporarily unavailable while the service recovers.",
            accessibilityIdentifier: "state.not-ready"
          ) {
            Button("Try Again") { Task { await model.bootstrap() } }
              .buttonStyle(.borderedProminent)
              .accessibilityIdentifier("state.retry")
          }
          .navigationTitle("Skyjo")
        }
      case .upgradeRequired:
        NavigationStack {
          StateMessageView(
            title: "Update required",
            systemImage: "arrow.down.app",
            message: "This Skyjo app version is not compatible with the current service. Update the app before trying again.",
            accessibilityIdentifier: "state.upgrade-required"
          ) {
            Button("Try Again") { Task { await model.bootstrap() } }
              .buttonStyle(.borderedProminent)
              .accessibilityIdentifier("state.retry")
          }
          .navigationTitle("Skyjo")
        }
      case .accountEnded:
        NavigationStack {
          StateMessageView(
            title: "Account access ended",
            systemImage: "person.crop.circle.badge.xmark",
            message: "Your session expired or this account was disabled. Sign in again to continue.",
            accessibilityIdentifier: "state.expired-disabled"
          ) {
            Button("Continue to Sign In") {
              model.rootState = .accountRequired
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("state.continue-sign-in")
          }
          .navigationTitle("Skyjo")
        }
      case .failed(let message):
        NavigationStack {
          StateMessageView(
            title: "Skyjo couldn't load",
            systemImage: "exclamationmark.triangle",
            message: message,
            accessibilityIdentifier: "state.failed"
          ) {
            Button("Retry") { Task { await model.bootstrap() } }
              .buttonStyle(.borderedProminent)
              .accessibilityIdentifier("state.retry")
          }
          .navigationTitle("Skyjo")
        }
      }
    }
    .task {
#if DEBUG
      if model.applyUITestState(arguments: ProcessInfo.processInfo.arguments) {
        return
      }
#endif
      guard model.rootState == .loading else { return }
      await model.bootstrap()
    }
  }
}

struct StateMessageView<Actions: View>: View {
  let title: String
  let systemImage: String
  let message: String
  let accessibilityIdentifier: String
  @ViewBuilder let actions: Actions

  init(
    title: String,
    systemImage: String,
    message: String,
    accessibilityIdentifier: String,
    @ViewBuilder actions: () -> Actions
  ) {
    self.title = title
    self.systemImage = systemImage
    self.message = message
    self.accessibilityIdentifier = accessibilityIdentifier
    self.actions = actions()
  }

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: systemImage)
    } description: {
      Text(message)
    } actions: {
      actions
    }
    .accessibilityIdentifier(accessibilityIdentifier)
    .padding(24)
  }
}

extension StateMessageView where Actions == EmptyView {
  init(
    title: String,
    systemImage: String,
    message: String,
    accessibilityIdentifier: String
  ) {
    self.init(
      title: title,
      systemImage: systemImage,
      message: message,
      accessibilityIdentifier: accessibilityIdentifier
    ) {
      EmptyView()
    }
  }
}
