#!/bin/sh

skyjo_classify_activation_unit() (
  set -eu
  live_unit=$1
  legacy_unit=$2
  hardened_unit=$3
  for unit in "$live_unit" "$legacy_unit" "$hardened_unit"; do
    [ -f "$unit" ] && [ ! -L "$unit" ] || exit 1
  done
  if /usr/bin/cmp -s "$live_unit" "$legacy_unit"; then
    printf '%s\n' legacy
  elif /usr/bin/cmp -s "$live_unit" "$hardened_unit"; then
    printf '%s\n' hardened
  else
    exit 1
  fi
)
