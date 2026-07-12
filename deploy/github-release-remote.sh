#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  github-release-remote.sh verify <run-id> <release-sha> <archive> <checksum>
  github-release-remote.sh promote <run-id> <release-sha> <archive> <checksum> <vX.Y.Z-tag>
  github-release-remote.sh rollback <run-id> <failed-release-sha> <checksum> <vX.Y.Z-tag>

Required environment:
  SKYJO_DEPLOY_HOST
  SKYJO_DEPLOY_PORT
  SKYJO_DEPLOY_USER
  SKYJO_DEPLOY_IDENTITY_FILE
  SKYJO_DEPLOY_KNOWN_HOSTS_FILE
  SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE
EOF
  exit 64
}

die() {
  printf 'Deploy transport error: %s\n' "$1" >&2
  exit 65
}

mode="${1:-}"
case "$mode" in
  verify)
    [[ $# -eq 5 ]] || usage
    run_id="$2"
    release_sha="$3"
    archive_path="$4"
    checksum_path="$5"
    release_tag=""
    ;;
  promote)
    [[ $# -eq 6 ]] || usage
    run_id="$2"
    release_sha="$3"
    archive_path="$4"
    checksum_path="$5"
    release_tag="$6"
    ;;
  rollback)
    [[ $# -eq 5 ]] || usage
    run_id="$2"
    release_sha="$3"
    archive_path=""
    checksum_path="$4"
    release_tag="$5"
    ;;
  *) usage ;;
esac

deploy_host="${SKYJO_DEPLOY_HOST:-}"
deploy_port="${SKYJO_DEPLOY_PORT:-22}"
deploy_user="${SKYJO_DEPLOY_USER:-skyjo-deploy}"
identity_file="${SKYJO_DEPLOY_IDENTITY_FILE:-}"
known_hosts_file="${SKYJO_DEPLOY_KNOWN_HOSTS_FILE:-}"
authorization_key_file="${SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE:-}"
ssh_bin="${SKYJO_SSH_BIN:-ssh}"
node_bin="${SKYJO_NODE_BIN:-node}"
signer="${SKYJO_DEPLOY_AUTH_SIGNER:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/sign-deployment-authorization.mjs}"

[[ "$run_id" =~ ^[0-9]+-[0-9]+-(canary|production)$ ]] || die 'invalid run ID'
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || die 'invalid release SHA'
[[ "$deploy_host" =~ ^[A-Za-z0-9.-]+$ ]] || die 'invalid deploy host'
[[ "$deploy_port" =~ ^[0-9]{1,5}$ ]] || die 'invalid deploy port'
(( 10#$deploy_port >= 1 && 10#$deploy_port <= 65535 )) || die 'deploy port is out of range'
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die 'invalid deploy user'
[[ -f "$identity_file" && ! -L "$identity_file" ]] || die 'missing deploy identity file'
[[ -f "$known_hosts_file" && ! -L "$known_hosts_file" ]] || die 'missing pinned known-hosts file'
[[ -f "$authorization_key_file" && ! -L "$authorization_key_file" ]] || die 'missing deployment authorization private key'
[[ -f "$signer" && ! -L "$signer" ]] || die 'missing deployment authorization signer'

if [[ "$mode" != "verify" ]]; then
  [[ "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'invalid immutable release tag'
fi
authorization_role=production
authorization_tag="$release_tag"
if [[ "$mode" == "verify" ]]; then
  authorization_role=canary
  authorization_tag=-
fi
authorization_key_id="${authorization_role}-primary"

expected_archive_name="skyjo-runtime-$release_sha.tar.gz"
expected_checksum_name="$expected_archive_name.sha256"
[[ "$(basename -- "$checksum_path")" == "$expected_checksum_name" ]] || die 'checksum path does not match release SHA'
[[ -f "$checksum_path" && ! -L "$checksum_path" ]] || die 'missing release checksum'

checksum_line="$(tr -d '\r\n' < "$checksum_path")"
[[ "$checksum_line" =~ ^([a-f0-9]{64})[[:space:]][[:space:]]($expected_archive_name)$ ]] || die 'invalid release checksum sidecar'
expected_digest="${BASH_REMATCH[1]}"

ssh_options=(
  -i "$identity_file"
  -p "$deploy_port"
  -o BatchMode=yes
  -o ClearAllForwardings=yes
  -o IdentitiesOnly=yes
  -o KbdInteractiveAuthentication=no
  -o PasswordAuthentication=no
  -o RequestTTY=no
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts_file"
)
target="$deploy_user@$deploy_host"

if [[ "$mode" == "rollback" ]]; then
  archive_path="${checksum_path%.sha256}"
fi

if [[ "$mode" == "verify" || "$mode" == "promote" || "$mode" == "rollback" ]]; then
  [[ "$(basename -- "$archive_path")" == "$expected_archive_name" ]] || die 'archive path does not match release SHA'
  [[ -f "$archive_path" && ! -L "$archive_path" ]] || die 'missing release archive'
  actual_digest="$(sha256sum "$archive_path" | awk '{print $1}')"
  [[ "$actual_digest" == "$expected_digest" ]] || die 'release archive checksum mismatch'
  archive_size="$(wc -c < "$archive_path" | tr -d '[:space:]')"
  [[ "$archive_size" =~ ^[1-9][0-9]*$ ]] || die 'release archive is empty'

fi

sign_command() {
  command_to_sign="$1"
  "$node_bin" "$signer" \
  --role "$authorization_role" \
  --command "$command_to_sign" \
  --run-id "$run_id" \
  --release-sha "$release_sha" \
  --artifact-sha256 "$expected_digest" \
  --artifact-bytes "$archive_size" \
  --tag "$authorization_tag" \
  --key-id "$authorization_key_id" \
  --private-key "$authorization_key_file" \
  --lifetime-seconds 300
}

if [[ "$mode" == "verify" || "$mode" == "promote" ]]; then
  upload_command="$(sign_command upload)"
  [[ "$upload_command" != *$'\n'* && "$upload_command" != *$'\r'* ]] || die 'signer returned an invalid upload command'
  [[ "$upload_command" == "upload $run_id $release_sha $expected_digest $archive_size $authorization_tag "* ]] || die 'signer returned a mismatched upload command'
  if ! "$ssh_bin" "${ssh_options[@]}" "$target" "$upload_command" < "$archive_path"; then
    printf '%s\n' 'Upload transport failed; retrying the exact signed, idempotent request once.' >&2
    sleep 1
    "$ssh_bin" "${ssh_options[@]}" "$target" "$upload_command" < "$archive_path"
  fi
fi

signed_command="$(sign_command "$mode")"
[[ "$signed_command" != *$'\n'* && "$signed_command" != *$'\r'* ]] || die 'signer returned an invalid command'
[[ "$signed_command" == "$mode $run_id $release_sha $expected_digest $archive_size $authorization_tag "* ]] || die 'signer returned a mismatched command'

controller_result="$("$ssh_bin" "${ssh_options[@]}" "$target" "$signed_command")"
if [[ "$mode" == rollback ]]; then
  [[ -n "$controller_result" && "$controller_result" != *$'\n'* && "$controller_result" != *$'\r'* ]] || die 'rollback controller returned an invalid result envelope'
  printf '%s\n' "$controller_result"
else
  [[ -n "$controller_result" ]] && printf '%s\n' "$controller_result"
  printf '%s completed for release %s.\n' "$mode" "$release_sha"
fi
