import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const harnessPath = path.join(repositoryRoot, 'scripts', 'ios-build-test.sh');

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
