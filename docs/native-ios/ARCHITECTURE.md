# Native iOS Architecture

## Decision

Use SwiftUI with Swift 6 language mode and strict concurrency, targeting iOS/iPadOS 18.0 or later. Build with the latest stable App-Store-supported Xcode. Keep dependencies at zero initially and add only Swift Package Manager packages with an explicit architectural reason.

The native client owns presentation, local solo execution, local persistence, audio/haptics, and transport coordination. The existing Node service remains authoritative for every multiplayer mutation and all shared/account data.

## Planned Repository Shape

```text
ios/
  SkyjoNative.xcodeproj/
  Config/
    Base.xcconfig
    Debug.xcconfig
    Release.xcconfig
    Local.xcconfig.example
  SkyjoApp/
    App/
    Features/
      Access/
      Account/
      Home/
      Solo/
      Rooms/
      Stats/
      Settings/
    Resources/
      Assets.xcassets/
      Audio/
      PrivacyInfo.xcprivacy
  Packages/
    SkyjoDomain/
    SkyjoNetworking/
    SkyjoPersistence/
    SkyjoDesignSystem/
    SkyjoTestSupport/
  SkyjoAppTests/
  SkyjoAppUITests/
  TestPlans/
    SkyjoCI.xctestplan
  README.md
```

Commit the project, shared schemes, test plan, `.xcconfig` templates, privacy manifest, and fixtures. Keep personal signing values in ignored `Local.xcconfig` or Xcode-managed local state.

The language-neutral boundary lives outside the Xcode workspace under `contracts/v1/`. Its JSON Schemas and generated fixtures are consumed by TypeScript today and are the portable inputs for subsequent Swift domain/realtime work. Contract bundle version 1 is independent of all runtime protocol, schema, release, and app-version numbers.

## Module Responsibilities

### SkyjoDomain

Pure Swift, Foundation-only where possible:

- `Card`, `Player`, `GameState`, phases, round history, rules constants, and legal solo reducers.
- Seeded random-source abstraction and deterministic IDs/clock for tests.
- AI knowledge projection, strategies, difficulty assignments, and strategy version.
- Codable wire/domain adapters. Hidden multiplayer values remain optional and never become fake values.
- No SwiftUI, URLSession, filesystem, notification, or global singleton dependencies.

The TypeScript engine remains the reference implementation during the port. Once parity fixtures pass, neither implementation may change a shared rule without updating the fixtures and both test suites in one compatible change.

### SkyjoNetworking

- One dedicated `URLSession` configured with an explicitly supplied, persistent `HTTPCookieStorage` for the outer access and account HttpOnly cookies; tests inject an isolated cookie store.
- `AccessSessionClient` owns typed `GET`, `POST`, and `DELETE /api/access/session` calls. It tolerates additive success fields, requires the typed `authenticated` field, rejects redirects and unexpected final URLs, caps requests at 256 KiB and responses at 64 KiB, and maps only known stable error codes to server messages.
- `SkyjoAPIClient` composes that access actor on the same session/cookie jar and adds typed current-account, signup/login/logout, profile/password, stats summary/list/detail/player, readiness, and version requests. General responses are capped at 2 MiB while the access route retains its 64 KiB boundary.
- Operational DTOs require schema 2 and protocol 2 plus valid release identity/timestamps. Unsupported values become an explicit upgrade state. Contract-required nullable keys must be present even when their value is `null`; absent keys fail decoding.
- Canonical valid/invalid HTTP fixtures under `contracts/v1/fixtures/` are decoded by Swift tests in addition to focused `URLProtocol` boundary and safe-error tests.
- Typed Codable request/response models remain the boundary for later invite and realtime contracts.
- An actor-owned `RoomConnection` around `URLSessionWebSocketTask`.
- One in-flight command at a time, UUID command IDs, expected revisions, replay only with the identical ID/body, and authoritative snapshot convergence before enabling another action.
- Explicit foreground/background presence, jittered reconnect, reachability hints, eight-second initial sync timeout, and diagnostic connection states.
- Redacted snapshots are decoded into optional values. Never persist or log private drawn cards or raw frames.

Do not store passwords just to recreate sessions. The server's signed cookies are the session. If a later credential-remembrance feature is approved, use Keychain Services and keep it separate from game storage.

Unknown, malformed, or non-JSON error responses use a safe local fallback. This preserves forward compatibility without displaying untrusted server detail. The real access-cookie round trip is exercised against an isolated local `server.mjs` process by `./scripts/ios-build-test.sh --networking-contracts`; unit tests continue to use `URLProtocol` for malformed and boundary cases.

### SkyjoPersistence

Use an actor-isolated SwiftData store with explicit `VersionedSchema` and `SchemaMigrationPlan` types. Persist game/outbox bodies as versioned Codable `Data` envelopes inside small record models rather than turning the game graph into SwiftData relationships. Keep model contexts inside the persistence boundary; do not make view models responsible for storage.

Required stores:

- At most one active `SoloSessionRecord` per owner partition (`guest` or `account:<uuid>`).
- A signed-in-only idempotent `StatsOutboxRecord` keyed by stable game UUID.
- Small nonsecret preferences through `UserDefaults`.
- Session cookies through the configured cookie store.
- Secrets only through Keychain, if any are introduced.

Do not enable CloudKit in v0.1.0. Cross-device merge and account-partition behavior require a separate design.

Solo replacement is transactional: persist the new validated session first, then remove the prior one. A failed replacement leaves the old game recoverable. Corrupt or incompatible records are quarantined or removed with a user-facing recovery message.

### SkyjoDesignSystem

- Card, grid, table band, player summary, score, connection banner, badges, controls, spacing, typography, colors, sounds, and haptics.
- Semantic roles and accessibility labels live alongside the reusable component.
- Dynamic Type and safe-area behavior are requirements, not later overrides.
- Animations use semantic events, stable IDs, and `accessibilityReduceMotion` alternatives.

### App And Features

- `AppModel` is `@MainActor` and owns the implemented access/account/home/stats navigation plus authenticated product state. It publishes explicit loading, access-required, account-required, offline, empty, disabled/ended-session, not-ready, upgrade-required, and safe failure states.
- Account-generation and per-request identity guards discard stale bootstrap, profile, password, logout, stats, game-detail, and player-history responses. Logout and replacement reset navigation to Home before establishing the next account state.
- Each feature has a small observable model whose dependencies are injected as protocols.
- Long-lived work is owned by actors/services, not detached `Task` calls in views.
- Navigation state is typed and restorable where safe. Invite routes are validated before they affect state.
- SwiftUI views render state and send intents; they do not implement game rules or WebSocket framing.
- Passwords are cleared after submission and never stored or logged; session cookies never enter UI state. Native admin remains intentionally web-only, and the Account screen links the public-release deletion dependency tracked by issue #192.

## State Ownership

```text
SwiftUI view intent
  -> @MainActor feature model
    -> domain reducer (solo) OR RoomConnection actor (multiplayer)
      -> atomic local store OR server protocol-v2 command
        -> validated state/snapshot
          -> feature model publishes render state
```

For multiplayer, optimistic board mutation is prohibited. A tap may show a short pending affordance, but the board advances only from the server snapshot carrying the next revision. For solo, the pure reducer advances immediately and the durable store follows; a persistence warning must not corrupt the in-memory turn.

## Realtime State Machine

Native states mirror the established web client: `idle`, `connecting`, `connected`, `reconnecting`, `offline`, and `error`.

- Connect to `wss://skyjo.groundworkrevops.com/rooms` with both valid server cookies.
- Send exactly one create/join request after open.
- Treat the first valid personalized snapshot/resync as synchronization.
- Publish `set-presence` after synchronization and on foreground/background transitions.
- Preserve a healthy socket across ordinary focus/scene changes.
- Use jittered delays based on 0.5, 1, 2, 4, 8, 15, and 30 seconds.
- Rejoin using the last room code and server-issued player ID; the account ID remains the authority for seat ownership.
- Disable commands while offline, unsynchronized, or awaiting a command result.
- On stale/future revision, accept the `resync`, clear the rejected pending action, explain it, and require a fresh user intent.
- An exact replay uses the same command ID, expected revision, and action. Never generate a new ID for an uncertain in-flight command.

`URLSessionWebSocketTask` handles WebSocket transport and control frames. Integration tests must still prove compatibility with the server's 15-second heartbeat and half-open termination behavior.

## Native-Specific Backend Work

IOS-2 adds two native-enabling capabilities to the repository:

1. The pre-gate JSON access-session endpoint, stable `{ code, error }` API failures, and an `ACCESS_REQUIRED` JSON response for unauthenticated API requests. The legacy HTML `/login` and PWA `error` message fallback remain intact.
2. Versioned JSON Schemas and deterministic, sanitized fixtures under `contracts/v1/`.

These are repository capabilities, not a claim that production has been promoted beyond the dated baseline in `README.md`. IOS-5 consumes them with the typed native HTTP/session client and accessible access/account/home/stats shell described above. Its local simulator/server evidence proves source compatibility, not production promotion or native distribution. Remaining additive backend work is:

1. A JSON invite redemption contract for universal-link handoff.
2. `apple-app-site-association` hosting and Associated Domains.
3. Authenticated APNs device registration/unregistration and APNs provider delivery. VAPID web subscriptions cannot receive native APNs notifications.

All additions must leave the current PWA and web-push paths working. Deploy server support before a native build depends on it; do not roll production back to a server that lacks a contract already required by a distributed native build.

## Security And Privacy

- HTTPS/WSS only; no App Transport Security exceptions for production.
- Never pin a single certificate unless an explicit rotation strategy is accepted.
- Redact email, cookies, passwords, invite tokens, device tokens, room frames, hidden values, and drawn-card values from logs.
- Use `Logger` categories and privacy annotations; diagnostics expose release/protocol/status, not secrets or raw state.
- Validate every decoded payload, array bound, identifier length, revision, URL path, and enum. A decoding failure closes or quarantines the affected flow safely.
- Universal links may navigate to a lobby/invite review only; they never directly mutate or delete user data.
- Add `PrivacyInfo.xcprivacy` before external distribution and keep App Store privacy answers consistent with actual account, chat, stats, and notification data.
- Do not add analytics or crash-reporting SDKs without a separate privacy/supply-chain review.

## Architecture Change Rule

A PR that replaces SwiftUI, embeds the PWA, changes the server-authoritative boundary, adds a non-SPM dependency, changes the minimum OS, or introduces a new persistent store must add an ADR under `docs/native-ios/adr/` and update the handoff manifest.
