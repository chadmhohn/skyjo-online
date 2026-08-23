# Skyjo State Backup and Isolated Restore

Skyjo state consists of the SQLite account/history database, the versioned room JSON document, and the checksum-validated release identity. Backups validate all three before they are accepted.

## Create and verify a backup

Run from the release checkout with `SKYJO_DB_FILE` and `SKYJO_ROOMS_FILE` set to the service values:

```sh
node scripts/backup-state.mjs --output /var/backups/skyjo-online/backup-YYYYMMDDTHHMMSSZ
node scripts/verify-state-backup.mjs --backup /var/backups/skyjo-online/backup-YYYYMMDDTHHMMSSZ
```

Explicit source flags are available for canary and test state:

```sh
node scripts/backup-state.mjs \
  --database /path/to/skyjo.sqlite \
  --rooms /path/to/rooms.json \
  --release /path/to/dist/release.json \
  --output /fresh/backup-directory
```

The output directory must be fresh. It contains only `skyjo.sqlite`, `rooms.json`, `release.json`, and `manifest.json`. SQLite is captured through its online backup API and is rejected unless integrity, foreign keys, migration checksums, room format, release identity, sizes, and SHA-256 checksums all validate.

## Restore for verification

Restore only to a new isolated directory:

```sh
node scripts/restore-state.mjs \
  --backup /var/backups/skyjo-online/backup-YYYYMMDDTHHMMSSZ \
  --destination /var/tmp/skyjo-restore-check-YYYYMMDDTHHMMSSZ
```

The restore command refuses live data locations, non-empty destinations, symlinks/junctions, nested or escaping paths, and any backup that fails verification. It never writes to `SKYJO_DB_FILE` or `SKYJO_ROOMS_FILE` and has no force/overwrite option. After checksum verification, it automatically reapplies the external `SKYJO_ACCOUNT_DELETION_LEDGER_FILE` (defaulting to `account-deletions.json` beside the live database) to the isolated SQLite and room copies. The runtime materializes an empty ledger on first startup, and the ledger is deliberately excluded from rollback payloads and backups; an operator restore fails closed if that expected file is missing, unreadable, or invalid.

Start a canary against the isolated copies and run `npm run smoke:deployed` before considering the backup usable. Delete the isolated test directory only after the canary has stopped.

## Live recovery rule

There is intentionally no automatic live database restore. If production has accepted traffic after a deployment, do not replace its database automatically or combine a restored database with newer room state. Stop the service, preserve the failed state, select a verified backup, restore it into a fresh isolated directory, validate it with a canary, and only then perform a deliberate operator-controlled cutover.

## Scheduled retention and restore drills

The governance release installs staged daily/monthly systemd assets. They remain disabled until the immutable release readiness contract, one daily backup, and one monthly isolated restore drill all pass during explicit activation. See [Repository governance and production operations](operations-governance.md).

Scheduled backups have isolated namespaces and cannot prune deployment, bootstrap, migration, or incident backups. The service retains 30 verified daily snapshots, 12 verified monthly snapshots, and 12 monthly drill records. Every production copy containing account source data has a 12-month maximum retention; exceptional copies outside the scheduled namespaces require an operator-owned inventory and manual destruction before that deadline. Verification and isolated restore accept known checksum-valid historical migration/protocol prefixes; new backups from live state still require the exact current migration and release identity.
