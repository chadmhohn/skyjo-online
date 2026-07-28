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
