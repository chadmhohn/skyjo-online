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
    ['/cdn-cgi/rum', 'ping'],
    ['/cdn-cgi/rum/', 'other']
  ])('permits the exact same-origin Cloudflare RUM POST at %s for %s browser requests', (path, resourceType) => {
    expect(classify({ resourceType, url: `${baseOrigin}${path}` }))
      .toEqual({ allowed: true, kind: 'cloudflare-rum' });
  });

  it.each([
    '/api/account/signup',
    '/api/account/stats',
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

  it('rejects query strings, fragments, URL credentials, and off-origin posts', () => {
    expect(classify({ url: `${baseOrigin}/cdn-cgi/rum?token=redacted` })).toEqual({
      allowed: false,
      reason: 'rum-query-or-fragment'
    });
    expect(classify({ url: `${baseOrigin}/cdn-cgi/rum#fragment` })).toEqual({
      allowed: false,
      reason: 'rum-query-or-fragment'
    });
    for (const suffix of ['/cdn-cgi/rum?', '/cdn-cgi/rum#', '/cdn-cgi/rum/?', '/cdn-cgi/rum/#']) {
      expect(classify({ url: `${baseOrigin}${suffix}` })).toEqual({
        allowed: false,
        reason: 'rum-query-or-fragment'
      });
    }
    expect(classify({ url: 'https://user:password@skyjo.example.test/cdn-cgi/rum' })).toEqual({
      allowed: false,
      reason: 'url-credentials'
    });
    expect(classify({ url: 'https://analytics.example.test/cdn-cgi/rum' })).toEqual({
      allowed: false,
      reason: 'cross-origin-mutation'
    });
  });

  it.each(['CONNECT', 'DELETE', 'PATCH', 'PUT', 'TRACE'])('rejects unsafe %s methods', (method) => {
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
