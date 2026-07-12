#!/bin/sh

skyjo_path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

skyjo_assert_safe_parent() (
  set -eu
  destination=$1
  allow_sticky=${2:-false}
  expected_uid=${3:-0}
  expected_gid=${4:-0}
  parent=$(/usr/bin/dirname -- "$destination")
  [ -d "$parent" ] && [ ! -L "$parent" ] || {
    printf '%s\n' "Destination parent is not a safe directory: $parent" >&2
    exit 1
  }
  uid=$(/usr/bin/stat -c %u -- "$parent")
  gid=$(/usr/bin/stat -c %g -- "$parent")
  mode=$(/usr/bin/stat -c %a -- "$parent")
  [ "$uid" = "$expected_uid" ] || { printf '%s\n' "Destination parent has an unexpected owner: $parent" >&2; exit 1; }
  [ "$gid" = "$expected_gid" ] || { printf '%s\n' "Destination parent has an unexpected group: $parent" >&2; exit 1; }
  numeric_mode=$((0$mode))
  if [ $((numeric_mode & 0022)) -ne 0 ]; then
    [ "$allow_sticky" = true ] && [ $((numeric_mode & 01000)) -ne 0 ] || {
      printf '%s\n' "Destination parent is writable without an accepted sticky policy: $parent" >&2
      exit 1
    }
  fi
)

skyjo_assert_root_directory_chain() (
  set -eu
  current=$1
  case "$current" in /*) ;; *) printf '%s\n' 'Root directory-chain validation requires an absolute path.' >&2; exit 1 ;; esac
  while :; do
    [ -d "$current" ] && [ ! -L "$current" ] || {
      printf '%s\n' "Root path component is not a real directory: $current" >&2
      exit 1
    }
    uid=$(/usr/bin/stat -c %u -- "$current")
    gid=$(/usr/bin/stat -c %g -- "$current")
    mode=$(/usr/bin/stat -c %a -- "$current")
    [ "$uid" = 0 ] || { printf '%s\n' "Root path component is not root-owned: $current" >&2; exit 1; }
    [ "$gid" = 0 ] || { printf '%s\n' "Root path component is not root-group-owned: $current" >&2; exit 1; }
    [ $(((0$mode) & 0022)) -eq 0 ] || {
      printf '%s\n' "Root path component is group/world writable: $current" >&2
      exit 1
    }
    [ "$current" = / ] && break
    current=$(/usr/bin/dirname -- "$current")
  done
)

skyjo_secure_directory() (
  set -eu
  destination=$1
  owner=$2
  group=$3
  mode=$4
  allow_sticky=${5:-false}
  expected_parent_uid=${6:-0}
  expected_parent_gid=${7:-0}
  skyjo_assert_safe_parent "$destination" "$allow_sticky" "$expected_parent_uid" "$expected_parent_gid" || exit 1
  if skyjo_path_exists "$destination"; then
    [ -d "$destination" ] && [ ! -L "$destination" ] || {
      printf '%s\n' "Refusing unsafe pre-existing directory destination: $destination" >&2
      exit 1
    }
  else
    /usr/bin/mkdir -m 0700 -- "$destination" || exit 1
  fi
  /usr/bin/chown "$owner:$group" -- "$destination" || exit 1
  /usr/bin/chmod "$mode" -- "$destination" || exit 1
)

skyjo_assert_regular_destination() (
  set -eu
  destination=$1
  allow_sticky=${2:-false}
  expected_parent_uid=${3:-0}
  expected_parent_gid=${4:-0}
  skyjo_assert_safe_parent "$destination" "$allow_sticky" "$expected_parent_uid" "$expected_parent_gid" || exit 1
  if skyjo_path_exists "$destination"; then
    [ -f "$destination" ] && [ ! -L "$destination" ] || {
      printf '%s\n' "Refusing unsafe pre-existing file destination: $destination" >&2
      exit 1
    }
  fi
)

skyjo_atomic_install() (
  set -eu
  source=$1
  destination=$2
  owner=$3
  group=$4
  mode=$5
  allow_sticky=${6:-false}
  expected_parent_uid=${7:-0}
  expected_parent_gid=${8:-0}
  [ -f "$source" ] && [ ! -L "$source" ] || {
    printf '%s\n' "Install source is not a safe regular file: $source" >&2
    exit 1
  }
  skyjo_assert_regular_destination "$destination" "$allow_sticky" "$expected_parent_uid" "$expected_parent_gid" || exit 1
  parent=$(/usr/bin/dirname -- "$destination")
  base=$(/usr/bin/basename -- "$destination")
  temporary=$(/usr/bin/mktemp "$parent/.$base.install.XXXXXX") || exit 1
  cleanup_atomic_install() { /usr/bin/rm -f -- "$temporary"; }
  trap cleanup_atomic_install EXIT HUP INT TERM
  /usr/bin/rm -f -- "$temporary" || exit 1
  /usr/bin/cp --no-dereference --reflink=never -- "$source" "$temporary" || exit 1
  [ -f "$temporary" ] && [ ! -L "$temporary" ] || exit 1
  /usr/bin/chown "$owner:$group" -- "$temporary" || exit 1
  /usr/bin/chmod "$mode" -- "$temporary" || exit 1
  /usr/bin/sync -f "$temporary" 2>/dev/null || true
  /usr/bin/mv -Tf -- "$temporary" "$destination" || exit 1
  /usr/bin/sync -f "$destination" 2>/dev/null || true
  /usr/bin/sync -f "$parent" 2>/dev/null || true
  trap - EXIT HUP INT TERM
)

skyjo_atomic_write_text() (
  set -eu
  destination=$1
  owner=$2
  group=$3
  mode=$4
  content=$5
  allow_sticky=${6:-false}
  expected_parent_uid=${7:-0}
  expected_parent_gid=${8:-0}
  skyjo_assert_regular_destination "$destination" "$allow_sticky" "$expected_parent_uid" "$expected_parent_gid" || exit 1
  parent=$(/usr/bin/dirname -- "$destination")
  base=$(/usr/bin/basename -- "$destination")
  temporary=$(/usr/bin/mktemp "$parent/.$base.write.XXXXXX") || exit 1
  cleanup_atomic_write() { /usr/bin/rm -f -- "$temporary"; }
  trap cleanup_atomic_write EXIT HUP INT TERM
  printf '%s' "$content" > "$temporary" || exit 1
  /usr/bin/chown "$owner:$group" -- "$temporary" || exit 1
  /usr/bin/chmod "$mode" -- "$temporary" || exit 1
  /usr/bin/sync -f "$temporary" 2>/dev/null || true
  /usr/bin/mv -Tf -- "$temporary" "$destination" || exit 1
  /usr/bin/sync -f "$parent" 2>/dev/null || true
  trap - EXIT HUP INT TERM
)

skyjo_publish_relative_symlink() (
  set -eu
  link_path=$1
  relative_target=$2
  expected_parent_uid=${3:-0}
  expected_parent_gid=${4:-0}
  skyjo_assert_safe_parent "$link_path" false "$expected_parent_uid" "$expected_parent_gid" || exit 1
  case "$relative_target" in ''|/*|*..*) printf '%s\n' 'Relative symlink target is unsafe.' >&2; exit 1 ;; esac
  if skyjo_path_exists "$link_path"; then
    [ -L "$link_path" ] || { printf '%s\n' "Refusing non-symlink publication target: $link_path" >&2; exit 1; }
    [ "$(/usr/bin/stat -c %u -- "$link_path")" = "$expected_parent_uid" ] || {
      printf '%s\n' "Existing symlink has an unexpected owner: $link_path" >&2
      exit 1
    }
    [ "$(/usr/bin/stat -c %g -- "$link_path")" = "$expected_parent_gid" ] || {
      printf '%s\n' "Existing symlink has an unexpected group: $link_path" >&2
      exit 1
    }
    [ "$(/usr/bin/readlink -- "$link_path")" = "$relative_target" ] && exit 0
  fi
  parent=$(/usr/bin/dirname -- "$link_path")
  base=$(/usr/bin/basename -- "$link_path")
  placeholder=$(/usr/bin/mktemp "$parent/.$base.link.XXXXXX") || exit 1
  /usr/bin/rm -f -- "$placeholder" || exit 1
  /usr/bin/ln -s -- "$relative_target" "$placeholder" || exit 1
  if [ "$expected_parent_uid" = 0 ] && [ "$expected_parent_gid" = 0 ]; then /usr/bin/chown -h root:root -- "$placeholder" || exit 1; fi
  /usr/bin/mv -Tf -- "$placeholder" "$link_path" || exit 1
  /usr/bin/sync -f "$parent" 2>/dev/null || true
)
