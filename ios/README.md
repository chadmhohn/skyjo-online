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

The script verifies the Release API origin, installs locked Node dependencies when needed, builds `server-dist`, and launches the real `server.mjs` on a dynamic loopback port with a fixed non-secret access fixture, generated test-only session/invite secrets, and temporary SQLite/room files. It passes only the loopback URL to the simulator, performs one unsigned `xcodebuild test`, proves the native two-cookie access/account flow and account/stats requests against that server, terminates the exact child, and deletes the validated temporary state/raw log. Its exit finalizer scans raw evidence for generated secrets and stages only verified sanitized files into the exact ignored directory CI may upload under `ios/Artifacts/`. Credentials and CI tokens never enter the `xcodebuild` environment.

Run the focused access/networking gate used by `iOS / Networking Contracts` with:

```sh
./scripts/ios-build-test.sh --networking-contracts
```

Verify the portable schemas and deterministic fixture corpus separately:

```sh
npm run contracts:fixtures:check
npm run test:unit:contracts
```

Run the IOS-3 cross-language domain gate used by `iOS / Domain & Persistence` with:

```sh
npm run test:domain:parity
```

That one command checks deterministic fixture generation, replays the rules and AI corpus through both TypeScript and Swift, runs the Swift domain invariant/privacy tests, and enforces at least 90% executable-line coverage for `SkyjoDomain`. Its SwiftPM scratch and coverage files remain in the ignored per-run `ios/Artifacts/DomainParity-*` directory.

Use `npm run contracts:fixtures:update` only after an intentional schema or canonical-producer change. The update is guarded against replacing a dirty fixture directory; review the generated corpus and SHA-256 manifest before committing.

To inspect destinations without running tests:

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
- `Packages/SkyjoNetworking` and `Packages/SkyjoPersistence` depend only on `SkyjoDomain`. `SkyjoAPIClient` composes the actor-owned `AccessSessionClient` with typed account, profile/password, stats, readiness, and version requests on the same injected dedicated `URLSession`/persistent cookie store. It rejects redirects and unexpected final URLs, bounds payloads, requires compatible operational versions, decodes stable `{ code, error }` failures, and uses a safe fallback for unknown or malformed errors.
- `SkyjoApp/App/AppModel.swift` owns the native access/account/home/stats navigation state. Request identities and account-generation guards prevent stale async responses from restoring state after logout or account replacement. Password fields are cleared after use, cookies are never surfaced to views, native admin remains a web link, and public-release account deletion remains tracked by issue #192.
- `Packages/SkyjoDesignSystem` contains reusable SwiftUI presentation primitives.
- `Packages/SkyjoTestSupport` aggregates all four package boundaries for tests and is never linked into the production app.
- `TestPlans/SkyjoCI.xctestplan` enables unit, package-graph, resource, launch, no-web-view, UI, and accessibility checks with coverage. Canonical `contracts/v1` HTTP fixtures, real local-server two-cookie relaunch simulation, state-model races, and native access/account/stats flows are part of the IOS-5 gate.

All packages use Swift 6 language mode, require iOS 18 or later, and have no remote dependencies.

Language-neutral schemas and fixtures live at [`contracts/v1`](../contracts/v1), outside the Swift package graph. Contract bundle version 1 is independent of the multiplayer protocol, snapshot envelope, presence, database, room persistence, PWA/server release, and native app version.

## Configuration

`Config/Base.xcconfig` owns shared nonsecret settings. Debug builds use the local Node endpoint by default and may include ignored `Config/Local.xcconfig` overrides. Release builds always reset the API base URL to `https://skyjo.groundworkrevops.com` after the optional local include, so a developer override cannot redirect a release build.

To prepare optional local signing or a different Debug URL:

```sh
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
```

Never add credentials, Apple team-specific state, signing exports, device tokens, or production data to either the committed templates or Xcode project. `com.groundworkrevops.skyjo` remains a working bundle-identifier proposal until the Apple team confirms availability.
