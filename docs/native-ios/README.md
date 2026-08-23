# Skyjo Native iOS Handoff

This directory is the portable source of truth for building a native Skyjo client on a Mac. A fresh Codex worker should not need chat history, files from another computer, VPS shell history, or private Nova memory to understand the intended product and architecture.

## Baseline

- Handoff reviewed: 2026-07-28 America/Denver.
- Repository: `chadmhohn/skyjo-online`.
- PWA release baseline: `v0.3.2` at `130114e745c66c9f72305f05a0366e3f0ca10915`.
- Production `/version` and `/readyz` were verified against that SHA when this handoff was written.
- Backend protocol: multiplayer protocol 2, shared snapshot envelope 2, explicit presence 1, persistence schema 2.
- Repository contract bundle: `contracts/v1`. Its bundle version is an independent documentation/fixture axis; it does not change or imply the deployed release, multiplayer protocol, snapshot envelope, presence, database, room-persistence, or solo-AI version.
- IOS-2 repository support includes the JSON access-session API and stable JSON API-error envelope described in [`BACKEND_CONTRACTS.md`](BACKEND_CONTRACTS.md). This is a source/PR statement, not evidence that production has been promoted beyond the dated v0.3.2 baseline above.
- IOS-5 repository support includes the native typed compatibility-access/account/stats client, persistent account-cookie session, and accessible account/home/stats shell described in [`ARCHITECTURE.md`](ARCHITECTURE.md). Issue #228 retires presentation of the shared-password gate before external TestFlight. This is still a source/PR statement until promotion and distribution are verified.
- IOS-6 repository support includes the strict protocol-v2 codec, actor-owned authenticated room connection, account-fenced durable reset recovery, well-formed legacy UTF-16 compatibility, canonical realtime fixtures, and real Swift/Chromium mixed-client contract gate described in [`BACKEND_CONTRACTS.md`](BACKEND_CONTRACTS.md) and [`TEST_AND_RELEASE.md`](TEST_AND_RELEASE.md). The gate pins the documented v0.3.2 PWA source; it is still source/CI compatibility evidence, not proof of production promotion or native distribution.
- APNs backend sequencing uses #203 then #204: the first source release freezes and validates an optional exact `apns_devices` envelope while retaining schema 2; it must be promoted and become the verified `previous` rollback anchor before the later feature creates or uses that table. Source/CI completion alone does not satisfy that production gate.
- Issue #204 repository support creates that frozen table idempotently, stores only encrypted token material, exposes authenticated config/register/delete routes, and fans authoritative post-commit room events independently to Web Push and APNs through a bounded provider. It is source support until its own immutable production promotion and sanitized provider proof complete; native permission and device behavior remain #189.
- Issue #202 repository support includes the backend-only invite handoff: exact public AASA hosting plus public JSON redemption of the existing signed/current-room invite. Redemption may emit only the legacy compatibility cookie and never an account session. It deliberately does not claim the production application identifier, immutable promotion, Apple CDN propagation, Associated Domains signing, native routing/UI, or physical-device proof owned by #188.
- IOS-8 repository support includes strict production-host URL routing through the app coordinator, real isolated-Node redemption and stale-room evidence, the exact Associated Domains declaration, and a fail-closed audit of the entitlement embedded in every architecture of an Xcode-signed Release simulator product. This proves the repository-owned consumer and built product, not operating-system universal-link selection: the confirmed production application identifier, immutable #202 promotion, Apple CDN propagation, Apple-team-signed device archive, and installed/uninstalled physical-device behavior remain release gates.
- IOS-7 repository support includes the native solo launcher, explicit recoverable replacement, 1-7-bot setup, stable board-first iPhone/iPad table, scoring/settings/recovery states, original and pinned CC0 cues, haptics, typed durable stats delivery, and multi-device UI/accessibility gate described in [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`TEST_AND_RELEASE.md`](TEST_AND_RELEASE.md). This is source and CI evidence only; it does not claim a production promotion, signed build, TestFlight distribution, or App Store release.
- Native targets: iPhone and iPad. A Mac Catalyst or visionOS target is not part of v0.1.0.
- Deployment target: iOS/iPadOS 18.0. Build and submission use the latest stable Xcode accepted by App Store Connect; as of this review, that is Xcode 26 and the iOS/iPadOS 26 SDK or later.

Always re-read public `/version`, `/readyz`, this repository's latest tag, and Apple's current upload requirements before claiming that any of those values are still current.

## Locked Product Decisions

1. Build a genuine SwiftUI app. Do not ship a `WKWebView`, Capacitor, Cordova, or a thin PWA wrapper as the native product.
2. Keep the existing Node/VPS service as the system of record for accounts, multiplayer rooms, randomness, legal multiplayer moves, revisions, redaction, history, and stats.
3. Port solo rules and AI behavior to Swift. Do not embed JavaScriptCore just to execute the TypeScript engine.
4. Prevent rule drift with versioned, deterministic JSON fixtures under `contracts/v1`, generated by the TypeScript implementation and consumed by both TypeScript and Swift tests.
5. Use Apple frameworks first: SwiftUI, Observation, Foundation, URLSession, URLSessionWebSocketTask, UserNotifications, OSLog, Security, and XCTest/Swift Testing. Use Swift Package Manager for any dependency that later proves necessary.
6. Preserve the PWA. Native work is additive, and server changes must remain compatible with the deployed web client.
7. Deliver simulator and local-device builds first, then internal TestFlight. Final naming, artwork, bot names, and third-party intellectual-property rights must be confirmed before external TestFlight Beta App Review. Public App Store submission adds the remaining metadata/privacy/account-deletion gates.

## Read In This Order

1. Root [`AGENTS.md`](../../AGENTS.md) for repository safety and production rules.
2. [`PRODUCT.md`](PRODUCT.md) for scope, parity, and intentional exclusions.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) for the target Swift structure and state ownership.
4. [`BACKEND_CONTRACTS.md`](BACKEND_CONTRACTS.md) before touching HTTP, WebSocket, invites, or notifications.
5. [`MAC_SETUP.md`](MAC_SETUP.md) to prepare and verify the Mac.
6. [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for dependency order and issue acceptance gates.
7. [`TEST_AND_RELEASE.md`](TEST_AND_RELEASE.md) before marking an issue complete or distributing a build.
8. [`PRIVACY.md`](PRIVACY.md) before changing collected data, logging, SDKs, or App Store privacy answers.
9. [`BRANDING_AND_RIGHTS.md`](BRANDING_AND_RIGHTS.md) before preparing external TestFlight metadata or builds.
10. [`APP_ICON_PROVENANCE.md`](APP_ICON_PROVENANCE.md) before replacing or repurposing the external app icon.
11. [`handoff-manifest.json`](handoff-manifest.json) for the machine-readable baseline and source paths.
12. Root [`contracts/README.md`](../../contracts/README.md) before changing schemas, DTOs, protocol frames, or deterministic fixtures.

The implementation workspace is documented at [`ios/README.md`](../../ios/README.md). The checked-in project, schemes, entitlements templates, test plans, and Swift packages are part of this repository; they must not live only in a developer's local Xcode state.

GitHub execution is tracked by [program issue #179](https://github.com/chadmhohn/skyjo-online/issues/179) in the [Skyjo Native iOS v0.1.0 milestone](https://github.com/chadmhohn/skyjo-online/milestone/3). Implementation proceeds from [#181](https://github.com/chadmhohn/skyjo-online/issues/181) through the dependency order in `IMPLEMENTATION_PLAN.md`; use current GitHub issue/PR state rather than this handoff to decide which issue is claimable.

## First Prompt For Codex On The Mac

Use this prompt after cloning the repository:

```text
You are the implementation owner for Skyjo Native iOS v0.1.0.

Read AGENTS.md and every file in docs/native-ios/ completely. Run ./scripts/ios-preflight.sh and inspect git status, the current GitHub milestone/issues, the latest release tag, and the public /version and /readyz endpoints. Do not use files or memory outside this repository as project requirements.

Work the first unblocked native-iOS issue in dependency order. Use a dedicated branch and PR, keep the PWA and protocol-v2 web client compatible, add tests with each behavior, and do not commit credentials, signing material, device tokens, production data, or xcuserdata. Use the iOS Simulator, xcodebuild, Swift Testing/XCTest, XCUITest, accessibility audits, and screenshots as appropriate. Stop only for Apple-account/2FA access, an unavailable provider, or a destructive production-data decision.
```

## What The Mac Worker Can Do Better

With Xcode installed, Codex on the Mac can compile Swift, run unit and UI tests with `xcodebuild`, boot and control iPhone/iPad simulators with `xcrun simctl`, capture screenshots and result bundles, run accessibility audits, inspect signing diagnostics, and use Instruments through `xctrace`. Those tools do not exist on the Windows worker.

The worker still cannot manufacture Apple credentials or silently clear trust gates. Chad may need to sign in to Xcode, complete two-factor authentication, select the Apple Developer team, trust a connected iPhone, enable Developer Mode, and make the final App Store naming/rights decision. Those are the only planned human gates; normal implementation and simulator testing should continue without them.

## Portability Rules

- Requirements must be committed here or linked to a GitHub issue. Never refer to a local path on another machine as an authority.
- Commit project settings, shared schemes, test plans, fixtures, sample configuration, and scripts.
- Ignore `xcuserdata`, DerivedData, local `.xcconfig` files, signing exports, API keys, and result bundles.
- Store secret *names and setup instructions*, never values.
- If code and this documentation disagree, treat executable tests and the current server implementation as current behavior, then update the docs in the same PR.
- Any protocol change requires backward-compatible server handling, web regression tests, Swift conformance tests, and a protocol-version decision.
- A `contracts/vN` bundle change is not itself a multiplayer protocol, snapshot envelope, database, persistence, release, or native-product version change. Evaluate and record every affected version axis independently.

## Human Inputs That Are Deliberately Not In Git

- Apple Account and Apple Developer Program membership.
- Apple Team ID and signing certificates/profiles.
- Final bundle identifier availability. The working proposal is `com.groundworkrevops.skyjo`.
- APNs `.p8` key, key ID, issuer/team ID, and a separate persistent 32-byte token-encryption key.
- App Store Connect API key if automated uploads are enabled.
- Production access password and test-account passwords.
- Final external-beta/App Store name, artwork, bot-name roster, and confirmation that the chosen branding/content may be distributed.

Development can start without those values by using simulator builds, mock services, the public health endpoints, and locally supplied test credentials.
