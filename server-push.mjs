import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const NON_PUBLIC_HOST_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'test',
  'example',
  'invalid',
  'internal',
  'lan',
  'home',
  'home.arpa',
  'onion',
  'example.com',
  'example.net',
  'example.org'
]);

const PROVIDER_REASON_ALLOWLIST = new Set([
  'BadCollapseId',
  'BadDeviceToken',
  'BadExpirationDate',
  'BadJwtToken',
  'BadMessageId',
  'BadPriority',
  'BadTopic',
  'DeviceTokenNotForTopic',
  'ExpiredProviderToken',
  'InternalServerError',
  'InvalidProviderToken',
  'MissingProviderToken',
  'PayloadEmpty',
  'PayloadTooLarge',
  'ServiceUnavailable',
  'Shutdown',
  'TooManyProviderTokenUpdates',
  'TooManyRequests',
  'TopicDisallowed',
  'Unregistered'
]);

function normalizeEnvironmentValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPublicIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [first, second, third] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function expandIpv6(hostname) {
  let candidate = hostname;
  if (candidate.includes('.')) {
    const lastColon = candidate.lastIndexOf(':');
    const octets = candidate.slice(lastColon + 1).split('.').map(Number);
    if (octets.length !== 4) return null;
    candidate = `${candidate.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const compressed = candidate.split('::');
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(':') : [];
  const right = compressed[1] ? compressed[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? groups
    : null;
}

function isPublicIpv6(hostname) {
  const groups = expandIpv6(hostname);
  if (!groups) return false;
  const [first, second] = groups;
  if (first === 0) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  return true;
}

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isPublicHostname(value) {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const ipVersion = isIP(unwrapped);
  if (ipVersion === 4) return isPublicIpv4(unwrapped);
  if (ipVersion === 6) return isPublicIpv6(unwrapped.toLowerCase());
  const hostname = domainToASCII(unwrapped.toLowerCase().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || !hostname.includes('.') || /^[0-9.]+$/.test(hostname)) return false;
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(hostname, suffix))) return false;
  return hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isValidMailtoSubject(parsed) {
  if (parsed.protocol !== 'mailto:' || parsed.hash) return false;
  let address;
  try {
    address = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  if (address.length > 254 || address.includes(',') || /[\u0000-\u001f\u007f]/.test(address)) return false;
  const separator = address.lastIndexOf('@');
  if (separator <= 0 || separator === address.length - 1) return false;
  const localPart = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  if (localPart.length > 64 || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)) return false;
  return isPublicHostname(domain);
}

export function validateVapidSubject(value) {
  const subject = normalizeEnvironmentValue(value);
  if (!subject || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error('SKYJO_VAPID_SUBJECT must be a public HTTPS or mailto contact URI.');
  }
  let parsed;
  try {
    parsed = new URL(subject);
  } catch {
    throw new Error('SKYJO_VAPID_SUBJECT must be a public HTTPS or mailto contact URI.');
  }
  const validHttps = parsed.protocol === 'https:' && !parsed.username && !parsed.password && isPublicHostname(parsed.hostname);
  if (!validHttps && !isValidMailtoSubject(parsed)) {
    throw new Error('SKYJO_VAPID_SUBJECT must be a public HTTPS or mailto contact URI.');
  }
  return subject;
}

function decodeCanonicalBase64Url(value) {
  if (!/^[a-z0-9_-]+$/i.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

function validateVapidKeyPair(publicKey, privateKey) {
  const publicBytes = decodeCanonicalBase64Url(publicKey);
  const privateBytes = decodeCanonicalBase64Url(privateKey);
  if (!publicBytes || publicBytes.length !== 65 || publicBytes[0] !== 4 || !privateBytes || privateBytes.length !== 32) {
    throw new Error('Skyjo Web Push VAPID keys must be a coherent P-256 key pair.');
  }
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    const derivedPublicKey = ecdh.getPublicKey();
    if (derivedPublicKey.length !== publicBytes.length || !crypto.timingSafeEqual(derivedPublicKey, publicBytes)) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('Skyjo Web Push VAPID keys must be a coherent P-256 key pair.');
  }
}

export function resolveWebPushConfiguration({ publicKey, privateKey, subject }) {
  const normalizedPublicKey = normalizeEnvironmentValue(publicKey);
  const normalizedPrivateKey = normalizeEnvironmentValue(privateKey);
  if (!normalizedPublicKey && !normalizedPrivateKey) {
    return { enabled: false, publicKey: '', privateKey: '', subject: '' };
  }
  if (!normalizedPublicKey || !normalizedPrivateKey) {
    throw new Error('SKYJO_VAPID_PUBLIC_KEY and SKYJO_VAPID_PRIVATE_KEY must both be set or both be empty.');
  }
  validateVapidKeyPair(normalizedPublicKey, normalizedPrivateKey);
  return {
    enabled: true,
    publicKey: normalizedPublicKey,
    privateKey: normalizedPrivateKey,
    subject: validateVapidSubject(subject)
  };
}

function safeProperty(value, property) {
  try {
    return value && typeof value === 'object' ? value[property] : undefined;
  } catch {
    return undefined;
  }
}

function providerReason(error) {
  let body = safeProperty(error, 'body');
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const reason = safeProperty(body, 'reason');
  return typeof reason === 'string' && PROVIDER_REASON_ALLOWLIST.has(reason) ? reason : null;
}

function endpointOrigin(endpoint) {
  if (typeof endpoint !== 'string') return null;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function createWebPushDeliveryDiagnostic(error, endpoint) {
  const rawStatusCode = safeProperty(error, 'statusCode');
  const statusCode = Number.isInteger(rawStatusCode) && rawStatusCode >= 100 && rawStatusCode <= 599
    ? rawStatusCode
    : null;
  return {
    statusCode,
    providerReason: providerReason(error),
    endpointOrigin: endpointOrigin(endpoint)
  };
}

export async function deliverWebPushNotifications({
  subscriptions,
  payload,
  sendNotification,
  deleteSubscription,
  reportFailure
}) {
  const serializedPayload = JSON.stringify(payload);
  return Promise.all(subscriptions.map(async ({ endpoint, subscription }) => {
    try {
      await sendNotification(subscription, serializedPayload);
      return { delivered: true, deleted: false };
    } catch (error) {
      const diagnostic = createWebPushDeliveryDiagnostic(error, endpoint);
      try {
        reportFailure(diagnostic);
      } catch {
        // Diagnostics must not change delivery or stale-subscription cleanup behavior.
      }
      const deleted = diagnostic.statusCode === 404 || diagnostic.statusCode === 410;
      if (deleted) await deleteSubscription(endpoint);
      return { delivered: false, deleted, diagnostic };
    }
  }));
}
