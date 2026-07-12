#!/usr/bin/env bash
set -Eeuo pipefail

command_line="${*: -1}"
printf '%s\n' "$command_line" >> "$SKYJO_FAKE_SSH_LOG"
if [[ "$command_line" != upload\ * ]]; then
  case "${SKYJO_FAKE_CONTROLLER_RESULT:-valid}" in
    empty) exit 0 ;;
    malformed) printf '%s\n' '{"unexpected":true}'; exit 0 ;;
    failed) exit 42 ;;
    valid) ;;
    *) exit 64 ;;
  esac
  read -r action run_id release_sha artifact_digest tag issued_at expires_at key_id signature extra <<< "$command_line"
  [[ -z "${extra:-}" ]]
  result_file="$SKYJO_FAKE_SSH_STATE/$action-$run_id.result"
  request_file="$SKYJO_FAKE_SSH_STATE/$action-$run_id.request"
  applied_file="$SKYJO_FAKE_SSH_STATE/$action-$run_id.applied"
  retry_file="$SKYJO_FAKE_SSH_STATE/$action-$run_id.retry"
  if [[ ! -e "$applied_file" ]]; then
    printf '%s\n' "$command_line" > "$request_file"
    case "$action" in
      verify) printf '{"verified":"%s","activated":false}\n' "$release_sha" > "$result_file" ;;
      promote) printf '{"promoted":"%s","tag":"%s","backup":"20260712T010203Z-pre-%s"}\n' "$release_sha" "$tag" "$release_sha" > "$result_file" ;;
      rollback) printf '{"rolledBackTo":"%040d","legacy":false}\n' 0 > "$result_file" ;;
      *) exit 64 ;;
    esac
    printf '1\n' > "$applied_file"
    if [[ "${SKYJO_FAKE_PRIVILEGED_DISCONNECT:-}" == all ]]; then
      exit 255
    fi
  else
    [[ "$(cat "$request_file")" == "$command_line" ]]
    [[ "$(cat "$applied_file")" == 1 ]]
    printf '1\n' > "$retry_file"
    conflict_file="$SKYJO_FAKE_SSH_STATE/$action-$run_id.conflict"
    if [[ "${SKYJO_FAKE_PRIVILEGED_CONFLICT:-}" == once && ! -e "$conflict_file" ]]; then
      printf '1\n' > "$conflict_file"
      exit 73
    fi
  fi
  cat "$result_file"
  exit 0
fi

read -r action run_id release_sha artifact_bytes extra <<< "$command_line"
[[ "$action" == upload && -z "${extra:-}" ]]
payload_file="$SKYJO_FAKE_SSH_STATE/$run_id.payload.$$"
trap 'rm -f "$payload_file"' EXIT
cat > "$payload_file"
[[ "$(wc -c < "$payload_file" | tr -d '[:space:]')" == "$artifact_bytes" ]]

request_file="$SKYJO_FAKE_SSH_STATE/$run_id.request"
applied_file="$SKYJO_FAKE_SSH_STATE/$run_id.applied"
retry_file="$SKYJO_FAKE_SSH_STATE/$run_id.retries"
if [[ ! -e "$applied_file" ]]; then
  printf '%s\n' "$command_line" > "$request_file"
  printf '1\n' > "$applied_file"
  if [[ "$run_id" == 123-1-canary ]]; then
    # Simulate a disconnect after durable publication but before its ACK.
    exit 255
  fi
else
  [[ "$(cat "$request_file")" == "$command_line" ]]
  [[ "$(cat "$applied_file")" == 1 ]]
  printf '1\n' > "$retry_file"
fi
printf 'uploaded %s %s idempotent\n' "$run_id" "$release_sha"
