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

Run selected iOS jobs on a pinned, documented macOS/Xcode image. Print `sw_vers`, `xcodebuild -version`, `swift --version`, SDKs, and selected simulator at the start. Do not use a floating beta image for release certification. The required check names always materialize, but release/docs/server-only changes use short Ubuntu placeholders and exact release tags reuse the already-tested protected-main SHA.

The build job first creates an unsigned device Release archive and recursively verifies its exact app-bundle inventory and approved cue hashes. It then creates an Xcode-signed Release simulator product and fails closed unless every executable architecture embeds only `applinks:skyjo.groundworkrevops.com`; the audit reads the built product, never the source entitlement or an intermediate `.xcent`. XCTest still compiles once without signing, and downstream jobs reuse derived products when safe. The archive gate runs the install action so device- or archive-conditional copy phases cannot distribute unreviewed media. Core native failures retain sanitized diagnostics under the existing bounded policy. UI jobs upload compact sanitized log/JSON/TSV evidence only on failure for three days and do not upload routine `.xcresult` bundles. Never attach cookies, credentials, invite tokens, APNs device tokens, raw private snapshots, signing assets, or production databases.

IOS-1 pins `iOS / Build` to the GitHub-hosted `macos-26` image and selects Xcode 26.6 through `DEVELOPER_DIR`. When native paths change, the job records the concrete weekly runner image version, discovers an iPhone on the newest installed iOS runtime, installs locked Node dependencies, and runs [`scripts/ios-build-test.sh`](../../scripts/ios-build-test.sh) with `--build-unit-tests`. That hosted scope still creates and audits the unsigned device archive and signed release-simulator product before running every `SkyjoAppTests` case. The argument-free local command continues to run the whole committed test plan. IOS-2 adds the focused `iOS / Networking Contracts` job, which runs the same harness with `--networking-contracts`. IOS-5 extends that gate through typed account/stats requests, canonical HTTP fixtures, exact DTO schema-bound mutations, future operational-axis routing, persistent-cookie client recreation, and loaded/detail/player/offline-retry state-model and accessibility coverage. IOS-6 adds strict protocol-v2 codec/state-machine fixtures, durable reset recovery, a real local `URLSessionWebSocketTask`, and a separately authenticated Chromium PWA peer. Chromium is installed only in the networking-contract job.

IOS-3 adds `iOS / Domain & Persistence`, which runs `npm run test:domain:parity` on the same pinned macOS/Xcode image. The command regenerates and verifies the canonical TypeScript fixture model without writing, replays it through TypeScript and Swift, and runs the Swift package tests with coverage. IOS-4 extends the same command with `SkyjoPersistence` and enforces independent aggregate executable-line floors of 90% for `SkyjoDomain` and `SkyjoPersistence`; one target cannot mask a coverage regression in the other. SwiftPM scratch and module-cache data stay under the ignored per-run `ios/Artifacts/DomainParity-*` directory.

IOS-7 adds the stable aggregate `iOS / UI & Accessibility` job. `./scripts/ios-build-test.sh --ui-accessibility` requires no backend or credentials, selects a standard iPhone, large iPhone, and iPad on the newest installed simulator runtime, builds the committed test plan once without signing, and runs the full native-solo/room matrix locally. Automatic CI is path-aware: unrelated and workflow-only changes run no macOS UI job, while native UI changes run a five-test standard-phone smoke selected with `SKYJO_IOS_UI_ACCESSIBILITY_MODE=smoke`. If a workflow-only change actually rewires a native job, run a manual `ios_ui_mode=smoke` or `full` dispatch before merge. A manual CI dispatch with `ios_ui_mode=full` splits the complete matrix across the exact standard-phone, large-phone, iPad-portrait, and iPad-landscape roles for pre-TestFlight or intentionally broad layout certification. The stable aggregate fails unless its selected scope succeeds.

IOS-8 extends native UI coverage through authenticated invite routing, authoritative room play, and destructive room controls. A redeemed invite must expose the Home-owned room destination even when its sanitized review was immediately consumed from Stats or Account by an existing account-scoped host. Host removal and local saved-seat deletion require explicit accessible confirmation that identifies the affected seat or routing data. Compact phone landscape reserves at least four 44-point card targets, three grid gaps, and board padding for every opponent board; the opponent rail scrolls horizontally instead of compressing those targets.

The repository-owned room UI fixtures are compiled only in `DEBUG` and enter through the real `RoomConnection`, strict protocol-v2 codec, revision handling, and pending-command state machine. Their fake socket emits bounded server-shaped frames; it does not inject a room or game snapshot directly into `RoomSessionModel`, bypass production validation, or add a release network path. Parameterized unseeded admission, seeded recovery failure, no-seat cleanup-required, waiting, active, scoring, pending, offline, and stale-revision/resync states cover deterministic saved-seat controls, authoritative create and join submission, eight connected seats, unread and local chat echo transitions, hidden-value redaction, ready convergence, and read-only recovery copy without retaining raw frames or secrets in artifacts.

The focused gate compiles [`scripts/ios-simulator-accessibility.c`](../../scripts/ios-simulator-accessibility.c) into ignored DerivedData as an external simulator-only helper. It uses the pinned simulator runtime's Accessibility test setters to capture, enable, verify, and restore Reduce Motion and Differentiate Without Color; Increase Contrast uses `simctl ui`. The helper is never linked into or copied into an app or test bundle. A simulator-scoped launch marker makes the adaptation assertion run only while the gate owns those settings. The automatic smoke fails closed unless its five representative standard-phone tests pass exactly. A complete local or manually dispatched full run fails closed unless the four result bundles prove the exact 45/5/24/2 test inventory with zero failures, skips, or expected failures. The standard-phone entry retains the complete solo inventory, all seven default-setup and all seven blocked-recovery audit owners, and the deterministic room-state sequence plus compact landscape and Accessibility XXXL evidence. The large phone retains the solo table geometry checks and replays the active and Accessibility XXXL room layouts; iPad portrait runs the twenty-one hardened solo checks plus waiting, active, and Accessibility XXXL rooms; and iPad landscape proves both solo and authoritative room tables remain contained. The room Accessibility XXXL pass runs contrast, Dynamic Type, and text-clipping audits independently. Its Xcode 26.6 reconciliation accepts only an exact deterministic opponent header obscured by navigation material, an exact first-row face-up opponent value child inside its exact card, or the exact three element-less UIKit floating-tab Dynamic Type diagnostics backed by the complete three-button iPad tab shell; all other findings fail. The standard-phone entry launches a fresh settings fixture for each of nine acceptance-critical rows at standard and Accessibility XXXL sizes, makes that exact row fully visible with progress-bounded scrolling, retains its pre-audit screenshot and frame, and immediately runs an independently bounded application-wide text-clipping audit. Each probe derives the expected UIKit font for its exact content-size category and proves the measured row can contain the ideal wrapped label, so an Xcode Form artifact cannot conceal a real row truncation. This includes the rendered `Set Up Another Game` action, a 44-point target with material XXXL expansion, before its identifier-exact Xcode Dynamic Type false-positive allowance is accepted. The deterministic opening move-log row adds the ninth probe and must render as the exact static text at both sizes with material Accessibility XXXL growth. Each fresh-probe audit may reconcile at most one exact `solo.settings.move-log.0` predictive clipping finding, and only when the callback proves the expected label, static-text type, finite positive frame, and same-category UIKit body-font ideal bounds all fit that measured frame. The retained evidence records the finding and its geometry; a mismatch, duplicate, insufficient frame, or any other attributed finding fails. Because those 18 isolated row audits intentionally make the full certification longer than the ordinary XCTest default on hosted simulators, each full role owns a 120-minute ceiling while the smoke owns 30 minutes. The signal-aware EXIT finalizer attempts and verifies restoration of every captured setting and marker after success, failure, or any trappable interruption; a restoration failure also fails an otherwise-green run.

The hosted iPad-portrait role cold-boots the selected simulator and reapplies and verifies the owned accessibility settings before each of its twenty-four pinned tests. The default-setup acceptance path repeats its exact defaults, explanatory copy, no-write guarantee, header geometry, 44-point action, and screenshot assertions in seven cold-booted XCTest children. The blocked-stats recovery path separately repeats its exact visual, control, scrolling, 44-point, and screenshot assertions in seven more children. Each seven-child group owns exactly one current Xcode 26 audit category apiece: contrast, element detection, hit region, sufficient element description, Dynamic Type, text clipping, or traits. No grouped audit remains on either fixture, so a completed category cannot accumulate AXRuntime state for the next one and every original category remains enforced. Every contrast handler snapshots only the exact system-chrome, setup-header, settings-navigation, opponent-scroll/header, and room-table state needed by its allowances before Xcode enters AXRuntime's audit traversal. The solo table handler does not re-query the local-board container merely to enrich a possible diagnostic: hosted Xcode 26.6 can wedge that otherwise unused frame lookup after the retained table screenshot and before the audit starts. The table fixture separately proves the source actions remain disabled during opening reveal and renders their primary-colored labels with a non-color lock cue; disabled-control contrast findings are never allowlisted. Issue callbacks read only the attributed issue plus those immutable values and never re-enter the app hierarchy while AXRuntime owns it. Each split default, blocked, corrupt, composite table, or audited room owner performs one terminal process-state query, requires the target to remain foreground, and then synchronously terminates it. No hierarchy, element, frame, screenshot, gesture, scrolling, tap, or other UI interaction follows those audits. This catches an audit that returns after jetsam has already killed its target instead of accepting a false-green child. Every pinned iPad-portrait test begins in a fresh XCTest process while retaining its exact assertions and audits. The bounded result-summary classifier currently accepts no retry signature: every timeout, invalid `XCUIApplication`, and invalid target-app error is nonretryable. Assertions, changed signatures, incomplete evidence, and preparation failures are likewise never retried. The schema-v2 isolation manifest records every attempt, and only one fully passing accepted bundle per pinned test enters the merge. The role retains every one-test log, summary, test inventory, proof, and `.xcresult`, runs all twenty-four children even after a failure, merges the accepted results back into the role's canonical `ipad-portrait.xcresult`, and fails unless that merged bundle proves the exact twenty-four XCTest identifiers on one destination with zero failures, skips, or expected failures. Other roles and the complete local matrix retain their grouped invocations.

The harness gives Node and `xcodebuild` allowlisted environments without CI tokens or service credentials and starts the real `server.mjs` on a dynamic loopback port without an access password, using UUID-based test-only session/invite secrets and temporary SQLite/room-state paths. Full mode builds `server-dist`; networking mode builds the production PWA bundle as well. Simulator environment contains only the loopback server URL, explicit test mode, and—in networking mode—the nonsecret loopback mixed-client control URL.

The Chromium driver receives a one-line bounded bootstrap containing only the server origin and runs under a separate `env -i` allowlist; it never inherits server credentials/state paths. It uses Playwright's Chromium library directly with an incognito context and no trace, video, screenshot, or console capture. Its loopback-only exact command API accepts aliases rather than chat bodies/raw frames and never returns cookies, passwords, player/command identifiers, or WebSocket payloads. The simulator uses a separate cookie-disabled control session so host-scoped cookies cannot cross loopback ports. Before launch, the harness pins and executes the documented v0.3.2 PWA command/snapshot validators by immutable commit and SHA-256 and proves the established 280-UTF-16-unit boundary.

The harness runs one unsigned device `xcodebuild archive`, audits its clean `.app`, builds and audits one ad-hoc Xcode-signed Release simulator `.app`, and then runs one unsigned `xcodebuild test`. It terminates the exact Chromium driver before the exact Node child, removes the validated temporary state/profile/raw logs, scrubs secrets and machine-local paths from retained text, and writes ignored results under `ios/Artifacts/`. On every trappable exit it scans the raw `.xcresult` and logs for generated server secrets, then stages only verified files into the exact current-run directory accepted by CI. Driver stdout is restricted to one sanitized ready record and stderr must stay empty. A match, unexpected driver output, or scan error stages only a generic safety log and fails; an exit that cannot run the finalizer creates no upload-eligible directory. UI failure uploads contain compact validated logs and proof records for three days; the full local evidence directory remains ignored.

Local equivalents:

```sh
npm run contracts:fixtures:check
npm run test:unit:contracts
./scripts/ios-build-test.sh --networking-contracts
./scripts/ios-build-test.sh --ui-accessibility
```

## Test Layers

### Swift Domain And Persistence

- Swift Testing parameterized tests for pure rules, AI, validation, and fixture parity.
- Seeded RNG/clock/UUID; no time-, locale-, or device-dependent expected values.
- Property/invariant tests for deck conservation, card visibility, legal phase transitions, revision monotonicity, scoring, and idempotency.
- Persistence tests for atomic replacement, corruption, custom real V1-to-V2 session/outbox migration with nonzero autosaves and duplicate-owner cleanup, quota/write failure, durable account partitioning, stale writes, completion acknowledgement loss, and outbox retry/abort.
- Permanent and corrupt FIFO heads remain durable blockers across relaunch; tests recover them only through an actor-scoped opaque head handle (with an optional safe game UUID for display), including malformed identifiers, excessive counters, and account switches while recovery is suspended.
- Payload-boundary tests measure encoded UTF-8 bytes and include four-byte Unicode scalars whose character count is below 2 MiB while their encoded body exceeds it.
- At least 90% line coverage for domain/network/persistence targets, with every security/rule branch represented by a named test.

### Networking And Server Compatibility

- `URLProtocol` fakes for deterministic HTTP/error behavior, including typed required success fields with additive-field tolerance, known/unknown/malformed errors, redirect rejection, and request/response bounds enforced while streaming. Invite tests additionally prove that a cookie-disabled transport preserves both existing authentication cookies across redirects, error statuses, invalid content/cache headers, declared and streamed overflow, malformed/invalid payloads, and failures after response headers, while a fully validated redemption alone commits its same-origin access cookie.
- Codable fixtures for every valid/invalid REST and WebSocket frame, including exact keys, safe-number/UUID edges, personalized/shared privacy, 16 KiB/1 MiB wire bounds, malformed Unicode, and the legacy 280-UTF-16 chat boundary.
- IOS-2/5/#228 local Node integration proves open access without a password, legacy access-route compatibility, direct account signup/current/profile/password/logout, stats summary/list/detail/player behavior, account-cookie client recreation, repeatable logout, and clearing both cookie names through native `URLSession`.
- IOS-6 extends the same isolated server gate to authenticated WebSocket admission, acknowledgement/snapshot ordering, exact replay, stale/future resync, presence, reconnect, terminal admission errors, 15-second heartbeat survival, and account-fenced reset recovery across actor recreation, corruption, write/clear failure, cancellation, and process-style file-store recreation.
- Issue #202 adds real-Node invite proof: exact cookie-free GET/HEAD AASA bytes and cache headers; production-like startup rejection for missing/malformed/synthetic identifiers; native redemption success, expiry, invalid signature/shape, oversized body/token, wrong method/media/JSON/object, stale room instance, dedicated trusted-IP rate limiting, restart survival, and absence of tokens/secrets from logs and persistent state. Deployment smoke verifies the exact configured/canary AASA plus a public sanitized invalid-redemption response without mutating a room; the public-edge smoke independently verifies the exact route restriction and GET/HEAD behavior.
- IOS-8 sends a production-shaped invite URL through the same `RoomAppCoordinator.accept` path used under SwiftUI `onOpenURL`, while its opaque token is redeemed against the isolated real Node server through an injected API origin. The test proves sanitized review state, no account grant, and stable stale-room failure after reset; the server may emit only the legacy compatibility cookie. It is app routing and redemption evidence, not an installed universal-link assertion; no token is placed in simulator launch arguments, UI-test state, logs, or retained artifacts.
- Two serialized mixed-client scenarios use one Swift simulator connection and one real Playwright-driven PWA. They cover native-create/PWA-join and the reverse; visible/background/offline/reopen lifecycle; duplicate and held-stale commands; host transfer; game start/opening; AI takeover; human reclaim; maximum compatible astral chat; and more than two server heartbeat intervals.
- The pinned v0.3.2 verifier executes the exact tagged PWA parser/validator slices and rejects any tag/source-digest drift, proving that current outbound snapshots remain consumable by the documented cached browser release.
- Previous released PWA compatibility stays green for any server change.

The deterministic contract corpus lives under `contracts/v1/fixtures/`; its SHA-256 manifest must match the generator. `npm run contracts:fixtures:check` is nonwriting and rejects missing, stale, or unexpected output. Use `npm run contracts:fixtures:update` only for an intentional schema/producer change and review the complete semantic and privacy diff.

### SwiftUI And XCUITest

- View-model tests for navigation and action availability.
- XCUITest for access, signup/login, solo continue/new replacement, full representative solo turns, room create/join, chat, disconnect/resync, scoring, and settings.
- System accessibility audit on primary screens plus explicit label/value/trait/order assertions for cards and table controls.
- Screenshot artifacts at compact phone, large phone, iPad portrait, and iPad landscape sizes. Use available simulator discovery rather than permanently assuming one device name.
- Dynamic Type at normal, xxxLarge, and an accessibility size; Reduce Motion; Increase Contrast; Differentiate Without Color; right-to-left smoke even if v0.1 ships English only.

For IOS-5, retain model and UI evidence for access, signup/login, cookie-backed relaunch, profile, password change, logout, stats loading/empty/detail/player history, retry, offline, disabled/expired account, service-not-ready, and upgrade-required states. The account screen must show the web-only admin link only to an admin and visibly track issue #192 for public-release deletion. Exercise the account screen in phone portrait, landscape, and an accessibility Dynamic Type size, attach sanitized screenshots for the changed UI, and keep the full simulator run free of cookies and passwords.

For IOS-7, retain model and UI evidence for Continue/New Game and replacement cancellation, all setup choices and explanations, stable draw/discard/drawn/guidance slots, face-down accessibility redaction, round-summary minimization, settings, safe persistence/outbox recovery, and guest offline play. Exercise standard and large phones plus iPad portrait/landscape. The focused gate combines the system accessibility audit with explicit XXXL Dynamic Type, Reduce Motion, Increase Contrast, Differentiate Without Color, safe-area containment, and 44-point-target assertions. Settings copy/action evidence is row-specific: every named row must begin its clipping audit fully visible in a fresh fixture at each required size, and its screenshot must be captured before XCTest is allowed to reposition the lazy list. The AXXXL reconciliation banner exceeds one chrome-free viewport, so its exact heading and message receive separate contrast passes; each is fully clear of navigation and tab-bar material while the pass may ignore only the other exact, independently audited label when it is not fully visible.

For IOS-8, retain focused XCUITest evidence for an eight-player waiting room and active table; compact chat plus unread state without table displacement; opponent hidden-value redaction; scoring and server-confirmed ready state; host Remove confirmation; pending, offline, and resynchronized messaging; and 44-point targets. Exercise phone portrait and short landscape, a large phone, and iPad portrait/landscape. At Accessibility XXXL, use the explicit scrollable table presentation, assert safe-area containment and target sizes, and run the system accessibility audit with only narrowly documented framework-noise categories excluded.

### Performance And Reliability

- XCTMetric launch, scroll/animation, solo AI-turn, snapshot decode/render, and reconnect measurements.
- Instruments/xctrace leak and allocations pass for repeated room connect/disconnect and a ten-minute game.
- Eight-player opening animation <=3 seconds and <=1 second with Reduce Motion.
- Connection status visible <=500 ms; half-open detected by the server <=35 seconds; ordinary recovered resync <=10 seconds.
- No unbounded task, timer, socket, observer, audio engine, or model retention after leaving a game.

IOS-10 keeps the recurring gate proportional: normal PR CI builds the three performance tests but skips their repeated samples. Before a TestFlight candidate, enable `SKYJO_RUN_RELEASE_PERFORMANCE=1` in the selected simulator's `launchctl` environment and run only `SkyjoAppUITests/testIOS10ColdLaunchPerformance`, `SkyjoAppUITests/testIOS10EightPlayerRenderPerformance`, and `SkyjoAppUITests/testIOS10ReconnectInteractionPerformance` on the standard-phone simulator. Use a Release-optimized test build with code coverage disabled, `ENABLE_TESTABILITY=YES`, and an explicit test-build `SWIFT_ACTIVE_COMPILATION_CONDITIONS="$(inherited) DEBUG"`; this exposes deterministic fixtures without putting them in the normal archive. Cold launch and table presentation each record three XCTMetric samples, and the resync interaction records five. Treat cold launch above 3 seconds, full app-launch-to-eight-player-table presentation above 5 seconds, the complete resync-action UI round trip above 4 seconds, or rising memory across the in-process resync samples as a release defect; compare absolute CPU/memory values only on the same device/runtime. The table has no blocking opening animation, so its animation budget is satisfied by construction, including Reduce Motion. Existing deterministic realtime and room-model tests remain the faster task/socket regression gate.

The 2026-08-21 Release-optimized fixture baseline on stable Xcode 26.6, iOS 26.5, and an iPhone 17 Pro Max simulator passed all three metric tests. Responsive cold launch averaged 0.974 seconds (0.967, 0.971, and 0.983); full launch-to-eight-player-table averaged 4.438 seconds (4.466, 4.427, and 4.420); the complete resync-action UI round trip averaged 2.983 seconds across five in-process samples. Peak physical memory stayed within 41.5-41.7 MB. These measurements exercise optimized production sources through deterministic test-only transport, but they are not the signed TestFlight archive. Pair them with the physical TestFlight session and a ten-minute Allocations/Leaks check; keep sanitized `.xcresult` and `.trace` evidence local rather than making them recurring CI artifacts.

## Security And Privacy Gates

- No hidden card, deck order, non-viewer drawn card, cookie, password, invite token, device token, or APNs key in model debug descriptions, OSLog, crash output, UI tree, notifications, pasteboard, persistence, or artifacts.
- Exact schema/bounds validation and fail-closed handling for malformed frames.
- No production HTTP or ATS exception.
- No secret in source, Info.plist, asset catalog, `.xcconfig`, build log, archive, or Git history.
- Dependency additions use SPM, are pinned/resolved, license-reviewed, privacy-manifest-reviewed, and justified in an ADR when architectural.
- `PrivacyInfo.xcprivacy` and the [`PRIVACY.md`](PRIVACY.md) App Store privacy-answer draft match actual APIs/data.
- Account creation must have an in-app deletion path before public App Store release.

## Simulator Matrix

CI minimum:

- One current compact/standard iPhone simulator.
- One current large iPhone simulator.
- One iPad simulator in portrait and landscape.
- Oldest supported iOS 18 runtime where available in scheduled compatibility CI.
- Current shipping iOS runtime for every PR.

Run sanitizers and extended compatibility on manual or weekly jobs when their runtime cost is too high for every PR. Release certification cannot skip a failing scheduled gate.

## Physical Device Gate

IOS-8 operating-system evidence starts only after #202 is immutably promoted with the confirmed full Apple application identifier and the direct plus Apple-CDN AASA responses match. Audit the resulting Apple-team-signed device `.app` with `node scripts/check-ios-associated-domains.mjs --app-bundle <absolute-app-path>`, then retain sanitized installed/uninstalled tap results without recording the invite URL or token. A simulator `simctl openurl` attempt that reaches Safari proves browser fallback, not native routing; simulator association/cache manipulation and a custom URL-scheme bypass are not acceptable substitutes.

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
- Portable schemas/fixtures use `contracts/vN`. This bundle version is independent of the PWA/server release, native release/build, multiplayer protocol, snapshot envelope, presence, database schema, room persistence, and solo-AI strategy; assess every affected axis separately.
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

APNs storage requires two distinct immutable server promotions even though both retain public database schema 2:

1. Merge and promote #203, which validates but never creates or uses the exact optional `apns_devices` envelope.
2. Verify that tag as production `current`, then promote one subsequent release so the envelope tag becomes the exact healthy `previous` rollback anchor.
3. Only then may #204 create/use the frozen table. Its canary and production proof must show the envelope release starts against a copied APNs-extended database and preserves every row.
4. Once the table exists, reject or operationally forbid rollback past the recorded envelope tag. Code rollback never restores SQLite.

#204 source and CI use ephemeral P-256/test-encryption keys plus an injected fake HTTP/2 transport; GitHub never receives production credentials or contacts Apple. Its production canary blanks every APNs setting, denies the provider-key directory, and proves only copied-state table creation/compatibility. Production enablement separately requires the complete file-backed provider configuration, authenticated config/register/rotate/delete/logout proof, encrypted-row and log-redaction inspection, independent Web Push/APNs fanout, and a sanitized real-provider result before #189 distributes a dependent native build.

Closing #203 from a source PR is provisional. If promotion acceptance has not completed, reopen it immediately and keep #204 blocked. Apple/APNs credentials are not required for #203 source or CI, but tagging, promotion, backup, production verification, and rollback-anchor recording require explicit approval in the current conversation.

For IOS-2 specifically, the new server is backward compatible with the PWA because `/login`, signed-cookie format, and the `error` string remain intact while `code` is additive. A pre-IOS-2 server is not forward compatible with native access: it may redirect the JSON endpoint to HTML login or omit the required envelope, and the native client intentionally fails closed. Deploy and verify the server first; do not roll it back after distributing a dependent native build unless that feature is disabled/fails safely and the compatibility impact is accepted. Passing local/CI checks alone is not a production-deployment claim.

For issue #202, place the confirmed complete Apple application identifier in the root-owned production environment before tagging. The isolated canary uses the fixed synthetic identifier and must never read the production environment. Promotion proves local/public direct AASA, current browser invite behavior, and the public JSON route before #188 distributes a dependent build; Apple CDN propagation and installed/uninstalled universal links remain separate physical-device gates. There is no persistence migration, so rollback is code-only. A pre-#202 server remains PWA-compatible but removes a contract required by a distributed native client, and cached AASA propagation may outlive a code rollback temporarily.

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
