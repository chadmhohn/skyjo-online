// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SkyjoNetworking",
  platforms: [
    .iOS(.v18)
  ],
  products: [
    .library(name: "SkyjoNetworking", targets: ["SkyjoNetworking"])
  ],
  dependencies: [
    .package(path: "../SkyjoDomain")
  ],
  targets: [
    .target(
      name: "SkyjoNetworking",
      dependencies: [
        .product(name: "SkyjoDomain", package: "SkyjoDomain")
      ]
    )
  ],
  swiftLanguageModes: [.v6]
)
