#!/bin/sh

skyjo_guard_directory() (
  set -eu
  directory=$1
  expected_uid=$2
  expected_gid=$3
  [ -d "$directory" ] && [ ! -L "$directory" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$directory")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$directory")" = "$expected_gid" ] || exit 1
  mode=$(/usr/bin/stat -c %a -- "$directory")
  [ $(((0$mode) & 0022)) -eq 0 ] || exit 1
)

skyjo_guard_regular_file() (
  set -eu
  file=$1
  expected_uid=$2
  expected_gid=$3
  require_executable=${4:-false}
  [ -f "$file" ] && [ ! -L "$file" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$file")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$file")" = "$expected_gid" ] || exit 1
  mode=$(/usr/bin/stat -c %a -- "$file")
  [ $(((0$mode) & 0022)) -eq 0 ] || exit 1
  [ "$require_executable" != true ] || [ -x "$file" ] || exit 1
)

skyjo_guard_node_runtime() (
  set -eu
  node_root=$1
  expected_version=$2
  expected_sha256=$3
  expected_uid=$4
  expected_gid=$5
  chain_floor=$6
  case "$node_root:$chain_floor" in /*:/*) ;; *) exit 1 ;; esac

  current=$node_root
  while :; do
    skyjo_guard_directory "$current" "$expected_uid" "$expected_gid" || exit 1
    [ "$current" = "$chain_floor" ] && break
    [ "$current" != / ] || exit 1
    current=$(/usr/bin/dirname -- "$current")
  done

  target="$node_root/node-v$expected_version"
  for directory in \
    "$target" \
    "$target/bin" \
    "$target/lib" \
    "$target/lib/node_modules" \
    "$target/lib/node_modules/npm" \
    "$target/lib/node_modules/npm/bin"; do
    skyjo_guard_directory "$directory" "$expected_uid" "$expected_gid" || exit 1
  done
  skyjo_guard_regular_file "$target/bin/node" "$expected_uid" "$expected_gid" true || exit 1
  skyjo_guard_regular_file "$target/lib/node_modules/npm/bin/npm-cli.js" "$expected_uid" "$expected_gid" || exit 1
  skyjo_guard_regular_file "$target/.skyjo-node-runtime" "$expected_uid" "$expected_gid" || exit 1
  printf 'format=1\nversion=%s\narchive_sha256=%s\n' "$expected_version" "$expected_sha256" | \
    /usr/bin/cmp -s - "$target/.skyjo-node-runtime" || exit 1

  link_path="$node_root/node"
  [ -L "$link_path" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$link_path")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$link_path")" = "$expected_gid" ] || exit 1
  [ "$(/usr/bin/readlink -- "$link_path")" = "node-v$expected_version" ] || exit 1
)
