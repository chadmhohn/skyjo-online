# Atomic VPS releases

Skyjo production runs only from immutable release directories. Application and smoke-account secrets remain in root-owned `/etc/skyjo-online.env`; no application secret is sent over SSH or stored in an artifact.

## Fixed layout

```text
/opt/skyjo-online/node-v24.18.0/       checksum-pinned private Node runtime
/opt/skyjo-online/node -> node-v24.18.0
/srv/skyjo-online/releases/<sha>/      root-owned immutable runtime
/srv/skyjo-online/current              active release symlink
/srv/skyjo-online/previous             last healthy release symlink
/var/tmp/skyjo-deploy/<run-id>/        quarantined upload/canary state
/var/lib/skyjo-online/                 skyjo-owned production state
/var/backups/skyjo-online/             root-owned verified backups
/usr/local/lib/skyjo-online/           root-owned controller and launchers
```

The global `/usr/bin/node` is never changed. The bootstrap downloads Node `v24.18.0` from nodejs.org and verifies the pinned official Linux x64 SHA-256 before installing it under `/opt/skyjo-online`.

## Restricted SSH interface

The `skyjo-deploy` account has a locked password and a forced Ed25519-key command with `restrict`, no PTY, no forwarding, and no user rc. It has no general shell or file-transfer command. The only accepted commands are:

```text
upload <run>-<attempt>-canary <40-sha> <byte-count>
verify <run>-<attempt>-canary <40-sha> <artifact-sha256>
upload <run>-<attempt>-production <40-sha> <byte-count>
promote <run>-<attempt>-production <40-sha> <artifact-sha256> <vX.Y.Z>
rollback <run>-<attempt>-production <failed-40-sha> <artifact-sha256> <vX.Y.Z>
```

`upload` writes a bounded partial file, fsyncs it, then atomically renames it to `skyjo-runtime-<sha>.tar.gz`. The other commands invoke one exact sudo wrapper. That wrapper holds a non-blocking global `flock`, so verify, promote, and rollback cannot overlap.

`verify` independently checks the SHA-256, tar paths, types, duplicate entries, expansion limits, and matching root/served release identities before extraction. It takes an online Node/SQLite snapshot of live state, restores only into the run directory, blanks VAPID configuration, starts the candidate on `127.0.0.1:4181`, and runs the authenticated HTTP/WebSocket smoke. It never changes `current`, `previous`, the production unit, or the live database.

`promote` additionally requires a semver tag and resolves that public GitHub tag to the exact commit SHA. It creates and verifies a durable pre-activation backup, repeats the copied-state canary, gracefully stops production, changes state ownership for the non-root service, swaps `previous` and `current`, and performs readiness/version/authenticated smoke checks. Any post-link failure automatically switches code back to `previous` and rechecks it. Database files are never automatically restored after activation because migrations are additive and backward compatible.

After the workflow's public Cloudflare checks, `rollback` provides a narrow recovery action. It is allowed only when the current release SHA, stored artifact digest, and stored tag all match the request. It swaps code to `previous`, never restores state, and emits one sanitized JSON result. A first-cutover legacy result is exactly `{"rolledBackTo":"legacy","legacy":true}`; normal rollback reports the previous SHA and `legacy:false`.

## First cutover from the legacy checkout

Preparation is deliberately split so installing delivery tooling cannot make the running legacy service unrestartable:

1. `sudo deploy/bootstrap-skyjo-delivery.sh prepare /root/skyjo-deploy.pub` installs the isolated Node runtime, users, directories, controller, forced-command policy, and canary/smoke units. It stages the hardened production unit but does not replace or restart the live unit.
2. `sudo deploy/bootstrap-skyjo-delivery.sh adopt-legacy <current-40-sha>` copies the exact legacy runtime into the release store, installs production-only dependencies with pinned npm, rejects all symlinks, writes a full checksum manifest, creates `current`, and preserves the original unit. Production is still untouched.
3. After the release artifact has passed `verify`, `sudo deploy/bootstrap-skyjo-delivery.sh activate-production-unit` gracefully stops the old service, validates and chowns only regular state files, installs the staged unit, starts the immutable legacy anchor under Node 24, and health-checks it. Failure restores the original unit and health-checks the recovered legacy service.
4. Only then may the tagged `promote` command activate `v0.1.1`. It fails closed when no `current` rollback anchor exists.

## Secret and service contract

`/etc/skyjo-online.env` must remain mode `0600`, root-owned, and contain the normal application variables plus a dedicated non-admin smoke account:

```text
SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=...
SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=...
```

Missing smoke credentials fail the canary before activation without printing their values. The production unit runs as non-login user `skyjo`, binds localhost, writes only `/var/lib/skyjo-online`, and uses systemd filesystem, device, kernel, privilege, capability, and address-family restrictions. Node's JIT requires executable memory, so `MemoryDenyWriteExecute` is intentionally not enabled.

The controller retains five release directories including `current` and `previous`. Scheduled daily/monthly backup retention and restore drills are installed by the governance/monitoring issue; pre-activation backups are not ambiguously pruned by the release controller.

## Local controller tests

```sh
node --test deploy/tests/release-controller.test.mjs
sh -n deploy/bootstrap-skyjo-delivery.sh deploy/skyjo-release-controller \
  deploy/skyjo-canary-launch deploy/skyjo-smoke-launch
```
