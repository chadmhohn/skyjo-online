import Foundation
import SkyjoNetworking
import Testing

@testable import SkyjoNative

@Suite("Native app state and navigation", .serialized)
@MainActor
struct AppModelTests {
  @Test("Bootstrap routes access, account, and authenticated empty states")
  func bootstrapRoutes() async {
    let accessModel = makeModel(scenario: .accessRequired)
    await accessModel.bootstrap()
    #expect(accessModel.rootState == .accessRequired)

    let accountModel = makeModel(scenario: .accountRequired)
    await accountModel.bootstrap()
    #expect(accountModel.rootState == .accountRequired)

    let authenticatedModel = makeModel(scenario: .normal)
    await authenticatedModel.bootstrap()
    #expect(authenticatedModel.rootState == .authenticated)
    #expect(authenticatedModel.user?.displayName == "Native Player")
    #expect(authenticatedModel.statsState == .empty)
  }

  @Test("Loaded stats navigate through game and player detail and retry after offline")
  func loadedStatsAndOfflineRetry() async throws {
    let loadedModel = makeModel(scenario: .loadedStats)
    await loadedModel.bootstrap()
    #expect(loadedModel.rootState == .authenticated)
    #expect(loadedModel.statsState == .loaded)
    #expect(loadedModel.statsSummary?.`self`.gamesPlayed == 1)
    let game = try #require(loadedModel.games.first)
    #expect(game.participants.count == 2)

    await loadedModel.loadGame(id: game.id)
    #expect(loadedModel.gameDetailState == .loaded(game))

    let otherUserID = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000004"))
    await loadedModel.loadPlayerHistory(userID: otherUserID)
    guard case .loaded(let history) = loadedModel.playerHistoryState else {
      Issue.record("Expected a successful player-history state.")
      return
    }
    #expect(history.user.id == otherUserID)
    #expect(history.games.map(\.id) == [game.id])

    let retryModel = makeModel(scenario: .statsOfflineRetry)
    await retryModel.bootstrap()
    #expect(retryModel.rootState == .authenticated)
    #expect(
      retryModel.statsState
        == .offline(message: "Stats are unavailable while you are offline.")
    )
    #expect(retryModel.statsSummary == nil)
    #expect(retryModel.games.isEmpty)

    await retryModel.loadStats()
    #expect(retryModel.statsState == .loaded)
    #expect(retryModel.statsSummary?.`self`.gamesPlayed == 1)
    #expect(retryModel.games.map(\.id) == [game.id])
  }

  @Test("Not-ready, offline, disabled, and expired sessions recover safely")
  func recoveryStates() async {
    let notReadyModel = makeModel(scenario: .notReady)
    await notReadyModel.bootstrap()
    #expect(notReadyModel.rootState == .serviceNotReady)

    let upgradeModel = makeModel(scenario: .upgradeRequired)
    await upgradeModel.bootstrap()
    #expect(upgradeModel.rootState == .upgradeRequired)

    let offlineModel = makeModel(scenario: .offline)
    await offlineModel.bootstrap()
    guard case .offline = offlineModel.rootState else {
      Issue.record("Expected an offline root state.")
      return
    }

    let disabledModel = makeModel(scenario: .disabled)
    await disabledModel.bootstrap()
    #expect(disabledModel.rootState == .accountEnded)

    let expiredModel = makeModel(scenario: .statsExpired)
    await expiredModel.bootstrap()
    #expect(expiredModel.rootState == .accountEnded)
    #expect(expiredModel.user == nil)

    let accessFollowupModel = makeModel(scenario: .accessFollowupOffline)
    accessFollowupModel.rootState = .accessRequired
    accessFollowupModel.access.password = "synthetic-access-value"
    await accessFollowupModel.submitAccess()
    guard case .offline = accessFollowupModel.rootState else {
      Issue.record("Expected the post-access account check to expose a retryable offline state.")
      return
    }
  }

  @Test("Unknown server detail stays hidden and forms disable invalid actions")
  func safeFallbackAndDisabledActions() async {
    let model = makeModel(scenario: .unknownAccessError)
    #expect(!model.access.canSubmit)
    model.access.password = "synthetic-access-value"
    #expect(model.access.canSubmit)
    await model.submitAccess()
    #expect(model.access.errorMessage == SkyjoHTTPClientError.safeFallbackMessage)
    #expect(model.access.password.isEmpty)

    model.authentication.mode = .signup
    model.authentication.email = "native@example.invalid"
    model.authentication.displayName = "Native Player"
    model.authentication.password = "password-one"
    model.authentication.confirmPassword = "password-two"
    #expect(!model.authentication.canSubmit)
    model.authentication.confirmPassword = "password-one"
    #expect(model.authentication.canSubmit)

    model.accountSettings.displayName = ""
    #expect(!model.accountSettings.canSaveProfile)
    model.accountSettings.currentPassword = "old-password"
    model.accountSettings.password = "new-password"
    model.accountSettings.confirmPassword = "different-password"
    #expect(!model.accountSettings.canChangePassword)
    model.accountSettings.currentPassword = String(repeating: "x", count: 1_025)
    model.accountSettings.password = "new-password"
    model.accountSettings.confirmPassword = "new-password"
    #expect(!model.accountSettings.canChangePassword)
  }

  @Test("Form length guards use Unicode code-point boundaries")
  func formLengthGuardsUseUnicodeScalars() {
    func composed(_ scalarCount: Int) -> String {
      "x" + String(repeating: "\u{0301}", count: scalarCount - 1)
    }

    let access = AccessFormModel()
    access.password = composed(4_096)
    #expect(access.canSubmit)
    access.password = composed(4_097)
    #expect(!access.canSubmit)

    let authentication = AuthenticationFormModel()
    let maximumEmail = composed(249) + "@b.co"
    let oversizedEmail = composed(250) + "@b.co"
    #expect(maximumEmail.unicodeScalars.count == 254)
    #expect(oversizedEmail.unicodeScalars.count == 255)
    authentication.email = maximumEmail
    authentication.password = composed(8)
    #expect(authentication.canSubmit)
    authentication.email = composed(3)
    #expect(authentication.canSubmit)
    authentication.email = composed(2)
    #expect(!authentication.canSubmit)
    authentication.email = oversizedEmail
    #expect(!authentication.canSubmit)
    authentication.email = maximumEmail
    authentication.password = composed(7)
    #expect(!authentication.canSubmit)
    authentication.password = composed(1_024)
    #expect(authentication.canSubmit)
    authentication.password = composed(1_025)
    #expect(!authentication.canSubmit)

    authentication.mode = .signup
    authentication.password = composed(8)
    authentication.confirmPassword = authentication.password
    authentication.displayName = composed(24)
    #expect(authentication.canSubmit)
    authentication.displayName = composed(25)
    #expect(!authentication.canSubmit)

    let account = AccountSettingsFormModel()
    account.displayName = composed(24)
    #expect(account.canSaveProfile)
    account.displayName = composed(25)
    #expect(!account.canSaveProfile)
    account.currentPassword = composed(1_024)
    account.password = composed(8)
    account.confirmPassword = account.password
    #expect(account.canChangePassword)
    account.currentPassword = composed(1_025)
    #expect(!account.canChangePassword)
    account.currentPassword = composed(1)
    account.password = composed(7)
    account.confirmPassword = account.password
    #expect(!account.canChangePassword)
    account.password = composed(1_024)
    account.confirmPassword = account.password
    #expect(account.canChangePassword)
    account.password = composed(1_025)
    account.confirmPassword = account.password
    #expect(!account.canChangePassword)
  }

  @Test("Password confirmation preserves exact Unicode scalar sequences")
  func passwordConfirmationUsesExactUnicodeScalars() {
    let precomposed = "password-\u{00E9}"
    let decomposed = "password-e\u{0301}"
    #expect(precomposed == decomposed)
    #expect(!precomposed.unicodeScalars.elementsEqual(decomposed.unicodeScalars))

    let authentication = AuthenticationFormModel()
    authentication.mode = .signup
    authentication.email = "native@example.invalid"
    authentication.displayName = "Native Player"
    authentication.password = precomposed
    authentication.confirmPassword = decomposed
    #expect(!authentication.canSubmit)
    authentication.confirmPassword = precomposed
    #expect(authentication.canSubmit)

    let account = AccountSettingsFormModel()
    account.currentPassword = "current-password"
    account.password = precomposed
    account.confirmPassword = decomposed
    #expect(!account.canChangePassword)
    account.confirmPassword = precomposed
    #expect(account.canChangePassword)
  }

  @Test("Profile, password, and logout actions update navigation without retaining passwords")
  func accountActions() async {
    let profileModel = makeModel(scenario: .normal)
    await profileModel.bootstrap()
    profileModel.accountSettings.displayName = "Native Prime"
    await profileModel.updateProfile()
    #expect(profileModel.user?.displayName == "Native Prime")
    #expect(profileModel.accountSettings.profileMessage == "Profile updated.")

    profileModel.accountSettings.currentPassword = "old-password"
    profileModel.accountSettings.password = "new-password"
    profileModel.accountSettings.confirmPassword = "new-password"
    profileModel.selectedTab = .account
    await profileModel.changePassword()
    #expect(profileModel.rootState == .accountRequired)
    #expect(profileModel.selectedTab == .home)
    #expect(profileModel.accountSettings.currentPassword.isEmpty)
    #expect(profileModel.accountSettings.password.isEmpty)
    #expect(profileModel.authentication.email == "native@example.invalid")
    #expect(profileModel.authentication.errorMessage.contains("Password changed"))

    let logoutModel = makeModel(scenario: .normal)
    await logoutModel.bootstrap()
    logoutModel.selectedTab = .account
    await logoutModel.logoutAccount()
    #expect(logoutModel.rootState == .accountRequired)
    #expect(logoutModel.selectedTab == .home)
    #expect(logoutModel.user == nil)
  }

  @Test("A disabled profile response ends the account session and clears stale state")
  func disabledProfileUpdateEndsSession() async {
    let model = makeModel(scenario: .disabledProfileUpdate)
    await model.bootstrap()
    model.selectedTab = .account
    model.accountSettings.displayName = "Native Prime"

    await model.updateProfile()

    #expect(model.rootState == .accountEnded)
    #expect(model.user == nil)
    #expect(model.selectedTab == .home)
    #expect(model.statsState == .idle)
    #expect(model.authentication.email == "native@example.invalid")
    #expect(!model.accountSettings.isSavingProfile)
    #expect(model.accountSettings.profileMessage.isEmpty)
  }

  @Test("Account-not-found during password change ends only the active account session")
  func passwordChangeAccountNotFoundEndsSession() async {
    let model = makeModel(scenario: .passwordAccountNotFound)
    await model.bootstrap()
    model.selectedTab = .account
    model.accountSettings.currentPassword = "old-password"
    model.accountSettings.password = "new-password"
    model.accountSettings.confirmPassword = "new-password"

    await model.changePassword()

    #expect(model.rootState == .accountEnded)
    #expect(model.user == nil)
    #expect(model.selectedTab == .home)
    #expect(model.statsState == .idle)
    #expect(model.authentication.email == "native@example.invalid")
    #expect(model.accountSettings.currentPassword.isEmpty)
    #expect(model.accountSettings.password.isEmpty)
    #expect(model.accountSettings.confirmPassword.isEmpty)
  }

  @Test("The shared access password clears before account follow-up completes")
  func accessPasswordClearsBeforeFollowup() async {
    let service = MockSkyjoService(scenario: .deferredAccessFollowup)
    let model = AppModel(
      service: service,
      baseURL: URL(string: "https://skyjo.example.invalid")!
    )
    model.rootState = .accessRequired
    model.access.password = "synthetic-access-value"

    let submitTask = Task { await model.submitAccess() }
    for _ in 0..<100 where !(await service.hasPendingCurrentAccountRequest()) {
      try? await Task.sleep(for: .milliseconds(5))
    }

    #expect(await service.hasPendingCurrentAccountRequest())
    #expect(model.access.password.isEmpty)
    #expect(model.access.isSubmitting)
    await service.completePendingCurrentAccount()
    await submitTask.value
    #expect(model.rootState == .accountRequired)
    #expect(!model.access.isSubmitting)
  }

  @Test("Stale account requests cannot repopulate state after sign out")
  func staleProfileCompletionIsIgnored() async {
    let service = MockSkyjoService(scenario: .deferredProfile)
    let model = AppModel(
      service: service,
      baseURL: URL(string: "https://skyjo.example.invalid")!
    )
    await model.bootstrap()
    model.accountSettings.displayName = "Old request"

    let profileTask = Task { await model.updateProfile() }
    for _ in 0..<100 where !(await service.hasPendingProfileRequest()) {
      try? await Task.sleep(for: .milliseconds(5))
    }
    #expect(await service.hasPendingProfileRequest())

    await model.logoutAccount()
    #expect(model.rootState == .accountRequired)
    await service.completePendingProfile(displayName: "Stale profile")
    await profileTask.value

    #expect(model.rootState == .accountRequired)
    #expect(model.user == nil)
    #expect(model.accountSettings.profileMessage.isEmpty)
  }

  @Test("Loaded stats stay mounted and stale refresh completion stays fenced")
  func loadedStatsRefreshLifecycle() async throws {
    let service = MockSkyjoService(scenario: .deferredStatsRefresh)
    let model = AppModel(
      service: service,
      baseURL: URL(string: "https://skyjo.example.invalid")!
    )
    await model.bootstrap()
    let originalGameIDs = model.games.map(\.id)

    #expect(model.statsState == .loaded)
    #expect(!model.isRefreshingStats)
    #expect(!originalGameIDs.isEmpty)

    let firstRefresh = Task { await model.loadStats() }
    for _ in 0..<100 where await service.pendingStatsRefreshCount() < 1 {
      try? await Task.sleep(for: .milliseconds(5))
    }

    #expect(await service.pendingStatsRefreshCount() == 1)
    #expect(model.statsState == .loaded)
    #expect(model.isRefreshingStats)
    #expect(model.games.map(\.id) == originalGameIDs)

    let secondRefresh = Task { await model.loadStats() }
    for _ in 0..<100 where await service.pendingStatsRefreshCount() < 2 {
      try? await Task.sleep(for: .milliseconds(5))
    }

    #expect(await service.pendingStatsRefreshCount() == 2)
    await service.completeOldestStatsRefresh()
    await firstRefresh.value

    #expect(model.statsState == .loaded)
    #expect(model.isRefreshingStats)
    #expect(model.games.map(\.id) == originalGameIDs)

    await service.completeOldestStatsRefresh()
    await secondRefresh.value

    #expect(model.statsState == .loaded)
    #expect(!model.isRefreshingStats)
    #expect(model.games.map(\.id) == originalGameIDs)
  }

  @Test("Mismatched account and detail payload identities fail visibly")
  func mismatchedResponseIdentities() async throws {
    let model = makeModel(scenario: .mismatchedIdentifiers)
    await model.bootstrap()

    model.accountSettings.displayName = "Native Prime"
    await model.updateProfile()
    #expect(model.accountSettings.profileMessage == "The server returned an invalid response.")

    let requestedGameID = try #require(UUID(uuidString: "40000000-0000-4000-8000-000000000001"))
    await model.loadGame(id: requestedGameID)
    #expect(model.gameDetailState == .failed(message: "The server returned an invalid response."))

    let requestedPlayerID = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000003"))
    await model.loadPlayerHistory(userID: requestedPlayerID)
    #expect(model.playerHistoryState == .failed(message: "The server returned an invalid response."))
  }

  private func makeModel(scenario: MockSkyjoService.Scenario) -> AppModel {
    AppModel(
      service: MockSkyjoService(scenario: scenario),
      baseURL: URL(string: "https://skyjo.example.invalid")!
    )
  }
}

private actor MockSkyjoService: SkyjoService {
  enum Scenario: Equatable, Sendable {
    case normal
    case accessRequired
    case accountRequired
    case notReady
    case offline
    case disabled
    case statsExpired
    case loadedStats
    case statsOfflineRetry
    case unknownAccessError
    case accessFollowupOffline
    case upgradeRequired
    case deferredProfile
    case deferredAccessFollowup
    case deferredStatsRefresh
    case disabledProfileUpdate
    case passwordAccountNotFound
    case mismatchedIdentifiers
  }

  let scenario: Scenario
  private var pendingProfileContinuation: CheckedContinuation<AccountUser, Never>?
  private var pendingCurrentAccountContinuation: CheckedContinuation<AccountUser?, Never>?
  private var pendingStatsRefreshContinuations: [CheckedContinuation<Void, Never>] = []
  private var statsSummaryRequestCount = 0

  init(scenario: Scenario) {
    self.scenario = scenario
  }

  func readiness() async throws -> ServiceReadiness {
    if scenario == .offline {
      throw SkyjoHTTPClientError.transport(.notConnectedToInternet)
    }
    if scenario == .upgradeRequired {
      throw SkyjoHTTPClientError.unsupportedServerVersion
    }
    let status = scenario == .notReady ? "not_ready" : "ready"
    return try JSONDecoder().decode(
      ServiceReadiness.self,
      from: Data(
        "{\"status\":\"\(status)\",\"releaseSha\":\"development\",\"schemaVersion\":2,\"protocolVersion\":2,\"checks\":{\"database\":\"ok\",\"roomState\":\"ok\",\"lastPersist\":\"ok\"}}".utf8
      )
    )
  }

  func accessStatus() async throws -> AccessSessionStatus {
    AccessSessionStatus(authenticated: scenario != .accessRequired)
  }

  func loginAccess(password: String) async throws -> AccessSessionStatus {
    if scenario == .unknownAccessError {
      throw SkyjoHTTPClientError.server(
        statusCode: 500,
        code: SkyjoAPIErrorCode(rawValue: "FUTURE_PRIVATE_DETAIL"),
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    }
    return AccessSessionStatus(authenticated: true)
  }

  func currentAccount() async throws -> AccountUser? {
    if scenario == .accessFollowupOffline {
      throw SkyjoHTTPClientError.transport(.notConnectedToInternet)
    }
    if scenario == .deferredAccessFollowup {
      return await withCheckedContinuation { continuation in
        pendingCurrentAccountContinuation = continuation
      }
    }
    if scenario == .accountRequired { return nil }
    return makeUser(disabled: scenario == .disabled)
  }

  func hasPendingCurrentAccountRequest() -> Bool {
    pendingCurrentAccountContinuation != nil
  }

  func completePendingCurrentAccount() {
    pendingCurrentAccountContinuation?.resume(returning: nil)
    pendingCurrentAccountContinuation = nil
  }

  func signup(
    email: String,
    displayName: String,
    password: String,
    confirmPassword: String
  ) async throws -> AccountUser {
    return makeUser(displayName: displayName)
  }

  func loginAccount(email: String, password: String) async throws -> AccountUser {
    makeUser()
  }

  func logoutAccount() async throws {}

  func updateProfile(displayName: String) async throws -> AccountUser {
    if scenario == .deferredProfile {
      return await withCheckedContinuation { continuation in
        pendingProfileContinuation = continuation
      }
    }
    if scenario == .mismatchedIdentifiers {
      return makeUser(
        id: UUID(uuidString: "30000000-0000-4000-8000-000000000099")!,
        displayName: displayName
      )
    }
    if scenario == .disabledProfileUpdate {
      return makeUser(displayName: displayName, disabled: true)
    }
    return makeUser(displayName: displayName)
  }

  func hasPendingProfileRequest() -> Bool {
    pendingProfileContinuation != nil
  }

  func completePendingProfile(displayName: String) {
    pendingProfileContinuation?.resume(returning: makeUser(displayName: displayName))
    pendingProfileContinuation = nil
  }

  func changePassword(
    currentPassword: String,
    password: String,
    confirmPassword: String
  ) async throws {
    if scenario == .passwordAccountNotFound {
      throw SkyjoHTTPClientError.server(
        statusCode: 404,
        code: .accountNotFound,
        message: "Account not found."
      )
    }
  }

  func statsSummary() async throws -> StatsSummary {
    if scenario == .statsExpired {
      throw SkyjoHTTPClientError.server(
        statusCode: 401,
        code: .accountAuthenticationRequired,
        message: "Sign in to your Skyjo account."
      )
    }
    if scenario == .statsOfflineRetry {
      statsSummaryRequestCount += 1
      if statsSummaryRequestCount == 1 {
        throw SkyjoHTTPClientError.transport(.notConnectedToInternet)
      }
    }
    if scenario == .deferredStatsRefresh {
      statsSummaryRequestCount += 1
      if statsSummaryRequestCount > 1 {
        await withCheckedContinuation { continuation in
          pendingStatsRefreshContinuations.append(continuation)
        }
      }
    }
    if scenario == .loadedStats || scenario == .statsOfflineRetry || scenario == .deferredStatsRefresh {
      return try UITestStatsFixture.make().summary
    }
    return try JSONDecoder().decode(
      StatsSummary.self,
      from: Data(
        #"{"self":{"gamesPlayed":0,"wins":0,"multiplayerGames":0,"singlePlayerGames":0,"winRate":0,"averageTotalScore":0,"bestTotalScore":null},"coPlayers":[],"recentGames":[],"admin":null}"#.utf8
      )
    )
  }

  func statsGames() async throws -> [StatsGame] {
    if scenario == .statsExpired {
      throw SkyjoHTTPClientError.server(
        statusCode: 401,
        code: .accountAuthenticationRequired,
        message: "Sign in to your Skyjo account."
      )
    }
    if scenario == .loadedStats || scenario == .statsOfflineRetry || scenario == .deferredStatsRefresh {
      return [try UITestStatsFixture.make().game]
    }
    return []
  }

  func pendingStatsRefreshCount() -> Int {
    pendingStatsRefreshContinuations.count
  }

  func completeOldestStatsRefresh() {
    guard !pendingStatsRefreshContinuations.isEmpty else { return }
    pendingStatsRefreshContinuations.removeFirst().resume()
  }

  func statsGame(id: UUID) async throws -> StatsGame {
    if scenario == .mismatchedIdentifiers {
      return try UITestStatsFixture.make(
        gameID: "40000000-0000-4000-8000-000000000099"
      ).game
    }
    if scenario == .loadedStats || scenario == .statsOfflineRetry {
      return try UITestStatsFixture.make().game
    }
    throw SkyjoHTTPClientError.server(statusCode: 404, code: .gameNotFound, message: "Game not found.")
  }

  func playerStats(userID: UUID) async throws -> PlayerStats {
    if scenario == .mismatchedIdentifiers {
      return try JSONDecoder().decode(
        PlayerStats.self,
        from: Data(
          #"{"user":{"id":"30000000-0000-4000-8000-000000000099","email":"other@example.invalid","displayName":"Other Player","role":"player","disabled":false,"createdAt":1784998800104,"updatedAt":1784998800104,"lastLoginAt":null},"summary":{"gamesPlayed":0,"wins":0,"multiplayerGames":0,"singlePlayerGames":0,"winRate":0,"averageTotalScore":0,"bestTotalScore":null},"games":[]}"#.utf8
        )
      )
    }
    if scenario == .loadedStats || scenario == .statsOfflineRetry {
      return try UITestStatsFixture.make().player
    }
    throw SkyjoHTTPClientError.server(statusCode: 404, code: .playerNotFound, message: "Player not found.")
  }

  private func makeUser(
    id: UUID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!,
    displayName: String = "Native Player",
    disabled: Bool = false
  ) -> AccountUser {
    AccountUser(
      id: id,
      email: "native@example.invalid",
      displayName: displayName,
      role: .player,
      disabled: disabled,
      createdAt: 1_784_998_800_104,
      updatedAt: 1_784_998_800_104,
      lastLoginAt: nil
    )
  }
}
