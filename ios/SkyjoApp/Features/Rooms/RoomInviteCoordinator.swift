import Foundation
import Observation
import SkyjoNetworking

enum RoomInviteHandoffState: Equatable {
  case idle
  case redeeming
  case review(RedeemedRoomInvite)
  case failed(message: String)
}

@MainActor
@Observable
final class RoomInviteCoordinator {
  private let redeem: @Sendable (RoomInviteLink) async throws -> RedeemedRoomInvite
  private var requestID: UUID?

  private(set) var state = RoomInviteHandoffState.idle

  init(client: RoomInviteClient) {
    redeem = { link in try await client.redeem(link) }
  }

  init(
    redeem: @escaping @Sendable (RoomInviteLink) async throws -> RedeemedRoomInvite
  ) {
    self.redeem = redeem
  }

  /// Returns false when the URL is outside the committed Skyjo universal-link contract.
  @discardableResult
  func accept(_ url: URL) async -> Bool {
    let link: RoomInviteLink
    do {
      link = try RoomInviteLink(url: url)
    } catch {
      guard Self.isSkyjoInviteRoute(url) else { return false }
      requestID = nil
      state = .failed(message: "This Skyjo invite link is invalid. Ask the host for a new link.")
      return true
    }

    let nextRequestID = UUID()
    requestID = nextRequestID
    state = .redeeming
    do {
      // The opaque token exists only in this stack frame and the networking actor request.
      let invite = try await redeem(link)
      guard requestID == nextRequestID else { return true }
      state = .review(invite)
    } catch {
      guard requestID == nextRequestID else { return true }
      state = .failed(message: Self.safeMessage(for: error))
    }
    return true
  }

  func consumeReview() -> RedeemedRoomInvite? {
    guard case .review(let invite) = state else { return nil }
    requestID = nil
    state = .idle
    return invite
  }

  func dismiss() {
    requestID = nil
    state = .idle
  }

  /// Reclaims sanitized review state from a room model that is being retired.
  /// A newer URL request always wins over the older review.
  func restoreReviewIfIdle(_ invite: RedeemedRoomInvite) {
    guard case .idle = state else { return }
    state = .review(invite)
  }

  private static func safeMessage(for error: any Error) -> String {
    if let error = error as? SkyjoHTTPClientError {
      if case .server(_, let code, _) = error {
        if code == .inviteInvalidOrExpired {
          return "This invite is invalid or has expired. Ask the host for a new link."
        }
        if code == .inviteRoomUnavailable {
          return "That room is no longer available. Ask the host for a new invite."
        }
        if code == .inviteRateLimited {
          return "Too many invite attempts. Wait a moment and try again."
        }
      }
      return error.localizedDescription
    }
    if let error = error as? RoomInviteContractError {
      return error.localizedDescription
    }
    return "Skyjo could not open this invite. Ask the host for a new link."
  }

  private static func isSkyjoInviteRoute(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return false
    }
    return components.scheme?.lowercased() == "https"
      && components.host?.lowercased() == RoomInviteLink.productionHost
      && (components.percentEncodedPath == "/invite"
        || components.percentEncodedPath.hasPrefix("/invite/"))
  }
}

/// Bridges universal-link redemption and the account-scoped room session without
/// allowing an invite received during sign-in or account replacement to reach an
/// older account's socket.
@MainActor
@Observable
final class RoomAppCoordinator {
  @ObservationIgnored
  private let makeSessionHost: @MainActor @Sendable (AccountUser) -> RoomSessionHost
  private let inviteHandoff: RoomInviteCoordinator
  private var synchronizationGeneration: UInt64 = 0

  private(set) var sessionHost: RoomSessionHost?
  var isRoomPresented = false

  init(apiClient: SkyjoAPIClient, inviteClient: RoomInviteClient) {
    inviteHandoff = RoomInviteCoordinator(client: inviteClient)
    makeSessionHost = { account in
      RoomSessionHost(
        account: account,
        apiClient: apiClient,
        inviteClient: inviteClient
      )
    }
  }

  init(
    inviteHandoff: RoomInviteCoordinator,
    makeSessionHost: @escaping @MainActor @Sendable (AccountUser) -> RoomSessionHost
  ) {
    self.inviteHandoff = inviteHandoff
    self.makeSessionHost = makeSessionHost
  }

  var handoffState: RoomInviteHandoffState {
    inviteHandoff.state
  }

  var inviteFailureMessage: String? {
    guard case .failed(let message) = handoffState else { return nil }
    return message
  }

  /// Returns false for URLs outside the committed Skyjo universal-link contract.
  @discardableResult
  func accept(_ url: URL) async -> Bool {
    guard await inviteHandoff.accept(url) else { return false }
    routePendingInviteIfPossible()
    return true
  }

  /// Keeps the room host aligned with the currently authenticated account. A nil
  /// account retires the socket but intentionally leaves sanitized invite review
  /// state in memory so sign-in can finish the handoff.
  func synchronize(account: AccountUser?) async {
    synchronizationGeneration &+= 1
    let generation = synchronizationGeneration

    guard let account else {
      let previousHost = sessionHost
      preservePendingReview(from: previousHost)
      sessionHost = nil
      isRoomPresented = false
      await previousHost?.stop()
      return
    }

    if let currentHost = sessionHost,
       currentHost.model.account.id == account.id {
      await currentHost.synchronize(account: account)
      guard synchronizationGeneration == generation else { return }
      routePendingInviteIfPossible()
      return
    }

    let previousHost = sessionHost
    preservePendingReview(from: previousHost)
    sessionHost = nil
    isRoomPresented = false
    await previousHost?.stop()
    guard synchronizationGeneration == generation else { return }

    sessionHost = makeSessionHost(account)
    routePendingInviteIfPossible()
  }

  func presentRooms(for account: AccountUser) async {
    await synchronize(account: account)
    guard sessionHost?.model.account.id == account.id else { return }
    isRoomPresented = true
  }

  func dismissInviteHandoff() {
    inviteHandoff.dismiss()
  }

  private func routePendingInviteIfPossible() {
    guard let sessionHost,
          let invite = inviteHandoff.consumeReview()
    else { return }
    sessionHost.applyInvite(invite)
    isRoomPresented = true
  }

  private func preservePendingReview(from host: RoomSessionHost?) {
    guard let invite = host?.drainPendingInviteForRetirement() else { return }
    inviteHandoff.restoreReviewIfIdle(invite)
  }
}
