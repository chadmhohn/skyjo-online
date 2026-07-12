import { normalizeMonitorResult } from './readiness-monitor-lib.mjs';

export const INCIDENT_MARKER = '<!-- skyjo-production-readiness-incident -->';
export const INCIDENT_TITLE = '[P0][Incident] Skyjo production readiness failure';
export const INCIDENT_LABELS = Object.freeze(['priority:p0', 'area:ops', 'incident:production', 'agent-ready']);

function assertRepository(value) {
  const repository = String(value || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub repository identity is invalid.');
  return repository;
}

function runUrl(repository, runId) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(runId || ''))) throw new Error('GitHub run identity is invalid.');
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function incidentBody(result, repository, runId) {
  const observed = result.status === 'healthy' ? 'recovered' : 'failing';
  const failureClass = result.failureClass || 'none';
  const httpStatus = result.httpStatus === null ? 'not available' : String(result.httpStatus);
  const releaseSha = result.releaseSha || 'not available';
  return [
    INCIDENT_MARKER,
    '',
    'Skyjo production readiness monitoring is reporting a sanitized operational state.',
    '',
    `- State: **${observed}**`,
    `- Checked at: \`${result.checkedAt}\``,
    `- Monitor: \`${result.monitor}\``,
    `- Failure class: \`${failureClass}\``,
    `- HTTP status: \`${httpStatus}\``,
    `- Verified release SHA: \`${releaseSha}\``,
    `- Evidence: [GitHub Actions run](${runUrl(repository, runId)})`,
    '',
    'Response bodies, exception messages, host paths, credentials, room data, and user data are intentionally excluded.',
    '',
    result.status === 'healthy'
      ? 'The monitor recovered. This incident is closed automatically.'
      : 'The next agent should inspect sanitized workflow evidence and the VPS journal, then keep remediation on this issue until readiness recovers.',
    ''
  ].join('\n');
}

function incidentIssues(issues) {
  if (!Array.isArray(issues)) throw new Error('GitHub issue response is invalid.');
  return issues
    .filter((issue) => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(INCIDENT_MARKER))
    .sort((left, right) => Number(right.number) - Number(left.number));
}

export async function reconcileProductionIncident(options) {
  const repository = assertRepository(options.repository);
  const runId = String(options.runId || '');
  const result = normalizeMonitorResult(options.result);
  if (result.monitor !== 'public') throw new Error('Only public monitor results can reconcile GitHub incidents.');
  const api = options.api;
  if (typeof api !== 'function') throw new Error('A GitHub API implementation is required.');

  const issues = incidentIssues(await api('GET', `/repos/${repository}/issues?state=all&labels=incident%3Aproduction&per_page=100`));
  const primary = issues[0];
  const duplicates = issues.slice(1).filter((issue) => issue.state === 'open');
  for (const duplicate of duplicates) {
    await api('PATCH', `/repos/${repository}/issues/${duplicate.number}`, { state: 'closed', state_reason: 'not_planned' });
  }

  if (result.status === 'healthy') {
    for (const issue of issues.filter((entry) => entry.state === 'open')) {
      await api('PATCH', `/repos/${repository}/issues/${issue.number}`, {
        body: incidentBody(result, repository, runId),
        state: 'closed',
        state_reason: 'completed'
      });
    }
    return { action: issues.some((entry) => entry.state === 'open') ? 'closed' : 'none', issueNumber: primary?.number || null };
  }

  const body = incidentBody(result, repository, runId);
  if (primary) {
    await api('PATCH', `/repos/${repository}/issues/${primary.number}`, {
      title: INCIDENT_TITLE,
      body,
      labels: [...INCIDENT_LABELS],
      state: 'open'
    });
    return { action: primary.state === 'open' ? 'updated' : 'reopened', issueNumber: primary.number };
  }
  const created = await api('POST', `/repos/${repository}/issues`, {
    title: INCIDENT_TITLE,
    body,
    labels: [...INCIDENT_LABELS]
  });
  if (!Number.isSafeInteger(created?.number)) throw new Error('GitHub did not return the created incident identity.');
  return { action: 'created', issueNumber: created.number };
}

export function createGithubApi({ token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (typeof token !== 'string' || token.length < 1 || /[\r\n]/.test(token)) throw new Error('GitHub token is missing or invalid.');
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
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}.`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('GitHub API returned invalid JSON.');
    }
  };
}
