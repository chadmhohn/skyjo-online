import SkyjoNetworking
import SwiftUI

@MainActor
struct AccountView: View {
  @Bindable var model: AppModel
  @Bindable var notifications: NativeNotificationCoordinator
  @Bindable private var settings: AccountSettingsFormModel
  let user: AccountUser
  @State private var confirmsLogout = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  init(
    model: AppModel,
    notifications: NativeNotificationCoordinator,
    user: AccountUser
  ) {
    self.model = model
    self.notifications = notifications
    _settings = Bindable(model.accountSettings)
    self.user = user
  }

  var body: some View {
    Form {
      Section("Current account") {
        LabeledContent("Email", value: user.email)
        LabeledContent("Role", value: user.role == .admin ? "Administrator" : "Player")
        if let lastLogin = user.lastLoginAt {
          LabeledContent("Last sign in") {
            Text(Date(timeIntervalSince1970: TimeInterval(lastLogin) / 1_000), format: .dateTime)
          }
        }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-expose-dynamic-type") {
          Text(dynamicTypeDiagnosticValue)
            .accessibilityLabel("Effective Dynamic Type")
            .accessibilityValue(dynamicTypeDiagnosticValue)
            .accessibilityIdentifier("debug.dynamic-type")
        }
#endif
      }

      Section("Profile") {
        TextField("Display name", text: $settings.displayName)
          .textContentType(.name)
          .accessibilityIdentifier("account.display-name")

        Button {
          Task { await model.updateProfile() }
        } label: {
          HStack {
            Text("Save Profile")
            if settings.isSavingProfile {
              Spacer()
              ProgressView()
                .accessibilityLabel("Saving profile")
            }
          }
        }
        .disabled(!settings.canSaveProfile)
        .buttonStyle(AccessibleBorderedButtonStyle())
        .accessibilityIdentifier("account.save-profile")

        if !settings.profileMessage.isEmpty {
          Text(settings.profileMessage)
            .foregroundStyle(settings.profileMessage == "Profile updated." ? Color.secondary : Color.red)
            .accessibilityIdentifier("account.profile-message")
        }
      }

      Section("Change password") {
        SecureField("Current password", text: $settings.currentPassword)
          .textContentType(.password)
          .accessibilityIdentifier("account.current-password")
        SecureField("New password", text: $settings.password)
          .textContentType(.newPassword)
          .accessibilityIdentifier("account.new-password")
        SecureField("Confirm new password", text: $settings.confirmPassword)
          .textContentType(.newPassword)
          .submitLabel(.done)
          .onSubmit { changePassword() }
          .accessibilityIdentifier("account.confirm-password")

        Button("Change Password") { changePassword() }
          .disabled(!settings.canChangePassword)
          .buttonStyle(AccessibleBorderedButtonStyle())
          .accessibilityIdentifier("account.change-password")

        Text("Changing your password signs this account out on every device.")
          .font(.footnote)
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)

        if !settings.passwordMessage.isEmpty {
          Text(settings.passwordMessage)
            .foregroundStyle(.red)
            .accessibilityIdentifier("account.password-message")
        }
      }

      Section("Turn notifications") {
        notificationControls
        Text(notificationDetail)
          .font(.footnote)
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("account.notifications.detail")
      }

      if user.role == .admin {
        Section("Administration") {
          Text("Native admin tools are intentionally out of scope for v0.1.0.")
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("account.admin-web-only")
          Link("Open Web Admin", destination: model.adminURL)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("account.admin-link")
        }
      }

      Section("Account deletion") {
        Label("Required before public App Store release", systemImage: "checklist")
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("account.deletion-gate")
        Text("Deletion semantics and native UI are tracked in public-release dependency #192. TestFlight work may continue, but this release cannot be listed publicly until that issue is complete.")
          .font(.footnote)
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
        Link("View tracking issue #192", destination: model.accountDeletionIssueURL)
          .font(.body)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("account.deletion-link")
      }

      Section {
        Button("Sign Out", role: .destructive) {
          confirmsLogout = true
        }
        .disabled(settings.isLoggingOut)
        .buttonStyle(AccessibleBorderedButtonStyle())
        .accessibilityIdentifier("account.logout")

        Text("If a session expires or an account is disabled, Skyjo returns to a safe sign-in recovery screen.")
          .font(.footnote)
          .foregroundStyle(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("account.recovery-footer")
      }
    }
    .contentMargins(.bottom, 96, for: .scrollContent)
    .navigationTitle("Account")
    .accessibilityIdentifier("account.screen")
    .confirmationDialog(
      "Sign out of this account?",
      isPresented: $confirmsLogout,
      titleVisibility: .visible
    ) {
      Button("Sign Out", role: .destructive) {
        Task { await model.logoutAccount() }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  private func changePassword() {
    guard settings.canChangePassword else { return }
    Task { await model.changePassword() }
  }

  @ViewBuilder
  private var notificationControls: some View {
    switch notifications.state {
    case .enabled:
      Label("Notifications enabled", systemImage: "bell.badge.fill")
        .accessibilityIdentifier("account.notifications.enabled")
      Button("Turn Off Notifications", role: .destructive) {
        Task { await notifications.disable() }
      }
      .disabled(notifications.isWorking)
      .accessibilityIdentifier("account.notifications.disable")
    case .denied:
      Label("Notifications blocked in Settings", systemImage: "bell.slash.fill")
        .accessibilityIdentifier("account.notifications.denied")
      Button("Open Settings") { notifications.openSettings() }
        .accessibilityIdentifier("account.notifications.settings")
    case .checking:
      HStack {
        ProgressView()
        Text("Setting up notifications")
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("account.notifications.checking")
    case .unavailable:
      Label("Notifications are not available yet", systemImage: "bell.slash")
        .accessibilityIdentifier("account.notifications.unavailable")
      Button("Try Again") { Task { await notifications.retry() } }
        .disabled(notifications.isWorking)
        .accessibilityIdentifier("account.notifications.retry")
    case .failed:
      Label("Notification setup needs another try", systemImage: "exclamationmark.triangle")
        .accessibilityIdentifier("account.notifications.failed")
      Button("Try Again") { Task { await notifications.retry() } }
        .disabled(notifications.isWorking)
        .accessibilityIdentifier("account.notifications.retry")
      Button("Turn Off Notifications", role: .destructive) {
        Task { await notifications.disable() }
      }
      .disabled(notifications.isWorking)
      .accessibilityIdentifier("account.notifications.disable")
    case .off:
      Button("Enable Turn Notifications") {
        Task { await notifications.enable() }
      }
      .disabled(notifications.isWorking)
      .accessibilityIdentifier("account.notifications.enable")
    }
  }

  private var notificationDetail: String {
    switch notifications.state {
    case .enabled:
      "This device can alert you when a multiplayer turn needs attention. Skyjo hides alerts while the app is open."
    case .denied:
      "Allow notifications in iOS Settings, then return to Skyjo."
    case .unavailable:
      "The Skyjo service has not enabled native notifications yet. Multiplayer still works normally."
    case .failed:
      "Skyjo could not finish notification setup. Multiplayer still works normally."
    case .off, .checking:
      "Skyjo asks only after you tap Enable. Alerts contain no cards, chat, scores, email, or invite links."
    }
  }

#if DEBUG
  private var dynamicTypeDiagnosticValue: String {
    switch dynamicTypeSize {
    case .xSmall: "xSmall"
    case .small: "small"
    case .medium: "medium"
    case .large: "large"
    case .xLarge: "xLarge"
    case .xxLarge: "xxLarge"
    case .xxxLarge: "xxxLarge"
    case .accessibility1: "accessibility1"
    case .accessibility2: "accessibility2"
    case .accessibility3: "accessibility3"
    case .accessibility4: "accessibility4"
    case .accessibility5: "accessibility5"
    @unknown default: "unknown"
    }
  }
#endif
}
