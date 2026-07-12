#!/bin/sh

skyjo_canonical_transport_public_key() (
  set -eu
  [ "$#" -eq 2 ] || { printf '%s\n' 'Transport-key validation requires a file and pinned fingerprint.' >&2; exit 1; }
  public_key=$1
  expected_fingerprint=$2
  [ -f "$public_key" ] && [ ! -L "$public_key" ] || { printf '%s\n' 'Deploy public key must be a regular file.' >&2; exit 1; }
  bytes=$(/usr/bin/wc -c < "$public_key" | /usr/bin/tr -d '[:space:]')
  case "$bytes" in ''|*[!0-9]*) printf '%s\n' 'Deploy public key size is invalid.' >&2; exit 1 ;; esac
  [ "$bytes" -ge 1 ] && [ "$bytes" -le 16384 ] || { printf '%s\n' 'Deploy public key size is invalid.' >&2; exit 1; }
  if /usr/bin/od -An -tx1 "$public_key" | /usr/bin/grep -Eq '(^|[[:space:]])00([[:space:]]|$)'; then
    printf '%s\n' 'Deploy public key contains a NUL byte.' >&2
    exit 1
  fi
  [ "$(/usr/bin/awk 'END { print NR }' "$public_key")" -eq 1 ] || {
    printf '%s\n' 'Deploy public key file must contain exactly one line.' >&2
    exit 1
  }
  final_byte=$(/usr/bin/tail -c 1 "$public_key" | /usr/bin/od -An -tx1 | /usr/bin/tr -d '[:space:]')
  [ "$final_byte" = 0a ] || { printf '%s\n' 'Deploy public key must end with LF or CRLF.' >&2; exit 1; }

  key=$(/usr/bin/sed -n '1p' "$public_key")
  carriage_return=$(printf '\r')
  case "$key" in *"$carriage_return") key=${key%"$carriage_return"} ;; esac
  case "$key" in *"$carriage_return"*) printf '%s\n' 'Deploy public key contains an embedded carriage return.' >&2; exit 1 ;; esac
  printf '%s' "$key" | LC_ALL=C /usr/bin/grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( [^[:cntrl:]]+)?$' || {
    printf '%s\n' 'Deploy key must be one canonical Ed25519 public key.' >&2
    exit 1
  }
  actual_fingerprint=$(/usr/bin/ssh-keygen -lf "$public_key" -E sha256 | /usr/bin/awk 'NR == 1 { print $2 }')
  [ "$actual_fingerprint" = "$expected_fingerprint" ] || {
    printf '%s\n' 'Deploy transport key does not match the pinned GitHub environment key.' >&2
    exit 1
  }
  printf '%s\n' "$key"
)
