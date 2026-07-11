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

## Package contract

The archive contains only:

- compiled `dist/` and `server-dist/` output;
- the Node server and its root-level runtime modules;
- the exact backup, restore, verification, and deployed-smoke scripts needed by the release controller;
- `package.json`, `package-lock.json`, and an `npm ci --omit=dev --ignore-scripts` production dependency tree;
- a reproducible CycloneDX 1.6 SBOM; and
- byte-identical release identities at the archive root and in `dist/`.

Source files, tests, development tooling, local state, environment files, and arbitrary scripts are not allowlisted. Packaging rejects source or installed symlinks and special filesystem entries. Verification rejects absolute paths, Windows paths, traversal, ambiguous segments, duplicate entries, links, devices, non-ustar extensions, missing runtime files, development dependencies in the SBOM, release identity drift, an unexpected filename, or any checksum mismatch before extraction.

GNU tar sorts entries and fixes owner, group, mode, and mtime from the release identity. GNU gzip uses `-n` to omit the original filename and timestamp. The builder verifies its own finished archive before reporting success.

## GitHub attestation handoff

The delivery workflow should attest the archive, checksum sidecar, and external SBOM together after `npm run release:artifact`. Use the official `actions/attest-build-provenance` action pinned to an immutable commit, grant `id-token: write` and `attestations: write` only to that job, retain `contents: read`, and keep checkout credential persistence disabled. The deploy job must compare the downloaded archive hash with the sidecar and the attested subject before upload.
