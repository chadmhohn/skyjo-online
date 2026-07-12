# Immutable Skyjo deployment runbook

Skyjo deploys one CI-built runtime archive, never a mutable Git checkout. A successful `main` run exercises that archive on an isolated VPS canary. Only an immutable semantic version tag can promote it to production.

## Delivery invariants

- The `CI / Quality & Security` job is the only job that compiles `dist/` and `server-dist/`. Browser tests and runtime packaging download those exact files.
- The runtime archive is named `skyjo-runtime-<40-character-source-sha>.tar.gz`. Its SHA-256 sidecar, external CycloneDX 1.6 SBOM, and GitHub build-provenance attestation bind the same source SHA.
- Pull requests package and verify the runtime but cannot reach a deployment environment. A green `main` run reaches only the isolated canary. Production is additionally gated to a `vX.Y.Z` tag whose commit is on protected `main`.
- The deploy identity can upload one size-limited archive and invoke only `verify`, `promote`, or a metadata-bound code rollback. It cannot request a shell, PTY, forwarding, arbitrary files, arbitrary sudo, or database restoration.
- The application runs as non-login user `skyjo` with an isolated Node 24 runtime at `/opt/skyjo-online/node/bin/node`. It never runs as root and does not depend on the host-wide `/usr/bin/node`.
- A promotion creates and verifies a durable state backup before activation. Migrations must be backward compatible. Automatic recovery changes code only; it never restores a database after traffic may have resumed.

## CI graph and environments

The release lane is part of `.github/workflows/ci.yml`, so it cannot race the required checks or rebuild a different bundle:

1. Quality builds once and uploads `dist/` plus `server-dist/`.
2. Unit, browser, accessibility, visual, and Lighthouse jobs consume or validate that source/build.
3. `CI / Runtime Artifact` downloads the tested build, installs production dependencies in an isolated staging tree, creates the archive/checksum/SBOM, verifies it, generates GitHub provenance, and verifies the published attestation.
4. `CI / Release Canary` waits for every required test job, uploads the archive through the forced SSH command, and requests a verify-only canary on `127.0.0.1:4181`.
5. `CI / Production` exists only for a `push` of `vX.Y.Z`. It promotes the same downloaded artifact, checks the public Cloudflare surface, and requests a code-only rollback if the edge check fails.

Both VPS jobs use `concurrency: { group: skyjo-production, queue: max }`. The root controller also holds a host `flock`, so GitHub retries and concurrent tags cannot interleave deployment state.

Create `canary` and `production` GitHub environments with no human reviewers. Configure these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `SKYJO_DEPLOY_HOST` | Public DNS name or IPv4 address of the VPS SSH service |
| Variable | `SKYJO_DEPLOY_PORT` | SSH port, normally `22` |
| Variable | `SKYJO_DEPLOY_USER` | `skyjo-deploy` |
| Variable | `SKYJO_PUBLIC_BASE_URL` | Production only: `https://skyjo.groundworkrevops.com` |
| Secret | `SKYJO_DEPLOY_SSH_PRIVATE_KEY` | Private half of the dedicated Ed25519 deploy key |
| Secret | `SKYJO_DEPLOY_KNOWN_HOSTS` | Operator-verified pinned VPS host-key line |

Do not use `ssh-keyscan` during a workflow. Store the verified host key, not a permissive `StrictHostKeyChecking=no` override. The production environment must allow only protected `v*` tags rooted at protected `main`.

## VPS layout

```text
/opt/skyjo-online/node-v24.18.0/       pinned private Node runtime
/opt/skyjo-online/node -> node-v24.18.0
/srv/skyjo-online/releases/<sha>/      root-owned immutable release
/srv/skyjo-online/current -> releases/<sha>
/srv/skyjo-online/previous -> releases/<sha-or-legacy-anchor>
/var/tmp/skyjo-deploy/<run-id>/        private upload and canary workspace
/var/lib/skyjo-online/                 live SQLite and room JSON state
/var/backups/skyjo-online/             verified state backups
/run/skyjo-online-canary/              root-created ephemeral canary environment
/etc/skyjo-online.env                  root-only application and smoke secrets
/usr/local/lib/skyjo-online/           root-owned controller and launchers
```

Release directories are root-owned and read-only to `skyjo`. Live state is owned by `skyjo` and is never placed below a release. Backups are root-only. Upload staging is owned by `skyjo-deploy`; the controller accepts only paths resolved beneath the expected run directory.

## One-time preparation

Generate a dedicated key locally. Do not reuse an interactive administrator key:

```sh
ssh-keygen -t ed25519 -f skyjo-github-deploy -C skyjo-github-actions
```

Copy only the public key to a root-readable temporary file on the VPS. From the checked-out release source, run the prepare phase:

```sh
sudo deploy/bootstrap-skyjo-delivery.sh prepare /root/skyjo-github-deploy.pub
sudo /usr/local/sbin/skyjo-release-controller self-test
```

Preparation installs and checksum-verifies the isolated Node 24 runtime, creates the restricted identities/directories, installs the root-owned dispatcher/controller, validates sudoers and SSH configuration, installs only the canary unit, and stages the hardened production unit. It deliberately does not replace or restart the legacy production service. Delete the temporary public-key file afterward.

Before the first tagged promotion, create and activate a verified rollback anchor for the currently healthy legacy service. These are deliberately separate, explicit steps; neither runs during prepare:

```sh
sudo deploy/bootstrap-skyjo-delivery.sh adopt-legacy <current-40-character-sha>
sudo deploy/bootstrap-skyjo-delivery.sh activate-production-unit
```

`adopt-legacy` creates a link-free, checksummed, production-dependency snapshot and backs up the old unit without restarting it. `activate-production-unit` validates that manifest, stops and flushes the old service, restricts state ownership, installs the staged unit, starts the legacy anchor with isolated Node 24, and health-checks it. Failure restores and rechecks the original unit. The release controller refuses promotion when a validated `current` rollback anchor is absent; a first promotion must never create a state where rollback means "nowhere."

The application environment stays at mode `0600`, owned by root. In addition to the application settings in `deploy/skyjo-online.env.example`, define a dedicated existing smoke account:

```dotenv
SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=release-smoke@example.com
SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=replace-with-a-long-dedicated-password
```

The controller reads these values locally for authenticated HTTP and WebSocket checks. They are not copied into GitHub and are never accepted as SSH arguments. The canary uses copied state, forces `127.0.0.1:4181`, and disables push credentials so verification cannot notify real users.

## Main-branch canary

Every non-PR CI run that clears all gates uploads the attested artifact using:

```text
upload <run-id>-canary <release-sha> <exact-byte-count>
verify <run-id>-canary <release-sha> <artifact-sha256>
```

Verify-only operation checks the archive path, declared size, digest, release identity, archive allowlist, and runtime version. It restores the latest live state backup into an isolated copied-state directory, runs backward-compatible migrations there, starts the hardened canary unit on port 4181 with push disabled, and runs liveness/readiness/version plus authenticated app/WebSocket smoke. It stops the canary and cleans the copied state without stopping or changing production.

## Tagged production promotion

Create the release tag only from the certified commit on protected `main`. Do not move or reuse a tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.1 -m "Skyjo v0.1.1"
git push origin v0.1.1
```

CI independently verifies the tag syntax and ancestry. The controller resolves the public GitHub tag and requires it to identify the exact archive SHA before touching production. Promotion then:

1. Locks the host deployment lane and verifies current readiness.
2. Revalidates archive size, SHA-256, safe paths, release metadata, runtime allowlist, and Node major 24.
3. Creates an online SQLite plus rooms/release backup, verifies checksums, integrity, foreign keys, migration history, and an isolated restore.
4. Runs copied-state migrations and authenticated smoke on the 4181 canary.
5. Gracefully stops production so rooms flush.
6. Applies the already-proven additive migration against live state.
7. Atomically sets `previous` to the old healthy release and `current` to the new SHA, then starts the hardened non-root service.
8. Requires local readiness, exact release SHA, login/account identity, and authenticated WebSocket smoke.
9. Lets CI verify public health, readiness, version SHA, login HTML, and the PWA manifest through Cloudflare.

Failure before step 7 leaves production untouched. Failure during or after local activation switches `current` back to `previous`, restarts it, and verifies it. A public-edge failure requests the same metadata-bound code rollback. The rollback command is rejected unless the current release, failed SHA, artifact digest, tag, run ID, and controller metadata all match.

For the one-time legacy anchor, rollback output explicitly reports `"legacy": true`. Only that exact controller result allows CI to use the reduced legacy edge proof (`healthz`, login, and manifest) because the old service may not implement `/readyz` or `/version`. Every normal rollback requires a full release SHA and the strict readiness/version proof.

## Retention and recovery

The controller retains five immutable releases total while always protecting `current` and `previous`. The scheduled governance workflow maintains 30 daily and 12 monthly verified backups; the release controller never ambiguously prunes its pre-activation recovery point. Staging and canary data are private and short-lived.

Automatic rollback never replaces `/var/lib/skyjo-online/skyjo.sqlite` or `rooms.json`. If data recovery is required after traffic resumed:

1. Stop the service and preserve the failed live state.
2. Select a verified backup deliberately.
3. Restore into a fresh isolated directory using `scripts/restore-state.mjs`.
4. Prove the restored copy with the canary.
5. Perform an operator-controlled state cutover.

See [data-recovery.md](data-recovery.md) for the checksummed backup contract. A destructive live-state restore is intentionally outside the GitHub deploy key's authority.

## Verification and troubleshooting

Safe preparation checks do not activate production:

```sh
sudo /usr/local/sbin/skyjo-release-controller self-test
sudo systemd-analyze verify deploy/skyjo-online.service
sudo systemd-analyze verify deploy/skyjo-online-canary@.service
sudo systemd-analyze verify deploy/skyjo-online-smoke@.service
node --test deploy/tests/release-controller.test.mjs
npm run smoke:delivery
```

After a tagged promotion, verify without printing cookies or secrets:

```sh
systemctl status skyjo-online.service --no-pager
curl -fsS http://127.0.0.1:4180/healthz
curl -fsS http://127.0.0.1:4180/readyz
curl -fsS http://127.0.0.1:4180/version
node scripts/smoke-public-release.mjs \
  --base-url https://skyjo.groundworkrevops.com \
  --release-sha "$(git rev-parse HEAD)"
```

Do not repair a deployment by editing `current`, copying files into a live release, running `npm install` on the VPS, widening sudo, disabling host-key checking, or restoring a database automatically. Preserve the failed run directory and CI evidence, then correct the controller or source and issue a new immutable tag.
