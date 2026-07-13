import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createAccountStore } from '../../server-account-store.mjs';
import { saveRoomsToDisk } from '../../server-room-persistence.mjs';
import { CURRENT_PROTOCOL_VERSION, writeReleaseIdentity } from '../../server-release.mjs';
import {
  governanceRuleset,
  assertDependabotReadbacks,
  assertGovernanceReadbacks,
  checkRunIntegrations,
  immutableReleaseTagsRuleset,
  reconcileGithubGovernance,
  releaseTagCreationRuleset,
  REQUIRED_CHECKS,
  repositorySettings
} from '../../scripts/github-governance-lib.mjs';
import {
  INCIDENT_MARKER,
  reconcileProductionIncident
} from '../../scripts/production-incident-lib.mjs';
import {
  normalizeMonitorBaseUrl,
  probeReadiness,
  validateReadinessPayload,
  writeMonitorResult
} from '../../scripts/readiness-monitor-lib.mjs';
import {
  enforceBackupRetention,
  RETENTION,
  runScheduledBackup,
  scheduledBackupName
} from '../../scripts/scheduled-backup-lib.mjs';
import { REQUIRED_ARCHIVE_ENTRIES } from '../release-controller-lib.mjs';
import { validateOperationsReadiness } from '../validate-operations-readiness.mjs';
import { REQUIRED_ARCHIVE_FILES } from '../../scripts/runtime-artifact-security.mjs';

const deployRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(deployRoot, '..');
const fixedNow = new Date('2026-07-11T12:34:56.000Z');
const releaseSha = 'a'.repeat(40);
const execFileAsync = promisify(execFile);
const repositoryOwner = { login: 'owner', type: 'User', id: 42 };

function requiredCheckRun(name, index, overrides = {}) {
  return {
    id: 10_000 + index,
    name,
    head_sha: releaseSha,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-07-12T19:40:00Z',
    app: { id: 15368 },
    ...overrides
  };
}

function requiredCheckResponse(overrides = {}) {
  const checkRuns = REQUIRED_CHECKS.map((name, index) => requiredCheckRun(name, index));
  return {
    total_count: checkRuns.length,
    check_runs: checkRuns,
    ...overrides
  };
}

function healthyResult(overrides = {}) {
  return {
    formatVersion: 1,
    monitor: 'public',
    status: 'healthy',
    checkedAt: fixedNow.toISOString(),
    attempts: 1,
    failureClass: null,
    httpStatus: 200,
    releaseSha,
    schemaVersion: 2,
    protocolVersion: 1,
    ...overrides
  };
}

async function expectProcessExit(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function createReadinessLauncherFixture(root, launcher) {
  const functionEnd = launcher.indexOf('\naction=${1:-}');
  assert.ok(functionEnd > 0, 'readiness launcher functions must be extractable');
  const harness = path.join(root, 'readiness-harness.sh');
  await fs.writeFile(harness, `${launcher.slice(0, functionEnd)}
mode=$1
shift
case "$mode" in
  run) run_readiness "$@" ;;
  safe-file) safe_readiness_file "$@" || exit 66 ;;
  safe-directory) safe_readiness_directory "$@" || exit 66 ;;
  resolve) resolve_readiness_release "$@" || exit 65 ;;
  current) readiness_current_matches "$@" || exit 65 ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });

  const uid = Number((await execFileAsync('/usr/bin/id', ['-u'])).stdout.trim());
  const gid = Number((await execFileAsync('/usr/bin/id', ['-g'])).stdout.trim());
  const groups = (await execFileAsync('/usr/bin/id', ['-Gn'])).stdout.trim();
  const releaseRoot = path.join(root, 'releases');
  const release = path.join(releaseRoot, releaseSha);
  const scripts = path.join(release, 'scripts');
  const current = path.join(root, 'current');
  const output = path.join(root, 'evidence', 'local-readiness.json');
  const node = path.join(root, 'node');
  await fs.mkdir(scripts, { recursive: true, mode: 0o755 });
  await fs.chmod(releaseRoot, 0o755);
  await fs.chmod(release, 0o755);
  await fs.chmod(scripts, 0o755);
  await fs.copyFile(path.join(repoRoot, 'scripts', 'monitor-readiness.mjs'), path.join(scripts, 'monitor-readiness.mjs'));
  await fs.copyFile(path.join(repoRoot, 'scripts', 'readiness-monitor-lib.mjs'), path.join(scripts, 'readiness-monitor-lib.mjs'));
  await fs.chmod(path.join(scripts, 'monitor-readiness.mjs'), 0o644);
  await fs.chmod(path.join(scripts, 'readiness-monitor-lib.mjs'), 0o644);
  await fs.writeFile(node, `#!/bin/sh
exec "${process.execPath}" "$@"
`, { mode: 0o755 });
  await fs.symlink(release, current);

  const args = [
    String(uid), String(gid), groups,
    String(uid), String(gid),
    node, current, releaseRoot, output
  ];
  return { root, harness, uid, gid, groups, releaseRoot, release, scripts, current, output, node, args };
}

async function runReadinessFixture(fixture, options = {}) {
  return execFileAsync('/bin/sh', [fixture.harness, 'run', ...(options.args || fixture.args)], {
    env: { ...process.env, ...(options.env || {}) }
  });
}

async function replaceSymlink(link, target) {
  await fs.unlink(link);
  await fs.symlink(target, link);
}

function response(status, body) {
  return {
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body)
  };
}

test('readiness monitor accepts only the local loopback or an HTTPS public origin', () => {
  assert.equal(normalizeMonitorBaseUrl('http://127.0.0.1:4180', 'local'), 'http://127.0.0.1:4180');
  assert.equal(normalizeMonitorBaseUrl('https://skyjo.example.com/', 'public'), 'https://skyjo.example.com');
  for (const candidate of ['http://localhost:4180', 'http://127.0.0.1:4181', 'https://127.0.0.1:4180']) {
    assert.throws(() => normalizeMonitorBaseUrl(candidate, 'local'), /restricted/);
  }
  assert.throws(() => normalizeMonitorBaseUrl('http://skyjo.example.com', 'public'), /HTTPS/);
  assert.throws(() => normalizeMonitorBaseUrl('https://user:secret@skyjo.example.com', 'public'), /credentials/);
});

test('readiness probes retain only a validated release identity and sanitized failure class', async () => {
  const payload = {
    status: 'ready', releaseSha, schemaVersion: 2, protocolVersion: 1,
    checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' },
    secret: 'must-not-propagate'
  };
  assert.deepEqual(validateReadinessPayload(payload), { releaseSha, schemaVersion: 2, protocolVersion: 1 });
  const healthy = await probeReadiness({
    monitor: 'public', baseUrl: 'https://skyjo.example.com', now: () => fixedNow,
    fetchImpl: async () => response(200, payload)
  });
  assert.deepEqual(healthy, healthyResult());
  assert.doesNotMatch(JSON.stringify(healthy), /must-not-propagate/);

  const unhealthy = await probeReadiness({
    monitor: 'public', baseUrl: 'https://skyjo.example.com', attempts: 2, now: () => fixedNow,
    sleep: async () => {}, fetchImpl: async () => response(503, 'private upstream details')
  });
  assert.equal(unhealthy.status, 'unhealthy');
  assert.equal(unhealthy.failureClass, 'http');
  assert.equal(unhealthy.httpStatus, 503);
  assert.doesNotMatch(JSON.stringify(unhealthy), /private|upstream/);
});

test('monitor evidence is an atomic normalized private JSON file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-monitor-'));
  try {
    const output = path.join(root, 'evidence', 'result.json');
    await writeMonitorResult(output, healthyResult());
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), healthyResult());
    if (process.platform !== 'win32') assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolved readiness execution replaces the symlinked false-success with trusted evidence', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-readiness-launch-'));
  try {
    const launcher = await fs.readFile(path.join(deployRoot, 'skyjo-ops-launch'), 'utf8');
    const fixture = await createReadinessLauncherFixture(root, launcher);
    const symlinkedEntry = path.join(root, 'symlinked-monitor-readiness.mjs');
    const falseOutput = path.join(root, 'false-success-evidence.json');
    await fs.symlink(path.join(repoRoot, 'scripts', 'monitor-readiness.mjs'), symlinkedEntry);
    const falseSuccess = await execFileAsync(process.execPath, [
      symlinkedEntry,
      '--monitor', 'local',
      '--base-url', 'http://127.0.0.1:4180',
      '--attempts', '1',
      '--timeout-ms', '100',
      '--output', falseOutput,
      '--fail-unhealthy'
    ]);
    assert.equal(falseSuccess.stdout, '');
    assert.equal(falseSuccess.stderr, '');
    await assert.rejects(fs.readFile(falseOutput, 'utf8'), { code: 'ENOENT' });

    const payload = {
      status: 'ready',
      releaseSha,
      schemaVersion: 2,
      protocolVersion: 1,
      checks: { database: 'ok', roomState: 'ok', lastPersist: 'ok' }
    };
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(4180, '127.0.0.1', resolve);
    });
    let result;
    try {
      result = await runReadinessFixture(fixture, {
        env: {
          NODE_OPTIONS: '--this-option-must-be-cleared',
          NODE_PATH: pathToFileURL(root).href
        }
      });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.match(result.stdout, /"monitor":"local","status":"healthy"/);
    assert.equal(result.stderr, '');
    const text = await fs.readFile(fixture.output, 'utf8');
    const evidence = JSON.parse(text);
    assert.deepEqual(evidence, healthyResult({ monitor: 'local', checkedAt: evidence.checkedAt }));
    assert.equal(text, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal((await fs.stat(fixture.output)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readiness launcher rejects identity and immutable-path drift and propagates monitor failures', {
  skip: process.platform === 'win32'
}, async () => {
  const launcherPath = path.join(deployRoot, 'skyjo-ops-launch');
  const launcher = await fs.readFile(launcherPath, 'utf8');
  await expectProcessExit(execFileAsync('/bin/sh', [launcherPath]), 64);
  await expectProcessExit(execFileAsync('/bin/sh', [launcherPath, 'unknown']), 64);
  await expectProcessExit(execFileAsync('/bin/sh', [launcherPath, 'daily', 'extra']), 64);
  await expectProcessExit(execFileAsync('/bin/sh', [launcherPath, 'readiness']), 77);

  async function rejectsFixture(mutator, code) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-readiness-reject-'));
    try {
      const fixture = await createReadinessLauncherFixture(root, launcher);
      await mutator(fixture);
      await expectProcessExit(runReadinessFixture(fixture), code);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  await rejectsFixture(async (fixture) => {
    const args = [...fixture.args];
    args[0] = String(fixture.uid + 1);
    fixture.args = args;
  }, 77);
  await rejectsFixture(async (fixture) => {
    const args = [...fixture.args];
    args[1] = String(fixture.gid + 1);
    fixture.args = args;
  }, 77);
  await rejectsFixture(async (fixture) => {
    const args = [...fixture.args];
    args[2] = `${fixture.groups} unexpected-supplemental-group`;
    fixture.args = args;
  }, 77);
  await rejectsFixture(
    (fixture) => replaceSymlink(fixture.current, path.join(fixture.root, 'outside', releaseSha)),
    65
  );
  await rejectsFixture(
    (fixture) => replaceSymlink(fixture.current, path.join(fixture.releaseRoot, 'nested', releaseSha)),
    65
  );
  await rejectsFixture(
    (fixture) => replaceSymlink(fixture.current, path.join(fixture.releaseRoot, 'not-a-release-sha')),
    65
  );
  await rejectsFixture(async (fixture) => {
    await fs.chmod(fixture.releaseRoot, 0o775);
  }, 65);
  await rejectsFixture(async (fixture) => {
    const realReleaseRoot = `${fixture.releaseRoot}-real`;
    await fs.rename(fixture.releaseRoot, realReleaseRoot);
    await fs.symlink(realReleaseRoot, fixture.releaseRoot);
  }, 65);
  await rejectsFixture(async (fixture) => {
    const otherRelease = path.join(fixture.releaseRoot, 'b'.repeat(40));
    await fs.rename(fixture.release, otherRelease);
    await fs.symlink(otherRelease, fixture.release);
  }, 65);
  await rejectsFixture(async (fixture) => {
    await fs.link(fixture.current, path.join(fixture.root, 'second-current-link'));
  }, 65);
  await rejectsFixture(async (fixture) => {
    await fs.chmod(fixture.release, 0o775);
  }, 65);
  await rejectsFixture(async (fixture) => {
    const realScripts = `${fixture.scripts}-real`;
    await fs.rename(fixture.scripts, realScripts);
    await fs.symlink(realScripts, fixture.scripts);
  }, 66);
  await rejectsFixture(async (fixture) => {
    await fs.chmod(fixture.scripts, 0o775);
  }, 66);

  for (const basename of ['monitor-readiness.mjs', 'readiness-monitor-lib.mjs']) {
    await rejectsFixture(async (fixture) => {
      const target = path.join(fixture.scripts, basename);
      const realTarget = `${target}.real`;
      await fs.rename(target, realTarget);
      await fs.symlink(realTarget, target);
    }, 66);
    await rejectsFixture(async (fixture) => {
      const target = path.join(fixture.scripts, basename);
      const realTarget = `${target}.real`;
      await fs.rename(target, realTarget);
      await fs.link(realTarget, target);
    }, 66);
    await rejectsFixture(async (fixture) => {
      await fs.chmod(path.join(fixture.scripts, basename), 0o664);
    }, 66);
  }

  const helperRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-readiness-owner-'));
  try {
    const fixture = await createReadinessLauncherFixture(helperRoot, launcher);
    await expectProcessExit(execFileAsync('/bin/sh', [
      fixture.harness, 'safe-directory', fixture.releaseRoot, String(fixture.uid + 1), String(fixture.gid)
    ]), 66);
    await expectProcessExit(execFileAsync('/bin/sh', [
      fixture.harness, 'safe-directory', fixture.release, String(fixture.uid + 1), String(fixture.gid)
    ]), 66);
    await expectProcessExit(execFileAsync('/bin/sh', [
      fixture.harness, 'safe-directory', fixture.scripts, String(fixture.uid + 1), String(fixture.gid)
    ]), 66);
    for (const target of [
      fixture.node,
      path.join(fixture.scripts, 'monitor-readiness.mjs'),
      path.join(fixture.scripts, 'readiness-monitor-lib.mjs')
    ]) {
      await expectProcessExit(execFileAsync('/bin/sh', [
        fixture.harness, 'safe-file', target, String(fixture.uid + 1), String(fixture.gid)
      ]), 66);
    }
    await expectProcessExit(execFileAsync('/bin/sh', [
      fixture.harness, 'resolve', fixture.current, fixture.releaseRoot,
      String(fixture.uid + 1), String(fixture.gid)
    ]), 65);

    const currentStat = await fs.lstat(fixture.current);
    const currentIdentity = [
      currentStat.dev, currentStat.ino, currentStat.uid, currentStat.gid, currentStat.nlink
    ].join(':');
    await replaceSymlink(fixture.current, path.join(fixture.releaseRoot, 'c'.repeat(40)));
    await expectProcessExit(execFileAsync('/bin/sh', [
      fixture.harness, 'current', fixture.current, currentIdentity, fixture.release
    ]), 65);
  } finally {
    await fs.rm(helperRoot, { recursive: true, force: true });
  }

  await rejectsFixture(async (fixture) => {
    await fs.writeFile(fixture.node, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  }, 42);
});

test('operations activation accepts only private healthy evidence for its exact release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-activation-readiness-'));
  try {
    const evidence = path.join(root, 'local-readiness.json');
    await fs.writeFile(evidence, `${JSON.stringify(healthyResult({ monitor: 'local' }), null, 2)}\n`, { mode: 0o600 });
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    assert.deepEqual(await validateOperationsReadiness(evidence, releaseSha, uid, process.platform, fixedNow.valueOf()), {
      releaseSha,
      checkedAt: fixedNow.toISOString()
    });
    await assert.rejects(
      validateOperationsReadiness(evidence, 'b'.repeat(40), uid, process.platform, fixedNow.valueOf()),
      /does not match/
    );
    const tamperedEvidence = path.join(root, 'tampered-evidence.json');
    const tampered = { ...healthyResult({ monitor: 'local' }), extra: 'not allowed' };
    await fs.writeFile(tamperedEvidence, JSON.stringify(tampered), { mode: 0o600, flag: 'wx' });
    await assert.rejects(
      validateOperationsReadiness(tamperedEvidence, releaseSha, uid, process.platform, fixedNow.valueOf()),
      /unexpected shape/
    );
    if (process.platform !== 'win32') {
      const linkedEvidence = path.join(root, 'linked-readiness.json');
      await fs.symlink(evidence, linkedEvidence);
      await assert.rejects(
        validateOperationsReadiness(linkedEvidence, releaseSha, uid, process.platform, fixedNow.valueOf())
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('incident reconciliation creates one issue, updates it, and closes it on recovery', async () => {
  const issues = [];
  const requests = [];
  const api = async (method, endpoint, body) => {
    requests.push({ method, endpoint, body });
    if (method === 'GET') return issues.map((issue) => ({ ...issue }));
    if (method === 'POST') {
      const issue = { number: 71, state: 'open', ...body };
      issues.push(issue);
      return issue;
    }
    const number = Number(endpoint.split('/').at(-1));
    Object.assign(issues.find((issue) => issue.number === number), body);
    return issues.find((issue) => issue.number === number);
  };
  const unhealthy = healthyResult({
    status: 'unhealthy', failureClass: 'network', httpStatus: null,
    releaseSha: null, schemaVersion: null, protocolVersion: null
  });
  assert.deepEqual(await reconcileProductionIncident({ repository: 'owner/repo', runId: '123', result: unhealthy, api }), {
    action: 'created', issueNumber: 71
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, new RegExp(INCIDENT_MARKER));
  assert.doesNotMatch(issues[0].body, /private upstream details|secret value/i);
  assert.equal((await reconcileProductionIncident({ repository: 'owner/repo', runId: '124', result: unhealthy, api })).action, 'updated');
  assert.equal(issues.length, 1);
  assert.equal((await reconcileProductionIncident({ repository: 'owner/repo', runId: '125', result: healthyResult(), api })).action, 'closed');
  assert.equal(issues[0].state, 'closed');
  assert.ok(requests.every((request) => !JSON.stringify(request).includes('secret')));
});

test('incident reconciliation preserves independent failure sources and deduplicates marker issues', async () => {
  const marked = (sources) => `${INCIDENT_MARKER}\n<!-- skyjo-production-active-sources:${sources} -->`;
  const issues = [
    { number: 73, state: 'closed', body: marked('') },
    { number: 72, state: 'open', body: marked('deployment') },
    { number: 71, state: 'open', body: marked('readiness') },
    { number: 99, state: 'open', body: 'User-created incident without the managed marker.' }
  ];
  const requests = [];
  const api = async (method, endpoint, body) => {
    requests.push({ method, endpoint, body });
    if (method === 'GET') return issues.map((issue) => ({ ...issue }));
    const number = Number(endpoint.split('/').at(-1));
    const issue = issues.find((entry) => entry.number === number);
    Object.assign(issue, body);
    return { ...issue };
  };
  const unhealthy = healthyResult({
    status: 'unhealthy', failureClass: 'internal', httpStatus: null,
    releaseSha: null, schemaVersion: null, protocolVersion: null
  });
  assert.deepEqual(await reconcileProductionIncident({
    repository: 'owner/repo', runId: '201', result: unhealthy, source: 'deployment', api
  }), { action: 'reopened', issueNumber: 73 });
  assert.equal(issues.find(({ number }) => number === 72).state_reason, 'not_planned');
  assert.equal(issues.find(({ number }) => number === 71).state_reason, 'not_planned');
  assert.equal(issues.find(({ number }) => number === 99).state, 'open');
  assert.match(issues.find(({ number }) => number === 73).body, /active-sources:deployment,readiness/);

  assert.equal((await reconcileProductionIncident({
    repository: 'owner/repo', runId: '202', result: healthyResult(), source: 'readiness', api
  })).action, 'updated');
  assert.equal(issues.find(({ number }) => number === 73).state, 'open');
  assert.match(issues.find(({ number }) => number === 73).body, /active-sources:deployment/);

  assert.equal((await reconcileProductionIncident({
    repository: 'owner/repo', runId: '203', result: healthyResult(), source: 'deployment', api
  })).action, 'closed');
  assert.equal(issues.find(({ number }) => number === 73).state_reason, 'completed');
  assert.ok(requests.every((request) => !JSON.stringify(request).includes('secret')));
});

test('governance policy has no bypass, zero approvals, exact checks, and squash-only settings', async () => {
  const ruleset = governanceRuleset();
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.equal(ruleset.enforcement, 'active');
  assert.ok(ruleset.rules.some((rule) => rule.type === 'deletion'));
  assert.ok(ruleset.rules.some((rule) => rule.type === 'non_fast_forward'));
  const pullRequest = ruleset.rules.find((rule) => rule.type === 'pull_request').parameters;
  assert.equal(pullRequest.required_approving_review_count, 0);
  assert.equal(pullRequest.required_review_thread_resolution, true);
  const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks').parameters;
  assert.deepEqual(checks.required_status_checks.map(({ context }) => context), [...REQUIRED_CHECKS]);
  assert.deepEqual(ruleset.rules.find((rule) => rule.type === 'code_scanning'), {
    type: 'code_scanning',
    parameters: {
      code_scanning_tools: [{
        tool: 'CodeQL', alerts_threshold: 'errors', security_alerts_threshold: 'high_or_higher'
      }]
    }
  });
  assert.deepEqual(releaseTagCreationRuleset(repositoryOwner.id), {
    name: 'Release tag creation', target: 'tag', enforcement: 'active',
    bypass_actors: [{ actor_id: 42, actor_type: 'User', bypass_mode: 'always' }],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }]
  });
  assert.deepEqual(immutableReleaseTagsRuleset(), {
    name: 'Immutable release tags', target: 'tag', enforcement: 'active', bypass_actors: [],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [
      { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
      { type: 'deletion' }
    ]
  });
  assert.deepEqual(repositorySettings(), {
    has_issues: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
    allow_auto_merge: true, delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY'
  });

  let dryRunCalls = 0;
  const plan = await reconcileGithubGovernance({
    repository: 'owner/repo',
    api: async () => { dryRunCalls += 1; return null; }
  });
  assert.equal(plan.applied, false);
  assert.equal(dryRunCalls, 0);
  assert.equal(plan.plan.releaseTagRulesets.length, 2);
  await assert.rejects(
    reconcileGithubGovernance({ repository: 'owner/repo', apply: true, confirmation: 'wrong/repo', api: async () => null }),
    /exact repository confirmation/
  );
});

test('governance apply preflights green main checks before its first mutation', async () => {
  const requests = [];
  const api = async (method, endpoint) => {
    requests.push({ method, endpoint });
    if (endpoint === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', owner: repositoryOwner };
    if (endpoint.endsWith('/commits/main')) return { sha: releaseSha };
    if (endpoint.includes('/check-runs')) return requiredCheckResponse({ total_count: 0, check_runs: [] });
    throw new Error('unexpected API request');
  };
  await assert.rejects(reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  }), /not represented/);
  assert.ok(requests.some(({ endpoint }) => endpoint.includes('check-runs?filter=latest&per_page=100')));
  assert.ok(requests.every(({ method }) => method === 'GET'));
});

test('governance duplicate checks accept only the unique newest success from one app', () => {
  const response = requiredCheckResponse();
  const context = REQUIRED_CHECKS[0];
  response.check_runs.push(requiredCheckRun(context, 100, {
    conclusion: 'failure',
    completed_at: '2026-07-12T19:20:00Z'
  }));
  response.check_runs.push(requiredCheckRun(context, 101, {
    conclusion: 'cancelled',
    completed_at: '2026-07-12T19:20:00Z'
  }));
  response.total_count = response.check_runs.length;
  response.check_runs.reverse();

  const integrations = checkRunIntegrations(response, releaseSha);
  assert.deepEqual(integrations, new Map(REQUIRED_CHECKS.map((name) => [name, 15368])));
});

test('governance duplicate checks reject a newer failure or any unsettled candidate', () => {
  const context = REQUIRED_CHECKS[0];
  const newerFailure = requiredCheckResponse();
  newerFailure.check_runs.push(requiredCheckRun(context, 100, {
    conclusion: 'failure',
    completed_at: '2026-07-12T19:50:00Z'
  }));
  newerFailure.total_count = newerFailure.check_runs.length;
  assert.throws(() => checkRunIntegrations(newerFailure, releaseSha), /not green/);

  const pending = requiredCheckResponse();
  pending.check_runs.push(requiredCheckRun(context, 101, {
    status: 'in_progress', conclusion: null, completed_at: null
  }));
  pending.total_count = pending.check_runs.length;
  assert.throws(() => checkRunIntegrations(pending, releaseSha), /not settled/);
});

test('governance duplicate checks reject mixed apps, stale heads, and malformed identities or timestamps', () => {
  const context = REQUIRED_CHECKS[0];
  const adversarialCases = [
    {
      overrides: { app: { id: 99 }, completed_at: '2026-07-12T19:20:00Z' },
      expected: /conflicting GitHub App/
    },
    {
      overrides: { head_sha: 'b'.repeat(40), completed_at: '2026-07-12T19:20:00Z' },
      expected: /does not belong to current main/
    },
    {
      overrides: { id: 0, completed_at: '2026-07-12T19:20:00Z' },
      expected: /check-run identity/
    },
    {
      overrides: { id: 10_000, completed_at: '2026-07-12T19:20:00Z' },
      expected: /check-run identity/
    },
    {
      overrides: { completed_at: 'not-a-timestamp' },
      expected: /completion timestamp/
    },
    {
      overrides: { completed_at: '2026-02-30T19:40:00Z' },
      expected: /completion timestamp/
    },
    {
      overrides: { completed_at: '2026-07-12T19:40:00Z' },
      expected: /no unique newest completion/
    }
  ];
  for (const { overrides, expected } of adversarialCases) {
    const response = requiredCheckResponse();
    response.check_runs.push(requiredCheckRun(context, 100, overrides));
    response.total_count = response.check_runs.length;
    assert.throws(() => checkRunIntegrations(response, releaseSha), expected);
  }

  const invalidApp = requiredCheckResponse();
  invalidApp.check_runs[0].app.id = 0;
  assert.throws(() => checkRunIntegrations(invalidApp, releaseSha), /trustworthy GitHub App/);

  const staleSingle = requiredCheckResponse();
  staleSingle.check_runs[0].head_sha = 'b'.repeat(40);
  assert.throws(() => checkRunIntegrations(staleSingle, releaseSha), /does not belong to current main/);
});

test('governance validates every singleton identity, head, status, timestamp, and app', () => {
  const invalidSingletons = [
    { mutate: (check) => { delete check.id; }, expected: /check-run identity/ },
    { mutate: (check) => { check.id = 0; }, expected: /check-run identity/ },
    { mutate: (check) => { delete check.head_sha; }, expected: /does not belong to current main/ },
    { mutate: (check) => { check.head_sha = 'b'.repeat(40); }, expected: /does not belong to current main/ },
    { mutate: (check) => { check.status = 'in_progress'; check.completed_at = null; }, expected: /not settled/ },
    { mutate: (check) => { delete check.completed_at; }, expected: /completion timestamp/ },
    { mutate: (check) => { check.completed_at = 'not-a-timestamp'; }, expected: /completion timestamp/ },
    { mutate: (check) => { delete check.app; }, expected: /trustworthy GitHub App/ },
    { mutate: (check) => { check.app.id = 0; }, expected: /trustworthy GitHub App/ },
    { mutate: (check) => { check.conclusion = 'failure'; }, expected: /not green/ }
  ];
  for (const { mutate, expected } of invalidSingletons) {
    const response = requiredCheckResponse();
    mutate(response.check_runs[0]);
    assert.throws(() => checkRunIntegrations(response, releaseSha), expected);
  }
});

test('governance check discovery rejects incomplete, oversized, and invalid bounded responses', () => {
  const incomplete = requiredCheckResponse({ total_count: REQUIRED_CHECKS.length + 1 });
  assert.throws(() => checkRunIntegrations(incomplete, releaseSha), /does not match/);

  const shortCount = requiredCheckResponse({ total_count: REQUIRED_CHECKS.length - 1 });
  assert.throws(() => checkRunIntegrations(shortCount, releaseSha), /does not match/);

  const invalidCount = requiredCheckResponse({ total_count: '9' });
  assert.throws(() => checkRunIntegrations(invalidCount, releaseSha), /count is invalid or exceeds/);

  const missingCount = requiredCheckResponse();
  delete missingCount.total_count;
  assert.throws(() => checkRunIntegrations(missingCount, releaseSha), /count is invalid or exceeds/);

  const oversizedRuns = Array.from({ length: 101 }, (_, index) => ({ name: `unrelated-${index}` }));
  assert.throws(() => checkRunIntegrations({ total_count: 101, check_runs: oversizedRuns }, releaseSha), /count is invalid or exceeds/);
});

test('governance apply rejects ambiguous managed rulesets before its first mutation', async () => {
  const requests = [];
  const api = async (method, endpoint) => {
    requests.push({ method, endpoint });
    if (endpoint === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', owner: repositoryOwner };
    if (endpoint.endsWith('/commits/main')) return { sha: releaseSha };
    if (endpoint.includes('/check-runs')) return requiredCheckResponse();
    if (endpoint.endsWith('/actions/permissions/workflow')) {
      return { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false };
    }
    if (endpoint.endsWith('/actions/permissions')) return { enabled: true, allowed_actions: 'all' };
    if (endpoint.includes('/rulesets?')) {
      return [
        { id: 90, name: 'Protect main', target: 'branch' },
        { id: 91, name: 'Protect main', target: 'branch' }
      ];
    }
    throw new Error(`unexpected API request ${method} ${endpoint}`);
  };
  await assert.rejects(reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  }), /ambiguous/);
  assert.ok(requests.every(({ method }) => method === 'GET'));
});

test('governance apply binds checks to their app and verifies detailed settings readback', async () => {
  const repository = {
    full_name: 'owner/repo', default_branch: 'main', owner: repositoryOwner,
    allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true,
    allow_auto_merge: false, delete_branch_on_merge: false
  };
  const actions = { enabled: true, allowed_actions: 'all', sha_pinning_required: false };
  const workflowToken = { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true };
  const detailedRulesets = new Map();
  let nextRulesetId = 91;
  const mutations = [];
  const api = async (method, endpoint, body) => {
    if (method !== 'GET') mutations.push({ method, endpoint, body });
    if (endpoint === '/repos/owner/repo') {
      if (method === 'PATCH') Object.assign(repository, body);
      return { ...repository };
    }
    if (endpoint.endsWith('/commits/main')) return { sha: releaseSha };
    if (endpoint.includes('/check-runs')) return requiredCheckResponse();
    if (endpoint.endsWith('/actions/permissions/workflow')) {
      if (method === 'PUT') Object.assign(workflowToken, body);
      return { ...workflowToken };
    }
    if (endpoint.endsWith('/actions/permissions')) {
      if (method === 'PUT') Object.assign(actions, body);
      return { ...actions };
    }
    if (endpoint.includes('/rulesets?')) {
      return [...detailedRulesets.values()].map(({ id, name, target }) => ({ id, name, target }));
    }
    if (endpoint.endsWith('/rulesets') && method === 'POST') {
      const detailedRuleset = { id: nextRulesetId, ...body };
      nextRulesetId += 1;
      detailedRulesets.set(detailedRuleset.id, detailedRuleset);
      return { ...detailedRuleset };
    }
    const rulesetMatch = endpoint.match(/\/rulesets\/([1-9][0-9]*)$/);
    if (rulesetMatch) {
      const id = Number(rulesetMatch[1]);
      if (method === 'PUT') detailedRulesets.set(id, { id, ...body });
      return { ...detailedRulesets.get(id) };
    }
    if (endpoint.endsWith('/vulnerability-alerts')) return null;
    if (endpoint.endsWith('/automated-security-fixes')) {
      return method === 'GET' ? { enabled: true, paused: false } : null;
    }
    throw new Error(`unexpected API request ${method} ${endpoint}`);
  };
  const result = await reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  });
  assert.deepEqual(result, {
    applied: true, repository: 'owner/repo', rulesetId: 93,
    releaseTagRulesetIds: [92, 91], mainSha: releaseSha
  });
  assert.equal(actions.sha_pinning_required, true);
  assert.deepEqual(workflowToken, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
  const mainRuleset = [...detailedRulesets.values()].find(({ name }) => name === 'Protect main');
  const required = mainRuleset.rules.find((rule) => rule.type === 'required_status_checks');
  assert.ok(required.parameters.required_status_checks.every((check) => check.integration_id === 15368));
  const creationRuleset = [...detailedRulesets.values()].find(({ name }) => name === 'Release tag creation');
  assert.deepEqual(creationRuleset.bypass_actors, [{ actor_id: 42, actor_type: 'User', bypass_mode: 'always' }]);
  assert.deepEqual([...detailedRulesets.values()].find(({ name }) => name === 'Immutable release tags').bypass_actors, []);
  assert.ok(mutations.some(({ endpoint }) => endpoint.endsWith('/automated-security-fixes')));
  assert.equal(repository.has_issues, true);
  assert.equal(repository.squash_merge_commit_title, 'PR_TITLE');
  assert.equal(repository.squash_merge_commit_message, 'PR_BODY');

  const second = await reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  });
  assert.deepEqual(second, result);
  assert.equal(mutations.filter(({ method, endpoint }) => method === 'POST' && endpoint.endsWith('/rulesets')).length, 3);
  assert.equal(mutations.filter(({ method, endpoint }) => method === 'PUT' && /\/rulesets\/[1-9]/.test(endpoint)).length, 3);
});

test('governance rejects disabled or paused Dependabot security readbacks', () => {
  assert.doesNotThrow(() => assertDependabotReadbacks(null, { enabled: true, paused: false }));
  assert.throws(() => assertDependabotReadbacks({ enabled: false }, { enabled: true, paused: false }), /vulnerability-alert/);
  assert.throws(() => assertDependabotReadbacks(null, { enabled: false, paused: false }), /security-update/);
  assert.throws(() => assertDependabotReadbacks(null, { enabled: true, paused: true }), /security-update/);
});

test('governance readback fails closed on every requested setting and CodeQL threshold', () => {
  const makeReadback = () => {
    const expectedRuleset = governanceRuleset(new Map(REQUIRED_CHECKS.map((name) => [name, 15368])));
    const expectedCreationRuleset = releaseTagCreationRuleset(repositoryOwner.id);
    const expectedImmutableRuleset = immutableReleaseTagsRuleset();
    return {
      repository: {
        has_issues: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
        allow_auto_merge: true, delete_branch_on_merge: true,
        squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY'
      },
      ruleset: { id: 91, ...structuredClone(expectedRuleset) },
      expectedRuleset,
      additionalRulesets: [
        { actual: { id: 92, ...structuredClone(expectedCreationRuleset) }, expected: expectedCreationRuleset },
        { actual: { id: 93, ...structuredClone(expectedImmutableRuleset) }, expected: expectedImmutableRuleset }
      ],
      actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: true },
      expectedAllowedActions: 'all',
      workflowToken: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
      vulnerabilityAlerts: null,
      securityUpdates: { enabled: true, paused: false }
    };
  };
  const corruptions = [
    (value) => { value.repository.has_issues = false; },
    (value) => { value.repository.squash_merge_commit_title = 'COMMIT_OR_PR_TITLE'; },
    (value) => { value.repository.squash_merge_commit_message = 'COMMIT_MESSAGES'; },
    (value) => { value.actions.sha_pinning_required = false; },
    (value) => { value.workflowToken.default_workflow_permissions = 'write'; },
    (value) => { value.workflowToken.can_approve_pull_request_reviews = true; },
    (value) => {
      value.ruleset.rules.find(({ type }) => type === 'code_scanning')
        .parameters.code_scanning_tools[0].security_alerts_threshold = 'critical';
    },
    (value) => { value.additionalRulesets[0].actual.bypass_actors[0].actor_id = 99; },
    (value) => { value.additionalRulesets[1].actual.rules.pop(); },
    (value) => { value.vulnerabilityAlerts = { enabled: false }; },
    (value) => { value.securityUpdates.paused = true; }
  ];
  assert.doesNotThrow(() => assertGovernanceReadbacks(makeReadback()));
  for (const corrupt of corruptions) {
    const value = makeReadback();
    corrupt(value);
    assert.throws(() => assertGovernanceReadbacks(value));
  }

  const immutableUpdate = (value, side = 'actual') => value.additionalRulesets[1][side]
    .rules.find(({ type }) => type === 'update');

  const omittedCanonicalFalse = makeReadback();
  delete immutableUpdate(omittedCanonicalFalse).parameters;
  assert.doesNotThrow(() => assertGovernanceReadbacks(omittedCanonicalFalse));

  const explicitFalse = makeReadback();
  assert.equal(immutableUpdate(explicitFalse).parameters.update_allows_fetch_and_merge, false);
  assert.doesNotThrow(() => assertGovernanceReadbacks(explicitFalse));

  const explicitTrue = makeReadback();
  immutableUpdate(explicitTrue).parameters.update_allows_fetch_and_merge = true;
  assert.throws(() => assertGovernanceReadbacks(explicitTrue), /Detailed update rule parameters did not match/);

  const omittedExpectedTrue = makeReadback();
  immutableUpdate(omittedExpectedTrue, 'expected').parameters.update_allows_fetch_and_merge = true;
  delete immutableUpdate(omittedExpectedTrue).parameters;
  assert.throws(() => assertGovernanceReadbacks(omittedExpectedTrue), /Detailed update rule parameters did not match/);

  const emptyParameters = makeReadback();
  immutableUpdate(emptyParameters).parameters = {};
  assert.throws(() => assertGovernanceReadbacks(emptyParameters), /Detailed update rule parameters did not match/);

  const nullParameters = makeReadback();
  immutableUpdate(nullParameters).parameters = null;
  assert.throws(() => assertGovernanceReadbacks(nullParameters), /Detailed update rule parameters did not match/);

  const ownUndefinedParameters = makeReadback();
  immutableUpdate(ownUndefinedParameters).parameters = undefined;
  assert.throws(() => assertGovernanceReadbacks(ownUndefinedParameters), /Detailed update rule parameters did not match/);

  const omittedWithExtraExpectedKey = makeReadback();
  immutableUpdate(omittedWithExtraExpectedKey, 'expected').parameters.unrelated = false;
  delete immutableUpdate(omittedWithExtraExpectedKey).parameters;
  assert.throws(() => assertGovernanceReadbacks(omittedWithExtraExpectedKey), /Detailed update rule parameters did not match/);

  const omittedBranchUpdate = makeReadback();
  omittedBranchUpdate.expectedRuleset.rules.push({
    type: 'update', parameters: { update_allows_fetch_and_merge: false }
  });
  omittedBranchUpdate.ruleset.rules.push({ type: 'update' });
  assert.throws(() => assertGovernanceReadbacks(omittedBranchUpdate), /Detailed update rule parameters did not match/);

  const omittedOtherParameters = makeReadback();
  delete omittedOtherParameters.ruleset.rules.find(({ type }) => type === 'pull_request').parameters;
  assert.throws(() => assertGovernanceReadbacks(omittedOtherParameters), /Detailed pull_request rule parameters did not match/);
});

test('incident reconciliation rejects malformed active-source markers without mutation', async () => {
  const requests = [];
  const api = async (method, endpoint) => {
    requests.push({ method, endpoint });
    return [{ number: 81, state: 'open', body: `${INCIDENT_MARKER}\n<!-- skyjo-production-active-sources:deployment,unknown -->` }];
  };
  await assert.rejects(reconcileProductionIncident({
    repository: 'owner/repo', runId: '301', result: healthyResult(), source: 'readiness', api
  }), /invalid active source marker/);
  assert.deepEqual(requests.map(({ method }) => method), ['GET']);
});

async function backupFixture(root) {
  const state = path.join(root, 'state');
  const dist = path.join(root, 'dist');
  await fs.mkdir(state, { recursive: true });
  const databasePath = path.join(state, 'skyjo.sqlite');
  const roomsPath = path.join(state, 'rooms.json');
  const store = await createAccountStore({ filePath: databasePath });
  store.close();
  await saveRoomsToDisk(new Map(), roomsPath);
  await writeReleaseIdentity(dist, {
    formatVersion: 1,
    releaseSha,
    buildTimestamp: '2026-07-11T00:00:00.000Z',
    schemaVersion: 2,
    protocolVersion: CURRENT_PROTOCOL_VERSION
  });
  return {
    SKYJO_DB_FILE: databasePath,
    SKYJO_ROOMS_FILE: roomsPath,
    SKYJO_RELEASE_FILE: path.join(dist, 'release.json')
  };
}

test('scheduled backups enforce isolated namespaces, retention, and a monthly restore drill', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-scheduled-backup-'));
  try {
    const env = await backupFixture(root);
    const backupRoot = path.join(root, 'backups');
    const restoreRoot = path.join(root, 'restores');
    assert.equal(RETENTION.daily, 30);
    assert.equal(RETENTION.monthly, 12);
    for (let day = 1; day <= 4; day += 1) {
      const result = await runScheduledBackup({
        kind: 'daily', env, backupRoot, restoreRoot, keep: 3,
        now: new Date(`2026-07-0${day}T03:15:00.000Z`)
      });
      assert.equal(result.kind, 'daily');
      assert.equal(result.restoreDrill, null);
      assert.ok(!('backupDirectory' in result));
    }
    assert.deepEqual(await fs.readdir(path.join(backupRoot, 'daily')), [
      'daily-20260702T031500Z', 'daily-20260703T031500Z', 'daily-20260704T031500Z'
    ]);
    const monthly = await runScheduledBackup({ kind: 'monthly', env, backupRoot, restoreRoot, now: fixedNow });
    assert.equal(monthly.restoreDrill, 'verified');
    assert.deepEqual(await fs.readdir(restoreRoot), []);
    const evidence = JSON.parse(await fs.readFile(path.join(backupRoot, 'drills', 'monthly-20260711T123456Z.json'), 'utf8'));
    assert.equal(evidence.status, 'verified');
    assert.equal(evidence.releaseSha, releaseSha);
    assert.equal(scheduledBackupName('daily', fixedNow), 'daily-20260711T123456Z');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retention refuses unexpected or unverified entries instead of deleting broadly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-retention-'));
  try {
    await fs.mkdir(path.join(root, 'not-a-managed-backup'));
    await assert.rejects(enforceBackupRetention(root, 'daily', 1), /Unexpected entry/);
    assert.ok(await fs.stat(path.join(root, 'not-a-managed-backup')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retention verifies retained backups before deleting any older backup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-retained-corruption-'));
  try {
    const env = await backupFixture(root);
    const backupRoot = path.join(root, 'backups');
    const restoreRoot = path.join(root, 'restores');
    for (let day = 1; day <= 3; day += 1) {
      await runScheduledBackup({
        kind: 'daily', env, backupRoot, restoreRoot, keep: 10,
        now: new Date(`2026-07-0${day}T03:15:00.000Z`)
      });
    }
    const category = path.join(backupRoot, 'daily');
    await fs.appendFile(path.join(category, 'daily-20260703T031500Z', 'rooms.json'), 'corrupt');
    await assert.rejects(enforceBackupRetention(category, 'daily', 2), /size or SHA-256/);
    assert.deepEqual((await fs.readdir(category)).sort(), [
      'daily-20260701T031500Z', 'daily-20260702T031500Z', 'daily-20260703T031500Z'
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('workflow and systemd assets preserve pins, staged activation, and exact schedules', async () => {
  const [dependabot, ci, codeql, monitor, installer, launcher, tmpfiles, dailyService, dailyTimer, monthlyService, monthlyTimer, readinessTimer, readinessService] = await Promise.all([
    fs.readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'codeql.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'production-monitor.yml'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'install-skyjo-operations.sh'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-ops-launch'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-online-operations.tmpfiles'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-daily.service'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-daily.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-monthly.service'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-monthly.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-readiness-monitor.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-readiness-monitor.service'), 'utf8')
  ]);
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*groups:[\s\S]*npm-production/);
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*github-actions:/);
  assert.doesNotMatch(codeql, /uses: [^\n]+@v[0-9]/);
  assert.match(codeql, /name: CodeQL \/ Analyze/);
  assert.match(ci, /Validate operations shells and systemd units[\s\S]*sh -n[\s\S]*systemd-analyze verify/);
  assert.match(ci, /production-incident:[\s\S]*needs:[\s\S]*- runtime-artifact[\s\S]*needs\.runtime-artifact\.result == 'success'/);
  assert.match(ci, /ref: \$\{\{ needs\.runtime-artifact\.outputs\.source-sha \}\}[\s\S]*SKYJO_INCIDENT_SOURCE: deployment/);
  assert.match(monitor, /SKYJO_MONITOR_ENABLED/);
  assert.match(monitor, /MONITOR_REF[\s\S]*refs\/heads\/main/);
  assert.match(monitor, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(monitor, /if: always\(\)[\s\S]*reconcile-production-incident/);
  const installFunction = installer.slice(installer.indexOf('install_assets()'), installer.indexOf('activate()'));
  assert.doesNotMatch(installFunction, /systemctl enable|operations\.enabled.*install/);
  assert.match(installFunction, /assert_install_inactive/);
  assert.match(installer, /Refusing to replace an active operations unit/);
  assert.match(installer, /Refusing to replace an enabled operations unit/);
  assert.match(installer, /non-root-owned or hardlinked operations target/);
  assert.match(installer, /operations asset checksums did not verify/i);
  assert.match(installer, /systemd-tmpfiles --create "\$TMPFILES_CONFIG"/);
  assert.match(installer, /Timed out waiting for the shared release lock/);
  assert.match(installer, /safe_installed_asset "\$asset" 444/);
  assert.doesNotMatch(installer, /disable --now[\s\S]{0,200}\|\| true/);
  assert.match(installer, /activation marker was removed, but one or more timers could not be disabled/i);
  assert.match(installer, /\[ ! -L "\$MARKER" \]/);
  assert.match(installer, /validate-operations-readiness\.mjs[\s\S]*"\$release_sha"/);
  assert.match(installer, /dirname "\$release"/);
  assert.match(dailyTimer, /OnCalendar=\*-\*-\* 03:15:00 UTC/);
  assert.match(monthlyTimer, /OnCalendar=\*-\*-01 04:15:00 UTC/);
  assert.match(readinessTimer, /OnUnitActiveSec=2m/);
  assert.match(readinessService, /ConditionPathExists=\/etc\/skyjo-online-operations\.enabled/);
  assert.match(readinessService, /User=skyjo-monitor\nGroup=skyjo-monitor/);
  assert.match(readinessService, /ExecStart=\/usr\/local\/lib\/skyjo-online\/skyjo-ops-launch readiness/);
  assert.doesNotMatch(readinessService, /\/srv\/skyjo-online\/current\/scripts\/monitor-readiness\.mjs/);
  assert.match(readinessService, /IPAddressAllow=localhost/);
  const readinessBranch = launcher.slice(0, launcher.indexOf('\ndaily|monthly) ;;'));
  const scheduledBranch = launcher.slice(launcher.indexOf('\n[ "$(/usr/bin/id -u)" -eq 0 ]'));
  assert.match(readinessBranch, /id -u skyjo-monitor[\s\S]*id -g skyjo-monitor[\s\S]*id -Gn skyjo-monitor/);
  assert.match(readinessBranch, /stat -c %u:%g:%h "\$current_link"/);
  assert.match(readinessBranch, /readlink "\$current_link"[\s\S]*readlink -f "\$current_link"/);
  assert.match(readinessBranch, /dirname "\$release_target"[\s\S]*\^\[a-f0-9\]\{40\}\$/);
  assert.match(readinessBranch, /monitor-readiness\.mjs[\s\S]*readiness-monitor-lib\.mjs/);
  assert.match(readinessBranch, /stat -c %u:%g:%h "\$safe_file"[\s\S]*\?\?\?\?\?w\*\|\?\?\?\?\?\?\?\?w\*/);
  assert.match(readinessBranch, /readiness_current_matches[\s\S]*unset NODE_OPTIONS NODE_PATH[\s\S]*exec "\$node" "\$script"/);
  assert.match(readinessBranch, /0 0 \\\n    \/opt\/skyjo-online\/node\/bin\/node/);
  assert.doesNotMatch(readinessBranch, /skyjo-release-controller\.lock|flock/);
  assert.match(scheduledBranch, /skyjo-release-controller\.lock[\s\S]*flock --exclusive --wait 300 9/);
  assert.match(scheduledBranch, /SKYJO_RELEASE_FILE[\s\S]*SKYJO_DB_FILE[\s\S]*SKYJO_ROOMS_FILE/);
  assert.match(scheduledBranch, /exec "\$node" "\$script" --kind "\$action"/);
  assert.equal(tmpfiles.trim(), 'f /run/lock/skyjo-release-controller.lock 0600 root root -');
  assert.match(dailyService, /ReadWritePaths=\/run\/lock\/skyjo-release-controller\.lock \/var\/backups\/skyjo-online\n/);
  assert.doesNotMatch(dailyService, /ReadWritePaths=.*skyjo-restore-drills/);
  assert.match(monthlyService, /ReadWritePaths=\/run\/lock\/skyjo-release-controller\.lock \/var\/backups\/skyjo-online \/var\/tmp\/skyjo-restore-drills/);

  if (process.platform !== 'win32') {
    const start = installer.indexOf('inactive_enablement_state() {');
    const end = installer.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start, 'inactive enablement helper must be extractable');
    const helper = installer.slice(start, end);
    await execFileAsync('/bin/sh', ['-eu', '-c', `${helper}
      inactive_enablement_state example.service static 0
      inactive_enablement_state example.service not-found 4
      inactive_enablement_state example.timer disabled 1
      inactive_enablement_state example.timer not-found 4
      for tuple in \
        'example.service disabled 1' 'example.service static 1' \
        'example.service not-found 1' 'example.timer static 0' \
        'example.timer enabled 0' 'example.timer indirect 0' \
        'example.timer masked 1' 'example.timer not-found 1'; do
        set -- $tuple
        if inactive_enablement_state "$1" "$2" "$3"; then exit 71; fi
      done
    `]);
  }
});

test('artifact producer and live controller require the same operations scripts', () => {
  for (const script of [
    'scripts/monitor-readiness.mjs',
    'scripts/readiness-monitor-lib.mjs',
    'scripts/run-scheduled-backup.mjs',
    'scripts/scheduled-backup-lib.mjs'
  ]) {
    assert.ok(REQUIRED_ARCHIVE_FILES.includes(script), `${script} must be required by the artifact producer`);
    assert.ok(REQUIRED_ARCHIVE_ENTRIES.has(script), `${script} must be required by the live controller`);
  }
});
