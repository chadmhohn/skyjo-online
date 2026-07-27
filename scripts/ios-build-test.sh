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
result_bundle="$artifacts_dir/SkyjoCI-$run_key-$run_attempt.xcresult"
derived_data="$artifacts_dir/DerivedData-$run_key-$run_attempt"
toolchain_log="$artifacts_dir/ios-toolchain-$run_key-$run_attempt.log"
simulator_log="$artifacts_dir/ios-simulators-$run_key-$run_attempt.log"
xcodebuild_log="$artifacts_dir/ios-xcodebuild-$run_key-$run_attempt.log"
result_summary_log="$artifacts_dir/ios-xcresult-summary-$run_key-$run_attempt.log"

mkdir -p "$artifacts_dir"
: > "$toolchain_log"

sanitize_output() {
  local runner_temp_path="${RUNNER_TEMP:-/path/not-present/runner-temp}"
  local user_home_path="${HOME:-/path/not-present/home}"

  # Xcode shell-escapes spaces in some emitted paths. Normalize those escapes
  # before replacing machine-local roots so no partial home path survives.
  /usr/bin/sed \
    -e 's/\\ / /g' \
    -e "s|$repo_root_physical|<workspace>|g" \
    -e "s|$repo_root_system_alias|<workspace>|g" \
    -e "s|$repo_root|<workspace>|g" \
    -e "s|$runner_temp_path|<runner-temp>|g" \
    -e "s|$user_home_path|<home>|g"
}

report_failure() {
  printf 'ERROR: %s\n' "$1" | sanitize_output | tee -a "$toolchain_log" >&2
  exit 1
}

if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || true)"
  export DEVELOPER_DIR
fi

[[ -n "$DEVELOPER_DIR" ]] || report_failure "No Xcode developer directory is selected."
[[ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]] || \
  report_failure "The selected developer directory does not contain the full Xcode toolchain: $DEVELOPER_DIR"
[[ -f "$project_path/project.pbxproj" ]] || report_failure "Missing Xcode project: $project_path"

xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2; exit }')"
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

set +e
"${xcode_environment[@]}" xcodebuild test \
  -project "$project_path" \
  -scheme SkyjoNative \
  -testPlan SkyjoCI \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -destination-timeout 120 \
  -derivedDataPath "$derived_data" \
  -resultBundlePath "$result_bundle" \
  -parallel-testing-enabled NO \
  CODE_SIGNING_ALLOWED=NO \
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
