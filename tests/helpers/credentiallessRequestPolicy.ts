const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const rumPaths = new Set(['/cdn-cgi/rum', '/cdn-cgi/rum/']);

export type CredentiallessRequestRejection =
  | 'application-mutation'
  | 'cross-origin-mutation'
  | 'malformed-base-origin'
  | 'malformed-request-url'
  | 'rum-query-or-fragment'
  | 'url-credentials'
  | 'unsafe-method';

export type CredentiallessRequestDecision =
  | { allowed: true; kind: 'cloudflare-rum' | 'safe-method' }
  | { allowed: false; reason: CredentiallessRequestRejection };

type CredentiallessRequestInput = {
  baseOrigin: string;
  method: string;
  resourceType: string;
  url: string;
};

export function classifyCredentiallessRequest({
  baseOrigin,
  method,
  url
}: CredentiallessRequestInput): CredentiallessRequestDecision {
  let requestUrl: URL;
  try {
    requestUrl = new URL(url);
  } catch {
    return { allowed: false, reason: 'malformed-request-url' };
  }

  if (safeMethods.has(method)) return { allowed: true, kind: 'safe-method' };
  if (method !== 'POST') return { allowed: false, reason: 'unsafe-method' };

  let expectedOrigin: string;
  try {
    const parsedBase = new URL(baseOrigin);
    if (
      parsedBase.username ||
      parsedBase.password ||
      parsedBase.pathname !== '/' ||
      parsedBase.search ||
      parsedBase.hash
    ) {
      return { allowed: false, reason: 'malformed-base-origin' };
    }
    expectedOrigin = parsedBase.origin;
  } catch {
    return { allowed: false, reason: 'malformed-base-origin' };
  }

  if (requestUrl.username || requestUrl.password) return { allowed: false, reason: 'url-credentials' };
  if (requestUrl.origin !== expectedOrigin) return { allowed: false, reason: 'cross-origin-mutation' };
  if (!rumPaths.has(requestUrl.pathname)) return { allowed: false, reason: 'application-mutation' };
  if (
    requestUrl.search ||
    requestUrl.hash ||
    requestUrl.href !== `${expectedOrigin}${requestUrl.pathname}`
  ) {
    return { allowed: false, reason: 'rum-query-or-fragment' };
  }
  return { allowed: true, kind: 'cloudflare-rum' };
}
