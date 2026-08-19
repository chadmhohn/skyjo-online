import assert from 'node:assert/strict';
import test from 'node:test';

import {
  entitlementSectionRange,
  validateAssociatedDomainsEntitlements
} from '../../scripts/check-ios-associated-domains.mjs';

const exactEntitlements = {
  'application-identifier': 'FAKETEAMID.com.groundworkrevops.skyjo',
  'com.apple.developer.associated-domains': [
    'applinks:skyjo.groundworkrevops.com'
  ]
};

test('the built-product audit accepts only the exact Skyjo applinks domain', () => {
  assert.doesNotThrow(() => validateAssociatedDomainsEntitlements(exactEntitlements));
  for (const invalidValue of [
    {},
    { 'com.apple.developer.associated-domains': 'applinks:skyjo.groundworkrevops.com' },
    { 'com.apple.developer.associated-domains': ['applinks:*.groundworkrevops.com'] },
    {
      'com.apple.developer.associated-domains': [
        'applinks:skyjo.groundworkrevops.com',
        'applinks:example.invalid'
      ]
    }
  ]) {
    assert.throws(
      () => validateAssociatedDomainsEntitlements(invalidValue),
      /Associated Domains array|must contain only/
    );
  }
});

test('the audit resolves exact bounded Mach-O entitlement sections', () => {
  const loadCommands = `
Load command 1
      cmd LC_SEGMENT_64
Section
  sectname __text
   segname __TEXT
      size 0x100
    offset 100
Section
  sectname __entitlements
   segname __TEXT
      addr 0x0000000100001000
      size 0x0000000000000123
    offset 4096
     align 0
Load command 2
      cmd LC_SYMTAB
`;
  assert.deepEqual(entitlementSectionRange(loadCommands), { offset: 4096, size: 0x123 });
  assert.throws(
    () => entitlementSectionRange(loadCommands.replace('__entitlements', '__not_entitlements')),
    /exactly one/
  );
  assert.throws(
    () => entitlementSectionRange(`${loadCommands}\n${loadCommands}`),
    /exactly one/
  );
});
