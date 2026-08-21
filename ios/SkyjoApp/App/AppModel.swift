import Foundation
import Observation
import SkyjoNetworking
import SkyjoPersistence

protocol SkyjoService: Sendable {
  func readiness() async throws -> ServiceReadiness
  func accessStatus() async throws -> AccessSessionStatus
  func loginAccess(password: String) async throws -> AccessSessionStatus
  func currentAccount() async throws -> AccountUser?
  func signup(
    email: String,
    displayName: String,
    password: String,
    confirmPassword: String
  ) async throws -> AccountUser
  func loginAccount(email: String, password: String) async throws -> AccountUser
  func logoutAccount(apnsInstallationID: UUID?) async throws
  func updateProfile(displayName: String) async throws -> AccountUser
  func changePassword(
    currentPassword: String,
    password: String,
    confirmPassword: String
  ) async throws
  func deleteAccount(currentPassword: String, confirmation: String) async throws
  func statsSummary() async throws -> StatsSummary
  func statsGames() async throws -> [StatsGame]
  func statsGame(id: UUID) async throws -> StatsGame
  func playerStats(userID: UUID) async throws -> PlayerStats
}

extension SkyjoAPIClient: SkyjoService {}

enum AppRootState: Equatable {
  case loading
  case accessRequired
  case accountRequired
  case guest
  case authenticated
  case offline(message: String)
  case offlineReady(message: String)
  case serviceNotReady
  case upgradeRequired
  case accountEnded
  case failed(message: String)
}

enum AppTab: Hashable {
  case home
  case stats
  case account
}

enum AuthenticationMode: String, CaseIterable, Identifiable {
  case login = "Sign In"
  case signup = "Create Account"

  var id: Self { self }
}

enum StatsLoadState: Equatable {
  case idle
  case loading
  case empty
  case loaded
  case offline(message: String)
  case failed(message: String)
}

enum GameDetailLoadState: Equatable {
  case idle
  case loading
  case loaded(StatsGame)
  case failed(message: String)
}

enum PlayerHistoryLoadState: Equatable {
  case idle
  case loading
  case loaded(PlayerStats)
  case empty(PlayerStats)
  case failed(message: String)
}

private func hasSchemaLength(_ value: String, in range: ClosedRange<Int>) -> Bool {
  range.contains(value.unicodeScalars.count)
}

private func hasIdenticalUnicodeScalars(_ lhs: String, _ rhs: String) -> Bool {
  lhs.unicodeScalars.elementsEqual(rhs.unicodeScalars)
}

@MainActor
@Observable
final class AccessFormModel {
  var password = ""
  var errorMessage = ""
  var isSubmitting = false

  var canSubmit: Bool {
    hasSchemaLength(password, in: 1...4_096) && !isSubmitting
  }

  func clearSensitiveFields() {
    password = ""
  }
}

@MainActor
@Observable
final class AuthenticationFormModel {
  var mode = AuthenticationMode.login
  var email = ""
  var displayName = ""
  var password = ""
  var confirmPassword = ""
  var errorMessage = ""
  var isSubmitting = false

  var canSubmit: Bool {
    guard !isSubmitting else { return false }
    let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      hasSchemaLength(normalizedEmail, in: 3...254),
      hasSchemaLength(password, in: 8...1_024)
    else {
      return false
    }
    if mode == .signup {
      let normalizedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      return hasSchemaLength(normalizedName, in: 1...24)
        && hasIdenticalUnicodeScalars(password, confirmPassword)
    }
    return true
  }

  func clearSensitiveFields() {
    password = ""
    confirmPassword = ""
  }
}

@MainActor
@Observable
final class AccountSettingsFormModel {
  var displayName = ""
  var currentPassword = ""
  var password = ""
  var confirmPassword = ""
  var profileMessage = ""
  var passwordMessage = ""
  var deletionPassword = ""
  var deletionConfirmation = ""
  var deletionMessage = ""
  var isSavingProfile = false
  var isChangingPassword = false
  var isLoggingOut = false
  var isDeletingAccount = false

  var canSaveProfile: Bool {
    let value = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    return hasSchemaLength(value, in: 1...24) && !isSavingProfile
  }

  var canChangePassword: Bool {
    hasSchemaLength(currentPassword, in: 1...1_024)
      && hasSchemaLength(password, in: 8...1_024)
      && hasIdenticalUnicodeScalars(password, confirmPassword)
      && !isChangingPassword
  }

  var canDeleteAccount: Bool {
    hasSchemaLength(deletionPassword, in: 1...1_024)
      && deletionConfirmation == "DELETE"
      && !isDeletingAccount
  }

  func synchronize(with user: AccountUser) {
    displayName = user.displayName
  }

  func clearSensitiveFields() {
    currentPassword = ""
    password = ""
    confirmPassword = ""
    deletionPassword = ""
    deletionConfirmation = ""
  }
}

@MainActor
@Observable
final class AppModel {
  private static let supportedReadinessSchemaVersion = 2
  private static let supportedProtocolVersion = 2

  private let service: any SkyjoService
  private let preferences: SoloPreferencesStore?
  private let sessionInvalidation: SessionInvalidationRelay?
  private let logoutInstallationID: () -> UUID?
  private let deleteLocalAccountData: @Sendable (UUID) async throws -> Void
  private var accountGeneration = 0
  private var bootstrapRequestID: UUID?
  private var statsRequestID: UUID?
  private var gameDetailRequestID: UUID?
  private var playerHistoryRequestID: UUID?
  private var profileRequestID: UUID?
  private var passwordRequestID: UUID?
  private var deletionRequestID: UUID?
  private var logoutRequestID: UUID?
#if DEBUG
  private var uiTestStatsFixture: UITestStatsFixture?
#endif

  let access = AccessFormModel()
  let authentication = AuthenticationFormModel()
  let accountSettings = AccountSettingsFormModel()
  let adminURL: URL

  var rootState = AppRootState.loading
  var selectedTab = AppTab.home
  var user: AccountUser?
  var statsState = StatsLoadState.idle
  var isRefreshingStats = false
  var statsSummary: StatsSummary?
  var games: [StatsGame] = []
  var gameDetailState = GameDetailLoadState.idle
  var playerHistoryState = PlayerHistoryLoadState.idle
  private(set) var localSessionGeneration = 0

  init(
    service: any SkyjoService,
    baseURL: URL,
    preferences: SoloPreferencesStore? = nil,
    sessionInvalidation: SessionInvalidationRelay? = nil,
    logoutInstallationID: @escaping () -> UUID? = { nil },
    deleteLocalAccountData: @escaping @Sendable (UUID) async throws -> Void = { _ in }
  ) {
    self.service = service
    self.preferences = preferences
    self.sessionInvalidation = sessionInvalidation
    self.logoutInstallationID = logoutInstallationID
    self.deleteLocalAccountData = deleteLocalAccountData
    adminURL = baseURL.appending(path: "admin")
  }

  convenience init(dependencies: AppDependencies, baseURL: URL) {
    self.init(
      service: dependencies.apiClient,
      baseURL: baseURL,
      preferences: dependencies.preferences,
      sessionInvalidation: dependencies.sessionInvalidation,
      logoutInstallationID: { dependencies.notifications.installationID },
      deleteLocalAccountData: { accountID in
        try await dependencies.persistenceStore.deleteAccountData(accountID: accountID)
      }
    )
  }

  convenience init(configuration: AppConfiguration) {
    let environment = SkyjoNetworkEnvironment(baseURL: configuration.apiBaseURL)
    let service = SkyjoAPIClient(
      environment: environment,
      persistentCookieStorage: .shared
    )
    self.init(service: service, baseURL: configuration.apiBaseURL)
  }

  func bootstrap() async {
    let requestID = UUID()
    bootstrapRequestID = requestID
    sessionInvalidation?.setConfirmedAccount(nil)
    rootState = .loading
    do {
      let readiness = try await service.readiness()
      guard bootstrapRequestID == requestID else { return }
      guard readiness.status == .ready else {
        routeUnavailableForLocalSolo(
          fallback: .serviceNotReady,
          message: "The online service is recovering. Your local solo game remains available."
        )
        return
      }
      guard
        readiness.schemaVersion == Self.supportedReadinessSchemaVersion,
        readiness.protocolVersion == Self.supportedProtocolVersion
      else {
        rootState = .upgradeRequired
        return
      }

      // The shared-password gate was retired before the first external beta.
      // A successful readiness/version check is now the service-access fence;
      // account authentication remains independent and optional for solo play.
      preferences?.confirmAccess()

      let currentUser = try await service.currentAccount()
      guard bootstrapRequestID == requestID else { return }
      guard let currentUser else {
        resetAccountState()
        preferences?.confirmSignedOut()
        rootState = .guest
        return
      }
      guard !currentUser.disabled else {
        resetAccountState(prefillEmail: currentUser.email)
        rootState = .accountEnded
        return
      }

      establishAuthenticatedUser(currentUser)
      await loadStats()
    } catch {
      guard bootstrapRequestID == requestID else { return }
      routeBootstrapError(error)
    }
  }

  func submitAccess() async {
    guard access.canSubmit else { return }
    access.isSubmitting = true
    access.errorMessage = ""
    defer {
      access.isSubmitting = false
      access.clearSensitiveFields()
    }

    let status: AccessSessionStatus
    do {
      status = try await service.loginAccess(password: access.password)
    } catch {
      access.errorMessage = userMessage(for: error)
      return
    }
    access.clearSensitiveFields()
    guard status.authenticated else {
      access.errorMessage = "Authentication failed."
      return
    }
    preferences?.confirmAccess()

    rootState = .loading
    do {
      let currentUser = try await service.currentAccount()
      if let currentUser, !currentUser.disabled {
        establishAuthenticatedUser(currentUser)
        await loadStats()
      } else if let currentUser {
        resetAccountState(prefillEmail: currentUser.email)
        rootState = .accountEnded
      } else {
        resetAccountState()
        preferences?.confirmSignedOut()
        rootState = .guest
      }
    } catch {
      routeBootstrapError(error)
    }
  }

  func submitAuthentication() async {
    guard authentication.canSubmit else { return }
    authentication.isSubmitting = true
    authentication.errorMessage = ""
    defer {
      authentication.isSubmitting = false
      authentication.clearSensitiveFields()
    }

    do {
      let email = authentication.email.trimmingCharacters(in: .whitespacesAndNewlines)
      let authenticatedUser: AccountUser
      switch authentication.mode {
      case .login:
        authenticatedUser = try await service.loginAccount(
          email: email,
          password: authentication.password
        )
      case .signup:
        authenticatedUser = try await service.signup(
          email: email,
          displayName: authentication.displayName.trimmingCharacters(in: .whitespacesAndNewlines),
          password: authentication.password,
          confirmPassword: authentication.confirmPassword
        )
      }
      guard !authenticatedUser.disabled else {
        resetAccountState(prefillEmail: authenticatedUser.email)
        rootState = .accountEnded
        return
      }
      establishAuthenticatedUser(authenticatedUser)
      await loadStats()
    } catch {
      if !routeSessionError(error, accountWasKnown: false) {
        authentication.errorMessage = userMessage(for: error)
      }
    }
  }

  func loadStats() async {
    guard rootState == .authenticated, let expectedUserID = user?.id else { return }
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    let preservesLoadedContent = statsState == .loaded
    statsRequestID = requestID
    isRefreshingStats = preservesLoadedContent
    if !preservesLoadedContent {
      statsState = .loading
    }
    defer {
      if statsRequestID == requestID {
        isRefreshingStats = false
        statsRequestID = nil
      }
    }
#if DEBUG
    if let uiTestStatsFixture {
      await Task.yield()
      guard
        isCurrentAccount(expectedUserID, generation: expectedGeneration),
        statsRequestID == requestID
      else { return }
      statsSummary = uiTestStatsFixture.summary
      games = [uiTestStatsFixture.game]
      statsState = .loaded
      return
    }
#endif
    do {
      async let summaryRequest = service.statsSummary()
      async let gamesRequest = service.statsGames()
      let (summary, loadedGames) = try await (summaryRequest, gamesRequest)
      guard isCurrentAccount(expectedUserID, generation: expectedGeneration), statsRequestID == requestID else {
        return
      }
      statsSummary = summary
      games = loadedGames
      statsState = loadedGames.isEmpty ? .empty : .loaded
    } catch {
      guard isCurrentAccount(expectedUserID, generation: expectedGeneration), statsRequestID == requestID else {
        return
      }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      if isOffline(error) {
        statsState = .offline(message: "Stats are unavailable while you are offline.")
      } else {
        statsState = .failed(message: userMessage(for: error))
      }
    }
  }

  func loadGame(id: UUID) async {
    guard rootState == .authenticated, let expectedUserID = user?.id else { return }
#if DEBUG
    if let uiTestStatsFixture, uiTestStatsFixture.game.id == id {
      gameDetailState = .loading
      await Task.yield()
      gameDetailState = .loaded(uiTestStatsFixture.game)
      return
    }
#endif
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    gameDetailRequestID = requestID
    gameDetailState = .loading
    do {
      let game = try await service.statsGame(id: id)
      guard
        isCurrentAccount(expectedUserID, generation: expectedGeneration),
        gameDetailRequestID == requestID
      else { return }
      guard game.id == id else {
        gameDetailState = .failed(message: "The server returned an invalid response.")
        return
      }
      gameDetailState = .loaded(game)
    } catch {
      guard isCurrentAccount(expectedUserID, generation: expectedGeneration), gameDetailRequestID == requestID else {
        return
      }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      gameDetailState = .failed(message: userMessage(for: error))
    }
  }

  func loadPlayerHistory(userID: UUID) async {
    guard rootState == .authenticated, let expectedUserID = user?.id else { return }
#if DEBUG
    if let uiTestStatsFixture, uiTestStatsFixture.player.user.id == userID {
      playerHistoryState = .loading
      await Task.yield()
      playerHistoryState = .loaded(uiTestStatsFixture.player)
      return
    }
#endif
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    playerHistoryRequestID = requestID
    playerHistoryState = .loading
    do {
      let history = try await service.playerStats(userID: userID)
      guard
        isCurrentAccount(expectedUserID, generation: expectedGeneration),
        playerHistoryRequestID == requestID
      else { return }
      guard history.user.id == userID else {
        playerHistoryState = .failed(message: "The server returned an invalid response.")
        return
      }
      playerHistoryState = history.games.isEmpty ? .empty(history) : .loaded(history)
    } catch {
      guard isCurrentAccount(expectedUserID, generation: expectedGeneration), playerHistoryRequestID == requestID else {
        return
      }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      playerHistoryState = .failed(message: userMessage(for: error))
    }
  }

  func updateProfile() async {
    guard
      accountSettings.canSaveProfile,
      rootState == .authenticated,
      let expectedUserID = user?.id
    else { return }
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    profileRequestID = requestID
    accountSettings.isSavingProfile = true
    accountSettings.profileMessage = ""
    defer {
      if profileRequestID == requestID {
        accountSettings.isSavingProfile = false
        profileRequestID = nil
      }
    }
    do {
      let updatedUser = try await service.updateProfile(
        displayName: accountSettings.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      )
      guard
        isCurrentAccount(expectedUserID, generation: expectedGeneration),
        profileRequestID == requestID
      else { return }
      guard updatedUser.id == expectedUserID else {
        accountSettings.profileMessage = "The server returned an invalid response."
        return
      }
      guard !updatedUser.disabled else {
        resetAccountState(prefillEmail: updatedUser.email)
        rootState = .accountEnded
        return
      }
      user = updatedUser
      accountSettings.synchronize(with: updatedUser)
      accountSettings.profileMessage = "Profile updated."
    } catch {
      guard isCurrentAccount(expectedUserID, generation: expectedGeneration), profileRequestID == requestID else {
        return
      }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      accountSettings.profileMessage = userMessage(for: error)
    }
  }

  func changePassword() async {
    guard
      accountSettings.canChangePassword,
      rootState == .authenticated,
      let expectedUser = user
    else { return }
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    passwordRequestID = requestID
    accountSettings.isChangingPassword = true
    accountSettings.passwordMessage = ""
    defer {
      if passwordRequestID == requestID {
        accountSettings.isChangingPassword = false
        accountSettings.clearSensitiveFields()
        passwordRequestID = nil
      }
    }
    do {
      try await service.changePassword(
        currentPassword: accountSettings.currentPassword,
        password: accountSettings.password,
        confirmPassword: accountSettings.confirmPassword
      )
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        passwordRequestID == requestID
      else { return }
      resetAccountState(prefillEmail: expectedUser.email)
      authentication.errorMessage = "Password changed. Sign in with your new password."
      preferences?.confirmSignedOut()
      selectedTab = .account
      rootState = .guest
    } catch {
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        passwordRequestID == requestID
      else { return }
      if case .server(_, let code, _) = error as? SkyjoHTTPClientError,
        code == .accountNotFound
      {
        resetAccountState(prefillEmail: expectedUser.email)
        rootState = .accountEnded
        return
      }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      accountSettings.passwordMessage = userMessage(for: error)
    }
  }

  func logoutAccount() async {
    guard
      !accountSettings.isLoggingOut,
      rootState == .authenticated,
      let expectedUser = user
    else { return }
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    logoutRequestID = requestID
    accountSettings.isLoggingOut = true
    accountSettings.profileMessage = ""
    defer {
      if logoutRequestID == requestID {
        accountSettings.isLoggingOut = false
        logoutRequestID = nil
      }
    }
    do {
      try await service.logoutAccount(apnsInstallationID: logoutInstallationID())
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        logoutRequestID == requestID
      else { return }
      resetAccountState(prefillEmail: expectedUser.email)
      preferences?.confirmSignedOut()
      rootState = .guest
    } catch {
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        logoutRequestID == requestID
      else { return }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      accountSettings.profileMessage = userMessage(for: error)
    }
  }

  func deleteAccount() async {
    guard
      accountSettings.canDeleteAccount,
      rootState == .authenticated,
      let expectedUser = user
    else { return }
    let expectedGeneration = accountGeneration
    let requestID = UUID()
    deletionRequestID = requestID
    accountSettings.isDeletingAccount = true
    accountSettings.deletionMessage = ""
    defer {
      if deletionRequestID == requestID {
        accountSettings.isDeletingAccount = false
        accountSettings.deletionPassword = ""
        accountSettings.deletionConfirmation = ""
        deletionRequestID = nil
      }
    }
    do {
      try await service.deleteAccount(
        currentPassword: accountSettings.deletionPassword,
        confirmation: accountSettings.deletionConfirmation
      )
      var localCleanupFailed = false
      do {
        try await deleteLocalAccountData(expectedUser.id)
      } catch {
        localCleanupFailed = true
      }
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        deletionRequestID == requestID
      else { return }
      resetAccountState()
      authentication.errorMessage = localCleanupFailed
        ? "Account deleted online. This device could not remove its saved account game data; reinstall Skyjo to finish local cleanup."
        : "Account deleted. Retained multiplayer results now identify you only as Deleted player."
      preferences?.confirmSignedOut()
      selectedTab = .home
      rootState = .guest
    } catch {
      guard
        isCurrentAccount(expectedUser.id, generation: expectedGeneration),
        deletionRequestID == requestID
      else { return }
      guard !routeSessionError(error, accountWasKnown: true) else { return }
      accountSettings.deletionMessage = userMessage(for: error)
    }
  }

#if DEBUG
  @discardableResult
  func applyUITestState(arguments: [String]) -> Bool {
    guard let stateArgument = arguments.first(where: { $0.hasPrefix("--ui-state=") }) else {
      return false
    }
    let state = String(stateArgument.dropFirst("--ui-state=".count))
    switch state {
    case "loading":
      rootState = .loading
    case "offline":
      rootState = .offline(message: "Skyjo could not reach the service. Check your connection and try again.")
    case "guest":
      resetAccountState()
      rootState = .guest
    case "solo-offline-account":
      let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
      if arguments.contains("--ui-offline-cached-account") {
        establishAuthenticatedUser(
          AccountUser(
            id: accountID,
            email: "fixture.solo@example.invalid",
            displayName: "Solo Fixture",
            role: .player,
            disabled: false,
            createdAt: 1_784_998_800_104,
            updatedAt: 1_784_998_800_104,
            lastLoginAt: nil
          )
        )
        routeUnavailableForLocalSolo(
          fallback: .offline(message: "Skyjo could not reach the service."),
          message: "Skyjo could not reach the service. Your account-owned solo save remains available."
        )
      } else {
        resetAccountState()
        preferences?.confirmAccess()
        preferences?.confirmAccount(accountID)
        rootState = .offlineReady(
          message: "Skyjo could not reach the service. Your account-owned solo save remains available."
        )
      }
    case "solo-setup-blocked-outbox", "solo-setup-corrupt-outbox",
         "solo-game-summary-outbox-unknown":
      let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000187")!
      establishAuthenticatedUser(
        AccountUser(
          id: accountID,
          email: "fixture.solo@example.invalid",
          displayName: "Solo Fixture",
          role: .player,
          disabled: false,
          createdAt: 1_784_998_800_104,
          updatedAt: 1_784_998_800_104,
          lastLoginAt: nil
        )
      )
    case let value where value.hasPrefix("solo-"):
      resetAccountState()
      rootState = .guest
    case "not-ready":
      rootState = .serviceNotReady
    case "upgrade-required":
      rootState = .upgradeRequired
    case "expired-disabled":
      rootState = .accountEnded
    case "failed":
      rootState = .failed(message: SkyjoHTTPClientError.safeFallbackMessage)
    case "authenticated-empty", "authenticated-admin", "authenticated-stats", "authenticated-stats-offline":
      let role: AccountRole = state == "authenticated-admin" ? .admin : .player
      let fixtureUser = AccountUser(
        id: UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
        email: "fixture.user@example.invalid",
        displayName: "Fixture User",
        role: role,
        disabled: false,
        createdAt: 1_784_998_800_104,
        updatedAt: 1_784_998_800_104,
        lastLoginAt: nil
      )
      establishAuthenticatedUser(fixtureUser)
      if state == "authenticated-stats" || state == "authenticated-stats-offline" {
        guard let fixture = try? UITestStatsFixture.make() else { return false }
        uiTestStatsFixture = fixture
        if state == "authenticated-stats" {
          statsSummary = fixture.summary
          games = [fixture.game]
          statsState = .loaded
        } else {
          statsSummary = nil
          games = []
          statsState = .offline(message: "Stats are unavailable while you are offline.")
        }
      } else {
        statsState = .empty
      }
    default:
      return false
    }
    if hasConfirmedAccountSession {
      if arguments.contains("--ui-start-tab=stats") {
        selectedTab = .stats
      } else if arguments.contains("--ui-start-tab=account") {
        selectedTab = .account
      }
    }
    return true
  }
#endif

  private func establishAuthenticatedUser(_ authenticatedUser: AccountUser) {
    invalidateAccountRequests()
    accountGeneration &+= 1
    user = authenticatedUser
    sessionInvalidation?.setConfirmedAccount(authenticatedUser.id)
    preferences?.confirmAccess()
    preferences?.confirmAccount(authenticatedUser.id)
    selectedTab = .home
    accountSettings.synchronize(with: authenticatedUser)
    accountSettings.profileMessage = ""
    accountSettings.passwordMessage = ""
    authentication.mode = .login
    authentication.email = authenticatedUser.email
    authentication.displayName = ""
    authentication.clearSensitiveFields()
    authentication.errorMessage = ""
    rootState = .authenticated
    localSessionGeneration &+= 1
  }

  private func resetAccountState(prefillEmail: String? = nil) {
    sessionInvalidation?.setConfirmedAccount(nil)
    preferences?.confirmSignedOut()
    invalidateAccountRequests()
    accountGeneration &+= 1
    user = nil
    selectedTab = .home
    statsSummary = nil
    games = []
    statsState = .idle
    gameDetailState = .idle
    playerHistoryState = .idle
#if DEBUG
    uiTestStatsFixture = nil
#endif
    authentication.mode = .login
    authentication.email = prefillEmail ?? ""
    authentication.displayName = ""
    authentication.clearSensitiveFields()
    accountSettings.isSavingProfile = false
    accountSettings.isChangingPassword = false
    accountSettings.isLoggingOut = false
    accountSettings.isDeletingAccount = false
    accountSettings.profileMessage = ""
    accountSettings.passwordMessage = ""
    accountSettings.deletionMessage = ""
    accountSettings.clearSensitiveFields()
    localSessionGeneration &+= 1
  }

  private func invalidateAccountRequests() {
    statsRequestID = nil
    isRefreshingStats = false
    gameDetailRequestID = nil
    playerHistoryRequestID = nil
    profileRequestID = nil
    passwordRequestID = nil
    deletionRequestID = nil
    logoutRequestID = nil
  }

  private func isCurrentAccount(_ userID: UUID, generation: Int) -> Bool {
    rootState == .authenticated
      && user?.id == userID
      && accountGeneration == generation
  }

  private func routeBootstrapError(_ error: any Error) {
    if routeSessionError(error, accountWasKnown: user != nil) { return }
    if error as? SkyjoHTTPClientError == .unsupportedServerVersion {
      rootState = .upgradeRequired
    } else if isOffline(error) {
      routeUnavailableForLocalSolo(
        fallback: .offline(message: "Skyjo could not reach the service. Check your connection and try again."),
        message: "Skyjo could not reach the service. You can continue a local solo game; account stats will wait for a confirmed session."
      )
    } else if isServiceUnavailable(error) {
      routeUnavailableForLocalSolo(
        fallback: .serviceNotReady,
        message: "The online service is unavailable. Your local solo game remains available."
      )
    } else {
      rootState = .failed(message: userMessage(for: error))
    }
  }

  @discardableResult
  private func routeSessionError(_ error: any Error, accountWasKnown: Bool) -> Bool {
    guard case .server(_, let code, _) = error as? SkyjoHTTPClientError else { return false }
    switch code {
    case .accessRequired:
      preferences?.clearConfirmedAccessAndAccount()
      resetAccountState()
      rootState = .upgradeRequired
      return true
    case .accountAuthenticationRequired:
      let email = accountWasKnown ? user?.email : authentication.email
      resetAccountState(prefillEmail: email)
      preferences?.confirmSignedOut()
      authentication.errorMessage = accountWasKnown
        ? "Your account session ended. Sign in again when you want account features."
        : authentication.errorMessage
      rootState = accountWasKnown ? .accountEnded : .guest
      if !accountWasKnown {
        selectedTab = .account
      }
      return true
    case .serviceNotReady, .serviceUnavailable:
      routeUnavailableForLocalSolo(
        fallback: .serviceNotReady,
        message: "The online service is unavailable. Your local solo game remains available."
      )
      return true
    default:
      return false
    }
  }

  private func isOffline(_ error: any Error) -> Bool {
    if case .transport = error as? SkyjoHTTPClientError { return true }
    return false
  }

  private func isServiceUnavailable(_ error: any Error) -> Bool {
    guard case .server(_, let code, _) = error as? SkyjoHTTPClientError else { return false }
    return code == .serviceNotReady || code == .serviceUnavailable
  }

  private func userMessage(for error: any Error) -> String {
    if let error = error as? SkyjoHTTPClientError {
      return error.localizedDescription
    }
    return SkyjoHTTPClientError.safeFallbackMessage
  }

  var localSoloOwner: SoloOwnerPartition {
    if let user { return .account(user.id) }
    if case .offlineReady = rootState, let hintedID = preferences?.lastConfirmedAccountID {
      return .account(hintedID)
    }
    return .guest
  }

  var hasConfirmedAccountSession: Bool {
    rootState == .authenticated && user != nil
  }

  var confirmedStatsAccountID: UUID? {
    hasConfirmedAccountSession ? user?.id : nil
  }

  func presentAcceptedRoomInvite(_ hasAcceptedInvite: Bool) {
    guard hasAcceptedInvite, hasConfirmedAccountSession else { return }
    selectedTab = .home
  }

  func synchronizeLocalSolo(_ solo: SoloFeatureModel) async {
    switch rootState {
    case .guest, .authenticated, .offlineReady:
      await solo.switchOwner(
        localSoloOwner,
        confirmedAccountID: confirmedStatsAccountID
      )
    default:
      await solo.invalidateStatsAuthorization()
    }
  }

  func handleStatsAuthorizationInvalidation(_ invalidation: SessionInvalidationRelay.Invalidation) {
    guard rootState == .authenticated,
          user?.id == invalidation.authorizationFence.accountID
    else { return }
    if let sessionInvalidation {
      guard sessionInvalidation.pendingInvalidation == invalidation else { return }
    }
    let email = user?.email
    resetAccountState(prefillEmail: email)
    switch invalidation.reason {
    case .accessRequired:
      preferences?.clearConfirmedAccessAndAccount()
      authentication.errorMessage = ""
      rootState = .upgradeRequired
    case .accountSessionChanged:
      preferences?.confirmSignedOut()
      authentication.errorMessage = "Your account session changed. Sign in again to resume stats delivery."
      selectedTab = .account
      rootState = .guest
    }
  }

  private func routeUnavailableForLocalSolo(
    fallback: AppRootState,
    message: String
  ) {
    sessionInvalidation?.setConfirmedAccount(nil)
    guard preferences?.accessWasConfirmed == true else {
      rootState = fallback
      return
    }
    statsState = .offline(message: "Stats are unavailable while you are offline.")
    rootState = .offlineReady(message: message)
    localSessionGeneration &+= 1
  }
}

#if DEBUG
struct UITestStatsFixture {
  let summary: StatsSummary
  let game: StatsGame
  let player: PlayerStats

  static func make(
    gameID: String = "40000000-0000-4000-8000-000000000001"
  ) throws -> Self {
    let gameJSON = #"{"id":"40000000-0000-4000-8000-000000000001","mode":"multi","roomCode":"A1B2C","completedAt":1784998800000,"roundCount":1,"winnerPlayerId":"human-1","winnerName":"Fixture User","winnerUserId":"30000000-0000-4000-8000-000000000003","createdByUserId":"30000000-0000-4000-8000-000000000003","finishedByAi":false,"participants":[{"id":"40000000-0000-4000-8000-000000000002","userId":"30000000-0000-4000-8000-000000000003","playerId":"human-1","displayName":"Fixture User","kind":"human","rank":1,"roundScore":22,"totalScore":22,"won":true},{"id":"40000000-0000-4000-8000-000000000003","userId":"30000000-0000-4000-8000-000000000004","playerId":"human-2","displayName":"Other Player","kind":"human","rank":2,"roundScore":37,"totalScore":37,"won":false}],"rounds":[{"id":"40000000-0000-4000-8000-000000000004","round":1,"playerId":"human-1","userId":"30000000-0000-4000-8000-000000000003","displayName":"Fixture User","roundScore":22,"totalScore":22},{"id":"40000000-0000-4000-8000-000000000005","round":1,"playerId":"human-2","userId":"30000000-0000-4000-8000-000000000004","displayName":"Other Player","roundScore":37,"totalScore":37}]}"#
      .replacingOccurrences(
        of: "40000000-0000-4000-8000-000000000001",
        with: gameID
      )
    let summaryJSON = #"{"self":{"gamesPlayed":1,"wins":1,"multiplayerGames":1,"singlePlayerGames":0,"winRate":100,"averageTotalScore":22,"bestTotalScore":22},"coPlayers":[{"userId":"30000000-0000-4000-8000-000000000004","displayName":"Other Player","gamesTogether":1,"wins":0,"averageTotalScore":37,"latestAt":1784998800000}],"recentGames":["# + gameJSON + #"],"admin":null}"#
    let playerJSON = #"{"user":{"id":"30000000-0000-4000-8000-000000000004","email":"other.player@example.invalid","displayName":"Other Player","role":"player","disabled":false,"createdAt":1784998800000,"updatedAt":1784998800000,"lastLoginAt":null},"summary":{"gamesPlayed":1,"wins":0,"multiplayerGames":1,"singlePlayerGames":0,"winRate":0,"averageTotalScore":37,"bestTotalScore":37},"games":["# + gameJSON + #"]}"#
    let decoder = JSONDecoder()
    return try Self(
      summary: decoder.decode(StatsSummary.self, from: Data(summaryJSON.utf8)),
      game: decoder.decode(StatsGame.self, from: Data(gameJSON.utf8)),
      player: decoder.decode(PlayerStats.self, from: Data(playerJSON.utf8))
    )
  }
}
#endif
