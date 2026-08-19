import Foundation
import Observation
import SkyjoNetworking
import UIKit
@preconcurrency import UserNotifications

enum NativeNotificationAuthorizationStatus: Equatable, Sendable {
  case notDetermined
  case denied
  case authorized
}

struct NativeNotificationRoute: Equatable, Sendable {
  let roomCode: String

  init?(userInfo: [AnyHashable: Any]) {
    guard
      userInfo["version"] as? Int == 1,
      let kind = userInfo["kind"] as? String,
      ["turn", "round-ended", "game-ended"].contains(kind),
      userInfo["route"] as? String == "room",
      let roomCode = userInfo["roomCode"] as? String,
      roomCode.utf8.count == 5,
      roomCode.utf8.allSatisfy({ byte in
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte)
      })
    else { return nil }
    self.roomCode = roomCode
  }
}

@MainActor
struct NativeNotificationSystemHandlers {
  let didRegister: (Data) -> Void
  let didFailRegistration: () -> Void
  let didOpenRoute: (NativeNotificationRoute) -> Void
}

@MainActor
protocol NativeNotificationOperatingSystem: AnyObject {
  func install(_ handlers: NativeNotificationSystemHandlers)
  func authorizationStatus() async -> NativeNotificationAuthorizationStatus
  func requestAuthorization() async throws -> Bool
  func registerForRemoteNotifications()
  func unregisterForRemoteNotifications()
  func openSettings()
}

@MainActor
final class SkyjoAppDelegate: NSObject, UIApplicationDelegate,
  UNUserNotificationCenterDelegate, NativeNotificationOperatingSystem
{
  private var handlers: NativeNotificationSystemHandlers?
  private var pendingDeviceToken: Data?
  private var registrationFailedBeforeInstall = false
  private var pendingRoute: NativeNotificationRoute?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func install(_ handlers: NativeNotificationSystemHandlers) {
    self.handlers = handlers
    if let pendingDeviceToken {
      self.pendingDeviceToken = nil
      handlers.didRegister(pendingDeviceToken)
    }
    if registrationFailedBeforeInstall {
      registrationFailedBeforeInstall = false
      handlers.didFailRegistration()
    }
    if let pendingRoute {
      self.pendingRoute = nil
      handlers.didOpenRoute(pendingRoute)
    }
  }

  func authorizationStatus() async -> NativeNotificationAuthorizationStatus {
    switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
    case .notDetermined:
      return .notDetermined
    case .denied:
      return .denied
    case .authorized, .provisional, .ephemeral:
      return .authorized
    @unknown default:
      return .denied
    }
  }

  func requestAuthorization() async throws -> Bool {
    try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
  }

  func registerForRemoteNotifications() {
    UIApplication.shared.registerForRemoteNotifications()
  }

  func unregisterForRemoteNotifications() {
    UIApplication.shared.unregisterForRemoteNotifications()
  }

  func openSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    guard let handlers else {
      pendingDeviceToken = deviceToken
      return
    }
    handlers.didRegister(deviceToken)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: any Error
  ) {
    guard let handlers else {
      registrationFailedBeforeInstall = true
      return
    }
    handlers.didFailRegistration()
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    // The realtime room already owns visible foreground feedback.
    []
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    guard let route = NativeNotificationRoute(
      userInfo: response.notification.request.content.userInfo
    ) else { return }
    await MainActor.run { deliver(route: route) }
  }

  private func deliver(route: NativeNotificationRoute) {
    guard let handlers else {
      pendingRoute = route
      return
    }
    handlers.didOpenRoute(route)
  }
}

protocol NativeNotificationService: Sendable {
  func apnsConfiguration() async throws -> APNSConfiguration
  func registerAPNSDevice(
    installationID: UUID,
    deviceToken: String,
    environment: APNSDeviceEnvironment,
    appVersion: String,
    locale: String
  ) async throws
  func deleteAPNSDevice(installationID: UUID) async throws
}

extension SkyjoAPIClient: NativeNotificationService {}

enum NativeNotificationState: Equatable {
  case off
  case checking
  case enabled
  case denied
  case unavailable
  case failed
}

@MainActor
@Observable
final class NativeNotificationCoordinator {
  private static let installationIDKey = "skyjo.apns.installation-id.v1"
  private static let enabledKey = "skyjo.apns.enabled.v1"

  @ObservationIgnored private let service: any NativeNotificationService
  @ObservationIgnored private let operatingSystem: any NativeNotificationOperatingSystem
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let environment: APNSDeviceEnvironment
  @ObservationIgnored private let appVersion: String
  @ObservationIgnored private let locale: String

  private(set) var state = NativeNotificationState.off
  private(set) var isWorking = false
  private(set) var pendingRoomRoute: NativeNotificationRoute?
  private(set) var routeGeneration = 0
  private(set) var wantsNotifications: Bool
  let installationID: UUID

  private var deviceToken: String?
  private var accountID: UUID?
  private var accountGeneration: UInt64 = 0

  init(
    service: any NativeNotificationService,
    operatingSystem: any NativeNotificationOperatingSystem,
    defaults: UserDefaults,
    environment: APNSDeviceEnvironment = NativeNotificationCoordinator.defaultEnvironment,
    appVersion: String = NativeNotificationCoordinator.bundleAppVersion,
    locale: String = Locale.current.identifier
  ) {
    self.service = service
    self.operatingSystem = operatingSystem
    self.defaults = defaults
    self.environment = environment
    self.appVersion = Self.boundedMetadata(appVersion, fallback: "0")
    self.locale = Self.boundedMetadata(locale, fallback: "und")
    installationID = Self.loadInstallationID(defaults: defaults)
    wantsNotifications = defaults.bool(forKey: Self.enabledKey)

    operatingSystem.install(
      NativeNotificationSystemHandlers(
        didRegister: { [weak self] token in self?.didRegister(deviceToken: token) },
        didFailRegistration: { [weak self] in self?.didFailRegistration() },
        didOpenRoute: { [weak self] route in self?.didOpen(route: route) }
      )
    )
  }

  func synchronize(account: AccountUser?) async {
    let nextAccountID = account?.id
    if accountID != nextAccountID {
      accountID = nextAccountID
      accountGeneration &+= 1
    }

    guard accountID != nil else {
      operatingSystem.unregisterForRemoteNotifications()
      deviceToken = nil
      state = .off
      isWorking = false
      return
    }
    guard wantsNotifications else {
      state = .off
      return
    }
    await activate(requestPermission: false)
  }

  func enable() async {
    guard accountID != nil, !isWorking else { return }
    wantsNotifications = true
    defaults.set(true, forKey: Self.enabledKey)
    await activate(requestPermission: true)
  }

  func disable() async {
    guard !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      if accountID != nil {
        try await service.deleteAPNSDevice(installationID: installationID)
      }
      wantsNotifications = false
      defaults.set(false, forKey: Self.enabledKey)
      deviceToken = nil
      operatingSystem.unregisterForRemoteNotifications()
      state = .off
    } catch {
      state = .failed
    }
  }

  func retry() async {
    guard wantsNotifications else {
      await enable()
      return
    }
    await activate(requestPermission: false)
  }

  func openSettings() {
    operatingSystem.openSettings()
  }

  func consumePendingRoomRoute() {
    pendingRoomRoute = nil
  }

  private func activate(requestPermission: Bool) async {
    guard let expectedAccountID = accountID, !isWorking else { return }
    let expectedGeneration = accountGeneration
    isWorking = true
    state = .checking
    defer { isWorking = false }

    do {
      var authorization = await operatingSystem.authorizationStatus()
      if authorization == .notDetermined, requestPermission {
        authorization = try await operatingSystem.requestAuthorization()
          ? .authorized
          : .denied
      }
      guard isCurrentAccount(expectedAccountID, generation: expectedGeneration) else { return }
      switch authorization {
      case .notDetermined:
        state = .off
        return
      case .denied:
        state = .denied
        return
      case .authorized:
        break
      }

      let configuration = try await service.apnsConfiguration()
      guard isCurrentAccount(expectedAccountID, generation: expectedGeneration) else { return }
      guard configuration.enabled else {
        state = .unavailable
        return
      }
      operatingSystem.registerForRemoteNotifications()
      if let deviceToken {
        try await register(
          deviceToken: deviceToken,
          accountID: expectedAccountID,
          generation: expectedGeneration
        )
      }
    } catch {
      guard isCurrentAccount(expectedAccountID, generation: expectedGeneration) else { return }
      state = .failed
    }
  }

  private func didRegister(deviceToken data: Data) {
    let token = data.map { String(format: "%02x", $0) }.joined()
    guard !token.isEmpty else {
      didFailRegistration()
      return
    }
    deviceToken = token
    guard wantsNotifications, let expectedAccountID = accountID else { return }
    let expectedGeneration = accountGeneration
    Task {
      do {
        let configuration = try await service.apnsConfiguration()
        guard isCurrentAccount(expectedAccountID, generation: expectedGeneration) else { return }
        guard configuration.enabled else {
          state = .unavailable
          return
        }
        try await register(
          deviceToken: token,
          accountID: expectedAccountID,
          generation: expectedGeneration
        )
      } catch {
        guard isCurrentAccount(expectedAccountID, generation: expectedGeneration) else { return }
        state = .failed
      }
    }
  }

  private func register(deviceToken: String, accountID: UUID, generation: UInt64) async throws {
    try await service.registerAPNSDevice(
      installationID: installationID,
      deviceToken: deviceToken,
      environment: environment,
      appVersion: appVersion,
      locale: locale
    )
    guard isCurrentAccount(accountID, generation: generation), self.deviceToken == deviceToken else {
      return
    }
    state = .enabled
  }

  private func didFailRegistration() {
    deviceToken = nil
    if wantsNotifications, accountID != nil {
      state = .failed
    }
  }

  private func didOpen(route: NativeNotificationRoute) {
    pendingRoomRoute = route
    routeGeneration &+= 1
  }

  private func isCurrentAccount(_ expectedAccountID: UUID, generation: UInt64) -> Bool {
    accountID == expectedAccountID && accountGeneration == generation && wantsNotifications
  }

  private static func loadInstallationID(defaults: UserDefaults) -> UUID {
    if let rawValue = defaults.string(forKey: installationIDKey),
       rawValue == rawValue.lowercased(),
       let value = UUID(uuidString: rawValue),
       value.uuidString.lowercased() == rawValue {
      return value
    }
    let value = UUID()
    defaults.set(value.uuidString.lowercased(), forKey: installationIDKey)
    return value
  }

  private static func boundedMetadata(_ rawValue: String, fallback: String) -> String {
    let scalars = rawValue.unicodeScalars.filter { scalar in
      switch scalar.value {
      case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F:
        true
      default:
        false
      }
    }
    let bounded = String(String.UnicodeScalarView(scalars.prefix(64)))
    return bounded.isEmpty ? fallback : bounded
  }

  private static var bundleAppVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
  }

  private static var defaultEnvironment: APNSDeviceEnvironment {
#if DEBUG
    .development
#else
    .production
#endif
  }
}
