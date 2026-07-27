import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '../fixtures';

test('release endpoints identify the exact ready candidate', async ({ request, skyjoServer }) => {
  const built = JSON.parse(await fs.readFile(path.resolve('dist', 'release.json'), 'utf8')) as {
    protocolVersion: number;
    releaseSha: string;
    schemaVersion: number;
  };
  expect(built.releaseSha).toMatch(/^[a-f0-9]{40}$/);
  const configuredSha = String(process.env.SKYJO_RELEASE_SHA || '').trim().toLowerCase();
  if (configuredSha) {
    expect(configuredSha).toMatch(/^[a-f0-9]{40}$/);
    expect(built.releaseSha).toBe(configuredSha);
  }

  const [readyResponse, versionResponse] = await Promise.all([
    request.get(`${skyjoServer.baseURL}/readyz`),
    request.get(`${skyjoServer.baseURL}/version`)
  ]);
  expect(readyResponse.status()).toBe(200);
  expect(versionResponse.status()).toBe(200);
  expect(readyResponse.headers()['cache-control']).toMatch(/no-store/);
  expect(versionResponse.headers()['cache-control']).toMatch(/no-store/);
  expect(await readyResponse.json()).toEqual({
    status: 'ready',
    releaseSha: built.releaseSha,
    schemaVersion: 2,
    protocolVersion: 2,
    checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
  });
  expect(await versionResponse.json()).toMatchObject({
    releaseSha: built.releaseSha,
    protocolVersion: 2
  });
  expect(built).toMatchObject({ schemaVersion: 2, protocolVersion: 2 });
});
