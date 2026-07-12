#!/bin/sh

skyjo_guard_bootstrap_generation() (
  set -eu
  store=$1
  expected_uid=$2
  expected_gid=$3
  [ -d "$store" ] && [ ! -L "$store" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$store")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$store")" = "$expected_gid" ] || exit 1
  store_mode=$(/usr/bin/stat -c %a -- "$store")
  [ $(((0$store_mode) & 0022)) -eq 0 ] || exit 1

  current="$store/current"
  [ -L "$current" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$current")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$current")" = "$expected_gid" ] || exit 1
  generation_name=$(/usr/bin/readlink -- "$current")
  printf '%s' "$generation_name" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || exit 1
  generation="$store/$generation_name"
  [ -d "$generation" ] && [ ! -L "$generation" ] || exit 1
  [ "$(/usr/bin/stat -c %u -- "$generation")" = "$expected_uid" ] || exit 1
  [ "$(/usr/bin/stat -c %g -- "$generation")" = "$expected_gid" ] || exit 1
  [ "$(/usr/bin/stat -c %a -- "$generation")" = 700 ] || exit 1
  if /usr/bin/find "$generation" -xdev \( ! -user "$expected_uid" -o ! -group "$expected_gid" \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
  if /usr/bin/find "$generation" -xdev \( -type d -o -type f \) -perm /022 -print -quit | /usr/bin/grep -q .; then exit 1; fi
  if /usr/bin/find "$generation" -xdev \( ! -type d ! -type f \) -print -quit | /usr/bin/grep -q .; then exit 1; fi
  manifest="$generation/bundle.sha256"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || exit 1
  [ "$(/usr/bin/stat -c %a -- "$manifest")" = 400 ] || exit 1
  (cd "$generation" && /usr/bin/sha256sum --check --strict bundle.sha256 >/dev/null) || exit 1
  script="$generation/bootstrap-skyjo-delivery.sh"
  [ -f "$script" ] && [ ! -L "$script" ] || exit 1
  [ "$(/usr/bin/stat -c %a -- "$script")" = 500 ] || exit 1
  printf '%s\n' "$script"
)
