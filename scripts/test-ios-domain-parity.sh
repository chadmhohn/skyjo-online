#!/usr/bin/env bash

# Rebuild the canonical TypeScript producer, replay the IOS-3 fixture corpus in
# TypeScript, then replay it through every SkyjoDomain Swift test with coverage.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
domain_package="$repo_root/ios/Packages/SkyjoDomain"
run_id="${GITHUB_RUN_ID:-local-$$}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
if [[ ! "$run_id" =~ ^(local-[0-9]+|[0-9]+)$ || ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: Invalid domain-parity artifact run identity.\n' >&2
  exit 1
fi
run_key="$run_id-$run_attempt"
domain_artifacts="${SKYJO_IOS_ARTIFACTS_DIR:-$repo_root/ios/Artifacts}/DomainParity-$run_key"
swift_scratch="$domain_artifacts/SwiftPM"
module_cache="$domain_artifacts/ModuleCache.noindex"

cd "$repo_root"
mkdir -p "$swift_scratch" "$module_cache"
export CLANG_MODULE_CACHE_PATH="$module_cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$module_cache"

npm run contracts:fixtures:check
"$repo_root/node_modules/.bin/vitest" run \
  --config "$repo_root/vitest.contracts.config.ts" \
  "$repo_root/tests/unit/contracts/domainParity.test.ts"

swift test \
  --package-path "$domain_package" \
  --scratch-path "$swift_scratch" \
  --enable-code-coverage

coverage_report="$(swift test \
  --package-path "$domain_package" \
  --scratch-path "$swift_scratch" \
  --show-codecov-path)"
if [[ ! -f "$coverage_report" ]]; then
  printf 'ERROR: SwiftPM did not produce the expected JSON coverage report.\n' >&2
  exit 1
fi

node "$repo_root/scripts/verify-swift-domain-coverage.mjs" \
  "$domain_package/Sources/SkyjoDomain" \
  < "$coverage_report"
