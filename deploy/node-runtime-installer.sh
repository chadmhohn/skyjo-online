#!/bin/sh

skyjo_node_marker() {
  printf 'format=1\nversion=%s\narchive_sha256=%s\n' "$1" "$2"
}

skyjo_node_target_valid() (
  set -eu
  target=$1
  expected_version=$2
  expected_sha256=$3
  owner=${4:-root:root}
  [ -d "$target" ] && [ ! -L "$target" ] || exit 1
  [ -x "$target/bin/node" ] && [ -f "$target/bin/node" ] && [ ! -L "$target/bin/node" ] || exit 1
  [ -f "$target/lib/node_modules/npm/bin/npm-cli.js" ] && [ ! -L "$target/lib/node_modules/npm/bin/npm-cli.js" ] || exit 1
  [ -f "$target/.skyjo-node-runtime" ] && [ ! -L "$target/.skyjo-node-runtime" ] || exit 1
  skyjo_node_marker "$expected_version" "$expected_sha256" | /usr/bin/cmp -s - "$target/.skyjo-node-runtime" || exit 1
  if [ "$owner" != - ]; then
    skyjo_assert_root_directory_chain "$target" || exit 1
    if /usr/bin/find "$target" -xdev \( ! -user root -o ! -group root \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
    if /usr/bin/find "$target" -xdev \( -type d -o -type f \) -perm /022 -print -quit | /usr/bin/grep -q .; then exit 1; fi
    if /usr/bin/find "$target" -xdev \( ! -type d ! -type f ! -type l \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
  fi
  [ "$("$target/bin/node" --version 2>/dev/null)" = "v$expected_version" ] || exit 1
)

skyjo_node_install_lock() (
  set -eu
  node_root=$1
  owner=${2:-root:root}
  lock_path="$node_root/.node-install.lock"
  if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
    [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
      printf '%s\n' 'Node installation lock is unsafe.' >&2
      exit 1
    }
  else
    ( set -C; : > "$lock_path" ) 2>/dev/null || true
  fi
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || exit 1
  if [ "$owner" != - ]; then
    /usr/bin/chown root:root -- "$lock_path" || exit 1
    /usr/bin/chmod 0600 -- "$lock_path" || exit 1
  else
    /usr/bin/chmod 0600 -- "$lock_path" 2>/dev/null || true
  fi
  printf '%s\n' "$lock_path"
)

skyjo_install_node_archive() (
  set -eu
  archive=$1
  expected_sha256=$2
  node_root=$3
  target=$4
  expected_archive_root=$5
  expected_version=$6
  owner=${7:-root:root}

  [ -d "$node_root" ] && [ ! -L "$node_root" ] || { printf '%s\n' 'Node runtime root is unsafe.' >&2; exit 1; }
  [ "$target" = "$node_root/node-v$expected_version" ] || { printf '%s\n' 'Node runtime target is invalid.' >&2; exit 1; }
  [ "$expected_archive_root" = "node-v$expected_version-linux-x64" ] || { printf '%s\n' 'Node archive root is invalid.' >&2; exit 1; }
  if [ "$owner" != - ]; then skyjo_assert_root_directory_chain "$node_root" || exit 1; fi

  lock_path=$(skyjo_node_install_lock "$node_root" "$owner") || exit 1
  exec 9<>"$lock_path" || exit 1
  /usr/bin/flock --exclusive 9 || exit 1

  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$expected_version" "$expected_sha256" "$owner" && exit 0
    printf '%s\n' 'Existing Node runtime target is incomplete or invalid; refusing to replace it.' >&2
    exit 1
  fi
  [ -f "$archive" ] && [ ! -L "$archive" ] || { printf '%s\n' 'Node runtime archive is unsafe.' >&2; exit 1; }
  printf '%s  %s\n' "$expected_sha256" "$archive" | /usr/bin/sha256sum --check --status || {
    printf '%s\n' 'Pinned Node archive checksum failed.' >&2
    exit 1
  }

  install_tmp=$(/usr/bin/mktemp -d "$node_root/.node-v$expected_version.install.XXXXXX") || exit 1
  cleanup_node_install() {
    case "$install_tmp" in
      "$node_root"/.node-v"$expected_version".install.*) /usr/bin/rm -rf -- "$install_tmp" ;;
      *) printf '%s\n' 'Refusing to clean an unexpected Node staging path.' >&2 ;;
    esac
  }
  trap cleanup_node_install EXIT
  trap 'exit 1' HUP INT TERM
  listing="$install_tmp/archive.list"
  runtime="$install_tmp/runtime"
  /usr/bin/mkdir "$runtime" || exit 1
  /usr/bin/chmod 0700 "$runtime" || exit 1

  if [ "$owner" = - ] && [ -n "${SKYJO_NODE_INSTALL_TEST_READY_FILE:-}" ]; then
    : > "$SKYJO_NODE_INSTALL_TEST_READY_FILE" || exit 1
    /usr/bin/sleep "${SKYJO_NODE_INSTALL_TEST_PAUSE_SECONDS:-30}" || exit 1
  fi

  /usr/bin/tar --list --xz --file "$archive" > "$listing" || exit 1
  /usr/bin/awk -v root="$expected_archive_root" '
    BEGIN { seen = 0 }
    $0 == root || $0 == root "/" { seen = 1; next }
    index($0, root "/") == 1 && $0 !~ /(^|\/)\.\.($|\/)/ && $0 !~ /^\// { seen = 1; next }
    { exit 1 }
    END { if (!seen) exit 1 }
  ' "$listing" || { printf '%s\n' 'Node archive contains an unexpected root or path.' >&2; exit 1; }

  /usr/bin/tar --extract --xz --file "$archive" --directory "$runtime" \
    --strip-components=1 --no-same-owner --no-same-permissions || exit 1
  [ -x "$runtime/bin/node" ] && [ -f "$runtime/bin/node" ] && [ ! -L "$runtime/bin/node" ] || {
    printf '%s\n' 'Extracted Node runtime is incomplete.' >&2
    exit 1
  }
  [ -f "$runtime/lib/node_modules/npm/bin/npm-cli.js" ] && [ ! -L "$runtime/lib/node_modules/npm/bin/npm-cli.js" ] || {
    printf '%s\n' 'Extracted Node runtime is missing npm.' >&2
    exit 1
  }
  skyjo_node_marker "$expected_version" "$expected_sha256" > "$runtime/.skyjo-node-runtime" || exit 1
  if [ "$owner" != - ]; then
    /usr/bin/chown -R "$owner" "$runtime" || exit 1
    /usr/bin/chmod -R u=rwX,go=rX "$runtime" || exit 1
    /usr/bin/chmod 0444 "$runtime/.skyjo-node-runtime" || exit 1
  else
    /usr/bin/chmod -R u=rwX,go=rX "$runtime" 2>/dev/null || true
    /usr/bin/chmod 0444 "$runtime/.skyjo-node-runtime" 2>/dev/null || true
  fi
  skyjo_node_target_valid "$runtime" "$expected_version" "$expected_sha256" - || {
    printf '%s\n' 'Prepared Node runtime failed final validation.' >&2
    exit 1
  }

  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$expected_version" "$expected_sha256" "$owner" && exit 0
    printf '%s\n' 'Node runtime target appeared during installation; refusing to replace it.' >&2
    exit 1
  fi
  /usr/bin/mv -T "$runtime" "$target" || exit 1
  skyjo_node_target_valid "$target" "$expected_version" "$expected_sha256" "$owner" || {
    printf '%s\n' 'Published Node runtime failed validation.' >&2
    exit 1
  }
  /usr/bin/sync -f "$target" 2>/dev/null || true
  /usr/bin/sync -f "$node_root" 2>/dev/null || true
)

skyjo_publish_node_symlink() (
  set -eu
  node_root=$1
  expected_version=$2
  expected_sha256=$3
  owner=${4:-root:root}
  target="$node_root/node-v$expected_version"
  skyjo_node_target_valid "$target" "$expected_version" "$expected_sha256" "$owner" || {
    printf '%s\n' 'Pinned Node target is not valid for symlink publication.' >&2
    exit 1
  }
  lock_path=$(skyjo_node_install_lock "$node_root" "$owner") || exit 1
  exec 9<>"$lock_path" || exit 1
  /usr/bin/flock --exclusive 9 || exit 1
  link_path="$node_root/node"
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    [ -L "$link_path" ] || { printf '%s\n' 'Node runtime link destination is not a symlink.' >&2; exit 1; }
    [ "$(/usr/bin/readlink -- "$link_path")" = "node-v$expected_version" ] || {
      printf '%s\n' 'Existing Node runtime link points to an unexpected target.' >&2
      exit 1
    }
    [ "$owner" = - ] || { [ "$(/usr/bin/stat -c %u -- "$link_path")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$link_path")" = 0 ]; } || exit 1
    exit 0
  fi
  placeholder=$(/usr/bin/mktemp "$node_root/.node.link.XXXXXX") || exit 1
  /usr/bin/rm -f -- "$placeholder" || exit 1
  /usr/bin/ln -s -- "node-v$expected_version" "$placeholder" || exit 1
  if [ "$owner" != - ]; then /usr/bin/chown -h root:root -- "$placeholder" || exit 1; fi
  /usr/bin/mv -Tf -- "$placeholder" "$link_path" || exit 1
  /usr/bin/sync -f "$node_root" 2>/dev/null || true
)
