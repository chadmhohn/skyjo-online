import crypto from 'node:crypto';

const roomCodePattern = /^[A-Z0-9]{5}$/;
const roomInstanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inviteSignatureDomain = 'skyjo:room-invite-token:v2\0';

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
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
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
