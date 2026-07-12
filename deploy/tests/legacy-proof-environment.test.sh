#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$script_dir/bootstrap-safety-lib.sh"
. "$script_dir/legacy-proof-environment-lib.sh"

tmp=$(mktemp -d)
cleanup() { case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac; }
trap cleanup EXIT
uid=$(id -u)
gid=$(id -g)
chmod 0700 "$tmp"
content='SKYJO_EXPECTED_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
'

mkfifo "$tmp/stale.env"
if skyjo_publish_legacy_proof_environment "$tmp/stale.env" "$uid" "$gid" "$content" "$uid" "$gid"; then
  printf '%s\n' 'Legacy proof accepted an unsafe stale environment destination.' >&2
  exit 1
fi
rm "$tmp/stale.env"
printf '%s\n' stale > "$tmp/stale.env"
skyjo_publish_legacy_proof_environment "$tmp/stale.env" "$uid" "$gid" "$content" "$uid" "$gid"
printf '%s' "$content" > "$tmp/expected.env"
cmp -s "$tmp/stale.env" "$tmp/expected.env"
skyjo_remove_legacy_proof_environment "$tmp/stale.env"
[ ! -e "$tmp/stale.env" ]

mkdir "$tmp/cleanup-failure.env"
if skyjo_remove_legacy_proof_environment "$tmp/cleanup-failure.env"; then
  printf '%s\n' 'Legacy proof cleanup accepted an unremovable environment path.' >&2
  exit 1
fi
printf '%s\n' 'legacy proof stale environment and cleanup regression passed'
