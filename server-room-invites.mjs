import crypto from 'node:crypto';

const roomCodePattern = /^[A-Z0-9]{5}$/;
const roomInstanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roomInviteTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const appleApplicationIdentifierPattern = /^[A-Z0-9]{10}\.com\.groundworkrevops\.skyjo$/;
const inviteSignatureDomain = 'skyjo:room-invite-token:v2\0';

export const SYNTHETIC_APPLE_APPLICATION_IDENTIFIER = 'TESTSKYJ01.com.groundworkrevops.skyjo';

export function isRoomInviteToken(value) {
  return typeof value === 'string' && value.length <= 2048 && roomInviteTokenPattern.test(value);
}

export function resolveAppleApplicationIdentifier({
  value,
  nodeEnv,
  canaryReleaseDirectory
} = {}) {
  const explicitlyNonProduction = nodeEnv === 'development' || nodeEnv === 'test';
  const isolatedCanary = typeof canaryReleaseDirectory === 'string' && canaryReleaseDirectory.length > 0;
  const configured = typeof value === 'string' ? value : '';
  if (!configured) {
    if (explicitlyNonProduction || isolatedCanary) return SYNTHETIC_APPLE_APPLICATION_IDENTIFIER;
    throw new TypeError('Apple application identifier is required.');
  }
  if (!appleApplicationIdentifierPattern.test(configured)) {
    throw new TypeError('Apple application identifier is invalid.');
  }
  if (configured === SYNTHETIC_APPLE_APPLICATION_IDENTIFIER && !explicitlyNonProduction && !isolatedCanary) {
    throw new TypeError('Synthetic Apple application identifier is not allowed in production.');
  }
  return configured;
}

export function createAppleAppSiteAssociation(applicationIdentifier) {
  if (!appleApplicationIdentifierPattern.test(String(applicationIdentifier || ''))) {
    throw new TypeError('Apple application identifier is invalid.');
  }
  return {
    applinks: {
      details: [{
        appIDs: [applicationIdentifier],
        components: [
          {
            '/': '/invite/*',
            '?': { open: 'browser' },
            exclude: true
          },
          { '/': '/invite/*' }
        ]
      }]
    }
  };
}

function validatedSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('Room invite secret is invalid.');
  return secret;
}

function signInvitePayload(payload, secret) {
  return crypto
    .createHmac('sha256', validatedSecret(secret))
    .update(inviteSignatureDomain)
    .update(payload)
    .digest('base64url');
}

function timingSafeEqualString(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createRoomInviteToken({
  roomCode,
  roomInstanceId,
  secret,
  ttlMs,
  now = Date.now,
  randomBytes = crypto.randomBytes
}) {
  if (!roomCodePattern.test(String(roomCode || ''))) throw new TypeError('Room invite code is invalid.');
  if (!roomInstanceIdPattern.test(String(roomInstanceId || ''))) throw new TypeError('Room instance identity is invalid.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('Room invite lifetime is invalid.');
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('Room invite runtime is invalid.');
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Room invite clock is invalid.');
  const expiresAt = timestamp + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError('Room invite expiry is invalid.');
  const nonce = randomBytes(16);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16) throw new TypeError('Room invite random source is invalid.');
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    room: roomCode,
    roomInstanceId: roomInstanceId.toLowerCase(),
    exp: expiresAt,
    nonce: nonce.toString('base64url')
  })).toString('base64url');
  return { token: `${payload}.${signInvitePayload(payload, secret)}`, expiresAt };
}

export function parseRoomInviteToken(token, { secret, now = Date.now } = {}) {
  if (!isRoomInviteToken(token)) return null;
  if (typeof now !== 'function') throw new TypeError('Room invite clock is invalid.');
  const [payload, signature] = token.split('.');
  if (!timingSafeEqualString(signature, signInvitePayload(payload, secret))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const expiresAt = Number(parsed?.exp);
    if (
      parsed?.v !== 2 ||
      !roomCodePattern.test(parsed?.room) ||
      !roomInstanceIdPattern.test(parsed?.roomInstanceId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now()
    ) return null;
    return {
      room: parsed.room,
      roomInstanceId: parsed.roomInstanceId.toLowerCase(),
      expiresAt
    };
  } catch {
    return null;
  }
}

export function inviteMatchesRoom(invite, room) {
  return Boolean(
    invite &&
    room &&
    room.code === invite.room &&
    room.roomInstanceId === invite.roomInstanceId
  );
}
