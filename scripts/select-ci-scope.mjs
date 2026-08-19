#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const NATIVE_PATH_PREFIXES = [
  'ios/',
  'contracts/',
  'scripts/ios-',
  'scripts/select-ios-',
  'scripts/verify-ios-',
];

const NATIVE_PATHS = new Set([
  '.github/workflows/ci.yml',
  'scripts/select-ci-scope.mjs',
]);

const UI_PATH_PREFIXES = ['ios/'];
const UI_PATHS = new Set([
  '.github/workflows/ci.yml',
  'scripts/ios-simulator-accessibility.c',
  'scripts/ios-ui-accessibility-test.sh',
  'scripts/select-ios-ui-simulators.mjs',
  'scripts/select-ci-scope.mjs',
  'scripts/verify-ios-ui-xcresult.mjs',
]);

const FULL_UI_ROLES = [
  'standard-phone',
  'large-phone',
  'ipad-portrait',
  'ipad-landscape',
];

function isValidPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

function matchesPath(path, exact, prefixes) {
  return exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

function isDocumentationPath(path) {
  return path.endsWith('.md');
}

export function selectCIScope({ eventName, refType, requestedUIMode, changedPaths }) {
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error(`Unsupported GitHub event: ${eventName}`);
  }
  if (!['branch', 'tag'].includes(refType)) {
    throw new Error(`Unsupported Git ref type: ${refType}`);
  }
  if (!['auto', 'skip', 'smoke', 'full'].includes(requestedUIMode)) {
    throw new Error(`Unsupported iOS UI mode: ${requestedUIMode}`);
  }
  if (!Array.isArray(changedPaths) || changedPaths.some((path) => !isValidPath(path))) {
    throw new Error('Changed paths must be safe repository-relative paths.');
  }

  if (refType === 'tag') {
    return {
      runNative: false,
      uiMode: 'skip',
      uiRoles: ['standard-phone'],
      reason: 'release tag reuses the exact protected-main native result',
    };
  }

  if (eventName === 'workflow_dispatch') {
    if (requestedUIMode === 'auto') {
      throw new Error('Manual CI runs must select skip, smoke, or full iOS UI coverage.');
    }
    if (requestedUIMode === 'skip') {
      return {
        runNative: false,
        uiMode: 'skip',
        uiRoles: ['standard-phone'],
        reason: 'manual run explicitly skipped native coverage',
      };
    }
    return {
      runNative: true,
      uiMode: requestedUIMode,
      uiRoles: requestedUIMode === 'full' ? FULL_UI_ROLES : ['standard-phone'],
      reason: `manual ${requestedUIMode} native coverage`,
    };
  }

  if (requestedUIMode !== 'auto') {
    throw new Error('Pull-request and branch-push scope must be automatic.');
  }

  const runNative = changedPaths.some(
    (path) => !isDocumentationPath(path) && matchesPath(path, NATIVE_PATHS, NATIVE_PATH_PREFIXES)
  );
  const runUISmoke = changedPaths.some(
    (path) => !isDocumentationPath(path) && matchesPath(path, UI_PATHS, UI_PATH_PREFIXES)
  );

  return {
    runNative,
    uiMode: runUISmoke ? 'smoke' : 'skip',
    uiRoles: ['standard-phone'],
    reason: runNative
      ? runUISmoke
        ? 'native UI paths changed'
        : 'native contracts or tooling changed without UI paths'
      : 'no native paths changed',
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') {
      result.selfTest = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    result[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function readNullDelimitedPaths(path) {
  const contents = fs.readFileSync(path);
  const parts = contents.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function runSelfTest() {
  assert.deepEqual(
    selectCIScope({
      eventName: 'pull_request',
      refType: 'branch',
      requestedUIMode: 'auto',
      changedPaths: ['docs/releases/v0.3.4-certification.md'],
    }),
    {
      runNative: false,
      uiMode: 'skip',
      uiRoles: ['standard-phone'],
      reason: 'no native paths changed',
    }
  );
  assert.equal(
    selectCIScope({
      eventName: 'pull_request',
      refType: 'branch',
      requestedUIMode: 'auto',
      changedPaths: ['ios/SkyjoApp/App/AppModel.swift'],
    }).uiMode,
    'smoke'
  );
  assert.equal(
    selectCIScope({
      eventName: 'pull_request',
      refType: 'branch',
      requestedUIMode: 'auto',
      changedPaths: ['ios/README.md'],
    }).runNative,
    false
  );
  assert.deepEqual(
    selectCIScope({
      eventName: 'workflow_dispatch',
      refType: 'branch',
      requestedUIMode: 'full',
      changedPaths: [],
    }).uiRoles,
    FULL_UI_ROLES
  );
  assert.equal(
    selectCIScope({
      eventName: 'push',
      refType: 'tag',
      requestedUIMode: 'auto',
      changedPaths: ['ios/SkyjoApp/App/AppModel.swift'],
    }).runNative,
    false
  );
  console.log('CI scope self-test passed.');
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  for (const required of ['event', 'ref-type', 'ui-mode', 'paths0-file']) {
    if (typeof args[required] !== 'string') {
      throw new Error(`Missing --${required}.`);
    }
  }
  const scope = selectCIScope({
    eventName: args.event,
    refType: args['ref-type'],
    requestedUIMode: args['ui-mode'],
    changedPaths: readNullDelimitedPaths(args['paths0-file']),
  });
  process.stdout.write(`run-native=${scope.runNative}\n`);
  process.stdout.write(`ui-mode=${scope.uiMode}\n`);
  process.stdout.write(`ui-roles=${JSON.stringify(scope.uiRoles)}\n`);
  process.stdout.write(`reason=${scope.reason}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
