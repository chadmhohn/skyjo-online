import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  RELEASE_FORMAT_VERSION,
  writeReleaseIdentity
} from '../server-release.mjs';

function resolveReleaseSha() {
  const configured = process.env.SKYJO_RELEASE_SHA || process.env.GITHUB_SHA;
  if (configured) return configured;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'development';
  }
}

function resolveBuildTimestamp() {
  if (process.env.SKYJO_BUILD_TIMESTAMP) return process.env.SKYJO_BUILD_TIMESTAMP;
  if (process.env.SOURCE_DATE_EPOCH) {
    const seconds = Number(process.env.SOURCE_DATE_EPOCH);
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

const identity = await writeReleaseIdentity(path.resolve('dist'), {
  formatVersion: RELEASE_FORMAT_VERSION,
  releaseSha: resolveReleaseSha(),
  buildTimestamp: resolveBuildTimestamp(),
  schemaVersion: CURRENT_SCHEMA_VERSION,
  protocolVersion: CURRENT_PROTOCOL_VERSION
});

console.log(`Wrote release identity ${identity.releaseSha} (schema ${identity.schemaVersion}, protocol ${identity.protocolVersion}).`);
