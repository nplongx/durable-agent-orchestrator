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

console.log('github-actions-provider P2 PASS');
