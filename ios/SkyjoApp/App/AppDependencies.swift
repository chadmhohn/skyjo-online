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

  private(set) var generation = 0
  private(set) var reason = Reason.accountSessionChanged

  func invalidate(_ reason: Reason) {
    self.reason = reason
    generation &+= 1
  }
}

actor SoloStatsDeliveryAdapter {
  private let client: SkyjoAPIClient
  private let invalidateAuthorization: @Sendable (SessionInvalidationRelay.Reason) async -> Void

  init(
    client: SkyjoAPIClient,
    invalidateAuthorization: @escaping @Sendable (SessionInvalidationRelay.Reason) async -> Void
  ) {
    self.client = client
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
      throw await map(error)
    } catch {
      throw StatsDeliveryError.retryable(.transport)
    }
  }

  private func map(_ error: SkyjoHTTPClientError) async -> StatsDeliveryError {
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
        await invalidateAuthorization(.accessRequired)
        return .authorizationChanged
      }
      if code == .accountAuthenticationRequired || code == .accountSessionChanged {
        await invalidateAuthorization(.accountSessionChanged)
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
  let preferences: SoloPreferencesStore
  let sessionInvalidation: SessionInvalidationRelay
  let persistenceStore: SoloPersistenceStore
  let statsOutbox: StatsOutboxCoordinator
  let feedback: GameFeedbackController
  let solo: SoloFeatureModel
  let persistenceWarning: SoloPersistenceWarning?

  init(configuration: AppConfiguration, defaults: UserDefaults = .standard) throws {
    preferences = SoloPreferencesStore(defaults: defaults)
    sessionInvalidation = SessionInvalidationRelay()
    let networkEnvironment = SkyjoNetworkEnvironment(baseURL: configuration.apiBaseURL)
    apiClient = SkyjoAPIClient(
      environment: networkEnvironment,
      persistentCookieStorage: .shared
    )

    let container: ModelContainer
    var initialWarning: SoloPersistenceWarning?
#if DEBUG
    let usesSoloUITestFixture = ProcessInfo.processInfo.arguments.contains {
      $0.hasPrefix("--ui-state=solo-")
    }
#else
    let usesSoloUITestFixture = false
#endif
    if usesSoloUITestFixture {
      // UI fixtures still exercise normal owner synchronization, but must not inherit
      // an earlier simulator run's durable sessions or stats-delivery queue.
      container = try SkyjoPersistenceContainer.makeInMemory()
      initialWarning = nil
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
        initialWarning = nil
      } catch {
        container = try SkyjoPersistenceContainer.makeInMemory()
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
      invalidateAuthorization: { reason in
        await MainActor.run { relay.invalidate(reason) }
      }
    )
    statsOutbox = StatsOutboxCoordinator(store: persistenceStore) { request in
      try await deliveryAdapter.deliver(request)
    }
    feedback = GameFeedbackController(preferences: preferences)
    solo = SoloFeatureModel(
      store: persistenceStore,
      statsOutbox: statsOutbox,
      preferences: preferences,
      feedback: feedback,
      initialWarning: initialWarning
    )
  }
}
