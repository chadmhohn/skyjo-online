// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SkyjoDomain",
  platforms: [
    .iOS(.v18)
  ],
  products: [
    .library(name: "SkyjoDomain", targets: ["SkyjoDomain"])
  ],
  targets: [
    .target(name: "SkyjoDomain")
  ],
  swiftLanguageModes: [.v6]
)
