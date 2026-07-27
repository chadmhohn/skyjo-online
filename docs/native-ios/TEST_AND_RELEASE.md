# Native Test, CI, And Release Contract

## Required Pull-Request Checks

After IOS-1/2 establish the project and fixtures, require these checks for native-code PRs:

1. `iOS / Build`
2. `iOS / Domain & Persistence`
3. `iOS / Networking Contracts`
4. `iOS / UI & Accessibility`
5. Existing `CI / Quality & Security`
6. Existing domain/data/realtime/web E2E checks selected by the changed paths
7. `CodeQL / Analyze`

Run the iOS jobs on a pinned, documented macOS/Xcode image. Print `sw_vers`, `xcodebuild -version`, `swift --version`, SDKs, and selected simulator at the start. Do not use a floating beta image for release certification.

The build job compiles once for testing without signing; downstream jobs reuse derived products when safe. Upload failed `.xcresult`, screenshots, logs, and sanitized diagnostics for 14 days. Never attach cookies, credentials, invite tokens, APNs device tokens, raw private snapshots, signing assets, or production databases.

## Test Layers

### Swift Domain And Persistence

- Swift Testing parameterized tests for pure rules, AI, validation, and fixture parity.
- Seeded RNG/clock/UUID; no time-, locale-, or device-dependent expected values.
- Property/invariant tests for deck conservation, card visibility, legal phase transitions, revision monotonicity, scoring, and idempotency.
- Persistence tests for atomic replacement, corruption, migration, quota/write failure, account partitioning, and outbox retry/abort.
- At least 90% line coverage for domain/network/persistence targets, with every security/rule branch represented by a named test.

### Networking And Server Compatibility

- `URLProtocol` fakes for deterministic HTTP and cookie/error behavior.
- Codable fixtures for every valid/invalid REST and WebSocket frame.
- Local Node server integration tests for real cookies, redirect boundaries, WebSocket upgrade, heartbeat, revisions, commands, redaction, reconnect, lifecycle, invites, and APNs registration APIs.
- Mixed-client E2E with at least one Swift simulator and one Playwright web client.
- Previous released PWA compatibility stays green for any server change.

### SwiftUI And XCUITest

- View-model tests for navigation and action availability.
- XCUITest for access, signup/login, solo continue/new replacement, full representative solo turns, room create/join, chat, disconnect/resync, scoring, and settings.
- System accessibility audit on primary screens plus explicit label/value/trait/order assertions for cards and table controls.
- Screenshot artifacts at compact phone, large phone, iPad portrait, and iPad landscape sizes. Use available simulator discovery rather than permanently assuming one device name.
- Dynamic Type at normal, xxxLarge, and an accessibility size; Reduce Motion; Increase Contrast; Differentiate Without Color; right-to-left smoke even if v0.1 ships English only.

### Performance And Reliability

- XCTMetric launch, scroll/animation, solo AI-turn, snapshot decode/render, and reconnect measurements.
- Instruments/xctrace leak and allocations pass for repeated room connect/disconnect and a ten-minute game.
- Eight-player opening animation <=3 seconds and <=1 second with Reduce Motion.
- Connection status visible <=500 ms; half-open detected by the server <=35 seconds; ordinary recovered resync <=10 seconds.
- No unbounded task, timer, socket, observer, audio engine, or model retention after leaving a game.

## Security And Privacy Gates

- No hidden card, deck order, non-viewer drawn card, cookie, password, invite token, device token, or APNs key in model debug descriptions, OSLog, crash output, UI tree, notifications, pasteboard, persistence, or artifacts.
- Exact schema/bounds validation and fail-closed handling for malformed frames.
- No production HTTP or ATS exception.
- No secret in source, Info.plist, asset catalog, `.xcconfig`, build log, archive, or Git history.
- Dependency additions use SPM, are pinned/resolved, license-reviewed, privacy-manifest-reviewed, and justified in an ADR when architectural.
- `PrivacyInfo.xcprivacy` and App Store privacy disclosures match actual APIs/data.
- Account creation must have an in-app deletion path before public App Store release.

## Simulator Matrix

CI minimum:

- One current compact/standard iPhone simulator.
- One current large iPhone simulator.
- One iPad simulator in portrait and landscape.
- Oldest supported iOS 18 runtime where available in scheduled compatibility CI.
- Current shipping iOS runtime for every PR.

Run sanitizers and extended compatibility on scheduled/nightly jobs when their runtime cost is too high for every PR. Release certification cannot skip a failing scheduled gate.

## Physical Device Gate

After automation is green, complete one consolidated session on Chad's iPhone 16 Pro Max and one supported iPad if available:

- Development/TestFlight install, cold launch, upgrade, logout/login, and account switch.
- Universal link from Messages/Mail/Safari with app installed and uninstalled fallback.
- Background, lock, Wi-Fi/cellular loss, half-open connection, reconnect, same-seat reclaim, and active AI action.
- APNs permission allow/deny, locked/background turn alert, tap routing, token rotation/reinstall, and foreground suppression.
- Solo force-quit restore, replacement confirmation, offline full turn/round, stats retry after reconnect.
- One mixed native/PWA two-player round and one eight-player opening stress run.
- VoiceOver, Dynamic Type at 200%/accessibility size, Reduce Motion, Bold Text, contrast, rotation, safe areas, and real audio/haptics.

A defect returns to its owning issue and automated regression coverage is added. Only the failed physical step needs targeted re-verification after the automated suite is green again.

## Versioning And Compatibility

- PWA/server releases keep `vX.Y.Z` tags.
- Native releases use `ios-vX.Y.Z` tags.
- `CFBundleShortVersionString` uses semantic product version; `CFBundleVersion` is a monotonically increasing build integer.
- The About/Diagnostics screen shows native version/build, backend release SHA, schema, protocol, and sanitized connection state.
- Maintain a table in each native release note with minimum/maximum supported backend protocol and tested production release.
- The server must reject unsupported native clients explicitly; the app must offer a useful upgrade path.

## TestFlight And Server Rollout Order

For an additive backend requirement:

1. Merge compatibility tests and server support while keeping it unused by the PWA/native release.
2. Back up and deploy the server through the existing immutable-tag pipeline.
3. Verify `/readyz`, `/version`, PWA account/invite/web-push/multiplayer smokes, rollback readiness, and the new endpoint behind test credentials.
4. Build the native Release archive against the already-compatible server.
5. Upload to internal TestFlight, close branding/rights gate #193, then upload to external TestFlight after physical gates.
6. Monitor sanitized readiness, APNs failures, and protocol errors. Never automatically restore a live database after traffic resumes.

Server rollback must remain compatible with the released native client or the native feature must be remotely nonessential/fail safely. Do not couple a native build to an unpromoted server commit.

## External TestFlight And Public App Store Gates

Internal TestFlight may use the documented working title. Before external TestFlight Beta App Review:

- Close [branding and asset-rights gate #193](https://github.com/chadmhohn/skyjo-online/issues/193), including the app name/icon, bot roster, audio, screenshots, metadata, and submitting legal entity.
- Remove or replace any third-party element that is not demonstrably original or licensed for distribution.
- Provide Beta App Review information and a working review account without placing credentials in git or the issue.

Before a public listing, additionally:

- Complete [account-deletion issue #192](https://github.com/chadmhohn/skyjo-online/issues/192), privacy policy URL, support URL, age rating, privacy nutrition labels, review notes/account, encryption/export answers, and required product-page assets.
- Re-check Apple's current App Review Guidelines, SDK/upload minimums, and developer agreements.
- Archive with an accepted stable Xcode and validate in App Store Connect.

This gate may change metadata and branding; it must not be improvised by an autonomous worker.
