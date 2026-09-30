import assert from 'node:assert/strict';
import { GitHubActionsProvider } from '../src/runtime/github-actions-provider.js';

const input = {
  schema_version: 1,
  job_id: 'job_p2',
  task_id: 'task_p2',
  lease_id: 'lease_p2',
  attempt: 1,
  role: 'engineer',
  input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://p2',
  workspace: '/workspace',
  required_evidence: ['result.json']
};

const calls = [];
let statusReads = 0;
const fetchImpl = async (url, options = {}) => {
  calls.push({ url, options });
  if (url.endsWith('/dispatches')) {
    return new Response(JSON.stringify({ workflow_run_id: 12345, run_url: 'https://api.github.com/runs/12345', html_url: 'https://github.com/example/run/12345' }), { status: 200 });
  }
  if (url.endsWith('/actions/runs/12345')) {
    statusReads++;
    const completed = statusReads >= 2;
    return new Response(JSON.stringify({ id: 12345, status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null, html_url: 'https://github.com/example/run/12345', head_sha: input.input_commit, run_attempt: 1, created_at: '2026-09-29T08:00:00Z' }), { status: 200 });
  }
  if (url.includes('/actions/runs/12345/artifacts')) {
    return new Response(JSON.stringify({ artifacts: [{ id: 9, name: 'p2-provider-12345', expired: false, archive_download_url: 'https://artifact.test/9' }] }), { status: 200 });
  }
  if (url.endsWith('/actions/runs/12345/cancel')) return new Response('', { status: 202 });
  throw new Error(`unexpected request ${url}`);
};

const provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p2-provider-smoke.yml', ref: 'main', fetchImpl,
  artifactDownloader: async () => ({
    schema_version: 1, job_id: input.job_id, task_id: input.task_id, lease_id: input.lease_id,
    attempt: 1, status: 'SUCCEEDED', input_commit: input.input_commit, output_commit: input.input_commit,
    exit_code: 0, provider_run_id: '12345', evidence_artifact: 'p2-provider-12345', evidence_refs: ['result.json'],
    started_at: '2026-09-29T08:00:00Z', finished_at: '2026-09-29T08:00:01Z', error: null
  })
});

const dispatched = await provider.dispatch(input);
assert.equal(dispatched.provider_run_id, '12345');
const dispatchBody = JSON.parse(calls[0].options.body);
assert.equal(dispatchBody.ref, 'main');
assert.deepEqual(dispatchBody.inputs, {
  job_id: input.job_id, task_id: input.task_id, lease_id: input.lease_id, attempt: '1', input_commit: input.input_commit
});

const status = await provider.getStatus('12345');
assert.equal(status.state, 'RUNNING');
const result = await provider.collectResult('12345');
assert.equal(result.status, 'SUCCEEDED');
assert.equal(result.provider_run_id, '12345');
assert.equal(result.output_commit, input.input_commit);
await provider.cancel('12345');
assert.ok(calls.some(call => call.url.endsWith('/actions/runs/12345/cancel')));

// GitHub's real workflow_dispatch endpoint normally returns 204 with no run id.
const pendingProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p2-provider-smoke.yml', ref: 'main',
  fetchImpl: async (url) => {
    assert.ok(url.endsWith('/dispatches'));
    return new Response(null, { status: 204 });
  }
});
const pending = await pendingProvider.dispatch(input);
assert.equal(pending.provider_run_id, null);
assert.equal(pending.pending_reconciliation, true);
assert.equal(pending.state, 'DISPATCHING');

let discoveredDispatchKey = null;
const persistedStore = { db: { exec() {}, prepare() { return { run() {}, get() { return null; } }; } } };
const reconciledProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p2-provider-smoke.yml', ref: 'main', store: persistedStore,
  fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/dispatches')) {
      discoveredDispatchKey = JSON.parse(options.body).inputs.dispatch_key;
      return new Response(null, { status: 204 });
    }
    if (url.includes('/actions/workflows/p2-provider-smoke.yml/runs?')) {
      return new Response(JSON.stringify({ workflow_runs: [{
        id: 67890, display_title: `P2 provider ${discoveredDispatchKey}`, name: 'P2 GitHub Actions Provider Smoke',
        status: 'in_progress', conclusion: null, html_url: 'https://github.com/example/run/67890', created_at: new Date().toISOString()
      }] }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  }
});
const reconciled = await reconciledProvider.dispatch({ ...input, dispatch_key: 'd'.repeat(64) });
assert.equal(reconciled.provider_run_id, '67890');
assert.equal(reconciled.state, 'RUNNING');

const p3Calls = [];
const p3Provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async (url, options = {}) => {
    p3Calls.push({ url, options });
    return new Response(JSON.stringify({ workflow_run_id: 24680, html_url: 'https://github.com/example/run/24680' }), { status: 200 });
  }
});
assert.equal(new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo',
  fetchImpl: async () => new Response('', { status: 204 })
}).workflow, 'p3-worker.yml');
await p3Provider.dispatch({
  ...input,
  role: 'architect',
  task_payload_inline: { schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect' },
  dispatch_key: 'e'.repeat(64)
});
const p3Body = JSON.parse(p3Calls[0].options.body);
assert.equal(p3Body.inputs.task_payload_ref, input.task_payload_ref);
assert.equal(p3Body.inputs.role, 'architect');
assert.deepEqual(JSON.parse(p3Body.inputs.task_payload_json), {
  schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect'
});

console.log('github-actions-provider P2 PASS');
