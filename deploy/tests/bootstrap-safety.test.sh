#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../bootstrap-safety-lib.sh
. "$script_dir/bootstrap-safety-lib.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
uid=$(id -u)
gid=$(id -g)
chmod 0700 "$tmp"

printf '%s\n' immutable-snapshot > "$tmp/snapshot.pem"
printf '%s\n' original-input > "$tmp/original.pem"
cp "$tmp/original.pem" "$tmp/key-snapshot.pem"
printf '%s\n' swapped-after-snapshot > "$tmp/original.pem"
mkdir "$tmp/destinations"
chmod 0700 "$tmp/destinations"

mkdir "$tmp/poisoned-path"
for command in dd mv chmod chown; do
  printf '#!/bin/sh\nprintf "poisoned %s\\n" >&2\nexit 99\n' "$command" > "$tmp/poisoned-path/$command"
  chmod 0700 "$tmp/poisoned-path/$command"
done
PATH="$tmp/poisoned-path" skyjo_atomic_install "$tmp/key-snapshot.pem" \
  "$tmp/destinations/installed.pem" "$uid" "$gid" 0600 false "$uid" "$gid"
[ "$(cat "$tmp/destinations/installed.pem")" = original-input ]
[ "$(cat "$tmp/original.pem")" = swapped-after-snapshot ]

printf '%s\n' untouched > "$tmp/victim"
ln -s "$tmp/victim" "$tmp/destinations/symlink-destination"
if [ -L "$tmp/destinations/symlink-destination" ]; then
  if skyjo_atomic_install "$tmp/snapshot.pem" "$tmp/destinations/symlink-destination" \
    "$uid" "$gid" 0600 false "$uid" "$gid"; then
    printf '%s\n' 'Atomic install accepted a destination symlink.' >&2
    exit 1
  fi
  [ "$(cat "$tmp/victim")" = untouched ]
else
  printf '%s\n' 'POSIX destination-symlink rejection is exercised in Linux CI.'
fi

mkfifo "$tmp/destinations/special-destination"
if skyjo_atomic_write_text "$tmp/destinations/special-destination" "$uid" "$gid" 0600 \
  'replacement' false "$uid" "$gid"; then
  printf '%s\n' 'Atomic write accepted a special-file destination.' >&2
  exit 1
fi
rm "$tmp/destinations/special-destination"

mkdir "$tmp/real-parent"
chmod 0700 "$tmp/real-parent"
ln -s "$tmp/real-parent" "$tmp/symlink-parent"
if [ -L "$tmp/symlink-parent" ]; then
  if skyjo_atomic_install "$tmp/snapshot.pem" "$tmp/symlink-parent/installed" \
    "$uid" "$gid" 0600 false "$uid" "$gid"; then
    printf '%s\n' 'Atomic install accepted a symlinked destination parent.' >&2
    exit 1
  fi
  [ ! -e "$tmp/real-parent/installed" ]
else
  printf '%s\n' 'POSIX parent-symlink rejection is exercised in Linux CI.'
fi

skyjo_atomic_write_text "$tmp/destinations/text" "$uid" "$gid" 0600 'exact-content' false "$uid" "$gid"
[ "$(cat "$tmp/destinations/text")" = exact-content ]

printf '%s\n' 'bootstrap snapshot and no-follow destination regression passed'
