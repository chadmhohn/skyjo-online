import Foundation
import SkyjoDomain

public struct SkyjoNetworkEnvironment: Equatable, Sendable {
  public static let defaultOuterAccessCookieName = "skyjo_session"

  public let baseURL: URL
  public let outerAccessCookieName: String

  public init(
    baseURL: URL,
    outerAccessCookieName: String = Self.defaultOuterAccessCookieName
  ) {
    self.baseURL = baseURL
    self.outerAccessCookieName = outerAccessCookieName
  }
}

public enum SkyjoNetworkingModule: Sendable {
  public static let name = "SkyjoNetworking"
  public static let dependencies = [SkyjoDomainModule.name]
}
