import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GitHubActionsProvider } from '../src/runtime/github-actions-provider.js';
import { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey } from '../src/runtime/provider-dispatch-identity.js';

const input = {
  schema_version: 1,
  job_id: 'job-contract',
  task_id: 'task-contract',
  lease_id: 'gateway-lease-contract',
  attempt: 1,
  owner_epoch: 1,
  role: 'engineer',
  input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://contract',
  workspace: 'ephemeral',
  required_evidence: ['result.json']
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// P3 dispatch must fail before the network boundary when no durable run ledger
// exists; otherwise a successful/ambiguous remote side effect could lose lineage.
let unledgeredDispatchCalls = 0;
const ambiguous = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'public-repo',
  fetchImpl: async (url) => {
    unledgeredDispatchCalls++;
    if (url.endsWith('/commits/ee24280441c2cf2d8ae4d706a295c90f8fef7bd6')) return jsonResponse({ sha: input.input_commit });
    if (url.endsWith('/dispatches')) throw new TypeError('simulated connection reset after dispatch request');
    throw new Error(`unexpected request ${url}`);
  }
});
await assert.rejects(
  ambiguous.dispatch({ ...input, dispatch_key: 'a'.repeat(64) }),
  /requires a durable provider-run ledger/
);
assert.equal(unledgeredDispatchCalls, 0, 'provider must not dispatch before durable lineage is available');

// When a persisted dispatch intent exists, a transport failure is reconciled before
// the caller is allowed to retry. Exactly one matching run is accepted.
const providerConfig = { provider: 'github-actions', workflow: 'p3-worker.yml', repository: 'example/public-repo', event: 'workflow_dispatch', ref: 'main' };
const acceptedIdentity = createProviderDispatchIdentity(input, providerConfig);
const acceptedKey = providerDispatchKey(acceptedIdentity);
const intentCreatedAt = new Date().toISOString();
const persistedIntent = {
  ...acceptedIdentity, request_json: canonicalProviderDispatchRequest(input),
  dispatch_key: acceptedKey, state: 'DISPATCHING',
  provider_run_id: null, created_at: intentCreatedAt, updated_at: intentCreatedAt
};
let persistedRun = null;
const persistedStore = {
  db: {
    exec() {},
    transaction(fn) { return fn; },
    prepare(sql) {
      if (/SELECT \* FROM provider_runs/.test(sql)) return { get: id => persistedRun && String(id) === persistedRun.provider_run_id ? { ...persistedRun } : null };
      if (/SELECT \* FROM provider_dispatch_intents WHERE dispatch_key/.test(sql)) return { get: key => key === acceptedKey ? { ...persistedIntent } : null };
      if (/SELECT \* FROM provider_dispatch_intents WHERE provider_run_id/.test(sql)) return { get: id => String(id) === String(persistedIntent.provider_run_id) ? { ...persistedIntent } : null };
      if (/UPDATE provider_dispatch_intents SET state='DISPATCHED'/.test(sql)) return { run(runId, updatedAt, key) {
        if (key !== acceptedKey || persistedIntent.state !== 'DISPATCHING' || persistedIntent.provider_run_id !== null) return { changes: 0 };
        persistedIntent.state = 'DISPATCHED'; persistedIntent.provider_run_id = String(runId); persistedIntent.updated_at = updatedAt;
        return { changes: 1 };
      } };
      if (/INSERT INTO provider_runs/.test(sql)) return { run(...args) {
        const [provider_run_id, provider, job_id, task_id, lease_id, attempt, owner_epoch, input_commit, dispatch_key, request_sha256, workflow, ref, state, conclusion,
          html_url, artifact_id, output_commit, run_attempt, created_at, updated_at] = args;
        persistedRun = { provider_run_id, provider, job_id, task_id, lease_id, attempt, owner_epoch, input_commit, dispatch_key, request_sha256, workflow, ref, state,
          conclusion, html_url, artifact_id, output_commit, run_attempt, created_at, updated_at };
        return { changes: 1 };
      } };
      return { run() { return { changes: 1 }; } };
    }
  }
};
const recovered = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'public-repo', workflow: 'p3-worker.yml',
  store: persistedStore,
  fetchImpl: async (url) => {
    if (url.endsWith('/dispatches')) throw new TypeError('simulated connection reset after GitHub accepted dispatch');
    if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return jsonResponse({ workflow_runs: [{
      id: 404, display_title: `P3 worker ${acceptedKey}`, name: 'P3 worker', status: 'in_progress',
      conclusion: null, html_url: 'https://github.com/example/public-repo/actions/runs/404',
      created_at: intentCreatedAt, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch',
      head_branch: 'main', repository: { full_name: 'example/public-repo' }, head_sha: input.input_commit, run_attempt: 1
    }] });
    throw new Error(`unexpected request ${url}`);
  }
});
const recoveredRun = await recovered.dispatch({ ...input, dispatch_key: acceptedKey });
assert.equal(recoveredRun.provider_run_id, '404');
assert.equal(recoveredRun.state, 'RUNNING');

// Reconciliation must refuse both zero matches and duplicate matches.
const ambiguousRequest = { ...input, task_id: 'task-ambiguous-reconcile' };
const ambiguousIdentity = createProviderDispatchIdentity(ambiguousRequest, providerConfig);
const ambiguousKey = providerDispatchKey(ambiguousIdentity);
for (const runs of [[], [
  { id: 101, display_title: `P3 worker ${ambiguousKey}`, name: 'P3 worker' },
  { id: 102, display_title: `P3 worker ${ambiguousKey}`, name: 'P3 worker' }
]]) {
  const provider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'public-repo', workflow: 'p3-worker.yml',
    fetchImpl: async (url) => {
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return jsonResponse({ workflow_runs: runs });
      throw new Error(`unexpected request ${url}`);
    }
  });
  const result = await provider.reconcileDispatchIntent({
    ...ambiguousIdentity, request_json: canonicalProviderDispatchRequest(ambiguousRequest), dispatch_key: ambiguousKey,
    created_at: new Date().toISOString()
  });
  assert.equal(result, null, 'ambiguous or missing workflow run must stay unresolved');
}

// A completed/cancelled workflow status is not a native worker-fencing proof.
const cancelCalls = [];
const cancelProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'public-repo', workflow: 'p2-provider-smoke.yml',
  fetchImpl: async (url, options = {}) => {
    cancelCalls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/actions/runs/303/cancel')) return new Response(null, { status: 202 });
    if (url.endsWith('/actions/runs/303')) return jsonResponse({
      id: 303, status: 'completed', conclusion: 'cancelled', run_attempt: 1
    });
    throw new Error(`unexpected request ${url}`);
  }
});
const cancelled = await cancelProvider.cancel('303');
assert.equal(cancelled.state, 'COMPLETED');
assert.equal(cancelled.conclusion, 'cancelled');
assert.equal(cancelled.cancellation_requested, true);
assert.equal(cancelled.fencing_confirmed, false);
assert.equal(cancelled.teardown_confirmed, false);
assert.equal('node_device_id' in cancelled, false);
assert.deepEqual(cancelCalls.map(call => call.method), ['POST', 'GET']);

// The executor adapter intentionally does not implement OpenClaw's provider lifecycle.
for (const method of ['resolveAllocation', 'provision', 'inspect', 'destroy']) {
  assert.equal(typeof cancelProvider[method], 'undefined', `adapter must not imply WorkerProvider.${method} exists`);
}

// Guard the architectural boundary against accidentally routing M12 through the second scheduler.
const schedulerSource = await readFile(new URL('../src/runtime/distributed-scheduler.js', import.meta.url), 'utf8');
assert.match(schedulerSource, /acquireTaskLease/);
assert.match(schedulerSource, /task_leases/);
const matrix = await readFile(new URL('../docs/github-actions-openclaw-contract-matrix.md', import.meta.url), 'utf8');
assert.match(matrix, /Incompatible if scheduler is inserted into M12/);
assert.match(matrix, /cancellation is not fencing evidence/i);

// The task is the untrusted boundary. Its workflow token must be read-only,
// must not mint OIDC credentials, and checkout must not persist a Git helper
// that lets task commands reuse the workflow token after checkout completes.
const workerWorkflow = await readFile(new URL('../.github/workflows/p3-worker.yml', import.meta.url), 'utf8');
assert.match(workerWorkflow, /^permissions:\n  contents: read\s*$/m,
  'P3 task execution must not receive repository write permission');
assert.doesNotMatch(workerWorkflow, /^\s+id-token:\s*write\s*$/m,
  'P3 task execution must not receive an OIDC token-minting capability');
assert.match(workerWorkflow, /uses: actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials:\s*false/,
  'checkout must not persist the workflow token in local Git config visible to task commands');

console.log('github-actions lifecycle boundary: PASS (mock API only; no workflow dispatched)');
