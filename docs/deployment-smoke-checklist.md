# Deployment smoke checklist

Use this as the concise release checklist. The trust model, bootstrap commands, failure behavior, and recovery procedure are in [immutable-deployment.md](immutable-deployment.md).

## Before merge

- [ ] `npm run smoke:release` passes from a clean branch.
- [ ] Required unit, Chromium, WebKit, visual/accessibility, Lighthouse, and CodeQL checks pass.
- [ ] `CI / Runtime Artifact` packages the build emitted by `CI / Quality & Security`; it does not invoke an application build again.
- [ ] Archive allowlist, checksum, exact source SHA, production dependency inventory, CycloneDX SBOM, and GitHub provenance verification pass.
- [ ] No application, account, VAPID, session, database, SSH, or smoke-account secret appears in source, artifacts, logs, or workflow inputs.

## Main canary

- [ ] `CI / Release Canary` waited for every required test job.
- [ ] The forced deploy identity accepted only the declared archive byte count and SHA-addressed filename.
- [ ] The controller verified the checksum and release identity before extraction.
- [ ] Copied-state migration and authenticated HTTP/WebSocket smoke passed on `127.0.0.1:4181` with push disabled.
- [ ] The canary stopped and its isolated state was cleaned without stopping or changing production.

## Release tag

- [ ] The release commit is on protected `main`, and the exact commit's main CI run is green.
- [ ] The new tag is immutable `vX.Y.Z`; it is not moved or reused.
- [ ] The controller independently resolved the public GitHub tag to the archive's full SHA.
- [ ] `current` and a verified rollback target exist before activation. The first cutover has an explicitly proven legacy anchor.
- [ ] The pre-activation backup passed SQLite integrity, foreign-key, migration-history, room-format, checksum, and isolated-restore verification.
- [ ] The copied-state canary passed immediately before live activation.
- [ ] Production stopped gracefully and flushed rooms before the backward-compatible migration.
- [ ] `previous` and `current` changed atomically, and the hardened service started as `skyjo` using `/opt/skyjo-online/node/bin/node`.
- [ ] If this is the APNs envelope release, record its immutable tag/SHA after production verification; do not claim #203 operationally complete until a later healthy promotion makes that exact tag `previous`.
- [ ] If `apns_devices` may exist, both copied-state proof and the selected `previous` release accept only the frozen exact envelope and preserve representative encrypted rows byte-for-byte. The rollback target is not older than the recorded envelope tag.

## Local production proof

```sh
systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
curl -fsS http://127.0.0.1:4180/readyz
curl -fsS http://127.0.0.1:4180/version
```

- [ ] Liveness returns exactly `ok`.
- [ ] Readiness returns 200, all three checks are `ok`, and its release SHA is exact.
- [ ] Version returns the same full SHA, valid build timestamp, and expected protocol.
- [ ] The controller's dedicated account login, identity lookup, and authenticated WebSocket open/close smoke passed without mutating a room.

## Public edge proof

CI runs the no-secret public proof:

```sh
node scripts/smoke-public-release.mjs \
  --base-url https://skyjo.groundworkrevops.com \
  --release-sha <expected-40-character-sha>
```

- [ ] Cloudflare serves public liveness, readiness, and version for the expected SHA.
- [ ] `/login` returns the password form without creating a session.
- [ ] `/manifest.webmanifest` is valid and public.
- [ ] Readiness, version, login, and manifest are `no-store`.

## Functional release proof

- [ ] Single player starts, opening reveals complete, the human and AI each take legal turns, and no console error appears.
- [ ] Two authenticated clients create/join a room, complete opening reveals, exchange one turn each, and observe identical state.
- [ ] Refresh/rejoin restores the same room and seat.
- [ ] A graceful restart restores durable rooms and account history.

## Failure and rollback

- [ ] A failure before activation leaves production untouched.
- [ ] A local post-activation failure automatically switches code to `previous` and verifies it.
- [ ] A public-edge failure requests the metadata-bound code rollback and verifies the recovered edge.
- [ ] Normal rollback reports a full release SHA and passes strict readiness/version proof.
- [ ] Once `apns_devices` exists, the resolved rollback SHA is the recorded envelope release or newer; a pre-envelope target is rejected operationally rather than attempted.
- [ ] Only a controller-confirmed first-cutover legacy anchor may use the reduced legacy health/login/manifest proof.
- [ ] No automated path restores or overwrites live SQLite or room state.
- [ ] Five releases remain, plus anything referenced by `current` or `previous`; backup rotation keeps 30 daily and 12 monthly verified sets.

Never repair a release by editing files below `current`, running `npm install` on the VPS, pointing a symlink manually, disabling SSH host verification, widening sudo, or copying a database over live state.
