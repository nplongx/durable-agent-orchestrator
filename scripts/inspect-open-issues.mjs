#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) {
  console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
  process.exit(2);
}

const apiRoot = 'https://api.github.com/repos/' + repository;
const runUrl = 'https://github.com/' + repository + '/actions/runs/' + (process.env.GITHUB_RUN_ID || 'unknown');
const commit = process.env.GITHUB_SHA || 'unknown';
const eventName = process.env.GITHUB_EVENT_NAME || 'unknown';
const refName = process.env.GITHUB_REF_NAME || 'unknown';
const logRoot = process.env.INSPECTION_LOG_DIR || process.env.RUNNER_TEMP || '/tmp';
const checks = [
  { key: 'npm-ci', name: 'Dependency installation (npm ci)', env: 'RESULT_NPM_CI', log: 'npm-ci.log', remedy: 'Check lockfile consistency, registry access, engine requirements, and dependency install errors.' },
  { key: 'docs-check', name: 'Documentation and local-link validation', env: 'RESULT_DOCS', log: 'docs-check.log', remedy: 'Fix the failing documentation validator or link and add a regression check when applicable.' },
  { key: 'site-check', name: 'Static website validation', env: 'RESULT_SITE', log: 'site-check.log', remedy: 'Fix the static-site check without weakening accessibility, branding, or link validation.' },
  { key: 'npm-test', name: 'Primary acceptance and regression suite', env: 'RESULT_NPM_TEST', log: 'npm-test.log', remedy: 'Reproduce the failed test in a clean checkout, determine the root cause, and add or update focused regression coverage.' },
  { key: 'batch-tests', name: 'Durable execution batch tests', env: 'RESULT_BATCH', log: 'batch-tests.log', remedy: 'Investigate the failing batch, cancellation, claim, concurrency, or recovery invariant before changing expected behavior.' },
  { key: 'package-reproducibility', name: 'Package reproducibility verification', env: 'RESULT_REPRO', log: 'package-reproducibility.log', remedy: 'Compare independent build manifests and hashes; do not update expected hashes merely to silence a mismatch.' },
  { key: 'phase2-readiness-audit', name: 'Phase 2 readiness audit regression test', env: 'RESULT_READINESS', log: 'phase2-readiness-audit.log', remedy: 'Investigate the failed assertion and preserve fail-closed readiness behavior. The audit must not be weakened to produce a pass.' },
];

function outcomeOf(check) {
  const value = (process.env[check.env] || 'skipped').toLowerCase();
  return ['success', 'failure', 'cancelled', 'skipped'].includes(value) ? value : 'unknown';
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function recentLog(check) {
  const file = path.join(logRoot, check.log);
  if (!fs.existsSync(file)) return 'No step log was produced for this run.';
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const tail = lines.slice(-100).join('\n');
  const bounded = tail.length > 14000 ? tail.slice(-14000) : tail;
  return bounded
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

async function api(pathname, options = {}) {
  const response = await fetch(apiRoot + pathname, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!response.ok) {
    throw new Error('GitHub API ' + options.method + ' ' + pathname + ' failed (' + response.status + '): ' + JSON.stringify(value).slice(0, 2000));
  }
  return value;
}

async function listOpenIssues() {
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    const entries = await api('/issues?state=open&per_page=100&page=' + page);
    results.push(...entries.filter((entry) => !entry.pull_request));
    if (entries.length < 100) break;
  }
  return results;
}

function markerFor(key) {
  return '<!-- runalith-inspection-key: ' + key + ' -->';
}

function observation(check, outcome) {
  const passed = outcome === 'success';
  const status = passed ? 'PASS' : outcome.toUpperCase();
  const message = passed
    ? 'This check passed in the latest run. The issue remains open for maintainer verification; the workflow never closes issues automatically.'
    : outcome === 'failure'
      ? 'This check failed. The log excerpt below is diagnostic evidence, not a root-cause conclusion.'
      : 'This check did not run to completion in this workflow run.';
  const log = passed ? '' : '\n\n<details><summary>Recent step log</summary>\n\n<pre>\n' + escapeHtml(recentLog(check)) + '\n</pre>\n</details>';
  return '<!-- latest-observation:start -->\n### Latest automated observation\n\n' +
    '- Status: **' + status + '**\n' +
    '- Workflow run: [' + runUrl + '](' + runUrl + ')\n' +
    '- Commit: ' + commit + '\n' +
    '- Trigger: ' + eventName + ' on ' + refName + '\n' +
    '- Observed at (UTC): ' + new Date().toISOString() + '\n\n' +
    message + log + '\n\n<!-- latest-observation:end -->';
}

function replaceObservation(body, replacement) {
  const start = '<!-- latest-observation:start -->';
  const end = '<!-- latest-observation:end -->';
  const from = body.indexOf(start);
  const to = body.indexOf(end);
  if (from >= 0 && to >= from) return body.slice(0, from) + replacement + body.slice(to + end.length);
  return body.trimEnd() + '\n\n' + replacement + '\n';
}

function newIssueBody(check, outcome) {
  return markerFor(check.key) + '\n' +
    '## Summary\n\nThe scheduled repository inspection detected a failing validation check: **' + check.name + '**.\n\n' +
    '## Impact\n\nA failing check may indicate a regression or a newly exposed mismatch. This generated issue records the observation; maintainers must confirm the root cause before changing runtime behavior or expected results.\n\n' +
    '## Triage checklist\n\n' +
    '- [ ] Reproduce the result from the linked workflow run in a clean checkout.\n' +
    '- [ ] Identify the root cause and affected behavior; distinguish a code regression from an invalid/stale test expectation.\n' +
    '- [ ] Add or update focused regression coverage.\n' +
    '- [ ] Update documentation if observable behavior or a known limitation changes.\n' +
    '- [ ] Rerun the affected check and confirm its result.\n\n' +
    '## Suggested first step\n\n' + check.remedy + '\n\n' +
    '## Safety constraints\n\nDo not weaken approval, authorization, audit integrity, recovery, provenance, or fail-closed release gates to make a check pass. Do not attach credentials, private runtime state, or unredacted secrets.\n\n' +
    observation(check, outcome);
}

function updateSummary(openIssues, changes, outcomes) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    '# Runalith repository inspection',
    '',
    '- Repository: ' + repository,
    '- Commit: ' + commit,
    '- Workflow run: ' + runUrl,
    '- Open issues after inspection: ' + openIssues.length,
    '',
    '## Validation results',
    '',
    '| Check | Result |',
    '|---|---|',
    ...checks.map((check) => '| ' + check.name + ' | ' + outcomeOf(check).toUpperCase() + ' |'),
    '',
    '## Issue actions',
    '',
    ...(changes.length ? changes.map((change) => '- ' + change) : ['- No issues created or updated.']),
    '',
    '## Open issue inventory',
    '',
    ...(openIssues.length
      ? openIssues.map((issue) => '- [#' + issue.number + ' ' + issue.title + '](' + issue.html_url + ') — updated ' + issue.updated_at.slice(0, 10))
      : ['- No open issues.']),
    '',
    'The workflow records failures and surfaces stale issues but does not close issues automatically or change release authorization.',
    '',
  ];
  fs.appendFileSync(file, lines.join('\n'));
}

const outcomes = new Map(checks.map((check) => [check.key, outcomeOf(check)]));
let issues = await listOpenIssues();
const actions = [];

for (const check of checks) {
  const outcome = outcomes.get(check.key);
  const marker = markerFor(check.key);
  let existing = issues.find((issue) => (issue.body || '').includes(marker));

  if (outcome === 'failure') {
    const latest = observation(check, outcome);
    if (existing) {
      const body = replaceObservation(existing.body || '', latest);
      await api('/issues/' + existing.number, { method: 'PATCH', body: JSON.stringify({ body }) });
      actions.push('Updated existing issue #' + existing.number + ' for ' + check.name + '.');
    } else {
      const created = await api('/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: '[Inspection] ' + check.name,
          body: newIssueBody(check, outcome),
          labels: ['bug'],
        }),
      });
      issues.push(created);
      actions.push('Created issue #' + created.number + ' for ' + check.name + '.');
    }
  } else if (existing && outcome === 'success') {
    const body = replaceObservation(existing.body || '', observation(check, outcome));
    if (body !== existing.body) {
      await api('/issues/' + existing.number, { method: 'PATCH', body: JSON.stringify({ body }) });
      actions.push('Updated issue #' + existing.number + ' with latest ' + outcome + ' result for ' + check.name + '; it was not closed.');
    }
  } else if (outcome === 'success') {
    actions.push('No issue needed for passing check: ' + check.name + '.');
  } else {
    actions.push('No issue created for ' + check.name + ' because result is ' + outcome + '.');
  }
}

issues = await listOpenIssues();
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
const stale = issues.filter((issue) => Date.parse(issue.updated_at) < thirtyDaysAgo);
console.log('Repository inspection completed. Open issues: ' + issues.length + '; not updated in 30 days: ' + stale.length + '.');
for (const change of actions) console.log('- ' + change);
if (stale.length) {
  console.log('Stale open issues are reported for human triage; this workflow will not close or duplicate them automatically:');
  for (const issue of stale) console.log('- #' + issue.number + ' ' + issue.title + ' (' + issue.html_url + ')');
}
updateSummary(issues, actions, outcomes);
