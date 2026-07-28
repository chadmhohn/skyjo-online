# Repository governance and production operations

Issue 63 ships repository policy, scheduled backup, readiness monitoring, and incident automation as reviewed code. It deliberately does not activate any live setting at merge time. Production is still on the legacy service until the `v0.1.1` release completes, and that service redirects `/readyz` and `/version` instead of serving the release contracts.

## Repository governance

The managed policy has these invariants:

- `main` accepts pull requests only, requires linear history and resolved conversations, disallows deletion and force pushes, has no bypass actors, and requires zero approving human reviews.
- A separate `v*` tag-creation ruleset permits only the authenticated user owner resolved from the repository API. A second no-bypass tag ruleset blocks every update and deletion, so the release actor may create a version tag exactly once but cannot move or remove it afterward.
- The 14 named CI and CodeQL workflow checks must pass strictly against the current base before merging. Each required context is bound to the GitHub App that produced the unique successful check on current `main`. A separate CodeQL code-scanning rule blocks error-level findings and high-or-critical security findings; it does not rely on the workflow completion check to infer alert severity.
- Only squash merging is available. Auto-merge and automatic branch deletion are enabled.
- Actions must use full commit SHAs. The default `GITHUB_TOKEN` is read-only and cannot approve pull requests; individual jobs must request narrower write permissions explicitly.
- Dependabot alerts and automatic security fixes are enabled. Weekly npm and Actions updates are grouped by ecosystem and dependency type.

The reconciler is a dry run unless `--apply` and an exact confirmation are both supplied:

```sh
node scripts/configure-github-governance.mjs --repo chadmhohn/skyjo-online
```

The dry run does not require a token and makes no network mutation. After this change is merged and the new `CodeQL / Analyze` check plus all 13 CI checks have each succeeded exactly once on current `main`, an administrator can apply it:

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/configure-github-governance.mjs \
  --repo chadmhohn/skyjo-online \
  --apply \
  --confirm chadmhohn/skyjo-online
```

Apply mode first reads current `main`, current Actions policy, and every repository ruleset. It refuses to change anything unless every required check is uniquely green with a trustworthy GitHub App identity and any existing managed ruleset has an unambiguous identity. It preserves the repository's current Actions allowlist selection, turns on SHA pinning, applies the settings, and reads back the full ruleset (including the CodeQL severity gate) plus repository, Actions, token, and Dependabot policies. It never deletes an unrelated ruleset.

When a pull request introduces a new required context, that pull request must first verify the context manually and merge only while it is green. Wait for the same context to pass on the resulting exact `main` SHA, then rerun the reconciler so it can bind the producer identity and add the context to the managed ruleset. IOS-7 uses this one-time sequence for `iOS / UI & Accessibility`; neither the pull-request run nor the source-only update is permission to claim that branch protection already requires it.

Repository governance is the immediate post-merge step for this issue: apply it as soon as the issue-63 main run, including CodeQL, is green. This is separate from VPS operations activation below, which must remain deferred until the tagged `v0.1.1` production cutover in issue 64.

## Staged VPS operations

The operations installer has three explicit modes:

```sh
sudo deploy/install-skyjo-operations.sh install
sudo /usr/local/share/skyjo-online/operations/install-skyjo-operations.sh activate
sudo /usr/local/share/skyjo-online/operations/install-skyjo-operations.sh deactivate
```

For release work, copy the reviewed installer and its nine sibling assets to a root-owned staging directory first. `install` refuses to run if the activation marker exists or any managed unit is active/enabled; an inactive reinstall remains idempotent. It rejects linked, hardlinked, non-root-owned, or externally writable file targets, then installs exact-mode root-owned units, validators, the backup launcher, and a separate operations-owned tmpfiles rule that recreates the shared root-only release lock after every boot. It creates private directories, verifies the units, and reloads systemd. It writes and immediately verifies an exact 18-entry checksum manifest. It never creates the activation marker and never enables a timer.

Run `activate` only after the immutable `v0.1.1` release is healthy and its local `/readyz` reports the expected release SHA. Activation:

1. re-proves every service inactive/static, every timer inactive/disabled, and the exact installed-asset checksum/owner/mode manifest before resolving `current` to a root-owned `releases/<40-sha>` directory;
2. proves local readiness once and requires the private result to name that exact release SHA;
3. creates and verifies one daily backup;
4. creates a monthly backup and completes an isolated restore drill;
5. enables the two-minute monitor, daily backup, and monthly drill timers.

Any failed proof removes the marker and disables the timers. If timer disablement itself fails, the command reports that failure instead of claiming success. `deactivate` removes the marker first, so services fail their condition even if systemd cannot disable a timer, and it preserves all backup/evidence data.

The backup services never load `/etc/skyjo-online.env`. Their root-owned launcher supplies only the fixed database, room-state, and release-identity paths. The process cannot access the application secret file. The launcher holds the same host lock as release promotion for the full snapshot/drill, so code activation and scheduled state capture cannot overlap. Scheduled snapshots live under:

```text
/var/backups/skyjo-online/scheduled/daily/
/var/backups/skyjo-online/scheduled/monthly/
/var/backups/skyjo-online/scheduled/drills/
```

Daily retention is 30 verified snapshots. Monthly retention is 12 verified snapshots and 12 drill records. Retention only enumerates exact managed names in those namespaces, verifies an old backup before deleting it, and never visits bootstrap or pre-deployment backups. A monthly drill restores into a fresh directory below `/var/tmp/skyjo-restore-drills`, reverifies the complete payload and semantic metadata, records sanitized evidence, and removes the isolated copy. It never writes live state.

Scheduled backup services run as root because they must read the private `skyjo`-owned SQLite/room files while writing root-only recovery material. That trust boundary is constrained to fixed paths, a root-owned sole-link launcher and assets, no application environment file, no network access, the shared release lock, and a read-only system image with only backup/restore namespaces writable. Retention verifies every managed backup—including the retained set—before it deletes anything.

Backup verification accepts a checksum-valid, contiguous historical migration/protocol prefix supported by the current code so a valid older monthly snapshot remains testable after additive releases. Creating a new backup from live state is stricter: the live database and release identity must be exactly current. Future, unknown, discontinuous, empty, or checksum-drifted histories remain rejected.

## Monitoring and incidents

The VPS monitor calls only `http://127.0.0.1:4180/readyz` every two minutes and stores a private, fixed-schema result in `/var/lib/skyjo-monitor/local-readiness.json`. It runs as the non-login `skyjo-monitor` user, cannot read production state, backups, or the environment file, and records only a failure class, HTTP status, timestamp, and validated release identity. Its root-owned launcher verifies that identity, resolves `current` to one direct root-owned immutable release, rejects linked or externally writable runtime assets, clears Node preload/module-path overrides, and invokes the monitor through the exact release path with fixed arguments. This avoids treating Node's symlink-resolved ES module as a successful non-entrypoint import.

The GitHub public monitor runs every 15 minutes but remains inert until this repository variable is exactly `true`:

```text
SKYJO_MONITOR_ENABLED=true
```

Before enabling it, set repository variable `SKYJO_PUBLIC_BASE_URL` to the production HTTPS origin and prove public `/readyz` and `/version` on `v0.1.1`. A missing or invalid URL after activation produces sanitized `internal` failure evidence and still reaches incident reconciliation; it cannot silently skip monitoring.

An unhealthy readiness result or failed tag deployment creates or reopens one issue identified by an internal marker and labelled `priority:p0`, `area:ops`, `incident:production`, and `agent-ready`. Later failures update the same issue. The marker tracks `readiness` and `deployment` as independent active sources: healthy production cannot hide a failed release, and a later successful deployment must prove the public readiness contract before clearing its source. Duplicate open marker issues are folded into the primary issue and closed; the primary closes only after every active source recovers. Issue text contains no response body, exception message, host path, credential, room content, or user data. No GitHub token or PAT is installed on the VPS.

Monitor evidence is retained as a GitHub Actions artifact for 14 days. Keep the public workflow gated while production is legacy; enabling it early would intentionally report the missing readiness contract as an incident.

## Verification

```sh
node --test deploy/tests/operations-governance.test.mjs
npm run test:unit:data
npm run test:unit:delivery
npm run test:controller
sh -n deploy/install-skyjo-operations.sh deploy/skyjo-ops-launch
```

On Ubuntu, also run `systemd-analyze verify` on all six service/timer units before installation. The runtime artifact integration test must prove the artifact producer and live release controller agree on every operations script.
