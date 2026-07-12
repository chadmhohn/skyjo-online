import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEffectiveSystemdProperties } from '../release-controller.mjs';

const expected = new Map([
  ['FragmentPath', '/etc/systemd/system/skyjo-online-canary@.service'],
  ['DropInPaths', ''],
  ['User', 'skyjo-canary'],
  ['Group', 'skyjo-canary'],
  ['NoNewPrivileges', 'yes'],
  ['ProtectSystem', 'strict']
]);

test('effective systemd validation rejects drop-ins and privilege drift', () => {
  assert.doesNotThrow(() => validateEffectiveSystemdProperties('canary', new Map(expected), expected));
  for (const [property, value] of [
    ['DropInPaths', '/etc/systemd/system/skyjo-online-canary@.service.d/override.conf'],
    ['User', 'root'],
    ['NoNewPrivileges', 'no'],
    ['ProtectSystem', 'no']
  ]) {
    const actual = new Map(expected);
    actual.set(property, value);
    assert.throws(() => validateEffectiveSystemdProperties('canary', actual, expected), new RegExp(property));
  }
});
