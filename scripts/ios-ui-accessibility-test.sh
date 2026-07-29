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
ui_udids=()
ui_contrast_states=()
ui_reduce_motion_states=()
ui_differentiate_states=()
ui_matrix_marker_states=()
accessibility_helper="$derived_data/SimulatorAccessibility/skyjo-simulator-accessibility"
finalizing=0

restore_simulator_accessibility() {
  local index=""
  local udid=""
  local expected_contrast=""
  local expected_reduce_motion=""
  local expected_differentiate=""
  local expected_marker=""
  local actual_contrast=""
  local actual_accessibility=""
  local actual_marker=""
  local command_status=0
  local query_status=0
  local restore_failed=0
  for index in "${!ui_udids[@]}"; do
    udid="${ui_udids[$index]}"
    expected_contrast="${ui_contrast_states[$index]}"
    expected_reduce_motion="${ui_reduce_motion_states[$index]}"
    expected_differentiate="${ui_differentiate_states[$index]}"
    expected_marker="${ui_matrix_marker_states[$index]-}"

    xcrun simctl ui "$udid" increase_contrast "$expected_contrast" >/dev/null 2>&1
    command_status=$?
    actual_contrast="$(xcrun simctl ui "$udid" increase_contrast 2>/dev/null)"
    query_status=$?
    if [[ "$command_status" -ne 0 || "$query_status" -ne 0 || \
          "$actual_contrast" != "$expected_contrast" ]]; then
      printf 'ERROR: Failed to restore Increase Contrast on selected simulator %s.\n' \
        "$((index + 1))" >&2
      restore_failed=1
    fi

    if [[ ! -x "$accessibility_helper" ]]; then
      printf 'ERROR: Accessibility restoration helper is unavailable.\n' >&2
      restore_failed=1
    else
      actual_accessibility="$(
        xcrun simctl spawn "$udid" "$accessibility_helper" \
          "$expected_reduce_motion" "$expected_differentiate" 2>/dev/null
      )"
      command_status=$?
      if [[ "$command_status" -ne 0 || \
            "$actual_accessibility" != "$expected_reduce_motion"$'\t'"$expected_differentiate" ]]; then
        printf 'ERROR: Failed to restore motion or color differentiation on selected simulator %s.\n' \
          "$((index + 1))" >&2
        restore_failed=1
      fi
      actual_accessibility="$(xcrun simctl spawn "$udid" "$accessibility_helper" 2>/dev/null)"
      command_status=$?
      if [[ "$command_status" -ne 0 || \
            "$actual_accessibility" != "$expected_reduce_motion"$'\t'"$expected_differentiate" ]]; then
        printf 'ERROR: Restored motion or color differentiation did not verify on selected simulator %s.\n' \
          "$((index + 1))" >&2
        restore_failed=1
      fi
    fi

    if [[ -n "$expected_marker" ]]; then
      xcrun simctl spawn "$udid" launchctl setenv \
        SKYJO_IOS_UI_ACCESSIBILITY_MATRIX "$expected_marker" >/dev/null 2>&1
    else
      xcrun simctl spawn "$udid" launchctl unsetenv \
        SKYJO_IOS_UI_ACCESSIBILITY_MATRIX >/dev/null 2>&1
    fi
    command_status=$?
    actual_marker="$(
      xcrun simctl spawn "$udid" launchctl getenv SKYJO_IOS_UI_ACCESSIBILITY_MATRIX \
        2>/dev/null
    )"
    query_status=$?
    if [[ "$command_status" -ne 0 || "$query_status" -ne 0 || \
          "$actual_marker" != "$expected_marker" ]]; then
      printf 'ERROR: Failed to restore the accessibility gate marker on selected simulator %s.\n' \
        "$((index + 1))" >&2
      restore_failed=1
    fi
  done
  return "$restore_failed"
}

handle_signal() {
  local status="$1"
  trap - HUP INT TERM
  exit "$status"
}

finalize() {
  local status="$1"
  local cleanup_status=0
  if [[ "$finalizing" -ne 0 ]]; then
    return
  fi
  finalizing=1
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  restore_simulator_accessibility
  cleanup_status=$?
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}

trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'finalize "$?"' EXIT
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

host_arch="$(uname -m)"
[[ "$host_arch" == "arm64" || "$host_arch" == "x86_64" ]] || {
  printf 'ERROR: Unsupported simulator host architecture: %s\n' "$host_arch" >&2
  exit 1
}
mkdir -p "$(dirname "$accessibility_helper")"
xcrun --sdk iphonesimulator clang \
  -Wall \
  -Wextra \
  -Werror \
  -arch "$host_arch" \
  -mios-simulator-version-min=18.0 \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  "$repo_root/scripts/ios-simulator-accessibility.c" \
  -lAccessibility \
  -o "$accessibility_helper"

for udid in "$standard_udid" "$large_udid" "$ipad_udid"; do
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl uninstall "$udid" com.groundworkrevops.skyjo >/dev/null 2>&1 || true
  for key in SKYJO_IOS_TEST_SERVER_URL SKYJO_IOS_PWA_CONTROL_URL SKYJO_IOS_TEST_MODE SKYJO_IOS_TEST_ACCESS_PASSWORD; do
    xcrun simctl spawn "$udid" launchctl unsetenv "$key" >/dev/null 2>&1 || true
  done
  contrast_state="$(xcrun simctl ui "$udid" increase_contrast)"
  [[ "$contrast_state" == "enabled" || "$contrast_state" == "disabled" ]] || {
    printf 'ERROR: Increase Contrast is unavailable on simulator %s.\n' "$udid" >&2
    exit 1
  }
  accessibility_state="$(xcrun simctl spawn "$udid" "$accessibility_helper")"
  IFS=$'\t' read -r reduce_motion_state differentiate_state <<< "$accessibility_state"
  [[ "$reduce_motion_state" =~ ^[01]$ && "$differentiate_state" =~ ^[01]$ ]] || {
    printf 'ERROR: Invalid simulator accessibility state for %s.\n' "$udid" >&2
    exit 1
  }
  matrix_marker_state="$(
    xcrun simctl spawn "$udid" launchctl getenv SKYJO_IOS_UI_ACCESSIBILITY_MATRIX \
      2>/dev/null
  )"
  ui_udids+=("$udid")
  ui_contrast_states+=("$contrast_state")
  ui_reduce_motion_states+=("$reduce_motion_state")
  ui_differentiate_states+=("$differentiate_state")
  ui_matrix_marker_states+=("$matrix_marker_state")
  if [[ "$udid" == "$standard_udid" || "$udid" == "$ipad_udid" ]]; then
    # A long-lived iOS/iPadOS simulator can accept XCTest's device rotation
    # while retaining a stale portrait interface. Preserve its state above,
    # then cold boot each landscape destination before measuring geometry.
    xcrun simctl shutdown "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b
  fi
  xcrun simctl ui "$udid" increase_contrast enabled
  [[ "$(xcrun simctl ui "$udid" increase_contrast)" == "enabled" ]] || {
    printf 'ERROR: Failed to verify Increase Contrast on simulator %s.\n' "$udid" >&2
    exit 1
  }
  [[ "$(xcrun simctl spawn "$udid" "$accessibility_helper" 1 1)" == $'1\t1' && \
     "$(xcrun simctl spawn "$udid" "$accessibility_helper")" == $'1\t1' ]] || {
    printf 'ERROR: Failed to enable simulator accessibility adaptations for %s.\n' "$udid" >&2
    exit 1
  }
  xcrun simctl spawn "$udid" launchctl setenv SKYJO_IOS_UI_ACCESSIBILITY_MATRIX 1
  [[ "$(
    xcrun simctl spawn "$udid" launchctl getenv SKYJO_IOS_UI_ACCESSIBILITY_MATRIX
  )" == "1" ]] || {
    printf 'ERROR: Failed to verify the accessibility gate marker for %s.\n' "$udid" >&2
    exit 1
  }
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
  testSoloSetupRendersEverySupportedChoice
  testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloRepresentativeTurnKeepsEveryActionSlotStable
  testSoloLandscapeTableFitsWithoutWholeScreenScrolling
  testSoloNarrowLandscapeKeepsActionsAndLocalBoardAnchored
  testSoloAccessibilityXXXLNarrowLandscapeRemainsAnchored
  testSoloShortPortraitUsesVerticalLayoutAndFitsItsDebugViewport
  testSoloScoreSummaryCanMinimizeAndRestore
  testSoloGameSummaryHasDistinctReplayAndSetupRoutes
  testSoloRecoveryIsExplicitAndSafe
  testSoloXXXLContentSizeIsUnclamped
  testSoloAccessibilityAdaptationsAreActive
  testSoloAccessibilityXXXLRemainsOperable
  testSoloRightToLeftLayoutKeepsControlsContained
)
large_tests=(
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloSingleOpponentFitsLargePhoneAndRendersHighValueCard
  testSoloAccessibilityXXXLRemainsOperable
)
ipad_portrait_tests=(
  testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting
  testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloRepresentativeTurnKeepsEveryActionSlotStable
  testSoloAccessibilityXXXLRemainsOperable
)
ipad_landscape_tests=(
  testSoloLandscapeTableFitsWithoutWholeScreenScrolling
)
[[ "${#standard_tests[@]}" -eq 18 && \
   "${#large_tests[@]}" -eq 3 && \
   "${#ipad_portrait_tests[@]}" -eq 5 && \
   "${#ipad_landscape_tests[@]}" -eq 1 ]] || {
  printf 'ERROR: The expected accessibility matrix inventory changed.\n' >&2
  exit 1
}

matrix_status=0
run_matrix_entry() {
  local role="$1"
  local udid="$2"
  local expected_count="$3"
  shift 3
  local result_bundle="$evidence_dir/$role.xcresult"
  local test_log="$evidence_dir/$role.log"
  local summary_log="$evidence_dir/$role-summary.log"
  local summary_status=1
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
    summary_status=${PIPESTATUS[0]}
    set -e
  else
    printf 'ERROR: Missing xcresult bundle for %s.\n' "$role" >&2
  fi
  if [[ "$status" -ne 0 && "$matrix_status" -eq 0 ]]; then
    matrix_status="$status"
  fi
  if [[ "$summary_status" -ne 0 ]]; then
    printf 'ERROR: Failed to extract the xcresult summary for %s.\n' "$role" >&2
    if [[ "$matrix_status" -eq 0 ]]; then matrix_status=1; fi
  elif ! node -e '
    const fs = require("node:fs");
    const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expected = Number(process.argv[2]);
    const exactCounts = (value) =>
      value &&
      Number.isInteger(value.passedTests) && value.passedTests === expected &&
      Number.isInteger(value.failedTests) && value.failedTests === 0 &&
      Number.isInteger(value.skippedTests) && value.skippedTests === 0;
    const configurations = summary.devicesAndConfigurations;
    if (
      summary.result !== "Passed" ||
      !Number.isInteger(summary.totalTestCount) || summary.totalTestCount !== expected ||
      !Number.isInteger(summary.expectedFailures) || summary.expectedFailures !== 0 ||
      !exactCounts(summary) ||
      !Array.isArray(configurations) || configurations.length !== 1 ||
      !exactCounts(configurations[0]) ||
      !Number.isInteger(configurations[0].expectedFailures) ||
      configurations[0].expectedFailures !== 0
    ) {
      throw new Error("xcresult counts do not match the pinned matrix entry");
    }
  ' "$summary_log" "$expected_count"; then
    printf 'ERROR: The xcresult summary did not prove the exact %s-test %s entry.\n' \
      "$expected_count" "$role" >&2
    if [[ "$matrix_status" -eq 0 ]]; then matrix_status=1; fi
  fi
}

run_matrix_entry standard-phone "$standard_udid" 18 "${standard_tests[@]}"
run_matrix_entry large-phone "$large_udid" 3 "${large_tests[@]}"
run_matrix_entry ipad-portrait "$ipad_udid" 5 "${ipad_portrait_tests[@]}"
run_matrix_entry ipad-landscape "$ipad_udid" 1 "${ipad_landscape_tests[@]}"

exit "$matrix_status"
