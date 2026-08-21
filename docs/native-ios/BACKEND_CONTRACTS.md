# Backend Contracts For The Native Client

This document separates the dated deployed v0.3.2 baseline from native-enabling contracts present in the IOS-2 repository change. Production was still verified as v0.3.2 at the SHA below when the handoff was reviewed; the access API, stable API-error envelope, and `contracts/v1` assets described here are source/PR capabilities until an immutable release is promoted and reverified. Do not infer a contract from rendered HTML or from a captured production room.

## Compatibility Baseline

| Contract | Current value | Canonical implementation |
| --- | ---: | --- |
| Release | `v0.3.2` / `130114e745c66c9f72305f05a0366e3f0ca10915` | Git tag and public `/version` |
| Portable contract bundle | 1 | `contracts/v1/`, `contracts/README.md` |
| Database schema | 2 | `server-migrations.mjs`, `server-readiness.mjs` |
| Room persistence | 2 with legacy readers | `server-room-persistence.mjs` |
| Multiplayer protocol | 2 | `src/protocolV2.ts` |
| Explicit presence | 1 | `src/protocolV2.ts`, `src/serverRealtime.ts` |
| Shared snapshot envelope | 2 | `src/protocolV2.ts`, `src/serverRealtime.ts` |
| Solo AI strategy | 1 | `src/aiContracts.ts`, `src/soloAiSetup.ts` |

The native app must refuse unsupported protocol versions with a clear upgrade message. The server must retain PWA compatibility whenever a native endpoint is added.

### Contract Registry And Independent Version Axes

`contracts/v1/schemas/` contains the language-neutral JSON Schemas for authoritative game state, redacted public room snapshots, protocol-v2 client/server frames, access/account DTOs, stats DTOs, operational DTOs, and stable JSON API errors. `contracts/v1/fixtures/` is the deterministic, sanitized corpus generated from canonical TypeScript producers. Its `manifest.json` records a SHA-256 digest for every generated fixture file.

Contract bundle version 1 identifies this portable schema/fixture layout only. It is independent of:

- PWA/server release and source SHA.
- Native marketing/build versions.
- Multiplayer protocol 2, shared snapshot envelope 2, and presence 1.
- Database schema 2 and room persistence 2.
- Solo AI strategy 1.

A change under `contracts/v1` does not automatically bump any other axis, and a runtime protocol/schema bump does not automatically rename the contract bundle. Evaluate each affected axis explicitly. Runtime negotiation continues to use the relevant protocol/envelope fields, not the directory name `v1`.

Use the nonwriting checks for ordinary verification:

```sh
npm run contracts:fixtures:check
npm run test:unit:contracts
```

When intentionally changing a schema or canonical producer, run `npm run contracts:fixtures:update`. The generator injects seeded randomness plus scripted clock/UUID/code sources and asserts their expected consumption; it does not depend on wall time or ambient randomness. It writes a temporary sibling directory, validates and hashes the complete corpus, and atomically replaces the fixture directory only when its existing git state is clean. Review the semantic/privacy diff and commit the schema, producer/generator, fixtures, and manifest together. The fixtures are synthetic and must never contain credentials, cookies, tokens, production rooms, or private wire captures.

## Hosts And Transport

- Production HTTP base: `https://skyjo.groundworkrevops.com`.
- Production WebSocket: `wss://skyjo.groundworkrevops.com/rooms`.
- Local default: `http://127.0.0.1:4180` and `ws://127.0.0.1:4180/rooms`.
- Production requires HTTPS/WSS. Do not add an App Transport Security exception for production.
- JSON requests use UTF-8 and `Content-Type: application/json` unless explicitly documented as the legacy form login.

Debug builds read the base URL from a nonsecret build setting. Release builds pin the production hostname through a committed release configuration, not a user-editable runtime field.

## Public Operational Endpoints

These endpoints do not require either session cookie and return `Cache-Control: no-store`:

- `GET /healthz` -> plain text `ok`. Liveness only.
- `GET /version` -> `{ releaseSha, buildTimestamp, protocolVersion }`.
- `GET /readyz` -> `{ status, releaseSha, schemaVersion, protocolVersion, checks: { database, roomState, lastPersist } }`; HTTP 503 when a required check is not `ok`.

Never use `/healthz` as proof that accounts or rooms are ready.

## Public Access And Account Session

Issue #228 retires the private shared-password layer before external TestFlight. Browser pages, guest solo play, account signup/sign-in, and the WebSocket handshake no longer require `skyjo_session`. The only active authentication cookie is `skyjo_account`, which identifies an optional signed-in account and is still required for account-only APIs and multiplayer admission.

The legacy access surface remains bounded and no-store solely so already-installed native clients roll forward safely:

- `GET /api/access/session` always returns HTTP 200 `{ "authenticated": true }` without creating a cookie.
- `POST /api/access/session` drains at most 256 KiB without parsing, comparing, persisting, or logging a password-shaped body; it returns HTTP 200 `{ "authenticated": true }`. A legacy access cookie may still be set for downgrade compatibility, but no authorization decision reads it.
- `DELETE /api/access/session` remains an idempotent full sign-out compatibility operation. It revokes the presented account session when possible, expires both legacy and account cookies, and returns `{ "authenticated": true }` because public access remains available.
- `GET /login` redirects to the safe `next` path or `/`; legacy `POST /login` also redirects without inspecting the former password field.
- Other access-session methods return HTTP 405 `METHOD_NOT_ALLOWED`; oversized bodies remain `REQUEST_TOO_LARGE`.

Do not extract, log, copy into `UserDefaults`, or manually expose account-cookie values. Production may retain the old access secret temporarily for rollback, but startup and authorization no longer depend on it.

## Account And Stats HTTP API

Public account-status/signup/login routes require no cookie. Authenticated routes require only the account cookie. IOS-2 normalizes JSON API failures to the stable object `{ "code": string, "error": string }` described by `contracts/v1/schemas/api-error.schema.json`; clients must tolerate additive response fields. `ACCESS_REQUIRED` remains a recognized legacy error only so a native app can classify an accidental rollback as upgrade-required rather than presenting the retired shared-password form.

Native clients may display the server message only for a recognized stable code. Unknown codes, malformed/non-JSON bodies, redirects, or out-of-bound error values use the safe local fallback `Request failed.` The PWA continues reading `error` and does not need to understand `code` immediately.

### Accounts

- `GET /api/account/me` -> `{ user: AccountUser | null }`.
- `POST /api/account/signup` body `{ email, displayName, password, confirmPassword }` -> 201 `{ user }` and account cookie.
- `POST /api/account/login` body `{ email, password }` -> `{ user }` and account cookie.
- `POST /api/account/logout` -> `{ ok: true }` and expired account cookie.
- `PATCH /api/account/profile` body `{ displayName }` -> `{ user }`.
- `POST /api/account/password` body `{ currentPassword, password, confirmPassword }` -> `{ ok: true }` and expired account cookie.

Signup is limited to 10 attempts per trusted client address per hour, and login is limited to 20 attempts per trusted client address per five minutes. Exhaustion returns HTTP 429 `ACCOUNT_RATE_LIMITED` with `Retry-After`; the same generic response covers both routes.

`AccountUser` currently contains:

```text
id: UUID
email: string
displayName: string
role: "admin" | "player"
disabled: boolean
createdAt: epoch milliseconds
updatedAt: epoch milliseconds
lastLoginAt: epoch milliseconds | null
```

Before public App Store submission, add authenticated account deletion with explicit recent-password confirmation, transactional removal/anonymization rules, session revocation, native UI, and tests. Do not invent deletion semantics inside the client.

### Stats

- `GET /api/stats/summary` -> `StatsSummary`.
- `GET /api/stats/games` -> `{ games: StatsGame[] }`.
- `GET /api/stats/games/:gameId` -> `{ game: StatsGame }`.
- `GET /api/stats/players/:userId` -> `{ user, summary, games }`.
- `POST /api/stats/single-player` body `{ state, clientGameKey, completedAt?, expectedAccountUserId }` -> 201 `{ game }`.

Use `src/account.tsx` as the current DTO map. A solo completion uses a stable game UUID as `clientGameKey`; the outbox replays the same key and immutable body until accepted. The native client accepts only the exact 201 success with a schema-valid `game.mode == "single"` response. `ACCOUNT_AUTHENTICATION_REQUIRED` invalidates the account session; legacy `ACCESS_REQUIRED` indicates an incompatible rollback and routes to upgrade-required. Local request-size rejection plus recognized size, invalid-payload, and unsupported-version responses are permanent blockers; transient transport/server failures remain retryable. If the confirmed account changes across any await, delivery aborts without mutating the durable row.

Admin endpoints exist under `/api/admin/users` but are outside native v0.1.0.

### IOS-5 Native HTTP Boundary

The native implementation uses one injected persistent cookie jar for the optional account session and legacy compatibility cookies. Bootstrap verifies readiness/version and then loads the optional account directly; it does not call the retired access gate. `SkyjoAPIClient` retains the compatibility access-session actor and exposes typed current-account, signup/login/logout, profile/password, stats summary/list/detail/player, solo-stats submission, readiness, and version operations without exposing cookies or passwords to SwiftUI state. It rejects redirects and unexpected final URLs, retains the legacy access route's 64 KiB response cap, caps general responses at 2 MiB, maps recognized stable error codes, and replaces unknown or malformed server detail with a safe local message.

Operational DTOs inspect schema/protocol axes before version-specific status, checks, release identity, or timestamp fields. They accept only schema 2 and protocol 2; future axes route to an explicit upgrade-required state even when that future payload introduces unknown status values or fields. Account and stats responses validate the committed schema's UUID versions/variants, Unicode string bounds, safe timestamps and scores, enum and collection bounds, and requested/returned detail identities without inventing producer-only constraints for paged or additive responses. Contract-required nullable fields must be present and may decode to `nil`, while omission fails closed; additive response fields remain ignored for forward compatibility. Swift tests decode the canonical valid/invalid HTTP fixtures from `contracts/v1/fixtures/`, exercise schema boundary mutations, request and streaming bounds, loaded/detail/player/offline-retry model and UI flows, and prove direct signup plus the account cookie survive client recreation through the complete local account/stats flow. Native admin remains a web-only link. Public-release account deletion is still blocked on [issue #192](https://github.com/chadmhohn/skyjo-online/issues/192); IOS-5 does not invent or call a deletion API.

## Invite Contract

Reusable signed HTTPS invites are returned by:

- `POST /api/rooms/invite` body `{ roomCode }` -> `{ roomCode, path, expiresAt }`.

The caller must be an account member of the room. `path` is `/invite/<signed-token>`. The web landing presents the ordinary reusable five-character room code for the Home Screen path and no longer mints short install codes. An explicit `?open=browser` redemption still emits the legacy compatibility cookie and redirects to the lobby. The retired `/invite-code` consumer remains bounded only for an already-minted rollback code. Neither current path grants an account session, room membership, or a player seat.

Issue #202 adds the backend-only native handoff in repository source. This is not evidence that production has been promoted or that Apple has accepted the Associated Domains configuration.

### Apple App Site Association

- `GET` and `HEAD /.well-known/apple-app-site-association` are public direct HTTP 200 responses with `Content-Type: application/json`, `Cache-Control: public, max-age=3600`, no redirect, and no cookie.
- The exact document has one `applinks.details` item and one full Apple application identifier. Its first component excludes `/invite/*` when query item `open` equals `browser`; its second component includes only `/invite/*`. It contains no `webcredentials`, unrelated service, broad route, or wildcard domain.
- `SKYJO_APPLE_APPLICATION_IDENTIFIER` supplies the complete application-identifier prefix plus `com.groundworkrevops.skyjo`. The prefix is not inferred from the Team ID. Production-like startup rejects a missing, malformed, placeholder, or fixed synthetic identifier.
- Development, tests, and the isolated deployment canary use only `TESTSKYJ01.com.groundworkrevops.skyjo`. The canary exception requires the deployment controller's exact `/var/tmp/skyjo-deploy/<validated-run-id>/release` path shape in `SKYJO_CANARY_RELEASE_DIR` and requires the running server module to reside in that same directory; an arbitrary or spoofed value cannot authorize the synthetic identifier for the production service.

### Native JSON Redemption

`POST /api/rooms/invite/redeem` is public before account authentication. It requires `Content-Type: application/json` and the exact request:

```json
{ "token": "<opaque-signed-token>" }
```

The token is accepted only in the body; query parameters are rejected. It must match the established signed-token alphabet/shape within 2,048 characters. The server validates its HMAC, version, expiry, room code, v4 room-instance UUID, and the currently live room instance. Success is a direct HTTP 200 with `Cache-Control: no-store`, exactly one legacy compatibility cookie, and the exact sanitized body:

```json
{ "roomCode": "ABCDE", "expiresAt": 1800003600000 }
```

Redemption does not read or create an account session, install-code row, room membership, player seat, room revision, database record, or persistence update. The token and room-instance UUID are never returned, persisted, or logged. The native token route uses the trusted client-IP selection in its own `native-token` limiter namespace and a limiter instance separate from install-code redemption. Other methods return `METHOD_NOT_ALLOWED` with `Allow: POST`.

Stable native-redemption failures are:

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `INVITE_INVALID_OR_EXPIRED` | 410 | Malformed structure/signature, unsupported token, or expired token; one generic public message |
| `INVITE_ROOM_UNAVAILABLE` | 410 | The signed token is valid but its exact room instance was deleted or replaced |
| `INVITE_RATE_LIMITED` | 429 | Trusted client-IP attempt bound reached; includes `Retry-After` |

Existing `INVALID_REQUEST`, `UNSUPPORTED_MEDIA_TYPE`, `METHOD_NOT_ALLOWED`, `REQUEST_TOO_LARGE`, `INVALID_JSON`, and `EXPECTED_JSON_OBJECT` errors cover request-contract failures. No failure sets a cookie or redirects.

The app-side consumer remains owned by #188. It must validate the HTTPS host and `/invite/` path, keep the token ephemeral, redeem it before account/room admission, and present a join review rather than mutating membership from the universal link. Its invite transport is cookie-disabled: existing same-origin cookies are attached explicitly, while response cookies remain pending until the complete direct 200 JSON/no-store body passes byte bounds, decoding, and room/expiry semantics. A redirect, transport interruption, error status, invalid media/cache header, oversized body, malformed JSON, or invalid DTO must leave the cookie jar unchanged. Invite possession never replaces account authentication or room membership rules.

Issue #202 originally added this backend without changing the then-active shared-password/account/WebSocket gates. Issue #228 later retired only the shared-password authorization decision while preserving invite validation, account authentication, room admission, cookie format for rollback compatibility, the PWA service worker, database/room schemas, protocol 2, snapshot envelope 2, presence 1, and contract-bundle version 1.

## WebSocket Admission Frames

After the authenticated socket opens, send exactly one admission frame.

Create:

```json
{
  "type": "create-room",
  "protocolVersion": 2,
  "snapshotEnvelopeVersion": 2,
  "name": "Player"
}
```

The server uses the account display name even though the compatibility frame retains `name`.

Join or rejoin:

```json
{
  "type": "join-room",
  "protocolVersion": 2,
  "presenceVersion": 1,
  "snapshotEnvelopeVersion": 2,
  "code": "ABCDE",
  "name": "Player",
  "playerId": "optional-server-issued-seat-uuid",
  "recoveryCommandId": "optional-reset-command-uuid"
}
```

Omit optional keys rather than sending null. A requested `playerId` is accepted only for the account that owns that seat. Save the server-issued `playerId` and room code after a valid personalized snapshot.

After initial synchronization, and when scene visibility changes, send:

```json
{ "type": "set-presence", "visible": true }
```

The current server sends a WebSocket ping every 15 seconds and terminates a connection that still awaits the prior pong on the next interval. Prove `URLSessionWebSocketTask` compatibility against the real Node server.

## Client Commands

All mutations use the exact envelope below. UUID command IDs are idempotency keys. `expectedRevision` is the revision of the last accepted authoritative room snapshot.

```json
{
  "type": "command",
  "protocolVersion": 2,
  "commandId": "00000000-0000-4000-8000-000000000001",
  "expectedRevision": 17,
  "action": { "type": "draw-blind" }
}
```

Valid `action` shapes:

- `{ type: "reveal-opening-card", cardIndex: 0...11 }`
- `{ type: "choose-discard" }`
- `{ type: "cancel-discard" }`
- `{ type: "draw-blind" }`
- `{ type: "replace-card", cardIndex: 0...11 }`
- `{ type: "discard-and-reveal", cardIndex: 0...11 }`
- `{ type: "set-next-round-ready", ready: boolean }`
- `{ type: "start-game" }`
- `{ type: "reset-room" }`
- `{ type: "leave-room" }`
- `{ type: "remove-player", playerId: UUID }`
- `{ type: "takeover-player-with-ai", playerId: UUID }`
- `{ type: "send-chat-message", text: string }` (maximum 280 UTF-16 code units before server cleaning)

Envelopes use exact keys. The server rejects legacy `update-state` frames with `upgrade-required`. Only one command may be in flight. Legal commands increment the room revision exactly once. An uncertain send is replayed only with the identical command ID, expected revision, and canonical action.

Chat retains the established JavaScript/PWA UTF-16 bound: 140 astral symbols (280 code units) are accepted and 141 are rejected. Swift therefore checks `String.utf16.count`, not grapheme or scalar count. Command input containing malformed surrogate data is rejected; legacy persisted producer strings are converted to well-formed Unicode and truncated without splitting a surrogate pair before persistence or public projection. Chat remains the ordinary schema-2 `text` field with no additive wire/persistence member and no protocol or persistence version change. Compatibility tests pin and execute the documented live v0.3.2 room reader and cached PWA validator source by immutable tag, commit, and reviewed SHA-256 digest.

## Server Frames

The accepted union is:

- Personalized `snapshot`: `{ type, protocolVersion: 2, playerId, revision, room }`.
- Shared public `snapshot` after synchronization: `{ type, protocolVersion: 2, revision, room }`.
- `resync`: personalized snapshot fields plus `reason` and optional `commandId`.
- `ack`: `{ type: "ack", protocolVersion: 2, commandId, revision }`, with optional `result: "room-left"` only for leaving.
- `error`: `{ type: "error", protocolVersion: 2, code, message, commandId? }`.
- `upgrade-required`: `{ type, protocolVersion: 2, message, commandId? }`.

Validate exact fields, safe integer revisions, bounded arrays and strings, room/player membership, and `frame.revision == room.revision`. Close or fail safely on malformed server frames.

### IOS-6 Native Realtime Boundary

`SkyjoAPIClient.makeRoomConnection(confirmedAccount:)` creates an actor-owned `RoomConnection` on the same dedicated cookie-aware `URLSession` used by the HTTP client, so the WebSocket upgrade receives both authenticated session layers without exposing cookie values. All connections created by one API client share the same injected reset-recovery store; the live default is one process-wide application-support file actor.

The native codec caps client frames at 16 KiB and server frames at 1 MiB, requires exact protocol-v2 keys, validates RFC UUID variant/version bits and JSON safe integers without trapping, preserves the previous PWA's UTF-16 string bounds, and rejects binary, malformed, oversized, semantically inconsistent, or privacy-invalid frames. A personalized snapshot establishes the viewer seat; later shared snapshots are accepted only for that synchronized viewer. Acknowledgement and authoritative snapshot may arrive in either order, but a command remains pending until both the matching acknowledgement revision and an accepted snapshot at that revision have converged. Reconnect replay uses the original canonical wire text, command UUID, and expected revision.

Reset-room is the only command with a durable replay record because an uncertain reset changes the room code. Before sending it, the client atomically persists exactly the confirmed account UUID, prior room code, server-issued player ID, command UUID, and expected revision in a bounded 4 KiB exact-key file. The record contains no email, display name, chat, card, cookie, or raw frame. Recovery is fenced to the same confirmed account and command. Cancellation, connection replacement, explicit disconnect, command rejection, terminal room/seat errors, and protocol upgrade clear only the matching record. A failed clear remains visibly pending, blocks further mutations, and is retried before another command or recovery operation; the destructive command is never sent before persistence succeeds.

Socket generation and lifecycle guards quarantine callbacks from retired sockets and stale actor reentrancy. The public event stream retains only the newest bounded status/snapshot/notice events, and every debug description redacts room codes, seats, command identifiers, messages, and snapshots. Invalid frames retire the affected socket, fail closed, and require a fresh synchronization before another command. `room-reset`, seat-removal/stale-seat, and `upgrade-required` terminate the affected admission and discard authoritative state before the UI can reuse it.

## Snapshot Privacy Contract

The native model must preserve these distinctions:

- Face-down grid values are `null`.
- Draw pile is a count only.
- Discard pile exposes count and visible top only.
- `hasDrawnCard` may be true while `drawnCard` is null for every non-drawing player.
- Only the active drawing player gets the private `drawnCard` object.
- Logs redact blind-drawn numeric values.
- Public room players do not expose account user IDs.

Never substitute zero or another sentinel for a hidden value. Do not put snapshots, raw frames, invite tokens, or private card values in analytics, crash logs, screenshots, pasteboards, or notification payloads.

## Reconnect And Lifecycle Contract

- Backoff bases: 500 ms, 1 s, 2 s, 4 s, 8 s, 15 s, 30 s, each jittered to 80-120%.
- Initial/synchronization timeout: 8 seconds.
- A waiting-room disconnected host transfers after 60 seconds.
- An active player seat has a 120-second grace period before host-triggered AI takeover.
- Reconnecting humans reclaim their AI-controlled seat after the current atomic AI action.
- Backgrounding sends invisible presence; foregrounding a healthy socket sends visible presence without forcing a reconnect.
- Offline commands are disabled.

Mirror the acceptance behavior in `src/roomConnection.ts`, `src/serverRealtime.ts`, `src/serverRoomLifecycle.ts`, and their unit/E2E tests.

## APNs Delta

Existing `/api/push/*` routes continue to own browser PushSubscription/VAPID data. Native device tokens use a parallel authenticated contract:

- `GET /api/push/apns/config` returns exactly `{ "enabled": boolean }`.
- `PUT /api/push/apns/devices/:installationId` accepts exactly `{ deviceToken, environment, appVersion, locale }` and returns exactly `{ "ok": true }` without echoing token material.
- Account-scoped, idempotent `DELETE /api/push/apns/devices/:installationId` returns exactly `{ "ok": true }` and remains available while provider delivery is disabled.
- `POST /api/account/logout` still accepts an empty body. Native clients may instead send exactly `{ "installationId": UUID }`; the matching account device row and session are then removed in one SQLite transaction.

All three native-push routes require the existing authenticated account cookie and reject queries. `installationId` is a canonical lowercase UUID. `environment` is exactly `development` or `production`, mapping respectively to Apple sandbox or production. `deviceToken` is lowercase, even-length hex representing 8 through 2,048 bytes; its length is deliberately not fixed at 32 bytes. `appVersion` and `locale` are 1 through 64 characters from the documented alphanumeric/dot/underscore/hyphen set. PUT requires JSON media, enforces 20 attempts per account per one-hour window, caps an account at eight active installations, and prunes registrations not refreshed for 180 days. The same retention prune runs after every successful account-store open or recovery and during the existing 30-minute housekeeping pass, so a dormant installation does not remain indefinitely just because no later push request arrives.

Stable native-push failures are:

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `INVALID_APNS_DEVICE` | 400 | Path, logout cleanup body, token, environment, or metadata is outside the exact contract |
| `APNS_NOT_CONFIGURED` | 503 | Registration is unavailable because provider delivery is coherently disabled |
| `APNS_DEVICE_LIMIT` | 409 | The account already owns the maximum active installation set |
| `APNS_REGISTRATION_RATE_LIMITED` | 429 | The account attempt window is exhausted; `Retry-After` is present |

Existing authentication, method, media, body-size, JSON, and object errors retain their stable codes. The additive `push-http.schema.json`, valid/invalid fixtures, and fixture manifest are contract-bundle-v1 assets; this does not change multiplayer protocol 2, snapshot envelope 2, presence 1, room persistence 2, public database schema 2, or bundle version 1.

The store persists only AES-256-GCM ciphertext, a 12-byte nonce, a 16-byte authentication tag, and a keyed SHA-256 fingerprint derived independently from one persistent 32-byte master key. Plaintext tokens are never stored in SQLite, backups, fixtures, logs, errors, diagnostics, or artifacts. Registration rechecks the original account session inside the same write transaction as the device upsert, so a logout, expiry, disablement, or account change that wins the race cannot recreate a registration. It rotates a stable installation, atomically reassigns a unique environment/fingerprint pair on account switch, preserves the active-device cap when the same token moves between installation IDs, cascades with eventual account deletion, and removes rows for disabled accounts. Provider cleanup is conditional on installation ID, environment, current fingerprint, and `updated_at`, so a late response cannot delete a token rotated after delivery began.

Provider enablement is all-or-nothing through `SKYJO_APNS_TEAM_ID`, `SKYJO_APNS_KEY_ID`, `SKYJO_APNS_PRIVATE_KEY_FILE`, and `SKYJO_APNS_TOKEN_KEY_FILE`. Production uses `/etc/skyjo-online/apns-provider.p8` and `/etc/skyjo-online/apns-token.key`, installed `root:skyjo` mode `0640` under a root-owned non-writable directory. The token-key file contains one canonical base64url encoding of 32 random bytes. Partial configuration, malformed IDs/keys, unsafe ownership, or writable permissions fail startup without printing values. The release artifact contains `server-apns.mjs` but never either key; the isolated canary explicitly blanks all four settings, cannot read the production key directory, and therefore cannot call Apple.

`server-apns.mjs` uses built-in `node:http2` and `node:crypto`: ES256 provider JWTs are cached for at most 50 minutes, sessions connect only to Apple's fixed sandbox/production origins, concurrency is limited to eight streams per environment with a 128-request queue, responses are bounded to 8 KiB, and requests time out after 10 seconds. Requests use topic `com.groundworkrevops.skyjo`, alert push type, priority 10, a five-minute expiry, an opaque collapse ID, and at most one bounded retry for transport failure or HTTP 429/500/503. One expired-provider-token response refreshes the JWT once. Permanent token cleanup is limited to the documented bad/unregistered token classifications; a 410 response must include an Apple timestamp at least as new as the stored registration. Authentication, configuration, throttling, and 5xx failures retain the registration.

The authoritative post-commit room event independently schedules Web Push and APNs adapters after a legal move. A failure in either adapter cannot block the other. Existing visible-live-client suppression and recovered-command deduplication remain unchanged. Native alerts cover `turn`, `round-ended`, and `game-ended` with generic visible copy. The payload contains only `aps` plus `{ version: 1, kind, route: "room", roomCode }`; it never contains a player/name, account/email, card/state/score, chat, invite, token, APNs ID, or command ID. The room code is routing data and is not rendered. A native tap must open review/recovery and never auto-join.

APNs storage has an explicit two-release database contract. Issue #203 keeps the public migration ledger and readiness contract at schema 2 while freezing `APNS_DEVICE_STORAGE_ENVELOPE` in `server-account-store.mjs`. That descriptor defines one optional `apns_devices` table with:

- `installation_id` as the primary key and `user_id` as a cascading foreign key to `users`;
- a checked `development|production` environment;
- storage-class-enforced BLOB ciphertext, 12-byte nonce, 16-byte authentication tag, and 32-byte keyed fingerprint;
- bounded app-version and locale strings plus integer-storage-class creation/update timestamps;
- unique `(environment, token_fingerprint)`, account/update, and retention indexes.

The envelope release accepts the table absent or exact-present, rejects any partial/widened column, storage-class constraint, foreign-key or index drift, and rejects all persistent database triggers or views while the optional table is present so baseline account activity cannot indirectly mutate rows and no undeclared projection can expose them. It never creates or queries device rows. Startup, readiness, backup, restore, concurrent opens, and shutdown preserve exact-present rows byte-for-byte. The #204 feature executes this same descriptor transactionally and idempotently, validates it on every open/readiness check, and does not redefine the SQL or advance the migration ledger.

Promote the envelope release first through an immutable tag. Confirm it as healthy production `current`, then promote one later release so the envelope tag is the verified `previous` rollback anchor before #204 may create storage. After `apns_devices` exists, code-only rollback must never target a pre-envelope release. Merge and CI evidence are not deployment evidence, and native #189 must not distribute a dependent build until the #204 feature release and sanitized production endpoint/provider/rollback proof complete.

## Native Access Verification And Rollback Compatibility

Run the focused native/server gate with:

```sh
./scripts/ios-build-test.sh --networking-contracts
```

The script builds `server-dist`, launches the real `server.mjs` on a dynamic `127.0.0.1` port without an access password, generates test-only session/invite secrets, and uses temporary SQLite and room-state paths. The simulator environment receives only the dynamic loopback URL, never a secret or generated credential. Swift `URLSession` tests prove open access, direct signup/current-account/profile/password/logout, stats summary/list/detail/player requests, account-cookie client recreation, repeatable logout, legacy access-route compatibility, and clearing of both cookie names against that process. Canonical `contracts/v1` fixtures and `URLProtocol` tests cover strict typed success decoding, required-nullable fields, additive fields, version compatibility, known/unknown/malformed errors, redirect rejection, and streamed request/response bounds. Cleanup terminates the exact child process and deletes the validated temporary state directory and raw server log. On every trappable exit, the harness scans the raw result bundle and logs for the generated server secrets and stages only verified files into the exact CI-upload directory. A match or scan failure stages only a generic safety error and fails the gate; an untrappable exit never creates an upload-eligible directory.

Compatibility and rollout rules:

- Issue #228 must be promoted before a native build that skips access status is distributed. The server remains compatible with older native clients because the bounded access endpoints report authenticated and may emit/clear the established cookie format.
- A rollback to a gated server may return `ACCESS_REQUIRED`; the current native client treats that as upgrade-required and never restores the retired password UI.
- Re-check `/version`, `/readyz`, open PWA/account/signup/invite flows, the legacy access compatibility route, and an account-only WebSocket against the promoted release.
- Keep the former production access secret available only when an explicitly selected older rollback target still requires it; current startup, authorization, canary, and deployment smoke do not depend on it.
- Source changes and local integration success are not proof of production deployment.

## Contract Change Checklist

A contract-changing PR must include:

- Updated schema/spec and sanitized fixtures.
- TypeScript producer/consumer tests.
- Swift decoding or golden-conformance tests.
- Compatibility tests for the prior released native and web clients, or an explicit protocol-version bump.
- Redaction/logging tests.
- Updated handoff manifest and this document.
