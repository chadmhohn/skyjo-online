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
      return false
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
}
