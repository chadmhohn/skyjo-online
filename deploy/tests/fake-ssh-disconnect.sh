#!/usr/bin/env bash
set -Eeuo pipefail

command_line="${*: -1}"
printf '%s\n' "$command_line" >> "$SKYJO_FAKE_SSH_LOG"
if [[ "$command_line" != upload\ * ]]; then
  case "${SKYJO_FAKE_CONTROLLER_RESULT:-valid}" in
    empty) exit 0 ;;
    failed) exit 42 ;;
    valid) ;;
    *) exit 64 ;;
  esac
  read -r action run_id release_sha artifact_digest artifact_bytes tag issued_at expires_at key_id signature extra <<< "$command_line"
  [[ -z "${extra:-}" ]]
  case "$action" in
    verify) printf '{"verified":"%s","activated":false}\n' "$release_sha" ;;
    promote) printf '{"promoted":"%s","tag":"%s","backup":"20260712T010203Z-pre-%s"}\n' "$release_sha" "$tag" "$release_sha" ;;
    rollback) printf '{"rolledBackTo":"%040d","legacy":false}\n' 0 ;;
    *) exit 64 ;;
  esac
  exit 0
fi

read -r action run_id release_sha artifact_digest artifact_bytes tag issued_at expires_at key_id signature extra <<< "$command_line"
[[ "$action" == upload && -z "${extra:-}" ]]
payload_file="$SKYJO_FAKE_SSH_STATE/$run_id.payload.$$"
trap 'rm -f "$payload_file"' EXIT
cat > "$payload_file"
[[ "$(wc -c < "$payload_file" | tr -d '[:space:]')" == "$artifact_bytes" ]]
[[ "$(sha256sum "$payload_file" | awk '{print $1}')" == "$artifact_digest" ]]

request_file="$SKYJO_FAKE_SSH_STATE/$run_id.request"
applied_file="$SKYJO_FAKE_SSH_STATE/$run_id.applied"
retry_file="$SKYJO_FAKE_SSH_STATE/$run_id.retries"
if [[ ! -e "$applied_file" ]]; then
  printf '%s\n' "$command_line" > "$request_file"
  printf '1\n' > "$applied_file"
  if [[ "$run_id" == 123-1-canary ]]; then
    # Simulate the TCP/SSH session dropping after the remote side durably
    # accepted the upload but before the client received its acknowledgement.
    exit 255
  fi
else
  [[ "$(cat "$request_file")" == "$command_line" ]]
  [[ "$(cat "$applied_file")" == 1 ]]
  printf '1\n' > "$retry_file"
fi
printf 'uploaded %s %s idempotent\n' "$run_id" "$release_sha"
