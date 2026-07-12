#!/bin/sh

skyjo_node_target_valid() (
  target=$1
  expected_version=$2
  [ -d "$target" ] && [ ! -L "$target" ] || return 1
  [ -x "$target/bin/node" ] && [ -f "$target/bin/node" ] && [ ! -L "$target/bin/node" ] || return 1
  [ -f "$target/lib/node_modules/npm/bin/npm-cli.js" ] && [ ! -L "$target/lib/node_modules/npm/bin/npm-cli.js" ] || return 1
  [ "$("$target/bin/node" --version 2>/dev/null)" = "v$expected_version" ] || return 1
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

  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$expected_version" && exit 0
    printf '%s\n' 'Existing Node runtime target is incomplete or invalid; refusing to replace it.' >&2
    exit 1
  fi
  [ -f "$archive" ] && [ ! -L "$archive" ] || { printf '%s\n' 'Node runtime archive is unsafe.' >&2; exit 1; }
  printf '%s  %s\n' "$expected_sha256" "$archive" | /usr/bin/sha256sum --check --status || {
    printf '%s\n' 'Pinned Node archive checksum failed.' >&2
    exit 1
  }

  install_tmp=$(/usr/bin/mktemp -d "$node_root/.node-v$expected_version.install.XXXXXX")
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
  /usr/bin/mkdir "$runtime"
  if [ "$owner" = - ]; then /usr/bin/chmod 0700 "$runtime" 2>/dev/null || true; else /usr/bin/chmod 0700 "$runtime"; fi

  /usr/bin/tar --list --xz --file "$archive" > "$listing"
  /usr/bin/awk -v root="$expected_archive_root" '
    BEGIN { seen = 0 }
    $0 == root || $0 == root "/" { seen = 1; next }
    index($0, root "/") == 1 && $0 !~ /(^|\/)\.\.($|\/)/ && $0 !~ /^\// { seen = 1; next }
    { exit 1 }
    END { if (!seen) exit 1 }
  ' "$listing" || { printf '%s\n' 'Node archive contains an unexpected root or path.' >&2; exit 1; }

  /usr/bin/tar --extract --xz --file "$archive" --directory "$runtime" \
    --strip-components=1 --no-same-owner --no-same-permissions
  skyjo_node_target_valid "$runtime" "$expected_version" || {
    printf '%s\n' 'Extracted Node runtime is incomplete or reports the wrong version.' >&2
    exit 1
  }
  if [ "$owner" != - ]; then
    /usr/bin/chown -R "$owner" "$runtime"
    /usr/bin/chmod -R u=rwX,go=rX "$runtime"
  else
    /usr/bin/chmod -R u=rwX,go=rX "$runtime" 2>/dev/null || true
  fi
  skyjo_node_target_valid "$runtime" "$expected_version" || {
    printf '%s\n' 'Prepared Node runtime failed final validation.' >&2
    exit 1
  }

  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$expected_version" && exit 0
    printf '%s\n' 'Node runtime target appeared during installation; refusing to replace it.' >&2
    exit 1
  fi
  /usr/bin/mv -T "$runtime" "$target"
  skyjo_node_target_valid "$target" "$expected_version" || {
    printf '%s\n' 'Published Node runtime failed validation.' >&2
    exit 1
  }
  /usr/bin/sync -f "$target" 2>/dev/null || true
  /usr/bin/sync -f "$node_root" 2>/dev/null || true
)
