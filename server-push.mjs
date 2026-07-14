import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const NON_PUBLIC_HOST_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'localdomain',
  'alt',
  'arpa',
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

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isPublicHostname(value) {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped) !== 0) return false;
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

function safeReport(reporter, diagnostic) {
  if (typeof reporter !== 'function') return;
  try {
    const result = reporter(diagnostic);
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Diagnostics must never change delivery or cleanup behavior.
  }
}

function subscriptionEntry(value) {
  try {
    return value && typeof value === 'object'
      ? { endpoint: value.endpoint, subscription: value.subscription }
      : { endpoint: null, subscription: null };
  } catch {
    return { endpoint: null, subscription: null };
  }
}

function failedDeliveryResult(diagnostic, { cleanupFailed = false } = {}) {
  return {
    delivered: false,
    deleted: false,
    cleanupFailed,
    diagnostic
  };
}

export async function deliverWebPushNotifications({
  subscriptions,
  payload,
  sendNotification,
  deleteSubscription,
  reportFailure,
  reportCleanupFailure
}) {
  const entries = Array.isArray(subscriptions) ? subscriptions.map(subscriptionEntry) : [];
  let serializedPayload;
  try {
    serializedPayload = JSON.stringify(payload);
    if (typeof serializedPayload !== 'string') throw new Error('serialization failed');
  } catch {
    return entries.map(({ endpoint }) => {
      const diagnostic = createWebPushDeliveryDiagnostic(null, endpoint);
      safeReport(reportFailure, diagnostic);
      return failedDeliveryResult(diagnostic);
    });
  }
  return Promise.all(entries.map(async ({ endpoint, subscription }) => {
    try {
      await sendNotification(subscription, serializedPayload);
      return { delivered: true, deleted: false, cleanupFailed: false };
    } catch (error) {
      const diagnostic = createWebPushDeliveryDiagnostic(error, endpoint);
      safeReport(reportFailure, diagnostic);
      const stale = diagnostic.statusCode === 404 || diagnostic.statusCode === 410;
      if (!stale) return failedDeliveryResult(diagnostic);
      try {
        await deleteSubscription(endpoint);
        return { delivered: false, deleted: true, cleanupFailed: false, diagnostic };
      } catch {
        safeReport(reportCleanupFailure, diagnostic);
        return failedDeliveryResult(diagnostic, { cleanupFailed: true });
      }
    }
  }));
}
