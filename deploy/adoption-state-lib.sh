#!/bin/sh

skyjo_prepare_unit_backup() (
  set -eu
  live_unit=$1
  backup_unit=$2
  checksum_file=$3
  owner=$4
  group=$5
  expected_parent_uid=${6:-0}
  expected_parent_gid=${7:-0}
  [ -f "$live_unit" ] && [ ! -L "$live_unit" ] || { printf '%s\n' 'Live production unit is unsafe.' >&2; exit 1; }
  if [ -e "$checksum_file" ] || [ -L "$checksum_file" ]; then
    [ -f "$checksum_file" ] && [ ! -L "$checksum_file" ] || exit 1
    [ -f "$backup_unit" ] && [ ! -L "$backup_unit" ] || exit 1
  elif [ -e "$backup_unit" ] || [ -L "$backup_unit" ]; then
    [ -f "$backup_unit" ] && [ ! -L "$backup_unit" ] || exit 1
    /usr/bin/cmp -s "$live_unit" "$backup_unit" || exit 1
    digest=$(/usr/bin/sha256sum "$backup_unit" | /usr/bin/awk '{print $1}')
    skyjo_atomic_write_text "$checksum_file" "$owner" "$group" 0600 "$digest  $backup_unit
" false "$expected_parent_uid" "$expected_parent_gid" || exit 1
  else
    skyjo_atomic_install "$live_unit" "$backup_unit" "$owner" "$group" 0600 false "$expected_parent_uid" "$expected_parent_gid" || exit 1
    digest=$(/usr/bin/sha256sum "$backup_unit" | /usr/bin/awk '{print $1}')
    skyjo_atomic_write_text "$checksum_file" "$owner" "$group" 0600 "$digest  $backup_unit
" false "$expected_parent_uid" "$expected_parent_gid" || exit 1
  fi
  for protected_file in "$backup_unit" "$checksum_file"; do
    [ "$(/usr/bin/stat -c %u -- "$protected_file")" = "$expected_parent_uid" ] || exit 1
    [ "$(/usr/bin/stat -c %g -- "$protected_file")" = "$expected_parent_gid" ] || exit 1
    [ "$(/usr/bin/stat -c %a -- "$protected_file")" = 600 ] || exit 1
  done
  /usr/bin/sha256sum --check --strict "$checksum_file" >/dev/null || exit 1
  /usr/bin/cmp -s "$live_unit" "$backup_unit" || exit 1
)

skyjo_validate_legacy_release() (
  set -eu
  target=$1
  expected_sha=$2
  expected_uid=${3:-0}
  expected_gid=${4:-0}
  [ -d "$target" ] && [ ! -L "$target" ] || exit 1
  if /usr/bin/find "$target" -xdev \( ! -user "$expected_uid" -o ! -group "$expected_gid" \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
  if /usr/bin/find "$target" -xdev \( -type d -o -type f \) -perm /022 -print -quit | /usr/bin/grep -q .; then exit 1; fi
  if /usr/bin/find "$target" -xdev \( ! -type d ! -type f \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
  [ -f "$target/.skyjo-legacy" ] && [ ! -L "$target/.skyjo-legacy" ] || exit 1
  [ "$(/usr/bin/cat "$target/.skyjo-legacy")" = "$expected_sha" ] || exit 1
  [ -f "$target/.skyjo-deployment.json" ] && [ ! -L "$target/.skyjo-deployment.json" ] || exit 1
  [ "$(/usr/bin/cat "$target/.skyjo-deployment.json")" = "{\"releaseSha\":\"$expected_sha\",\"legacy\":true}" ] || exit 1
  [ -f "$target/.skyjo-legacy-manifest.sha256" ] && [ ! -L "$target/.skyjo-legacy-manifest.sha256" ] || exit 1
  (cd "$target" && /usr/bin/sha256sum --check --strict .skyjo-legacy-manifest.sha256 >/dev/null) || exit 1
)

skyjo_ensure_legacy_link() (
  set -eu
  link_path=$1
  relative_target=$2
  expected_uid=${3:-0}
  expected_gid=${4:-0}
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    [ -L "$link_path" ] || exit 1
    [ "$(/usr/bin/stat -c %u -- "$link_path")" = "$expected_uid" ] || exit 1
    [ "$(/usr/bin/stat -c %g -- "$link_path")" = "$expected_gid" ] || exit 1
    [ "$(/usr/bin/readlink -- "$link_path")" = "$relative_target" ] || exit 1
    exit 0
  fi
  skyjo_publish_relative_symlink "$link_path" "$relative_target" "$expected_uid" "$expected_gid"
)

skyjo_cleanup_legacy_staging() (
  set -eu
  releases=$1
  sha=$2
  expected_uid=${3:-0}
  expected_gid=${4:-0}
  maximum=${5:-4}
  count=0
  for candidate in "$releases/.legacy-$sha-"*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    count=$((count + 1))
    [ "$count" -le "$maximum" ] || exit 1
    [ -d "$candidate" ] && [ ! -L "$candidate" ] || exit 1
    [ "$(/usr/bin/stat -c %u -- "$candidate")" = "$expected_uid" ] || exit 1
    [ "$(/usr/bin/stat -c %g -- "$candidate")" = "$expected_gid" ] || exit 1
    /usr/bin/rm -rf -- "$candidate" || exit 1
  done
)
