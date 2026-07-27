import SkyjoDesignSystem
import SkyjoDomain
import SkyjoNetworking
import SkyjoPersistence

public enum NativePackageGraph: Sendable {
  public static let moduleNames = [
    SkyjoDomainModule.name,
    SkyjoNetworkingModule.name,
    SkyjoPersistenceModule.name,
    SkyjoDesignSystemModule.name,
    "SkyjoTestSupport",
  ]

  public static let directDependencies = [
    SkyjoDomainModule.name: [String](),
    SkyjoNetworkingModule.name: SkyjoNetworkingModule.dependencies,
    SkyjoPersistenceModule.name: SkyjoPersistenceModule.dependencies,
    SkyjoDesignSystemModule.name: [String](),
    "SkyjoTestSupport": [
      SkyjoDomainModule.name,
      SkyjoNetworkingModule.name,
      SkyjoPersistenceModule.name,
      SkyjoDesignSystemModule.name,
    ],
  ]
}
