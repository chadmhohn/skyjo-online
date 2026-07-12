#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$script_dir/bootstrap-safety-lib.sh"
. "$script_dir/adoption-state-lib.sh"

tmp=$(mktemp -d)
cleanup() { case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac; }
trap cleanup EXIT
uid=$(id -u)
gid=$(id -g)
sha=$(printf 'a%.0s' {1..40})
mkdir "$tmp/backups" "$tmp/releases"
chmod 0700 "$tmp" "$tmp/backups" "$tmp/releases"
live="$tmp/live.service"
backup="$tmp/backups/legacy.service"
checksum="$backup.sha256"
printf '%s\n' '[Service]' 'ExecStart=/legacy' > "$live"

# Simulate interruption after backup publication but before checksum publication.
cp "$live" "$backup"
chmod 0600 "$backup"
if [ "$(stat -c %a "$backup")" != 600 ]; then
  printf '%s\n' 'POSIX adoption mode/link interruption regressions are exercised in Linux CI.'
  exit 0
fi
skyjo_prepare_unit_backup "$live" "$backup" "$checksum" "$uid" "$gid" "$uid" "$gid"
[ -f "$checksum" ]
sha256sum --check --strict "$checksum" >/dev/null

target="$tmp/releases/$sha"
mkdir "$target"
printf '%s\n' "$sha" > "$target/.skyjo-legacy"
printf '{"releaseSha":"%s","legacy":true}\n' "$sha" > "$target/.skyjo-deployment.json"
(
  cd "$target"
  find . -type f ! -name .skyjo-legacy-manifest.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$target/.skyjo-legacy-manifest.sha256"
chmod 0755 "$target"
find "$target" -type f -exec chmod 0644 {} +
skyjo_validate_legacy_release "$target" "$sha" "$uid" "$gid"

# Resume after target rename and after each individual link publication.
skyjo_ensure_legacy_link "$tmp/current" "releases/$sha" "$uid" "$gid"
if [ -L "$tmp/current" ]; then
  current_target=$(readlink "$tmp/current")
  current_inode=$(stat -c %i -- "$tmp/current")
  [ "$current_target" = "releases/$sha" ]
  [ ! -e "$tmp/previous" ]
  # A missing link is published with the numeric owner contract.
  skyjo_ensure_legacy_link "$tmp/previous" "releases/$sha" "$uid" "$gid"
  [ "$(readlink "$tmp/previous")" = "releases/$sha" ]
  # Existing exact links are accepted idempotently with the same numeric IDs.
  skyjo_ensure_legacy_link "$tmp/current" "releases/$sha" "$uid" "$gid"
  skyjo_ensure_legacy_link "$tmp/previous" "releases/$sha" "$uid" "$gid"
  [ "$(readlink "$tmp/current")" = "$current_target" ]
  [ "$(stat -c %i -- "$tmp/current")" = "$current_inode" ]
  [ "$(readlink "$tmp/previous")" = "releases/$sha" ]
  if skyjo_ensure_legacy_link "$tmp/current" "releases/$sha" "$(id -un)" "$(id -gn)"; then
    printf '%s\n' 'Adoption accepted account names instead of numeric ownership IDs.' >&2
    exit 1
  fi

  wrong_link="$tmp/wrong-target"
  wrong_target="releases/$(printf 'b%.0s' {1..40})"
  ln -s "$wrong_target" "$wrong_link"
  wrong_inode=$(stat -c %i -- "$wrong_link")
  if skyjo_ensure_legacy_link "$wrong_link" "releases/$sha" "$uid" "$gid"; then
    printf '%s\n' 'Adoption replaced an existing link with the wrong target.' >&2
    exit 1
  fi
  [ "$(readlink "$wrong_link")" = "$wrong_target" ]
  [ "$(stat -c %i -- "$wrong_link")" = "$wrong_inode" ]

  regular_path="$tmp/regular-current"
  printf '%s\n' 'not-a-link' > "$regular_path"
  regular_inode=$(stat -c %i -- "$regular_path")
  if skyjo_ensure_legacy_link "$regular_path" "releases/$sha" "$uid" "$gid"; then
    printf '%s\n' 'Adoption replaced an existing regular file.' >&2
    exit 1
  fi
  [ ! -L "$regular_path" ]
  [ "$(cat "$regular_path")" = 'not-a-link' ]
  [ "$(stat -c %i -- "$regular_path")" = "$regular_inode" ]

  unsafe_link="$tmp/unsafe-target"
  if skyjo_ensure_legacy_link "$unsafe_link" "../releases/$sha" "$uid" "$gid"; then
    printf '%s\n' 'Adoption accepted an unsafe relative link target.' >&2
    exit 1
  fi
  [ ! -e "$unsafe_link" ] && [ ! -L "$unsafe_link" ]
else
  printf '%s\n' 'POSIX adoption-link interruption regressions are exercised in Linux CI.'
fi

printf '%s\n' changed >> "$live"
if skyjo_prepare_unit_backup "$live" "$backup" "$checksum" "$uid" "$gid" "$uid" "$gid"; then
  printf '%s\n' 'Adoption accepted a live unit different from its verified backup.' >&2
  exit 1
fi

mkdir "$tmp/releases/.legacy-$sha-123" "$tmp/releases/.legacy-$sha-456"
if skyjo_cleanup_legacy_staging "$tmp/releases" "$sha" "$(id -un)" "$(id -gn)" 4; then
  printf '%s\n' 'Interrupted staging cleanup accepted account names instead of numeric ownership IDs.' >&2
  exit 1
fi
[ -d "$tmp/releases/.legacy-$sha-123" ]
[ -d "$tmp/releases/.legacy-$sha-456" ]
skyjo_cleanup_legacy_staging "$tmp/releases" "$sha" "$uid" "$gid" 4
[ ! -e "$tmp/releases/.legacy-$sha-123" ]
[ ! -e "$tmp/releases/.legacy-$sha-456" ]
printf '%s\n' 'adoption interruption and idempotent resume matrix passed'
