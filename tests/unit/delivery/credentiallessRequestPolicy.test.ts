import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyCredentiallessRequest } from '../../helpers/credentiallessRequestPolicy';

const baseOrigin = 'https://skyjo.example.test';
const root = path.resolve(import.meta.dirname, '..', '..', '..');

function classify(overrides: Partial<Parameters<typeof classifyCredentiallessRequest>[0]> = {}) {
  return classifyCredentiallessRequest({
    baseOrigin,
    method: 'POST',
    resourceType: 'xhr',
    url: `${baseOrigin}/cdn-cgi/rum`,
    ...overrides
  });
}

describe('credentialless production request policy', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('permits safe %s requests', (method) => {
    expect(classify({ method, resourceType: 'document', url: 'https://assets.example.test/file.js?cache=1' }))
      .toEqual({ allowed: true, kind: 'safe-method' });
  });

  it.each([
    ['/cdn-cgi/rum', 'xhr'],
    ['/cdn-cgi/rum/', 'fetch'],
    ['/cdn-cgi/rum?', 'ping'],
    ['/cdn-cgi/rum/?', 'other']
  ])('permits the exact same-origin Cloudflare RUM POST at %s for %s browser requests', (path, resourceType) => {
    expect(classify({ resourceType, url: `${baseOrigin}${path}` }))
      .toEqual({ allowed: true, kind: 'cloudflare-rum' });
  });

  it.each(['xhr', 'fetch', 'ping', 'other'])('does not use %s resource type as authorization', (resourceType) => {
    expect(classify({ resourceType, url: `${baseOrigin}/cdn-cgi/rum?` }))
      .toEqual({ allowed: true, kind: 'cloudflare-rum' });
    expect(classify({ resourceType, url: `${baseOrigin}/api/account/stats` }))
      .toEqual({ allowed: false, reason: 'application-mutation' });
  });

  it.each([
    '/api/account/signup',
    '/api/account/stats',
    '/api/push/apns/devices/00000000-0000-4000-8000-000000000001',
    '/api/push/subscribe',
    '/invite-code',
    '/login',
    '/cdn-cgi/rum-extra',
    '/cdn-cgi/rum/nested'
  ])('rejects application or lookalike mutation path %s', (path) => {
    expect(classify({ url: `${baseOrigin}${path}` })).toEqual({
      allowed: false,
      reason: 'application-mutation'
    });
  });

  it('rejects every non-empty query and bare or non-empty fragment adjacent to an exact RUM path', () => {
    for (const suffix of [
      '/cdn-cgi/rum?token=redacted',
      '/cdn-cgi/rum/?token=redacted',
      '/cdn-cgi/rum?=',
      '/cdn-cgi/rum?&',
      '/cdn-cgi/rum?%00',
      '/cdn-cgi/rum??',
      '/cdn-cgi/rum#',
      '/cdn-cgi/rum/#',
      '/cdn-cgi/rum#fragment',
      '/cdn-cgi/rum/#fragment',
      '/cdn-cgi/rum?#',
      '/cdn-cgi/rum/?#'
    ]) {
      expect(classify({ url: `${baseOrigin}${suffix}` })).toEqual({
        allowed: false,
        reason: 'rum-query-or-fragment'
      });
    }
  });

  it('rejects credentials, off-origin requests, and noncanonical same-origin spellings', () => {
    expect(classify({ url: 'https://user:password@skyjo.example.test/cdn-cgi/rum' })).toEqual({
      allowed: false,
      reason: 'url-credentials'
    });
    expect(classify({ url: 'https://analytics.example.test/cdn-cgi/rum' })).toEqual({
      allowed: false,
      reason: 'cross-origin-mutation'
    });
    expect(classify({ url: 'https://skyjo.example.test.evil/cdn-cgi/rum?' })).toEqual({
      allowed: false,
      reason: 'cross-origin-mutation'
    });
    expect(classify({ url: 'https://skyjo.example.test:444/cdn-cgi/rum?' })).toEqual({
      allowed: false,
      reason: 'cross-origin-mutation'
    });
    for (const url of [
      'https://skyjo.example.test:443/cdn-cgi/rum',
      'https://SKYJO.example.test/cdn-cgi/rum',
      ` ${baseOrigin}/cdn-cgi/rum`,
      `${baseOrigin}/cdn-cgi/rum\n`
    ]) {
      expect(classify({ url })).toEqual({
        allowed: false,
        reason: 'rum-query-or-fragment'
      });
    }
  });

  it('requires raw URL membership rather than accepting an equivalent normalized href', () => {
    const normalizedToAllowed = `${baseOrigin}/cdn-cgi/x/../rum?`;
    expect(new URL(normalizedToAllowed).href).toBe(`${baseOrigin}/cdn-cgi/rum?`);
    expect(classify({ url: normalizedToAllowed })).toEqual({
      allowed: false,
      reason: 'rum-query-or-fragment'
    });

    for (const suffix of ['/cdn-cgi/%2e/rum?', '/cdn-cgi\\rum?']) {
      expect(new URL(`${baseOrigin}${suffix}`).href).toBe(`${baseOrigin}/cdn-cgi/rum?`);
      expect(classify({ url: `${baseOrigin}${suffix}` })).toEqual({
        allowed: false,
        reason: 'rum-query-or-fragment'
      });
    }
    for (const suffix of ['/cdn-cgi/%72um?', '/cdn-cgi/rum%3f']) {
      expect(classify({ url: `${baseOrigin}${suffix}` })).toEqual({
        allowed: false,
        reason: 'application-mutation'
      });
    }
    for (const suffix of ['/cdn-cgi/RUM?', '/cdn-cgi//rum?']) {
      expect(classify({ url: `${baseOrigin}${suffix}` })).toEqual({
        allowed: false,
        reason: 'application-mutation'
      });
    }
  });

  it.each(['CONNECT', 'DELETE', 'PATCH', 'PUT', 'TRACE', 'post', 'POST '])('rejects unsafe %s methods', (method) => {
    expect(classify({ method })).toEqual({ allowed: false, reason: 'unsafe-method' });
  });

  it('fails closed for malformed request URLs and base origins', () => {
    expect(classify({ method: 'GET', url: 'not an absolute URL' })).toEqual({
      allowed: false,
      reason: 'malformed-request-url'
    });
    expect(classify({ baseOrigin: 'not an origin' })).toEqual({
      allowed: false,
      reason: 'malformed-base-origin'
    });
    expect(classify({ baseOrigin: `${baseOrigin}/nested` })).toEqual({
      allowed: false,
      reason: 'malformed-base-origin'
    });
  });

  it('is wired into the public smoke without replacing credential, cache, offline, or restore gates', async () => {
    const smoke = await fs.readFile(
      path.join(root, 'tests', 'e2e', 'certification', 'public-production-pwa.spec.ts'),
      'utf8'
    );
    expect(smoke).toContain('classifyCredentiallessRequest({');
    expect(smoke).toContain('assertCredentiallessContext(context)');
    expect(smoke).toContain('assertSafeCaches(restored)');
    expect(smoke).toContain('await context.setOffline(true)');
    expect(smoke).toContain('beforeContinue.gameId !== beforeClose.gameId');
    expect(smoke).toContain('afterContinue.state !== beforeClose.state');
    expect(smoke).not.toContain('browserRequest.postData');
  });
});
