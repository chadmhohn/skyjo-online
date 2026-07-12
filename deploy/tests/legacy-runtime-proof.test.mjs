import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { normalizeLegacyProofConfiguration, runLegacyRuntimeProof } from '../legacy-runtime-proof.mjs';

const releaseSha = 'c'.repeat(40);

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send() {
    queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'error', message: 'Join or create a room first.' })));
  }

  close() {
    queueMicrotask(() => this.emit('close'));
  }
}

async function proofFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-legacy-proof-'));
  const releaseRoot = path.join(root, 'releases');
  const releaseDirectory = path.join(releaseRoot, releaseSha);
  const stateRoot = path.join(root, 'state');
  const databasePath = path.join(stateRoot, 'skyjo.sqlite');
  const roomsPath = path.join(stateRoot, 'rooms.json');
  await Promise.all([fs.mkdir(releaseDirectory, { recursive: true }), fs.mkdir(stateRoot)]);
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE users (email TEXT PRIMARY KEY, disabled INTEGER NOT NULL);');
  database.prepare('INSERT INTO users (email, disabled) VALUES (?, 0)').run('smoke@example.com');
  database.close();
  await fs.writeFile(roomsPath, '[]\n');
  const contracts = { releaseRoot, stateRoot, baseUrl: 'http://127.0.0.1:4180' };
  const config = {
    releaseDirectory, expectedReleaseSha: releaseSha, databasePath, roomsPath,
    baseUrl: contracts.baseUrl, accessPassword: 'shared-secret',
    accountEmail: 'smoke@example.com', accountPassword: 'account-secret'
  };
  try { await callback({ root, contracts, config, databasePath, roomsPath }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function healthyAuthFetch(calls) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    if (pathname === '/healthz') return new Response('ok', { status: 200 });
    if (pathname === '/readyz') return new Response('', { status: 302, headers: { location: '/login?next=%2Freadyz' } });
    if (pathname === '/login') return new Response('', { status: 303, headers: { 'set-cookie': 'skyjo_site=site-token; Path=/' } });
    if (pathname === '/api/account/login') return new Response('{}', { status: 200, headers: { 'set-cookie': 'skyjo_account=account-token; Path=/' } });
    if (pathname === '/api/account/me') return Response.json({ user: { email: 'smoke@example.com' } });
    throw new Error(`Unexpected proof request: ${pathname}`);
  };
}

test('legacy proof requires exact hardened state paths and completes authenticated fallback proof', async () => {
  await proofFixture(async ({ contracts, config }) => {
    const calls = [];
    const result = await runLegacyRuntimeProof(config, { contracts, fetchImpl: healthyAuthFetch(calls), WebSocketImpl: FakeWebSocket });
    assert.equal(result.authenticated, true);
    assert.deepEqual(calls, ['/healthz', '/readyz', '/login', '/api/account/login', '/api/account/me']);
    await assert.rejects(
      normalizeLegacyProofConfiguration({ ...config, databasePath: path.join(contracts.stateRoot, 'wrong.sqlite') }, contracts),
      /hardened production path/i
    );
    await assert.rejects(
      normalizeLegacyProofConfiguration({ ...config, roomsPath: path.join(contracts.stateRoot, 'wrong.json') }, contracts),
      /hardened production path/i
    );
  });
});

test('healthz success cannot hide corrupt database or room state', async () => {
  await proofFixture(async ({ contracts, config, databasePath, roomsPath }) => {
    const databaseCalls = [];
    await fs.writeFile(databasePath, 'not sqlite');
    await assert.rejects(
      runLegacyRuntimeProof(config, { contracts, fetchImpl: healthyAuthFetch(databaseCalls), WebSocketImpl: FakeWebSocket }),
      /sqlite|database/i
    );
    assert.deepEqual(databaseCalls, ['/healthz']);

    await fs.rm(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE users (email TEXT PRIMARY KEY, disabled INTEGER NOT NULL);');
    database.prepare('INSERT INTO users (email, disabled) VALUES (?, 0)').run('smoke@example.com');
    database.close();
    await fs.writeFile(roomsPath, '{not json');
    const roomCalls = [];
    await assert.rejects(
      runLegacyRuntimeProof(config, { contracts, fetchImpl: healthyAuthFetch(roomCalls), WebSocketImpl: FakeWebSocket }),
      /room-state|json/i
    );
    assert.deepEqual(roomCalls, ['/healthz']);
  });
});

test('healthz success cannot hide state unreadable by the runtime identity', { skip: process.platform === 'win32' }, async () => {
  await proofFixture(async ({ contracts, config, databasePath }) => {
    await fs.chmod(databasePath, 0o000);
    const calls = [];
    await assert.rejects(
      runLegacyRuntimeProof(config, { contracts, fetchImpl: healthyAuthFetch(calls), WebSocketImpl: FakeWebSocket }),
      /access|open|database/i
    );
    assert.deepEqual(calls, ['/healthz']);
  });
});
