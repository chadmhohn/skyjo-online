import SkyjoDomain

public actor SkyjoPersistenceBootstrap {
  public init() {}

  public func domainModuleName() -> String {
    SkyjoDomainModule.name
  }
}

public enum SkyjoPersistenceModule: Sendable {
  public static let name = "SkyjoPersistence"
  public static let dependencies = [SkyjoDomainModule.name]
}
