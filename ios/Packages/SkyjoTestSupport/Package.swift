// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SkyjoTestSupport",
  platforms: [
    .iOS(.v18)
  ],
  products: [
    .library(name: "SkyjoTestSupport", targets: ["SkyjoTestSupport"])
  ],
  dependencies: [
    .package(path: "../SkyjoDomain"),
    .package(path: "../SkyjoNetworking"),
    .package(path: "../SkyjoPersistence"),
    .package(path: "../SkyjoDesignSystem"),
  ],
  targets: [
    .target(
      name: "SkyjoTestSupport",
      dependencies: [
        .product(name: "SkyjoDomain", package: "SkyjoDomain"),
        .product(name: "SkyjoNetworking", package: "SkyjoNetworking"),
        .product(name: "SkyjoPersistence", package: "SkyjoPersistence"),
        .product(name: "SkyjoDesignSystem", package: "SkyjoDesignSystem"),
      ]
    )
  ],
  swiftLanguageModes: [.v6]
)
