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
result_verifier="$repo_root/scripts/verify-ios-ui-xcresult.mjs"
artifacts_root="${SKYJO_IOS_ARTIFACTS_DIR:-$repo_root/ios/Artifacts}"
run_key="${GITHUB_RUN_ID:-local-$$}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
selected_role="${SKYJO_IOS_UI_ACCESSIBILITY_ROLE:-}"

if [[ "$#" -ne 0 ]]; then
  printf 'ERROR: Usage: ./scripts/ios-ui-accessibility-test.sh\n' >&2
  exit 1
fi
if [[ ! "$run_key" =~ ^(local-[0-9]+|[0-9]+)$ || ! "$run_attempt" =~ ^[1-9][0-9]*$ ]]; then
  printf 'ERROR: Invalid iOS artifact run identity.\n' >&2
  exit 1
fi
case "$selected_role" in
  ""|standard-phone|large-phone|ipad-portrait|ipad-landscape) ;;
  *)
    printf 'ERROR: SKYJO_IOS_UI_ACCESSIBILITY_ROLE must be one of standard-phone, large-phone, ipad-portrait, or ipad-landscape.\n' >&2
    exit 1
    ;;
esac

evidence_dir="$artifacts_root/UIAccessibility-$run_key-$run_attempt"
derived_data="$artifacts_root/UIAccessibilityDerivedData-$run_key-$run_attempt"
matrix_file="$evidence_dir/simulator-matrix.tsv"
toolchain_log="$evidence_dir/toolchain.log"
build_log="$evidence_dir/build-for-testing.log"
mkdir -p "$evidence_dir"
printf 'Selected UI accessibility role: %s\n' "${selected_role:-full-matrix}" \
  > "$evidence_dir/role-selection.log"
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
[[ -f "$result_verifier" ]] || {
  printf 'ERROR: The iOS UI xcresult verifier is unavailable.\n' >&2
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

clear_simulator_test_environment() {
  local udid="$1"
  local key=""
  for key in \
    SKYJO_IOS_TEST_SERVER_URL \
    SKYJO_IOS_PWA_CONTROL_URL \
    SKYJO_IOS_TEST_MODE \
    SKYJO_IOS_TEST_ACCESS_PASSWORD; do
    xcrun simctl spawn "$udid" launchctl unsetenv "$key" >/dev/null 2>&1 || true
  done
}

apply_simulator_accessibility() {
  local udid="$1"
  local actual_contrast=""
  local actual_accessibility=""
  local actual_marker=""

  xcrun simctl ui "$udid" increase_contrast enabled || return 1
  actual_contrast="$(xcrun simctl ui "$udid" increase_contrast)" || return 1
  if [[ "$actual_contrast" != "enabled" ]]; then
    printf 'ERROR: Failed to verify Increase Contrast on simulator %s.\n' "$udid" >&2
    return 1
  fi

  actual_accessibility="$(
    xcrun simctl spawn "$udid" "$accessibility_helper" 1 1
  )" || return 1
  if [[ "$actual_accessibility" != $'1\t1' ]]; then
    printf 'ERROR: Failed to enable simulator accessibility adaptations for %s.\n' \
      "$udid" >&2
    return 1
  fi
  actual_accessibility="$(
    xcrun simctl spawn "$udid" "$accessibility_helper"
  )" || return 1
  if [[ "$actual_accessibility" != $'1\t1' ]]; then
    printf 'ERROR: Failed to verify simulator accessibility adaptations for %s.\n' \
      "$udid" >&2
    return 1
  fi

  xcrun simctl spawn "$udid" launchctl setenv \
    SKYJO_IOS_UI_ACCESSIBILITY_MATRIX 1 || return 1
  actual_marker="$(
    xcrun simctl spawn "$udid" launchctl getenv SKYJO_IOS_UI_ACCESSIBILITY_MATRIX
  )" || return 1
  if [[ "$actual_marker" != "1" ]]; then
    printf 'ERROR: Failed to verify the accessibility gate marker for %s.\n' "$udid" >&2
    return 1
  fi
}

cold_boot_and_prepare_simulator() {
  local udid="$1"

  # shutdown returns nonzero when a simulator is already down. The required
  # boot and bootstatus calls below still fail closed for every other error.
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl boot "$udid" || return 1
  xcrun simctl bootstatus "$udid" -b || return 1
  xcrun simctl uninstall "$udid" com.groundworkrevops.skyjo >/dev/null 2>&1 || true
  clear_simulator_test_environment "$udid"
  apply_simulator_accessibility "$udid"
}

reset_simulator_after_infrastructure_failure() {
  local udid="$1"
  local selected_udid=""
  local selected=0

  for selected_udid in "${ui_udids[@]}"; do
    if [[ "$selected_udid" == "$udid" ]]; then
      selected=1
    fi
  done
  if [[ "$selected" -ne 1 ]]; then
    printf 'ERROR: Refusing to reset an unselected simulator.\n' >&2
    return 1
  fi

  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  if [[ "${GITHUB_ACTIONS:-}" == "true" && \
        "${RUNNER_ENVIRONMENT:-}" == "github-hosted" ]]; then
    # The exact selected simulator is ephemeral on a GitHub-hosted runner.
    # Erasing it releases stale Accessibility audit state before the normal
    # cold-boot path reapplies and verifies every required adaptation.
    xcrun simctl erase "$udid" || return 1
  fi
}

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

    # An isolated child can be interrupted between shutdown and boot. Bring
    # the captured simulator back before restoring its original settings.
    xcrun simctl boot "$udid" >/dev/null 2>&1 || true
    xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1
    command_status=$?
    if [[ "$command_status" -ne 0 ]]; then
      printf 'ERROR: Failed to boot selected simulator %s for restoration.\n' \
        "$((index + 1))" >&2
      restore_failed=1
      continue
    fi

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

active_udids=()
build_udid=""
case "$selected_role" in
  "")
    active_udids=("$standard_udid" "$large_udid" "$ipad_udid")
    build_udid="$standard_udid"
    ;;
  standard-phone)
    active_udids=("$standard_udid")
    build_udid="$standard_udid"
    ;;
  large-phone)
    active_udids=("$large_udid")
    build_udid="$large_udid"
    ;;
  ipad-portrait|ipad-landscape)
    active_udids=("$ipad_udid")
    build_udid="$ipad_udid"
    ;;
esac

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

for udid in "${active_udids[@]}"; do
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl uninstall "$udid" com.groundworkrevops.skyjo >/dev/null 2>&1 || true
  clear_simulator_test_environment "$udid"
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
  if [[ -z "$selected_role" && \
        ( "$udid" == "$standard_udid" || "$udid" == "$ipad_udid" ) ]] || \
     [[ "$selected_role" == "standard-phone" || "$selected_role" == "ipad-landscape" ]]; then
    # A long-lived iOS/iPadOS simulator can accept XCTest's device rotation
    # while retaining a stale portrait interface. Preserve its state above,
    # then cold boot each landscape destination before measuring geometry.
    xcrun simctl shutdown "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" -b
  fi
  apply_simulator_accessibility "$udid"
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
  -destination "platform=iOS Simulator,id=$build_udid" \
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
  testSoloSetupAuditsBlockedStatsRecoveryElementDetectionWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryHitRegionsWithoutSave
  testSoloSetupAuditsBlockedStatsRecoverySufficientDescriptionsWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryDynamicTypeWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryTextClippingWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryTraitsWithoutSave
  testSoloSetupRetriesBlockedStatsRecoveryWithoutSave
  testSoloSetupAuditsCorruptStatsRecoveryWithoutSave
  testSoloSetupDiscardsCorruptStatsRecoveryWithoutSave
  testSoloSetupBlockedStatsRecoveryScalesAtAccessibilityXXXL
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
  testSoloSetupAuditsBlockedStatsRecoveryElementDetectionWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryHitRegionsWithoutSave
  testSoloSetupAuditsBlockedStatsRecoverySufficientDescriptionsWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryDynamicTypeWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryTextClippingWithoutSave
  testSoloSetupAuditsBlockedStatsRecoveryTraitsWithoutSave
  testSoloSetupRetriesBlockedStatsRecoveryWithoutSave
  testSoloSetupAuditsCorruptStatsRecoveryWithoutSave
  testSoloSetupDiscardsCorruptStatsRecoveryWithoutSave
  testSoloSetupBlockedStatsRecoveryScalesAtAccessibilityXXXL
  testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards
  testSoloRepresentativeTurnKeepsEveryActionSlotStable
  testSoloAccessibilityXXXLRemainsOperable
)
ipad_landscape_tests=(
  testSoloLandscapeTableFitsWithoutWholeScreenScrolling
)
[[ "${#standard_tests[@]}" -eq 28 && \
   "${#large_tests[@]}" -eq 3 && \
   "${#ipad_portrait_tests[@]}" -eq 15 && \
   "${#ipad_landscape_tests[@]}" -eq 1 ]] || {
  printf 'ERROR: The expected accessibility matrix inventory changed.\n' >&2
  exit 1
}
for pinned_test_name in \
  "${standard_tests[@]}" \
  "${large_tests[@]}" \
  "${ipad_portrait_tests[@]}" \
  "${ipad_landscape_tests[@]}"; do
  [[ "$pinned_test_name" =~ ^test[A-Za-z0-9_]+$ ]] || {
    printf 'ERROR: The accessibility matrix contains an invalid XCTest identifier.\n' >&2
    exit 1
  }
done

matrix_status=0
selected_pipeline_status=0
select_pipeline_status() {
  local producer_status="$1"
  shift
  local component_status=""
  selected_pipeline_status="$producer_status"
  if [[ "$selected_pipeline_status" -eq 0 ]]; then
    for component_status in "$@"; do
      if [[ "$component_status" -ne 0 ]]; then
        selected_pipeline_status="$component_status"
        break
      fi
    done
  fi
  return 0
}

record_matrix_status() {
  local status="$1"
  if [[ "$status" -ne 0 && "$matrix_status" -eq 0 ]]; then
    matrix_status="$status"
  fi
  return 0
}

verify_result_bundle() (
  local role="$1"
  local result_bundle="$2"
  local summary_log="$3"
  local tests_log="$4"
  local proof_log="$5"
  local expected_count="$6"
  shift 6
  local summary_status=1
  local tests_status=1
  local proof_status=1
  local -a summary_pipeline_status=()
  local -a tests_pipeline_status=()
  local -a proof_pipeline_status=()

  if [[ "$#" -ne "$expected_count" ]]; then
    printf 'ERROR: The pinned test arguments changed for %s.\n' "$role" >&2
    return 1
  fi
  if [[ ! -e "$result_bundle" ]]; then
    printf 'ERROR: Missing xcresult bundle for %s.\n' "$role" >&2
    return 1
  fi

  set +e
  xcrun xcresulttool get test-results summary --path "$result_bundle" \
    2>&1 | sanitize_output | tee "$summary_log"
  summary_pipeline_status=("${PIPESTATUS[@]}")
  xcrun xcresulttool get test-results tests --path "$result_bundle" \
    2>&1 | sanitize_output | tee "$tests_log"
  tests_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  select_pipeline_status "${summary_pipeline_status[@]}"
  summary_status="$selected_pipeline_status"
  select_pipeline_status "${tests_pipeline_status[@]}"
  tests_status="$selected_pipeline_status"
  if [[ "$summary_status" -ne 0 || "$tests_status" -ne 0 ]]; then
    printf 'ERROR: Failed to extract complete xcresult evidence for %s.\n' "$role" >&2
    return 1
  fi

  set +e
  node "$result_verifier" "$summary_log" "$tests_log" "$@" \
    2>&1 | sanitize_output | tee "$proof_log"
  proof_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  select_pipeline_status "${proof_pipeline_status[@]}"
  proof_status="$selected_pipeline_status"
  if [[ "$proof_status" -ne 0 ]]; then
    printf 'ERROR: The xcresult evidence did not prove the exact %s-test %s entry.\n' \
      "$expected_count" "$role" >&2
    return 1
  fi
)

classify_infrastructure_failure() (
  local summary_log="$1"
  local classification_log="$2"
  local test_name="$3"
  local classification_status=1
  local -a classification_pipeline_status=()

  set +e
  node "$result_verifier" \
    --classify-infrastructure-failure "$summary_log" "$test_name" \
    2>&1 | sanitize_output | tee "$classification_log"
  classification_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  select_pipeline_status "${classification_pipeline_status[@]}"
  classification_status="$selected_pipeline_status"
  return "$classification_status"
)

run_matrix_entry() {
  local role="$1"
  local udid="$2"
  local expected_count="$3"
  shift 3
  local result_bundle="$evidence_dir/$role.xcresult"
  local test_log="$evidence_dir/$role.log"
  local summary_log="$evidence_dir/$role-summary.log"
  local tests_log="$evidence_dir/$role-tests.log"
  local proof_log="$evidence_dir/$role-proof.json"
  local -a test_pipeline_status=()
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
  test_pipeline_status=("${PIPESTATUS[@]}")
  set -e
  select_pipeline_status "${test_pipeline_status[@]}"
  local status="$selected_pipeline_status"
  record_matrix_status "$status"

  set +e
  verify_result_bundle \
    "$role" "$result_bundle" "$summary_log" "$tests_log" "$proof_log" \
    "$expected_count" "$@"
  local proof_status=$?
  set -e
  record_matrix_status "$proof_status"
  return 0
}

run_isolated_ipad_portrait_entry() {
  local role="$1"
  local udid="$2"
  local expected_count="$3"
  shift 3
  local children_dir="$evidence_dir/$role-isolated"
  local isolation_manifest="$evidence_dir/$role-isolation.tsv"
  local merged_result_bundle="$evidence_dir/$role.xcresult"
  local merged_summary_log="$evidence_dir/$role-summary.log"
  local merged_tests_log="$evidence_dir/$role-tests.log"
  local merged_proof_log="$evidence_dir/$role-proof.json"
  local merge_log="$evidence_dir/$role-merge.log"
  local -a child_result_bundles=()
  local test_name=""
  local ordinal=0

  if [[ "$#" -ne "$expected_count" ]]; then
    printf 'ERROR: The pinned isolated iPad portrait inventory changed.\n' >&2
    record_matrix_status 1
    return 0
  fi
  mkdir -p "$children_dir"
  printf 'schema-version\t2\nrole\t%s\nexpected-test-count\t%s\n' \
    "$role" "$expected_count" > "$isolation_manifest"
  printf 'attempt\tordinal\tidentifier\tattempt-number\tpreparation-status\txcodebuild-status\tproof-status\tclassification-status\treset-status\taccepted\n' \
    >> "$isolation_manifest"
  printf 'test\tordinal\tidentifier\tfinal-status\taccepted-attempt\n' \
    >> "$isolation_manifest"

  for test_name in "$@"; do
    ordinal=$((ordinal + 1))
    local ordinal_key=""
    local attempt_number=1
    local run_another_attempt=1
    local accepted_attempt=0
    local final_status=1

    printf -v ordinal_key '%02d' "$ordinal"
    while [[ "$run_another_attempt" -eq 1 ]]; do
      local attempt_suffix=""
      local child_key=""
      local child_result_bundle=""
      local child_test_log=""
      local child_summary_log=""
      local child_tests_log=""
      local child_proof_log=""
      local classification_log=""
      local preparation_status=1
      local status=1
      local proof_status=1
      local classification_status="-"
      local reset_status="-"
      local accepted=0
      local retry_eligible=0
      local -a arguments=()
      local -a child_pipeline_status=()

      run_another_attempt=0
      if [[ "$attempt_number" -eq 2 ]]; then
        attempt_suffix="-retry-02"
      fi
      child_key="$ordinal_key-$test_name$attempt_suffix"
      child_result_bundle="$children_dir/$child_key.xcresult"
      child_test_log="$children_dir/$child_key.log"
      child_summary_log="$children_dir/$child_key-summary.log"
      child_tests_log="$children_dir/$child_key-tests.log"
      child_proof_log="$children_dir/$child_key-proof.json"
      classification_log="$children_dir/$child_key-infrastructure-classification.json"
      arguments=(
        test-without-building
        -quiet
        -project "$project_path"
        -scheme SkyjoNative
        -testPlan SkyjoCI
        -configuration Debug
        -destination "platform=iOS Simulator,id=$udid"
        -destination-timeout 120
        -derivedDataPath "$derived_data"
        -resultBundlePath "$child_result_bundle"
        -parallel-testing-enabled NO
        "-only-testing:$solo_suite/$test_name"
        CODE_SIGNING_ALLOWED=NO
      )

      set +e
      cold_boot_and_prepare_simulator "$udid"
      preparation_status=$?
      set -e

      # Always run every pinned child invocation so a failed test still leaves
      # a complete evidence manifest for diagnosis. Only an exact classified
      # infrastructure failure can add one second invocation for that child.
      set +e
      "${xcode_environment[@]}" xcodebuild "${arguments[@]}" \
        2>&1 | sanitize_output | tee "$child_test_log"
      child_pipeline_status=("${PIPESTATUS[@]}")
      set -e
      select_pipeline_status "${child_pipeline_status[@]}"
      status="$selected_pipeline_status"

      set +e
      verify_result_bundle \
        "$role/$test_name" \
        "$child_result_bundle" \
        "$child_summary_log" \
        "$child_tests_log" \
        "$child_proof_log" \
        1 \
        "$test_name"
      proof_status=$?
      set -e

      if [[ "$preparation_status" -eq 0 && "$status" -eq 0 && \
            "$proof_status" -eq 0 ]]; then
        accepted=1
        accepted_attempt="$attempt_number"
        final_status=0
        child_result_bundles+=("$child_result_bundle")
      elif [[ "$attempt_number" -eq 1 && "$preparation_status" -eq 0 && \
              "$status" -eq 65 && "$proof_status" -ne 0 ]]; then
        set +e
        classify_infrastructure_failure \
          "$child_summary_log" "$classification_log" "$test_name"
        classification_status=$?
        set -e
        if [[ "$classification_status" -eq 0 ]]; then
          retry_eligible=1
          set +e
          reset_simulator_after_infrastructure_failure "$udid"
          reset_status=$?
          set -e
          if [[ "$reset_status" -eq 0 ]]; then
            run_another_attempt=1
          else
            record_matrix_status "$reset_status"
          fi
        fi
      fi

      if [[ "$accepted" -ne 1 && "$run_another_attempt" -ne 1 && \
            "$retry_eligible" -ne 1 ]]; then
        record_matrix_status "$preparation_status"
        record_matrix_status "$status"
        record_matrix_status "$proof_status"
        if [[ "$classification_status" != "-" ]]; then
          record_matrix_status "$classification_status"
        fi
      elif [[ "$accepted" -ne 1 && "$attempt_number" -eq 2 ]]; then
        record_matrix_status "$preparation_status"
        record_matrix_status "$status"
        record_matrix_status "$proof_status"
      fi

      printf 'attempt\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$ordinal_key" "$test_name" "$attempt_number" "$preparation_status" \
        "$status" "$proof_status" "$classification_status" "$reset_status" "$accepted" \
        >> "$isolation_manifest"
      attempt_number=$((attempt_number + 1))
    done

    printf 'test\t%s\t%s\t%s\t%s\n' \
      "$ordinal_key" "$test_name" "$final_status" "$accepted_attempt" \
      >> "$isolation_manifest"
  done

  local merge_status=1
  local -a merge_pipeline_status=()
  if [[ "${#child_result_bundles[@]}" -eq "$expected_count" && \
        ! -e "$merged_result_bundle" ]]; then
    set +e
    xcrun xcresulttool merge \
      --output-path "$merged_result_bundle" \
      "${child_result_bundles[@]}" \
      2>&1 | sanitize_output | tee "$merge_log"
    merge_pipeline_status=("${PIPESTATUS[@]}")
    set -e
    select_pipeline_status "${merge_pipeline_status[@]}"
    merge_status="$selected_pipeline_status"
  else
    printf 'ERROR: Cannot merge the exact isolated iPad portrait result inventory.\n' \
      | tee "$merge_log" >&2
  fi
  record_matrix_status "$merge_status"

  local merged_proof_status=1
  if [[ "$merge_status" -eq 0 ]]; then
    set +e
    verify_result_bundle \
      "$role" \
      "$merged_result_bundle" \
      "$merged_summary_log" \
      "$merged_tests_log" \
      "$merged_proof_log" \
      "$expected_count" \
      "$@"
    merged_proof_status=$?
    set -e
  fi
  record_matrix_status "$merged_proof_status"
  printf 'merge\tstatus\t%s\nproof\tstatus\t%s\n' \
    "$merge_status" "$merged_proof_status" >> "$isolation_manifest"
  return 0
}

case "$selected_role" in
  "")
    run_matrix_entry standard-phone "$standard_udid" 28 "${standard_tests[@]}"
    run_matrix_entry large-phone "$large_udid" 3 "${large_tests[@]}"
    run_matrix_entry ipad-portrait "$ipad_udid" 15 "${ipad_portrait_tests[@]}"
    run_matrix_entry ipad-landscape "$ipad_udid" 1 "${ipad_landscape_tests[@]}"
    ;;
  standard-phone)
    run_matrix_entry standard-phone "$standard_udid" 28 "${standard_tests[@]}"
    ;;
  large-phone)
    run_matrix_entry large-phone "$large_udid" 3 "${large_tests[@]}"
    ;;
  ipad-portrait)
    run_isolated_ipad_portrait_entry \
      ipad-portrait "$ipad_udid" 15 "${ipad_portrait_tests[@]}"
    ;;
  ipad-landscape)
    run_matrix_entry ipad-landscape "$ipad_udid" 1 "${ipad_landscape_tests[@]}"
    ;;
esac

exit "$matrix_status"
