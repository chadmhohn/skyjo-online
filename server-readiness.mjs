import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION
} from './server-release.mjs';

function checkState(value) {
  return value === true || value === 'ok' ? 'ok' : 'error';
}

export function createReadinessResult({ releaseIdentity, databaseReady, roomState, lastPersist }) {
  const checks = {
    database: checkState(databaseReady),
    roomState: checkState(roomState),
    lastPersist: checkState(lastPersist)
  };
  const releaseReady = Boolean(releaseIdentity);
  const ready = releaseReady && Object.values(checks).every((value) => value === 'ok');
  return {
    statusCode: ready ? 200 : 503,
    payload: {
      status: ready ? 'ready' : 'not_ready',
      releaseSha: releaseIdentity?.releaseSha || null,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      checks
    }
  };
}

export function createVersionResult(releaseIdentity) {
  if (!releaseIdentity) {
    return {
      statusCode: 503,
      payload: { status: 'unavailable' }
    };
  }
  return {
    statusCode: 200,
    payload: {
      releaseSha: releaseIdentity.releaseSha,
      buildTimestamp: releaseIdentity.buildTimestamp,
      protocolVersion: releaseIdentity.protocolVersion
    }
  };
}
