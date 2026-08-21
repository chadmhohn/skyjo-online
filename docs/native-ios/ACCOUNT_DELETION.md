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

On success, one SQLite transaction removes the account profile, email, password verifier, every account session, Web Push subscription, APNs device registration, and account-owned solo game history. The native client then removes that account's local solo save and undelivered stats-outbox partition. Guest saves and another account's local partition are not touched.

`SKYJO_ADMIN_INITIAL_PASSWORD` is an empty-database-only bootstrap. It cannot recreate a deleted bootstrap administrator or promote a later account that reuses the email. The last-active-admin rule ensures deletion cannot leave the database without an administrator.

Active rooms are scrubbed and durably written before the SQLite deletion commits. The deleted seat becomes a disconnected AI seat named `Deleted player`, authored active-room chat messages are removed, notification delivery stops, and the remaining room can continue. A room-persistence failure prevents account deletion from reporting success.

## Retained And Anonymized Data

Completed multiplayer scores are shared history for the remaining players. Those rows remain, but the deleted account ID is set to `NULL`, the copied display name becomes `Deleted player`, the private room code and idempotency key are removed, and copied names/free-form logs in the completed-state journal are scrubbed. Aggregates are calculated only from the anonymized rows and can no longer open the deleted player's profile.

Active rooms expire under the existing six-hour stale-room policy. Completed anonymized multiplayer results currently have no automatic expiration because they no longer contain an account identity; deleting game history later is a separate product-retention decision.

Production state backups are immutable and are not rewritten in place. Deleted source data can remain in the access-controlled rotating backup set until the existing 30 daily and 12 monthly snapshots expire. Backups are used only for disaster recovery; any isolated restore must reapply deletions made after the selected snapshot before it can be promoted to live traffic. Automatic live restore remains forbidden.

## Failure And Recovery

- Before the server returns success, the account remains usable if password verification or durable room cleanup fails.
- After the server returns success, all server sessions are already revoked. A native local-cleanup failure is reported explicitly and can be completed by reinstalling the app; it cannot resurrect the server account.
- Deletion is destructive. Backup/restore drills verify the post-deletion database and anonymized history, but normal rollback never restores an account into live traffic.

## Privacy And Store Disclosures

The App Store privacy answers continue to declare account identifiers, email address, gameplay content, and product interaction as linked to the user while the account exists. They are used only for app functionality, are not used for tracking, and are not sold. After deletion, only non-account-linked multiplayer score history and restricted rotating backups remain as described above.
