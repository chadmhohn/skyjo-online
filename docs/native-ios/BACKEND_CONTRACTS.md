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

## Two Session Layers

The service has two distinct signed HttpOnly cookies:

1. Outer access cookie, default name `skyjo_session`. It admits requests past the private shared-password gate.
2. Account cookie, default name `skyjo_account`. It identifies a signed-in account.

Both use path `/`, `SameSite=Lax`, a finite Max-Age, and `Secure` in production. The WebSocket upgrade requires both a valid outer session and a current account session. Use one dedicated `URLSession`/cookie jar for HTTP and WebSocket requests so the handshake receives both cookies.

Do not extract, log, copy into `UserDefaults`, or manually expose HttpOnly cookie values. Do not bundle the shared password.

### Outer Access Flow

The existing PWA continues to submit `POST /login` as `application/x-www-form-urlencoded` with `password` and `next`; success sets the access cookie and responds with a 303. Its GET page, redirect behavior, and browser logout flow remain unchanged.

IOS-2 adds an API-only surface handled before the outer access redirect:

- `GET /api/access/session` -> HTTP 200 `{ "authenticated": boolean }`. A missing, expired, invalid, or malformed cookie yields `false`, not a redirect or server error.
- `POST /api/access/session` requires `Content-Type: application/json` and exactly `{ "password": string }`. The password must contain 1-4096 Unicode code points; the same bound is enforced for the configured access secret at server startup. Success returns HTTP 200 `{ "authenticated": true }` and sets the existing signed outer-access cookie. A wrong password returns HTTP 401 `ACCESS_AUTHENTICATION_FAILED` and sets no cookie.
- `DELETE /api/access/session` is idempotent and returns HTTP 200 `{ "authenticated": false }`. It expires both outer-access and account cookies and best-effort revokes the presented account session server-side.
- Other methods return HTTP 405 `METHOD_NOT_ALLOWED` with `Allow: GET, POST, DELETE`.

Malformed JSON, a non-object body, an unsupported media type, an invalid shape/bound, and an oversized body use `INVALID_JSON`, `EXPECTED_JSON_OBJECT`, `UNSUPPORTED_MEDIA_TYPE`, `INVALID_REQUEST`, and `REQUEST_TOO_LARGE` respectively. Success and error responses are JSON with `Cache-Control: no-store`.

The endpoint reuses the established cookie signing, name, path, lifetime, HttpOnly, SameSite, and production Secure behavior, so the PWA, HTTP APIs, and WebSocket upgrade see the same outer session. It does not introduce a new access-specific rate limiter; the server retains the existing outer-gate posture, generic authentication message, constant-time secret comparison, request bounds, and no-secret logging. Any future throttling must cover both JSON and legacy HTML login without breaking invite/browser behavior.

## Account And Stats HTTP API

All routes below require the outer access session. Authenticated routes additionally require the account cookie. IOS-2 normalizes JSON API failures to the stable object `{ "code": string, "error": string }` described by `contracts/v1/schemas/api-error.schema.json`. `code` is the machine-readable branch key; `error` remains the sanitized user-facing string consumed by the PWA, so adding the sibling field is backward compatible. Canonical producers emit the exact envelope, while clients must tolerate additive response fields.

An unauthenticated request to `/api/*`, except the pre-gate access-session endpoint itself, receives HTTP 401 `{ "code": "ACCESS_REQUIRED", "error": "Skyjo access is required." }` rather than an HTML login redirect. Browser page requests still redirect to `/login`. Do not confuse `ACCESS_REQUIRED` with `ACCOUNT_AUTHENTICATION_REQUIRED`: the former means the outer shared gate is absent; the latter means the account cookie is absent, expired, disabled, or otherwise invalid after outer access succeeds.

Native clients may display the server message only for a recognized stable code. Unknown codes, malformed/non-JSON bodies, redirects, or out-of-bound error values use the safe local fallback `Request failed.` The PWA continues reading `error` and does not need to understand `code` immediately.

### Accounts

- `GET /api/account/me` -> `{ user: AccountUser | null }`.
- `POST /api/account/signup` body `{ email, displayName, password, confirmPassword }` -> 201 `{ user }` and account cookie.
- `POST /api/account/login` body `{ email, password }` -> `{ user }` and account cookie.
- `POST /api/account/logout` -> `{ ok: true }` and expired account cookie.
- `PATCH /api/account/profile` body `{ displayName }` -> `{ user }`.
- `POST /api/account/password` body `{ currentPassword, password, confirmPassword }` -> `{ ok: true }` and expired account cookie.

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

Use `src/account.tsx` as the current DTO map. A solo completion uses a stable game UUID as `clientGameKey`; the outbox must replay the same key and body until accepted. It must abort delivery if the confirmed account changes.

Admin endpoints exist under `/api/admin/users` but are outside native v0.1.0.

## Invite Contract

Current signed invites are reusable HTTPS paths returned by:

- `POST /api/rooms/invite` body `{ roomCode }` -> `{ roomCode, path, expiresAt }`.

The caller must be an account member of the room. `path` is currently `/invite/<signed-token>`. The web landing can mint short, one-use install codes and can grant the outer access cookie, but it is HTML/browser-oriented.

Native implementation adds:

- Associated Domain `applinks:skyjo.groundworkrevops.com`.
- `/.well-known/apple-app-site-association` with only the intended invite paths.
- A JSON invite inspection/redemption endpoint that accepts the opaque signed token, validates expiry and current room instance, grants only the same outer access currently granted by web invites, and returns a sanitized room code/expiry.

The app treats the token as ephemeral, never logs it, validates the URL host/path, and shows a join review screen. Invite possession never replaces account authentication or room membership rules.

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
- `{ type: "send-chat-message", text: string }` (maximum 280 characters before server cleaning)

Envelopes use exact keys. The server rejects legacy `update-state` frames with `upgrade-required`. Only one command may be in flight. Legal commands increment the room revision exactly once. An uncertain send is replayed only with the identical command ID, expected revision, and canonical action.

## Server Frames

The accepted union is:

- Personalized `snapshot`: `{ type, protocolVersion: 2, playerId, revision, room }`.
- Shared public `snapshot` after synchronization: `{ type, protocolVersion: 2, revision, room }`.
- `resync`: personalized snapshot fields plus `reason` and optional `commandId`.
- `ack`: `{ type: "ack", protocolVersion: 2, commandId, revision }`, with optional `result: "room-left"` only for leaving.
- `error`: `{ type: "error", protocolVersion: 2, code, message, commandId? }`.
- `upgrade-required`: `{ type, protocolVersion: 2, message, commandId? }`.

Validate exact fields, safe integer revisions, bounded arrays and strings, room/player membership, and `frame.revision == room.revision`. Close or fail safely on malformed server frames.

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

Existing `/api/push/*` routes store browser PushSubscription/VAPID data. Native device tokens are different and require a parallel contract, for example:

- `PUT /api/push/apns/devices/:installationId` with `{ deviceToken, environment, appVersion, locale }`.
- `DELETE /api/push/apns/devices/:installationId`.

The server associates tokens with the authenticated account, supports multiple devices, rotates tokens, removes invalid tokens, and sends minimal turn-alert payloads through APNs. Device tokens and APNs errors are secrets/sensitive operations data. Define final route schemas, stable codes, database migration, retention, and web-push coexistence before implementation.

## Native Access Verification And Rollback Compatibility

Run the focused native/server gate with:

```sh
./scripts/ios-build-test.sh --networking-contracts
```

The script builds `server-dist`, launches the real `server.mjs` on a dynamic `127.0.0.1` port, generates test-only session/invite secrets, and uses temporary SQLite and room-state paths. The loopback server and test target share a fixed, explicitly non-secret access fixture; the simulator environment receives only the dynamic loopback URL, never a secret or generated credential. Swift `URLSession` tests prove unauthenticated status, generic wrong-password failure, access-cookie persistence across requests, repeatable logout, and clearing of both cookie layers against that process. `URLProtocol` tests cover strict typed success decoding, additive fields, known/unknown/malformed errors, redirect rejection, and streamed request/response bounds. Cleanup terminates the exact child process and deletes the validated temporary state directory and raw server log. On every trappable exit, the harness scans the raw result bundle and logs for the generated server secrets and stages only verified files into the exact CI-upload directory. A match or scan failure stages only a generic safety error and fails the gate; an untrappable exit never creates an upload-eligible directory.

Compatibility and rollout rules:

- The new server remains compatible with the existing PWA: HTML access routes and cookie format are unchanged, and every API error retains the legacy `error` string while adding `code`.
- The native client is fail-closed against an older server. A pre-IOS-2 backend may redirect `/api/access/session` to HTML login or return an unrecognized API response; `AccessSessionClient` rejects the redirect/invalid payload instead of scraping HTML or treating it as authenticated.
- Promote and verify server support through the immutable release pipeline before distributing a native build that requires it. Re-check `/version`, `/readyz`, the PWA account/login/invite flows, and the focused access contract against the promoted release.
- A server rollback to a pre-IOS-2 release is safe for the PWA but removes required native access functionality. Do not perform that rollback after a dependent native build is distributed unless the native feature is disabled/fails safely and the compatibility impact is accepted. The established signed cookie format itself remains downgrade-compatible.
- Source changes and local integration success are not proof of production deployment.

## Contract Change Checklist

A contract-changing PR must include:

- Updated schema/spec and sanitized fixtures.
- TypeScript producer/consumer tests.
- Swift decoding or golden-conformance tests.
- Compatibility tests for the prior released native and web clients, or an explicit protocol-version bump.
- Redaction/logging tests.
- Updated handoff manifest and this document.
