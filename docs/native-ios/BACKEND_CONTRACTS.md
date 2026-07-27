# Backend Contracts For The Native Client

This document maps the deployed v0.3.2 behavior. The executable TypeScript validators remain authoritative until the planned language-neutral schemas and fixtures are committed. Do not infer a contract from rendered HTML or from a captured production room.

## Compatibility Baseline

| Contract | Current value | Canonical implementation |
| --- | ---: | --- |
| Release | `v0.3.2` / `130114e745c66c9f72305f05a0366e3f0ca10915` | Git tag and public `/version` |
| Database schema | 2 | `server-migrations.mjs`, `server-readiness.mjs` |
| Room persistence | 2 with legacy readers | `server-room-persistence.mjs` |
| Multiplayer protocol | 2 | `src/protocolV2.ts` |
| Explicit presence | 1 | `src/protocolV2.ts`, `src/serverRealtime.ts` |
| Shared snapshot envelope | 2 | `src/protocolV2.ts`, `src/serverRealtime.ts` |
| Solo AI strategy | 1 | `src/aiContracts.ts`, `src/soloAiSetup.ts` |

The native app must refuse unsupported protocol versions with a clear upgrade message. The server must retain PWA compatibility whenever a native endpoint is added.

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

### Current Outer Access Flow

The existing PWA submits `POST /login` as `application/x-www-form-urlencoded` with `password` and `next`; success sets the access cookie and responds with a 303. This can bootstrap a development client, but parsing an HTML-oriented flow is not the long-term native contract.

Before native access UI is considered complete, add and test an additive JSON surface that is handled before the outer access redirect:

- `GET /api/access/session` -> `{ authenticated: boolean }`.
- `POST /api/access/session` with `{ password: string }` -> `{ authenticated: true }` plus the existing access cookie.
- `DELETE /api/access/session` -> `{ authenticated: false }` plus expired access/account cookies.

Use generic authentication errors and the existing rate-limiting posture. The PWA `/login` behavior remains unchanged.

## Account And Stats HTTP API

All routes below require the outer access session. Authenticated routes additionally require the account cookie. Current errors are not yet one stable contract: many routes use `{ error: string }`, while some validation failures escape as plain text. The native-contract issue must introduce stable machine-readable error codes without breaking the PWA's message fallback.

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

## Contract Change Checklist

A contract-changing PR must include:

- Updated schema/spec and sanitized fixtures.
- TypeScript producer/consumer tests.
- Swift decoding or golden-conformance tests.
- Compatibility tests for the prior released native and web clients, or an explicit protocol-version bump.
- Redaction/logging tests.
- Updated handoff manifest and this document.
