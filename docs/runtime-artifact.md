# Immutable Runtime Artifact

Skyjo releases are built once on Node 24 and packaged as a SHA-addressed, runtime-only archive. The package step is intentionally Linux-only so every release uses the same GNU tar and gzip normalization contract.

## Build and verify

Use the commit timestamp for the release identity so a rebuild of the same commit has stable metadata:

```sh
export SKYJO_RELEASE_SHA="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="$(git show -s --format=%ct "$SKYJO_RELEASE_SHA")"
npm ci
npm run build
npm run release:artifact
```

The final command emits one JSON object and writes:

- `release/skyjo-runtime-<sha>.tar.gz`
- `release/skyjo-runtime-<sha>.tar.gz.sha256`
- `release/skyjo-runtime-<sha>.cdx.json`

Verify the downloaded files before upload or promotion:

```sh
npm run release:artifact:verify -- \
  --archive "release/skyjo-runtime-$SKYJO_RELEASE_SHA.tar.gz" \
  --checksum "release/skyjo-runtime-$SKYJO_RELEASE_SHA.tar.gz.sha256" \
  --release-sha "$SKYJO_RELEASE_SHA"
```

`npm run release:sbom` can generate the external, reproducible CycloneDX 1.6 JSON independently. The generator is an exact lockfile dependency; the workflow must never download an unpinned generator dynamically.

The Linux delivery gate packages the already-built `dist/` and `server-dist/` twice, proves byte-for-byte reproducibility, safely extracts one package, starts it with isolated SQLite/room state and push disabled, and runs the deployed authentication and WebSocket smoke:

```sh
SKYJO_RELEASE_SHA="$(git rev-parse HEAD)" \
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" \
npm run test:artifact:integration
```

The downloaded build identity must already contain that exact SHA and `SOURCE_DATE_EPOCH`; the integration gate never rebuilds application output.

## Package contract

The archive contains only:

- compiled `dist/` and `server-dist/` output;
- the Node server and its root-level runtime modules;
- the exact backup, restore, verification, and deployed-smoke scripts needed by the release controller;
- `package.json`, `package-lock.json`, and an `npm ci --omit=dev --ignore-scripts` production dependency tree;
- a reproducible CycloneDX 1.6 SBOM; and
- byte-identical release identities at the archive root and in `dist/`.

Source files, tests, development tooling, local state, environment files, and arbitrary scripts are not allowlisted. After production dependency installation, the builder deterministically removes every case-insensitive `.git`, `.github`, or `.env*` path under the isolated `node_modules` tree before SBOM generation, normalization, and tar creation. First-party `dist` and `server-dist` are never silently pruned: the build-time verifier rejects those forbidden segments anywhere in an archive using the same deployment-owned predicate as the VPS controller. Non-secret dotfiles such as `.gitignore` and `.npmignore` remain valid package content. Packaging also rejects source or installed symlinks and special filesystem entries. The verifier derives the complete non-development, non-optional package name/version inventory from `package-lock.json`. Every physical installed package manifest and every CycloneDX component must match that inventory exactly, with no extra package roots or falsified components. The SBOM root version must match `package.json` and its `skyjo:releaseSha` property must match the embedded release identity.

Verification also rejects absolute paths, Windows paths, traversal, ambiguous segments, duplicate entries, links, devices, non-ustar extensions, missing runtime files, release identity drift, an unexpected filename, or any checksum mismatch before extraction. Resource ceilings are 16 MiB compressed, 32 MiB expanded tar, 24 MiB aggregate files, 4 MiB per file, and 4,096 entries. These limits leave headroom over the measured runtime while bounding decompression and entry-count attacks.

GNU tar sorts entries and fixes owner/group to `0`, files to `0644`, directories to `0755`, and every mtime to the release build epoch. The verifier enforces those values on every header. GNU gzip uses `-n` to omit the original filename and timestamp. The builder verifies its own finished archive before reporting success; deployment still extracts with `--no-same-owner --no-same-permissions` before the root-owned controller applies its runtime ownership.

## GitHub attestation handoff

The read-only runtime packaging job creates and verifies the archive, checksum sidecar, and external SBOM after `npm run release:artifact`; pull-request and manual-dispatch packaging never receive OIDC authority. A separate protected-main/tag-only job downloads the exact three immutable subjects without checking out or executing repository code, rechecks their names and checksum, and attests them together. Use the official `actions/attest-build-provenance` action pinned to an immutable commit, grant `id-token: write` and `attestations: write` only to that job, and retain `contents: read`. Deployment jobs must compare the downloaded archive hash with the sidecar and reverify the attested subject against the workflow, source digest/ref, and GitHub-hosted runner policy before upload.
