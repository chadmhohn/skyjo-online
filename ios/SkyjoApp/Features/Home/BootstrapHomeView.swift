import Foundation
import SkyjoDesignSystem
import SkyjoNetworking
import SwiftUI

@MainActor
struct BootstrapHomeView: View {
  @State private var model: AppModel?
  @State private var dependencies: AppDependencies?
  private let configurationErrorMessage: String?

  init(configuration: Result<AppConfiguration, AppConfigurationError>) {
    switch configuration {
    case .success(let configuration):
      do {
        let dependencies = try AppDependencies(configuration: configuration)
        _dependencies = State(initialValue: dependencies)
        _model = State(
          initialValue: AppModel(
            dependencies: dependencies,
            baseURL: configuration.apiBaseURL
          )
        )
        configurationErrorMessage = nil
      } catch {
        _dependencies = State(initialValue: nil)
        _model = State(initialValue: nil)
        configurationErrorMessage = "Local game storage could not be initialized."
      }
    case .failure(let error):
      _dependencies = State(initialValue: nil)
      _model = State(initialValue: nil)
      configurationErrorMessage = error.localizedDescription
    }
  }

  var body: some View {
    Group {
      if let model, let dependencies {
        NativeRootView(
          model: model,
          dependencies: dependencies,
          rooms: dependencies.rooms
        )
      } else {
        NavigationStack {
          StateMessageView(
            title: "Configuration unavailable",
            systemImage: "exclamationmark.triangle",
            message: configurationErrorMessage ?? "The app is not configured.",
            accessibilityIdentifier: "bootstrap.configuration-error"
          )
          .navigationTitle("Skyjo")
        }
      }
    }
    .tint(Color("AccentColor"))
    .onOpenURL { url in
      guard let model, let dependencies else { return }
      Task {
        guard await dependencies.rooms.accept(url) else { return }
        guard case .review = dependencies.rooms.handoffState else { return }

        // Successful redemption may install the outer-access cookie. Keep only
        // sanitized room/expiry review state while bootstrap advances through
        // the access and account gates.
        if !model.hasConfirmedAccountSession {
          await model.bootstrap()
        }
        await dependencies.rooms.synchronize(
          account: model.hasConfirmedAccountSession ? model.user : nil
        )
        if model.hasConfirmedAccountSession {
          model.selectedTab = .home
        }
      }
    }
  }
}

@MainActor
private struct NativeRootView: View {
  @Bindable var model: AppModel
  let dependencies: AppDependencies
  @Bindable var rooms: RoomAppCoordinator
  @Environment(\.scenePhase) private var scenePhase

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
      case .guest:
        HomeShellView(
          model: model,
          user: nil,
          solo: dependencies.solo,
          preferences: dependencies.preferences,
          rooms: rooms,
          offlineMessage: nil
        )
      case .authenticated:
        HomeShellView(
          model: model,
          user: model.user,
          solo: dependencies.solo,
          preferences: dependencies.preferences,
          rooms: rooms,
          offlineMessage: nil
        )
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
      case .offlineReady(let message):
        HomeShellView(
          model: model,
          user: model.user,
          solo: dependencies.solo,
          preferences: dependencies.preferences,
          rooms: rooms,
          offlineMessage: message
        )
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
        await model.synchronizeLocalSolo(dependencies.solo)
        _ = await dependencies.solo.applyUITestState(arguments: ProcessInfo.processInfo.arguments)
        return
      }
#endif
      guard model.rootState == .loading else { return }
      await model.bootstrap()
    }
    .task(
      id: LocalSoloSynchronizationID(
        rootState: model.rootState,
        localSessionGeneration: model.localSessionGeneration
      )
    ) {
#if DEBUG
      if ProcessInfo.processInfo.arguments.contains(where: {
        $0.hasPrefix("--ui-state=solo-")
      }) {
        return
      }
#endif
      await model.synchronizeLocalSolo(dependencies.solo)
    }
    .task(
      id: RoomAccountSynchronizationID(
        rootState: model.rootState,
        account: model.user
      )
    ) {
      await rooms.synchronize(
        account: model.hasConfirmedAccountSession ? model.user : nil
      )
      if case .idle = rooms.handoffState,
         rooms.isRoomPresented,
         model.hasConfirmedAccountSession {
        model.selectedTab = .home
      }
    }
    .safeAreaInset(edge: .top) {
      InviteHandoffStatusView(
        state: rooms.handoffState,
        waitsForAccount: !model.hasConfirmedAccountSession
      )
    }
    .alert(
      "Invite unavailable",
      isPresented: Binding(
        get: { rooms.inviteFailureMessage != nil },
        set: { if !$0 { rooms.dismissInviteHandoff() } }
      )
    ) {
      Button("OK") { rooms.dismissInviteHandoff() }
    } message: {
      Text(rooms.inviteFailureMessage ?? "Skyjo could not open this invite.")
    }
    .onChange(of: dependencies.sessionInvalidation.generation) {
      guard let invalidation = dependencies.sessionInvalidation.pendingInvalidation else { return }
      model.handleStatsAuthorizationInvalidation(invalidation)
      dependencies.sessionInvalidation.consume(invalidation)
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      dependencies.solo.setSceneActive(phase == .active)
    }
  }
}

private struct LocalSoloSynchronizationID: Equatable {
  let rootState: AppRootState
  let localSessionGeneration: Int
}

private struct RoomAccountSynchronizationID: Equatable {
  let rootState: AppRootState
  let account: AccountUser?
}

private struct InviteHandoffStatusView: View {
  let state: RoomInviteHandoffState
  let waitsForAccount: Bool

  @ViewBuilder
  var body: some View {
    switch state {
    case .redeeming:
      HStack(spacing: 10) {
        ProgressView()
        Text("Opening Skyjo invite…")
          .font(.subheadline.weight(.semibold))
      }
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal)
      .background(.regularMaterial)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("rooms.invite.redeeming")
    case .review(let invite) where waitsForAccount:
      Label(
        "Invite for room \(invite.roomCode) is ready. Sign in to review it.",
        systemImage: "person.crop.circle.badge.checkmark"
      )
      .font(.subheadline.weight(.semibold))
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal)
      .background(.regularMaterial)
      .accessibilityIdentifier("rooms.invite.waiting-for-account")
    case .idle, .review, .failed:
      EmptyView()
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
