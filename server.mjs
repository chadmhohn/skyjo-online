import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';
import { WebSocketServer } from 'ws';
import {
  createInitialRoomState,
  createNextRoundRoomState
} from './server-dist/serverValidation.js';
import {
  broadcastRealtimeSnapshots,
  hasVisibleLiveClient,
  REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES,
  registerRealtimeServer,
  sendRealtimeJson,
  syncPlayerPresence
} from './server-dist/serverRealtime.js';
import {
  createProtocolV2MessageHandler,
  createResetAliasIndex,
  isResetAliasCodeReserved
} from './server-dist/serverProtocolV2.js';
import {
  ACTIVE_PLAYER_GRACE_MS,
  createRoomLifecycleScheduler,
  dueHostTransfer,
  hostFlags,
  markPlayersDisconnectedForShutdown,
  reclaimAiSeat,
  WAITING_HOST_TRANSFER_MS
} from './server-dist/serverRoomLifecycle.js';
import {
  createGameStateSnapshotProjector,
  createRoomSnapshot,
  MULTIPLAYER_PROTOCOL_VERSION
} from './server-dist/protocolV2.js';
import { wellFormedUTF16Prefix } from './server-unicode.mjs';
import {
  loadRoomsSnapshotFromDisk,
  reconcileCompletedRoomJournals,
  resolveRoomsFilePath,
  ROOM_STALE_MS,
  saveRoomsToDisk
} from './server-room-persistence.mjs';
import { normalizePersistedGameState } from './server-game-state-validation.mjs';
import {
  createAccountStore,
  createUniqueRandomCode,
  PublicApiError,
  publicApiErrorResponse,
  resolveAccountDatabasePath
} from './server-account-store.mjs';
import {
  cleanInviteInstallCode,
  createInviteRedemptionRateLimiter,
  createPersistentInviteInstallCode,
  hashInviteInstallCode
} from './server-invite-codes.mjs';
import {
  createAppleAppSiteAssociation,
  createRoomInviteToken as createSignedRoomInviteToken,
  inviteMatchesRoom,
  isRoomInviteToken,
  parseRoomInviteToken,
  resolveAppleApplicationIdentifier
} from './server-room-invites.mjs';
import { createPersistenceHealthTracker } from './server-persistence-health.mjs';
import {
  createWebPushDeliveryDiagnostic,
  deliverWebPushNotifications,
  resolveWebPushConfiguration
} from './server-push.mjs';
import { createReadinessResult, createVersionResult } from './server-readiness.mjs';
import { loadReleaseIdentity, releaseValidationOptionsForEnvironment } from './server-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
const accessPassword = process.env.SKYJO_ACCESS_PASSWORD;
const sessionSecret = process.env.SKYJO_SESSION_SECRET;
const inviteSecret = process.env.SKYJO_INVITE_SECRET || sessionSecret;
const cookieName = process.env.SKYJO_COOKIE_NAME || 'skyjo_session';
const sessionTtlMs = Number(process.env.SKYJO_SESSION_TTL_HOURS || 24 * 14) * 60 * 60 * 1000;
const inviteTtlMs = Number(process.env.SKYJO_INVITE_TTL_HOURS || 24 * 7) * 60 * 60 * 1000;
const inviteCodeTtlMs = Number(process.env.SKYJO_INVITE_CODE_TTL_MINUTES || 30) * 60 * 1000;
const accountCookieName = process.env.SKYJO_ACCOUNT_COOKIE_NAME || 'skyjo_account';
const accountSessionTtlMs = Number(process.env.SKYJO_ACCOUNT_SESSION_TTL_HOURS || 24 * 14) * 60 * 60 * 1000;
const adminEmail = process.env.SKYJO_ADMIN_EMAIL || 'chad.hohn@groundworkrevops.com';
const adminInitialPassword = process.env.SKYJO_ADMIN_INITIAL_PASSWORD || '';
const secureCookies = process.env.SKYJO_SECURE_COOKIES !== 'false';
const trustProxyClientIp = process.env.SKYJO_TRUST_PROXY_CLIENT_IP === 'true';
const testPwaVariantsEnabled = process.env.NODE_ENV === 'test' && process.env.SKYJO_TEST_PWA_VARIANTS === 'true';
const testPwaNetworkFaultsEnabled = process.env.NODE_ENV === 'test' && process.env.SKYJO_TEST_PWA_NETWORK_FAULTS === 'true';
// One fixed pre-click clock leaves a 500ms diagnostic margin inside the product's 8s deadline.
const testPwaActivationBarrierDeadlineMs = 7_500;
const testPwaActivationBarrierLifetimeMs = 30_000;
const testPwaActivationBarrierMaxRuns = 16;
const testPwaWorkerLeaseLifetimeMs = 30_000;
const testPwaActivationBarriers = new Map();
let testPwaWorkerLease = null;
const vapidPublicKeyEnvironment = process.env.SKYJO_VAPID_PUBLIC_KEY || '';
const vapidPrivateKeyEnvironment = process.env.SKYJO_VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.SKYJO_VAPID_SUBJECT || `mailto:${adminEmail}`;
const rooms = new Map();
const roomsFile = resolveRoomsFilePath();
const accountDatabaseFile = resolveAccountDatabasePath();
const databaseRetryDelayMs = Math.max(100, Number(process.env.SKYJO_DATABASE_RETRY_MS || 5000));
const roomsSaveDebounceMs = 250;
const maxRoomChatMessages = 80;
const maxRoomChatMessageLength = 280;
const maxAccessPasswordLength = 4096;
const inviteCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCodeLength = 5;
const secureCodeMaxAttempts = 128;
const lifecyclePolicy = Object.freeze({
  activePlayerGraceMs: positiveDurationFromEnvironment('SKYJO_ACTIVE_PLAYER_GRACE_MS', ACTIVE_PLAYER_GRACE_MS),
  waitingHostTransferMs: positiveDurationFromEnvironment('SKYJO_WAITING_HOST_TRANSFER_MS', WAITING_HOST_TRANSFER_MS)
});
const lifecycleTickMs = positiveDurationFromEnvironment('SKYJO_LIFECYCLE_TICK_MS', 250);
const aiActionDelayMs = positiveDurationFromEnvironment('SKYJO_AI_ACTION_DELAY_MS', 650, true);
const inviteRedemptionRateLimiter = createInviteRedemptionRateLimiter();
const nativeInviteRedemptionRateLimiter = createInviteRedemptionRateLimiter();
let roomsSaveTimer = null;
let roomsSaveQueue = Promise.resolve();
let shuttingDown = false;
let accountStore = null;
let nextDatabaseRetryAt = 0;
let databaseFailureLogged = false;
let releaseIdentity = null;
let appleAppSiteAssociation = null;

function positiveDurationFromEnvironment(name, fallback, allowZero = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 10 * 60 * 1000) {
    throw new Error(`${name} must be an integer between ${minimum} and 600000.`);
  }
  return value;
}
let roomPersistenceLoadAccepted = false;
let roomCompletionRecoveryPending = false;
const roomPersistenceHealth = createPersistenceHealthTracker();

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);

const accessPasswordLength = typeof accessPassword === 'string' ? [...accessPassword].length : 0;
if (
  accessPasswordLength < 1 ||
  accessPasswordLength > maxAccessPasswordLength ||
  !sessionSecret ||
  typeof inviteSecret !== 'string' ||
  inviteSecret.length < 16
) {
  console.error('Skyjo authentication secrets are missing or invalid.');
  console.error('Set the access, session, and invite secrets before running npm start.');
  process.exit(1);
}

try {
  const appleApplicationIdentifier = resolveAppleApplicationIdentifier({
    value: process.env.SKYJO_APPLE_APPLICATION_IDENTIFIER,
    nodeEnv: process.env.NODE_ENV,
    canaryReleaseDirectory: process.env.SKYJO_CANARY_RELEASE_DIR,
    runtimeDirectory: import.meta.dirname
  });
  appleAppSiteAssociation = JSON.stringify(createAppleAppSiteAssociation(appleApplicationIdentifier));
} catch {
  console.error('Apple application identifier configuration is missing or invalid.');
  console.error('Set SKYJO_APPLE_APPLICATION_IDENTIFIER to the complete application identifier before production startup.');
  process.exit(1);
}

let webPushConfiguration;
try {
  webPushConfiguration = resolveWebPushConfiguration({
    publicKey: vapidPublicKeyEnvironment,
    privateKey: vapidPrivateKeyEnvironment,
    subject: vapidSubject
  });
  if (webPushConfiguration.enabled) {
    webPush.setVapidDetails(
      webPushConfiguration.subject,
      webPushConfiguration.publicKey,
      webPushConfiguration.privateKey
    );
  } else {
    console.warn('Web Push is disabled. Set SKYJO_VAPID_PUBLIC_KEY and SKYJO_VAPID_PRIVATE_KEY to enable notifications.');
  }
} catch (error) {
  console.error(`Web Push configuration is invalid: ${error instanceof Error ? error.message : 'validation failed.'}`);
  process.exit(1);
}
const pushNotificationsEnabled = webPushConfiguration.enabled;

try {
  releaseIdentity = await loadReleaseIdentity(distDir, releaseValidationOptionsForEnvironment(process.env.NODE_ENV));
} catch {
  console.error('Release identity validation failed; readiness and version endpoints will remain unavailable.');
}

async function ensureAccountStore({ force = false } = {}) {
  if (accountStore?.checkReadiness()) return accountStore;
  accountStore?.close();
  accountStore = null;

  const timestamp = Date.now();
  if (!force && timestamp < nextDatabaseRetryAt) return null;
  nextDatabaseRetryAt = timestamp + databaseRetryDelayMs;

  let candidate = null;
  try {
    candidate = await createAccountStore({ filePath: accountDatabaseFile });
    const bootstrappedAdmin = await candidate.bootstrapAdmin({ email: adminEmail, password: adminInitialPassword });
    if (bootstrappedAdmin) {
      console.log(`Admin account ready for ${bootstrappedAdmin.email}`);
    } else {
      console.warn('No admin account was bootstrapped. Set SKYJO_ADMIN_INITIAL_PASSWORD before first production account setup.');
    }
    if (roomPersistenceLoadAccepted) {
      const reconciled = reconcileCompletedRoomJournals(
        rooms,
        (sourceKey) => candidate.getCompletedGameJournalBySourceKey(sourceKey)
      );
      if (reconciled > 0) roomCompletionRecoveryPending = true;
      if (roomCompletionRecoveryPending) {
        await roomPersistenceHealth.track(() => saveRoomsToDisk(rooms, roomsFile));
        roomCompletionRecoveryPending = false;
      }
    }
    accountStore = candidate;
    databaseFailureLogged = false;
    return accountStore;
  } catch {
    candidate?.close();
    if (!databaseFailureLogged) {
      console.error('Account database is unavailable; the service is running in health-only mode.');
      databaseFailureLogged = true;
    }
    return null;
  }
}

await ensureAccountStore({ force: true });

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSessionCookie() {
  const expiresAt = Date.now() + sessionTtlMs;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
    } catch {
      cookies.delete(rawName);
    }
  }
  return cookies;
}

function hasValidSession(req) {
  const token = parseCookies(req.headers.cookie).get(cookieName);
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiresAtRaw, nonce, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !nonce) return false;

  const payload = `${expiresAtRaw}.${nonce}`;
  return timingSafeEqualString(signature, sign(payload));
}

function cookieHeader(value, maxAgeSeconds) {
  const secure = secureCookies ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function accountCookieHeader(value, maxAgeSeconds) {
  const secure = secureCookies ? '; Secure' : '';
  return `${accountCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function accountToken(req) {
  return parseCookies(req.headers.cookie).get(accountCookieName) || '';
}

function isPublicPwaAsset(pathname) {
  return pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/offline.html' ||
    /^\/skyjo-icon(?:-v2)?(?:-(?:180|192|512))?\.(?:png|svg)$/.test(pathname) ||
    /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(pathname) ||
    /^\/audio\/[A-Za-z0-9_.-]+\.mp3$/.test(pathname);
}

function currentAccountUser(req) {
  const token = accountToken(req);
  if (!token || !accountStore) return null;
  try {
    return accountStore.getUserBySessionToken(token);
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function sendJsonResponse(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function validTestPwaActivationBarrierToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
}

function validTestPwaWorkerVariant(value) {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'E';
}

function validTestPwaWorkerBuildNonce(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
}

function validTestPwaWorkerInstanceNonce(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function clearTestPwaWorkerLease(token = null) {
  const lease = testPwaWorkerLease;
  if (!lease || (token !== null && lease.token !== token)) return false;
  clearTimeout(lease.expiryTimer);
  if (testPwaWorkerLease === lease) testPwaWorkerLease = null;
  return true;
}

function activeTestPwaWorkerLease() {
  const lease = testPwaWorkerLease;
  if (lease && Date.now() >= lease.expiresAt) {
    clearTestPwaWorkerLease(lease.token);
    return null;
  }
  return lease;
}

function installTestPwaWorkerLease({
  token,
  variant,
  workerBuildNonce,
  releasedDBuildNonce,
  reservedBuildNonces
}) {
  const priorLease = testPwaWorkerLease;
  if (priorLease) clearTimeout(priorLease.expiryTimer);
  const lease = {
    activationBarrierToken: token,
    expiresAt: Date.now() + testPwaWorkerLeaseLifetimeMs,
    expiryTimer: null,
    releasedDBuildNonce,
    reservedBuildNonces: new Set(reservedBuildNonces),
    token,
    variant,
    workerBuildNonce
  };
  lease.expiryTimer = setTimeout(() => {
    if (testPwaWorkerLease === lease) clearTestPwaWorkerLease(token);
  }, testPwaWorkerLeaseLifetimeMs);
  lease.expiryTimer.unref?.();
  testPwaWorkerLease = lease;
  return lease;
}

function exactTestPwaWorkerSequence(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function validTestPwaWorkerBarrierIdentities(barrier, expectedVariants) {
  if (
    barrier.expectedWorkerBuildNonces.size !== expectedVariants.length ||
    barrier.workers.size !== expectedVariants.length
  ) return false;
  const seenBuildNonces = new Set();
  for (const variant of expectedVariants) {
    const expectedBuildNonce = barrier.expectedWorkerBuildNonces.get(variant);
    const worker = barrier.workers.get(variant);
    if (
      !validTestPwaWorkerBuildNonce(expectedBuildNonce) ||
      !worker ||
      worker.buildNonce !== expectedBuildNonce ||
      seenBuildNonces.has(expectedBuildNonce)
    ) return false;
    seenBuildNonces.add(expectedBuildNonce);
  }
  return true;
}

function armTestPwaWorkerLeaseForReleasedD(token, barrier) {
  const expectedVariants = ['B', 'C', 'D'];
  const workerD = barrier.workers.get('D');
  if (
    activeTestPwaWorkerLease() ||
    barrier.token !== token ||
    barrier.poisoned ||
    barrier.deadlineAt === null ||
    barrier.step !== 5 ||
    !exactTestPwaWorkerSequence(barrier.arrivals, expectedVariants) ||
    !exactTestPwaWorkerSequence(barrier.releases, ['B', 'C']) ||
    !validTestPwaWorkerBarrierIdentities(barrier, expectedVariants) ||
    !barrier.workers.get('B').released ||
    !barrier.workers.get('C').released ||
    workerD.released
  ) return null;

  return installTestPwaWorkerLease({
    token,
    variant: 'D',
    workerBuildNonce: workerD.buildNonce,
    releasedDBuildNonce: workerD.buildNonce,
    reservedBuildNonces: barrier.expectedWorkerBuildNonces.values()
  });
}

function completedTestPwaWorkerBarrierMatchesLease(token, barrier, lease) {
  const expectedVariants = ['B', 'C', 'D'];
  return (
    barrier.token === token &&
    !barrier.poisoned &&
    barrier.deadlineAt !== null &&
    barrier.step === 6 &&
    exactTestPwaWorkerSequence(barrier.arrivals, expectedVariants) &&
    exactTestPwaWorkerSequence(barrier.releases, expectedVariants) &&
    validTestPwaWorkerBarrierIdentities(barrier, expectedVariants) &&
    expectedVariants.every((variant) => barrier.workers.get(variant).released) &&
    barrier.workers.get('D').buildNonce === lease.releasedDBuildNonce
  );
}

function switchTestPwaWorkerLeaseToE(token, workerBuildNonce, barrier = null) {
  const lease = activeTestPwaWorkerLease();
  if (
    !lease ||
    lease.token !== token ||
    !validTestPwaWorkerBuildNonce(workerBuildNonce) ||
    lease.reservedBuildNonces.has(workerBuildNonce)
  ) return null;
  if (barrier && !completedTestPwaWorkerBarrierMatchesLease(token, barrier, lease)) {
    clearTestPwaWorkerLease(token);
    return null;
  }
  if (lease.variant === 'E') {
    return lease.workerBuildNonce === workerBuildNonce ? lease : null;
  }
  if (lease.variant !== 'D') return null;
  return installTestPwaWorkerLease({
    token,
    variant: 'E',
    workerBuildNonce,
    releasedDBuildNonce: lease.releasedDBuildNonce,
    reservedBuildNonces: lease.reservedBuildNonces
  });
}

function testPwaWorkerRequest(cookies, barriers) {
  const cookieNames = [
    'skyjo_sw_test_variant',
    'skyjo_sw_test_activation_barrier',
    'skyjo_sw_test_worker_nonce'
  ];
  const hasTestWorkerCookies = cookieNames.some((name) => cookies.has(name));
  const lease = activeTestPwaWorkerLease();
  if (!hasTestWorkerCookies) {
    if (lease) {
      return {
        activationBarrierToken: lease.activationBarrierToken,
        kind: 'worker',
        variant: lease.variant,
        workerBuildNonce: lease.workerBuildNonce
      };
    }
    return barriers.size > 0 ? { kind: 'error', status: 409 } : null;
  }

  const variant = cookies.get('skyjo_sw_test_variant');
  const activationBarrierToken = cookies.get('skyjo_sw_test_activation_barrier');
  const workerBuildNonce = cookies.get('skyjo_sw_test_worker_nonce');
  const hasActivationBarrierToken = cookies.has('skyjo_sw_test_activation_barrier');
  if (
    !validTestPwaWorkerVariant(variant) ||
    !validTestPwaWorkerBuildNonce(workerBuildNonce) ||
    (hasActivationBarrierToken && !validTestPwaActivationBarrierToken(activationBarrierToken))
  ) return { kind: 'error', status: 400 };

  const workerRequest = {
    activationBarrierToken: hasActivationBarrierToken ? activationBarrierToken : null,
    kind: 'worker',
    variant,
    workerBuildNonce
  };
  if (lease && (
    workerRequest.activationBarrierToken !== lease.activationBarrierToken ||
    workerRequest.variant !== lease.variant ||
    workerRequest.workerBuildNonce !== lease.workerBuildNonce
  )) return { kind: 'error', status: 409 };
  return workerRequest;
}

function testPwaExpectedWorkerBuildNonces(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const expectedVariants = ['B', 'C', 'D'];
  const buildNonces = new Map();
  const seenBuildNonces = new Set();
  for (let index = 0; index < expectedVariants.length; index += 1) {
    const worker = value[index];
    if (
      !worker ||
      worker.variant !== expectedVariants[index] ||
      !validTestPwaWorkerBuildNonce(worker.buildNonce) ||
      seenBuildNonces.has(worker.buildNonce)
    ) return null;
    buildNonces.set(worker.variant, worker.buildNonce);
    seenBuildNonces.add(worker.buildNonce);
  }
  return buildNonces;
}

function settleTestPwaActivationArrivalWaiters(barrier, outcome = null) {
  for (const waiter of [...barrier.arrivalWaiters]) {
    if (outcome || barrier.arrivals.length >= waiter.count) {
      waiter.settle(outcome || 'arrived');
    }
  }
}

function settleTestPwaActivationWaiters(worker, outcome) {
  if (outcome === 'released') worker.released = true;
  const settle = worker.settle;
  worker.settle = null;
  settle?.(outcome);
}

function poisonTestPwaActivationBarrier(barrier) {
  barrier.poisoned = true;
  clearTestPwaWorkerLease(barrier.token);
  settleTestPwaActivationArrivalWaiters(barrier, 'poisoned');
  for (const worker of barrier.workers.values()) {
    settleTestPwaActivationWaiters(worker, 'poisoned');
  }
}

function deleteTestPwaActivationBarrier(token, barrier, outcome = 'cleanup') {
  if (testPwaActivationBarriers.get(token) !== barrier) return;
  clearTimeout(barrier.expiryTimer);
  settleTestPwaActivationArrivalWaiters(barrier, outcome);
  for (const worker of barrier.workers.values()) {
    settleTestPwaActivationWaiters(worker, outcome);
  }
  testPwaActivationBarriers.delete(token);
}

function createTestPwaActivationBarrier(token, expectedWorkerBuildNonces) {
  if (testPwaActivationBarriers.size >= testPwaActivationBarrierMaxRuns) return null;
  const barrier = {
    arrivalWaiters: new Set(),
    arrivals: [],
    deadlineAt: null,
    expectedWorkerBuildNonces,
    expiryTimer: null,
    poisoned: false,
    releases: [],
    step: 0,
    token,
    workers: new Map()
  };
  barrier.expiryTimer = setTimeout(() => {
    deleteTestPwaActivationBarrier(token, barrier, 'expired');
  }, testPwaActivationBarrierLifetimeMs);
  barrier.expiryTimer.unref?.();
  testPwaActivationBarriers.set(token, barrier);
  return barrier;
}

function beginTestPwaActivationBarrierDeadline(token, barrier) {
  if (barrier.deadlineAt !== null) return;
  clearTimeout(barrier.expiryTimer);
  barrier.deadlineAt = Date.now() + testPwaActivationBarrierDeadlineMs;
  barrier.expiryTimer = setTimeout(() => {
    deleteTestPwaActivationBarrier(token, barrier, 'expired');
  }, testPwaActivationBarrierDeadlineMs);
  barrier.expiryTimer.unref?.();
}

function testPwaActivationBarrierSnapshot(barrier) {
  const released = [];
  const pending = [];
  for (const variant of barrier.arrivals) {
    if (barrier.releases.includes(variant)) released.push(variant);
    else pending.push(variant);
  }
  const workers = barrier.arrivals.map((variant) => {
    const worker = barrier.workers.get(variant);
    return {
      variant,
      buildNonce: worker.buildNonce,
      instanceNonce: worker.instanceNonce
    };
  });
  return { arrivals: [...barrier.arrivals], pending, poisoned: barrier.poisoned, released, workers };
}

async function waitForTestPwaActivationArrivals(barrier, count, req, res) {
  if (barrier.poisoned) return 'poisoned';
  if (barrier.deadlineAt === null) return 'not-started';
  const remainingMs = Math.max(0, barrier.deadlineAt - Date.now());
  if (remainingMs === 0) return 'timeout';
  if (barrier.arrivals.length >= count) return 'arrived';
  return new Promise((resolve) => {
    let timeout = null;
    const waiter = { count, settle: null };
    const onDisconnect = () => settle('disconnected');
    const settle = (outcome) => {
      if (timeout !== null) clearTimeout(timeout);
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
      barrier.arrivalWaiters.delete(waiter);
      resolve(outcome);
    };
    waiter.settle = settle;
    barrier.arrivalWaiters.add(waiter);
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);
    timeout = setTimeout(() => settle('timeout'), remainingMs);
    timeout.unref?.();
    if (barrier.poisoned) settle('poisoned');
    else if (Date.now() >= barrier.deadlineAt) settle('timeout');
    else if (barrier.arrivals.length >= count) settle('arrived');
  });
}

async function waitForTestPwaActivationRelease(barrier, worker, req, res) {
  if (barrier.poisoned) return 'poisoned';
  if (barrier.deadlineAt === null) return 'not-started';
  const remainingMs = Math.max(0, barrier.deadlineAt - Date.now());
  if (remainingMs === 0) return 'timeout';
  if (worker.waitStarted) {
    poisonTestPwaActivationBarrier(barrier);
    return 'duplicate';
  }
  worker.waitStarted = true;
  if (worker.released) return 'released';
  return new Promise((resolve) => {
    let timeout = null;
    const onDisconnect = () => settle('disconnected');
    const settle = (outcome) => {
      if (timeout !== null) clearTimeout(timeout);
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
      if (worker.settle === settle) worker.settle = null;
      resolve(outcome);
    };
    worker.settle = settle;
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);
    timeout = setTimeout(() => settle('timeout'), remainingMs);
    timeout.unref?.();
  });
}

function sendInvalidTestPwaActivationBarrierResponse(res) {
  sendJsonResponse(res, 400, { error: 'Invalid test activation barrier request.' });
}

async function handleTestPwaActivationBarrierRequest(req, res, url) {
  if (url.pathname === '/__test/pwa-activation/init' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token, workers } = payload;
    const expectedWorkerBuildNonces = testPwaExpectedWorkerBuildNonces(workers);
    if (!validTestPwaActivationBarrierToken(token) || !expectedWorkerBuildNonces) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    if (testPwaActivationBarriers.has(token)) {
      sendJsonResponse(res, 409, { error: 'Test activation barrier already exists.' });
      return;
    }
    const barrier = createTestPwaActivationBarrier(token, expectedWorkerBuildNonces);
    if (!barrier) {
      sendJsonResponse(res, 503, { error: 'Test activation barrier capacity reached.' });
      return;
    }
    sendJsonResponse(res, 201, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/start' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token } = payload;
    if (!validTestPwaActivationBarrierToken(token)) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test activation barrier not found.' });
      return;
    }
    if (
      barrier.poisoned ||
      barrier.deadlineAt !== null ||
      barrier.step !== 0 ||
      barrier.arrivals.length !== 0
    ) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Unexpected test activation barrier start.' });
      return;
    }
    beginTestPwaActivationBarrierDeadline(token, barrier);
    sendJsonResponse(res, 200, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/status' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    if (!validTestPwaActivationBarrierToken(token)) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test activation barrier not found.' });
      return;
    }
    sendJsonResponse(res, 200, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/wait-arrivals' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const count = Number(url.searchParams.get('count'));
    if (
      !validTestPwaActivationBarrierToken(token) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 3
    ) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test activation barrier not found.' });
      return;
    }
    const outcome = await waitForTestPwaActivationArrivals(barrier, count, req, res);
    if (outcome !== 'arrived') {
      poisonTestPwaActivationBarrier(barrier);
      if (!res.destroyed) {
        const timedOut = outcome === 'timeout' || outcome === 'expired';
        sendJsonResponse(res, timedOut ? 504 : 409, {
          error: timedOut
            ? 'Test worker activation arrival timed out.'
            : 'Test worker activation arrival failed.'
        });
      }
      return;
    }
    sendJsonResponse(res, 200, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/arrive' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token, variant, buildNonce, instanceNonce } = payload;
    if (
      !validTestPwaActivationBarrierToken(token) ||
      !validTestPwaWorkerVariant(variant) ||
      !validTestPwaWorkerBuildNonce(buildNonce) ||
      !validTestPwaWorkerInstanceNonce(instanceNonce)
    ) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test activation barrier not found.' });
      return;
    }
    if (barrier.deadlineAt === null) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Test worker activation barrier was not started.' });
      return;
    }
    if (barrier.deadlineAt !== null && Date.now() >= barrier.deadlineAt) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 504, { error: 'Test worker activation barrier timed out.' });
      return;
    }
    const expectedStep = [
      ['arrive', 'B'],
      ['release', 'B'],
      ['arrive', 'C'],
      ['release', 'C'],
      ['arrive', 'D'],
      ['release', 'D']
    ][barrier.step];
    if (
      barrier.poisoned ||
      expectedStep?.[0] !== 'arrive' ||
      variant !== expectedStep?.[1] ||
      barrier.workers.has(variant) ||
      barrier.expectedWorkerBuildNonces.get(variant) !== buildNonce ||
      [...barrier.workers.values()].some((worker) => (
        worker.buildNonce === buildNonce || worker.instanceNonce === instanceNonce
      ))
    ) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Unexpected test worker activation arrival.' });
      return;
    }
    barrier.arrivals.push(variant);
    barrier.step += 1;
    barrier.workers.set(variant, {
      buildNonce,
      instanceNonce,
      released: false,
      settle: null,
      waitStarted: false
    });
    settleTestPwaActivationArrivalWaiters(barrier);
    sendJsonResponse(res, 201, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/wait-release' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const variant = url.searchParams.get('variant');
    if (!validTestPwaActivationBarrierToken(token) || !validTestPwaWorkerVariant(variant)) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    const worker = barrier?.workers.get(variant);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test worker activation arrival not found.' });
      return;
    }
    if (!worker) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Unexpected test worker activation wait.' });
      return;
    }
    if (barrier.poisoned) {
      sendJsonResponse(res, 409, { error: 'Test worker activation barrier is poisoned.' });
      return;
    }
    const outcome = await waitForTestPwaActivationRelease(barrier, worker, req, res);
    if (outcome === 'timeout' || outcome === 'expired') {
      poisonTestPwaActivationBarrier(barrier);
      if (!res.destroyed) sendJsonResponse(res, 504, { error: 'Test worker activation barrier timed out.' });
      return;
    }
    if (outcome !== 'released') {
      poisonTestPwaActivationBarrier(barrier);
      if (!res.destroyed) sendJsonResponse(res, 409, { error: 'Test worker activation barrier failed.' });
      return;
    }
    send(res, 204, '');
    return;
  }

  if (url.pathname === '/__test/pwa-activation/release' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token, variant } = payload;
    if (!validTestPwaActivationBarrierToken(token) || !validTestPwaWorkerVariant(variant)) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    const worker = barrier?.workers.get(variant);
    if (!barrier) {
      sendJsonResponse(res, 404, { error: 'Test worker activation arrival not found.' });
      return;
    }
    if (!worker) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Unexpected test worker activation release.' });
      return;
    }
    if (barrier.deadlineAt !== null && Date.now() >= barrier.deadlineAt) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 504, { error: 'Test worker activation barrier timed out.' });
      return;
    }
    const expectedStep = [
      ['arrive', 'B'],
      ['release', 'B'],
      ['arrive', 'C'],
      ['release', 'C'],
      ['arrive', 'D'],
      ['release', 'D']
    ][barrier.step];
    if (
      barrier.poisoned ||
      expectedStep?.[0] !== 'release' ||
      variant !== expectedStep?.[1] ||
      worker.released
    ) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Unexpected test worker activation release.' });
      return;
    }
    if (variant === 'D' && !armTestPwaWorkerLeaseForReleasedD(token, barrier)) {
      poisonTestPwaActivationBarrier(barrier);
      sendJsonResponse(res, 409, { error: 'Test worker lease could not be armed.' });
      return;
    }
    settleTestPwaActivationWaiters(worker, 'released');
    barrier.releases.push(variant);
    barrier.step += 1;
    sendJsonResponse(res, 200, testPwaActivationBarrierSnapshot(barrier));
    return;
  }

  if (url.pathname === '/__test/pwa-activation/lease' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token, variant, buildNonce } = payload;
    if (
      !validTestPwaActivationBarrierToken(token) ||
      variant !== 'E' ||
      !validTestPwaWorkerBuildNonce(buildNonce)
    ) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const lease = switchTestPwaWorkerLeaseToE(
      token,
      buildNonce,
      testPwaActivationBarriers.get(token) || null
    );
    if (!lease) {
      sendJsonResponse(res, 409, { error: 'Test worker lease switch was rejected.' });
      return;
    }
    sendJsonResponse(res, 200, { variant: lease.variant, buildNonce: lease.workerBuildNonce });
    return;
  }

  if (url.pathname === '/__test/pwa-activation/cleanup' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const { token } = payload;
    if (!validTestPwaActivationBarrierToken(token)) {
      sendInvalidTestPwaActivationBarrierResponse(res);
      return;
    }
    const barrier = testPwaActivationBarriers.get(token);
    if (barrier) deleteTestPwaActivationBarrier(token, barrier);
    clearTestPwaWorkerLease(token);
    send(res, 204, '');
    return;
  }

  sendJsonResponse(res, 404, { error: 'Test activation barrier endpoint not found.' });
}

function testPwaWorkerSource(variant, activationBarrierToken = null, workerBuildNonce = null) {
  const workerBuildId = crypto
    .createHash('sha256')
    .update(`skyjo-test-worker:${workerBuildNonce}`, 'utf8')
    .digest('hex');
  const activationBarrier = activationBarrierToken && variant !== 'A'
    ? `\nconst activationBarrierToken=${JSON.stringify(activationBarrierToken)};
async function waitAtActivationBarrier() {
  const arrive = await fetch('/__test/pwa-activation/arrive', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: activationBarrierToken,
      variant: version,
      buildNonce: workerBuildNonce,
      instanceNonce: workerInstanceNonce
    })
  });
  if (!arrive.ok) throw new Error('Test activation arrival failed.');
  const release = await fetch('/__test/pwa-activation/wait-release?token=' + encodeURIComponent(activationBarrierToken) + '&variant=' + encodeURIComponent(version), {
    cache: 'no-store'
  });
  if (!release.ok) throw new Error('Test activation release failed.');
}`
    : '';
  return `const version=${JSON.stringify(variant)};
const workerBuildNonce=${JSON.stringify(workerBuildNonce)};
const workerBuildId=${JSON.stringify(workerBuildId)};
const workerInstanceNonce=Array.from(self.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, '0')).join('');
const skipWaitingGraceMs = 50;
function requestImmediateActivation(event) {
  // WebKit may finish this message event before its queued skipWaiting task; the independent 50ms grace keeps one bounded scheduling window.
  void self.skipWaiting().catch(() => {});
  event.waitUntil(new Promise((resolve) => setTimeout(resolve, skipWaitingGraceMs)));
}
async function activateTestWorker() {
  await self.clients.claim();
  ${activationBarrierToken && variant !== 'A' ? 'await waitAtActivationBarrier();' : ''}
}${activationBarrier}
self.addEventListener('install', () => {});
self.addEventListener('activate', (event) => event.waitUntil(activateTestWorker()));
self.addEventListener('message', (event) => {
  const isActivation = event.data?.type === 'SKYJO_ACTIVATE_UPDATE';
  const isBuildIdentityRequest = event.data?.type === 'SKYJO_GET_BUILD_ID';
  const isIdentityRequest = event.data?.type === 'SKYJO_TEST_WORKER_IDENTITY';
  const identityRequestId = event.data?.requestId;
  if (event.origin !== self.location.origin) return;
  if (isActivation) {
    requestImmediateActivation(event);
    return;
  }
  if (
    isBuildIdentityRequest &&
    event.data?.version === 1 &&
    typeof identityRequestId === 'string' &&
    /^[a-z0-9-]{3,64}$/.test(identityRequestId) &&
    event.ports?.length === 1
  ) {
    const replyPort = event.ports[0];
    try {
      replyPort.postMessage({
        type: 'SKYJO_BUILD_ID',
        version: 1,
        requestId: identityRequestId,
        buildId: workerBuildId
      });
    } finally {
      replyPort.close();
    }
    return;
  }
  if (isIdentityRequest && event.ports?.[0]) {
    event.ports[0].postMessage({
      type: 'SKYJO_TEST_WORKER_IDENTITY',
      variant: version,
      buildNonce: workerBuildNonce,
      instanceNonce: workerInstanceNonce
    });
  }
});\n`;
}

function makeRoomCode(randomInt = crypto.randomInt) {
  return createUniqueRandomCode({
    alphabet: inviteCodeAlphabet,
    length: roomCodeLength,
    isTaken: (code) => rooms.has(code) || isResetAliasCodeReserved(resetAliasIndex, code, Date.now()),
    randomInt,
    maxAttempts: secureCodeMaxAttempts
  });
}

function makeRoomCodeForSocket() {
  try {
    return makeRoomCode();
  } catch {
    console.error('Secure room code allocation failed.');
    return null;
  }
}

function cleanServerRoomCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
}

function createRoomInviteToken(room) {
  const cleanRoom = cleanServerRoomCode(room?.code);
  if (cleanRoom.length !== roomCodeLength) throw new PublicApiError('INVALID_ROOM_CODE');
  return createSignedRoomInviteToken({
    roomCode: cleanRoom,
    roomInstanceId: room?.roomInstanceId,
    secret: inviteSecret,
    ttlMs: inviteTtlMs
  });
}

function roomInviteTokenFromUrl(url) {
  const token = url.pathname.startsWith('/invite/')
    ? url.pathname.slice('/invite/'.length)
    : url.searchParams.get('invite');
  if (token === null) return null;
  return isRoomInviteToken(token) ? token : '';
}

function roomForInvite(invite) {
  const room = rooms.get(invite.room);
  return inviteMatchesRoom(invite, room) ? room : null;
}

function sendInviteRoomAccess(res, roomCode) {
  send(res, 303, '', {
    Location: `/lobby?room=${encodeURIComponent(roomCode)}`,
    'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
  });
}

async function handleRoomInviteAccess(res, url, { landing = false } = {}) {
  const token = roomInviteTokenFromUrl(url);
  if (token === null) return false;
  if (!token) {
    sendInviteUnavailable(res, 'This invite is invalid or has expired.');
    return true;
  }

  const invite = parseRoomInviteToken(token, { secret: inviteSecret });
  if (!invite) {
    sendInviteUnavailable(res, 'This invite is invalid or has expired.');
    return true;
  }

  if (!roomForInvite(invite)) {
    sendInviteUnavailable(res, 'That room is no longer available. Ask the host for a new invite.');
    return true;
  }

  if (landing && url.searchParams.get('open') !== 'browser') {
    if (!(await ensureAccountStore())) {
      send(res, 503, 'Invite service is temporarily unavailable.', { 'Content-Type': 'text/plain; charset=utf-8' });
      return true;
    }
    const installCode = createPersistentInviteInstallCode({
      store: accountStore,
      roomCode: invite.room,
      roomInstanceId: invite.roomInstanceId,
      expiresAt: Math.min(invite.expiresAt, Date.now() + inviteCodeTtlMs),
      secret: inviteSecret
    });
    const nonce = htmlNonce();
    send(res, 200, renderInviteLanding({ token, invite, installCode, nonce }), htmlSecurityHeaders(nonce));
    return true;
  }

  sendInviteRoomAccess(res, invite.room);
  return true;
}

function gamePlayerIds(room) {
  const players = Array.isArray(room.state?.players) && room.state.players.length > 0 ? room.state.players : room.players;
  return players.map((player) => player.id);
}

function normalizedReadyIds(room) {
  const validIds = new Set(gamePlayerIds(room));
  const current = Array.isArray(room.readyForNextRoundPlayerIds) ? room.readyForNextRoundPlayerIds : [];
  return current.filter((id, index, ids) => validIds.has(id) && ids.indexOf(id) === index);
}

function allPlayersReadyForNextRound(room) {
  const playerIds = gamePlayerIds(room);
  const readyIds = new Set(normalizedReadyIds(room));
  return playerIds.length > 0 && playerIds.every((id) => readyIds.has(id));
}

function setPlayerReadyForNextRound(room, playerId, ready) {
  const current = new Set(normalizedReadyIds(room));
  if (ready) current.add(playerId);
  else current.delete(playerId);
  room.readyForNextRoundPlayerIds = [...current];
}

function sendJson(ws, payload) {
  return sendRealtimeJson(ws, payload);
}

const projectGameStateSnapshot = createGameStateSnapshotProjector();

function broadcastRoom(room) {
  broadcastRealtimeSnapshots({
    room,
    createSnapshot: (candidate, playerId, serverNow) =>
      createRoomSnapshot(candidate, playerId, serverNow, lifecyclePolicy, projectGameStateSnapshot),
    sendPersonalized: (client, candidate, snapshot) =>
      sendRoomSnapshot(client, candidate, {}, snapshot)
  });
}

function sendCurrentRoom(ws, room) {
  sendRoomSnapshot(ws, room);
}

function sendRoomSnapshot(ws, room, options = {}, preparedSnapshot = null) {
  if (!ws.playerId || !room.players.some((player) => player.id === ws.playerId)) return false;
  const type = options.type === 'resync' ? 'resync' : 'snapshot';
  const payload = {
    type,
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    playerId: ws.playerId,
    revision: room.revision,
    room: preparedSnapshot || createRoomSnapshot(
      room,
      ws.playerId,
      Date.now(),
      lifecyclePolicy,
      projectGameStateSnapshot
    ),
    ...(type === 'resync'
      ? {
          reason: options.reason || 'revision-mismatch',
          ...(options.commandId ? { commandId: options.commandId } : {})
        }
      : {})
  };
  const sent = sendJson(ws, payload);
  if (sent) ws.snapshotRoomCode = room.code;
  return sent;
}

function queueRoomsSave() {
  if (!roomPersistenceLoadAccepted) {
    const error = new Error('Room persistence is unavailable.');
    error.code = 'ROOM_PERSISTENCE_UNAVAILABLE';
    return Promise.reject(error);
  }
  const currentSave = roomsSaveQueue
    .catch(() => {})
    .then(() => roomPersistenceHealth.track(() => saveRoomsToDisk(rooms, roomsFile)));
  roomsSaveQueue = currentSave.catch(() => {});
  return currentSave;
}

function persistRoomsSoon() {
  if (roomsSaveTimer) return;
  roomsSaveTimer = setTimeout(() => {
    roomsSaveTimer = null;
    void queueRoomsSave().catch(() => {
      console.error('Failed to persist rooms.');
    });
  }, roomsSaveDebounceMs);
  roomsSaveTimer.unref();
}

async function flushRoomPersistence() {
  if (roomsSaveTimer) {
    clearTimeout(roomsSaveTimer);
    roomsSaveTimer = null;
  }
  if (!roomPersistenceLoadAccepted) {
    const error = new Error('Room persistence is unavailable.');
    error.code = 'ROOM_PERSISTENCE_UNAVAILABLE';
    throw error;
  }
  await queueRoomsSave();
}

function markAllPlayersDisconnected() {
  const timestamp = Date.now();
  for (const room of rooms.values()) {
    room.clients.clear();
    markPlayersDisconnectedForShutdown(room, timestamp);
  }
}

function roomPlayer(ws) {
  if (!ws.roomCode || !ws.playerId) return null;
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const player = room.players.find((item) => item.id === ws.playerId);
  return player ? { room, player } : null;
}

function createWaitingRoom({ code, hostPlayer, ws }) {
  const timestamp = Date.now();
  return {
    roomVersion: 2,
    roomInstanceId: crypto.randomUUID(),
    code,
    hostId: hostPlayer.id,
    players: [{
      id: hostPlayer.id,
      userId: hostPlayer.userId,
      name: hostPlayer.name,
      connected: true,
      host: true,
      joinedAt: timestamp,
      lastSeenAt: timestamp,
      disconnectedAt: null,
      controller: 'human'
    }],
    chatMessages: [],
    readyForNextRoundPlayerIds: [],
    state: null,
    status: 'waiting',
    updatedAt: timestamp,
    completedGameId: null,
    gameSessionId: null,
    finishedByAi: false,
    revision: 0,
    recentCommandIds: [],
    resetAliases: [],
    clients: new Set([ws])
  };
}

function reclaimVisiblePlayer(room, player, timestamp) {
  const reclaimed = reclaimAiSeat(room, player.id);
  if (!reclaimed || room.revision >= Number.MAX_SAFE_INTEGER) return false;
  room.players = reclaimed.players;
  room.readyForNextRoundPlayerIds = reclaimed.readyForNextRoundPlayerIds;
  const reclaimedPlayer = room.players.find((candidate) => candidate.id === player.id);
  if (reclaimedPlayer) {
    reclaimedPlayer.disconnectedAt = null;
    reclaimedPlayer.lastSeenAt = timestamp;
  }
  room.revision += 1;
  room.updatedAt = timestamp;
  return true;
}

function transferRoomHost(fence) {
  const room = rooms.get(fence.roomCode);
  if (!room || room.revision !== fence.expectedRevision || room.hostId !== fence.fromPlayerId) return false;
  const timestamp = Date.now();
  const transfer = dueHostTransfer(room, timestamp, lifecyclePolicy);
  if (!transfer || transfer.toPlayerId !== fence.toPlayerId || transfer.deadline !== fence.deadline) return false;
  if (room.revision >= Number.MAX_SAFE_INTEGER) return false;
  room.hostId = transfer.toPlayerId;
  room.players = hostFlags(room.players, transfer.toPlayerId);
  room.revision += 1;
  room.updatedAt = timestamp;
  persistRoomsSoon();
  broadcastRoom(room);
  return true;
}

function reportWebPushFailure(message, diagnostic = createWebPushDeliveryDiagnostic(null, null)) {
  try {
    console.warn(message, diagnostic);
  } catch {
    // Logging cannot be allowed to reject a fire-and-forget notification task.
  }
}

async function sendPushToUsers(userIds, payload) {
  try {
    const store = accountStore;
    if (!pushNotificationsEnabled || !store) return;
    const subscriptions = store.listPushSubscriptionsForUsers(userIds);
    if (subscriptions.length === 0) return;
    await deliverWebPushNotifications({
      subscriptions,
      payload,
      sendNotification: (subscription, serializedPayload) => webPush.sendNotification(subscription, serializedPayload),
      deleteSubscription: (endpoint) => store.deletePushSubscription(endpoint),
      reportFailure: (diagnostic) => reportWebPushFailure('Web Push delivery failed.', diagnostic),
      reportCleanupFailure: (diagnostic) => reportWebPushFailure('Web Push subscription cleanup failed.', diagnostic)
    });
  } catch {
    reportWebPushFailure('Web Push notification task failed.');
  }
}

function schedulePushToUsers(userIds, payload) {
  void sendPushToUsers(userIds, payload).catch(() => {
    reportWebPushFailure('Web Push notification task rejected unexpectedly.');
  });
}

function awayUserIdsForPlayers(room, playerIds) {
  const targetPlayerIds = new Set(playerIds.filter(Boolean));
  return room.players
    .filter((player) => targetPlayerIds.has(player.id) && player.userId && !hasVisibleLiveClient(room, player.id))
    .map((player) => player.userId);
}

function notifyAwayPlayersAfterMove(room, actor, nextState) {
  if (!nextState || !Array.isArray(nextState.players)) return;
  const url = `/lobby?room=${encodeURIComponent(room.code)}`;
  if (nextState.phase === 'round-over' || nextState.phase === 'game-over') {
    const targetUserIds = awayUserIdsForPlayers(
      room,
      room.players.filter((player) => player.id !== actor.id).map((player) => player.id)
    );
    const title = nextState.phase === 'game-over' ? 'Skyjo game finished' : 'Skyjo round ended';
    schedulePushToUsers(targetUserIds, {
      title,
      body: `${actor.name} played in room ${room.code}.`,
      tag: `skyjo-${room.code}-${nextState.phase}`,
      url
    });
    return;
  }

  const activePlayer = nextState.players[nextState.currentPlayerIndex];
  if (!activePlayer || activePlayer.id === actor.id) return;
  const targetUserIds = awayUserIdsForPlayers(room, [activePlayer.id]);
  schedulePushToUsers(targetUserIds, {
    title: 'Your turn in Skyjo',
    body: `${actor.name} played. Tap to take your turn.`,
    tag: `skyjo-${room.code}-turn`,
    url
  });
}

function cleanChatText(value) {
  return wellFormedUTF16Prefix(
    String(value || '').replace(/\s+/g, ' ').trim(),
    maxRoomChatMessageLength
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeRedirectPath(value) {
  const path = String(value || '/');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}

function htmlNonce() {
  return crypto.randomBytes(18).toString('base64');
}

function htmlSecurityHeaders(nonce) {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "font-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; '),
    'Content-Type': 'text/html; charset=utf-8'
  };
}

function renderPwaHead(title) {
  return `<meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0a1410" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Skyjo" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="/skyjo-icon-v2.svg" />
    <link rel="apple-touch-icon" href="/skyjo-icon-v2-180.png" />
    <title>${escapeHtml(title)}</title>`;
}

function renderInviteUnavailable(message, nonce) {
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderPwaHead('Skyjo invite unavailable')}
    <style nonce="${nonce}">
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #060c0a; color: #f5e6c8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(100%, 480px); border: 1px solid rgba(245, 230, 200, 0.16); border-radius: 12px; padding: 24px; background: rgba(255, 255, 255, 0.035); }
      h1 { margin: 0 0 12px; font-size: clamp(32px, 10vw, 52px); }
      p { margin: 0 0 20px; color: rgba(245, 230, 200, 0.76); line-height: 1.5; }
      a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; border-radius: 8px; padding: 0 16px; color: #0a1410; background: #f5e6c8; font-weight: 900; text-decoration: none; }
    </style>
  </head>
  <body><main><h1>Invite unavailable</h1><p>${escapeHtml(message)}</p><a href="/login">Open Skyjo</a></main></body>
</html>`;
}

function sendInviteUnavailable(res, message) {
  const nonce = htmlNonce();
  send(res, 410, renderInviteUnavailable(message, nonce), htmlSecurityHeaders(nonce));
}

function trustedClientIp(req) {
  const remoteAddress = typeof req.socket.remoteAddress === 'string' && isIP(req.socket.remoteAddress)
    ? req.socket.remoteAddress
    : 'unknown';
  if (!trustProxyClientIp) return remoteAddress;
  const forwarded = typeof req.headers['cf-connecting-ip'] === 'string'
    ? req.headers['cf-connecting-ip'].trim()
    : '';
  return isIP(forwarded) ? forwarded : remoteAddress;
}

function inviteRedemptionClientKey(req, namespace) {
  return `${namespace}:${trustedClientIp(req)}`;
}

function formatInviteCodeMinutes(expiresAt) {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function renderInviteLanding({ token, invite, installCode, nonce }) {
  const safeRoom = escapeHtml(invite.room);
  const safeCode = escapeHtml(installCode.code);
  const safeMinutes = escapeHtml(formatInviteCodeMinutes(installCode.expiresAt));
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderPwaHead('Join Skyjo')}
    <style nonce="${nonce}">
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 20px;
        background:
          radial-gradient(ellipse 90% 60% at 50% 0%, rgba(245, 230, 200, 0.1) 0%, transparent 58%),
          radial-gradient(ellipse 70% 50% at 90% 100%, rgba(34, 197, 94, 0.09) 0%, transparent 60%),
          linear-gradient(180deg, #0a1410 0%, #060c0a 100%);
        color: #f5e6c8;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(100%, 560px); }
      h1 { margin: 0; font-size: clamp(42px, 12vw, 68px); line-height: 0.95; letter-spacing: 0; }
      h2 { margin: 0 0 10px; font-size: 18px; }
      p { margin: 0; color: rgba(245, 230, 200, 0.74); line-height: 1.5; }
      ol { margin: 12px 0 0; padding-left: 22px; color: rgba(245, 230, 200, 0.78); line-height: 1.45; }
      li + li { margin-top: 6px; }
      .shell { display: grid; gap: 14px; }
      .eyebrow { color: rgba(245, 230, 200, 0.58); font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; }
      .lead { margin-top: 10px; font-size: 17px; }
      .room { display: inline-flex; margin-top: 16px; border: 1px solid rgba(245, 230, 200, 0.22); border-radius: 8px; padding: 8px 12px; font-size: 24px; font-weight: 900; letter-spacing: 0.08em; }
      .choice { border: 1px solid rgba(245, 230, 200, 0.14); border-radius: 8px; padding: 16px; background: rgba(255, 255, 255, 0.035); }
      .actions { display: grid; gap: 10px; margin-top: 14px; }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        border: 0;
        border-radius: 8px;
        padding: 0 14px;
        color: #0a1410;
        background: #f5e6c8;
        font: inherit;
        font-weight: 900;
        text-decoration: none;
        cursor: pointer;
      }
      .button.secondary { color: #f5e6c8; background: rgba(245, 230, 200, 0.12); }
      .code-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 14px; }
      input {
        min-height: 46px;
        width: 100%;
        border: 1px solid rgba(245, 230, 200, 0.18);
        border-radius: 8px;
        padding: 0 12px;
        color: #f5e6c8;
        background: rgba(0, 0, 0, 0.22);
        font: inherit;
        font-size: 20px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-align: center;
      }
      .note { margin-top: 9px; font-size: 13px; color: rgba(245, 230, 200, 0.58); }
      .status { min-height: 18px; margin-top: 8px; color: #bbf7d0; font-size: 13px; font-weight: 800; }
      @media (max-width: 480px) {
        body { padding: 14px; }
        .code-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section>
        <div class="eyebrow">Skyjo invite</div>
        <h1>Join Room ${safeRoom}</h1>
        <p class="lead">Choose where to play. Browser is fastest; Home Screen is better for repeat games.</p>
        <div class="room">${safeRoom}</div>
      </section>

      <section class="choice">
        <h2>Add Skyjo to your Home Screen</h2>
        <p>Copy this invite code first, then add Skyjo from Safari.</p>
        <div class="code-row">
          <input id="invite-code" readonly value="${safeCode}" />
          <button class="button" id="copy-code" type="button">Copy Code</button>
        </div>
        <div class="status" id="copy-status" role="status"></div>
        <ol>
          <li>Tap the Safari share button.</li>
          <li>Choose Add to Home Screen.</li>
          <li>Open Skyjo from the new icon and paste this code.</li>
        </ol>
        <p class="note">Code expires in about ${safeMinutes}. If it expires, open the original invite link again.</p>
      </section>

      <section class="choice">
        <h2>Open in browser</h2>
        <p>Continue in this browser now. This still bypasses the shared Skyjo password for this invite.</p>
        <div class="actions">
          <a class="button secondary" href="?open=browser">Open in Browser</a>
        </div>
      </section>
    </main>
    <script nonce="${nonce}">
      const codeInput = document.getElementById('invite-code');
      const copyButton = document.getElementById('copy-code');
      const status = document.getElementById('copy-status');
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeInput.value);
          status.textContent = 'Invite code copied';
        } catch {
          codeInput.focus();
          codeInput.select();
          status.textContent = 'Code selected';
        }
      });
    </script>
  </body>
</html>`;
}

function appendRoomChatMessage(room, player, text) {
  const message = {
    id: crypto.randomUUID(),
    playerId: player.id,
    playerName: player.name,
    text,
    createdAt: Date.now()
  };
  const currentMessages = Array.isArray(room.chatMessages) ? room.chatMessages : [];
  room.chatMessages = [...currentMessages, message].slice(-maxRoomChatMessages);
  return message;
}

function sendApiError(res, status, code, message, headers = {}) {
  sendJsonResponse(res, status, { code, error: message }, headers);
}

function accountSessionHeaders(session) {
  return {
    'Set-Cookie': accountCookieHeader(session.token, Math.floor(accountSessionTtlMs / 1000))
  };
}

function requireAccountForApi(req, res) {
  const user = currentAccountUser(req);
  if (!user) {
    sendApiError(res, 401, 'ACCOUNT_AUTHENTICATION_REQUIRED', 'Sign in to your Skyjo account.');
    return null;
  }
  return user;
}

function requireAdminForApi(req, res) {
  const user = requireAccountForApi(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendApiError(res, 403, 'ADMIN_REQUIRED', 'Admin privileges are required.');
    return null;
  }
  return user;
}

function singlePlayerSourceKey(user, body) {
  const rawKey = typeof body.clientGameKey === 'string' ? body.clientGameKey : '';
  return `single:${user.id}:${rawKey.slice(0, 160) || crypto.randomUUID()}`;
}

async function handleApiRequest(req, res, url) {
  try {
    if (url.pathname === '/api/account/me' && req.method === 'GET') {
      sendJsonResponse(res, 200, { user: currentAccountUser(req) });
      return true;
    }

    if (url.pathname === '/api/account/signup' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
      const user = await accountStore.createUser({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        role: 'player'
      });
      const session = accountStore.createSession(user.id, accountSessionTtlMs);
      sendJsonResponse(res, 201, { user: session.user }, accountSessionHeaders(session));
      return true;
    }

    if (url.pathname === '/api/account/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const user = await accountStore.authenticate(body.email, body.password);
      if (!user) {
        sendApiError(res, 401, 'ACCOUNT_AUTHENTICATION_FAILED', 'Email or password did not match.');
        return true;
      }
      const session = accountStore.createSession(user.id, accountSessionTtlMs);
      sendJsonResponse(res, 200, { user: session.user }, accountSessionHeaders(session));
      return true;
    }

    if (url.pathname === '/api/account/logout' && req.method === 'POST') {
      accountStore.deleteSession(accountToken(req));
      sendJsonResponse(res, 200, { ok: true }, { 'Set-Cookie': accountCookieHeader('', 0) });
      return true;
    }

    if (url.pathname === '/api/account/profile' && req.method === 'PATCH') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const updatedUser = accountStore.patchUser(user.id, { displayName: body.displayName });
      sendJsonResponse(res, 200, { user: updatedUser });
      return true;
    }

    if (url.pathname === '/api/account/password' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
      await accountStore.changePassword(user.id, body.currentPassword, body.password);
      sendJsonResponse(res, 200, { ok: true }, { 'Set-Cookie': accountCookieHeader('', 0) });
      return true;
    }

    if (url.pathname === '/api/push/config' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, {
        enabled: pushNotificationsEnabled,
        publicKey: pushNotificationsEnabled ? webPushConfiguration.publicKey : ''
      });
      return true;
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      if (!pushNotificationsEnabled) {
        sendApiError(res, 503, 'PUSH_NOT_CONFIGURED', 'Push notifications are not configured.');
        return true;
      }
      const body = await readJsonBody(req);
      accountStore.savePushSubscription(user.id, body.subscription, req.headers['user-agent'] || '');
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      accountStore.deletePushSubscriptionForUser(user.id, body.endpoint);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/rooms/invite' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      const roomCode = cleanServerRoomCode(body.roomCode);
      const room = rooms.get(roomCode);
      if (!room) {
        sendApiError(res, 404, 'ROOM_NOT_FOUND', 'Room not found.');
        return true;
      }
      if (!room.players.some((player) => player.userId === user.id)) {
        sendApiError(res, 403, 'ROOM_MEMBERSHIP_REQUIRED', 'Join the room before sharing it.');
        return true;
      }
      const invite = createRoomInviteToken(room);
      sendJsonResponse(res, 200, {
        roomCode,
        path: `/invite/${invite.token}`,
        expiresAt: invite.expiresAt
      });
      return true;
    }

    if (url.pathname === '/api/stats/summary' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, accountStore.getStatsSummary(user));
      return true;
    }

    if (url.pathname === '/api/stats/games' && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      sendJsonResponse(res, 200, { games: accountStore.listVisibleGames(user) });
      return true;
    }

    if (url.pathname === '/api/stats/single-player' && req.method === 'POST') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const body = await readJsonBody(req);
      if (
        typeof body.expectedAccountUserId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          body.expectedAccountUserId
        )
      ) {
        throw new PublicApiError('STATS_CLIENT_UPGRADE_REQUIRED');
      }
      if (body.expectedAccountUserId !== user.id) throw new PublicApiError('ACCOUNT_SESSION_CHANGED');
      const state = body.state;
      const humanPlayer = Array.isArray(state?.players) ? state.players.find((player) => player.kind === 'human') : null;
      if (!humanPlayer) throw new PublicApiError('MISSING_HUMAN_PLAYER');
      const game = accountStore.recordCompletedGame({
        mode: 'single',
        state,
        createdByUserId: user.id,
        playerAccounts: { [humanPlayer.id]: user.id },
        sourceKey: singlePlayerSourceKey(user, body),
        completedAt: body.completedAt
      });
      sendJsonResponse(res, 201, { game });
      return true;
    }

    const gameMatch = url.pathname.match(/^\/api\/stats\/games\/([^/]+)$/);
    if (gameMatch && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const game = accountStore.getVisibleGame(user, gameMatch[1]);
      if (!game) {
        sendApiError(res, 404, 'GAME_NOT_FOUND', 'Game not found.');
        return true;
      }
      sendJsonResponse(res, 200, { game });
      return true;
    }

    const playerMatch = url.pathname.match(/^\/api\/stats\/players\/([^/]+)$/);
    if (playerMatch && req.method === 'GET') {
      const user = requireAccountForApi(req, res);
      if (!user) return true;
      const playerStats = accountStore.getVisiblePlayerStats(user, playerMatch[1]);
      if (!playerStats) {
        sendApiError(res, 404, 'PLAYER_NOT_FOUND', 'Player not found.');
        return true;
      }
      sendJsonResponse(res, 200, playerStats);
      return true;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      if (!requireAdminForApi(req, res)) return true;
      sendJsonResponse(res, 200, { users: accountStore.listUsers() });
      return true;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      if (!requireAdminForApi(req, res)) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
      const role = body.role === 'admin' ? 'admin' : 'player';
      const user = await accountStore.createUser({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        role
      });
      sendJsonResponse(res, 201, { user });
      return true;
    }

    const adminPasswordMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (adminPasswordMatch && req.method === 'POST') {
      if (!requireAdminForApi(req, res)) return true;
      const body = await readJsonBody(req);
      if (body.password !== body.confirmPassword) throw new PublicApiError('PASSWORDS_MUST_MATCH');
      await accountStore.setUserPassword(adminPasswordMatch[1], body.password);
      sendJsonResponse(res, 200, { ok: true });
      return true;
    }

    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && req.method === 'PATCH') {
      const adminUser = requireAdminForApi(req, res);
      if (!adminUser) return true;
      const body = await readJsonBody(req);
      if (adminUser.id === adminUserMatch[1] && (body.disabled === true || body.disabled === 1 || body.role === 'player')) {
        sendApiError(res, 400, 'ADMIN_SELF_REVOKE_FORBIDDEN', 'You cannot revoke your own admin access.');
        return true;
      }
      const user = accountStore.patchUser(adminUserMatch[1], {
        displayName: body.displayName,
        role: body.role,
        disabled: body.disabled
      });
      sendJsonResponse(res, 200, { user });
      return true;
    }

    return false;
  } catch (error) {
    const publicError = publicApiErrorResponse(error);
    if (publicError.status === 500) console.error('API request failed:', error);
    sendApiError(res, publicError.status, publicError.code, publicError.message);
    return true;
  }
}

function requestUsesJson(req) {
  const contentType = typeof req.headers['content-type'] === 'string'
    ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase()
    : '';
  return contentType === 'application/json';
}

function validAccessSessionBody(body) {
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'password')) return false;
  if (typeof body.password !== 'string') return false;
  const passwordLength = [...body.password].length;
  return passwordLength >= 1 && passwordLength <= maxAccessPasswordLength;
}

function handleAppleAppSiteAssociation(req, res, url) {
  if (url.pathname !== '/.well-known/apple-app-site-association') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed.', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return true;
  }
  send(res, 200, req.method === 'HEAD' ? '' : appleAppSiteAssociation, {
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': String(Buffer.byteLength(appleAppSiteAssociation)),
    'Content-Type': 'application/json'
  });
  return true;
}

function validNativeInviteRedemptionBody(body) {
  return Object.keys(body).length === 1 &&
    Object.hasOwn(body, 'token') &&
    typeof body.token === 'string';
}

async function handleNativeInviteRedemption(req, res, url) {
  if (url.pathname !== '/api/rooms/invite/redeem') return false;
  if (req.method !== 'POST') {
    sendApiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: 'POST' });
    return true;
  }

  try {
    if (!requestUsesJson(req)) throw new PublicApiError('UNSUPPORTED_MEDIA_TYPE');
    const rate = nativeInviteRedemptionRateLimiter.consume(
      inviteRedemptionClientKey(req, 'native-token')
    );
    if (!rate.allowed) {
      const publicError = publicApiErrorResponse(new PublicApiError('INVITE_RATE_LIMITED'));
      sendApiError(res, publicError.status, publicError.code, publicError.message, {
        'Retry-After': String(rate.retryAfterSeconds)
      });
      return true;
    }
    if (url.search) throw new PublicApiError('INVALID_REQUEST');
    const body = await readJsonBody(req);
    if (!validNativeInviteRedemptionBody(body)) throw new PublicApiError('INVALID_REQUEST');
    if (!isRoomInviteToken(body.token)) throw new PublicApiError('INVITE_INVALID_OR_EXPIRED');
    const invite = parseRoomInviteToken(body.token, { secret: inviteSecret });
    if (!invite) throw new PublicApiError('INVITE_INVALID_OR_EXPIRED');
    if (!roomForInvite(invite)) throw new PublicApiError('INVITE_ROOM_UNAVAILABLE');
    sendJsonResponse(res, 200, {
      roomCode: invite.room,
      expiresAt: invite.expiresAt
    }, {
      'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
    });
  } catch (error) {
    const publicError = publicApiErrorResponse(error);
    if (publicError.status === 500) console.error('Native invite redemption failed.');
    sendApiError(res, publicError.status, publicError.code, publicError.message);
  }
  return true;
}

async function handleAccessSessionRequest(req, res, url) {
  if (url.pathname !== '/api/access/session') return false;

  if (req.method === 'GET') {
    sendJsonResponse(res, 200, { authenticated: hasValidSession(req) });
    return true;
  }

  if (req.method === 'DELETE') {
    try {
      accountStore?.deleteSession(accountToken(req));
    } catch {
      console.error('Account session revocation failed during access logout.');
    }
    sendJsonResponse(res, 200, { authenticated: false }, {
      'Set-Cookie': [cookieHeader('', 0), accountCookieHeader('', 0)]
    });
    return true;
  }

  if (req.method !== 'POST') {
    sendApiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', {
      Allow: 'GET, POST, DELETE'
    });
    return true;
  }

  try {
    if (!requestUsesJson(req)) throw new PublicApiError('UNSUPPORTED_MEDIA_TYPE');
    const body = await readJsonBody(req);
    if (!validAccessSessionBody(body)) throw new PublicApiError('INVALID_REQUEST');
    if (!timingSafeEqualString(body.password, accessPassword)) {
      throw new PublicApiError('ACCESS_AUTHENTICATION_FAILED');
    }
    sendJsonResponse(res, 200, { authenticated: true }, {
      'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
    });
  } catch (error) {
    const publicError = publicApiErrorResponse(error);
    if (publicError.status === 500) console.error('Access session request failed.');
    sendApiError(res, publicError.status, publicError.code, publicError.message);
  }
  return true;
}

function renderLogin(error = false, next = '/', inviteCodeError = false, inviteRateLimited = false, nonce = htmlNonce()) {
  const safeNext = safeRedirectPath(next);
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderPwaHead('Skyjo Online')}
    <style nonce="${nonce}">
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at top, #1d4ed8 0, #111827 48%, #020617 100%);
        color: #f8fafc;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { width: min(92vw, 380px); }
      h1 { margin: 0 0 8px; font-size: 48px; letter-spacing: 0; }
      h2 { margin: 0 0 10px; font-size: 18px; }
      p { margin: 0 0 24px; color: #bfdbfe; line-height: 1.45; }
      form { display: grid; gap: 12px; }
      input, button {
        width: 100%;
        box-sizing: border-box;
        border: 0;
        border-radius: 8px;
        font: inherit;
        min-height: 44px;
      }
      input { padding: 0 12px; background: #f8fafc; color: #0f172a; }
      button { background: #38bdf8; color: #082f49; font-weight: 700; cursor: pointer; }
      .invite-panel { margin-top: 18px; border-top: 1px solid rgba(191, 219, 254, 0.22); padding-top: 18px; }
      .invite-panel p { margin-bottom: 12px; color: rgba(191, 219, 254, 0.82); }
      .invite-panel input { text-transform: uppercase; letter-spacing: 0.08em; text-align: center; font-weight: 800; }
      .error { margin-top: 12px; color: #fecaca; }
    </style>
  </head>
  <body>
    <main>
      <h1>SKYJO</h1>
      <p>Enter the shared game password.</p>
      <form method="post" action="/login">
        <input name="next" type="hidden" value="${escapeHtml(safeNext)}" />
        <input name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Continue</button>
      </form>
      ${error ? '<div class="error">That password did not work.</div>' : ''}
      <section class="invite-panel">
        <h2>Have an invite code?</h2>
        <p>Paste the code from a Skyjo invite to open that room without the shared password.</p>
        <form method="post" action="/invite-code">
          <input name="code" autocomplete="one-time-code" inputmode="text" placeholder="ABCD123" required />
          <button type="submit">Open Invite</button>
        </form>
        ${inviteCodeError ? '<div class="error">That invite code expired or did not match.</div>' : ''}
        ${inviteRateLimited ? '<div class="error">Too many attempts. Wait a few minutes and try again.</div>' : ''}
      </section>
    </main>
  </body>
</html>`;
}

async function handleInviteCodeRedeem(req, res) {
  const rate = inviteRedemptionRateLimiter.consume(inviteRedemptionClientKey(req, 'install-code'));
  if (!rate.allowed) {
    const nonce = htmlNonce();
    send(res, 429, renderLogin(false, '/', false, true, nonce), {
      ...htmlSecurityHeaders(nonce),
      'Retry-After': String(rate.retryAfterSeconds)
    });
    return;
  }
  const body = await readRequestBody(req);
  const form = new URLSearchParams(body);
  const code = cleanInviteInstallCode(form.get('code'));
  if (!code || !(await ensureAccountStore())) {
    send(res, 303, '', { Location: '/login?inviteError=1' });
    return;
  }

  const invite = accountStore.consumeInviteCode(hashInviteInstallCode(code, inviteSecret));
  if (!invite) {
    send(res, 303, '', { Location: '/login?inviteError=1' });
    return;
  }

  if (!roomForInvite({ room: invite.roomCode, roomInstanceId: invite.roomInstanceId })) {
    sendInviteUnavailable(res, 'That room is no longer available. Ask the host for a new invite.');
    return;
  }

  sendInviteRoomAccess(res, invite.roomCode);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new PublicApiError('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PublicApiError('INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PublicApiError('EXPECTED_JSON_OBJECT');
  return parsed;
}

async function serveStatic(req, res) {
  const parsed = new URL(req.url || '/', 'http://localhost');
  let pathname = decodeURIComponent(parsed.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requestedPath = path.normalize(path.join(distDir, pathname));
  const inDist = requestedPath === distDir || requestedPath.startsWith(`${distDir}${path.sep}`);
  if (!inDist) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let filePath = requestedPath;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    const isSpaNavigation = req.method === 'GET' && acceptsHtml && path.extname(pathname) === '';
    if (!isSpaNavigation) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    filePath = path.join(distDir, 'index.html');
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const relativePath = path.relative(distDir, filePath).replaceAll(path.sep, '/');
    const immutableAsset = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(relativePath);
    const cacheControl = immutableAsset ? 'public, max-age=31536000, immutable' : 'no-store';
    const htmlHeaders = ext === '.html'
      ? {
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        }
      : {};
    send(res, 200, data, {
      'Cache-Control': cacheControl,
      'Content-Type': mimeTypes.get(ext) || 'application/octet-stream',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(fileName === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      ...htmlHeaders
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

try {
  const snapshot = await roomPersistenceHealth.track(() =>
    loadRoomsSnapshotFromDisk(roomsFile, { staleMs: ROOM_STALE_MS })
  );
  const restoredRoomMap = new Map(snapshot.rooms.map((room) => [room.code, room]));
  const reconciledCompletions = accountStore
    ? reconcileCompletedRoomJournals(
        restoredRoomMap,
        (sourceKey) => accountStore.getCompletedGameJournalBySourceKey(sourceKey)
      )
    : 0;
  if (snapshot.missing || snapshot.legacy || reconciledCompletions > 0) {
    await roomPersistenceHealth.track(() => saveRoomsToDisk(restoredRoomMap, roomsFile));
  }
  for (const room of snapshot.rooms) {
    rooms.set(room.code, room);
  }
  roomPersistenceLoadAccepted = true;
  if (snapshot.rooms.length > 0) {
    console.log(`Restored ${snapshot.rooms.length} persisted room(s) from ${roomsFile}`);
  }
} catch {
  console.error('Persisted room state was rejected; room writes are disabled to protect the source file.');
}

const resetAliasIndex = createResetAliasIndex(rooms);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (url.pathname === '/version') {
      const result = createVersionResult(releaseIdentity);
      sendJsonResponse(res, result.statusCode, result.payload, { 'Cache-Control': 'no-store' });
      return;
    }

    if (url.pathname === '/readyz') {
      await ensureAccountStore();
      const persistence = roomPersistenceHealth.probe();
      const result = createReadinessResult({
        releaseIdentity,
        databaseReady: accountStore?.checkReadiness() === true,
        roomState: roomPersistenceLoadAccepted,
        lastPersist: persistence.status === 'ok'
      });
      sendJsonResponse(res, result.statusCode, result.payload, { 'Cache-Control': 'no-store' });
      return;
    }

    if (handleAppleAppSiteAssociation(req, res, url)) return;

    const testNetworkFault = testPwaNetworkFaultsEnabled &&
      parseCookies(req.headers.cookie).get('skyjo_pwa_test_network_fault') === 'drop';
    if (
      testNetworkFault &&
      (url.pathname.startsWith('/api/') || (
        req.method === 'GET' && (url.pathname === '/' || url.pathname === '/single-player')
      ))
    ) {
      if (url.pathname.startsWith('/api/')) {
        sendApiError(res, 503, 'SERVICE_UNAVAILABLE', 'Service unavailable.', { 'Retry-After': '1' });
      } else {
        send(res, 503, 'Service unavailable.', {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '1'
        });
      }
      return;
    }

    if (testPwaVariantsEnabled && url.pathname === '/sw.js') {
      const cookies = parseCookies(req.headers.cookie);
      const workerRequest = testPwaWorkerRequest(cookies, testPwaActivationBarriers);
      if (workerRequest?.kind === 'error') {
        send(res, workerRequest.status, 'Invalid test service worker routing.', {
          'Content-Type': 'text/plain; charset=utf-8'
        });
        return;
      }
      if (workerRequest?.kind === 'worker') {
        send(res, 200, testPwaWorkerSource(
          workerRequest.variant,
          workerRequest.activationBarrierToken,
          workerRequest.workerBuildNonce
        ), {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/'
        });
        return;
      }
    }

    if (url.pathname.startsWith('/__test/pwa-activation/')) {
      if (!testPwaVariantsEnabled) {
        sendJsonResponse(res, 404, { error: 'Not found.' });
        return;
      }
      await handleTestPwaActivationBarrierRequest(req, res, url);
      return;
    }

    if (await handleNativeInviteRedemption(req, res, url)) return;

    if (await handleAccessSessionRequest(req, res, url)) return;

    if (isPublicPwaAsset(url.pathname)) {
      await serveStatic(req, res);
      return;
    }

    if (url.pathname === '/logout') {
      accountStore?.deleteSession(accountToken(req));
      send(res, 302, '', {
        Location: '/login',
        'Set-Cookie': [cookieHeader('', 0), accountCookieHeader('', 0)]
      });
      return;
    }

    if (url.pathname.startsWith('/invite/')) {
      if (await handleRoomInviteAccess(res, url, { landing: true })) return;
    }

    if (url.pathname === '/invite-code' && req.method === 'POST') {
      await handleInviteCodeRedeem(req, res);
      return;
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      const nonce = htmlNonce();
      send(
        res,
        200,
        renderLogin(
          url.searchParams.get('error') === '1',
          url.searchParams.get('next') || '/',
          url.searchParams.get('inviteError') === '1',
          false,
          nonce
        ),
        htmlSecurityHeaders(nonce)
      );
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readRequestBody(req);
      const form = new URLSearchParams(body);
      const password = form.get('password') || '';
      const next = safeRedirectPath(form.get('next') || '/');
      if (!timingSafeEqualString(password, accessPassword)) {
        send(res, 303, '', { Location: `/login?error=1&next=${encodeURIComponent(next)}` });
        return;
      }
      send(res, 303, '', {
        Location: next,
        'Set-Cookie': cookieHeader(createSessionCookie(), Math.floor(sessionTtlMs / 1000))
      });
      return;
    }

    if (!hasValidSession(req)) {
      if (url.pathname.startsWith('/api/')) {
        sendApiError(res, 401, 'ACCESS_REQUIRED', 'Skyjo access is required.');
        return;
      }
      if (url.searchParams.has('invite') && (await handleRoomInviteAccess(res, url))) return;
      const next = safeRedirectPath(`${url.pathname}${url.search}`);
      send(res, 302, '', { Location: `/login?next=${encodeURIComponent(next)}` });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!(await ensureAccountStore())) {
        sendApiError(res, 503, 'SERVICE_NOT_READY', 'Service is not ready.');
        return;
      }
      if (await handleApiRequest(req, res, url)) return;
      sendApiError(res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found.');
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    if (error instanceof PublicApiError) {
      const publicError = publicApiErrorResponse(error);
      send(res, publicError.status, publicError.message, { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    console.error(error);
    send(res, 500, 'Internal server error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: REALTIME_MAX_INBOUND_CLIENT_FRAME_BYTES });

const handleProtocolV2Message = createProtocolV2MessageHandler({
  allPlayersReadyForNextRound,
  appendRoomChatMessage,
  broadcastRoom,
  cleanChatText,
  createInitialRoomState,
  createNextRoundRoomState,
  createWaitingRoom,
  digestAction: (canonicalAction) => crypto.createHash('sha256').update(canonicalAction).digest('hex'),
  lifecyclePolicy,
  makeRoomCodeForSocket,
  normalizedReadyIds,
  notifyAwayPlayersAfterMove,
  now: Date.now,
  persistRoomsSoon,
  random: () => crypto.randomInt(0, 0x1_0000_0000) / 0x1_0000_0000,
  randomUuid: crypto.randomUUID,
  recordCompletedGame: (input) => {
    const validationContext = {
      rosterPlayerIds: input.state.players.map((player) => player.id),
      roomStatus: 'finished',
      readyForNextRoundPlayerIds: []
    };
    const submittedState = normalizePersistedGameState(input.state, validationContext);
    const game = accountStore.recordCompletedGame({ ...input, state: submittedState });
    const journal = accountStore.getCompletedGameJournalBySourceKey(input.sourceKey);
    if (
      !journal ||
      journal.id !== game.id ||
      journal.sourceKey !== input.sourceKey ||
      journal.roomCode !== input.roomCode
    ) {
      throw new Error('Completed game journal identity does not match the recorded game.');
    }
    const state = normalizePersistedGameState(journal.state, validationContext);
    if (state.phase !== 'game-over') {
      throw new Error('Completed game journal is not terminal.');
    }
    return {
      id: journal.id,
      finishedByAi: journal.finishedByAi,
      recovered: !isDeepStrictEqual(state, submittedState),
      state
    };
  },
  roomPlayer,
  rooms,
  resetAliasIndex,
  sendJson,
  sendRoomSnapshot,
  setPlayerReadyForNextRound,
  syncPlayerPresence,
  reportCompletedGameError: (error) => console.error('Failed to record multiplayer game:', error)
});

const lifecycleScheduler = createRoomLifecycleScheduler({
  aiActionDelayMs,
  executeAiAction: (fence) => handleProtocolV2Message.executeAutomatedAction(fence),
  lifecyclePolicy,
  now: Date.now,
  randomUuid: crypto.randomUUID,
  rooms: () => rooms.values(),
  tickIntervalMs: lifecycleTickMs,
  transferHost: transferRoomHost
});
lifecycleScheduler.runNow();

const disposeRealtimeServer = registerRealtimeServer({
  server,
  webSocketServer: wss,
  hasValidSession,
  currentAccountUser,
  roomPlayer,
  persistRoomsSoon,
  broadcastRoom,
  sendCurrentRoom,
  now: Date.now,
  isShuttingDown: () => shuttingDown,
  onPlayerVisible: reclaimVisiblePlayer,
  onProtocolMessage: handleProtocolV2Message
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_STALE_MS;
  let removedRoom = false;
  for (const [code, room] of rooms.entries()) {
    if (room.updatedAt < cutoff && room.clients.size === 0) {
      rooms.delete(code);
      removedRoom = true;
    }
  }
  if (removedRoom) persistRoomsSoon();
}, 1000 * 60 * 30).unref();

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Skyjo Online serving ${distDir}`);
  console.log(`Listening on http://${host}:${listeningPort}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycleScheduler.dispose();
  console.log(`Received ${signal}; persisting rooms before shutdown.`);
  markAllPlayersDisconnected();
  let exitCode = 0;
  try {
    await flushRoomPersistence();
  } catch {
    exitCode = 1;
    console.error('Room persistence flush failed during shutdown.');
  }
  disposeRealtimeServer();
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close(() => {});
  server.close(() => {
    accountStore?.close();
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 3000).unref();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
