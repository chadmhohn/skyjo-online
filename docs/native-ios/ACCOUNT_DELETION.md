# Account Deletion And Retention

Skyjo lets a signed-in player permanently delete an account from both the native Account screen and the web Account page. Support contact is not required.

## Confirmation Contract

`DELETE /api/account` requires the current authenticated account cookie, JSON media, no query string, and exactly:

```json
{
  "currentPassword": "the current account password",
  "confirmation": "DELETE"
}
```

The server re-verifies the current password immediately before deletion. The final client action is disabled until the player enters a password and the exact uppercase confirmation. A wrong password, stale credential proof, last-active-admin rule, or unavailable durable room store leaves the account active and returns a stable error.

## Data Removed

On success, one SQLite transaction removes the account profile, email, password verifier, every account session, Web Push subscription, APNs device registration, and account-owned solo game history. The native client and PWA then atomically remove that account's local solo save and undelivered stats-outbox partition. Guest saves and another account's local partition are not touched. Clearing the confirmed owner first aborts in-flight local delivery and broadcasts the owner change to other browser tabs.

`SKYJO_ADMIN_INITIAL_PASSWORD` is an empty-database-only bootstrap. It cannot recreate a deleted bootstrap administrator or promote a later account that reuses the email. If the external deletion ledger contains any tombstone, new bootstrap creation remains disabled even when reconciling an old backup removes its only account. The last-active-admin rule ensures an ordinary live deletion cannot leave the database without an administrator.

The server first proves the room store is writable without changing room state, then records the external deletion tombstone as the irreversible commit point. Active rooms are staged and durably written before the SQLite deletion completes. The deleted seat becomes a disconnected AI seat named `Deleted player`; a waiting-room seat is removed instead so waiting rooms never persist AI players. Authored active-room chat messages are removed, notification delivery is blocked and drained, and the remaining room can continue. Sockets are disconnected only after the database commit. A room-persistence or stale-proof failure before the tombstone restores the live room snapshot and leaves the account active; any failure after the tombstone is completed from that durable record before the request can report success.

## Retained And Anonymized Data

Completed multiplayer scores are shared history for the remaining players. Those rows remain, but the deleted account ID is set to `NULL`, the copied display name becomes `Deleted player`, the private room code and idempotency key are removed, and copied names/free-form logs in the completed-state journal are scrubbed. Aggregates are calculated only from the anonymized rows and can no longer open the deleted player's profile.

Active rooms expire under the existing six-hour stale-room policy. Completed anonymized multiplayer results currently have no automatic expiration because they no longer contain an account identity; deleting game history later is a separate product-retention decision.

Production state backups are immutable and are not rewritten in place. The maximum retention for any production copy containing account source data is 12 months from creation. The scheduled set enforces 30 daily and 12 monthly snapshots; privileged pre-activation, bootstrap, migration, or incident copies sit outside that automatic pruning namespace and must be inventoried, date-stamped, access-controlled, and manually destroyed before the same 12-month limit. Before the database deletion commits, the server durably records the account UUID and deletion timestamp in `account-deletions.json`. This separate security ledger contains no email or display name, is retained for the life of the service with no automatic expiration, and is not part of release rollback or state-backup payloads. Server startup and every isolated restore reapply it to SQLite and room state before the candidate can be used, so a pre-deletion backup cannot resurrect credentials, sessions, push registrations, solo data, chat, or account identity. Automatic live restore remains forbidden.

## Failure And Recovery

- Before the server returns success, the account remains usable if password verification or durable room cleanup fails.
- After the server returns success, all server sessions are already revoked. A native local-cleanup failure is reported explicitly and can be completed by reinstalling the app; it cannot resurrect the server account.
- Deletion is destructive. Backup/restore drills verify the post-deletion database and anonymized history, but normal rollback never restores an account into live traffic.

## Privacy And Store Disclosures

The App Store privacy answers declare account identifiers, email address, gameplay content, and product interaction as linked to the user and used only for app functionality; they are not used for tracking or sold. After deletion, non-account-linked multiplayer score history remains, account source data may remain in restricted backups for at most 12 months, and the restricted deletion-safety ledger retains only the account UUID and deletion timestamp indefinitely as described above.
