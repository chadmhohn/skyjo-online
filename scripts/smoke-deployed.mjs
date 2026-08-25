import { runDeployedSmoke } from './deployed-smoke-lib.mjs';
import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs';
import { resolveAppleApplicationIdentifier } from '../server-room-invites.mjs';
import { fileURLToPath } from 'node:url';

const configuredProtocolVersion = process.env.SKYJO_EXPECTED_PROTOCOL_VERSION;
const accountSetup = process.env.SKYJO_SMOKE_ACCOUNT_SETUP || 'existing';
if (accountSetup !== 'existing' && accountSetup !== 'signup') {
  throw new Error('SKYJO_SMOKE_ACCOUNT_SETUP must be existing or signup.');
}
const expectedAPNSNotificationsEnabled = [
  process.env.SKYJO_APNS_TEAM_ID,
  process.env.SKYJO_APNS_KEY_ID,
  process.env.SKYJO_APNS_PRIVATE_KEY_FILE,
  process.env.SKYJO_APNS_TOKEN_KEY_FILE
].every((value) => String(value || '').trim().length > 0);

const result = await runDeployedSmoke({
  baseUrl: process.env.SKYJO_SMOKE_BASE_URL,
  accountEmail: process.env.SKYJO_SMOKE_ACCOUNT_EMAIL || process.env.SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL,
  accountPassword: process.env.SKYJO_SMOKE_ACCOUNT_PASSWORD || process.env.SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD,
  createAccount: accountSetup === 'signup',
  expectedAppleApplicationIdentifier: resolveAppleApplicationIdentifier({
    value: process.env.SKYJO_APPLE_APPLICATION_IDENTIFIER,
    nodeEnv: process.env.NODE_ENV,
    canaryReleaseDirectory: process.env.SKYJO_CANARY_RELEASE_DIR,
    runtimeDirectory: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  }),
  expectedAPNSNotificationsEnabled,
  expectedReleaseSha: process.env.SKYJO_EXPECTED_RELEASE_SHA || process.env.SKYJO_SMOKE_RELEASE_SHA || undefined,
  expectedProtocolVersion: configuredProtocolVersion === undefined
    ? CURRENT_PROTOCOL_VERSION
    : Number(configuredProtocolVersion)
});

console.log(`Deployed smoke passed for release ${result.releaseSha}.`);
