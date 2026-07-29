import Foundation
import Observation
import SkyjoNetworking
import SkyjoPersistence
import SwiftData

@MainActor
@Observable
final class SessionInvalidationRelay {
  enum Reason: Equatable, Sendable {
    case accessRequired
    case accountSessionChanged
  }

  struct AuthorizationFence: Equatable, Sendable {
    let accountID: UUID
    let generation: UInt64
  }

  struct Invalidation: Equatable, Sendable {
    let reason: Reason
    let authorizationFence: AuthorizationFence
  }

  private(set) var generation = 0
  private(set) var pendingInvalidation: Invalidation?
  private var confirmedAccountID: UUID?
  private var authorizationGeneration: UInt64 = 0
  private let statsOutboxAuthorization: StatsOutboxAuthorizationController?

  init(statsOutboxAuthorization: StatsOutboxAuthorizationController? = nil) {
    self.statsOutboxAuthorization = statsOutboxAuthorization
  }

  func setConfirmedAccount(_ accountID: UUID?) {
    guard confirmedAccountID != accountID else { return }
    statsOutboxAuthorization?.setConfirmedAccount(accountID)
    confirmedAccountID = accountID
    authorizationGeneration &+= 1
    pendingInvalidation = nil
  }

  func authorizationFence(for accountID: UUID) -> AuthorizationFence? {
    guard confirmedAccountID == accountID else { return nil }
    return AuthorizationFence(accountID: accountID, generation: authorizationGeneration)
  }

  func invalidate(_ reason: Reason, ifCurrent fence: AuthorizationFence) {
    guard authorizationFence(for: fence.accountID) == fence else { return }
    statsOutboxAuthorization?.setConfirmedAccount(nil)
    confirmedAccountID = nil
    authorizationGeneration &+= 1
    pendingInvalidation = Invalidation(reason: reason, authorizationFence: fence)
    generation &+= 1
  }

  func consume(_ invalidation: Invalidation) {
    guard pendingInvalidation == invalidation else { return }
    pendingInvalidation = nil
  }
}

actor SoloStatsDeliveryAdapter {
  private let client: SkyjoAPIClient
  private let authorizationFence: @Sendable (
    UUID
  ) async -> SessionInvalidationRelay.AuthorizationFence?
  private let invalidateAuthorization: @Sendable (
    SessionInvalidationRelay.Reason,
    SessionInvalidationRelay.AuthorizationFence
  ) async -> Void

  init(
    client: SkyjoAPIClient,
    authorizationFence: @escaping @Sendable (
      UUID
    ) async -> SessionInvalidationRelay.AuthorizationFence?,
    invalidateAuthorization: @escaping @Sendable (
      SessionInvalidationRelay.Reason,
      SessionInvalidationRelay.AuthorizationFence
    ) async -> Void
  ) {
    self.client = client
    self.authorizationFence = authorizationFence
    self.invalidateAuthorization = invalidateAuthorization
  }

  func deliver(_ request: StatsSubmissionRequest) async throws {
    guard let gameID = UUID(uuidString: request.clientGameKey),
          request.clientGameKey == gameID.uuidString.lowercased(),
          let accountID = UUID(uuidString: request.expectedAccountUserId),
          request.expectedAccountUserId == accountID.uuidString.lowercased()
    else {
      throw StatsDeliveryError.permanent(.invalidPayload)
    }
    guard let fence = await authorizationFence(accountID) else {
      throw StatsDeliveryError.authorizationChanged
    }

    do {
      _ = try await client.submitSinglePlayerStats(
        SinglePlayerStatsSubmission(
          state: request.state,
          clientGameID: gameID,
          completedAt: request.completedAt,
          expectedAccountUserID: accountID
        )
      )
    } catch let error as SkyjoHTTPClientError {
      guard await authorizationFence(accountID) == fence else {
        throw StatsDeliveryError.authorizationChanged
      }
      let mappedError = await map(error, authorizationFence: fence)
      if mappedError != .authorizationChanged {
        guard await authorizationFence(accountID) == fence else {
          throw StatsDeliveryError.authorizationChanged
        }
      }
      throw mappedError
    } catch {
      guard await authorizationFence(accountID) == fence else {
        throw StatsDeliveryError.authorizationChanged
      }
      throw StatsDeliveryError.retryable(.transport)
    }

    guard await authorizationFence(accountID) == fence else {
      throw StatsDeliveryError.authorizationChanged
    }
  }

  private func map(
    _ error: SkyjoHTTPClientError,
    authorizationFence: SessionInvalidationRelay.AuthorizationFence
  ) async -> StatsDeliveryError {
    switch error {
    case .requestTooLarge:
      return .permanent(.requestTooLarge)
    case .unsupportedServerVersion:
      return .permanent(.unsupportedVersion)
    case .invalidHTTPResponse, .invalidSuccessPayload, .redirected, .responseTooLarge:
      return .permanent(.invalidPayload)
    case .transport:
      return .retryable(.transport)
    case .server(let statusCode, let code, _):
      if code == .accessRequired {
        await invalidateAuthorization(.accessRequired, authorizationFence)
        return .authorizationChanged
      }
      if code == .accountAuthenticationRequired || code == .accountSessionChanged {
        await invalidateAuthorization(.accountSessionChanged, authorizationFence)
        return .authorizationChanged
      }
      if code == .requestTooLarge {
        return .permanent(.requestTooLarge)
      }
      if code == .statsClientUpgradeRequired
        || code == .apiRouteNotFound
        || code == .methodNotAllowed
      {
        return .permanent(.unsupportedVersion)
      }
      if code == .invalidRequest
        || code == .expectedJSONObject
        || code == .invalidJSON
        || code == .unsupportedMediaType
        || code == .incompleteGame
        || code == .invalidCompletedAt
        || code == .missingHumanPlayer
      {
        return .permanent(.invalidPayload)
      }
      if code == .serviceNotReady || code == .serviceUnavailable {
        return .retryable(.unavailable)
      }
      if code == .requestFailed || statusCode >= 500 {
        return .retryable(.server)
      }
      // Unknown 4xx responses are not safe to retry forever with an immutable body.
      if (400..<500).contains(statusCode) {
        return .permanent(.invalidPayload)
      }
      return .retryable(.server)
    }
  }
}

@MainActor
final class AppDependencies {
  let apiClient: SkyjoAPIClient
  let inviteClient: RoomInviteClient
  let rooms: RoomAppCoordinator
  let preferences: SoloPreferencesStore
  let sessionInvalidation: SessionInvalidationRelay
  let persistenceStore: SoloPersistenceStore
  let statsOutbox: StatsOutboxCoordinator
  let feedback: GameFeedbackController
  let solo: SoloFeatureModel
  let persistenceWarning: SoloPersistenceWarning?

  init(configuration: AppConfiguration, defaults: UserDefaults = .standard) throws {
    preferences = SoloPreferencesStore(defaults: defaults)
    let statsOutboxAuthorization = StatsOutboxAuthorizationController()
    sessionInvalidation = SessionInvalidationRelay(
      statsOutboxAuthorization: statsOutboxAuthorization
    )
    let networkEnvironment = SkyjoNetworkEnvironment(baseURL: configuration.apiBaseURL)
    let cookieStorage = HTTPCookieStorage.shared
    let apiClient = SkyjoAPIClient(
      environment: networkEnvironment,
      persistentCookieStorage: cookieStorage
    )
    self.apiClient = apiClient
    let inviteClient = RoomInviteClient(
      environment: networkEnvironment,
      persistentCookieStorage: cookieStorage
    )
    self.inviteClient = inviteClient
#if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--ui-open-room-invite") {
      rooms = RoomAppCoordinator(
        inviteHandoff: RoomInviteCoordinator { _ in
          try RedeemedRoomInvite(
            roomCode: "ABCDE",
            expiresAt: 2_000_000_000_000
          )
        },
        makeSessionHost: { account in
          RoomSessionHost(account: account) { nextAccount in
            RoomSessionModel(
              account: nextAccount,
              environment: RoomSessionEnvironment(
                makeConnection: { throw RoomUITestFixtureError.connectionUnavailable },
                createInvite: { _ in throw RoomUITestFixtureError.connectionUnavailable },
                seatStore: VolatileRoomSeatRecoveryStore(),
                nowMilliseconds: { 1_900_000_000_000 }
              )
            )
          }
        }
      )
    } else {
      rooms = RoomAppCoordinator(apiClient: apiClient, inviteClient: inviteClient)
    }
#else
    rooms = RoomAppCoordinator(apiClient: apiClient, inviteClient: inviteClient)
#endif

    let container: ModelContainer
    var initialWarning: SoloPersistenceWarning?
    let persistenceIsDurable: Bool
#if DEBUG
    let usesSoloUITestFixture = ProcessInfo.processInfo.arguments.contains {
      $0.hasPrefix("--ui-state=solo-")
    }
    let usesVolatileUITestFixture = ProcessInfo.processInfo.arguments.contains(
      "--ui-state=solo-launcher-volatile"
    )
#else
    let usesSoloUITestFixture = false
    let usesVolatileUITestFixture = false
#endif
    if usesSoloUITestFixture {
      // UI fixtures still exercise normal owner synchronization, but must not inherit
      // an earlier simulator run's durable sessions or stats-delivery queue.
      container = try SkyjoPersistenceContainer.makeInMemory()
      persistenceIsDurable = !usesVolatileUITestFixture
      initialWarning = usesVolatileUITestFixture
        ? SoloPersistenceWarning(
          kind: .unavailable,
          message: "Saved games are unavailable on this device right now. This session can continue, but it is temporary."
        )
        : nil
    } else {
      do {
        let fileManager = FileManager.default
        let supportRoot = try fileManager.url(
          for: .applicationSupportDirectory,
          in: .userDomainMask,
          appropriateFor: nil,
          create: true
        )
        let directory = supportRoot.appending(path: "SkyjoNative", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        container = try SkyjoPersistenceContainer.make(
          at: directory.appending(path: "solo-v2.sqlite")
        )
        persistenceIsDurable = true
        initialWarning = nil
      } catch {
        container = try SkyjoPersistenceContainer.makeInMemory()
        persistenceIsDurable = false
        initialWarning = SoloPersistenceWarning(
          kind: .unavailable,
          message: "Saved games are unavailable on this device right now. This session can continue, but it is temporary."
        )
      }
    }
    persistenceWarning = initialWarning
    persistenceStore = SoloPersistenceStore(modelContainer: container)

    let relay = sessionInvalidation
    let deliveryAdapter = SoloStatsDeliveryAdapter(
      client: apiClient,
      authorizationFence: { accountID in
        await MainActor.run { relay.authorizationFence(for: accountID) }
      },
      invalidateAuthorization: { reason, fence in
        await MainActor.run { relay.invalidate(reason, ifCurrent: fence) }
      }
    )
    if usesSoloUITestFixture {
      statsOutbox = StatsOutboxCoordinator(
        store: persistenceStore,
        authorizationController: statsOutboxAuthorization
      ) { _ in }
    } else {
      statsOutbox = StatsOutboxCoordinator(
        store: persistenceStore,
        authorizationController: statsOutboxAuthorization
      ) { request in
        try await deliveryAdapter.deliver(request)
      }
    }
    feedback = GameFeedbackController(preferences: preferences)
    solo = SoloFeatureModel(
      store: persistenceStore,
      statsOutbox: statsOutbox,
      preferences: preferences,
      feedback: feedback,
      initialWarning: initialWarning,
      persistenceIsDurable: persistenceIsDurable
    )
  }
}

#if DEBUG
private enum RoomUITestFixtureError: Error {
  case connectionUnavailable
}
#endif
