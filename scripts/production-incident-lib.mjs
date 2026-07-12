import { normalizeMonitorResult } from './readiness-monitor-lib.mjs';

export const INCIDENT_MARKER = '<!-- skyjo-production-readiness-incident -->';
export const INCIDENT_SOURCES_MARKER = 'skyjo-production-active-sources';
export const INCIDENT_TITLE = '[P0][Incident] Skyjo production release or readiness failure';
export const INCIDENT_LABELS = Object.freeze(['priority:p0', 'area:ops', 'incident:production', 'agent-ready']);
const incidentSources = new Set(['readiness', 'deployment']);

function assertRepository(value) {
  const repository = String(value || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub repository identity is invalid.');
  return repository;
}

function runUrl(repository, runId) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(runId || ''))) throw new Error('GitHub run identity is invalid.');
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function assertIncidentSource(value) {
  const source = String(value || 'readiness');
  if (!incidentSources.has(source)) throw new Error('Production incident source is invalid.');
  return source;
}

function activeSourcesFromIssue(issue) {
  const body = String(issue?.body || '');
  const markerPrefix = `<!-- ${INCIDENT_SOURCES_MARKER}:`;
  const matches = [...body.matchAll(/<!-- skyjo-production-active-sources:([^<>]*) -->/g)];
  if (matches.length === 0) {
    if (body.includes(markerPrefix)) throw new Error('Production incident contains an invalid active source marker.');
    return issue?.state === 'open' ? new Set(['readiness']) : new Set();
  }
  if (matches.length !== 1) throw new Error('Production incident contains an invalid active source marker.');
  const serialized = matches[0][1];
  const sources = new Set(serialized.split(',').filter(Boolean));
  if (
    [...sources].some((source) => !incidentSources.has(source)) ||
    [...sources].sort().join(',') !== serialized
  ) {
    throw new Error('Production incident contains an invalid active source marker.');
  }
  return sources;
}

function incidentBody(result, repository, runId, activeSources, source) {
  const sortedSources = [...activeSources].sort();
  const observed = sortedSources.length === 0 ? 'recovered' : 'failing';
  const failureClass = result.failureClass || 'none';
  const httpStatus = result.httpStatus === null ? 'not available' : String(result.httpStatus);
  const releaseSha = result.releaseSha || 'not available';
  return [
    INCIDENT_MARKER,
    `<!-- ${INCIDENT_SOURCES_MARKER}:${sortedSources.join(',')} -->`,
    '',
    'Skyjo production automation is reporting a sanitized operational state.',
    '',
    `- State: **${observed}**`,
    `- Active failure sources: \`${sortedSources.join(', ') || 'none'}\``,
    `- Latest signal: \`${source}:${result.status}\``,
    `- Checked at: \`${result.checkedAt}\``,
    `- Monitor: \`${result.monitor}\``,
    `- Failure class: \`${failureClass}\``,
    `- HTTP status: \`${httpStatus}\``,
    `- Verified release SHA: \`${releaseSha}\``,
    `- Evidence: [GitHub Actions run](${runUrl(repository, runId)})`,
    '',
    'Response bodies, exception messages, host paths, credentials, room data, and user data are intentionally excluded.',
    '',
    sortedSources.length === 0
      ? 'The monitor recovered. This incident is closed automatically.'
      : 'The next agent should inspect sanitized workflow evidence and the VPS journal, then keep remediation on this issue until every active failure source recovers.',
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
  const source = assertIncidentSource(options.source);
  if (result.monitor !== 'public') throw new Error('Only public monitor results can reconcile GitHub incidents.');
  const api = options.api;
  if (typeof api !== 'function') throw new Error('A GitHub API implementation is required.');

  const issues = incidentIssues(await api('GET', `/repos/${repository}/issues?state=all&labels=incident%3Aproduction&per_page=100`));
  const primary = issues[0];
  const duplicates = issues.slice(1).filter((issue) => issue.state === 'open');
  const activeSources = new Set();
  for (const issue of issues.filter((entry) => entry.state === 'open')) {
    for (const activeSource of activeSourcesFromIssue(issue)) activeSources.add(activeSource);
  }
  for (const duplicate of duplicates) {
    await api('PATCH', `/repos/${repository}/issues/${duplicate.number}`, { state: 'closed', state_reason: 'not_planned' });
  }

  if (result.status === 'healthy') {
    activeSources.delete(source);
    if (!primary || activeSources.size === 0) {
      if (primary?.state === 'open') {
        await api('PATCH', `/repos/${repository}/issues/${primary.number}`, {
          body: incidentBody(result, repository, runId, activeSources, source),
          state: 'closed',
          state_reason: 'completed'
        });
      }
      return { action: primary?.state === 'open' ? 'closed' : 'none', issueNumber: primary?.number || null };
    }
    await api('PATCH', `/repos/${repository}/issues/${primary.number}`, {
      title: INCIDENT_TITLE,
      body: incidentBody(result, repository, runId, activeSources, source),
      labels: [...INCIDENT_LABELS],
      state: 'open'
    });
    return { action: primary.state === 'open' ? 'updated' : 'reopened', issueNumber: primary.number };
  }

  activeSources.add(source);
  const body = incidentBody(result, repository, runId, activeSources, source);
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
