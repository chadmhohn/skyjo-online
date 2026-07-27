# Skyjo Native iOS Workspace

This directory contains the committed SwiftUI foundation for the universal iPhone and iPad app. Read the root [`AGENTS.md`](../AGENTS.md), [`ios/AGENTS.md`](AGENTS.md), and the complete [`docs/native-ios/`](../docs/native-ios/README.md) handoff before changing it.

## Prerequisites

- macOS with the repository-supported stable Xcode selected through `xcode-select`.
- An installed iOS Simulator runtime with at least one iPhone and one iPad device.
- The GitHub CLI, Node, and npm versions checked by the repository preflight.

From the repository root, verify the machine with:

```sh
./scripts/ios-preflight.sh
```

Simulator work does not require an Apple account, development team, or signing credential.

## Build And Test

The stable clean-clone command dynamically selects an iPhone on the newest available iOS Simulator runtime and runs the shared `SkyjoNative` scheme with the committed `SkyjoCI` test plan:

```sh
./scripts/ios-build-test.sh
```

The script performs one unsigned `xcodebuild test`, writes ignored local evidence under `ios/Artifacts/`, and excludes credentials and CI tokens from the Xcode process environment. To inspect destinations without running tests:

```sh
xcodebuild \
  -project ios/SkyjoNative.xcodeproj \
  -scheme SkyjoNative \
  -showdestinations
```

## Project Boundaries

- `SkyjoNative.xcodeproj` contains the app, unit-test, and UI-test targets plus a shared scheme.
- `SkyjoApp/` contains only the native application shell and resources. It does not embed a web view.
- `Packages/SkyjoDomain` is the pure domain boundary.
- `Packages/SkyjoNetworking` and `Packages/SkyjoPersistence` depend only on `SkyjoDomain`.
- `Packages/SkyjoDesignSystem` contains reusable SwiftUI presentation primitives.
- `Packages/SkyjoTestSupport` aggregates all four package boundaries for tests and is never linked into the production app.
- `TestPlans/SkyjoCI.xctestplan` enables unit, package-graph, resource, launch, and no-web-view checks with coverage.

All packages use Swift 6 language mode, require iOS 18 or later, and have no remote dependencies.

## Configuration

`Config/Base.xcconfig` owns shared nonsecret settings. Debug builds use the local Node endpoint by default and may include ignored `Config/Local.xcconfig` overrides. Release builds always reset the API base URL to `https://skyjo.groundworkrevops.com` after the optional local include, so a developer override cannot redirect a release build.

To prepare optional local signing or a different Debug URL:

```sh
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
```

Never add credentials, Apple team-specific state, signing exports, device tokens, or production data to either the committed templates or Xcode project. `com.groundworkrevops.skyjo` remains a working bundle-identifier proposal until the Apple team confirms availability.
