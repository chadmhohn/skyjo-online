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

The global `/usr/bin/node` is never changed. The bootstrap downloads Node `v24.18.0` from nodejs.org, verifies the pinned official Linux x64 SHA-256 and sole `node-v24.18.0-linux-x64` archive root, strips that root into a private same-filesystem staging directory, validates Node and npm, and atomically publishes the exact `/opt/skyjo-online/node-v24.18.0` target. Failed staging is removed; a valid target is reused without replacement, while an incomplete existing target is never clobbered.

## Restricted SSH interface

The `skyjo-deploy` account has a locked password and a forced Ed25519-key command with `restrict`, no PTY, no forwarding, and no user rc. Bootstrap accepts one LF- or CRLF-terminated Ed25519 public-key record, verifies its pinned fingerprint, rejects embedded controls or extra lines, and writes one canonical LF-only `authorized_keys` record. The account has no general shell or file-transfer command. The only accepted commands are:

```text
<action> <run>-<attempt>-<lane> <40-sha> <artifact-sha256> <artifact-bytes> <tag-or-dash> <issued-at> <expires-at> <lane-key-id> <ed25519-signature>
```

The only actions are `upload`/`verify` for the canary lane and `upload`/`promote`/`rollback` for the production lane. Every action is signed by that environment's distinct `SKYJO_DEPLOY_AUTH_PRIVATE_KEY`; the root controller verifies the pinned lane public key and consumes the authorization once before upload or release code runs. `upload` verifies the signed size and digest, writes a bounded unique partial, fsyncs it, and publishes with a no-overwrite hard link to `skyjo-runtime-<sha>.tar.gz`. The stage parent remains exact mode `1731` and non-enumerable to the deploy identity; only its expected parent-directory `EACCES` after a successful first mkdir is tolerated, while the run directory and archive are still fsynced and every other error fails closed. The exact sudo wrapper holds a non-blocking global `flock`, so authorization, verify, promote, and rollback cannot overlap.

`verify` independently checks the SHA-256, tar paths, types, duplicate entries, expansion limits, and matching root/served release identities before extraction. After taking ownership of the stage, the controller copies the upload into its private artifact with bounded 64 KiB positional `FileHandle` reads and writes, retries short writes, fsyncs the destination, and closes both handles before continuing; it does not create `FileHandle` streams, and a failed copy removes its partial destination. It then takes an online Node/SQLite snapshot of live state, restores only into the run directory, blanks VAPID configuration, starts the candidate on `127.0.0.1:4181`, and runs the authenticated HTTP/WebSocket smoke. Canary and production-smoke cleanup first inspect every exact temporary instance with named `systemctl show` properties. A clean result must prove the requested `Id`, expected template `FragmentPath`, no drop-ins, `CollectMode=inactive`, loaded/inactive/dead/success state, zero main and control PIDs, and no pending job. A successful instance that systemd garbage-collected simply reloads into that clean state and is never reset. Exact active or work-bearing residue is stopped and reinspected; an exact failed, quiescent instance is reset and reinspected. Either condition remains a certification failure even when remediation reaches the clean terminal state. Identity drift, unexpected templates or drop-ins, unsupported collection policy, unloaded state, malformed probes, and ambiguous state fail closed without remediation. Unrelated unit names are rejected before any systemd call. Every requested instance is attempted before one retained error or aggregate is returned, so an unsafe first unit cannot strand later cleanup and each failure retains its per-unit, per-stage evidence. Verify never changes `current`, `previous`, the production unit, or the live database.

The controller entrypoint top-level-awaits the complete action. On Linux, Node 24.18.0 asynchronous work such as `node:sqlite` `backup()` and later recursive filesystem cleanup can leave a pending promise without a referenced event-loop handle; an otherwise-idle process then exits 13 with unsettled top-level await. The direct controller therefore holds one explicitly referenced no-op interval across the entire `await main()` lifecycle and clears it in an outer `finally` after success or failure handling. The snapshot helper retains its narrower guard for backup use outside the controller: it references an interval only for `await backup()`, then always clears it and closes the source database in `finally`. Neither guard imposes an arbitrary operation timeout. A successful `verify` must return exactly one canonical `{"verified":"<sha>","activated":false}` line; a successful `promote` must return the matching canonical release/tag envelope with either its pre-activation backup or `idempotent:true`. The GitHub transport independently validates that envelope before printing completion, so an empty, malformed, mismatched, or nonzero controller response fails closed. Verify removes the complete run directory after canary cleanup. Action and run-cleanup failures both terminalize the one-use authorization ledger as `failed`; a cleanup failure is never ignored or allowed to turn an incomplete action into success.

`promote` additionally requires a semver tag and resolves that public GitHub tag to the exact commit SHA. It creates and verifies a durable pre-activation backup, repeats the copied-state canary, gracefully stops production, changes state ownership for the non-root service, swaps `previous` and `current`, and performs readiness/version/authenticated smoke checks. Any post-link failure automatically switches code back to `previous` and rechecks it. Database files are never automatically restored after activation because migrations are additive and backward compatible.

After the workflow's public Cloudflare checks, `rollback` provides a narrow recovery action. It is allowed only when the current release SHA, stored artifact digest, and stored tag all match the request. It swaps code to `previous`, never restores state, and emits one sanitized JSON line. CI rejects extra fields, extra lines, inconsistent legacy flags, the failed SHA, and malformed targets. A first-cutover legacy result is exactly `{"rolledBackTo":"legacy","legacy":true}`; normal rollback reports the previous full SHA with `legacy:false`, and that recovered SHA is required by the public readiness/version smoke.

## First cutover from the legacy checkout

Preparation is deliberately split so installing delivery tooling cannot make the running legacy service unrestartable:

1. `sudo deploy/bootstrap-skyjo-delivery.sh prepare /root/skyjo-deploy.pub /root/canary-public.pem /root/production-public.pem` installs the isolated Node runtime, pinned lane public keys, users, directories, controller, forced-command policy, and canary/smoke units. It stages the hardened production unit but does not replace or restart the live unit.
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
node --test deploy/tests/*.test.mjs
sh -n deploy/bootstrap-skyjo-delivery.sh deploy/skyjo-release-controller \
  deploy/skyjo-canary-launch deploy/skyjo-smoke-launch
```
