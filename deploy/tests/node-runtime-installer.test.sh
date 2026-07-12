#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../node-runtime-installer.sh
. "$script_dir/node-runtime-installer.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

version=24.18.0
archive_root="node-v$version-linux-x64"

make_payload() {
  destination=$1
  root_name=$2
  complete=$3
  mkdir -p "$destination/$root_name/bin" "$destination/$root_name/lib/node_modules/npm/bin"
  cat > "$destination/$root_name/bin/node" <<EOF
#!/bin/sh
[ "\${1:-}" = --version ] && printf '%s\n' v$version
EOF
  chmod 0755 "$destination/$root_name/bin/node"
  if [ "$complete" = true ]; then
    printf '%s\n' '// pinned npm cli fixture' > "$destination/$root_name/lib/node_modules/npm/bin/npm-cli.js"
  fi
}

make_archive() {
  source_root=$1
  root_name=$2
  archive=$3
  tar --create --xz --file "$archive" --directory "$source_root" "$root_name"
  sha256sum "$archive" | awk '{print $1}'
}

assert_no_staging() {
  node_root=$1
  if find "$node_root" -maxdepth 1 -name '.node-v*.install.*' -print -quit | grep -q .; then
    printf '%s\n' 'Node installer left a partial staging directory.' >&2
    exit 1
  fi
}

wrong_payload="$tmp/wrong-payload"
wrong_root="node-v$version"
make_payload "$wrong_payload" "$wrong_root" true
wrong_archive="$tmp/wrong-root.tar.xz"
wrong_digest=$(make_archive "$wrong_payload" "$wrong_root" "$wrong_archive")
wrong_node_root="$tmp/wrong-node-root"
mkdir "$wrong_node_root"
if skyjo_install_node_archive "$wrong_archive" "$wrong_digest" "$wrong_node_root" \
  "$wrong_node_root/node-v$version" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer accepted an archive whose root omitted the platform suffix.' >&2
  exit 1
fi
[ ! -e "$wrong_node_root/node-v$version" ]
assert_no_staging "$wrong_node_root"

incomplete_payload="$tmp/incomplete-payload"
make_payload "$incomplete_payload" "$archive_root" false
incomplete_archive="$tmp/incomplete.tar.xz"
incomplete_digest=$(make_archive "$incomplete_payload" "$archive_root" "$incomplete_archive")
incomplete_node_root="$tmp/incomplete-node-root"
mkdir "$incomplete_node_root"
if skyjo_install_node_archive "$incomplete_archive" "$incomplete_digest" "$incomplete_node_root" \
  "$incomplete_node_root/node-v$version" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer published an incomplete extracted runtime.' >&2
  exit 1
fi
[ ! -e "$incomplete_node_root/node-v$version" ]
assert_no_staging "$incomplete_node_root"

valid_payload="$tmp/valid-payload"
make_payload "$valid_payload" "$archive_root" true
valid_archive="$tmp/valid.tar.xz"
valid_digest=$(make_archive "$valid_payload" "$archive_root" "$valid_archive")
node_root="$tmp/node-root"
target="$node_root/node-v$version"
mkdir "$node_root"
skyjo_install_node_archive "$valid_archive" "$valid_digest" "$node_root" "$target" "$archive_root" "$version" -
skyjo_node_target_valid "$target" "$version"
[ ! -e "$node_root/$archive_root" ]
printf '%s\n' preserve-me > "$target/idempotency-marker"
skyjo_install_node_archive "$tmp/does-not-exist.tar.xz" "$(printf '0%.0s' {1..64})" \
  "$node_root" "$target" "$archive_root" "$version" -
[ "$(cat "$target/idempotency-marker")" = preserve-me ]
assert_no_staging "$node_root"

partial_root="$tmp/preexisting-partial-root"
partial_target="$partial_root/node-v$version"
mkdir -p "$partial_target"
printf '%s\n' do-not-clobber > "$partial_target/marker"
if skyjo_install_node_archive "$valid_archive" "$valid_digest" "$partial_root" "$partial_target" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer replaced a pre-existing invalid target.' >&2
  exit 1
fi
[ "$(cat "$partial_target/marker")" = do-not-clobber ]
assert_no_staging "$partial_root"

printf '%s\n' 'node runtime installer regression passed'
