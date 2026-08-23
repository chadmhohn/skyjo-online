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
/var/lib/skyjo-deploy/.admission.lock  root:skyjo-deploy 0640 admission flock file
/var/lib/skyjo-online/                 skyjo-owned production state
/var/backups/skyjo-online/             root-owned verified backups
/etc/skyjo-deploy-auth/                root-only lane public keys
/var/lib/skyjo-deploy-authorizations/  root-only one-use command ledger
/usr/local/lib/skyjo-online/           root-owned controller and launchers
/usr/local/lib/skyjo-online/bootstrap/ immutable root-private bootstrap generations
/usr/local/sbin/skyjo-delivery-bootstrap  installed adopt/activate entrypoint
```

The global `/usr/bin/node` is never changed. The bootstrap downloads Node `v24.18.0` from nodejs.org, verifies the pinned official Linux x64 SHA-256 and sole `node-v24.18.0-linux-x64` archive root, strips that root into a private same-filesystem staging directory, writes a checksum-bound runtime marker, validates the full root-owned/non-writable path and runtime tree before executing Node, and atomically publishes the exact target and a unique relative symlink. Installation is serialized; interrupted staging is removed, a valid target is reused, and incomplete or forged existing trees are never executed or clobbered. The sudo wrapper acquires the deployment lock and enters a root-owned shell launcher that independently checks the exact Node symlink, uid/gid, path modes, marker, binary, npm CLI, and controller imports before it executes the direct versioned Node binary.

## Restricted SSH interface

The `skyjo-deploy` account has a locked password and a forced Ed25519-key command with `restrict`, no PTY, no forwarding, and no user rc. Bootstrap accepts one LF- or CRLF-terminated Ed25519 public-key record, verifies its pinned fingerprint, rejects embedded controls or extra lines, and writes one canonical LF-only `authorized_keys` record. The account has no general shell or file-transfer command. The only accepted commands are:

```text
upload <run>-<attempt>-canary <40-sha> <byte-count>
upload <run>-<attempt>-production <40-sha> <byte-count>
verify <run>-<attempt>-canary <40-sha> <artifact-sha256> - <iat> <exp> <canary-key-id> <signature>
promote <run>-<attempt>-production <40-sha> <artifact-sha256> <vX.Y.Z> <iat> <exp> <production-key-id> <signature>
rollback <run>-<attempt>-production <failed-40-sha> <artifact-sha256> <vX.Y.Z> <iat> <exp> <production-key-id> <signature>
```

`upload` is deliberately unsigned and non-executing. It writes a bounded unique partial, fsyncs it, publishes with a no-overwrite hard link, and is constrained by one persistent admission lock plus a 32-run global staging quota. The stage root remains directories-only at exact mode `1731` on ext4; its directory link count is the admission counter, and every mode-`0700` run directory begins with a mode-`0400` `.quota-admitted` file containing its exact run ID. Before reserving or reopening a run, the dispatcher opens the empty `root:skyjo-deploy` mode-`0640` `/var/lib/skyjo-deploy/.admission.lock` read-only with `O_NOFOLLOW`, revalidates its inode and trust chain, and has `/usr/bin/flock` lock the inherited descriptor retained by Node. That same descriptor stays held through input receipt, partial cleanup, archive binding, publication or idempotent return, failure cleanup, and final lock release; every dispatcher unlink or `rmdir` first proves the descriptor is still held. A 15-minute total input deadline prevents a stalled client from retaining admission indefinitely. A crash closes the descriptor automatically, so there is no per-run owner file, stale PID recovery, or pathname lock removal. Upload contention returns `75`. Bootstrap and the root controller take the host lock before this admission lock; controller contention returns `73` for the exact signed-command retry loop. Bootstrap accepts only the upload, each strict root-claim transition, or fully claimed ownership state, so a controller interruption remains resumable while unknown owners/modes still fail closed. If an upload acknowledgement is lost, CI retries the same upload exactly once; durable publication is idempotent and candidate execution still occurs only after a signed command. The other commands require exact canonical Ed25519 authorization from distinct canary/production keys. Root repeats parsing and signature verification and atomically creates a one-use replay record before any archive, state, GitHub, or candidate operation. Once authorization is verified it ignores SSH hangups through action and ledger finalization; verify, promote, and rollback therefore cannot overlap or be stranded by a disconnected client.

`verify` independently checks the SHA-256, tar paths, types, duplicate entries, expansion limits, and matching root/served release identities before extraction. Trusted controller code takes a schema-neutral online SQLite/rooms snapshot, restores only into the run directory, supplies synthetic credentials, blanks VAPID configuration, and starts the candidate as the separate `skyjo-canary` identity on `127.0.0.1:4181`. Candidate strict state proof also runs as that unprivileged identity without production state, secrets, or network access. It never changes `current`, `previous`, the production unit, or the live database.

The server derives the repository's fixed synthetic Apple application identifier only when `SKYJO_CANARY_RELEASE_DIR` matches the controller's exact isolated release-path contract and the running artifact resides in that same directory, while `/etc/skyjo-online.env` must contain Apple's confirmed full App ID prefix plus `com.groundworkrevops.skyjo` before production promotion. Production startup rejects a missing, malformed, placeholder, or synthetic value. The full identifier is public configuration; invite signing material remains secret.

`promote` additionally requires a semver tag and resolves that public GitHub tag to the exact commit SHA. It creates and verifies a durable pre-activation backup, repeats the copied-state canary, gracefully stops production, changes state ownership for the non-root service, swaps `previous` and `current`, and performs readiness/version/authenticated smoke checks. Any post-link failure automatically switches code back to `previous` and rechecks it. Database files are never automatically restored after activation because migrations are additive and backward compatible.

The optional `apns_devices` physical table keeps the public migration ledger at schema 2 and therefore has a stricter release-order invariant. Promote the #203 envelope code first, verify it, then make that exact immutable tag `previous` through a later healthy promotion before #204 may create the frozen table. The #204 server creates the exact frozen descriptor transactionally and idempotently during copied-state canary and production startup. Once the table exists, that tag is the permanent minimum rollback target; older code rejects the table and must never be selected. `npm run smoke:apns-rollback`, copied-state backup/restore, and readiness prove the envelope release preserves exact rows without using them.

Production APNs credentials are file-backed and never enter the release archive or SSH command. The only accepted provider paths are `/etc/skyjo-online/apns-provider.p8` and `/etc/skyjo-online/apns-token.key`, both `root:skyjo` mode `0640` beneath root-owned non-writable `/etc/skyjo-online`. `/etc/skyjo-online.env` must specify all four `SKYJO_APNS_*` settings or none; partial configuration fails startup. Canary units blank those settings and deny access to the key directory, so a copied-state proof cannot call Apple.

After the workflow's public Cloudflare checks, `rollback` provides a narrow recovery action. It is allowed only when the current release SHA, stored artifact digest, and stored tag all match the request. It swaps code to `previous`, never restores state, and emits one sanitized JSON result. A first-cutover legacy result is exactly `{"rolledBackTo":"legacy","legacy":true}`; normal rollback reports the previous SHA and `legacy:false`.

## First cutover from the legacy checkout

Preparation is deliberately split so installing delivery tooling cannot make the running legacy service unrestartable:

1. Freeze old deployment workflows and prove no old-protocol upload is active. Stage the reviewed `deploy/` directory and three public keys beneath a root-owned, non-group/world-writable path such as `/root/skyjo-bootstrap-source`; bootstrap rejects any writable source path component or source file. Run `sudo /root/skyjo-bootstrap-source/bootstrap-skyjo-delivery.sh prepare /root/skyjo-deploy.pub /root/canary-auth-public.pem /root/production-auth-public.pem`. It snapshots the exact delivery bundle and key inputs into a root-private recursively validated generation, then re-executes from that immutable copy. Under host-then-admission lock ordering, it creates or resumes the external admission file without replacing a valid inode, validates the pinned fingerprints, and installs the isolated runtime, controller, forced-command policy, keyring/ledger, and canary/proof units. Because the lock is outside `/var/tmp/skyjo-deploy`, a failure before new asset publication leaves the old controller's stage contract usable. Only after every preparation check succeeds does bootstrap publish `bootstrap/current` and the installed delayed-action entrypoint. It stages the hardened production unit but does not replace or restart the live unit.
2. `sudo /usr/local/sbin/skyjo-delivery-bootstrap adopt-legacy <current-40-sha>` first checksums and byte-compares a root-only backup of the live unit, then creates or resumes the exact link-free legacy release. It is idempotent across backup, checksum, target rename, and link-publication interruptions; ambiguous partial state fails closed. It publishes both `current` and `previous` to the same validated legacy anchor so first promotion and pruning have a rollback target. Production remains untouched.
3. After the release artifact has passed `verify`, run first activation from the installed entrypoint as the direct process of a manager-owned transient service:

   ```sh
   sudo systemd-run \
     --unit=skyjo-activate-production \
     --collect \
     --wait \
     --service-type=exec \
     /usr/bin/flock --exclusive --nonblock --no-fork \
     /run/lock/skyjo-release-controller.lock \
     /usr/local/sbin/skyjo-delivery-bootstrap activate-production-unit
   sudo journalctl --unit=skyjo-activate-production --no-pager
   ```

   The transient unit survives SSH loss and shares the controller lock. Direct interactive activation, `--scope`, `--pty`, `--pipe`, `nohup`, and relative script paths are rejected or unsupported. Before stopping, activation classifies the live unit as exactly the checksummed legacy backup or the validated staged hardened unit; a third state fails closed. The latter is an interrupted cutover and is safely stopped, normalized, reloaded, restarted, and fully proved. Every failure boundary enters the same legacy restoration transaction. The restored service must pass SQLite/rooms integrity, dedicated account login, and authenticated WebSocket proof; `/healthz` alone can never approve recovery.
4. Only then may the tagged `promote` command activate `v0.1.1`. It fails closed when no `current` rollback anchor exists.

## Secret and service contract

`/etc/skyjo-online.env` must remain mode `0600`, root-owned, and contain the normal application variables plus a dedicated non-admin smoke account:

```text
SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=...
SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=...
```

Missing smoke credentials fail the canary before activation without printing their values. The production unit runs as non-login user `skyjo`, binds localhost, writes only `/var/lib/skyjo-online`, and uses systemd filesystem, device, kernel, privilege, capability, and address-family restrictions. Node's JIT requires executable memory, so `MemoryDenyWriteExecute` is intentionally not enabled.

Canary stop/certification/environment cleanup and root-owned run-directory removal are release gates. Every temporary unit must match its exact template, have no drop-ins, use `CollectMode=inactive`, retain no process or job, and finish inactive/dead/success; state probes retain empty properties with `systemctl show --all`. Exact failed or active residue is remediated narrowly and reinspected, but the anomalous run still fails. Ambiguous or unsafe final state preserves its run root for incident repair. Run-directory removal is complete only after a post-removal `lstat` proves `ENOENT`. A cleanup failure marks the signed authorization failed and never reports verification or promotion success.

The controller retains five release directories including `current` and `previous`. Scheduled daily/monthly backup retention and restore drills use separate namespaces described in [Repository governance and production operations](operations-governance.md); they never prune pre-activation or bootstrap backups. Any such exceptional copy that contains account source data is therefore operator-inventoried and manually destroyed before the global 12-month maximum.

## Local controller tests

```sh
node --test deploy/tests/*.test.mjs
sh -n deploy/bootstrap-skyjo-delivery.sh deploy/bootstrap-safety-lib.sh \
  deploy/bootstrap-generation-guard-lib.sh deploy/activation-transaction-lib.sh \
  deploy/activation-unit-state-lib.sh deploy/adoption-state-lib.sh \
  deploy/legacy-proof-environment-lib.sh deploy/legacy-proof-unit-cleanup-lib.sh \
  deploy/node-runtime-installer.sh \
  deploy/node-runtime-guard-lib.sh deploy/transport-key-lib.sh \
  deploy/skyjo-delivery-bootstrap deploy/skyjo-controller-launch deploy/skyjo-release-controller \
  deploy/skyjo-canary-launch deploy/skyjo-smoke-launch deploy/skyjo-state-proof-launch \
  deploy/github-release-remote.sh
```
