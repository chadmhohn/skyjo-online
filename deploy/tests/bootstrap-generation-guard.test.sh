#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../bootstrap-generation-guard-lib.sh
. "$script_dir/bootstrap-generation-guard-lib.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
uid=$(id -u)
gid=$(id -g)
store="$tmp/bootstrap"
generation_name=$(printf 'a%.0s' {1..64})
generation="$store/$generation_name"
sentinel="$tmp/fake-bootstrap-executed"
mkdir -p "$generation/inputs"
chmod 0755 "$store"
chmod 0700 "$generation" "$generation/inputs"
cat > "$generation/bootstrap-skyjo-delivery.sh" <<EOF
#!/bin/sh
printf '%s\n' executed > '$sentinel'
EOF
chmod 0500 "$generation/bootstrap-skyjo-delivery.sh"
printf '%s\n' fixture > "$generation/inputs/key"
chmod 0600 "$generation/inputs/key"
(
  cd "$generation"
  find . -type f ! -name bundle.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$generation/bundle.sha256"
chmod 0400 "$generation/bundle.sha256"
ln -s "$generation_name" "$store/current"

if [ ! -L "$store/current" ]; then
  printf '%s\n' 'POSIX bootstrap generation guard regressions are exercised in Linux CI.'
  exit 0
fi

resolved=$(skyjo_guard_bootstrap_generation "$store" "$uid" "$gid")
[ "$resolved" = "$generation/bootstrap-skyjo-delivery.sh" ]
[ ! -e "$sentinel" ]

chmod 0770 "$generation"
if skyjo_guard_bootstrap_generation "$store" "$uid" "$gid" >/dev/null; then
  printf '%s\n' 'Bootstrap guard accepted a writable generation.' >&2
  exit 1
fi
[ ! -e "$sentinel" ]
chmod 0700 "$generation"

chmod 0700 "$generation/bootstrap-skyjo-delivery.sh"
if skyjo_guard_bootstrap_generation "$store" "$uid" "$gid" >/dev/null; then
  printf '%s\n' 'Bootstrap guard accepted a writable fake bootstrap.' >&2
  exit 1
fi
[ ! -e "$sentinel" ]

printf '%s\n' 'pre-execution bootstrap generation guard regression passed'
