import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePrivateIdentityGroups } from '../release-controller.mjs';

const identities = {
  skyjo: { gid: 901 },
  'skyjo-canary': { gid: 902 },
  'skyjo-deploy': { gid: 903 }
};
const passwd = [
  'root:x:0:0:root:/root:/bin/bash',
  'skyjo:x:901:901::/var/lib/skyjo-online:/usr/sbin/nologin',
  'skyjo-canary:x:902:902::/var/empty/skyjo-canary:/usr/sbin/nologin',
  'skyjo-deploy:x:903:903::/var/lib/skyjo-deploy:/bin/sh'
].join('\n');

test('private runtime primary groups are distinct and unaliased', () => {
  assert.doesNotThrow(() => validatePrivateIdentityGroups(identities, `${passwd}\n`));
  assert.throws(() => validatePrivateIdentityGroups({ ...identities, 'skyjo-deploy': { gid: 902 } }, `${passwd}\n`), /distinct/i);
  assert.throws(() => validatePrivateIdentityGroups(identities, `${passwd}\nunrelated:x:950:903::/home/unrelated:/bin/sh\n`), /shared/i);
});
