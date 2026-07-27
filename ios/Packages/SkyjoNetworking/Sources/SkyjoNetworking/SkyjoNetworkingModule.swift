import Foundation
import SkyjoDomain

public struct SkyjoNetworkEnvironment: Equatable, Sendable {
  public let baseURL: URL

  public init(baseURL: URL) {
    self.baseURL = baseURL
  }
}

public enum SkyjoNetworkingModule: Sendable {
  public static let name = "SkyjoNetworking"
  public static let dependencies = [SkyjoDomainModule.name]
}
