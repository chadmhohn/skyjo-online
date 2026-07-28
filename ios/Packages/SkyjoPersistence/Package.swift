// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SkyjoPersistence",
  platforms: [
    .iOS(.v18),
    .macOS(.v15)
  ],
  products: [
    .library(name: "SkyjoPersistence", targets: ["SkyjoPersistence"])
  ],
  dependencies: [
    .package(path: "../SkyjoDomain")
  ],
  targets: [
    .target(
      name: "SkyjoPersistence",
      dependencies: [
        .product(name: "SkyjoDomain", package: "SkyjoDomain")
      ]
    ),
    .testTarget(
      name: "SkyjoPersistenceTests",
      dependencies: [
        "SkyjoPersistence",
        .product(name: "SkyjoDomain", package: "SkyjoDomain")
      ]
    )
  ],
  swiftLanguageModes: [.v6]
)
