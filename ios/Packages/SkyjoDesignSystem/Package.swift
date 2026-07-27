// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SkyjoDesignSystem",
  platforms: [
    .iOS(.v18)
  ],
  products: [
    .library(name: "SkyjoDesignSystem", targets: ["SkyjoDesignSystem"])
  ],
  targets: [
    .target(name: "SkyjoDesignSystem")
  ],
  swiftLanguageModes: [.v6]
)
