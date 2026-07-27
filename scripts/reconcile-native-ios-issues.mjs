#!/usr/bin/env node

import assert from 'node:assert/strict';

const managedLabels = ['agent-ready', 'blocked', 'in-progress'];

export function desiredManagedLabel({ state, labels = [], openBlockers = 0 }) {
  if (state !== 'open') return null;
  if (labels.includes('human-gate')) return 'blocked';
  if (openBlockers > 0) return 'blocked';
  if (labels.includes('in-progress')) return 'in-progress';
  return 'agent-ready';
}

function selfTest() {
  assert.equal(desiredManagedLabel({ state: 'closed' }), null);
  assert.equal(desiredManagedLabel({ state: 'open', openBlockers: 2 }), 'blocked');
  assert.equal(desiredManagedLabel({ state: 'open', labels: ['human-gate'] }), 'blocked');
  assert.equal(desiredManagedLabel({ state: 'open', labels: ['in-progress'] }), 'in-progress');
  assert.equal(desiredManagedLabel({ state: 'open' }), 'agent-ready');
  console.log('Native iOS issue orchestration self-test passed.');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GITHUB_TOKEN || '';
  const programIssue = Number(process.env.SKYJO_NATIVE_PROGRAM_ISSUE || 179);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair.');
  }
  if (!token) throw new Error('GITHUB_TOKEN is required.');

  async function api(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'skyjo-native-ios-issue-orchestrator',
        'X-GitHub-Api-Version': '2026-03-10',
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    if (!response.ok) {
      const requestId = response.headers.get('x-github-request-id') || 'unknown';
      throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed (${response.status}, request ${requestId}).`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function addLabel(issueNumber, label) {
    await api(`/repos/${repository}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: { labels: [label] }
    });
  }

  async function removeLabel(issueNumber, label) {
    await api(`/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE'
    });
  }

  const issues = await api(
    `/repos/${repository}/issues?state=all&labels=${encodeURIComponent('area:ios')}&per_page=100`
  );
  const managedIssues = issues.filter((issue) => !issue.pull_request && issue.number !== programIssue);

  for (const issue of managedIssues) {
    const blockers = await api(
      `/repos/${repository}/issues/${issue.number}/dependencies/blocked_by?per_page=100`
    );
    const current = new Set(issue.labels.map((label) => label.name));
    const desired = desiredManagedLabel({
      state: issue.state,
      labels: [...current],
      openBlockers: blockers.filter((blocker) => blocker.state !== 'closed').length
    });

    for (const label of managedLabels) {
      if (label === desired) {
        if (!current.has(label)) await addLabel(issue.number, label);
      } else if (current.has(label)) {
        await removeLabel(issue.number, label);
      }
    }
    console.log(`#${issue.number}: ${desired || 'closed'} (${blockers.filter((item) => item.state !== 'closed').length} open blocker(s))`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
