export const GOVERNANCE_RULESET_NAME = 'Protect main';
export const REQUIRED_CHECKS = Object.freeze([
  'CI / Quality & Security',
  'CI / Unit (domain)',
  'CI / Unit (data)',
  'CI / E2E (chromium 1)',
  'CI / E2E (chromium 2)',
  'CI / E2E (webkit)',
  'CI / Visual & Accessibility',
  'CI / Lighthouse',
  'CodeQL / Analyze'
]);

export function assertGovernanceRepository(value) {
  const repository = String(value || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Repository must be an owner/name identity.');
  return repository;
}

export function governanceRuleset(integrationIds = new Map()) {
  return {
    name: GOVERNANCE_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH'],
        exclude: []
      }
    },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash']
        }
      },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: true,
          required_status_checks: REQUIRED_CHECKS.map((context) => ({
            context,
            ...(integrationIds.has(context) ? { integration_id: integrationIds.get(context) } : {})
          }))
        }
      }
    ]
  };
}

export function repositorySettings() {
  return {
    has_issues: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'PR_BODY'
  };
}

export function actionsPermissions(existing = {}) {
  return {
    enabled: existing.enabled !== false,
    allowed_actions: ['all', 'local_only', 'selected'].includes(existing.allowed_actions) ? existing.allowed_actions : 'all',
    sha_pinning_required: true
  };
}

export function workflowTokenPermissions() {
  return {
    default_workflow_permissions: 'read',
    can_approve_pull_request_reviews: false
  };
}

function checkRunIntegrations(checkRuns) {
  if (!checkRuns || !Array.isArray(checkRuns.check_runs)) throw new Error('Current main check-run response is invalid.');
  if (
    Number.isSafeInteger(checkRuns.total_count) &&
    checkRuns.total_count > checkRuns.check_runs.length
  ) {
    throw new Error('Current main check runs exceed the bounded governance preflight response.');
  }
  const integrationIds = new Map();
  for (const context of REQUIRED_CHECKS) {
    const matches = checkRuns.check_runs.filter((check) => check.name === context);
    if (matches.length !== 1) throw new Error(`Required check ${context} is not uniquely represented on current main.`);
    const [check] = matches;
    if (check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error(`Required check ${context} is not green on current main.`);
    }
    if (!Number.isSafeInteger(check.app?.id) || check.app.id < 1) {
      throw new Error(`Required check ${context} has no trustworthy GitHub App identity.`);
    }
    integrationIds.set(context, check.app.id);
  }
  return integrationIds;
}

function assertDetailedRuleset(actual, expected) {
  function contains(actualValue, expectedValue) {
    if (Array.isArray(expectedValue)) {
      return Array.isArray(actualValue) && actualValue.length === expectedValue.length &&
        expectedValue.every((value, index) => contains(actualValue[index], value));
    }
    if (expectedValue && typeof expectedValue === 'object') {
      return actualValue && typeof actualValue === 'object' && !Array.isArray(actualValue) &&
        Object.entries(expectedValue).every(([key, value]) => contains(actualValue[key], value));
    }
    return actualValue === expectedValue;
  }
  if (
    actual?.name !== expected.name || actual?.target !== 'branch' || actual?.enforcement !== 'active' ||
    !Array.isArray(actual.bypass_actors) || actual.bypass_actors.length !== 0 ||
    !contains(actual.conditions?.ref_name, expected.conditions.ref_name)
  ) {
    throw new Error('Detailed ruleset identity, conditions, enforcement, or bypass policy did not match.');
  }
  if (!Array.isArray(actual.rules) || actual.rules.length !== expected.rules.length) {
    throw new Error('Detailed ruleset contains missing or unexpected rules.');
  }
  for (const expectedRule of expected.rules) {
    const matches = actual.rules.filter((rule) => rule.type === expectedRule.type);
    if (matches.length !== 1) throw new Error(`Detailed ruleset does not contain one ${expectedRule.type} rule.`);
    if (expectedRule.parameters && !contains(matches[0].parameters, expectedRule.parameters)) {
      throw new Error(`Detailed ${expectedRule.type} rule parameters did not match.`);
    }
  }
}

export function assertDependabotReadbacks(vulnerabilityAlerts, securityUpdates) {
  if (vulnerabilityAlerts !== null) {
    throw new Error('Dependabot vulnerability-alert readback did not confirm enablement.');
  }
  if (securityUpdates?.enabled !== true || securityUpdates.paused === true) {
    throw new Error('Dependabot security-update readback did not confirm active enablement.');
  }
}

export async function reconcileGithubGovernance({ repository, api, apply = false, confirmation }) {
  const target = assertGovernanceRepository(repository);
  if (typeof api !== 'function') throw new Error('A GitHub API implementation is required.');
  const plan = {
    repository: target,
    repositorySettings: repositorySettings(),
    ruleset: governanceRuleset(),
    dependabotAlerts: true,
    dependabotSecurityUpdates: true,
    actions: actionsPermissions(),
    workflowToken: workflowTokenPermissions()
  };
  if (!apply) return { applied: false, plan };
  if (confirmation !== target) throw new Error('Apply requires an exact repository confirmation.');

  const repositoryState = await api('GET', `/repos/${target}`);
  if (repositoryState?.full_name?.toLowerCase() !== target.toLowerCase() || repositoryState?.default_branch !== 'main') {
    throw new Error('Repository identity or default branch does not match the governance contract.');
  }
  const mainCommit = await api('GET', `/repos/${target}/commits/main`);
  if (!/^[a-f0-9]{40}$/.test(mainCommit?.sha || '')) throw new Error('Current main commit identity is invalid.');
  const checks = await api('GET', `/repos/${target}/commits/${mainCommit.sha}/check-runs?filter=latest&per_page=100`);
  const integrationIds = checkRunIntegrations(checks);
  const existingActions = await api('GET', `/repos/${target}/actions/permissions`);
  const existingWorkflowToken = await api('GET', `/repos/${target}/actions/permissions/workflow`);
  if (existingActions?.enabled !== true) throw new Error('GitHub Actions must already be enabled before governance activation.');
  if (!['all', 'local_only', 'selected'].includes(existingActions.allowed_actions)) {
    throw new Error('Current Actions allowlist policy is invalid.');
  }
  if (!['read', 'write'].includes(existingWorkflowToken?.default_workflow_permissions)) {
    throw new Error('Current workflow-token policy is invalid.');
  }

  await api('PATCH', `/repos/${target}`, repositorySettings());
  await api('PUT', `/repos/${target}/actions/permissions`, actionsPermissions(existingActions));
  await api('PUT', `/repos/${target}/actions/permissions/workflow`, workflowTokenPermissions());
  await api('PUT', `/repos/${target}/vulnerability-alerts`);
  await api('PUT', `/repos/${target}/automated-security-fixes`);

  const rulesets = await api('GET', `/repos/${target}/rulesets?includes_parents=false`);
  if (!Array.isArray(rulesets)) throw new Error('Ruleset listing is invalid.');
  const matches = rulesets.filter((ruleset) => ruleset.name === GOVERNANCE_RULESET_NAME && ruleset.target === 'branch');
  if (matches.length > 1) throw new Error('Multiple managed rulesets exist; refusing an ambiguous update.');
  const payload = governanceRuleset(integrationIds);
  let rulesetId;
  if (matches.length === 1) {
    rulesetId = matches[0].id;
    await api('PUT', `/repos/${target}/rulesets/${rulesetId}`, payload);
  } else {
    const created = await api('POST', `/repos/${target}/rulesets`, payload);
    rulesetId = created?.id;
  }
  if (!Number.isSafeInteger(rulesetId)) throw new Error('Managed ruleset identity is invalid.');

  const [
    verifiedRepository,
    verifiedRuleset,
    verifiedActions,
    verifiedWorkflowToken,
    verifiedVulnerabilityAlerts,
    verifiedSecurityUpdates
  ] = await Promise.all([
    api('GET', `/repos/${target}`),
    api('GET', `/repos/${target}/rulesets/${rulesetId}`),
    api('GET', `/repos/${target}/actions/permissions`),
    api('GET', `/repos/${target}/actions/permissions/workflow`),
    api('GET', `/repos/${target}/vulnerability-alerts`),
    api('GET', `/repos/${target}/automated-security-fixes`)
  ]);
  assertDetailedRuleset(verifiedRuleset, payload);
  assertDependabotReadbacks(verifiedVulnerabilityAlerts, verifiedSecurityUpdates);
  if (
    verifiedRepository.allow_squash_merge !== true ||
    verifiedRepository.allow_merge_commit !== false ||
    verifiedRepository.allow_rebase_merge !== false ||
    verifiedRepository.allow_auto_merge !== true ||
    verifiedRepository.delete_branch_on_merge !== true ||
    verifiedActions.enabled !== true ||
    verifiedActions.allowed_actions !== existingActions.allowed_actions ||
    verifiedActions.sha_pinning_required !== true ||
    verifiedWorkflowToken.default_workflow_permissions !== 'read' ||
    verifiedWorkflowToken.can_approve_pull_request_reviews !== false
  ) {
    throw new Error('GitHub governance readback did not match the requested policy.');
  }
  return { applied: true, repository: target, rulesetId, mainSha: mainCommit.sha };
}

export function createGovernanceApi({ token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('GitHub token is missing or invalid.');
  return async (method, endpoint, body) => {
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method) || !endpoint.startsWith('/repos/')) throw new Error('GitHub API request is not allowed.');
    const response = await fetchImpl(`${apiBase}${endpoint}`, {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2026-03-10',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`GitHub governance API request failed with status ${response.status}.`);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('GitHub governance API returned invalid JSON.');
    }
  };
}
