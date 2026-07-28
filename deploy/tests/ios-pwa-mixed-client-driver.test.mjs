import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_HEADER_NAME,
  CONTROL_HEADER_VALUE,
  MAXIMUM_CONTROL_REQUEST_BYTES,
  classifyControlRequest,
  controlErrorResponse,
  createControlServer,
  parseControlCommand,
  parseStartupMessage,
} from '../../scripts/ios-pwa-mixed-client-driver.mjs';
import {
  V032_PROTOCOL_V2_SHA256,
  V032_RELEASE_SHA,
  V032_ROOM_CONNECTION_SHA256,
  verifyV032PWACompatibility,
} from '../../scripts/verify-ios-pwa-v032-compatibility.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const driverPath = path.join(repositoryRoot, 'scripts', 'ios-pwa-mixed-client-driver.mjs');

function command(overrides = {}) {
  return Buffer.from(JSON.stringify({
    version: CONTROL_PROTOCOL_VERSION,
    id: '40000000-0000-4000-8000-000000000186',
    operation: 'reset',
    arguments: {},
    ...overrides,
  }));
}

test('startup accepts only an exact dynamic IPv4 loopback origin', () => {
  assert.deepEqual(
    parseStartupMessage('{"version":1,"type":"start","serverOrigin":"http://127.0.0.1:4180"}'),
    { serverOrigin: 'http://127.0.0.1:4180' }
  );
  for (const serverOrigin of [
    'https://127.0.0.1:4180',
    'http://localhost:4180',
    'http://127.0.0.1:4180/path',
    'http://user:secret@127.0.0.1:4180',
    'http://127.0.0.1',
  ]) {
    assert.throws(
      () => parseStartupMessage(JSON.stringify({ version: 1, type: 'start', serverOrigin })),
      /invalid-startup/
    );
  }
  assert.throws(
    () => parseStartupMessage('{"version":1,"type":"start","serverOrigin":"http://127.0.0.1:4180","secret":"x"}'),
    /invalid-startup/
  );
});

test('control commands are exact, bounded, typed, and operation allowlisted', () => {
  assert.deepEqual(parseControlCommand(command()), {
    id: '40000000-0000-4000-8000-000000000186',
    operation: 'reset',
    arguments: {},
  });
  for (const invalid of [
    command({ version: 2 }),
    command({ id: 'not-an-id' }),
    command({ operation: 'evaluate-javascript' }),
    command({ arguments: { visible: true } }),
    command({ extra: true }),
    Buffer.alloc(MAXIMUM_CONTROL_REQUEST_BYTES + 1, 0x61),
    Buffer.from('not-json'),
  ]) {
    assert.throws(() => parseControlCommand(invalid), /invalid-request/);
  }
});

test('control failures contain only a stable code and never exception detail', () => {
  const response = controlErrorResponse(
    '40000000-0000-4000-8000-000000000186',
    'operation-failed'
  );
  assert.deepEqual(response, {
    version: 1,
    id: '40000000-0000-4000-8000-000000000186',
    ok: false,
    error: { code: 'operation-failed' },
  });
  assert.equal(JSON.stringify(response).includes('message'), false);
  assert.equal(JSON.stringify(response).includes('stack'), false);
});

test('the loopback HTTP boundary rejects credentials, browser origins, preflight, and wrong media types', () => {
  const valid = {
    remoteAddress: '127.0.0.1',
    method: 'POST',
    url: '/v1/command',
    headers: {
      'content-type': 'application/json',
      [CONTROL_HEADER_NAME]: CONTROL_HEADER_VALUE,
    },
  };
  assert.equal(classifyControlRequest(valid), 'command');
  assert.equal(classifyControlRequest({ ...valid, method: 'GET', url: '/v1/health' }), 'health');
  for (const candidate of [
    { ...valid, remoteAddress: '127.0.0.2' },
    { ...valid, headers: { ...valid.headers, cookie: 'private=value' } },
    { ...valid, headers: { ...valid.headers, authorization: 'Bearer private' } },
    { ...valid, headers: { ...valid.headers, 'proxy-authorization': 'Basic private' } },
    { ...valid, headers: { ...valid.headers, origin: 'http://127.0.0.1:9999' } },
    { ...valid, headers: { ...valid.headers, 'x-skyjo-unexpected': '1' } },
    { ...valid, headers: { ...valid.headers, 'content-type': 'text/plain' } },
    { ...valid, headers: { 'content-type': 'application/json' } },
  ]) {
    assert.equal(classifyControlRequest(candidate), 'forbidden');
  }
  assert.equal(classifyControlRequest({ ...valid, method: 'OPTIONS' }), 'not-found');
});

test('the control server serializes concurrent browser mutations', async (t) => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const server = createControlServer({
    async execute(parsed) {
      calls.push(parsed.id);
      if (calls.length === 1) await firstGate;
      return { state: 'idle' };
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const endpoint = `http://127.0.0.1:${address.port}/v1/command`;
  const headers = {
    'content-type': 'application/json',
    [CONTROL_HEADER_NAME]: CONTROL_HEADER_VALUE,
  };
  const firstID = '40000000-0000-4000-8000-000000000186';
  const secondID = '40000000-0000-4000-8000-000000000187';
  const first = fetch(endpoint, {
    method: 'POST',
    headers,
    body: command({ id: firstID }),
  });
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = fetch(endpoint, {
    method: 'POST',
    headers,
    body: command({ id: secondID }),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(calls, [firstID]);
  releaseFirst();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(calls, [firstID, secondID]);
});

test('malformed startup fails with one generic diagnostic and never echoes input', async () => {
  const sentinel = 'SENSITIVE-STARTUP-SENTINEL';
  const child = spawn(process.execPath, [driverPath], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    version: 1,
    type: 'start',
    serverOrigin: 'http://127.0.0.1:4180',
    password: sentinel,
  }) + '\n');
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, 'ERROR: mixed PWA driver startup failed.\n');
  assert.equal(stderr.includes(sentinel), false);
});

test('startup rejects trailing bytes and a second line without opening Chromium', async () => {
  const child = spawn(process.execPath, [driverPath], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const valid = '{"version":1,"type":"start","serverOrigin":"http://127.0.0.1:4180"}';
  child.stdin.end(`${valid}\n${valid}\n`);
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, 'ERROR: mixed PWA driver startup failed.\n');
});

test('driver is a direct ephemeral Playwright library bridge with no retained frame history', async () => {
  const source = await fs.readFile(driverPath, 'utf8');
  assert.match(source, /from '@playwright\/test'/);
  assert.doesNotMatch(source, /playwright\.config|trace:|screenshot:|video:/);
  assert.match(source, /browser\.newContext\(\{[\s\S]*serviceWorkers: 'block'/);
  assert.match(source, /context\.addInitScript\(installControlledWebSocket\)/);
  assert.match(source, /NativeWebSocket\.prototype\.send\.call\(this, payload\);[\s\S]*NativeWebSocket\.prototype\.send\.call\(this, payload\)/);
  assert.match(source, /mode === 'holding'[\s\S]*messageBox\.isDisabled\(\)/);
  assert.match(source, /this\.heldMessageBox = messageBox[\s\S]*releaseHeldCommand\(\)[\s\S]*const messageBox = this\.heldMessageBox[\s\S]*messageBox\.isEnabled\(\)/);
  assert.match(source, /'maximum-astral': '🃏'\.repeat\(140\)/);
  assert.doesNotMatch(source, /'maximum-astral': '🃏'\.repeat\(280\)/);
  assert.doesNotMatch(source, /frames\s*=|frameHistory|console\.log|console\.error/);
});

test('the exact immutable v0.3.2 PWA wire validators retain the UTF-16 downgrade boundary', async () => {
  assert.equal(V032_RELEASE_SHA, '130114e745c66c9f72305f05a0366e3f0ca10915');
  assert.equal(V032_ROOM_CONNECTION_SHA256, 'f298980f1020f7d201628e51be68227b842caeacfe7b79c16860980ccc99acd9');
  assert.equal(V032_PROTOCOL_V2_SHA256, 'd57283c7ea9b4662bd316d1fe1d3dc5d043dbccfb2ddd00b477266d9c26f334b');
  assert.deepEqual(await verifyV032PWACompatibility(repositoryRoot), {
    release: V032_RELEASE_SHA,
    maximumAstralScalars: 140,
    maximumUTF16Units: 280,
    nextAstralScalarsRejected: 141,
    inboundSnapshotValidated: true,
  });
});
