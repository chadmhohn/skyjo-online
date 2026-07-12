# Immutable Skyjo deployment runbook

Skyjo deploys one CI-built runtime archive, never a mutable Git checkout. A successful `main` run exercises that archive on an isolated VPS canary. Only an immutable semantic version tag can promote it to production.

## Delivery invariants

- The `CI / Quality & Security` job is the only job that compiles `dist/` and `server-dist/`. Browser tests and runtime packaging download those exact files.
- The runtime archive is named `skyjo-runtime-<40-character-source-sha>.tar.gz`. Its SHA-256 sidecar, external CycloneDX 1.6 SBOM, and GitHub build-provenance attestation bind the same source SHA. Every attestation recheck also pins this repository's `ci.yml`, exact source ref/digest, and GitHub-hosted runner provenance.
- Pull requests package and verify the runtime but cannot reach a deployment environment. A green `main` run reaches only the isolated canary. Production is additionally gated to a `vX.Y.Z` tag whose commit is on protected `main`.
- The deploy identity can upload one size-limited archive and relay only a separately signed `verify`, `promote`, or metadata-bound code rollback. It cannot request a shell, PTY, forwarding, arbitrary files, arbitrary sudo, or database restoration. Uploads alone never execute candidate code.
- The application runs as non-login user `skyjo` with an isolated Node 24 runtime at `/opt/skyjo-online/node/bin/node`. It never runs as root and does not depend on the host-wide `/usr/bin/node`.
- A promotion creates and verifies a durable state backup before activation. Migrations must be backward compatible. Automatic recovery changes code only; it never restores a database after traffic may have resumed.

## CI graph and environments

The release lane is part of `.github/workflows/ci.yml`, so it cannot race the required checks or rebuild a different bundle:

1. Quality builds once and uploads `dist/` plus `server-dist/`.
2. Unit, browser, accessibility, visual, and Lighthouse jobs consume or validate that source/build.
3. `CI / Runtime Artifact` downloads the tested build, installs production dependencies in an isolated staging tree, creates the archive/checksum/SBOM, verifies them, and uploads the exact subject set with read-only repository permissions. Pull-request code never receives OIDC or attestation authority.
4. `CI / Runtime Attestation` runs only for protected `main` and `vX.Y.Z` pushes. It downloads the exact three subjects without checking out or executing repository code, rechecks their names and checksum, generates GitHub provenance, and verifies the published attestation.
5. `CI / Release Canary` waits for every required test job and the attestation job, uploads the archive through the forced SSH command, and requests a verify-only canary on `127.0.0.1:4181`.
6. `CI / Production` exists only for a `push` of `vX.Y.Z`. It promotes the same downloaded artifact, checks the public Cloudflare surface, and requests a code-only rollback if the edge check fails.

Both VPS jobs use `concurrency: { group: skyjo-production, queue: max }`, preserving queued releases instead of cancelling them. The root controller also holds a host `flock`, so GitHub retries and concurrent tags cannot interleave deployment state.

## Signed-action protocol cutover

The corrective delivery lineage intentionally returns to the reviewed split contract: a four-token, bounded, nonexecuting upload followed by a separately signed nine-token `verify`, `promote`, or `rollback`. The dispatcher/controller installed from `0cc063e` expects the superseded ten-token size-bound command, so this transition is an ordered bootstrap cutover rather than a normal merge-first rollout:

1. Let the corrective pull request complete every repository CI check. `CI / Release Canary` is intentionally ineligible on pull requests, so the old live dispatcher is not contacted by the new client.
2. Freeze one reviewed corrective commit and record its exact 40-character SHA. Export that commit without checkout conversion (`git -c core.autocrlf=false -c core.eol=lf archive ...`), verify every deploy shebang asset is LF-only, and stage only those reviewed bytes beneath the root-owned bootstrap source path.
3. Before merging, run `bootstrap-skyjo-delivery.sh prepare` from that exact archive and the already pinned public-key inputs. Require the installed controller `self-test` to pass. This atomically replaces the forced dispatcher, controller, client assets, and manifest as one immutable bootstrap generation; do not mix files from the old and new protocols.
4. Using the release archive/checksum built for the same corrective SHA, run one manual `verify` through `deploy/github-release-remote.sh`. The four-token upload must remain nonexecuting, and the signed nine-token canary action must complete with the exact canonical result. Preserve the command result and self-test output as PR evidence.
5. Merge only after that manual canary passes, then require the protected `main` run's normal `CI / Release Canary` to pass again. Do not tag or promote during the cutover window. If bootstrap or the manual canary fails, leave production untouched and repair or atomically select the prior verified bootstrap generation before retrying.

This sequence is required only for the `0cc063e` protocol transition. Later changes use the normal merge-then-canary flow unless they deliberately alter the forced-command grammar again.

Create `canary` and `production` GitHub environments with no human reviewers. Configure these environment values:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `SKYJO_DEPLOY_HOST` | Public DNS name or IPv4 address of the VPS SSH service |
| Variable | `SKYJO_DEPLOY_PORT` | SSH port, normally `22` |
| Variable | `SKYJO_DEPLOY_USER` | `skyjo-deploy` |
| Variable | `SKYJO_PUBLIC_BASE_URL` | Production only: `https://skyjo.groundworkrevops.com` |
| Variable | `SKYJO_DEPLOY_AUTH_KEY_ID` | `canary-2026-07` in canary; `production-2026-07` in production |
| Secret | `SKYJO_DEPLOY_SSH_PRIVATE_KEY` | Private half of the dedicated Ed25519 deploy key |
| Secret | `SKYJO_DEPLOY_KNOWN_HOSTS` | Operator-verified pinned VPS host-key line |
| Secret | `SKYJO_CANARY_AUTH_PRIVATE_KEY` | Canary environment only: Ed25519 command-signing key |
| Secret | `SKYJO_PRODUCTION_AUTH_PRIVATE_KEY` | Production environment only: distinct Ed25519 command-signing key |

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
/etc/skyjo-deploy-auth/                root-only pinned lane public keys
/var/lib/skyjo-deploy-authorizations/  root-only one-use command ledger
/usr/local/lib/skyjo-online/           root-owned controller and launchers
/usr/local/lib/skyjo-online/bootstrap/ immutable root-private bootstrap generations
/usr/local/sbin/skyjo-delivery-bootstrap  installed adopt/activate entrypoint
```

Release directories are root-owned and read-only to `skyjo`. Live state is owned by `skyjo` and is never placed below a release. Backups are root-only. Upload staging is mode `1731` on ext4 and uses its directory link count as a fail-closed 32-run admission counter. Each mode-`0700` run directory has a same-owner mode-`0400` `.quota-admitted` file containing the exact run ID; bootstrap rejects unknown or legacy stage entries without deleting them. Per-run and global locks prevent publication races. The controller accepts only paths resolved beneath the expected admitted run directory.

## One-time preparation

Use the provisioned three-key bundle: one forced-command SSH transport key plus distinct canary and production Ed25519 authorization keys. The current bootstrap pins their fingerprints; rotation requires a reviewed code/key/environment update rather than an ad hoc replacement.

```sh
ssh-keygen -lf skyjo-deploy-transport.pub -E sha256
openssl pkey -pubin -in canary-auth-public.pem -text -noout
openssl pkey -pubin -in production-auth-public.pem -text -noout
```

Copy the reviewed `deploy/` directory plus the three public keys beneath a root-owned, non-group/world-writable staging path on the VPS. Bootstrap rejects a writable source path component, source asset, or key input before it snapshots or executes helper code:

```sh
sudo install -d -o root -g root -m 0700 /root/skyjo-bootstrap-source
sudo cp -R --no-dereference --reflink=never deploy/. /root/skyjo-bootstrap-source/
sudo chown -R root:root /root/skyjo-bootstrap-source
sudo chmod -R go-rwx /root/skyjo-bootstrap-source
sudo chmod 0500 /root/skyjo-bootstrap-source/bootstrap-skyjo-delivery.sh
sudo /root/skyjo-bootstrap-source/bootstrap-skyjo-delivery.sh prepare \
  /root/skyjo-deploy-transport.pub \
  /root/canary-auth-public.pem \
  /root/production-auth-public.pem
sudo /usr/local/sbin/skyjo-release-controller self-test
```

Preparation recursively validates the root-private generation's uid/gid, modes, file types, and checksums, then re-executes only that immutable copy. It installs the checksum-pinned Node 24 runtime with a checksum-bound marker, validates the entire root-owned/non-writable runtime path before executing an existing Node binary, and creates or verifies three distinct locked system identities with exact homes, shells, private primary groups, and no supplementary groups. Immutable sudoers and systemd sources preflight before any live publication, then the installed bytes are verified again. The locked controller path performs a second shell-level trust guard before any root Node execution. A single Windows CRLF transport public-key line is fingerprint-verified and rewritten as one LF-only forced-command record; extra lines and embedded controls fail closed. Failed Node staging is cleaned and a valid target is reused without replacement. Preparation preserves every byte of an existing `/etc/skyjo-online.env`, publishes the installed adopt/activate entrypoint only after all preparation checks pass, and deliberately does not replace or restart the legacy production service. Delete the temporary source public-key files afterward; the installed immutable snapshots remain covered by the delivery asset manifest.

Before the first tagged promotion, create and activate a verified rollback anchor for the currently healthy legacy service. These are deliberately separate, explicit steps; neither runs during prepare:

```sh
sudo /usr/local/sbin/skyjo-delivery-bootstrap adopt-legacy <current-40-character-sha>
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

`adopt-legacy` is a backup-first, interruption-resumable state machine. It validates or resumes the same immutable target and publishes both `current` and `previous` to it; divergent partial state fails closed. First activation must be the direct process of this systemd transient `Type=exec` service; it survives SSH loss and shares the deployment lock. Do not use direct interactive execution, `--scope`, `--pty`, `--pipe`, `nohup`, or a relative bootstrap path. `activate-production-unit` classifies the live unit as the exact legacy backup or exact staged hardened unit. A hardened crash state is stopped and safely resumed through ownership, reload, restart, health, and full proof; any resume failure restores legacy. Any normal-cutover boundary failure likewise restores the original unit and requires the full SQLite/rooms/account/WebSocket proof before reporting recovery; a healthy `/healthz` response is insufficient.

The application environment stays at mode `0600`, owned by root. In addition to the application settings in `deploy/skyjo-online.env.example`, define a dedicated existing smoke account:

```dotenv
SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL=release-smoke@example.com
SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD=replace-with-a-long-dedicated-password
```

The controller reads these values locally only for the post-activation production HTTP and WebSocket check. They are not copied into GitHub and are never accepted as SSH arguments. The canary uses copied state plus random synthetic credentials, forces `127.0.0.1:4181`, has no production environment access, and disables push credentials so verification cannot notify real users.

## Main-branch canary

Every protected `main` or immutable tag push that clears all gates uploads the attested artifact using the non-executing forced command:

```text
upload <run-id>-canary <release-sha> <exact-byte-count>
```

After upload, CI signs an exact nine-token command with the canary key:

```text
verify <run-id>-canary <release-sha> <artifact-sha256> - <issued-at> <expires-at> <key-id> <signature>
```

The root controller re-parses and verifies every field, key role, 10-minute maximum lifetime, and signature, then atomically consumes `role + command + run-id` in its root-only replay ledger before it reads the archive or state. An Actions rerun deliberately reuses the same run ID so an ambiguous started or completed operation is reconciled rather than applied twice. A terminal failed operation is never re-executed under that identity. To retry it, an authenticated repository operator starts a new workflow run from the exact protected ref: `gh workflow run ci.yml --ref main` for a main canary, or `gh workflow run ci.yml --ref v0.1.1` for an existing immutable release tag. The new workflow run supplies a fresh run ID, while checkout, tag syntax and ancestry, artifact identity, provenance, controller tag resolution, and every original CI/deployment gate remain unchanged. A dispatch from any other branch can run read-only CI but cannot mint provenance, reach the VPS canary, or deploy production; a main dispatch cannot deploy production. The Node controller itself owns the no-fork host lock and ignores SSH hangups only from authorization consumption through action and ledger finalization. Verify-only operation checks the archive path, declared size, digest, release identity, archive allowlist, and runtime version. Trusted controller code takes a schema-neutral online snapshot of current live state, restores it into an isolated copied-state directory, lets the candidate run backward-compatible migrations, and then runs candidate-owned strict backup verification as unprivileged `skyjo-canary`. The server, authenticated smoke, and proof units have no production secrets; the server/smoke are loopback-only and the proof has no network. Stop/reset/environment and run-root cleanup are mandatory gates: failure marks authorization failed rather than silently returning success or consuming staging quota.

## Tagged production promotion

Create the release tag only from the certified commit on protected `main`. Do not move or reuse a tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.1 -m "Skyjo v0.1.1"
git push origin v0.1.1
```

CI independently verifies the tag syntax and ancestry. A separately signed production command uses the same nine fields with `promote` or `rollback` and a `vX.Y.Z` tag. The canary key cannot authorize production, the production key cannot authorize canary, and upload never carries either signature. The controller resolves the public GitHub tag and requires both an exact SHA match and ancestry from public `main` before touching production. Promotion then:

1. Locks the host deployment lane and verifies current readiness.
2. Revalidates archive size, SHA-256, safe paths, release metadata, runtime allowlist, and Node major 24.
3. Creates a root-owned schema-neutral online SQLite plus rooms backup that accepts the currently deployed legacy/schema version, verifies checksums, integrity, foreign keys, room-envelope metadata, and an isolated materialization.
4. Runs copied-state migrations and authenticated smoke on the 4181 canary.
5. Gracefully stops production so rooms flush.
6. Applies the already-proven additive migration against live state.
7. Atomically sets `previous` to the old healthy release and `current` to the new SHA, then starts the hardened non-root service.
8. Requires local readiness, exact release SHA, login/account identity, and authenticated WebSocket smoke.
9. Lets CI verify public health, readiness, version SHA, login HTML, and the PWA manifest through Cloudflare.

Failure before step 7 leaves production untouched. Failure during or after local activation switches `current` back to `previous`, restarts it, and verifies it. A public-edge failure requests the same metadata-bound code rollback. The rollback command is rejected unless the current release, failed SHA, artifact digest, tag, run ID, and controller metadata all match.

For the one-time legacy anchor, rollback output must be exactly `{"rolledBackTo":"legacy","legacy":true}`. Only that strictly parsed result allows CI to use the reduced legacy edge proof (`healthz`, login, and manifest) because the old service may not implement `/readyz` or `/version`. Every normal rollback must return a different full release SHA; CI passes that exact recovered SHA to the strict readiness/version public smoke. Extra output, malformed JSON, unexpected fields, or the failed SHA are rejected.

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
sudo systemd-analyze verify deploy/skyjo-online-canary-smoke@.service
sudo systemd-analyze verify deploy/skyjo-online-smoke@.service
sudo systemd-analyze verify deploy/skyjo-online-state-proof@.service
sudo systemd-analyze verify deploy/skyjo-online-legacy-proof@.service
node --test deploy/tests/*.test.mjs
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

Do not repair a deployment by editing `current`, copying files into a live release, running `npm install` on the VPS, widening sudo, disabling host-key checking, moving/recreating a tag, or restoring a database automatically. Preserve the failed run directory and CI evidence. Use an ordinary Actions rerun to reconcile interrupted work under the same run ID; if that durable operation is terminal failed, use `gh workflow run ci.yml --ref <existing-vX.Y.Z-tag>` to create a new authorized run ID against the unchanged tag and SHA.
