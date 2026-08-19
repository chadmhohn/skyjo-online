# Deployment smoke checklist

Use this as the concise release checklist. The trust model, bootstrap commands, failure behavior, and recovery procedure are in [immutable-deployment.md](immutable-deployment.md).

## Before merge

- [ ] `npm run smoke:release` passes from a clean branch.
- [ ] Required unit, Chromium, WebKit, visual/accessibility, Lighthouse, and CodeQL checks pass.
- [ ] `CI / Runtime Artifact` packages the build emitted by `CI / Quality & Security`; it does not invoke an application build again.
- [ ] Archive allowlist, checksum, exact source SHA, production dependency inventory, CycloneDX SBOM, and GitHub provenance verification pass.
- [ ] No application, account, VAPID, session, database, SSH, smoke-account secret, APNs provider/encryption key, JWT, device token/fingerprint, real invite token, or live room-instance UUID appears in source, artifacts, logs, or workflow inputs.

## Main canary

- [ ] `CI / Release Canary` waited for every required test job.
- [ ] The forced deploy identity accepted only the declared archive byte count and SHA-addressed filename.
- [ ] The controller verified the checksum and release identity before extraction.
- [ ] Copied-state migration and authenticated HTTP/WebSocket smoke passed on `127.0.0.1:4181` with push disabled.
- [ ] All four `SKYJO_APNS_*` settings are blank in the canary, `/etc/skyjo-online` is inaccessible to it, no Apple connection occurs, and #204 creates or validates the frozen table only in copied state.
- [ ] The isolated canary served the exact synthetic Apple association document and rejected an invalid pre-gate native invite redemption without creating a session or mutating room state.
- [ ] The canary stopped and its isolated state was cleaned without stopping or changing production.

## Release tag

- [ ] The release commit is on protected `main`, and the exact commit's main CI run is green.
- [ ] The new tag is immutable `vX.Y.Z`; it is not moved or reused.
- [ ] The production `SKYJO_APPLE_APPLICATION_IDENTIFIER` is the Apple-confirmed full App ID prefix plus `com.groundworkrevops.skyjo`; it is neither missing nor the fixed synthetic test value.
- [ ] The controller independently resolved the public GitHub tag to the archive's full SHA.
- [ ] `current` and a verified rollback target exist before activation. The first cutover has an explicitly proven legacy anchor.
- [ ] The pre-activation backup passed SQLite integrity, foreign-key, migration-history, room-format, checksum, and isolated-restore verification.
- [ ] The copied-state canary passed immediately before live activation.
- [ ] Production stopped gracefully and flushed rooms before the backward-compatible migration.
- [ ] `previous` and `current` changed atomically, and the hardened service started as `skyjo` using `/opt/skyjo-online/node/bin/node`.
- [ ] If this is the APNs envelope release, record its immutable tag/SHA after production verification; do not claim #203 operationally complete until a later healthy promotion makes that exact tag `previous`.
- [ ] The envelope tag's `CI / Runtime Artifact` result proves the exact uploaded archive, checksum, and SBOM equal both deterministic rebuilds and that the extracted upload subject passes `server-apns-rollback-proof.mjs --expected-release-sha <exact-sha>` with one exact SHA-bound success line.
- [ ] If establishing the APNs rollback floor, resolve `/srv/skyjo-online/previous` to the recorded envelope SHA, require its root-owned mode-`0644` `.skyjo-deployment.json` exact bytes (ordered SHA, artifact digest, tag, and one final LF) to match that tested upload subject, and run its artifact-carried proof helper as `skyjo-canary` under `env -i` with synthetic temporary state only. Record the bounded SHA-bound success result; never read production secrets/state or restart production for this proof.
- [ ] If `apns_devices` may exist, both copied-state proof and the selected `previous` release accept only the frozen exact envelope and preserve representative encrypted rows byte-for-byte. The rollback target is not older than the recorded envelope tag.
- [ ] For an APNs-enabled production release, the provider and persistent token-encryption files exist only at the documented paths under root-owned `/etc/skyjo-online`, are `root:skyjo` mode `0640`, and all four configuration fields are complete. Do not print their contents or identifiers into retained evidence.

## Local production proof

```sh
systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
curl -fsS http://127.0.0.1:4180/readyz
curl -fsS http://127.0.0.1:4180/version
curl -fsS http://127.0.0.1:4180/.well-known/apple-app-site-association
```

- [ ] Liveness returns exactly `ok`.
- [ ] Readiness returns 200, all three checks are `ok`, and its release SHA is exact.
- [ ] Version returns the same full SHA, valid build timestamp, and expected protocol.
- [ ] Apple association GET and HEAD are direct public 200 responses with `application/json`, the confirmed single App ID, only `/invite/*`, and an exclusion for `?open=browser` before the include rule; neither response creates a cookie.
- [ ] The controller's dedicated account login, identity lookup, and authenticated WebSocket open/close smoke passed without mutating a room.
- [ ] An authenticated APNs config request returns the exact enabled state; authenticated register/rotate/delete/logout-cleanup requests obey the exact schema and never echo a token. SQLite inspection proves only bounded encrypted BLOBs and keyed fingerprints exist, and retained logs contain none of the submitted material.

## Public edge proof

CI runs the no-secret public proof:

```sh
node scripts/smoke-public-release.mjs \
  --base-url https://skyjo.groundworkrevops.com \
  --release-sha <expected-40-character-sha>
```

- [ ] Cloudflare serves public liveness, readiness, and version for the expected SHA.
- [ ] `/login` returns the password form without creating a session.
- [ ] `/manifest.webmanifest` and `/.well-known/apple-app-site-association` are valid and public.
- [ ] The association response uses the documented bounded public cache; readiness, version, login, and manifest are `no-store`.

## Functional release proof

- [ ] Single player starts, opening reveals complete, the human and AI each take legal turns, and no console error appears.
- [ ] Two authenticated clients create/join a room, complete opening reveals, exchange one turn each, and observe identical state.
- [ ] Refresh/rejoin restores the same room and seat.
- [ ] On a trusted operator terminal, one disposable-room invite redeems through `POST /api/rooms/invite/redeem` with the token only in the HTTPS JSON body, returns exactly `roomCode` and `expiresAt` plus one outer-access cookie, and does not create an account, membership, seat, or room mutation. No token or room-instance UUID is retained in evidence.
- [ ] The existing browser invite and `?open=browser` fallback still work, and the signed native app opens the Universal Link on a physical device under issue #188's human gate.
- [ ] Web Push and APNs fan out independently from one authoritative post-commit turn/round/game event; visible clients and recovered duplicate commands do not receive extra alerts. Retained provider evidence contains only the allowlisted status/reason/environment/stage fields.
- [ ] A graceful restart restores durable rooms and account history.

## Failure and rollback

- [ ] A failure before activation leaves production untouched.
- [ ] A local post-activation failure automatically switches code to `previous` and verifies it.
- [ ] A public-edge failure requests the metadata-bound code rollback and verifies the recovered edge.
- [ ] Normal rollback reports a full release SHA and passes strict readiness/version proof.
- [ ] Once `apns_devices` exists, the resolved rollback SHA is the recorded envelope release or newer; a pre-envelope target is rejected operationally rather than attempted.
- [ ] Only a controller-confirmed first-cutover legacy anchor may use the reduced legacy health/login/manifest proof.
- [ ] No automated path restores or overwrites live SQLite or room state.
- [ ] A code rollback leaves invite signing material and durable state untouched; account for the bounded Apple association cache and retain safe browser handling for `/invite/*` in the rollback target.
- [ ] Five releases remain, plus anything referenced by `current` or `previous`; backup rotation keeps 30 daily and 12 monthly verified sets.

Never repair a release by editing files below `current`, running `npm install` on the VPS, pointing a symlink manually, disabling SSH host verification, widening sudo, or copying a database over live state.
