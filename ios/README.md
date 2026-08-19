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

CI uses `./scripts/ios-build-test.sh --build-unit-tests` for the bounded build lane when native paths change. Release notes, server-only work, and an exact release tag reuse the protected-main native result through cheap required-check placeholders instead of starting macOS runners. The argument-free command above remains the complete local build-and-test entrypoint.

The script verifies the Release API origin, builds a clean unsigned device archive for resource inspection, and builds an ad-hoc Xcode-signed Release simulator app whose executable entitlements are audited in every architecture. It installs locked Node dependencies when needed, builds `server-dist`, and launches the real `server.mjs` on a dynamic loopback port with a fixed non-secret access fixture, generated test-only session/invite secrets, and temporary SQLite/room files. It passes only bounded nonsecret loopback/test-mode values to the simulator, performs one unsigned `xcodebuild test`, proves the native two-cookie access/account flow and account/stats requests against that server, terminates the exact child, and deletes the validated temporary state/raw log. Its exit finalizer scans raw evidence for generated secrets and stages only verified sanitized files into the exact ignored directory CI may upload under `ios/Artifacts/`. Credentials and CI tokens never enter the `xcodebuild` environment.

Run the focused access/networking gate used by `iOS / Networking Contracts` with:

```sh
./scripts/ios-build-test.sh --networking-contracts
```

Networking mode first verifies the immutable v0.3.2 PWA parser/validator source and its established UTF-16 wire bounds, builds the current production PWA, and starts a real incognito Chromium peer under a credential-isolated environment. The Swift tests drive that peer through a narrow loopback control client while all room creation/join/chat/lifecycle actions occur through the visible PWA UI. Driver profiles, logs, and temporary state remain inside the exact harness directory and are removed before sanitized evidence is staged.

Run the focused native solo-and-room UI gate used by `iOS / UI & Accessibility` with:

```sh
./scripts/ios-build-test.sh --ui-accessibility
```

UI/accessibility mode needs no backend, account, or credential. It discovers a standard iPhone, large iPhone, and iPad on the newest installed simulator runtime, builds once without signing, then exercises solo launch/setup/table/scoring/settings/recovery plus authoritative waiting/active/scoring/pending/offline/resynchronized room fixtures across phone portrait and short landscape, large phone, and iPad portrait/landscape. The command above runs the complete matrix locally. Ordinary native-UI pull requests and protected-main pushes set `SKYJO_IOS_UI_ACCESSIBILITY_MODE=smoke` with the standard-phone role, which runs five representative launch, solo, summary, account-routing, and multiplayer tests. A manual CI dispatch with `ios_ui_mode=full` runs all four roles before TestFlight or when broad layout evidence is actually needed. The stable aggregate required check passes only when the selected scope passes, while unrelated changes skip the macOS role entirely. CI uploads compact sanitized text/JSON evidence only on failure for three days; full `.xcresult` bundles remain local instead of becoming routine artifacts.

Verify the portable schemas and deterministic fixture corpus separately:

```sh
npm run contracts:fixtures:check
npm run test:unit:contracts
```

Run the IOS-3 cross-language domain gate used by `iOS / Domain & Persistence` with:

```sh
npm run test:domain:parity
```

That one command checks deterministic fixture generation, replays the rules and AI corpus through both TypeScript and Swift, runs the Swift domain and persistence tests, and enforces independent executable-line coverage floors of at least 90% for both `SkyjoDomain` and `SkyjoPersistence`. Its SwiftPM scratch and coverage files remain in the ignored per-run `ios/Artifacts/DomainParity-*` directory.

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
- `Packages/SkyjoNetworking` and `Packages/SkyjoPersistence` depend only on `SkyjoDomain`. `SkyjoAPIClient` composes the actor-owned `AccessSessionClient` with typed account, profile/password, stats, solo-stats submission, readiness, and version requests on the same injected dedicated `URLSession`/persistent cookie store. It rejects redirects and unexpected final URLs, bounds payloads, requires compatible operational versions, decodes stable `{ code, error }` failures, and uses a safe fallback for unknown or malformed errors. `RoomInviteClient` validates the exact production HTTPS route, keeps signed tokens opaque, manually attaches existing shared authentication cookies to a cookie-disabled transport, and commits the single same-host redemption cookie only after a direct, bounded JSON/no-store success has passed DTO and invite-semantic validation. Invite creation never accepts response cookies. Redirects, transport failures, error statuses, invalid headers, oversized bodies, malformed payloads, and off-domain cookies cannot mutate the shared jar. `SkyjoAPIClient` also creates authenticated actor-owned `RoomConnection` instances sharing one account-fenced reset-recovery store. The realtime codec validates exact protocol-v2 frames and hidden-state semantics, and the state machine permits one exact-replay command until acknowledgement/snapshot convergence without optimistic mutation.
- `SkyjoApp/App/AppModel.swift` owns the native access/account/home/stats navigation state and injects the account-partitioned solo feature. `AppDependencies` also owns the shared-cookie invite client and `RoomAppCoordinator`; room navigation exists only for a currently confirmed online account, while sanitized invite review survives access/account gates and retiring room hosts cannot receive a newer link. Request identities and account-generation guards prevent stale async responses from restoring state after logout or account replacement. Password fields are cleared after use, cookies are never surfaced to views, native admin remains a web link, and public-release account deletion remains tracked by issue #192.
- `SkyjoApp/Features/Solo/` owns the guest/offline-ready solo launcher, explicit replacement review, 1-7-opponent setup, pure-reducer game loop, stable board-first table, minimizable score summary, settings, owner/generation fences, lifecycle autosave, and visible stats-outbox recovery. Sound effects and haptics default on, music remains visibly unavailable and off for v0.1.0, and user choices persist through the declared `UserDefaults` privacy-manifest reason.
- `SkyjoApp/Features/Rooms/` owns universal-link handoff, account-scoped room-session lifetime, create/join/recovery, waiting-room controls, authoritative gameplay, chat, score, room options, and invite review/share presentation. It never mutates the multiplayer board optimistically; room-specific sheets and share state survive ordinary same-room snapshots but are dismissed when the authoritative room changes or ends.
- `Packages/SkyjoPersistence` validates every solo snapshot, owns a custom SwiftData V1-to-V2 migration that restores nonzero autosave sequences before enforcing one durable save per owner, partitions guest/account saves, enforces monotonic autosave sequences, replaces saves atomically, and retains a signed-in-only FIFO stats outbox with generation-fenced delivery and opaque terminal/corrupt-head recovery. CloudKit is disabled.
- `Packages/SkyjoDesignSystem` contains reusable SwiftUI card, status, and stable action-slot primitives. Face-down cards structurally carry no value into the presentation or accessibility tree.
- `Packages/SkyjoTestSupport` aggregates all four package boundaries for tests and is never linked into the production app.
- `TestPlans/SkyjoCI.xctestplan` enables unit, package-graph, resource, launch, no-web-view, UI, and accessibility checks with coverage. Canonical `contracts/v1` HTTP/realtime fixtures, real local-server two-cookie relaunch simulation, transactional invite-cookie handoff through the app coordinator, stale-room recovery, state-model races, native access/account/stats flows, durable room reset/seat recovery, real Swift/PWA mixed-room scenarios, consumed-review invite navigation from Stats and Account, destructive room confirmations, compact opponent geometry, and the multi-device solo-and-room UI matrix are committed gates.

All packages use Swift 6 language mode, require iOS 18 or later, and have no remote dependencies.

Language-neutral schemas and fixtures live at [`contracts/v1`](../contracts/v1), outside the Swift package graph. Contract bundle version 1 is independent of the multiplayer protocol, snapshot envelope, presence, database, room persistence, PWA/server release, and native app version.

Native v0.1.0 does not import PWA IndexedDB saves. The local persistence envelope permits up to 2 MiB so every schema-bounded solo history can restore; the current HTTP request boundary remains 256 KiB. The implemented solo-stats adapter classifies local/client or server `REQUEST_TOO_LARGE`, invalid-payload, and unsupported-version failures as permanent outbox failures so they remain visible for explicit retry after compatibility changes or confirmed discard.

## Configuration

`Config/Base.xcconfig` owns shared nonsecret settings. Debug builds use the local Node endpoint by default and may include ignored `Config/Local.xcconfig` overrides. Release builds always reset the API base URL to `https://skyjo.groundworkrevops.com` after the optional local include, so a developer override cannot redirect a release build.

To prepare optional local signing or a different Debug URL:

```sh
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
```

Never add credentials, Apple team-specific state, signing exports, device tokens, or production data to either the committed templates or Xcode project. `com.groundworkrevops.skyjo` remains a working bundle-identifier proposal until the Apple team confirms availability.

The project declares only `applinks:skyjo.groundworkrevops.com` in its Associated Domains entitlement. The standard harness uses [`check-ios-associated-domains.mjs`](../scripts/check-ios-associated-domains.mjs) to verify that exact value from every architecture of an Xcode-signed Release simulator executable rather than trusting the source file or an intermediate `.xcent`. Networking mode also creates an invite on the real local Node process and sends its production-shaped URL through the app coordinator used beneath `onOpenURL`, including stale-room reset handling. These are built-product and app-consumer checks, not operating-system association proof: the final Apple application identifier, team-signed device archive, immutable #202 backend promotion, direct/Apple-CDN AASA verification, and installed/uninstalled behavior on physical Apple hardware remain explicit IOS-8 release gates. The later consolidated release session covers both iPhone and iPad plus Messages, Mail, and Safari.
