import { runDeployedSmoke } from './deployed-smoke-lib.mjs';
import { CURRENT_PROTOCOL_VERSION } from '../server-release.mjs';

const configuredProtocolVersion = process.env.SKYJO_EXPECTED_PROTOCOL_VERSION;

const result = await runDeployedSmoke({
  baseUrl: process.env.SKYJO_SMOKE_BASE_URL,
  accessPassword: process.env.SKYJO_SMOKE_ACCESS_PASSWORD || process.env.SKYJO_ACCESS_PASSWORD,
  accountEmail: process.env.SKYJO_SMOKE_ACCOUNT_EMAIL || process.env.SKYJO_DEPLOY_SMOKE_ACCOUNT_EMAIL,
  accountPassword: process.env.SKYJO_SMOKE_ACCOUNT_PASSWORD || process.env.SKYJO_DEPLOY_SMOKE_ACCOUNT_PASSWORD,
  expectedReleaseSha: process.env.SKYJO_EXPECTED_RELEASE_SHA || process.env.SKYJO_SMOKE_RELEASE_SHA || undefined,
  expectedProtocolVersion: configuredProtocolVersion === undefined
    ? CURRENT_PROTOCOL_VERSION
    : Number(configuredProtocolVersion)
});

console.log(`Deployed smoke passed for release ${result.releaseSha}.`);
