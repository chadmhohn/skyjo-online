#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../transport-key-lib.sh
. "$script_dir/transport-key-lib.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

/usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$tmp/transport"
expected_line=$(/usr/bin/sed -n '1p' "$tmp/transport.pub")
expected_fingerprint=$(/usr/bin/ssh-keygen -lf "$tmp/transport.pub" -E sha256 | /usr/bin/awk 'NR == 1 { print $2 }')
/usr/bin/sed 's/$/\r/' "$tmp/transport.pub" > "$tmp/transport-crlf.pub"

canonical=$(skyjo_canonical_transport_public_key "$tmp/transport-crlf.pub" "$expected_fingerprint")
[ "$canonical" = "$expected_line" ]
if printf '%s' "$canonical" | /usr/bin/od -An -tx1 | /usr/bin/grep -Eq '(^|[[:space:]])0d([[:space:]]|$)'; then
  printf '%s\n' 'Canonical transport key retained a carriage return.' >&2
  exit 1
fi

options='restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/opt/skyjo-online/node/bin/node /usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs"'
printf '%s %s\n' "$options" "$canonical" > "$tmp/authorized_keys"
[ "$(/usr/bin/awk 'END { print NR }' "$tmp/authorized_keys")" -eq 1 ]
[ "$(/usr/bin/tail -c 1 "$tmp/authorized_keys" | /usr/bin/od -An -tx1 | /usr/bin/tr -d '[:space:]')" = 0a ]
if /usr/bin/od -An -tx1 "$tmp/authorized_keys" | /usr/bin/grep -Eq '(^|[[:space:]])0d([[:space:]]|$)'; then
  printf '%s\n' 'Installed authorized_keys contains a carriage return.' >&2
  exit 1
fi
LC_ALL=C /usr/bin/grep -Eq '^restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/opt/skyjo-online/node/bin/node /usr/local/lib/skyjo-online/skyjo-deploy-dispatch\.mjs" ssh-ed25519 [A-Za-z0-9+/=]+( [^[:cntrl:]]+)?$' "$tmp/authorized_keys"

assert_rejected() {
  candidate=$1
  fingerprint=${2:-$expected_fingerprint}
  if skyjo_canonical_transport_public_key "$candidate" "$fingerprint" >/dev/null 2>&1; then
    printf 'Malformed transport key was accepted: %s\n' "$candidate" >&2
    exit 1
  fi
}

/usr/bin/cat "$tmp/transport.pub" "$tmp/transport.pub" > "$tmp/multiple.pub"
printf '%s\rmalformed\r\n' "$expected_line" > "$tmp/embedded-cr.pub"
printf '%s\0\n' "$expected_line" > "$tmp/nul.pub"
printf '%s' "$expected_line" > "$tmp/no-final-newline.pub"
assert_rejected "$tmp/multiple.pub"
assert_rejected "$tmp/embedded-cr.pub"
assert_rejected "$tmp/nul.pub"
assert_rejected "$tmp/no-final-newline.pub"
assert_rejected "$tmp/transport-crlf.pub" 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

printf '%s\n' 'transport key CRLF canonicalization regression passed'
