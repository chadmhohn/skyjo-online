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
  assert.match(workflow, /\n  workflow_dispatch:\s*\n\s*\npermissions:/,
    'recovery dispatch must accept only the selected immutable ref, never a mutable SHA input');
  assert.match(workflow, /uses: actions\/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f/);
  assert.match(workflow, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(workflow, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.match(workflow, /actionlint.*-ignore 'unexpected\.key\.\.queue\.'/);
  assert.equal((workflow.match(/--deny-self-hosted-runners/g) || []).length, 3);
  assert.equal((workflow.match(/--signer-workflow/g) || []).length, 3);
  assert.equal((workflow.match(/--source-digest/g) || []).length, 3);
  assert.equal((workflow.match(/--source-ref/g) || []).length, 3);
  assert.equal((workflow.match(/id-token: write/g) || []).length, 1,
    'only the trusted attestation job may mint an Actions OIDC token');
  assert.equal((workflow.match(/attestations: write/g) || []).length, 1,
    'only the trusted attestation job may publish provenance');
  assert.match(workflow, /secrets\.SKYJO_CANARY_AUTH_PRIVATE_KEY/);
  assert.match(workflow, /secrets\.SKYJO_PRODUCTION_AUTH_PRIVATE_KEY/);
  assert.equal((workflow.match(/vars\.SKYJO_DEPLOY_AUTH_KEY_ID/g) || []).length, 2);
  assert.equal((workflow.match(/SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE:/g) || []).length, 2);
  assert.doesNotMatch(workflow, /SKYJO_DEPLOY_AUTH_PRIVATE_KEY:/);
  assert.match(workflow, /release-canary:[\s\S]*?queue: max/);
  assert.match(workflow, /runtime-artifact:[\s\S]*?Download the one tested production build[\s\S]*?npm run release:artifact/);
  const artifactJob = workflow.match(/\n  runtime-artifact:[\s\S]*?\n  attest-runtime:/)?.[0] || '';
  const attestationJob = workflow.match(/\n  attest-runtime:[\s\S]*?\n  release-canary:/)?.[0] || '';
  const canaryJob = workflow.match(/\n  release-canary:[\s\S]*?\n  production:/)?.[0] || '';
  const productionJob = workflow.match(/\n  production:[\s\S]*$/)?.[0] || '';
  assert.match(artifactJob, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(artifactJob, /id-token:|attestations:|attest-build-provenance|GH_TOKEN:/,
    'PR-controlled runtime packaging must not receive or request provenance authority');
  assert.doesNotMatch(artifactJob, /npm run build(?:\s|$)/, 'artifact job must consume the quality build without rebuilding');
  const protectedBuildDispatch = /if: \(github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\)\) \|\| \(github\.event_name == 'workflow_dispatch' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)\)\)/;
  assert.match(attestationJob, protectedBuildDispatch,
    'only exact main or immutable tag dispatches may mint provenance');
  assert.match(canaryJob, protectedBuildDispatch,
    'only exact main or immutable tag dispatches may reach the VPS canary');
  assert.match(productionJob, /if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    'a recovery dispatch may reach production only when the selected ref is an immutable v* tag');
  assert.doesNotMatch(productionJob, /refs\/heads\/main/,
    'main dispatch must never reach production');
  assert.match(attestationJob, /needs:\s*\n\s*- runtime-artifact/);
  assert.match(attestationJob, /permissions:[\s\S]*?id-token: write[\s\S]*?attestations: write/);
  assert.match(attestationJob, /uses: actions\/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f/);
  assert.doesNotMatch(attestationJob, /actions\/checkout@|npm (?:ci|run)|node scripts\//,
    'the privileged attestation job must not execute repository-controlled code');
  assert.match(workflow, /release-canary:[\s\S]*?needs:[\s\S]*?- attest-runtime/);
  assert.match(workflow, /production:[\s\S]*?needs:[\s\S]*?- attest-runtime/);
  assert.match(workflow, /parse-code-rollback-result\.mjs --failed-release-sha "\$sha"/);
  assert.match(workflow, /smoke-public-release\.mjs --base-url "\$SKYJO_PUBLIC_BASE_URL" --release-sha "\$rollback_target"/);
  assert.doesNotMatch(workflow, /rollback_result.*=~.*legacy/);
  assert.doesNotMatch(workflow, /GITHUB_RUN_ATTEMPT/, 'workflow reruns must retain the same journal operation identity');
  assert.match(workflow, /run_id="\$\{GITHUB_RUN_ID\}-1-canary"/);
  assert.match(workflow, /run_id="\$\{GITHUB_RUN_ID\}-1-production"/);
  assert.equal((workflow.match(/rm -rf -- "\$RUNNER_TEMP\/skyjo-ssh"/g) || []).length, 2,
    'both deployment lanes must remove the complete credential directory');
  for (const job of ['unit-domain', 'unit-data', 'e2e-chromium-1', 'e2e-chromium-2', 'e2e-webkit', 'visual-accessibility', 'lighthouse']) {
    assert.match(workflow, new RegExp(`release-canary:[\\s\\S]*?- ${job}`), `release canary must wait for ${job}`);
  }

  const productionUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online.service'), 'utf8');
  const canaryUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-canary@.service'), 'utf8');
  const canarySmokeUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-canary-smoke@.service'), 'utf8');
  const productionSmokeUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-smoke@.service'), 'utf8');
  const stateProofUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-state-proof@.service'), 'utf8');
  const legacyProofUnit = await fs.readFile(path.join(root, 'deploy', 'skyjo-online-legacy-proof@.service'), 'utf8');
  const canaryLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-canary-launch'), 'utf8');
  const smokeLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-smoke-launch'), 'utf8');
  const stateProofLauncher = await fs.readFile(path.join(root, 'deploy', 'skyjo-state-proof-launch'), 'utf8');
  for (const unit of [productionUnit, canaryUnit, canarySmokeUnit, productionSmokeUnit, stateProofUnit, legacyProofUnit]) {
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /^RestrictNamespaces=true$/m);
    assert.match(unit, /^UMask=0077$/m);
    assert.doesNotMatch(unit, /\/usr\/bin\/node/);
  }
  assert.match(productionUnit, /^User=skyjo$/m);
  assert.match(productionSmokeUnit, /^User=skyjo$/m);
  assert.match(legacyProofUnit, /^User=skyjo$/m);
  assert.match(legacyProofUnit, /^EnvironmentFile=\/etc\/skyjo-online\.env$/m);
  assert.doesNotMatch(legacyProofUnit, /^InaccessiblePaths=/m);
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
  const bootstrapSafetyRegression = await bashPath(path.join(root, 'deploy', 'tests', 'bootstrap-safety.test.sh'));
  await execFileAsync(bash, [bootstrapSafetyRegression]);
  const nodeGuardRegression = await bashPath(path.join(root, 'deploy', 'tests', 'node-runtime-guard.test.sh'));
  await execFileAsync(bash, [nodeGuardRegression]);
  const bootstrapGuardRegression = await bashPath(path.join(root, 'deploy', 'tests', 'bootstrap-generation-guard.test.sh'));
  await execFileAsync(bash, [bootstrapGuardRegression]);
  const activationTransactionRegression = await bashPath(path.join(root, 'deploy', 'tests', 'activation-transaction.test.sh'));
  await execFileAsync(bash, [activationTransactionRegression]);
  const activationUnitStateRegression = await bashPath(path.join(root, 'deploy', 'tests', 'activation-unit-state.test.sh'));
  await execFileAsync(bash, [activationUnitStateRegression]);
  const adoptionStateRegression = await bashPath(path.join(root, 'deploy', 'tests', 'adoption-state.test.sh'));
  await execFileAsync(bash, [adoptionStateRegression]);
  const legacyProofEnvironmentRegression = await bashPath(path.join(root, 'deploy', 'tests', 'legacy-proof-environment.test.sh'));
  await execFileAsync(bash, [legacyProofEnvironmentRegression]);
  const legacyProofUnitCleanupRegression = await bashPath(path.join(root, 'deploy', 'tests', 'legacy-proof-unit-cleanup.test.sh'));
  await execFileAsync(bash, [legacyProofUnitCleanupRegression], { timeout: 60_000 });
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
      bashIdentity, bashKnownHosts, bashCanaryKey, bashProductionKey, bashLog, bashState,
      bashFakeSsh, bashClient, bashArchive, bashChecksum
    ] = await Promise.all([
      identity, knownHosts, canaryAuthorizationKey, productionAuthorizationKey, log, state,
      fakeSsh, path.join(root, 'deploy', 'github-release-remote.sh'), archive, checksum
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
    const canaryEnv = {
      ...baseEnv,
      SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE: bashCanaryKey,
      SKYJO_DEPLOY_AUTH_KEY_ID: 'canary-2026-07',
      SKYJO_FAKE_PRIVILEGED_DISCONNECT: 'all',
      SKYJO_FAKE_PRIVILEGED_CONFLICT: 'once'
    };
    const productionEnv = {
      ...baseEnv,
      SKYJO_DEPLOY_AUTH_PRIVATE_KEY_FILE: bashProductionKey,
      SKYJO_DEPLOY_AUTH_KEY_ID: 'production-2026-07',
      SKYJO_FAKE_PRIVILEGED_DISCONNECT: 'all',
      SKYJO_FAKE_PRIVILEGED_CONFLICT: 'once'
    };
    const verify = await execFileAsync(bash, [bashClient, 'verify', '123-1-canary', fullSha, bashArchive, bashChecksum], { env: canaryEnv });
    assert.equal(verify.stdout, `{"verified":"${fullSha}","activated":false}\nverify completed for release ${fullSha}.\n`);
    const promote = await execFileAsync(bash, [bashClient, 'promote', '123-1-production', fullSha, bashArchive, bashChecksum, 'v0.1.1'], { env: productionEnv });
    assert.equal(promote.stdout, `{"promoted":"${fullSha}","tag":"v0.1.1","backup":"20260712T010203Z-pre-${fullSha}"}\npromote completed for release ${fullSha}.\n`);
    const rollback = await execFileAsync(bash, [bashClient, 'rollback', '123-1-production', fullSha, bashChecksum, 'v0.1.1'], { env: productionEnv });
    assert.equal(rollback.stdout, `{"rolledBackTo":"${'0'.repeat(40)}","legacy":false}\n`);
    const calls = await fs.readFile(log, 'utf8');
    const commandLines = calls.trim().split('\n');
    const canaryUploads = commandLines.filter((line) => line.startsWith('upload 123-1-canary '));
    const productionUploads = commandLines.filter((line) => line.startsWith('upload 123-1-production '));
    const canaryVerifications = commandLines.filter((line) => line.startsWith('verify 123-1-canary '));
    const promotions = commandLines.filter((line) => line.startsWith('promote 123-1-production '));
    const rollbacks = commandLines.filter((line) => line.startsWith('rollback 123-1-production '));
    assert.equal(canaryUploads.length, 2, 'a post-publication disconnect must retry upload exactly once');
    assert.equal(canaryUploads[0], canaryUploads[1], 'the upload retry must be byte-for-byte identical');
    assert.equal(productionUploads.length, 1, 'successful upload must not be repeated');
    for (const [name, commands] of [['verify', canaryVerifications], ['promote', promotions], ['rollback', rollbacks]]) {
      assert.equal(commands.length, 3, `${name} must retry after a lost acknowledgement and wait behind the retained flock`);
      assert.equal(new Set(commands).size, 1, `${name} retries must reuse the exact signed command`);
      assert.equal(await fs.readFile(path.join(state, `${name}-${name === 'verify' ? '123-1-canary' : '123-1-production'}.applied`), 'utf8'), '1\n');
      assert.equal(await fs.readFile(path.join(state, `${name}-${name === 'verify' ? '123-1-canary' : '123-1-production'}.retry`), 'utf8'), '1\n');
    }
    assert.equal(await fs.readFile(path.join(state, '123-1-canary.applied'), 'utf8'), '1\n');
    assert.equal(await fs.readFile(path.join(state, '123-1-canary.retries'), 'utf8'), '1\n');
    assert.equal(await fs.readFile(path.join(state, '123-1-production.applied'), 'utf8'), '1\n');
    assert.match(calls, new RegExp(`upload 123-1-canary ${fullSha} ${payload.length}`));
    assert.match(calls, new RegExp(`verify 123-1-canary ${fullSha} ${digest} - [0-9]+ [0-9]+ canary-2026-07 [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`promote 123-1-production ${fullSha} ${digest} v0\\.1\\.1 [0-9]+ [0-9]+ production-2026-07 [A-Za-z0-9_-]{86}`));
    assert.match(calls, new RegExp(`rollback 123-1-production ${fullSha} ${digest} v0\\.1\\.1 [0-9]+ [0-9]+ production-2026-07 [A-Za-z0-9_-]{86}`));
    await assert.rejects(execFileAsync(bash, [bashClient, 'verify', '124-1-canary', fullSha, bashArchive, bashChecksum], {
      env: { ...canaryEnv, SKYJO_FAKE_CONTROLLER_RESULT: 'empty', SKYJO_FAKE_PRIVILEGED_DISCONNECT: '' }
    }), /invalid or incomplete result/i);
    await assert.rejects(execFileAsync(bash, [bashClient, 'verify', '125-1-canary', fullSha, bashArchive, bashChecksum], {
      env: { ...canaryEnv, SKYJO_FAKE_CONTROLLER_RESULT: 'malformed', SKYJO_FAKE_PRIVILEGED_DISCONNECT: '' }
    }), /invalid or incomplete result/i);
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
console.log(`delivery smoke passed: public/current and explicit legacy recovery, build-once CI contract, hardened units, immutable bootstrap, atomic Node installer and remote transport ${linuxRemote}`);
