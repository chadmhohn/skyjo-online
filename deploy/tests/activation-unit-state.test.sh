#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$script_dir/activation-unit-state-lib.sh"
tmp=$(mktemp -d)
cleanup() { case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac; }
trap cleanup EXIT
printf '%s\n' legacy > "$tmp/legacy"
printf '%s\n' hardened > "$tmp/hardened"
cp "$tmp/legacy" "$tmp/live"
[ "$(skyjo_classify_activation_unit "$tmp/live" "$tmp/legacy" "$tmp/hardened")" = legacy ]
cp "$tmp/hardened" "$tmp/live"
[ "$(skyjo_classify_activation_unit "$tmp/live" "$tmp/legacy" "$tmp/hardened")" = hardened ]
printf '%s\n' ambiguous > "$tmp/live"
if skyjo_classify_activation_unit "$tmp/live" "$tmp/legacy" "$tmp/hardened" >/dev/null; then
  printf '%s\n' 'Activation unit classifier accepted unknown live content.' >&2
  exit 1
fi
printf '%s\n' 'activation legacy/hardened crash-state classifier passed'
