#!/usr/bin/env bash

# Runs the deterministic native-solo UI evidence matrix without a backend or credentials.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
repo_root_system_alias="$repo_root"
if [[ "$repo_root" == /private/* ]]; then
  repo_root_system_alias="/${repo_root#/private/}"
fi
project_path="$repo_root/ios/SkyjoNative.xcodeproj"
artifacts_root="${SKYJO_IOS_ARTIFACTS_DIR:-$repo_root/ios/Artifacts}"
run_key="${GITHUB_RUN_ID:-local-$$}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"

if [[ "$#" -ne 0 ]]; then
  printf 'ERROR: Usage: ./scripts/ios-ui-accessibility-test.sh\n' >&2
  exit 1
fi
if [[ ! "$run_key" =~ ^(local-[0-9]+|[0-9]+)$ || ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: Invalid iOS artifact run identity.\n' >&2
  exit 1
fi

evidence_dir="$artifacts_root/UIAccessibility-$run_key-$run_attempt"
derived_data="$artifacts_root/UIAccessibilityDerivedData-$run_key-$run_attempt"
matrix_file="$evidence_dir/simulator-matrix.tsv"
toolchain_log="$evidence_dir/toolchain.log"
build_log="$evidence_dir/build-for-testing.log"
mkdir -p "$evidence_dir"
if [[ -e "$derived_data" ]]; then
  printf 'ERROR: Refusing to reuse existing derived data: %s\n' "$derived_data" >&2
  exit 1
fi

sanitize_output() {
  local user_home="${HOME:-/path/not-present/home}"
  local runner_temp="${RUNNER_TEMP:-/path/not-present/runner-temp}"
  /usr/bin/sed \
    -e 's/\\ / /g' \
    -e "s|$repo_root|<workspace>|g" \
    -e "s|$repo_root_system_alias|<workspace>|g" \
    -e "s|$user_home|<home>|g" \
    -e "s|$runner_temp|<runner-temp>|g"
}

cd "$repo_root"
: > "$toolchain_log"
[[ -n "${DEVELOPER_DIR:-}" ]] || {
  printf 'ERROR: DEVELOPER_DIR must select the pinned Xcode installation.\n' >&2
  exit 1
}
[[ -x "$DEVELOPER_DIR/usr/bin/xcodebuild" ]] || {
  printf 'ERROR: Pinned xcodebuild is unavailable at DEVELOPER_DIR.\n' >&2
  exit 1
}

{
  sw_vers
  xcodebuild -version
  swift --version
  xcodebuild -showsdks
} 2>&1 | sanitize_output | tee "$toolchain_log"

xcrun simctl list --json devices available \
  | node scripts/select-ios-ui-simulators.mjs \
  | tee "$matrix_file"

standard_udid=""
large_udid=""
ipad_udid=""
while IFS=$'\t' read -r role runtime name udid; do
  [[ -n "$role" && -n "$runtime" && -n "$name" && "$udid" =~ ^[A-Fa-f0-9-]{36}$ ]] || {
    printf 'ERROR: Invalid simulator matrix record.\n' >&2
    exit 1
  }
  printf 'Selected %s: %s (%s) on %s\n' "$role" "$name" "$udid" "$runtime" \
    | tee -a "$toolchain_log"
  case "$role" in
    standard-phone) standard_udid="$udid" ;;
    large-phone) large_udid="$udid" ;;
    ipad) ipad_udid="$udid" ;;
    *)
      printf 'ERROR: Unexpected simulator matrix role: %s\n' "$role" >&2
      exit 1
      ;;
  esac
done < "$matrix_file"
[[ -n "$standard_udid" && -n "$large_udid" && -n "$ipad_udid" ]] || {
  printf 'ERROR: Simulator matrix is incomplete.\n' >&2
  exit 1
}

for udid in "$standard_udid" "$large_udid" "$ipad_udid"; do
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl uninstall "$udid" com.groundworkrevops.skyjo >/dev/null 2>&1 || true
  for key in SKYJO_IOS_TEST_SERVER_URL SKYJO_IOS_PWA_CONTROL_URL SKYJO_IOS_TEST_MODE SKYJO_IOS_TEST_ACCESS_PASSWORD; do
    xcrun simctl spawn "$udid" launchctl unsetenv "$key" >/dev/null 2>&1 || true
  done
done

xcode_environment=(
  /usr/bin/env -i
  "PATH=/usr/bin:/bin:/usr/sbin:/sbin:$DEVELOPER_DIR/usr/bin"
  "DEVELOPER_DIR=$DEVELOPER_DIR"
  "HOME=${HOME:-/tmp}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=en_US.UTF-8"
  "LC_ALL=en_US.UTF-8"
)

set +e
"${xcode_environment[@]}" xcodebuild \
  build-for-testing \
  -quiet \
  -project "$project_path" \
  -scheme SkyjoNative \
  -testPlan SkyjoCI \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$standard_udid" \
  -destination-timeout 120 \
  -derivedDataPath "$derived_data" \
  -parallel-testing-enabled NO \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | sanitize_output | tee "$build_log"
build_status=${PIPESTATUS[0]}
set -e
if [[ "$build_status" -ne 0 ]]; then
  exit "$build_status"
fi

solo_suite="SkyjoAppUITests/SkyjoAppUITests"
standard_tests=(
  testSoloLauncherMakesReplacementExplicitAndRecoverable
  testSoloOfflineAccountCopyAndRevalidationAreExplicit
  testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloLandscapeTableFitsWithoutWholeScreenScrolling
  testSoloScoreSummaryCanMinimizeAndRestore
  testSoloRecoveryAndAccessibilityXXXLRemainOperable
)
large_tests=(
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloRecoveryAndAccessibilityXXXLRemainOperable
)
ipad_portrait_tests=(
  testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloRecoveryAndAccessibilityXXXLRemainOperable
)
ipad_landscape_tests=(
  testSoloLandscapeTableFitsWithoutWholeScreenScrolling
)

matrix_status=0
run_matrix_entry() {
  local role="$1"
  local udid="$2"
  shift 2
  local result_bundle="$evidence_dir/$role.xcresult"
  local test_log="$evidence_dir/$role.log"
  local summary_log="$evidence_dir/$role-summary.log"
  local -a arguments=(
    test-without-building
    -quiet
    -project "$project_path"
    -scheme SkyjoNative
    -testPlan SkyjoCI
    -configuration Debug
    -destination "platform=iOS Simulator,id=$udid"
    -destination-timeout 120
    -derivedDataPath "$derived_data"
    -resultBundlePath "$result_bundle"
    -parallel-testing-enabled NO
  )
  local test_name=""
  for test_name in "$@"; do
    arguments+=("-only-testing:$solo_suite/$test_name")
  done
  arguments+=(CODE_SIGNING_ALLOWED=NO)

  set +e
  "${xcode_environment[@]}" xcodebuild "${arguments[@]}" \
    2>&1 | sanitize_output | tee "$test_log"
  local status=${PIPESTATUS[0]}
  set -e
  if [[ -e "$result_bundle" ]]; then
    set +e
    xcrun xcresulttool get test-results summary --path "$result_bundle" \
      2>&1 | sanitize_output | tee "$summary_log"
    set -e
  fi
  if [[ "$status" -ne 0 ]]; then
    matrix_status="$status"
  fi
}

run_matrix_entry standard-phone "$standard_udid" "${standard_tests[@]}"
run_matrix_entry large-phone "$large_udid" "${large_tests[@]}"
run_matrix_entry ipad-portrait "$ipad_udid" "${ipad_portrait_tests[@]}"
run_matrix_entry ipad-landscape "$ipad_udid" "${ipad_landscape_tests[@]}"

exit "$matrix_status"
