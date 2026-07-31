#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_RESULT_JSON_BYTES = 16 * 1024 * 1024;
const TEST_NAME_PATTERN = /^test[A-Za-z0-9_]+$/;
const TEST_BUNDLE = 'SkyjoAppUITests';
const TEST_SUITE = 'SkyjoAppUITests';
const TEST_URL_PREFIX = 'test://com.apple.xcode/SkyjoNative';

function fail(message) {
  throw new Error(message);
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function collectTestCases(nodes, output) {
  if (!Array.isArray(nodes)) fail('The test inventory has an invalid node collection.');
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      fail('The test inventory has an invalid node.');
    }
    if (node.nodeType === 'Test Case') output.push(node);
    if (node.children !== undefined) collectTestCases(node.children, output);
  }
}

function expectedTestIdentity(testName) {
  return {
    name: `${testName}()`,
    nodeIdentifier: `${TEST_BUNDLE}/${testName}()`,
    nodeIdentifierURL: `${TEST_URL_PREFIX}/${TEST_BUNDLE}/${TEST_SUITE}/${testName}`
  };
}

function validateExpectedTestName(testName) {
  if (typeof testName !== 'string' || !TEST_NAME_PATTERN.test(testName)) {
    fail('Expected UI test name must be a pinned XCTest identifier.');
  }
}

export function classifyIOSUIInfrastructureFailure(summary, expectedTestName) {
  validateExpectedTestName(expectedTestName);
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('The xcresult summary is invalid.');
  }

  if (
    summary.result !== 'Failed' ||
    requireNonnegativeInteger(summary.totalTestCount, 'summary.totalTestCount') !== 1 ||
    requireNonnegativeInteger(summary.passedTests, 'summary.passedTests') !== 0 ||
    requireNonnegativeInteger(summary.failedTests, 'summary.failedTests') !== 1 ||
    requireNonnegativeInteger(summary.skippedTests, 'summary.skippedTests') !== 0 ||
    requireNonnegativeInteger(summary.expectedFailures, 'summary.expectedFailures') !== 0 ||
    !Array.isArray(summary.testFailures) ||
    summary.testFailures.length !== 1
  ) {
    fail('The xcresult summary does not prove one exact failed test.');
  }

  const configurations = summary.devicesAndConfigurations;
  if (!Array.isArray(configurations) || configurations.length !== 1) {
    fail('The xcresult summary does not prove one exact failed destination.');
  }
  const configuration = configurations[0];
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    requireNonnegativeInteger(configuration.passedTests, 'configuration.passedTests') !== 0 ||
    requireNonnegativeInteger(configuration.failedTests, 'configuration.failedTests') !== 1 ||
    requireNonnegativeInteger(configuration.skippedTests, 'configuration.skippedTests') !== 0 ||
    requireNonnegativeInteger(configuration.expectedFailures, 'configuration.expectedFailures') !== 0 ||
    typeof configuration.device?.deviceId !== 'string' ||
    configuration.device.deviceId.length === 0 ||
    configuration.device.platform !== 'iOS Simulator' ||
    typeof configuration.testPlanConfiguration?.configurationId !== 'string' ||
    configuration.testPlanConfiguration.configurationId.length === 0 ||
    configuration.testPlanConfiguration.configurationName !== 'CI'
  ) {
    fail('The xcresult summary does not identify one failed CI simulator destination.');
  }

  const expected = expectedTestIdentity(expectedTestName);
  const failure = summary.testFailures[0];
  if (
    !failure ||
    typeof failure !== 'object' ||
    Array.isArray(failure) ||
    failure.targetName !== TEST_BUNDLE ||
    failure.testIdentifier !== 1 ||
    failure.testName !== expected.name ||
    failure.testIdentifierString !== expected.nodeIdentifier ||
    failure.testIdentifierURL !== expected.nodeIdentifierURL ||
    typeof failure.failureText !== 'string'
  ) {
    fail('The xcresult failure does not identify the requested pinned test.');
  }

  // Every previously grouped audit owner now runs one category per XCTest
  // child. No timeout, invalid-application, or invalid-target summary is safe
  // to retry because a second attempt can conceal product or process failure.
  return null;
}

export function validateIOSUIXCResult(summary, inventory, expectedTestNames) {
  if (!Array.isArray(expectedTestNames) || expectedTestNames.length === 0) {
    fail('At least one expected UI test is required.');
  }
  if (
    expectedTestNames.some(
      (testName) => typeof testName !== 'string' || !TEST_NAME_PATTERN.test(testName)
    ) ||
    new Set(expectedTestNames).size !== expectedTestNames.length
  ) {
    fail('Expected UI test names must be unique pinned XCTest identifiers.');
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('The xcresult summary is invalid.');
  }
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    fail('The xcresult test inventory is invalid.');
  }

  const expectedCount = expectedTestNames.length;
  if (
    summary.result !== 'Passed' ||
    requireNonnegativeInteger(summary.totalTestCount, 'summary.totalTestCount') !== expectedCount ||
    requireNonnegativeInteger(summary.passedTests, 'summary.passedTests') !== expectedCount ||
    requireNonnegativeInteger(summary.failedTests, 'summary.failedTests') !== 0 ||
    requireNonnegativeInteger(summary.skippedTests, 'summary.skippedTests') !== 0 ||
    requireNonnegativeInteger(summary.expectedFailures, 'summary.expectedFailures') !== 0 ||
    !Array.isArray(summary.testFailures) ||
    summary.testFailures.length !== 0
  ) {
    fail('The xcresult summary does not prove an exact passing test count.');
  }

  const configurations = summary.devicesAndConfigurations;
  if (!Array.isArray(configurations) || configurations.length === 0) {
    fail('The xcresult summary does not contain a device configuration.');
  }
  let configurationPassed = 0;
  const configurationDeviceIds = new Set();
  const configurationIds = new Set();
  const configurationNames = new Set();
  for (const configuration of configurations) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      fail('The xcresult summary contains an invalid device configuration.');
    }
    configurationPassed += requireNonnegativeInteger(
      configuration.passedTests,
      'configuration.passedTests'
    );
    if (
      requireNonnegativeInteger(configuration.failedTests, 'configuration.failedTests') !== 0 ||
      requireNonnegativeInteger(configuration.skippedTests, 'configuration.skippedTests') !== 0 ||
      requireNonnegativeInteger(configuration.expectedFailures, 'configuration.expectedFailures') !== 0
    ) {
      fail('A device configuration contains a failed, skipped, or expected-failure test.');
    }
    const deviceId = configuration.device?.deviceId;
    const configurationId = configuration.testPlanConfiguration?.configurationId;
    const configurationName = configuration.testPlanConfiguration?.configurationName;
    if (
      typeof deviceId !== 'string' ||
      deviceId.length === 0 ||
      typeof configurationId !== 'string' ||
      configurationId.length === 0 ||
      configurationName !== 'CI'
    ) {
      fail('A device configuration does not identify the pinned CI destination.');
    }
    configurationDeviceIds.add(deviceId);
    configurationIds.add(configurationId);
    configurationNames.add(configurationName);
  }
  if (
    configurationPassed !== expectedCount ||
    configurationDeviceIds.size !== 1 ||
    configurationIds.size !== 1 ||
    configurationNames.size !== 1
  ) {
    fail('The xcresult configurations do not prove one exact destination and test plan.');
  }

  if (!Array.isArray(inventory.devices) || inventory.devices.length === 0) {
    fail('The xcresult inventory does not contain a device.');
  }
  const inventoryDeviceIds = new Set(
    inventory.devices.map((device) => {
      if (!device || typeof device.deviceId !== 'string' || device.deviceId.length === 0) {
        fail('The xcresult inventory contains an invalid device.');
      }
      return device.deviceId;
    })
  );
  if (inventoryDeviceIds.size !== 1) {
    fail('The xcresult inventory contains more than one destination.');
  }
  const planConfigurations = inventory.testPlanConfigurations;
  if (!Array.isArray(planConfigurations) || planConfigurations.length === 0) {
    fail('The xcresult inventory does not contain a test-plan configuration.');
  }
  const inventoryConfigurationIds = new Set();
  for (const configuration of planConfigurations) {
    if (
      !configuration ||
      typeof configuration.configurationId !== 'string' ||
      configuration.configurationId.length === 0 ||
      configuration.configurationName !== 'CI'
    ) {
      fail('The xcresult inventory contains an invalid test-plan configuration.');
    }
    inventoryConfigurationIds.add(configuration.configurationId);
  }
  if (
    inventoryConfigurationIds.size !== 1 ||
    !inventoryDeviceIds.has(configurationDeviceIds.values().next().value) ||
    !inventoryConfigurationIds.has(configurationIds.values().next().value)
  ) {
    fail('The xcresult summary and inventory identify different destinations or test plans.');
  }

  const testCases = [];
  collectTestCases(inventory.testNodes, testCases);
  if (testCases.length !== expectedCount) {
    fail('The xcresult inventory does not contain the exact expected test count.');
  }
  const actualByIdentifier = new Map();
  for (const testCase of testCases) {
    if (
      typeof testCase.nodeIdentifier !== 'string' ||
      actualByIdentifier.has(testCase.nodeIdentifier)
    ) {
      fail('The xcresult inventory contains a missing or duplicate test identifier.');
    }
    actualByIdentifier.set(testCase.nodeIdentifier, testCase);
  }

  const normalizedTests = expectedTestNames.map((testName) => {
    const expected = expectedTestIdentity(testName);
    const actual = actualByIdentifier.get(expected.nodeIdentifier);
    if (
      !actual ||
      actual.name !== expected.name ||
      actual.nodeIdentifierURL !== expected.nodeIdentifierURL ||
      actual.result !== 'Passed'
    ) {
      fail(`The xcresult inventory did not prove the pinned test ${testName}.`);
    }
    return expected.nodeIdentifier;
  });

  return {
    schemaVersion: 1,
    result: 'Passed',
    expectedTestCount: expectedCount,
    testIdentifiers: normalizedTests,
    deviceConfigurationCount: configurations.length
  };
}

function readBoundedJSON(filePath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    if (!fs.fstatSync(descriptor).isFile()) {
      fail(`${label} JSON is missing or outside the allowed size.`);
    }

    const boundedContents = Buffer.allocUnsafe(MAX_RESULT_JSON_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < boundedContents.length) {
      const readCount = fs.readSync(
        descriptor,
        boundedContents,
        bytesRead,
        boundedContents.length - bytesRead,
        null
      );
      if (readCount === 0) break;
      bytesRead += readCount;
    }
    if (bytesRead === 0 || bytesRead > MAX_RESULT_JSON_BYTES) {
      fail(`${label} JSON is missing or outside the allowed size.`);
    }
    return JSON.parse(boundedContents.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`Unable to read ${label} JSON.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === '--classify-infrastructure-failure') {
    const [, summaryPath, expectedTestName, ...unexpectedArguments] = arguments_;
    if (!summaryPath || !expectedTestName || unexpectedArguments.length !== 0) {
      fail(
        'Usage: node scripts/verify-ios-ui-xcresult.mjs --classify-infrastructure-failure <summary.json> <test-name>'
      );
    }
    const proof = classifyIOSUIInfrastructureFailure(
      readBoundedJSON(summaryPath, 'summary'),
      expectedTestName
    );
    if (!proof) fail('The xcresult failure is not an allowlisted accessibility infrastructure failure.');
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    return;
  }

  const [summaryPath, inventoryPath, ...expectedTestNames] = arguments_;
  if (!summaryPath || !inventoryPath || expectedTestNames.length === 0) {
    fail(
      'Usage: node scripts/verify-ios-ui-xcresult.mjs <summary.json> <tests.json> <test-name> [...]'
    );
  }
  const proof = validateIOSUIXCResult(
    readBoundedJSON(summaryPath, 'summary'),
    readBoundedJSON(inventoryPath, 'test inventory'),
    expectedTestNames
  );
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown verification failure.';
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  }
}
