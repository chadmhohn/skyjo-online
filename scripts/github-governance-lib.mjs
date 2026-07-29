export const GOVERNANCE_RULESET_NAME = 'Protect main';
export const RELEASE_TAG_CREATION_RULESET_NAME = 'Release tag creation';
export const RELEASE_TAG_IMMUTABILITY_RULESET_NAME = 'Immutable release tags';
export const REQUIRED_CHECKS = Object.freeze([
  'CI / Quality & Security',
  'iOS / Build',
  'iOS / Domain & Persistence',
  'iOS / Networking Contracts',
  'iOS / UI & Accessibility',
  'CI / Unit (domain)',
  'CI / Unit (data)',
  'CI / E2E (chromium 1)',
  'CI / E2E (chromium 2)',
  'CI / E2E (webkit)',
  'CI / Visual & Accessibility',
  'CI / Lighthouse',
  'CI / Load & Recovery',
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
      },
      {
        type: 'code_scanning',
        parameters: {
          code_scanning_tools: [{
            tool: 'CodeQL',
            alerts_threshold: 'errors',
            security_alerts_threshold: 'high_or_higher'
          }]
        }
      }
    ]
  };
}

function releaseTagConditions() {
  return {
    ref_name: {
      include: ['refs/tags/v*'],
      exclude: []
    }
  };
}

export function releaseTagCreationRuleset(releaseActorId = null) {
  return {
    name: RELEASE_TAG_CREATION_RULESET_NAME,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [{
      actor_id: releaseActorId,
      actor_type: 'User',
      bypass_mode: 'always'
    }],
    conditions: releaseTagConditions(),
    rules: [{ type: 'creation' }]
  };
}

export function immutableReleaseTagsRuleset() {
  return {
    name: RELEASE_TAG_IMMUTABILITY_RULESET_NAME,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: releaseTagConditions(),
    rules: [
      { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
      { type: 'deletion' }
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

const CHECK_RUN_PAGE_LIMIT = 100;
const CHECK_RUN_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

function completedAtTimestamp(value, context) {
  if (typeof value !== 'string') throw new Error(`Required check ${context} has an invalid completion timestamp.`);
  const match = CHECK_RUN_TIMESTAMP.exec(value);
  if (!match) throw new Error(`Required check ${context} has an invalid completion timestamp.`);
  const timestamp = Date.parse(value);
  const expected = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== expected) {
    throw new Error(`Required check ${context} has an invalid completion timestamp.`);
  }
  return timestamp;
}

function validateRequiredCheck(check, context, mainSha, checkIds) {
  if (!Number.isSafeInteger(check?.id) || check.id < 1 || checkIds.has(check.id)) {
    throw new Error(`Required check ${context} has an invalid or repeated check-run identity.`);
  }
  checkIds.add(check.id);
  if (check.head_sha !== mainSha) {
    throw new Error(`Required check ${context} does not belong to current main.`);
  }
  if (check.status !== 'completed') {
    throw new Error(`Required check ${context} is not settled on current main.`);
  }
  const completedAt = completedAtTimestamp(check.completed_at, context);
  if (!Number.isSafeInteger(check.app?.id) || check.app.id < 1) {
    throw new Error(`Required check ${context} has no trustworthy GitHub App identity.`);
  }
  return { check, completedAt };
}

export function checkRunIntegrations(checkRuns, mainSha) {
  if (!checkRuns || !Array.isArray(checkRuns.check_runs)) throw new Error('Current main check-run response is invalid.');
  if (
    !Number.isSafeInteger(checkRuns.total_count) || checkRuns.total_count < 0 ||
    checkRuns.total_count > CHECK_RUN_PAGE_LIMIT
  ) {
    throw new Error('Current main check-run count is invalid or exceeds the bounded governance preflight response.');
  }
  if (checkRuns.check_runs.length > CHECK_RUN_PAGE_LIMIT || checkRuns.total_count !== checkRuns.check_runs.length) {
    throw new Error('Current main check-run count does not match the bounded response.');
  }
  const integrationIds = new Map();
  const checkIds = new Set();
  for (const context of REQUIRED_CHECKS) {
    const matches = checkRuns.check_runs.filter((check) => check.name === context);
    if (matches.length === 0) throw new Error(`Required check ${context} is not represented on current main.`);
    const validated = matches.map((check) => validateRequiredCheck(check, context, mainSha, checkIds));
    const appIds = new Set(validated.map(({ check }) => check.app.id));
    if (appIds.size !== 1) {
      throw new Error(`Duplicate required check ${context} has conflicting GitHub App identities.`);
    }
    const newestTimestamp = Math.max(...validated.map(({ completedAt }) => completedAt));
    const newest = validated.filter(({ completedAt }) => completedAt === newestTimestamp);
    if (newest.length !== 1) {
      throw new Error(`Duplicate required check ${context} has no unique newest completion.`);
    }
    if (newest[0].check.conclusion !== 'success') {
      throw new Error(`Required check ${context} is not green on current main.`);
    }
    integrationIds.set(context, newest[0].check.app.id);
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
  function isCanonicalOmittedFalseUpdateParameters(actualRule, expectedRule) {
    if (
      expected.target !== 'tag' ||
      expectedRule.type !== 'update' ||
      Object.hasOwn(actualRule, 'parameters') ||
      !expectedRule.parameters ||
      typeof expectedRule.parameters !== 'object' ||
      Array.isArray(expectedRule.parameters)
    ) return false;
    const keys = Reflect.ownKeys(expectedRule.parameters);
    return keys.length === 1 &&
      keys[0] === 'update_allows_fetch_and_merge' &&
      expectedRule.parameters.update_allows_fetch_and_merge === false;
  }
  if (
    actual?.name !== expected.name || actual?.target !== expected.target || actual?.enforcement !== 'active' ||
    !contains(actual.bypass_actors, expected.bypass_actors) ||
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
    if (
      expectedRule.parameters &&
      !contains(matches[0].parameters, expectedRule.parameters) &&
      !isCanonicalOmittedFalseUpdateParameters(matches[0], expectedRule)
    ) {
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

export function assertGovernanceReadbacks({
  repository,
  ruleset,
  expectedRuleset,
  actions,
  expectedAllowedActions,
  workflowToken,
  vulnerabilityAlerts,
  securityUpdates,
  additionalRulesets = []
}) {
  assertDetailedRuleset(ruleset, expectedRuleset);
  for (const pair of additionalRulesets) assertDetailedRuleset(pair.actual, pair.expected);
  assertDependabotReadbacks(vulnerabilityAlerts, securityUpdates);
  if (
    repository?.has_issues !== true ||
    repository?.allow_squash_merge !== true ||
    repository?.allow_merge_commit !== false ||
    repository?.allow_rebase_merge !== false ||
    repository?.allow_auto_merge !== true ||
    repository?.delete_branch_on_merge !== true ||
    repository?.squash_merge_commit_title !== 'PR_TITLE' ||
    repository?.squash_merge_commit_message !== 'PR_BODY' ||
    actions?.enabled !== true ||
    actions?.allowed_actions !== expectedAllowedActions ||
    actions?.sha_pinning_required !== true ||
    workflowToken?.default_workflow_permissions !== 'read' ||
    workflowToken?.can_approve_pull_request_reviews !== false
  ) {
    throw new Error('GitHub governance readback did not match the requested policy.');
  }
}

export async function reconcileGithubGovernance({ repository, api, apply = false, confirmation }) {
  const target = assertGovernanceRepository(repository);
  if (typeof api !== 'function') throw new Error('A GitHub API implementation is required.');
  const plan = {
    repository: target,
    repositorySettings: repositorySettings(),
    ruleset: governanceRuleset(),
    releaseTagRulesets: [releaseTagCreationRuleset(), immutableReleaseTagsRuleset()],
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
  const [ownerName] = target.split('/');
  if (
    repositoryState.owner?.login?.toLowerCase() !== ownerName.toLowerCase() ||
    repositoryState.owner?.type !== 'User' ||
    !Number.isSafeInteger(repositoryState.owner?.id) || repositoryState.owner.id < 1
  ) {
    throw new Error('The user-owned repository release identity is invalid.');
  }
  const mainCommit = await api('GET', `/repos/${target}/commits/main`);
  if (!/^[a-f0-9]{40}$/.test(mainCommit?.sha || '')) throw new Error('Current main commit identity is invalid.');
  const checks = await api('GET', `/repos/${target}/commits/${mainCommit.sha}/check-runs?filter=latest&per_page=100`);
  const integrationIds = checkRunIntegrations(checks, mainCommit.sha);
  const existingActions = await api('GET', `/repos/${target}/actions/permissions`);
  const existingWorkflowToken = await api('GET', `/repos/${target}/actions/permissions/workflow`);
  if (existingActions?.enabled !== true) throw new Error('GitHub Actions must already be enabled before governance activation.');
  if (!['all', 'local_only', 'selected'].includes(existingActions.allowed_actions)) {
    throw new Error('Current Actions allowlist policy is invalid.');
  }
  if (!['read', 'write'].includes(existingWorkflowToken?.default_workflow_permissions)) {
    throw new Error('Current workflow-token policy is invalid.');
  }
  const rulesets = await api('GET', `/repos/${target}/rulesets?includes_parents=false`);
  if (!Array.isArray(rulesets)) throw new Error('Ruleset listing is invalid.');
  const desiredRulesets = [
    { key: 'immutableReleaseTags', payload: immutableReleaseTagsRuleset() },
    { key: 'releaseTagCreation', payload: releaseTagCreationRuleset(repositoryState.owner.id) },
    { key: 'main', payload: governanceRuleset(integrationIds) }
  ];
  const existingRulesetIds = new Map();
  for (const desired of desiredRulesets) {
    const matches = rulesets.filter((ruleset) => ruleset.name === desired.payload.name);
    if (matches.length > 1 || (matches.length === 1 && matches[0].target !== desired.payload.target)) {
      throw new Error(`Managed ruleset ${desired.payload.name} is ambiguous or targets the wrong ref type.`);
    }
    if (matches.length === 0) {
      existingRulesetIds.set(desired.key, null);
      continue;
    }
    const rulesetId = matches[0].id;
    if (!Number.isSafeInteger(rulesetId) || rulesetId < 1) throw new Error('Managed ruleset identity is invalid.');
    const existingRuleset = await api('GET', `/repos/${target}/rulesets/${rulesetId}`);
    if (existingRuleset?.id !== rulesetId || existingRuleset?.name !== desired.payload.name || existingRuleset?.target !== desired.payload.target) {
      throw new Error('Managed ruleset detail does not match its listing.');
    }
    existingRulesetIds.set(desired.key, rulesetId);
  }

  // All fallible discovery and identity checks happen before the first write. GitHub
  // does not offer a transaction across these repository settings, so each write is
  // deliberately idempotent and the complete policy is verified again below.
  const rulesetIds = new Map();
  for (const desired of desiredRulesets) {
    const existingRulesetId = existingRulesetIds.get(desired.key);
    let rulesetId;
    if (existingRulesetId === null) {
      const created = await api('POST', `/repos/${target}/rulesets`, desired.payload);
      rulesetId = created?.id;
    } else {
      rulesetId = existingRulesetId;
      await api('PUT', `/repos/${target}/rulesets/${rulesetId}`, desired.payload);
    }
    if (!Number.isSafeInteger(rulesetId) || rulesetId < 1) throw new Error('Managed ruleset identity is invalid.');
    rulesetIds.set(desired.key, rulesetId);
  }
  await api('PATCH', `/repos/${target}`, repositorySettings());
  await api('PUT', `/repos/${target}/actions/permissions`, actionsPermissions(existingActions));
  await api('PUT', `/repos/${target}/actions/permissions/workflow`, workflowTokenPermissions());
  await api('PUT', `/repos/${target}/vulnerability-alerts`);
  await api('PUT', `/repos/${target}/automated-security-fixes`);

  const [
    verifiedRepository,
    verifiedRulesets,
    verifiedActions,
    verifiedWorkflowToken,
    verifiedVulnerabilityAlerts,
    verifiedSecurityUpdates,
    verifiedMainCommit
  ] = await Promise.all([
    api('GET', `/repos/${target}`),
    Promise.all(desiredRulesets.map((desired) => api('GET', `/repos/${target}/rulesets/${rulesetIds.get(desired.key)}`))),
    api('GET', `/repos/${target}/actions/permissions`),
    api('GET', `/repos/${target}/actions/permissions/workflow`),
    api('GET', `/repos/${target}/vulnerability-alerts`),
    api('GET', `/repos/${target}/automated-security-fixes`),
    api('GET', `/repos/${target}/commits/main`)
  ]);
  if (verifiedMainCommit?.sha !== mainCommit.sha) throw new Error('Main advanced while repository governance was being applied.');
  const mainIndex = desiredRulesets.findIndex(({ key }) => key === 'main');
  assertGovernanceReadbacks({
    repository: verifiedRepository,
    ruleset: verifiedRulesets[mainIndex],
    expectedRuleset: desiredRulesets[mainIndex].payload,
    additionalRulesets: desiredRulesets
      .map((desired, index) => ({ actual: verifiedRulesets[index], expected: desired.payload, key: desired.key }))
      .filter(({ key }) => key !== 'main'),
    actions: verifiedActions,
    expectedAllowedActions: existingActions.allowed_actions,
    workflowToken: verifiedWorkflowToken,
    vulnerabilityAlerts: verifiedVulnerabilityAlerts,
    securityUpdates: verifiedSecurityUpdates
  });
  return {
    applied: true,
    repository: target,
    rulesetId: rulesetIds.get('main'),
    releaseTagRulesetIds: [rulesetIds.get('releaseTagCreation'), rulesetIds.get('immutableReleaseTags')],
    mainSha: mainCommit.sha
  };
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
