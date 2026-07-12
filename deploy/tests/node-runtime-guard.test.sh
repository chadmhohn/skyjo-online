#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../node-runtime-guard-lib.sh
. "$script_dir/node-runtime-guard-lib.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

uid=$(id -u)
gid=$(id -g)
version=24.18.0
digest=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
root="$tmp/node-root"
target="$root/node-v$version"
sentinel="$tmp/fake-node-executed"
mkdir -p "$target/bin" "$target/lib/node_modules/npm/bin"
chmod 0700 "$tmp" "$root"
chmod 0755 "$target" "$target/bin" "$target/lib" "$target/lib/node_modules" "$target/lib/node_modules/npm" "$target/lib/node_modules/npm/bin"
cat > "$target/bin/node" <<EOF
#!/bin/sh
printf '%s\n' executed > '$sentinel'
EOF
chmod 0755 "$target/bin/node"
printf '%s\n' '// npm fixture' > "$target/lib/node_modules/npm/bin/npm-cli.js"
printf 'format=1\nversion=%s\narchive_sha256=%s\n' "$version" "$digest" > "$target/.skyjo-node-runtime"
chmod 0644 "$target/lib/node_modules/npm/bin/npm-cli.js" "$target/.skyjo-node-runtime"
ln -s "node-v$version" "$root/node"

if [ ! -L "$root/node" ]; then
  printf '%s\n' 'POSIX pre-execution Node guard regressions are exercised in Linux CI.'
  exit 0
fi

skyjo_guard_node_runtime "$root" "$version" "$digest" "$uid" "$gid" "$root"
[ ! -e "$sentinel" ]

chmod 0775 "$target/bin/node"
if skyjo_guard_node_runtime "$root" "$version" "$digest" "$uid" "$gid" "$root"; then
  printf '%s\n' 'Pre-execution guard accepted a group-writable Node binary.' >&2
  exit 1
fi
[ ! -e "$sentinel" ]
chmod 0755 "$target/bin/node"

printf 'format=1\nversion=%s\narchive_sha256=%064d\n' "$version" 0 > "$target/.skyjo-node-runtime"
if skyjo_guard_node_runtime "$root" "$version" "$digest" "$uid" "$gid" "$root"; then
  printf '%s\n' 'Pre-execution guard accepted a forged runtime marker.' >&2
  exit 1
fi
[ ! -e "$sentinel" ]

printf '%s\n' 'pre-execution Node runtime guard regression passed'
