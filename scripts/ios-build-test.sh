#!/usr/bin/env bash

# Build and test the native app on the newest available iPhone Simulator without
# inheriting credentials into xcodebuild or its result bundle.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
repo_root_physical="$(cd "$script_dir/.." && pwd -P)"
repo_root_system_alias="$repo_root_physical"
if [[ "$repo_root_physical" == /private/* ]]; then
  repo_root_system_alias="/${repo_root_physical#/private/}"
fi
project_path="$repo_root/ios/SkyjoNative.xcodeproj"
artifacts_dir="${SKYJO_IOS_ARTIFACTS_DIR:-$repo_root/ios/Artifacts}"
run_key="${GITHUB_RUN_ID:-local-$$}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
if [[ ! "$run_key" =~ ^(local-[0-9]+|[0-9]+)$ || ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: Invalid iOS artifact run identity.\n' >&2
  exit 1
fi
result_bundle="$artifacts_dir/SkyjoCI-$run_key-$run_attempt.xcresult"
derived_data="$artifacts_dir/DerivedData-$run_key-$run_attempt"
toolchain_log="$artifacts_dir/ios-toolchain-$run_key-$run_attempt.log"
simulator_log="$artifacts_dir/ios-simulators-$run_key-$run_attempt.log"
xcodebuild_log="$artifacts_dir/ios-xcodebuild-$run_key-$run_attempt.log"
result_summary_log="$artifacts_dir/ios-xcresult-summary-$run_key-$run_attempt.log"
node_server_log="$artifacts_dir/ios-node-server-$run_key-$run_attempt.log"
artifact_safety_log="$artifacts_dir/ios-artifact-safety-$run_key-$run_attempt.log"
validated_artifacts_dir="$artifacts_dir/Validated-$run_key-$run_attempt"
node_test_parent=""
node_test_dir=""
node_server_raw_log=""
node_server_pid=""
simulator_test_environment_set=false
ios_test_access_fixture="skyjo-ios-contract-access-v1"
ios_test_session_secret=""
ios_test_invite_secret=""
test_mode="full"

cd "$repo_root"
mkdir -p "$artifacts_dir"
: > "$toolchain_log"

sanitize_output() {
  local runner_temp_path="${RUNNER_TEMP:-/path/not-present/runner-temp}"
  local user_home_path="${HOME:-/path/not-present/home}"
  local test_session_secret="${ios_test_session_secret:-/value/not-present/test-session}"
  local test_invite_secret="${ios_test_invite_secret:-/value/not-present/test-invite}"

  # Xcode shell-escapes spaces in some emitted paths. Normalize those escapes
  # before replacing machine-local roots so no partial home path survives.
  /usr/bin/sed \
    -e 's/\\ / /g' \
    -e "s|$repo_root_physical|<workspace>|g" \
    -e "s|$repo_root_system_alias|<workspace>|g" \
    -e "s|$repo_root|<workspace>|g" \
    -e "s|$runner_temp_path|<runner-temp>|g" \
    -e "s|$user_home_path|<home>|g" \
    -e "s|$test_session_secret|<test-secret>|g" \
    -e "s|$test_invite_secret|<test-secret>|g"
}

report_failure() {
  printf 'ERROR: %s\n' "$1" | sanitize_output | tee -a "$toolchain_log" >&2
  exit 1
}

if [[ "$#" -gt 1 ]]; then
  report_failure "Usage: ./scripts/ios-build-test.sh [--networking-contracts]"
fi
case "${1:-}" in
  "") ;;
  --networking-contracts)
    test_mode="networking-contracts"
    ;;
  *)
    report_failure "Usage: ./scripts/ios-build-test.sh [--networking-contracts]"
    ;;
esac

sanitize_node_server_log() {
  if [[ -n "$node_server_raw_log" && -f "$node_server_raw_log" ]]; then
    sanitize_output < "$node_server_raw_log" > "$node_server_log"
  fi
}

cleanup_node_server() {
  if [[ "$simulator_test_environment_set" == true && -n "${simulator_udid:-}" ]]; then
    xcrun simctl spawn "$simulator_udid" launchctl unsetenv SKYJO_IOS_TEST_SERVER_URL \
      >/dev/null 2>&1 || true
  fi

  if [[ -n "$node_server_pid" ]] && kill -0 "$node_server_pid" 2>/dev/null; then
    kill -TERM "$node_server_pid" 2>/dev/null || true
    for _ in {1..40}; do
      if ! kill -0 "$node_server_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$node_server_pid" 2>/dev/null; then
      kill -KILL "$node_server_pid" 2>/dev/null || true
    fi
    wait "$node_server_pid" 2>/dev/null || true
  fi

  sanitize_node_server_log

  if [[
    -n "$node_test_parent" &&
    -n "$node_test_dir" &&
    -d "$node_test_dir" &&
    "$node_test_dir" == "$node_test_parent"/skyjo-ios-node.*
  ]]; then
    rm -rf -- "$node_test_dir"
  fi
}

validate_retained_artifacts() {
  local target=""
  local private_value=""
  local scan_status=0
  local unsafe=false
  local -a retained_targets=(
    "$result_bundle"
    "$toolchain_log"
    "$simulator_log"
    "$xcodebuild_log"
    "$result_summary_log"
    "$node_server_log"
  )
  local -a private_values=(
    "$ios_test_session_secret"
    "$ios_test_invite_secret"
    "SKYJO_IOS_TEST_ACCESS_PASSWORD"
    "ios-access-"
  )

  for target in "${retained_targets[@]}"; do
    [[ -e "$target" ]] || continue
    for private_value in "${private_values[@]}"; do
      [[ -n "$private_value" ]] || continue
      if /usr/bin/grep -ar -F -q -- "$private_value" "$target" 2>/dev/null; then
        scan_status=0
      else
        scan_status=$?
      fi
      if [[ "$scan_status" -eq 0 || "$scan_status" -gt 1 ]]; then
        unsafe=true
        break 2
      fi
    done
  done

  if [[ "$unsafe" == false ]]; then
    if ! printf 'Verified retained iOS evidence contains no generated server secrets.\n' \
      | tee "$artifact_safety_log"; then
      return 1
    fi
    return 0
  fi

  # A raw result bundle is not safely editable. Delete only this run's exact,
  # validated generated targets and leave a non-sensitive failure marker for CI.
  if [[
    -d "$result_bundle" &&
    "$result_bundle" == "$artifacts_dir/SkyjoCI-$run_key-$run_attempt.xcresult"
  ]]; then
    rm -rf -- "$result_bundle"
  fi
  for target in \
    "$toolchain_log" \
    "$simulator_log" \
    "$xcodebuild_log" \
    "$result_summary_log" \
    "$node_server_log"; do
    if [[ -f "$target" ]]; then
      rm -f -- "$target"
    fi
  done
  printf '%s\n' \
    'ERROR: Retained iOS evidence contained a generated server secret and was discarded.' \
    > "$artifact_safety_log"
  return 1
}

stage_validated_artifacts() {
  local target=""
  local -a validated_targets=(
    "$result_bundle"
    "$toolchain_log"
    "$simulator_log"
    "$xcodebuild_log"
    "$result_summary_log"
    "$node_server_log"
    "$artifact_safety_log"
  )

  [[ ! -e "$validated_artifacts_dir" ]] || return 1
  /bin/mkdir "$validated_artifacts_dir" || return 1
  for target in "${validated_targets[@]}"; do
    [[ -e "$target" ]] || continue
    /bin/mv -- "$target" "$validated_artifacts_dir/" || return 1
  done
}

stage_artifact_safety_failure() {
  [[ ! -e "$validated_artifacts_dir" ]] || return 1
  /bin/mkdir "$validated_artifacts_dir" || return 1
  printf '%s\n' \
    'ERROR: iOS evidence validation failed; no raw result bundle or log is eligible for upload.' \
    > "$validated_artifacts_dir/ios-artifact-safety-$run_key-$run_attempt.log" || return 1
}

finalize_on_exit() {
  local original_status=$?
  local cleanup_status=0
  local validation_status=0
  local staging_status=0

  trap - EXIT
  set +e
  cleanup_node_server
  cleanup_status=$?
  validate_retained_artifacts
  validation_status=$?
  if [[ "$validation_status" -eq 0 ]]; then
    stage_validated_artifacts
  else
    stage_artifact_safety_failure
  fi
  staging_status=$?

  if [[ "$validation_status" -ne 0 || "$staging_status" -ne 0 ]]; then
    exit 1
  fi
  if [[ "$cleanup_status" -ne 0 && "$original_status" -eq 0 ]]; then
    exit "$cleanup_status"
  fi
  exit "$original_status"
}

trap finalize_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || true)"
  export DEVELOPER_DIR
fi

[[ -n "$DEVELOPER_DIR" ]] || report_failure "No Xcode developer directory is selected."
[[ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]] || \
  report_failure "The selected developer directory does not contain the full Xcode toolchain: $DEVELOPER_DIR"
[[ -f "$project_path/project.pbxproj" ]] || report_failure "Missing Xcode project: $project_path"

xcode_version_output="$(xcodebuild -version)"
xcode_version="$(printf '%s\n' "$xcode_version_output" | awk '/^Xcode / { print $2; exit }')"
if [[ ! "$xcode_version" =~ ^26\.6($|\.) ]]; then
  report_failure "Xcode 26.6 is required; selected version is ${xcode_version:-unknown}."
fi

simulator_listing="$(xcrun simctl list devices available)"
printf '%s\n' "$simulator_listing" | sanitize_output > "$simulator_log"

simulator_record="$(printf '%s\n' "$simulator_listing" | awk '
  /^-- iOS [0-9]+([.][0-9]+)* --$/ {
    part_count = split($3, version_parts, ".")
    patch = part_count >= 3 ? version_parts[3] : 0
    version_key = (version_parts[1] * 1000000) + (version_parts[2] * 1000) + patch
    current_runtime = 0
    if (version_key > best_version_key) {
      best_version_key = version_key
      selected_device = ""
      selected_runtime = ""
      current_runtime = 1
    } else if (version_key == best_version_key) {
      current_runtime = 1
    }
    runtime_version = $3
    next
  }
  /^-- / {
    current_runtime = 0
    next
  }
  current_runtime && selected_device == "" && /^[[:space:]]+iPhone/ {
    selected_device = $0
    selected_runtime = runtime_version
  }
  END {
    if (selected_device != "") {
      print selected_runtime "\t" selected_device
    }
  }
')"

[[ -n "$simulator_record" ]] || report_failure "No available iPhone Simulator was found."

IFS=$'\t' read -r simulator_runtime simulator_line <<< "$simulator_record"
simulator_udid="$(printf '%s\n' "$simulator_line" \
  | /usr/bin/sed -nE 's/.*\(([[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12})\).*/\1/p')"

if [[ ! "$simulator_udid" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
  report_failure "Could not resolve a valid simulator identifier from: $simulator_line"
fi

{
  printf 'Runner image OS: %s\n' "${ImageOS:-local}"
  printf 'Runner image version: %s\n' "${ImageVersion:-local}"
  sw_vers
  xcodebuild -version
  xcrun swift --version
  xcodebuild -showsdks
  xcrun simctl list runtimes
  printf 'Selected simulator: iOS %s, %s\n' "$simulator_runtime" "$simulator_line"
} 2>&1 | sanitize_output | tee -a "$toolchain_log"

# Keep tokens, service credentials, and unrelated local configuration out of
# xcodebuild's process environment and the generated result bundle.
xcode_environment=(
  /usr/bin/env -i
  "PATH=$PATH"
  "HOME=${HOME:-/tmp}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "USER=${USER:-runner}"
  "LOGNAME=${LOGNAME:-${USER:-runner}}"
  "LANG=${LANG:-en_US.UTF-8}"
  "DEVELOPER_DIR=$DEVELOPER_DIR"
  "NSUnbufferedIO=YES"
)

set +e
release_settings="$("${xcode_environment[@]}" xcodebuild \
  -project "$project_path" \
  -scheme SkyjoNative \
  -configuration Release \
  -showBuildSettings 2>&1)"
release_settings_status=$?
set -e

if [[ "$release_settings_status" -ne 0 ]]; then
  report_failure "Could not resolve the Release build settings."
fi

release_api_base_url="$(awk -F ' = ' '
  /^[[:space:]]*SKYJO_API_BASE_URL = / {
    print $2
    exit
  }
' <<< "$release_settings")"
if [[ "$release_api_base_url" != "https://skyjo.groundworkrevops.com" ]]; then
  report_failure "Release API base URL does not resolve exactly to the required production HTTPS origin."
fi
printf 'Verified Release API base URL: %s\n' "$release_api_base_url" | tee -a "$toolchain_log"

command -v node >/dev/null 2>&1 || report_failure "Node is required for native networking contract tests."
command -v npm >/dev/null 2>&1 || report_failure "npm is required for native networking contract tests."
command -v curl >/dev/null 2>&1 || report_failure "curl is required for native networking contract tests."
command -v uuidgen >/dev/null 2>&1 || report_failure "uuidgen is required for isolated native networking tests."

if [[ ! -x "$repo_root/node_modules/.bin/tsc" ]]; then
  set +e
  "${xcode_environment[@]}" npm ci \
    2>&1 | sanitize_output | tee -a "$toolchain_log"
  npm_install_status=${PIPESTATUS[0]}
  set -e
  if [[ "$npm_install_status" -ne 0 ]]; then
    report_failure "Locked Node dependency installation failed."
  fi
fi

set +e
"${xcode_environment[@]}" npm run build:server \
  2>&1 | sanitize_output | tee -a "$toolchain_log"
server_build_status=${PIPESTATUS[0]}
set -e
if [[ "$server_build_status" -ne 0 ]]; then
  report_failure "The local Node server build failed."
fi

node_test_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
node_test_dir="$(mktemp -d "$node_test_parent/skyjo-ios-node.XXXXXX")"
if [[ "$node_test_dir" != "$node_test_parent"/skyjo-ios-node.* ]]; then
  report_failure "The isolated Node test directory was not created under the expected temporary root."
fi
node_server_raw_log="$node_test_dir/server.log"

session_nonce="$(uuidgen | tr '[:upper:]' '[:lower:]')"
invite_nonce="$(uuidgen | tr '[:upper:]' '[:lower:]')"
ios_test_session_secret="ios-session-$session_nonce"
ios_test_invite_secret="ios-invite-$invite_nonce"

node_server_environment=(
  /usr/bin/env -i
  "PATH=$PATH"
  "HOME=${HOME:-/tmp}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "USER=${USER:-runner}"
  "LOGNAME=${LOGNAME:-${USER:-runner}}"
  "LANG=${LANG:-en_US.UTF-8}"
  "NODE_ENV=test"
  "HOST=127.0.0.1"
  "PORT=0"
  "SKYJO_ACCESS_PASSWORD=$ios_test_access_fixture"
  "SKYJO_SESSION_SECRET=$ios_test_session_secret"
  "SKYJO_INVITE_SECRET=$ios_test_invite_secret"
  "SKYJO_ADMIN_INITIAL_PASSWORD="
  "SKYJO_DATABASE_RETRY_MS=100"
  "SKYJO_DB_FILE=$node_test_dir/skyjo.sqlite"
  "SKYJO_ROOMS_FILE=$node_test_dir/rooms.json"
  "SKYJO_SECURE_COOKIES=false"
  "SKYJO_VAPID_PRIVATE_KEY="
  "SKYJO_VAPID_PUBLIC_KEY="
)

"${node_server_environment[@]}" node "$repo_root/server.mjs" > "$node_server_raw_log" 2>&1 &
node_server_pid=$!

node_server_port=""
for _ in {1..150}; do
  node_server_port="$(sed -nE 's/^Listening on http:\/\/127\.0\.0\.1:([0-9]+).*$/\1/p' "$node_server_raw_log" | head -n 1)"
  if [[ -n "$node_server_port" ]]; then
    break
  fi
  if ! kill -0 "$node_server_pid" 2>/dev/null; then
    sanitize_node_server_log
    report_failure "The isolated Node server exited before reporting its port. See the sanitized Node log."
  fi
  sleep 0.1
done

if [[
  ! "$node_server_port" =~ ^[0-9]+$ ||
  "$node_server_port" -lt 1 ||
  "$node_server_port" -gt 65535
]]; then
  sanitize_node_server_log
  report_failure "The isolated Node server did not report a valid port. See the sanitized Node log."
fi

ios_test_server_url="http://127.0.0.1:$node_server_port"
server_health=""
for _ in {1..50}; do
  server_health="$(curl --fail --silent --show-error --max-time 2 "$ios_test_server_url/healthz" 2>/dev/null || true)"
  if [[ "$server_health" == "ok" ]]; then
    break
  fi
  if ! kill -0 "$node_server_pid" 2>/dev/null; then
    sanitize_node_server_log
    report_failure "The isolated Node server stopped before becoming healthy. See the sanitized Node log."
  fi
  sleep 0.1
done
if [[ "$server_health" != "ok" ]]; then
  sanitize_node_server_log
  report_failure "The isolated Node server did not become healthy. See the sanitized Node log."
fi

xcrun simctl boot "$simulator_udid" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$simulator_udid" -b >/dev/null
simulator_test_environment_set=true
# Remove the credential-bearing key used by older harness revisions before
# Xcode can capture simulator-wide launchd diagnostics.
xcrun simctl spawn "$simulator_udid" launchctl unsetenv SKYJO_IOS_TEST_ACCESS_PASSWORD \
  >/dev/null 2>&1 || true
set +e
legacy_access_environment="$(
  xcrun simctl spawn "$simulator_udid" launchctl getenv SKYJO_IOS_TEST_ACCESS_PASSWORD \
    2>/dev/null
)"
legacy_access_environment_status=$?
set -e
if [[ "$legacy_access_environment_status" -ne 0 || -n "$legacy_access_environment" ]]; then
  report_failure "Could not prove the legacy simulator access credential is absent."
fi
if ! xcrun simctl spawn "$simulator_udid" launchctl setenv \
  SKYJO_IOS_TEST_SERVER_URL "$ios_test_server_url" >/dev/null 2>&1; then
  report_failure "Could not inject the isolated server URL into the selected simulator."
fi
printf 'Started isolated local Node contract server on a dynamic loopback port.\n' | tee -a "$toolchain_log"
printf 'Native test mode: %s\n' "$test_mode" | tee -a "$toolchain_log"

xcode_test_arguments=(
  test
  -project "$project_path"
  -scheme SkyjoNative
  -testPlan SkyjoCI
  -configuration Debug
  -destination "platform=iOS Simulator,id=$simulator_udid"
  -destination-timeout 120
  -derivedDataPath "$derived_data"
  -resultBundlePath "$result_bundle"
  -parallel-testing-enabled NO
)
if [[ "$test_mode" == "networking-contracts" ]]; then
  xcode_test_arguments+=("-only-testing:SkyjoAppTests")
fi
xcode_test_arguments+=(CODE_SIGNING_ALLOWED=NO)

set +e
"${xcode_environment[@]}" xcodebuild "${xcode_test_arguments[@]}" \
  2>&1 | sanitize_output | tee "$xcodebuild_log"
xcodebuild_status=${PIPESTATUS[0]}
set -e

if [[ -e "$result_bundle" ]]; then
  set +e
  xcrun xcresulttool get test-results summary --path "$result_bundle" \
    2>&1 | sanitize_output | tee "$result_summary_log"
  summary_status=${PIPESTATUS[0]}
  set -e
  if [[ "$summary_status" -ne 0 ]]; then
    printf 'xcresulttool could not produce a test summary (status %d).\n' "$summary_status" \
      | tee -a "$result_summary_log"
  fi
fi

exit "$xcodebuild_status"
