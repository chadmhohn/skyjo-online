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
  const artifactJob = workflow.match(/\n  runtime-artifact:[\s\S]*?\n  runtime-attestation:/)?.[0] || '';
  assert.doesNotMatch(artifactJob, /npm run build(?:\s|$)/, 'artifact job must consume the quality build without rebuilding');
  assert.doesNotMatch(artifactJob, /id-token: write|attestations: write/, 'PR-controlled packaging must not receive provenance credentials');
  assert.match(workflow, /runtime-attestation:[\s\S]*?id-token: write[\s\S]*?attestations: write/);
  assert.match(workflow, /AUTH_KEY: \$\{\{ secrets\.SKYJO_DEPLOY_AUTH_PRIVATE_KEY \}\}/);
  for (const policy of [
    '--signer-workflow "github.com/$GITHUB_REPOSITORY/.github/workflows/ci.yml"',
    '--source-digest "${{ needs.runtime-artifact.outputs.source-sha }}"',
    '--source-ref "$GITHUB_REF"',
    '--deny-self-hosted-runners'
  ]) {
    assert.equal(workflow.split(policy).length - 1, 3, `every attestation stage must enforce ${policy}`);
  }
  assert.match(workflow, /parse-code-rollback-result\.mjs --failed-release-sha "\$sha"/);
  assert.match(workflow, /--release-sha "\$rollback_target"/);
  assert.doesNotMatch(workflow, /rollback_result.*=~.*legacy/);
  for (const job of ['unit-domain', 'unit-data', 'e2e-chromium-1', 'e2e-chromium-2', 'e2e-webkit', 'visual-accessibility', 'lighthouse']) {
    assert.match(workflow, new RegExp(`release-canary:[\\s\\S]*?- ${job}`), `release canary must wait for ${job}`);
  }

  const productionUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online.service'), 'utf8');
  const canaryUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-canary@.service'), 'utf8');
  const canarySmokeUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-canary-smoke@.service'), 'utf8');
  const productionSmokeUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-smoke@.service'), 'utf8');
  const stateProofUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-state-proof@.service'), 'utf8');
  const canaryLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-canary-launch'), 'utf8');
  const smokeLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-smoke-launch'), 'utf8');
  const stateProofLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-state-proof-launch'), 'utf8');
  for (const unit of [productionUnit, canaryUnit, canarySmokeUnit, productionSmokeUnit, stateProofUnit]) {
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /^RestrictNamespaces=true$/m);
    assert.match(unit, /^UMask=0077$/m);
    assert.doesNotMatch(unit, /\/usr\/bin\/node/);
  }
  assert.match(productionUnit, /^User=skyjo$/m);
  assert.match(productionSmokeUnit, /^User=skyjo$/m);
  for (const unit of [canaryUnit, canarySmokeUnit, stateProofUnit]) {
    assert.match(unit, /^User=skyjo-canary$/m);
    assert.doesNotMatch(unit, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
    assert.match(unit, /^InaccessiblePaths=\/var\/lib\/skyjo-online \/etc\/skyjo-online\.env$/m);
    assert.doesNotMatch(unit, /^PrivateTmp=true$/m);
  }
  assert.match(productionUnit, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.match(canaryLauncher, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.match(smokeLauncher, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.match(stateProofLauncher, /\/opt\/skyjo-online\/node\/bin\/node/);
  assert.doesNotMatch(canaryUnit, /^ReadWritePaths=.*\/var\/lib\/skyjo-online/m);
  assert.match(canaryUnit, /^IPAddressDeny=any$/m);
  assert.match(canaryUnit, /^IPAddressAllow=localhost$/m);
  assert.match(canaryUnit, /^ReadWritePaths=\/var\/tmp\/skyjo-deploy\/%i$/m);
  assert.match(canarySmokeUnit, /^IPAddressDeny=any$/m);
  assert.match(canarySmokeUnit, /^IPAddressAllow=localhost$/m);
  assert.match(stateProofUnit, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.doesNotMatch(stateProofUnit, /^IPAddressAllow=/m);
  assert.doesNotMatch(productionSmokeUnit, /^Requires=/m);
  assert.match(productionSmokeUnit, /skyjo-smoke-launch/);
  assert.match(stateProofLauncher, /"\$release\/scripts\/backup-state\.mjs"/);
  assert.match(stateProofLauncher, /"\$release\/scripts\/verify-state-backup\.mjs"/);
}

async function testLinuxRemoteClient() {
  const bash = process.env.SKYJO_TEST_BASH || (process.platform === 'linux' ? 'bash' : '');
  if (!bash) return 'skipped without a POSIX Bash runtime';
  const bashPath = async (value) => {
    if (process.platform !== 'win32') return value;
    const { stdout } = await execFileAsync(bash, ['-c', 'cygpath -u "$1"', '_', value]);
    return stdout.trim();
  };
  const installerRegression = await bashPath(path.join(root, 'deploy', 'tests', 'node-runtime-installer.test.sh'));
  await execFileAsync(bash, [installerRegression]);
  const transportKeyRegression = await bashPath(path.join(root, 'deploy', 'tests', 'transport-key-crlf.test.sh'));
  await execFileAsync(bash, [transportKeyRegression]);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-delivery-smoke-'));
  try {
    const archiveName = `skyjo-runtime-${fullSha}.tar.gz`;
    const archive = path.join(temp, archiveName);
    const checksum = `${archive}.sha256`;
    const identity = path.join(temp, 'identity');
    const knownHosts = path.join(temp, 'known_hosts');
    const canaryAuthorizationKey = path.join(temp, 'canary-auth.pem');
    const productionAuthorizationKey = path.join(temp, 'production-auth.pem');
    const log = path.join(temp, 'ssh.log');
    const state = path.join(temp, 'ssh-state');
    const fakeSsh = path.join(temp, 'ssh');
    const payload = Buffer.from('deterministic-runtime-archive');
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const canaryKeys = crypto.generateKeyPairSync('ed25519');
    const productionKeys = crypto.generateKeyPairSync('ed25519');
    await Promise.all([
      fs.writeFile(archive, payload),
      fs.writeFile(checksum, `${digest}  ${archiveName}\n`),
      fs.writeFile(identity, 'test-key\n'),
      fs.writeFile(knownHosts, 'example.test ssh-ed25519 test\n'),
      fs.writeFile(canaryAuthorizationKey, canaryKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }),
      fs.writeFile(productionAuthorizationKey, productionKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }),
      fs.mkdir(state),
      fs.copyFile(path.join(root, 'deploy', 'tests', 'fake-ssh-disconnect.sh'), fakeSsh)
    ]);
    await fs.chmod(fakeSsh, 0o700);
    const [
      bashIdentity, bashKnownHosts, bashCanaryAuthorizationKey, bashProductionAuthorizationKey,
      bashLog, bashState, bashFakeSsh, bashClient, bashArchive, bashChecksum
    ] = await Promise.all([
      identity, knownHosts, canaryAuthorizationKey, productionAuthorizationKey,
      log, state, fakeSsh, path.join(root, 'deploy', 'github-release-remote.sh'), archive, checksum
    ].map(bashPath));
    const baseEnv = {
      ...process.env,
      SKYJO_DEPLOY_HOST: 'deploy.example.test',
      SKYJO_DEPLOY_PORT: '22',
      SKYJO_DEPLOY_USER: 'skyjo-deploy',
      SKYJO_DEPLOY_IDENTITY_FILE: bashIdentity,
      SKYJO_DEPLOY_KNOWN_HOSTS_FILE: bashKnownHosts,
      SKYJO_FAKE_SSH_LOG: bashLog,
      SKYJO_FAKE_SSH_STATE: bashState,
      SKYJO_SSH_BIN: bashFakeSsh
    };
    const canaryEnv = { ...baseEnv, SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE: bashCanaryAuthorizationKey };
    const productionEnv = { ...baseEnv, SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE: bashProductionAuthorizationKey };
    const verifyExecution = await execFileAsync(bash, [bashClient, 'verify', '123-1-canary', fullSha, bashArchive, bashChecksum], { env: canaryEnv });
    assert.equal(verifyExecution.stdout, `{"verified":"${fullSha}","activated":false}\nverify completed for release ${fullSha}.\n`);
    const promoteExecution = await execFileAsync(bash, [bashClient, 'promote', '123-1-production', fullSha, bashArchive, bashChecksum, 'v0.1.1'], { env: productionEnv });
    assert.match(promoteExecution.stdout, new RegExp(`^\\{"promoted":"${fullSha}","tag":"v0\\.1\\.1","backup":"[^"]+"\\}\\npromote completed for release ${fullSha}\\.\\n$`));
    const rollbackExecution = await execFileAsync(bash, [bashClient, 'rollback', '123-1-production', fullSha, bashChecksum, 'v0.1.1'], { env: productionEnv });
    assert.equal(rollbackExecution.stdout, `{"rolledBackTo":"${'0'.repeat(40)}","legacy":false}\n`);
    const calls = await fs.readFile(log, 'utf8');
    const commandLines = calls.trim().split('\n');
    const canaryUploads = commandLines.filter((line) => line.startsWith('upload 123-1-canary '));
    const productionUploads = commandLines.filter((line) => line.startsWith('upload 123-1-production '));
    const canaryVerifications = commandLines.filter((line) => line.startsWith('verify 123-1-canary '));
    assert.equal(canaryUploads.length, 2, 'a post-publication disconnect must retry upload exactly once');
    assert.equal(canaryUploads[0], canaryUploads[1], 'the retry must reuse the exact signed authorization');
    assert.equal(productionUploads.length, 1, 'a successful upload must not be repeated');
    assert.equal(canaryVerifications.length, 1, 'an upload retry must not duplicate candidate execution');
    assert.equal(await fs.readFile(path.join(state, '123-1-canary.applied'), 'utf8'), '1\n');
    assert.equal(await fs.readFile(path.join(state, '123-1-canary.retries'), 'utf8'), '1\n');
    assert.equal(await fs.readFile(path.join(state, '123-1-production.applied'), 'utf8'), '1\n');
    assert.match(calls, new RegExp(`upload 123-1-canary ${fullSha} ${digest} ${payload.length} - [0-9]+ [0-9]+ canary-primary [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`verify 123-1-canary ${fullSha} ${digest} ${payload.length} - [0-9]+ [0-9]+ canary-primary [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`upload 123-1-production ${fullSha} ${digest} ${payload.length} v0\\.1\\.1 [0-9]+ [0-9]+ production-primary [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`promote 123-1-production ${fullSha} ${digest} ${payload.length} v0\\.1\\.1 [0-9]+ [0-9]+ production-primary [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`rollback 123-1-production ${fullSha} ${digest} ${payload.length} v0\\.1\\.1 [0-9]+ [0-9]+ production-primary [A-Za-z0-9_-]{86}`));
    await assert.rejects(
      execFileAsync(bash, [bashClient, 'verify', '124-1-canary', fullSha, bashArchive, bashChecksum], {
        env: { ...canaryEnv, SKYJO_FAKE_CONTROLLER_RESULT: 'empty' }
      }),
      /invalid or incomplete result/i
    );
    await assert.rejects(
      execFileAsync(bash, [bashClient, 'verify', '125-1-canary', fullSha, bashArchive, bashChecksum], {
        env: { ...canaryEnv, SKYJO_FAKE_CONTROLLER_RESULT: 'failed' }
      }),
      /transport or execution failed/i
    );
    await assert.rejects(
      execFileAsync(bash, [bashClient, 'promote', '123-1-production', fullSha, bashArchive, bashChecksum, 'main'], { env: productionEnv }),
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
console.log(`delivery smoke passed: public/current and explicit legacy recovery, build-once CI contract, hardened units, atomic Node installer and remote transport ${linuxRemote}`);
