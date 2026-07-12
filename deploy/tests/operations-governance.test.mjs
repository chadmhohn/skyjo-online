import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAccountStore } from '../../server-account-store.mjs';
import { saveRoomsToDisk } from '../../server-room-persistence.mjs';
import { writeReleaseIdentity } from '../../server-release.mjs';
import {
  governanceRuleset,
  reconcileGithubGovernance,
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

test('operations activation accepts only private healthy evidence for its exact release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyjo-activation-readiness-'));
  try {
    const evidence = path.join(root, 'local-readiness.json');
    await fs.writeFile(evidence, `${JSON.stringify(healthyResult({ monitor: 'local' }), null, 2)}\n`, { mode: 0o600 });
    const uid = (await fs.stat(evidence)).uid;
    assert.deepEqual(await validateOperationsReadiness(evidence, releaseSha, uid), {
      releaseSha,
      checkedAt: fixedNow.toISOString()
    });
    await assert.rejects(validateOperationsReadiness(evidence, 'b'.repeat(40), uid), /does not match/);
    const tampered = JSON.parse(await fs.readFile(evidence, 'utf8'));
    tampered.extra = 'not allowed';
    await fs.writeFile(evidence, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(validateOperationsReadiness(evidence, releaseSha, uid), /unexpected shape/);
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
  assert.deepEqual(repositorySettings(), {
    has_issues: true, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
    allow_auto_merge: true, delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY'
  });

  const plan = await reconcileGithubGovernance({ repository: 'owner/repo', api: async () => null });
  assert.equal(plan.applied, false);
  await assert.rejects(
    reconcileGithubGovernance({ repository: 'owner/repo', apply: true, confirmation: 'wrong/repo', api: async () => null }),
    /exact repository confirmation/
  );
});

test('governance apply preflights unique green main checks before its first mutation', async () => {
  const requests = [];
  const api = async (method, endpoint) => {
    requests.push({ method, endpoint });
    if (endpoint === '/repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main' };
    if (endpoint.endsWith('/commits/main')) return { sha: releaseSha };
    if (endpoint.includes('/check-runs')) return { check_runs: [] };
    throw new Error('unexpected API request');
  };
  await assert.rejects(reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  }), /not uniquely represented/);
  assert.ok(requests.every(({ method }) => method === 'GET'));
});

test('governance apply binds checks to their app and verifies detailed settings readback', async () => {
  const repository = {
    full_name: 'owner/repo', default_branch: 'main',
    allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true,
    allow_auto_merge: false, delete_branch_on_merge: false
  };
  const actions = { enabled: true, allowed_actions: 'all', sha_pinning_required: false };
  const workflowToken = { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true };
  let detailedRuleset = null;
  const mutations = [];
  const api = async (method, endpoint, body) => {
    if (method !== 'GET') mutations.push({ method, endpoint, body });
    if (endpoint === '/repos/owner/repo') {
      if (method === 'PATCH') Object.assign(repository, body);
      return { ...repository };
    }
    if (endpoint.endsWith('/commits/main')) return { sha: releaseSha };
    if (endpoint.includes('/check-runs')) {
      return {
        check_runs: REQUIRED_CHECKS.map((name) => ({
          name, status: 'completed', conclusion: 'success', app: { id: 15368 }
        }))
      };
    }
    if (endpoint.endsWith('/actions/permissions/workflow')) {
      if (method === 'PUT') Object.assign(workflowToken, body);
      return { ...workflowToken };
    }
    if (endpoint.endsWith('/actions/permissions')) {
      if (method === 'PUT') Object.assign(actions, body);
      return { ...actions };
    }
    if (endpoint.includes('/rulesets?')) return detailedRuleset ? [{ id: 91, name: detailedRuleset.name, target: 'branch' }] : [];
    if (endpoint.endsWith('/rulesets') && method === 'POST') {
      detailedRuleset = { id: 91, ...body };
      return detailedRuleset;
    }
    if (endpoint.endsWith('/rulesets/91')) return { ...detailedRuleset };
    if (endpoint.endsWith('/vulnerability-alerts') || endpoint.endsWith('/automated-security-fixes')) return null;
    throw new Error(`unexpected API request ${method} ${endpoint}`);
  };
  const result = await reconcileGithubGovernance({
    repository: 'owner/repo', apply: true, confirmation: 'owner/repo', api
  });
  assert.deepEqual(result, { applied: true, repository: 'owner/repo', rulesetId: 91, mainSha: releaseSha });
  assert.equal(actions.sha_pinning_required, true);
  assert.deepEqual(workflowToken, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
  const required = detailedRuleset.rules.find((rule) => rule.type === 'required_status_checks');
  assert.ok(required.parameters.required_status_checks.every((check) => check.integration_id === 15368));
  assert.ok(mutations.some(({ endpoint }) => endpoint.endsWith('/automated-security-fixes')));
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
    protocolVersion: 1
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

test('workflow and systemd assets preserve pins, staged activation, and exact schedules', async () => {
  const [dependabot, codeql, monitor, installer, dailyTimer, monthlyTimer, readinessTimer, readinessService] = await Promise.all([
    fs.readFile(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'codeql.yml'), 'utf8'),
    fs.readFile(path.join(repoRoot, '.github', 'workflows', 'production-monitor.yml'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'install-skyjo-operations.sh'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-daily.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-backup-monthly.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-readiness-monitor.timer'), 'utf8'),
    fs.readFile(path.join(deployRoot, 'skyjo-readiness-monitor.service'), 'utf8')
  ]);
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*groups:[\s\S]*npm-production/);
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*github-actions:/);
  assert.doesNotMatch(codeql, /uses: [^\n]+@v[0-9]/);
  assert.match(codeql, /name: CodeQL \/ Analyze/);
  assert.match(monitor, /SKYJO_MONITOR_ENABLED/);
  assert.match(monitor, /if: always\(\)[\s\S]*reconcile-production-incident/);
  const installFunction = installer.slice(installer.indexOf('install_assets()'), installer.indexOf('activate()'));
  assert.doesNotMatch(installFunction, /systemctl enable|operations\.enabled.*install/);
  assert.doesNotMatch(installer, /disable --now[\s\S]{0,200}\|\| true/);
  assert.match(installer, /activation marker was removed, but one or more timers could not be disabled/i);
  assert.match(installer, /\[ ! -L "\$MARKER" \]/);
  assert.match(installer, /validate-operations-readiness\.mjs[\s\S]*"\$release_sha"/);
  assert.match(installer, /dirname "\$release"/);
  assert.match(dailyTimer, /OnCalendar=\*-\*-\* 03:15:00 UTC/);
  assert.match(monthlyTimer, /OnCalendar=\*-\*-01 04:15:00 UTC/);
  assert.match(readinessTimer, /OnUnitActiveSec=2m/);
  assert.match(readinessService, /ConditionPathExists=\/etc\/skyjo-online-operations\.enabled/);
  assert.match(readinessService, /IPAddressAllow=localhost/);
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
