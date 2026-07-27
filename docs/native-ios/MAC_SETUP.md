# Mac And Xcode Setup

## Required Mac Baseline

As of 2026-07-27, Apple lists Xcode 26.6 as the latest stable release and requires App Store uploads for iOS/iPadOS to use the iOS/iPadOS 26 SDK or later. Xcode 26.6 requires a supported macOS Tahoe 26.x release. Re-check [Apple's Xcode support matrix](https://developer.apple.com/support/xcode/) and [App Store submission requirements](https://developer.apple.com/app-store/submitting/) on the Mac; do not use a beta Xcode for a release archive unless App Store Connect explicitly accepts it.

Install:

1. Latest stable Xcode from the Mac App Store or Apple Developer downloads.
2. The current iOS Simulator runtime through Xcode Settings > Components.
3. Git and GitHub CLI (`gh`).
4. Node 24 and npm 11 for the existing backend, fixture generation, and PWA regression suite. The repository's `.node-version` is authoritative.

No CocoaPods, Ruby toolchain, JavaScript runtime inside the app, Tuist, or XcodeGen is required by the chosen architecture. If the bootstrap issue later chooses a project generator, record that in an ADR and make bootstrap reproducible.

## Clone And Verify

```sh
git clone https://github.com/chadmhohn/skyjo-online.git
cd skyjo-online
git status --short --branch
git fetch --tags --prune
gh auth status
./scripts/ios-preflight.sh
```

The preflight is read-only. It checks macOS, Xcode command-line selection, Swift, simulator availability, Git/GitHub CLI, Node/npm, and the public Skyjo release/readiness endpoints. Fix any required failure before project bootstrap.

If Xcode was just installed:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcodebuild -version
swift --version
xcrun simctl list runtimes
```

The `sudo` commands are machine setup, not project automation. Codex should explain them and let the user enter the Mac password locally; never ask for or capture that password.

## Apple Account And Signing

Simulator builds do not require Chad's signing identity. Start there.

For a physical iPhone/iPad:

1. Sign in under Xcode Settings > Accounts with a personal Apple Account or Developer Program account.
2. Connect/pair the device, enable Developer Mode when iOS requests it, and trust the Mac.
3. Select the appropriate Team under Signing & Capabilities and keep automatic signing enabled for development.

TestFlight, App Store distribution, production APNs, and Associated Domains require an appropriate Apple Developer Program team and App Store Connect access. Apple's current program membership is separate from installing Xcode. Apple login, two-factor authentication, agreements, tax/business steps, and device trust are expected human gates.

Never commit:

- Apple credentials, session cookies, or two-factor codes.
- `.p8`, `.p12`, `.cer`, `.mobileprovision`, signing export passwords, or keychain exports.
- Team-specific `Local.xcconfig`, `xcuserdata`, or Developer Portal downloads.
- App Store Connect API private keys or APNs provider keys.

Commit only placeholder configuration names and setup instructions.

## Local Configuration Contract

The bootstrap issue creates:

- `ios/Config/Base.xcconfig`: nonsecret shared settings.
- `ios/Config/Debug.xcconfig`: local/debug defaults.
- `ios/Config/Release.xcconfig`: production hostname and release-safe flags.
- `ios/Config/Local.xcconfig.example`: documented optional overrides.
- ignored `ios/Config/Local.xcconfig`: local Team ID or alternate dev URL if needed.

Proposed defaults:

```text
PRODUCT_BUNDLE_IDENTIFIER = com.groundworkrevops.skyjo
IPHONEOS_DEPLOYMENT_TARGET = 18.0
SKYJO_API_BASE_URL = https://skyjo.groundworkrevops.com
SWIFT_VERSION = 6.0
SWIFT_STRICT_CONCURRENCY = complete
```

The bundle identifier is a working proposal until the Apple team confirms it is available. Do not bake secrets into an `.xcconfig` or Info.plist.

## Useful Native Commands

Once the project exists, the committed scheme/test plan should make these work from the repository root:

```sh
xcodebuild -project ios/SkyjoNative.xcodeproj -scheme SkyjoNative -showdestinations
xcodebuild -project ios/SkyjoNative.xcodeproj -scheme SkyjoNative -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max' build
xcodebuild -project ios/SkyjoNative.xcodeproj -scheme SkyjoNative -testPlan SkyjoCI -destination 'platform=iOS Simulator,name=iPhone 16 Pro Max' test
xcrun simctl list devices available
xcrun xcresulttool get test-results summary --path <result-bundle>
xcrun xctrace list templates
```

Simulator names change with Xcode. CI and scripts should discover an available destination or use a tested generic device family instead of assuming the example exists forever.

## Physical-Device-Only Checks

The Simulator is valuable but not proof for:

- APNs delivery and token rotation.
- Background/lock behavior under real memory and network pressure.
- Haptics, speaker/ringer behavior, and Bluetooth audio.
- Camera/share-sheet integrations if later added.
- Real VoiceOver gestures, safe areas, thermal behavior, or exact iPhone 16 Pro Max layout.
- Development signing, TestFlight installation, and universal-link CDN propagation.

Use simulator automation continuously and reserve consolidated device sessions for these gates.

## Troubleshooting Boundaries

- If `xcodebuild` points to CommandLineTools, select the full Xcode developer directory.
- If no simulator is available, install an iOS runtime from Xcode Components.
- If a connected device is unavailable, unlock it, trust the Mac, enable Developer Mode, and inspect Xcode's device status.
- If signing fails, inspect Team/bundle-ID/capabilities first. Do not disable signing security or commit a personal profile.
- If App Store upload requirements changed, update this runbook and CI before archiving.
- If production access is unavailable, use protocol fixtures, mocks, and a local Node server; do not weaken production auth.
