#!/usr/bin/env bash

# Read-only Mac readiness check for the native iOS handoff.
set -u

failures=0
warnings=0

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
  pass "macOS detected ($(sw_vers -productVersion 2>/dev/null || printf 'unknown version'))"
else
  fail "This preflight must run on macOS."
fi

if command_exists xcode-select && developer_dir="$(xcode-select -p 2>/dev/null)"; then
  if [ -x "$developer_dir/usr/bin/xcodebuild" ] || command_exists xcodebuild; then
    pass "Xcode developer directory: $developer_dir"
  else
    fail "The selected developer directory does not contain the full Xcode toolchain."
  fi
else
  fail "Xcode command-line selection is unavailable. Install Xcode and select Xcode.app."
fi

if command_exists xcodebuild; then
  xcode_version="$(xcodebuild -version 2>/dev/null || true)"
  if [ -n "$xcode_version" ]; then
    printf '%s\n' "$xcode_version"
    xcode_major="$(printf '%s\n' "$xcode_version" | awk '/^Xcode / { split($2, parts, "."); print parts[1]; exit }')"
    if [ -n "$xcode_major" ] && [ "$xcode_major" -ge 26 ] 2>/dev/null; then
      pass "Xcode satisfies the current App Store SDK baseline."
    else
      fail "Xcode 26 or later is required by the current handoff; re-check Apple's upload requirements."
    fi
  else
    fail "xcodebuild could not report a version. Complete Xcode first-launch setup."
  fi
else
  fail "xcodebuild is unavailable."
fi

if command_exists swift; then
  swift_version="$(swift --version 2>/dev/null | head -n 1)"
  [ -n "$swift_version" ] && pass "$swift_version" || fail "Swift could not report a version."
else
  fail "Swift is unavailable."
fi

if command_exists xcrun && simulator_devices="$(xcrun simctl list devices available 2>/dev/null || true)"; then
  if printf '%s\n' "$simulator_devices" | grep -q 'iPhone'; then
    pass "At least one iPhone Simulator device is available."
  else
    fail "No available iPhone Simulator was found. Install an iOS runtime in Xcode Components."
  fi
  if printf '%s\n' "$simulator_devices" | grep -q 'iPad'; then
    pass "At least one iPad Simulator device is available."
  else
    warn "No available iPad Simulator was found; iPad is required before parity certification."
  fi
else
  fail "simctl is unavailable or could not enumerate devices."
fi

if command_exists git; then
  pass "$(git --version)"
else
  fail "Git is unavailable."
fi

if command_exists gh; then
  if gh auth status >/dev/null 2>&1; then
    pass "GitHub CLI is authenticated."
  else
    fail "GitHub CLI is installed but not authenticated. Run gh auth login."
  fi
else
  fail "GitHub CLI is unavailable."
fi

if command_exists node; then
  node_version="$(node --version 2>/dev/null || true)"
  node_major="$(printf '%s' "$node_version" | sed -E 's/^v([0-9]+).*/\1/')"
  node_minor="$(printf '%s' "$node_version" | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')"
  if [ "$node_major" = "24" ] && [ -n "$node_minor" ] && [ "$node_minor" -ge 15 ] 2>/dev/null; then
    pass "Node $node_version satisfies the repository's Node 24.15+ line."
  else
    fail "Node 24.15 or later (but below 25) is required; found ${node_version:-unknown}."
  fi
else
  fail "Node is unavailable. Install the version from .node-version."
fi

if command_exists npm; then
  npm_version="$(npm --version 2>/dev/null || true)"
  npm_major="$(printf '%s' "$npm_version" | sed -E 's/^([0-9]+).*/\1/')"
  if [ -n "$npm_major" ] && [ "$npm_major" -ge 11 ] 2>/dev/null; then
    pass "npm $npm_version satisfies the repository baseline."
  else
    fail "npm 11 or later is required; found ${npm_version:-unknown}."
  fi
else
  fail "npm is unavailable."
fi

if command_exists curl; then
  version_json="$(curl --connect-timeout 5 --max-time 10 -fsS https://skyjo.groundworkrevops.com/version 2>/dev/null || true)"
  ready_json="$(curl --connect-timeout 5 --max-time 10 -fsS https://skyjo.groundworkrevops.com/readyz 2>/dev/null || true)"
  if [ -n "$version_json" ]; then
    pass "Production /version responded: $version_json"
  else
    warn "Production /version was not reachable; local development can continue, but compatibility is unverified."
  fi
  if printf '%s' "$ready_json" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"'; then
    pass "Production /readyz reports ready."
  elif [ -n "$ready_json" ]; then
    warn "Production /readyz responded without ready status: $ready_json"
  else
    warn "Production /readyz was not reachable."
  fi
else
  warn "curl is unavailable; public release/readiness checks were skipped."
fi

printf '\nPreflight complete: %d failure(s), %d warning(s).\n' "$failures" "$warnings"
[ "$failures" -eq 0 ]
