import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyIOSUIInfrastructureFailure,
  validateIOSUIXCResult
} from '../../scripts/verify-ios-ui-xcresult.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const harnessPath = path.join(repositoryRoot, 'scripts', 'ios-build-test.sh');
const uiAccessibilityHarnessPath = path.join(
  repositoryRoot,
  'scripts',
  'ios-ui-accessibility-test.sh'
);
const uiAccessibilityTestsPath = path.join(
  repositoryRoot,
  'ios',
  'SkyjoAppUITests',
  'SkyjoAppUITests.swift'
);

const ipadPortraitTests = [
  'testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting',
  'testSoloSetupAuditsDefaultElementDetectionBeforeWriting',
  'testSoloSetupAuditsDefaultHitRegionsBeforeWriting',
  'testSoloSetupAuditsDefaultSufficientDescriptionsBeforeWriting',
  'testSoloSetupAuditsDefaultDynamicTypeBeforeWriting',
  'testSoloSetupAuditsDefaultTextClippingBeforeWriting',
  'testSoloSetupAuditsDefaultTraitsBeforeWriting',
  'testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoveryElementDetectionWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoveryHitRegionsWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoverySufficientDescriptionsWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoveryDynamicTypeWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoveryTextClippingWithoutSave',
  'testSoloSetupAuditsBlockedStatsRecoveryTraitsWithoutSave',
  'testSoloSetupRetriesBlockedStatsRecoveryWithoutSave',
  'testSoloSetupAuditsCorruptStatsRecoveryWithoutSave',
  'testSoloSetupDiscardsCorruptStatsRecoveryWithoutSave',
  'testSoloSetupBlockedStatsRecoveryScalesAtAccessibilityXXXL',
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
      device: {
        deviceId: '00000000-0000-4000-8000-000000000001',
        platform: 'iOS Simulator'
      },
      testPlanConfiguration: { configurationId: '1', configurationName: 'CI' }
    }))
  };
}

function failedSummary(testName, failureText) {
  return {
    result: 'Failed',
    totalTestCount: 1,
    passedTests: 0,
    failedTests: 1,
    skippedTests: 0,
    expectedFailures: 0,
    testFailures: [
      {
        failureText,
        targetName: 'SkyjoAppUITests',
        testIdentifier: 1,
        testIdentifierString: `SkyjoAppUITests/${testName}()`,
        testIdentifierURL:
          `test://com.apple.xcode/SkyjoNative/SkyjoAppUITests/` +
          `SkyjoAppUITests/${testName}`,
        testName: `${testName}()`
      }
    ],
    devicesAndConfigurations: [
      {
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        expectedFailures: 0,
        device: {
          deviceId: '00000000-0000-4000-8000-000000000001',
          platform: 'iOS Simulator'
        },
        testPlanConfiguration: { configurationId: '1', configurationName: 'CI' }
      }
    ]
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

async function runIsolatedPortraitScenario(harness, scenario) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `skyjo-ios-portrait-${scenario}-`)
  );
  const firstTest = ipadPortraitTests[0];
  const stubScript = [
    'set -euo pipefail',
    extractBashFunction(harness, 'select_pipeline_status'),
    extractBashFunction(harness, 'record_matrix_status'),
    extractBashFunction(harness, 'run_isolated_ipad_portrait_entry'),
    'matrix_status=0',
    'selected_pipeline_status=0',
    'evidence_dir="$STUB_DIR/evidence"',
    'project_path="$STUB_DIR/project"',
    'derived_data="$STUB_DIR/derived"',
    'solo_suite="SkyjoAppUITests/SkyjoAppUITests"',
    'stub_environment() { "$@"; }',
    'xcode_environment=(stub_environment)',
    'mkdir -p "$evidence_dir"',
    'sanitize_output() { /bin/cat; }',
    'cold_boot_and_prepare_simulator() {',
    '  printf "%s\\n" "$1" >> "$STUB_DIR/cold-boots"',
    '  return 0',
    '}',
    'classify_infrastructure_failure() (',
    '  printf "%s\\t%s\\n" "$1" "$3" >> "$STUB_DIR/classifications"',
    `  [[ "$STUB_SCENARIO" != "assertion" && "$3" == "${firstTest}" && "$1" != *-retry-02-summary.log ]]`,
    ')',
    'reset_simulator_after_infrastructure_failure() {',
    '  printf "%s\\n" "$1" >> "$STUB_DIR/resets"',
    '  return 0',
    '}',
    'verify_result_bundle() (',
    '  local role="$1"',
    '  local result_bundle="$2"',
    '  printf "%s\\t%s\\n" "$role" "$result_bundle" >> "$STUB_DIR/proofs"',
    '  if [[ "$role" == "ipad-portrait" ]]; then return 0; fi',
    `  if [[ "$role" == */${firstTest} ]]; then`,
    '    if [[ "$result_bundle" != *-retry-02.xcresult ]]; then return 1; fi',
    '    if [[ "$STUB_SCENARIO" == "retry-fails" ]]; then return 1; fi',
    '  fi',
    '  return 0',
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
    `  if [[ "$result_bundle" == *"01-${firstTest}.xcresult" ]]; then return 65; fi`,
    `  if [[ "$STUB_SCENARIO" == "retry-fails" && "$result_bundle" == *"01-${firstTest}-retry-02.xcresult" ]]; then return 65; fi`,
    '  return 0',
    '}',
    'xcrun() {',
    '  local argument=""',
    '  local output_path=""',
    '  local capture_path=0',
    '  [[ "$1" == "xcresulttool" && "$2" == "merge" ]] || return 2',
    '  shift 2',
    '  for argument in "$@"; do',
    '    if [[ "$capture_path" -eq 1 ]]; then',
    '      output_path="$argument"',
    '      capture_path=0',
    '    elif [[ "$argument" == "--output-path" ]]; then',
    '      capture_path=1',
    '    elif [[ "$argument" == *.xcresult ]]; then',
    '      printf "%s\\n" "$argument" >> "$STUB_DIR/merge-inputs"',
    '    fi',
    '  done',
    '  [[ -n "$output_path" ]] || return 2',
    '  mkdir -p "$output_path"',
    '}',
    `tests=(${ipadPortraitTests.map((testName) => `"${testName}"`).join(' ')})`,
    `run_isolated_ipad_portrait_entry ipad-portrait stub-udid ${ipadPortraitTests.length} "\${tests[@]}"`,
    'printf "%s\\n" "$matrix_status" > "$STUB_DIR/matrix-status"'
  ].join('\n');

  const result = spawnSync('bash', ['-c', stubScript], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, STUB_DIR: temporaryDirectory, STUB_SCENARIO: scenario }
  });
  const readLines = async (name) => {
    try {
      const contents = await fs.readFile(path.join(temporaryDirectory, name), 'utf8');
      return contents.trim() === '' ? [] : contents.trim().split('\n');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return {
      matrixStatus: Number((await readLines('matrix-status'))[0]),
      invocations: await readLines('invocations'),
      coldBoots: await readLines('cold-boots'),
      classifications: await readLines('classifications'),
      resets: await readLines('resets'),
      mergeInputs: await readLines('merge-inputs'),
      manifest: await fs.readFile(
        path.join(temporaryDirectory, 'evidence', 'ipad-portrait-isolation.tsv'),
        'utf8'
      )
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
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
  const infrastructureReset =
    harness.match(/reset_simulator_after_infrastructure_failure\(\) \{[\s\S]*?\n\}/)?.[0] || '';
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
  assert.match(infrastructureReset, /for selected_udid in "\$\{ui_udids\[@\]\}"/);
  assert.match(infrastructureReset, /"\$\{GITHUB_ACTIONS:-\}" == "true"/);
  assert.match(infrastructureReset, /"\$\{RUNNER_ENVIRONMENT:-\}" == "github-hosted"/);
  assert.match(infrastructureReset, /simctl erase "\$udid"/);
  assert.ok(
    infrastructureReset.indexOf('simctl shutdown "$udid"') <
      infrastructureReset.indexOf('simctl erase "$udid"')
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
  assert.match(isolatedEntry, /classify_infrastructure_failure/);
  assert.match(isolatedEntry, /reset_simulator_after_infrastructure_failure/);
  assert.match(isolatedEntry, /"\$status" -eq 65/);
  assert.match(isolatedEntry, /"\$attempt_number" -eq 1/);
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
  assert.equal(ipadPortraitTests.length, 21);
  for (const testName of ipadPortraitTests) assert.match(harness, new RegExp(`  ${testName}\\n`));
});

test('default setup audit categories own separate fail-closed terminal XCTest children', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const uiTests = await fs.readFile(uiAccessibilityTestsPath, 'utf8');
  const method = (name) => {
    const match = uiTests.match(
      new RegExp(`  func ${name}\\(\\) throws \\{[\\s\\S]*?\\n  \\}\\n\\n  @MainActor`)
    );
    assert.ok(match, `missing isolated UI test method ${name}`);
    return match[0];
  };
  const auditOwners = [
    ['testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting', 'contrast'],
    ['testSoloSetupAuditsDefaultElementDetectionBeforeWriting', 'elementDetection'],
    ['testSoloSetupAuditsDefaultHitRegionsBeforeWriting', 'hitRegion'],
    [
      'testSoloSetupAuditsDefaultSufficientDescriptionsBeforeWriting',
      'sufficientElementDescription'
    ],
    ['testSoloSetupAuditsDefaultDynamicTypeBeforeWriting', 'dynamicType'],
    ['testSoloSetupAuditsDefaultTextClippingBeforeWriting', 'textClipped'],
    ['testSoloSetupAuditsDefaultTraitsBeforeWriting', 'trait']
  ];
  const phaseAudits = [
    ['contrast', 'performContrastAccessibilityAudit'],
    ['elementDetection', 'performElementDetectionAccessibilityAudit'],
    ['hitRegion', 'performHitRegionAccessibilityAudit'],
    ['sufficientElementDescription', 'performSufficientElementDescriptionAccessibilityAudit'],
    ['dynamicType', 'performDynamicTypeAccessibilityAudit'],
    ['textClipped', 'performExactTextClippingAudit'],
    ['trait', 'performTraitAccessibilityAudit']
  ];
  const standardInventory = harness.match(/standard_tests=\(\n([\s\S]*?)\n\)\nlarge_tests=/);
  const ipadInventory = harness.match(/ipad_portrait_tests=\(\n([\s\S]*?)\n\)\nipad_landscape_tests=/);
  assert.ok(standardInventory, 'missing standard-phone inventory');
  assert.ok(ipadInventory, 'missing iPad-portrait inventory');

  for (const [name, phase] of auditOwners) {
    const source = method(name);
    assert.match(standardInventory[1], new RegExp(`  ${name}\\n`));
    assert.match(ipadInventory[1], new RegExp(`  ${name}\\n`));
    assert.match(source, new RegExp(`try runSoloSetupDefaultsAudit\\(\\n      \\.${phase},`));
    for (const [, otherPhase] of auditOwners) {
      if (otherPhase !== phase) assert.doesNotMatch(source, new RegExp(`\\.${otherPhase},`));
    }
  }
  assert.equal(auditOwners.length, 7);

  const runner = uiTests.match(
    /  private func runSoloSetupDefaultsAudit\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(runner, 'missing default-setup audit runner');
  for (let index = 0; index < phaseAudits.length; index += 1) {
    const [phase, ownedAudit] = phaseAudits[index];
    const start = runner[0].indexOf(`case .${phase}:`);
    const end = index + 1 < phaseAudits.length
      ? runner[0].indexOf(`case .${phaseAudits[index + 1][0]}:`)
      : runner[0].indexOf('    assertAuditTargetRemainsForegroundAndTerminate(');
    assert.ok(start >= 0 && end > start, `missing exact switch segment for ${phase}`);
    const segment = runner[0].slice(start, end);
    assert.match(segment, new RegExp(`try ${ownedAudit}\\(`));
    for (const [, otherAudit] of phaseAudits) {
      if (otherAudit !== ownedAudit) assert.doesNotMatch(segment, new RegExp(`try ${otherAudit}\\(`));
    }
  }
  assert.doesNotMatch(runner[0], /performSoloAccessibilityAudit/);
  assert.match(
    runner[0],
    /switch phase[\s\S]*?assertAuditTargetRemainsForegroundAndTerminate\(\n      app,/
  );

  const fixture = uiTests.match(
    /  private func launchVerifiedSoloSetupDefaultsAuditFixture\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(fixture, 'missing verified default-setup fixture');
  for (const requiredValue of [
    'solo.setup',
    'solo.setup.bot-count',
    'solo.setup.difficulty',
    'solo.setup.difficulty-explanation',
    'solo.setup.start',
    'solo.setup.opponents-header',
    'solo.setup.difficulty-header',
    'Medium',
    'Balanced decisions and the default for a new player.'
  ]) {
    assert.match(fixture[0], new RegExp(requiredValue.replaceAll('.', '\\.')));
  }
  assert.match(fixture[0], /XCTAssertGreaterThanOrEqual\(app\.buttons\["solo\.setup\.start"\]\.frame\.height, 44\)/);
  assert.match(fixture[0], /attachScreenshot\(app, name: screenshotName\)/);
});

test('blocked-outbox audit categories own separate fail-closed terminal XCTest children', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const uiTests = await fs.readFile(uiAccessibilityTestsPath, 'utf8');
  const method = (name) => {
    const match = uiTests.match(
      new RegExp(`  func ${name}\\(\\) throws \\{[\\s\\S]*?\\n  \\}\\n\\n  @MainActor`)
    );
    assert.ok(match, `missing isolated UI test method ${name}`);
    return match[0];
  };
  const auditOwners = [
    ['testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave', 'contrast'],
    ['testSoloSetupAuditsBlockedStatsRecoveryElementDetectionWithoutSave', 'elementDetection'],
    ['testSoloSetupAuditsBlockedStatsRecoveryHitRegionsWithoutSave', 'hitRegion'],
    [
      'testSoloSetupAuditsBlockedStatsRecoverySufficientDescriptionsWithoutSave',
      'sufficientElementDescription'
    ],
    ['testSoloSetupAuditsBlockedStatsRecoveryDynamicTypeWithoutSave', 'dynamicType'],
    ['testSoloSetupAuditsBlockedStatsRecoveryTextClippingWithoutSave', 'textClipped'],
    ['testSoloSetupAuditsBlockedStatsRecoveryTraitsWithoutSave', 'trait']
  ];
  const phaseAudits = [
    ['contrast', 'performContrastAccessibilityAudit'],
    ['elementDetection', 'performElementDetectionAccessibilityAudit'],
    ['hitRegion', 'performHitRegionAccessibilityAudit'],
    ['sufficientElementDescription', 'performSufficientElementDescriptionAccessibilityAudit'],
    ['dynamicType', 'performDynamicTypeAccessibilityAudit'],
    ['textClipped', 'performExactTextClippingAudit'],
    ['trait', 'performTraitAccessibilityAudit']
  ];

  const standardInventory = harness.match(/standard_tests=\(\n([\s\S]*?)\n\)\nlarge_tests=/);
  const ipadInventory = harness.match(/ipad_portrait_tests=\(\n([\s\S]*?)\n\)\nipad_landscape_tests=/);
  assert.ok(standardInventory, 'missing standard-phone inventory');
  assert.ok(ipadInventory, 'missing iPad-portrait inventory');

  for (const [name, phase] of auditOwners) {
    const source = method(name);
    assert.match(standardInventory[1], new RegExp(`  ${name}\\n`));
    assert.match(ipadInventory[1], new RegExp(`  ${name}\\n`));
    assert.match(
      source,
      new RegExp(`try runBlockedStatsRecoveryAudit\\(\\n      \\.${phase},`)
    );
    for (const [, otherPhase] of auditOwners) {
      if (otherPhase !== phase) assert.doesNotMatch(source, new RegExp(`\\.${otherPhase},`));
    }
  }

  assert.equal(auditOwners.length, 7);
  assert.match(harness, /"\$\{#standard_tests\[@\]\}" -eq 34/);
  const runner = uiTests.match(
    /  private func runBlockedStatsRecoveryAudit\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(runner, 'missing blocked-recovery audit runner');
  for (let index = 0; index < phaseAudits.length; index += 1) {
    const [phase, ownedAudit] = phaseAudits[index];
    const start = runner[0].indexOf(`case .${phase}:`);
    const end = index + 1 < phaseAudits.length
      ? runner[0].indexOf(`case .${phaseAudits[index + 1][0]}:`)
      : runner[0].indexOf('    assertAuditTargetRemainsForegroundAndTerminate(');
    assert.ok(start >= 0 && end > start, `missing exact switch segment for ${phase}`);
    const segment = runner[0].slice(start, end);
    assert.match(segment, new RegExp(`try ${ownedAudit}\\(`));
    for (const [, otherAudit] of phaseAudits) {
      if (otherAudit !== ownedAudit) assert.doesNotMatch(segment, new RegExp(`try ${otherAudit}\\(`));
    }
  }
  assert.match(
    runner[0],
    /switch phase[\s\S]*?assertAuditTargetRemainsForegroundAndTerminate\(\n      app,/
  );

  const fixture = uiTests.match(
    /  private func launchVerifiedBlockedStatsRecoveryAuditFixture\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(fixture, 'missing verified blocked-recovery fixture');
  for (const requiredIdentifier of [
    'solo.setup',
    'solo.outbox.recovery',
    'solo.outbox.retry',
    'solo.outbox.discard',
    'solo.outbox.heading',
    'solo.outbox.message'
  ]) {
    assert.match(fixture[0], new RegExp(requiredIdentifier.replaceAll('.', '\\.')));
  }
  assert.match(fixture[0], /XCTAssertGreaterThanOrEqual\(retry\.frame\.height, 44\)/);
  assert.match(fixture[0], /XCTAssertGreaterThanOrEqual\(discard\.frame\.height, 44\)/);
  assert.match(fixture[0], /attachScreenshot\(app, name: screenshotName\)/);

  const lifecycleHelper = uiTests.match(
    /  private func assertAuditTargetRemainsForegroundAndTerminate\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(lifecycleHelper, 'missing post-audit target-liveness helper');
  assert.match(
    lifecycleHelper[0],
    /XCTAssertEqual\([\s\S]*?app\.state,[\s\S]*?\.runningForeground[\s\S]*?\)[\s\S]*?app\.terminate\(\)/
  );

  const corruptOwner = method('testSoloSetupAuditsCorruptStatsRecoveryWithoutSave');
  assert.match(corruptOwner, /try performExactTextClippingAudit\(on: corruptApp\)/);
  assert.match(
    corruptOwner,
    /try performExactTextClippingAudit\(on: corruptApp\)[\s\S]*?assertAuditTargetRemainsForegroundAndTerminate\(\n      corruptApp,/
  );
  assert.doesNotMatch(corruptOwner, /corruptApp\.terminate\(\)/);
});

test('contrast audit snapshots app state before entering AXRuntime', async () => {
  const uiTests = await fs.readFile(uiAccessibilityTestsPath, 'utf8');
  const focusedAudit = uiTests.match(
    /  private func performFocusedSoloAccessibilityAudits\([\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(focusedAudit, 'missing focused solo accessibility audit');

  const auditCall = 'try app.performAccessibilityAudit(for: .contrast) { issue in';
  const auditStart = focusedAudit[0].indexOf(auditCall);
  assert.ok(auditStart > 0, 'missing contrast accessibility audit');
  const snapshotSetup = focusedAudit[0].slice(0, auditStart);
  const callbackStart = auditStart + auditCall.length;
  const callbackEnd = focusedAudit[0].indexOf(
    '\n    }\n    if enforceDynamicType',
    callbackStart
  );
  assert.ok(callbackEnd > callbackStart, 'missing contrast callback boundary');
  const callbackBody = focusedAudit[0].slice(callbackStart, callbackEnd);

  for (const exactSnapshot of [
    /let appFrame = app\.frame/,
    /app\.buttons\["solo\.action\.draw"\]/,
    /app\.buttons\["solo\.action\.discard"\]/,
    /app\.switches\["solo\.settings\.music"\]/,
    /let tabBarFrame = tabBar\.exists \? tabBar\.frame : nil/,
    /let navigationBarFrame = navigationBar\.exists \? navigationBar\.frame : nil/,
    /"solo\.setup\.opponents-header": "Opponents"/,
    /"solo\.setup\.difficulty-header": "Difficulty"/,
    /app\.navigationBars\["Game Settings"\]/,
    /"solo\.opponents\.scroll"/,
    /\(1\.\.\.7\)\.map \{ "solo\.board\.header\.opponent\.ai-/,
    /"solo\.board\.local\.human"/
  ]) {
    assert.match(snapshotSetup, exactSnapshot);
  }
  assert.doesNotMatch(callbackBody, /\bapp\.|self\.element\(in:\s*app/);
  const elementFrameRead = callbackBody.indexOf('let elementFrame = element.frame');
  const disabledControlReturn = callbackBody.indexOf(
    'if isDisabledControl {\n        return true\n      }'
  );
  assert.ok(elementFrameRead >= 0, 'missing one-frame disabled-control proof');
  assert.ok(
    disabledControlReturn > elementFrameRead,
    'disabled-control short-circuit must follow the issue frame read'
  );
  for (const deferredElementRead of [
    'let elementIdentifier = element.identifier',
    'let elementLabel = element.label',
    'let elementType = element.elementType',
    '!element.isHittable'
  ]) {
    assert.ok(
      callbackBody.indexOf(deferredElementRead) > disabledControlReturn,
      `${deferredElementRead} must remain after the disabled-control short-circuit`
    );
  }
  assert.match(
    callbackBody,
    /let isOffscreenOpponentHeaderChild = opponentScrollFrame\.map[\s\S]*?opponentHeaderFrames\.contains/
  );
  for (const exactAllowance of [
    'isObscuredByTabBar',
    'isIndependentlyAuditedOffscreenCopy',
    'isVerifiedSetupHeaderArtifact',
    'isSettingsCopyBehindNavigationMaterial',
    'isOffscreenOpponentHeaderChild'
  ]) {
    assert.match(callbackBody, new RegExp(`!${exactAllowance}`));
  }

  const tableOwner = uiTests.match(
    /  func testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards\(\) throws \{[\s\S]*?\n  \}\n\n  @MainActor/
  );
  assert.ok(tableOwner, 'missing solo-table composite audit owner');
  assert.match(
    tableOwner[0],
    /try performSoloAccessibilityAudit\(on: app\)[\s\S]*?assertAuditTargetRemainsForegroundAndTerminate\(/
  );
});

test('the infrastructure reset erases only the exact selected GitHub-hosted simulator', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const resetFunction = extractBashFunction(
    harness,
    'reset_simulator_after_infrastructure_failure'
  );
  const runReset = async (target, runnerEnvironment, githubActions = 'true') => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skyjo-ios-reset-')
    );
    const script = [
      'set -u',
      resetFunction,
      'ui_udids=(selected-udid)',
      'xcrun() { printf "%s\\n" "$*" >> "$TRACE_FILE"; }',
      'reset_simulator_after_infrastructure_failure "$TARGET_UDID"'
    ].join('\n');
    try {
      const result = spawnSync('bash', ['-c', script], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: githubActions,
          RUNNER_ENVIRONMENT: runnerEnvironment,
          TARGET_UDID: target,
          TRACE_FILE: path.join(temporaryDirectory, 'trace')
        }
      });
      let trace = [];
      try {
        trace = (await fs.readFile(path.join(temporaryDirectory, 'trace'), 'utf8'))
          .trim()
          .split('\n');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return { status: result.status, stderr: result.stderr, trace };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  };

  const hosted = await runReset('selected-udid', 'github-hosted');
  assert.equal(hosted.status, 0, hosted.stderr);
  assert.deepEqual(hosted.trace, [
    'simctl shutdown selected-udid',
    'simctl erase selected-udid'
  ]);

  const selfHosted = await runReset('selected-udid', 'self-hosted');
  assert.equal(selfHosted.status, 0, selfHosted.stderr);
  assert.deepEqual(selfHosted.trace, ['simctl shutdown selected-udid']);

  const local = await runReset('selected-udid', 'github-hosted', 'false');
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(local.trace, ['simctl shutdown selected-udid']);

  const unselected = await runReset('another-udid', 'github-hosted');
  assert.equal(unselected.status, 1);
  assert.deepEqual(unselected.trace, []);
  assert.match(unselected.stderr, /Refusing to reset an unselected simulator/);
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
    `run_isolated_ipad_portrait_entry ipad-portrait stub-udid ${ipadPortraitTests.length} "\${tests[@]}"`,
    `[[ "$(wc -l < "$STUB_DIR/invocations")" -eq ${ipadPortraitTests.length} ]]`,
    'test_rows="$(awk -F "\\t" \'$1 == "test" && $2 ~ /^[0-9][0-9]$/ { count += 1 } END { print count + 0 }\' "$evidence_dir/ipad-portrait-isolation.tsv")"',
    `[[ "$test_rows" -eq ${ipadPortraitTests.length} ]]`,
    '[[ "$matrix_status" -eq 1 ]]',
    'printf "all-tests-recorded\\n"'
  ].join('\n');

  try {
    const result = spawnSync('bash', ['-c', stubScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, STUB_DIR: temporaryDirectory }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'all-tests-recorded');
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the isolated portrait retry accepts only a passing classified second attempt', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const scenario = await runIsolatedPortraitScenario(harness, 'eligible');
  assert.equal(scenario.matrixStatus, 0);
  assert.equal(scenario.invocations.length, ipadPortraitTests.length + 1);
  assert.equal(scenario.coldBoots.length, ipadPortraitTests.length + 1);
  assert.equal(scenario.classifications.length, 1);
  assert.equal(scenario.resets.length, 1);
  assert.equal(scenario.mergeInputs.length, ipadPortraitTests.length);
  assert.match(scenario.mergeInputs[0], /-retry-02\.xcresult$/);
  assert.doesNotMatch(
    scenario.mergeInputs.join('\n'),
    new RegExp(`01-${ipadPortraitTests[0]}\\.xcresult`)
  );
  assert.match(scenario.manifest, /^schema-version\t2$/m);
  assert.equal(
    scenario.manifest.match(/^attempt\t[0-9][0-9]\t/mg)?.length,
    ipadPortraitTests.length + 1
  );
  assert.equal(
    scenario.manifest.match(/^test\t[0-9][0-9]\t/mg)?.length,
    ipadPortraitTests.length
  );
  assert.match(
    scenario.manifest,
    new RegExp(`^test\\t01\\t${ipadPortraitTests[0]}\\t0\\t2$`, 'm')
  );
});

test('the isolated portrait retry rejects assertions and fails closed after one retry', async () => {
  const harness = await fs.readFile(uiAccessibilityHarnessPath, 'utf8');
  const assertion = await runIsolatedPortraitScenario(harness, 'assertion');
  assert.equal(assertion.matrixStatus, 65);
  assert.equal(assertion.invocations.length, ipadPortraitTests.length);
  assert.equal(assertion.classifications.length, 1);
  assert.equal(assertion.resets.length, 0);
  assert.equal(assertion.mergeInputs.length, 0);
  assert.match(
    assertion.manifest,
    new RegExp(`^test\\t01\\t${ipadPortraitTests[0]}\\t1\\t0$`, 'm')
  );

  const retryFailure = await runIsolatedPortraitScenario(harness, 'retry-fails');
  assert.equal(retryFailure.matrixStatus, 65);
  assert.equal(retryFailure.invocations.length, ipadPortraitTests.length + 1);
  assert.equal(retryFailure.classifications.length, 1);
  assert.equal(retryFailure.resets.length, 1);
  assert.equal(retryFailure.mergeInputs.length, 0);
  assert.equal(
    retryFailure.invocations.filter((invocation) => invocation.includes('-retry-02')).length,
    1
  );
  assert.match(
    retryFailure.manifest,
    new RegExp(`^test\\t01\\t${ipadPortraitTests[0]}\\t1\\t0$`, 'm')
  );
});

test('the xcresult classifier rejects every audit timeout after category isolation', () => {
  const defaultsAuditTests = ipadPortraitTests.slice(0, 7);
  const blockedAuditTests = ipadPortraitTests.slice(7, 14);
  assert.equal(defaultsAuditTests.length, 7);
  assert.equal(blockedAuditTests.length, 7);
  for (const auditTest of [...defaultsAuditTests, ...blockedAuditTests]) {
    for (const timeoutMinutes of [10, 20]) {
      assert.equal(
        classifyIOSUIInfrastructureFailure(
          failedSummary(
            auditTest,
            `Test exceeded execution time allowance of ${timeoutMinutes} minutes`
          ),
          auditTest
        ),
        null
      );
    }
  }
});

test('the xcresult classifier rejects app termination signatures and weaker evidence', () => {
  const defaultsTest = ipadPortraitTests[0];
  const defaultsAuditTests = ipadPortraitTests.slice(0, 7);
  const blockedAuditTests = ipadPortraitTests.slice(7, 14);
  const recoveryTest = blockedAuditTests[0];
  assert.equal(
    classifyIOSUIInfrastructureFailure(
      failedSummary(defaultsTest, 'XCTAssertTrue failed - clipped text'),
      defaultsTest
    ),
    null
  );
  assert.equal(defaultsAuditTests.length, 7);
  assert.equal(blockedAuditTests.length, 7);
  for (const auditTest of [...defaultsAuditTests, ...blockedAuditTests]) {
    assert.equal(
      classifyIOSUIInfrastructureFailure(
        failedSummary(
          auditTest,
          'failed: caught error: "Error Domain=com.apple.xcode.xctest.accessibilityAudit ' +
            'Code=-51 "Invalid XCUIApplication." UserInfo={NSLocalizedDescription=Invalid XCUIApplication.}"'
        ),
        auditTest
      ),
      null
    );
    assert.equal(
      classifyIOSUIInfrastructureFailure(
        failedSummary(
          auditTest,
          'failed: caught error: "Error Domain=com.apple.accessibilityAudit Code=-902 ' +
            '"Invalid target app 36957" UserInfo={NSLocalizedDescription=Invalid target app 36957}"'
        ),
        auditTest
      ),
      null
    );
  }

  assert.throws(
    () =>
      classifyIOSUIInfrastructureFailure(
        failedSummary(defaultsTest, 'Test exceeded execution time allowance of 10 minutes'),
        recoveryTest
      ),
    /requested pinned test/
  );
  const multipleTests = failedSummary(
    defaultsTest,
    'Test exceeded execution time allowance of 10 minutes'
  );
  multipleTests.totalTestCount = 2;
  multipleTests.failedTests = 2;
  assert.throws(
    () => classifyIOSUIInfrastructureFailure(multipleTests, defaultsTest),
    /one exact failed test/
  );
  const skipped = failedSummary(
    defaultsTest,
    'Test exceeded execution time allowance of 10 minutes'
  );
  skipped.failedTests = 0;
  skipped.skippedTests = 1;
  assert.throws(
    () => classifyIOSUIInfrastructureFailure(skipped, defaultsTest),
    /one exact failed test/
  );
  const wrongDestination = failedSummary(
    defaultsTest,
    'Test exceeded execution time allowance of 10 minutes'
  );
  wrongDestination.devicesAndConfigurations[0].device.platform = 'macOS';
  assert.throws(
    () => classifyIOSUIInfrastructureFailure(wrongDestination, defaultsTest),
    /one failed CI simulator destination/
  );
  const wrongFailureId = failedSummary(
    defaultsTest,
    'Test exceeded execution time allowance of 10 minutes'
  );
  wrongFailureId.testFailures[0].testIdentifier = 2;
  assert.throws(
    () => classifyIOSUIInfrastructureFailure(wrongFailureId, defaultsTest),
    /requested pinned test/
  );
  assert.throws(
    () => classifyIOSUIInfrastructureFailure(null, defaultsTest),
    /summary is invalid/
  );
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
    expectedTestCount: ipadPortraitTests.length,
    testIdentifiers: ipadPortraitTests.map((testName) => `SkyjoAppUITests/${testName}()`),
    deviceConfigurationCount: 1
  });

  const skipped = passingSummary(ipadPortraitTests.length);
  skipped.passedTests = ipadPortraitTests.length - 1;
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

  const secondDestination = passingSummary(
    ipadPortraitTests.length,
    [2, ipadPortraitTests.length - 2]
  );
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

  const secondConfiguration = passingSummary(
    ipadPortraitTests.length,
    [2, ipadPortraitTests.length - 2]
  );
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

  const duplicateMergeCounters = passingSummary(
    ipadPortraitTests.length,
    [ipadPortraitTests.length * 2]
  );
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
