import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateIOSUIXCResult } from '../../scripts/verify-ios-ui-xcresult.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const harnessPath = path.join(repositoryRoot, 'scripts', 'ios-build-test.sh');
const uiAccessibilityHarnessPath = path.join(
  repositoryRoot,
  'scripts',
  'ios-ui-accessibility-test.sh'
);

const ipadPortraitTests = [
  'testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting',
  'testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave',
  'testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards',
  'testSoloRepresentativeTurnKeepsEveryActionSlotStable',
  'testSoloAccessibilityXXXLRemainsOperable'
];

function passingSummary(testCount, configurationCounts = [testCount]) {
  return {
    result: 'Passed',
    totalTestCount: testCount,
    passedTests: testCount,
    failedTests: 0,
    skippedTests: 0,
    expectedFailures: 0,
    testFailures: [],
    devicesAndConfigurations: configurationCounts.map((passedTests) => ({
      passedTests,
      failedTests: 0,
      skippedTests: 0,
      expectedFailures: 0,
      device: { deviceId: '00000000-0000-4000-8000-000000000001' },
      testPlanConfiguration: { configurationId: '1', configurationName: 'CI' }
    }))
  };
}

function passingInventory(testNames) {
  return {
    devices: [{ deviceId: '00000000-0000-4000-8000-000000000001' }],
    testPlanConfigurations: [{ configurationId: '1', configurationName: 'CI' }],
    testNodes: [
      {
        nodeType: 'Test Plan',
        children: [
          {
            nodeType: 'UI test bundle',
            children: [
              {
                nodeType: 'Test Suite',
                children: testNames.map((testName) => ({
                  name: `${testName}()`,
                  nodeIdentifier: `SkyjoAppUITests/${testName}()`,
                  nodeIdentifierURL:
                    `test://com.apple.xcode/SkyjoNative/SkyjoAppUITests/` +
                    `SkyjoAppUITests/${testName}`,
                  nodeType: 'Test Case',
                  result: 'Passed'
                }))
              }
            ]
          }
        ]
      }
    ]
  };
}

function extractBashFunction(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^${escapedName}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing Bash function ${name}`);
  return match[0];
}

test('the Xcode version probe consumes the complete producer output before parsing', async () => {
  const harness = await fs.readFile(harnessPath, 'utf8');

  assert.match(harness, /xcode_version_output="\$\(xcodebuild -version\)"/);
  assert.match(harness, /printf '%s\\n' "\$xcode_version_output" \| awk/);
  assert.doesNotMatch(harness, /xcodebuild -version[^\n]*\|/);
});

test('networking mode launches a credential-isolated PWA bridge and current production bundle', async () => {
  const harness = await fs.readFile(harnessPath, 'utf8');

  assert.match(harness, /if \[\[ "\$test_mode" == "networking-contracts" \]\]; then[\s\S]*verify-ios-pwa-v032-compatibility\.mjs[\s\S]*npm run build/);
  assert.match(harness, /pwa_driver_environment=\([\s\S]*\/usr\/bin\/env -i[\s\S]*"NODE_ENV=test"[\s\S]*\)/);
  const driverEnvironment = harness.match(/pwa_driver_environment=\([\s\S]*?\n  \)/)?.[0] || '';
  assert.match(driverEnvironment, /"HOME=\$\{HOME:-\/tmp\}"/);
  assert.doesNotMatch(driverEnvironment, /pwa-driver-home|PLAYWRIGHT_BROWSERS_PATH=\/tmp/);
  assert.doesNotMatch(driverEnvironment, /SKYJO_ACCESS_PASSWORD|SKYJO_SESSION_SECRET|SKYJO_INVITE_SECRET|SKYJO_DB_FILE|SKYJO_ROOMS_FILE/);
  assert.match(harness, /ios-pwa-mixed-client-driver\.mjs"[\s\\\n]*< <\(printf '\{"version":1,"type":"start","serverOrigin":"%s"\}\\n' "\$ios_test_server_url"\)[\s\\\n]*> "\$pwa_driver_raw_stdout" 2> "\$pwa_driver_raw_stderr" &/);
  assert.doesNotMatch(harness, /pwa-driver\.stdin|mkfifo/);
  assert.match(harness, /Started isolated mixed PWA driver on a dynamic loopback port\./);
  assert.doesNotMatch(harness, /Started isolated mixed PWA driver[^\n]*\$pwa_driver_control_(?:port|url)/);
});

test('mixed driver cleanup, simulator environment, and lifecycle acceleration stay fail-closed', async () => {
  const harness = await fs.readFile(harnessPath, 'utf8');

  const cleanup = harness.match(/cleanup_node_server\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(cleanup.indexOf('kill -TERM "$pwa_driver_pid"') < cleanup.indexOf('kill -TERM "$node_server_pid"'));
  assert.match(cleanup, /wc -l < "\$pwa_driver_raw_stdout"/);
  assert.match(cleanup, /-s "\$pwa_driver_raw_stderr"/);
  assert.match(cleanup, /grep -a -F -q -- "\$private_value"[\s\\\n]*"\$pwa_driver_raw_stdout" "\$pwa_driver_raw_stderr"/);
  assert.ok(cleanup.indexOf('grep -a -F -q') < cleanup.indexOf('rm -rf -- "$node_test_dir"'));
  for (const key of ['SKYJO_IOS_TEST_SERVER_URL', 'SKYJO_IOS_PWA_CONTROL_URL', 'SKYJO_IOS_TEST_MODE']) {
    assert.match(cleanup, new RegExp(key));
  }
  assert.match(harness, /launchctl setenv \\\n\s*SKYJO_IOS_TEST_MODE "\$test_mode"/);
  assert.match(harness, /launchctl setenv \\\n\s*SKYJO_IOS_PWA_CONTROL_URL "\$pwa_driver_control_url"/);

  const timerBlock = harness.match(/if \[\[ "\$test_mode" == "networking-contracts" \]\]; then\n  node_server_environment\+=\([\s\S]*?\n  \)\nfi/)?.[0] || '';
  assert.match(timerBlock, /SKYJO_WAITING_HOST_TRANSFER_MS=1000/);
  assert.match(timerBlock, /SKYJO_ACTIVE_PLAYER_GRACE_MS=1000/);
  assert.match(timerBlock, /SKYJO_LIFECYCLE_TICK_MS=25/);
  assert.match(timerBlock, /SKYJO_AI_ACTION_DELAY_MS=300/);

  const retainedArtifacts = harness.match(/local -a retained_targets=\([\s\S]*?\n  \)/)?.[0] || '';
  assert.doesNotMatch(retainedArtifacts, /pwa_driver|pwa-driver/);
});

test('the selected iPad portrait role cold-boots and isolates each pinned test', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const coldBoot =
    harness.match(/cold_boot_and_prepare_simulator\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const isolatedEntry =
    harness.match(/run_isolated_ipad_portrait_entry\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const restore =
    harness.match(/restore_simulator_accessibility\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  const selectedRole = harness.match(/case "\$selected_role" in[\s\S]*?exit "\$matrix_status"/)?.[0] || '';

  assert.match(coldBoot, /simctl shutdown "\$udid"/);
  assert.match(coldBoot, /simctl boot "\$udid"/);
  assert.match(coldBoot, /simctl bootstatus "\$udid" -b/);
  assert.match(coldBoot, /apply_simulator_accessibility "\$udid"/);
  assert.ok(coldBoot.indexOf('simctl shutdown "$udid"') < coldBoot.indexOf('simctl boot "$udid"'));
  assert.ok(coldBoot.indexOf('simctl boot "$udid"') < coldBoot.indexOf('simctl bootstatus "$udid" -b'));
  assert.ok(
    coldBoot.indexOf('simctl bootstatus "$udid" -b') <
      coldBoot.indexOf('apply_simulator_accessibility "$udid"')
  );
  assert.doesNotMatch(
    coldBoot,
    /ui_(?:contrast|reduce_motion|differentiate|matrix_marker)_states\+=/
  );
  for (const capturedState of [
    'ui_contrast_states',
    'ui_reduce_motion_states',
    'ui_differentiate_states',
    'ui_matrix_marker_states'
  ]) {
    assert.match(restore, new RegExp(`\\$\\{${capturedState}\\[\\$index\\]`));
  }
  assert.ok(
    restore.indexOf('simctl bootstatus "$udid" -b') <
      restore.indexOf('simctl ui "$udid" increase_contrast "$expected_contrast"')
  );
  assert.match(isolatedEntry, /for test_name in "\$@"; do/);
  assert.match(isolatedEntry, /cold_boot_and_prepare_simulator "\$udid"/);
  assert.match(isolatedEntry, /"-only-testing:\$solo_suite\/\$test_name"/);
  assert.doesNotMatch(isolatedEntry, /break|continue/);
  assert.match(isolatedEntry, /child_result_bundles\+=\("\$child_result_bundle"\)/);
  assert.match(isolatedEntry, /xcrun xcresulttool merge/);
  assert.match(isolatedEntry, /--output-path "\$merged_result_bundle"/);
  assert.match(isolatedEntry, /verify_result_bundle[\s\S]*?"\$expected_count"[\s\S]*?"\$@"/);
  assert.match(
    selectedRole,
    /""\)[\s\S]*?run_matrix_entry ipad-portrait[\s\S]*?ipad-portrait\)[\s\S]*?run_isolated_ipad_portrait_entry/
  );
  for (const testName of ipadPortraitTests) assert.match(harness, new RegExp(`  ${testName}\\n`));
});

test('a failed child proof does not stop the remaining isolated portrait invocations', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  assert.match(harness, /^verify_result_bundle\(\) \($/m);
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'skyjo-ios-portrait-harness-')
  );
  const stubScript = [
    'set -euo pipefail',
    extractBashFunction(harness, 'select_pipeline_status'),
    extractBashFunction(harness, 'record_matrix_status'),
    extractBashFunction(harness, 'run_isolated_ipad_portrait_entry'),
    'matrix_status=0',
    'selected_pipeline_status=0',
    'select_pipeline_status 65 7 0',
    '[[ "$selected_pipeline_status" -eq 65 ]]',
    'select_pipeline_status 0 7 0',
    '[[ "$selected_pipeline_status" -eq 7 ]]',
    'selected_pipeline_status=0',
    'evidence_dir="$STUB_DIR/evidence"',
    'project_path="$STUB_DIR/project"',
    'derived_data="$STUB_DIR/derived"',
    'solo_suite="SkyjoAppUITests/SkyjoAppUITests"',
    'stub_environment() { "$@"; }',
    'xcode_environment=(stub_environment)',
    'mkdir -p "$evidence_dir"',
    'sanitize_output() { /bin/cat; }',
    'cold_boot_and_prepare_simulator() { return 0; }',
    'verify_result_bundle() (',
    '  set -e',
    `  [[ "$1" != *${ipadPortraitTests[0]} ]]`,
    ')',
    'xcodebuild() {',
    '  local argument=""',
    '  local result_bundle=""',
    '  local capture_path=0',
    '  for argument in "$@"; do',
    '    if [[ "$capture_path" -eq 1 ]]; then result_bundle="$argument"; break; fi',
    '    if [[ "$argument" == "-resultBundlePath" ]]; then capture_path=1; fi',
    '  done',
    '  [[ -n "$result_bundle" ]] || return 2',
    '  mkdir -p "$result_bundle"',
    '  printf "%s\\n" "$result_bundle" >> "$STUB_DIR/invocations"',
    '}',
    'xcrun() {',
    '  local argument=""',
    '  local output_path=""',
    '  local capture_path=0',
    '  [[ "$1" == "xcresulttool" && "$2" == "merge" ]] || return 2',
    '  shift 2',
    '  for argument in "$@"; do',
    '    if [[ "$capture_path" -eq 1 ]]; then output_path="$argument"; break; fi',
    '    if [[ "$argument" == "--output-path" ]]; then capture_path=1; fi',
    '  done',
    '  [[ -n "$output_path" ]] || return 2',
    '  mkdir -p "$output_path"',
    '}',
    `tests=(${ipadPortraitTests.map((testName) => `"${testName}"`).join(' ')})`,
    'run_isolated_ipad_portrait_entry ipad-portrait stub-udid 5 "${tests[@]}"',
    '[[ "$(wc -l < "$STUB_DIR/invocations")" -eq 5 ]]',
    'test_rows="$(awk -F "\\t" \'$1 == "test" && $2 ~ /^[0-9][0-9]$/ { count += 1 } END { print count + 0 }\' "$evidence_dir/ipad-portrait-isolation.tsv")"',
    '[[ "$test_rows" -eq 5 ]]',
    '[[ "$matrix_status" -eq 1 ]]',
    'printf "all-five-recorded\\n"'
  ].join('\n');

  try {
    const result = spawnSync('bash', ['-c', stubScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, STUB_DIR: temporaryDirectory }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'all-five-recorded');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the xcresult verifier proves merged exact IDs and rejects weaker evidence', () => {
  const mergedProof = validateIOSUIXCResult(
    passingSummary(ipadPortraitTests.length, [ipadPortraitTests.length]),
    passingInventory(ipadPortraitTests),
    ipadPortraitTests
  );
  assert.deepEqual(mergedProof, {
    schemaVersion: 1,
    result: 'Passed',
    expectedTestCount: 5,
    testIdentifiers: ipadPortraitTests.map((testName) => `SkyjoAppUITests/${testName}()`),
    deviceConfigurationCount: 1
  });

  const skipped = passingSummary(ipadPortraitTests.length);
  skipped.passedTests = 4;
  skipped.skippedTests = 1;
  assert.throws(
    () => validateIOSUIXCResult(skipped, passingInventory(ipadPortraitTests), ipadPortraitTests),
    /exact passing test count/
  );

  const wrongIdentifier = passingInventory(ipadPortraitTests);
  const testCases = wrongIdentifier.testNodes[0].children[0].children[0].children;
  testCases[0].nodeIdentifier = 'SkyjoAppUITests/testUnexpected()';
  assert.throws(
    () =>
      validateIOSUIXCResult(
        passingSummary(ipadPortraitTests.length),
        wrongIdentifier,
        ipadPortraitTests
      ),
    /did not prove the pinned test/
  );

  const secondDestination = passingSummary(ipadPortraitTests.length, [2, 3]);
  secondDestination.devicesAndConfigurations[1].device.deviceId =
    '00000000-0000-4000-8000-000000000002';
  assert.throws(
    () =>
      validateIOSUIXCResult(
        secondDestination,
        passingInventory(ipadPortraitTests),
        ipadPortraitTests
    ),
    /one exact destination and test plan/
  );

  const secondConfiguration = passingSummary(ipadPortraitTests.length, [2, 3]);
  secondConfiguration.devicesAndConfigurations[1].testPlanConfiguration.configurationId = '2';
  assert.throws(
    () =>
      validateIOSUIXCResult(
        secondConfiguration,
        passingInventory(ipadPortraitTests),
        ipadPortraitTests
      ),
    /one exact destination and test plan/
  );

  const mismatchedInventory = passingInventory(ipadPortraitTests);
  mismatchedInventory.devices[0].deviceId = '00000000-0000-4000-8000-000000000002';
  assert.throws(
    () =>
      validateIOSUIXCResult(
        passingSummary(ipadPortraitTests.length),
        mismatchedInventory,
        ipadPortraitTests
    ),
    /summary and inventory identify different/
  );

  const mismatchedPlanInventory = passingInventory(ipadPortraitTests);
  mismatchedPlanInventory.testPlanConfigurations[0].configurationId = '2';
  assert.throws(
    () =>
      validateIOSUIXCResult(
        passingSummary(ipadPortraitTests.length),
        mismatchedPlanInventory,
        ipadPortraitTests
      ),
    /summary and inventory identify different/
  );

  const duplicateMergeCounters = passingSummary(ipadPortraitTests.length, [10]);
  assert.throws(
    () =>
      validateIOSUIXCResult(
        duplicateMergeCounters,
        passingInventory(ipadPortraitTests),
        ipadPortraitTests
      ),
    /one exact destination and test plan/
  );
});

test('the xcresult verifier reads each bounded JSON input through one descriptor', async () => {
  const verifier = await fs.readFile(
    path.join(repositoryRoot, 'scripts', 'verify-ios-ui-xcresult.mjs'),
    'utf8'
  );
  const boundedReader =
    verifier.match(/function readBoundedJSON\(filePath, label\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(boundedReader, /fs\.openSync\(/);
  assert.match(boundedReader, /fs\.fstatSync\(descriptor\)/);
  assert.match(boundedReader, /fs\.readSync\([\s\S]*?descriptor/);
  assert.match(boundedReader, /MAX_RESULT_JSON_BYTES \+ 1/);
  assert.match(boundedReader, /fs\.closeSync\(descriptor\)/);
  assert.doesNotMatch(boundedReader, /fs\.statSync\(|fs\.readFileSync\(/);
});
