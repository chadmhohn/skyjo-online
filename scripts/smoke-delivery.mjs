import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runPublicReleaseSmoke } from './smoke-public-release.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const fullSha = 'a'.repeat(40);

async function withPublicFixture({ legacy = false } = {}, callback) {
  const server = http.createServer((request, response) => {
    const noStore = { 'cache-control': 'no-store' };
    if (request.url === '/healthz') {
      response.writeHead(200, { ...noStore, 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    if (request.url === '/manifest.webmanifest') {
      response.writeHead(200, { ...noStore, 'content-type': 'application/manifest+json' });
      response.end(JSON.stringify({ id: '/', name: 'Skyjo Online', icons: [{ src: '/icon.png' }] }));
      return;
    }
    if (request.url === '/login') {
      response.writeHead(200, { ...noStore, 'content-type': 'text/html; charset=utf-8' });
      response.end('<form method="post" action="/login"></form>');
      return;
    }
    if (!legacy && request.url === '/readyz') {
      response.writeHead(200, { ...noStore, 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ready',
        releaseSha: fullSha,
        checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
      }));
      return;
    }
    if (!legacy && request.url === '/version') {
      response.writeHead(200, { ...noStore, 'content-type': 'application/json' });
      response.end(JSON.stringify({
        releaseSha: fullSha,
        buildTimestamp: '2026-07-11T00:00:00.000Z',
        protocolVersion: 1
      }));
      return;
    }
    response.writeHead(302, { location: '/login' });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testPublicSmoke() {
  await withPublicFixture({}, async (baseUrl) => {
    const result = await runPublicReleaseSmoke({ baseUrl, releaseSha: fullSha, timeoutMs: 250, retryMs: 10 });
    assert.equal(result.releaseSha, fullSha);
    await assert.rejects(
      runPublicReleaseSmoke({ baseUrl, releaseSha: 'b'.repeat(40), timeoutMs: 50, retryMs: 10 }),
      /wrong release/i
    );
  });
  await withPublicFixture({ legacy: true }, async (baseUrl) => {
    await assert.rejects(runPublicReleaseSmoke({ baseUrl, timeoutMs: 50, retryMs: 10 }), /readyz/i);
    const result = await runPublicReleaseSmoke({ baseUrl, allowLegacyRollback: true, timeoutMs: 100, retryMs: 10 });
    assert.equal(result.legacy, true);
  });
}

async function testWorkflowContract() {
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- ["']v\*["']/);
  assert.match(workflow, /uses: actions\/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f/);
  assert.match(workflow, /release-canary:[\s\S]*?queue: max/);
  assert.match(workflow, /production:[\s\S]*?github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /runtime-artifact:[\s\S]*?Download the one tested production build[\s\S]*?npm run release:artifact/);
  const artifactJob = workflow.match(/\n  runtime-artifact:[\s\S]*?\n  release-canary:/)?.[0] || '';
  assert.doesNotMatch(artifactJob, /npm run build(?:\s|$)/, 'artifact job must consume the quality build without rebuilding');
  for (const job of ['unit-domain', 'unit-data', 'e2e-chromium-1', 'e2e-chromium-2', 'e2e-webkit', 'visual-accessibility', 'lighthouse']) {
    assert.match(workflow, new RegExp(`release-canary:[\\s\\S]*?- ${job}`), `release canary must wait for ${job}`);
  }

  const productionUnit = await fs.readFile(path.join(root, 'deploy', 'systemd', 'skyjo-online.service'), 'utf8');
  const canaryUnit = await fs.readFile(path.join(root, 'deploy', 'systemd', 'skyjo-online-canary@.service'), 'utf8');
  const smokeUnit = await fs.readFile(path.join(root, 'deploy', 'systemd', 'skyjo-online-smoke@.service'), 'utf8');
  for (const unit of [productionUnit, canaryUnit, smokeUnit]) {
    assert.match(unit, /^User=skyjo$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /\/opt\/skyjo-online\/node\/bin\/node/);
    assert.doesNotMatch(unit, /\/usr\/bin\/node/);
  }
  assert.match(canaryUnit, /^Environment=PORT=4181$/m);
  assert.doesNotMatch(canaryUnit, /\/var\/lib\/skyjo-online/);
  assert.match(canaryUnit, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.doesNotMatch(smokeUnit, /^Requires=/m);
  assert.match(smokeUnit, /smoke-launcher\.mjs/);
}

async function testLinuxRemoteClient() {
  if (process.platform !== 'linux') return 'skipped outside Linux';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-delivery-smoke-'));
  try {
    const archiveName = `skyjo-runtime-${fullSha}.tar.gz`;
    const archive = path.join(temp, archiveName);
    const checksum = `${archive}.sha256`;
    const identity = path.join(temp, 'identity');
    const knownHosts = path.join(temp, 'known_hosts');
    const log = path.join(temp, 'ssh.log');
    const fakeSsh = path.join(temp, 'ssh');
    const payload = Buffer.from('deterministic-runtime-archive');
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    await Promise.all([
      fs.writeFile(archive, payload),
      fs.writeFile(checksum, `${digest}  ${archiveName}\n`),
      fs.writeFile(identity, 'test-key\n'),
      fs.writeFile(knownHosts, 'example.test ssh-ed25519 test\n'),
      fs.writeFile(fakeSsh, `#!/usr/bin/env bash\nset -Eeuo pipefail\nprintf '%s\\n' "\${*: -1}" >> "$SKYJO_FAKE_SSH_LOG"\nif [[ "\${*: -1}" == upload\\ * ]]; then wc -c >> "$SKYJO_FAKE_SSH_LOG"; else printf '{"legacy":false}\\n'; fi\n`)
    ]);
    await fs.chmod(fakeSsh, 0o700);
    const env = {
      ...process.env,
      SKYJO_DEPLOY_HOST: 'deploy.example.test',
      SKYJO_DEPLOY_PORT: '22',
      SKYJO_DEPLOY_USER: 'skyjo-deploy',
      SKYJO_DEPLOY_IDENTITY_FILE: identity,
      SKYJO_DEPLOY_KNOWN_HOSTS_FILE: knownHosts,
      SKYJO_FAKE_SSH_LOG: log,
      SKYJO_SSH_BIN: fakeSsh
    };
    const client = path.join(root, 'deploy', 'github-release-remote.sh');
    await execFileAsync('bash', [client, 'verify', '123-1-canary', fullSha, archive, checksum], { env });
    await execFileAsync('bash', [client, 'promote', '123-1-production', fullSha, archive, checksum, 'v0.1.1'], { env });
    await execFileAsync('bash', [client, 'rollback', '123-1-production', fullSha, checksum, 'v0.1.1'], { env });
    const calls = await fs.readFile(log, 'utf8');
    assert.match(calls, new RegExp(`upload 123-1-canary ${fullSha} ${payload.length}`));
    assert.match(calls, new RegExp(`verify 123-1-canary ${fullSha} ${digest}`));
    assert.match(calls, new RegExp(`promote 123-1-production ${fullSha} ${digest} v0\\.1\\.1`));
    assert.match(calls, new RegExp(`rollback 123-1-production ${fullSha} ${digest} v0\\.1\\.1`));
    await assert.rejects(
      execFileAsync('bash', [client, 'promote', '123-1-production', fullSha, archive, checksum, 'main'], { env }),
      /immutable release tag/i
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  return 'passed';
}

await testPublicSmoke();
await testWorkflowContract();
const linuxRemote = await testLinuxRemoteClient();
console.log(`delivery smoke passed: public/current and explicit legacy recovery, build-once CI contract, hardened units, remote transport ${linuxRemote}`);
