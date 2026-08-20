import Foundation
import SkyjoNetworking
import Testing

@testable import SkyjoNative

@Suite("Native notification lifecycle", .serialized)
@MainActor
struct NativeNotificationTests {
  @Test("Permission is requested only after the explicit enable action")
  func explicitPermissionAndDenial() async throws {
    let (defaults, suite) = try makeNotificationDefaults()
    defer { defaults.removePersistentDomain(forName: suite) }
    let service = NotificationServiceProbe()
    let system = NotificationSystemProbe(authorization: .notDetermined, requestResult: false)
    let coordinator = makeCoordinator(service: service, system: system, defaults: defaults)

    await coordinator.synchronize(account: notificationUser(idSuffix: "01"))
    #expect(coordinator.state == .off)
    #expect(system.permissionRequestCount == 0)

    await coordinator.enable()
    #expect(coordinator.state == .denied)
    #expect(system.permissionRequestCount == 1)
    #expect(await service.registrations().isEmpty)
  }

  @Test("Token rotation, account replacement, disable, and relaunch stay bounded")
  func registrationLifecycle() async throws {
    let (defaults, suite) = try makeNotificationDefaults()
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(true, forKey: "skyjo.apns.enabled.v1")
    let service = NotificationServiceProbe()
    let system = NotificationSystemProbe(authorization: .authorized, requestResult: true)
    let coordinator = makeCoordinator(service: service, system: system, defaults: defaults)

    await coordinator.synchronize(account: notificationUser(idSuffix: "01"))
    #expect(system.registrationCount == 1)
    system.deliverDeviceToken(Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]))
    await waitForRegistrationCount(1, service: service)

    system.deliverDeviceToken(Data([0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]))
    await waitForRegistrationCount(2, service: service)
    let firstTwo = await service.registrations()
    #expect(firstTwo.map(\.deviceToken) == ["0123456789abcdef", "fedcba9876543210"])
    #expect(Set(firstTwo.map(\.installationID)) == [coordinator.installationID])

    await coordinator.synchronize(account: notificationUser(idSuffix: "02"))
    await waitForRegistrationCount(3, service: service)
    #expect(await service.registrations().last?.deviceToken == "fedcba9876543210")

    await coordinator.disable()
    #expect(coordinator.state == .off)
    #expect(await service.deletedInstallations() == [coordinator.installationID])
    #expect(system.unregistrationCount == 1)

    let relaunched = makeCoordinator(
      service: service,
      system: NotificationSystemProbe(authorization: .authorized, requestResult: true),
      defaults: defaults
    )
    #expect(relaunched.installationID == coordinator.installationID)
  }

  @Test("Registration failure is recoverable and payload routing rejects ambiguous rooms")
  func failureAndSafeRouting() async throws {
    let (defaults, suite) = try makeNotificationDefaults()
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(true, forKey: "skyjo.apns.enabled.v1")
    let service = NotificationServiceProbe()
    let system = NotificationSystemProbe(authorization: .authorized, requestResult: true)
    let coordinator = makeCoordinator(service: service, system: system, defaults: defaults)
    await coordinator.synchronize(account: notificationUser(idSuffix: "01"))

    system.failRegistration()
    #expect(coordinator.state == .failed)
    #expect(NativeNotificationRoute(userInfo: [
      "version": 1,
      "kind": "turn",
      "route": "room",
      "roomCode": "abcde",
    ]) == nil)

    let route = try #require(NativeNotificationRoute(userInfo: [
      "version": 1,
      "kind": "round-ended",
      "route": "room",
      "roomCode": "ABCDE",
    ]))
    system.open(route)
    #expect(coordinator.pendingRoomRoute == route)
    coordinator.consumePendingRoomRoute()
    #expect(coordinator.pendingRoomRoute == nil)
  }

  @Test("Turning notifications off waits for an in-flight registration before deleting")
  func disableWinsRegistrationRace() async throws {
    let (defaults, suite) = try makeNotificationDefaults()
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(true, forKey: "skyjo.apns.enabled.v1")
    let service = SuspendingNotificationServiceProbe()
    let system = NotificationSystemProbe(authorization: .authorized, requestResult: true)
    let coordinator = makeCoordinator(service: service, system: system, defaults: defaults)

    await coordinator.synchronize(account: notificationUser(idSuffix: "01"))
    system.deliverDeviceToken(Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]))
    await waitForRegistrationStart(service: service)

    let disable = Task { await coordinator.disable() }
    await Task.yield()
    #expect(await service.events() == ["register-start"])

    await service.releaseRegistration()
    await disable.value

    #expect(await service.events() == ["register-start", "register-finish", "delete"])
    #expect(await service.hasRegistration() == false)
    #expect(coordinator.state == .off)
    #expect(system.unregistrationCount == 1)
  }

  private func makeCoordinator(
    service: any NativeNotificationService,
    system: NotificationSystemProbe,
    defaults: UserDefaults
  ) -> NativeNotificationCoordinator {
    NativeNotificationCoordinator(
      service: service,
      operatingSystem: system,
      defaults: defaults,
      environment: .development,
      appVersion: "0.1.0",
      locale: "en-US"
    )
  }
}

private struct NotificationRegistration: Sendable {
  let installationID: UUID
  let deviceToken: String
}

private actor NotificationServiceProbe: NativeNotificationService {
  private var registrationValues: [NotificationRegistration] = []
  private var deletionValues: [UUID] = []

  func apnsConfiguration() async throws -> APNSConfiguration {
    APNSConfiguration(enabled: true)
  }

  func registerAPNSDevice(
    installationID: UUID,
    deviceToken: String,
    environment: APNSDeviceEnvironment,
    appVersion: String,
    locale: String
  ) async throws {
    registrationValues.append(.init(installationID: installationID, deviceToken: deviceToken))
  }

  func deleteAPNSDevice(installationID: UUID) async throws {
    deletionValues.append(installationID)
  }

  func registrations() -> [NotificationRegistration] { registrationValues }
  func deletedInstallations() -> [UUID] { deletionValues }
}

private actor SuspendingNotificationServiceProbe: NativeNotificationService {
  private var eventValues: [String] = []
  private var registrationContinuation: CheckedContinuation<Void, Never>?
  private var registered = false

  func apnsConfiguration() async throws -> APNSConfiguration {
    APNSConfiguration(enabled: true)
  }

  func registerAPNSDevice(
    installationID: UUID,
    deviceToken: String,
    environment: APNSDeviceEnvironment,
    appVersion: String,
    locale: String
  ) async throws {
    eventValues.append("register-start")
    await withCheckedContinuation { continuation in
      registrationContinuation = continuation
    }
    registered = true
    eventValues.append("register-finish")
  }

  func deleteAPNSDevice(installationID: UUID) async throws {
    registered = false
    eventValues.append("delete")
  }

  func releaseRegistration() {
    registrationContinuation?.resume()
    registrationContinuation = nil
  }

  func events() -> [String] { eventValues }
  func hasRegistration() -> Bool { registered }
}

@MainActor
private final class NotificationSystemProbe: NativeNotificationOperatingSystem {
  var authorization: NativeNotificationAuthorizationStatus
  let requestResult: Bool
  private var handlers: NativeNotificationSystemHandlers?
  private(set) var permissionRequestCount = 0
  private(set) var registrationCount = 0
  private(set) var unregistrationCount = 0

  init(authorization: NativeNotificationAuthorizationStatus, requestResult: Bool) {
    self.authorization = authorization
    self.requestResult = requestResult
  }

  func install(_ handlers: NativeNotificationSystemHandlers) { self.handlers = handlers }
  func authorizationStatus() async -> NativeNotificationAuthorizationStatus { authorization }
  func requestAuthorization() async throws -> Bool {
    permissionRequestCount += 1
    authorization = requestResult ? .authorized : .denied
    return requestResult
  }
  func registerForRemoteNotifications() { registrationCount += 1 }
  func unregisterForRemoteNotifications() { unregistrationCount += 1 }
  func openSettings() {}
  func deliverDeviceToken(_ token: Data) { handlers?.didRegister(token) }
  func failRegistration() { handlers?.didFailRegistration() }
  func open(_ route: NativeNotificationRoute) { handlers?.didOpenRoute(route) }
}

private func notificationUser(idSuffix: String) -> AccountUser {
  AccountUser(
    id: UUID(uuidString: "30000000-0000-4000-8000-0000000000\(idSuffix)")!,
    email: "notifications@example.invalid",
    displayName: "Notifications",
    role: .player,
    disabled: false,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    lastLoginAt: nil
  )
}

private func makeNotificationDefaults() throws -> (UserDefaults, String) {
  let suite = "skyjo.notifications.\(UUID().uuidString)"
  return (try #require(UserDefaults(suiteName: suite)), suite)
}

private func waitForRegistrationCount(
  _ expectedCount: Int,
  service: NotificationServiceProbe
) async {
  for _ in 0..<100 {
    if await service.registrations().count >= expectedCount { break }
    await Task.yield()
  }
  #expect(await service.registrations().count == expectedCount)
}

private func waitForRegistrationStart(
  service: SuspendingNotificationServiceProbe
) async {
  for _ in 0..<100 {
    if await service.events() == ["register-start"] { break }
    await Task.yield()
  }
  #expect(await service.events() == ["register-start"])
}
