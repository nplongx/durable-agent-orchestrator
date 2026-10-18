import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitHubActionsProvider } from '../src/runtime/github-actions-provider.js';
import { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey } from '../src/runtime/provider-dispatch-identity.js';

const input = {
  schema_version: 1,
  job_id: 'job_p2',
  task_id: 'task_p2',
  lease_id: 'lease_p2',
  attempt: 1,
  owner_epoch: 1,
  role: 'engineer',
  input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://p2',
  workspace: '/workspace',
  required_evidence: ['result.json']
};
const p3CreatedAt = new Date().toISOString();
const p3Config = { provider: 'github-actions', api_base: 'https://api.github.com', workflow: 'p3-worker.yml', repository: 'example/repo', event: 'workflow_dispatch', ref: 'main' };
function makeP3Intent(overrides = {}) {
  const request = { ...input, ...overrides };
  const identity = createProviderDispatchIdentity(request, p3Config);
  return { ...identity, request_json: canonicalProviderDispatchRequest(request), dispatch_key: providerDispatchKey(identity), state: 'DISPATCHING', provider_run_id: null,
    created_at: p3CreatedAt, updated_at: p3CreatedAt };
}
const p3DispatchKey = makeP3Intent().dispatch_key;

// A provider-run preflight SELECT can race another process inserting the same
// run ID. The post-upsert readback must reject a conflicting immutable binding
// rather than treating the SQL upsert's row count as proof of identity.
let providerRunReads = 0;
const racedProviderRun = {
  provider_run_id: 'raced-777', provider: 'github-actions', job_id: 'other-job', task_id: 'other-task',
  lease_id: 'other-lease', attempt: 1, owner_epoch: 1, input_commit: input.input_commit,
  dispatch_key: null, request_sha256: null, workflow: 'p3-worker.yml', ref: 'main', run_attempt: 1,
  state: 'QUEUED', conclusion: null
};
const racingPersistenceStore = { db: { exec() {}, prepare(sql) {
  if (/SELECT \* FROM provider_runs/.test(sql)) return { get: () => ++providerRunReads === 1 ? null : { ...racedProviderRun } };
  if (/INSERT INTO provider_runs/.test(sql)) return { run: () => ({ changes: 1 }) };
  return { run() {}, get() { return null; } };
} } };
const racingPersistenceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: racingPersistenceStore, fetchImpl: async () => { throw new Error('persistence-only fixture must not perform network I/O'); }
});
assert.throws(() => racingPersistenceProvider._persist({
  provider_run_id: 'raced-777', job_id: input.job_id, task_id: input.task_id, lease_id: input.lease_id,
  attempt: 1, owner_epoch: 1, input_commit: input.input_commit, workflow: 'p3-worker.yml', ref: 'main',
  dispatch_key: p3DispatchKey, request_sha256: makeP3Intent().request_sha256, run_attempt: 1, state: 'RUNNING'
}), /durable readback conflicts with immutable job_id binding/,
'post-upsert provider run readback must reject a conflicting concurrent insert');

function p3PersistedStore(runId = '24680', dispatchKey = p3DispatchKey, runAttempt = 1, intentBase = makeP3Intent()) {
  const row = {
    provider_run_id: runId, provider: 'github-actions', job_id: input.job_id, task_id: input.task_id,
    lease_id: input.lease_id, attempt: 1, owner_epoch: input.owner_epoch, input_commit: input.input_commit,
    workflow: 'p3-worker.yml', ref: 'main', state: 'QUEUED', conclusion: null,
    html_url: null, artifact_id: null, output_commit: null, run_attempt: runAttempt,
    created_at: p3CreatedAt, updated_at: p3CreatedAt
  };
  const intent = {
    ...intentBase, dispatch_key: dispatchKey, state: 'DISPATCHED',
    provider_run_id: runId, created_at: p3CreatedAt, updated_at: p3CreatedAt
  };
  const store = { db: { exec() {}, transaction(fn) { return fn; }, prepare(sql) {
    if (/SELECT \* FROM provider_runs/.test(sql)) return { get: id => String(id) === runId ? { ...row,
      dispatch_key: intent.dispatch_key, request_sha256: intent.request_sha256 } : null };
    if (/SELECT \* FROM provider_dispatch_intents WHERE provider_run_id/.test(sql)) return { get: id => String(id) === runId ? { ...intent } : null };
    if (/SELECT \* FROM provider_dispatch_intents WHERE dispatch_key/.test(sql)) return { get: key => String(key) === dispatchKey ? { ...intent } : null };
    if (/INSERT INTO provider_runs/.test(sql)) return { run: (...args) => {
      const [id, provider, job_id, task_id, lease_id, attempt, owner_epoch, input_commit, dispatch_key, request_sha256,
        workflow, ref, state, conclusion, html_url, artifact_id, output_commit, nextRunAttempt, created_at, updated_at] = args;
      if (String(id) !== runId) return { changes: 0 };
      row.provider = provider; row.job_id = job_id; row.task_id = task_id; row.lease_id = lease_id;
      row.attempt = attempt; row.owner_epoch = owner_epoch; row.input_commit = input_commit;
      row.dispatch_key ??= dispatch_key; row.request_sha256 ??= request_sha256; row.workflow = workflow; row.ref = ref;
      row.state = row.state === 'COMPLETED' || state === 'COMPLETED' ? 'COMPLETED' : state;
      row.conclusion = row.state === 'COMPLETED' && row.conclusion ? row.conclusion : conclusion;
      row.html_url ??= html_url; row.artifact_id ??= artifact_id; row.output_commit ??= output_commit;
      row.run_attempt ??= nextRunAttempt; row.created_at ??= created_at; row.updated_at = updated_at;
      return { changes: 1 };
    } };
    return { run() { return { changes: 1 }; } };
  } } };
  store.inspectRun = () => ({ ...row });
  return store;
}

function p3DispatchStore(dispatchKey, intentBase = makeP3Intent()) {
  const intent = { ...intentBase, dispatch_key: dispatchKey };
  let persistedRun = null;
  return { db: { exec() {}, transaction(fn) { return fn; }, prepare(sql) {
    if (/SELECT \* FROM provider_dispatch_intents WHERE dispatch_key/.test(sql)) return { get: key => String(key) === dispatchKey ? { ...intent } : null };
    if (/SELECT \* FROM provider_runs/.test(sql)) return { get: id => persistedRun && String(id) === persistedRun.provider_run_id ? { ...persistedRun } : null };
    if (/UPDATE provider_dispatch_intents\s+SET dispatch_claim_id/.test(sql)) return { run: (claimId, claimedAt, updatedAt, key) => {
      if (String(key) !== dispatchKey || intent.state !== 'DISPATCHING' || intent.provider_run_id !== null || intent.dispatch_claim_id) return { changes: 0 };
      intent.dispatch_claim_id = claimId; intent.dispatch_claimed_at = claimedAt; intent.updated_at = updatedAt; return { changes: 1 };
    } };
    if (/UPDATE provider_dispatch_intents SET state='DISPATCHED'/.test(sql)) return { run: (providerRunId) => {
      intent.state = 'DISPATCHED'; intent.provider_run_id = String(providerRunId); return { changes: 1 };
    } };
    if (/INSERT INTO provider_runs/.test(sql)) return { run: (...args) => {
      const [provider_run_id, provider, job_id, task_id, lease_id, attempt, input_commit, dispatch_key, request_sha256, workflow, ref, state, conclusion,
        html_url, artifact_id, output_commit, run_attempt, created_at, updated_at] = args;
      persistedRun = { provider_run_id, provider, job_id, task_id, lease_id, attempt, input_commit, dispatch_key, request_sha256, workflow, ref, state,
        conclusion, html_url, artifact_id, output_commit, run_attempt, created_at, updated_at };
      return { changes: 1 };
    } };
    return { run() { return { changes: 1 }; }, get() { return null; } };
  } } };
}

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
  allowUnverifiedLegacyResults: true,
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
// A status endpoint response must be correlated to the exact requested run.
// Otherwise collectResult could fetch artifacts for one ID while trusting the
// conclusion and status returned for another ID.
let mismatchedRunArtifactReads = 0;
const mismatchedRunProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('12345'),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/12345')) return new Response(JSON.stringify({
      id: 54321, status: 'completed', conclusion: 'success', run_attempt: 1,
      head_sha: input.input_commit
    }), { status: 200 });
    if (url.includes('/actions/runs/12345/artifacts')) mismatchedRunArtifactReads++;
    throw new Error(`unexpected mismatched-run request ${url}`);
  }
});
await assert.rejects(() => mismatchedRunProvider.collectResult('12345'), /status response identity mismatch/);
assert.equal(mismatchedRunArtifactReads, 0, 'cross-linked status identity must be rejected before artifact lookup');
const result = await provider.collectResult('12345');
assert.equal(result.status, 'SUCCEEDED');
assert.equal(result.provider_run_id, '12345');
assert.equal(result.output_commit, input.input_commit);
assert.equal(result.evidence_verification.skipped, true, 'explicit legacy compatibility must remain visibly unverified');
await assert.rejects(() => new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p2-provider-smoke.yml', ref: 'main',
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/12345')) return new Response(JSON.stringify({ id: 12345, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit }), { status: 200 });
    if (url.includes('/actions/runs/12345/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 9, name: 'p2-provider-12345', expired: false, archive_download_url: 'https://artifact.test/9' }] }), { status: 200 });
    throw new Error(`unexpected strict legacy request ${url}`);
  },
  artifactDownloader: async () => { throw new Error('strict default must reject before reading unverifiable P2 payload'); }
}).collectResult('12345'), /legacy P2 provider results lack execution-evidence verification/);
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

let unledgeredDispatchCalls = 0;
const unledgeredP3 = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async () => { unledgeredDispatchCalls++; return new Response(null, { status: 204 }); }
});
await assert.rejects(() => unledgeredP3.dispatch({ ...input, dispatch_key: 'a'.repeat(64) }), /requires a durable provider-run ledger/);
assert.equal(unledgeredDispatchCalls, 0, 'P3 must not perform a remote dispatch without durable lineage storage');
let missingIntentDispatchCalls = 0;
const missingIntentP3 = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async () => { missingIntentDispatchCalls++; return new Response(null, { status: 204 }); }
});
await assert.rejects(() => missingIntentP3.dispatch({ ...input, dispatch_key: 'b'.repeat(64) }), /pre-existing durable provider_dispatch_intents row/);
assert.equal(missingIntentDispatchCalls, 0, 'P3 must not dispatch unless the scheduler has durably reserved its exact dispatch key');
assert.equal(pending.pending_reconciliation, true);
assert.equal(pending.state, 'DISPATCHING');

let discoveredDispatchKey = null;
const persistedProviderRuns = new Map();
const persistedStore = { db: { exec() {}, prepare(sql) {
  if (/SELECT \* FROM provider_runs/.test(sql)) return { get: id => persistedProviderRuns.has(String(id)) ? { ...persistedProviderRuns.get(String(id)) } : null };
  if (/INSERT INTO provider_runs/.test(sql)) return { run: (...args) => {
    const [provider_run_id, provider, job_id, task_id, lease_id, attempt, owner_epoch, input_commit, dispatch_key, request_sha256,
      workflow, ref, state, conclusion, html_url, artifact_id, output_commit, run_attempt, created_at, updated_at] = args;
    const prior = persistedProviderRuns.get(String(provider_run_id));
    persistedProviderRuns.set(String(provider_run_id), { provider_run_id: String(provider_run_id), provider, job_id, task_id, lease_id, attempt,
      owner_epoch, input_commit, dispatch_key: prior?.dispatch_key ?? dispatch_key, request_sha256: prior?.request_sha256 ?? request_sha256,
      workflow, ref, state: prior?.state === 'COMPLETED' || state === 'COMPLETED' ? 'COMPLETED' : state,
      conclusion: prior?.state === 'COMPLETED' ? prior.conclusion : conclusion, html_url: prior?.html_url ?? html_url,
      artifact_id: prior?.artifact_id ?? artifact_id, output_commit: prior?.output_commit ?? output_commit,
      run_attempt: prior?.run_attempt ?? run_attempt, created_at: prior?.created_at ?? created_at, updated_at });
    return { changes: 1 };
  } };
  return { run() { return { changes: 1 }; }, get() { return null; } };
} } };
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

// The P3 workflow declares an exact run-name contract. A lookalike run title
// that embeds the dispatch key plus a suffix is not the dispatched attempt.
const spoofedIntent = makeP3Intent({ task_id: 'task-spoofed-run-title' });
const spoofedDispatchKey = spoofedIntent.dispatch_key;
const spoofedReconciliation = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: persistedStore,
  fetchImpl: async url => {
    if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return new Response(JSON.stringify({ workflow_runs: [{
      id: 99901, display_title: `P3 worker ${spoofedDispatchKey}suffix`, name: 'P3 Distributed Worker',
      status: 'in_progress', conclusion: null, html_url: 'https://github.com/example/run/99901',
      created_at: new Date().toISOString()
    }] }), { status: 200 });
    throw new Error(`unexpected spoofed reconciliation request ${url}`);
  }
});
assert.equal(await spoofedReconciliation.reconcileDispatchIntent({
  ...spoofedIntent, created_at: new Date().toISOString()
}), null, 'P3 dispatch reconciliation must require exact declared run-name identity');
await assert.rejects(() => spoofedReconciliation.reconcileDispatchIntent({
  dispatch_key: 'not-a-digest', job_id: input.job_id, task_id: input.task_id,
  lease_id: input.lease_id, attempt: 1, input_commit: input.input_commit,
  created_at: new Date().toISOString()
}), /64-character hexadecimal dispatch_key/);

const p3PayloadRequest = {
  ...input,
  role: 'architect',
  required_evidence: ['execution.json'],
  task_payload_inline: {
    schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect',
    required_evidence: ['execution.json'], command: 'true'
  }
};
const p3PayloadIntent = makeP3Intent(p3PayloadRequest);
const p3PayloadDispatchKey = p3PayloadIntent.dispatch_key;
const p3Calls = [];
const p3Provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3DispatchStore(p3PayloadDispatchKey, p3PayloadIntent),
  fetchImpl: async (url, options = {}) => {
    p3Calls.push({ url, options });
    if (url.endsWith('/dispatches')) return new Response(JSON.stringify({ workflow_run_id: 24680, html_url: 'https://github.com/example/run/24680' }), { status: 200 });
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'in_progress', conclusion: null, run_attempt: 1, head_sha: input.input_commit,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3PayloadDispatchKey}`, created_at: p3CreatedAt
    }), { status: 200 });
    throw new Error(`unexpected P3 dispatch request ${url}`);
  }
});
for (const [label, badPayload] of [
  ['missing required evidence', { ...p3PayloadRequest.task_payload_inline, required_evidence: [] }],
  ['required evidence contract substitution', { ...p3PayloadRequest.task_payload_inline, required_evidence: ['result.json'] }],
  ['role substitution', { ...p3PayloadRequest.task_payload_inline, role: 'administrator' }],
  ['task substitution', { ...p3PayloadRequest.task_payload_inline, task_id: 'different-task' }],
  ['missing execution operation', (({ command: _command, ...payload }) => payload)(p3PayloadRequest.task_payload_inline)]
]) {
  await assert.rejects(
    () => p3Provider.dispatch({ ...p3PayloadRequest, task_payload_inline: badPayload, dispatch_key: p3PayloadDispatchKey }),
    /P3 inline task payload/,
    `${label} must fail before an inline payload can be accepted by the workflow boundary`
  );
}
assert.equal(p3Calls.length, 0, 'invalid inline task payloads must not cross the mocked provider boundary');
let idempotentDispatchCalls = 0;
const alreadyDispatchedKey = p3DispatchKey;
const idempotentP3Provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('24680', alreadyDispatchedKey),
  fetchImpl: async () => { idempotentDispatchCalls++; return new Response(null, { status: 204 }); }
});
const idempotentRun = await idempotentP3Provider.dispatch({ ...input, dispatch_key: alreadyDispatchedKey });
assert.equal(idempotentRun.provider_run_id, '24680');
assert.equal(idempotentRun.idempotent, true);
assert.equal(idempotentDispatchCalls, 0, 'a resolved dispatch key must return its bound run instead of issuing another workflow_dispatch');
assert.equal(new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo',
  fetchImpl: async () => new Response('', { status: 204 })
}).workflow, 'p3-worker.yml');
await p3Provider.dispatch({ ...p3PayloadRequest, dispatch_key: p3PayloadDispatchKey });
const p3Body = JSON.parse(p3Calls[0].options.body);
assert.equal(p3Body.inputs.task_payload_ref, input.task_payload_ref);
assert.equal(p3Body.inputs.owner_epoch, String(input.owner_epoch));
assert.equal(p3Body.inputs.role, 'architect');
assert.deepEqual(JSON.parse(p3Body.inputs.task_payload_json), {
  schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect',
  required_evidence: ['execution.json'], command: 'true'
});
const wrongArtifactP3 = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 10, name: 'result-24680', expired: false, archive_download_url: 'https://artifact.test/10' }] }), { status: 200 });
    throw new Error(`unexpected P3 artifact request ${url}`);
  },
  artifactDownloader: async () => { throw new Error('P3 must reject the non-P3 fallback name before download'); }
});
await assert.rejects(() => wrongArtifactP3.collectResult('24680'), /has no result artifact/);

const p3Result = {
  schema_version: 1, job_id: input.job_id, task_id: input.task_id, lease_id: input.lease_id, attempt: 1, owner_epoch: input.owner_epoch,
  status: 'SUCCEEDED', input_commit: input.input_commit, output_commit: input.input_commit, exit_code: 0,
  provider_run_id: '24680', provider_run_attempt: 1, evidence_artifact: 'p3-worker-24680',
  evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
  started_at: '2026-09-29T08:00:00Z', finished_at: '2026-09-29T08:00:01Z', error: null
};
const payloadBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, job_id: input.job_id, task_id: input.task_id, lease_id: input.lease_id, attempt: 1, owner_epoch: input.owner_epoch, role: 'architect', required_evidence: input.required_evidence }, null, 2)}\n`);
const stdoutBytes = Buffer.from('P3_EXECUTION_OK\n');
const stderrBytes = Buffer.from('');
const gitStatusBytes = Buffer.from('\n');
const executionBytes = Buffer.from(`${JSON.stringify({ task_id: input.task_id, exit_code: 0, timed_out: false,
  output_commit: p3Result.output_commit,
  stdout_bytes: stdoutBytes.length, stderr_bytes: stderrBytes.length, git_status_bytes: gitStatusBytes.length,
  stdout_sha256: crypto.createHash('sha256').update(stdoutBytes).digest('hex'),
  stderr_sha256: crypto.createHash('sha256').update(stderrBytes).digest('hex'),
  git_status_sha256: crypto.createHash('sha256').update(gitStatusBytes).digest('hex') }, null, 2)}\n`);
const resultBytes = Buffer.from(`${JSON.stringify(p3Result, null, 2)}\n`);
const p3Evidence = {
  'task-payload.json': JSON.parse(payloadBytes.toString('utf8')),
  'execution.json': JSON.parse(executionBytes.toString('utf8')),
  'stdout.txt': stdoutBytes.toString('utf8'),
  'stderr.txt': stderrBytes.toString('utf8'),
  'git-status.txt': gitStatusBytes.toString('utf8')
};
const p3EvidenceBytes = {
  'result.json': resultBytes,
  'task-payload.json': payloadBytes,
  'execution.json': executionBytes,
  'stdout.txt': stdoutBytes,
  'stderr.txt': stderrBytes,
  'git-status.txt': gitStatusBytes
};
const legacyRefFixtureSourceBytes = Buffer.from(`${JSON.stringify({ schema_version: 1, job_id: input.job_id, task_id: input.task_id,
  role: 'architect', required_evidence: input.required_evidence }, null, 2)}\n`);
const verifiedP3Store = p3PersistedStore();
const verifiedP3Provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: verifiedP3Store,
  taskPayloadSourceReader: async () => legacyRefFixtureSourceBytes,
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 11, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/11' }] }), { status: 200 });
    throw new Error(`unexpected verified P3 request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: p3Evidence, evidence_bytes: p3EvidenceBytes })
});
const verifiedP3 = await verifiedP3Provider.collectResult('24680');
assert.equal(verifiedP3.evidence_verification.valid, true);
assert.equal(verifiedP3.evidence_verification.skipped, undefined);
assert.equal(verifiedP3.evidence_verification.evidence_hash.length, 64);
assert.equal(verifiedP3.evidence_verification.output_commit_provenance,
  'worker_reported_and_execution_json_bound_not_independently_attested');
assert.equal(verifiedP3Store.inspectRun().output_commit, null,
  'provider-run ledger must not persist a worker-reported output commit as trusted output metadata');

const unboundUriPayloadProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 20, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/20' }] }), { status: 200 });
    throw new Error(`unexpected URI-shaped task payload request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: p3Evidence, evidence_bytes: p3EvidenceBytes })
});
await assert.rejects(() => unboundUriPayloadProvider.collectResult('24680'),
  /task_payload_ref must be a safe workspace-relative path/,
  'URI-shaped task payload refs must not bypass immutable source provenance');

// Adversarial request/result collection: when a durable inline payload defines
// the approved operation, changing only command/instructions in task-payload
// evidence must be rejected even when task IDs and required_evidence still match.
const inlinePayload = {
  schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect',
  required_evidence: ['result.json'], command: 'true', instructions: 'approved inline operation'
};
const inlineIntent = makeP3Intent({ ...input, role: 'architect', task_payload_inline: inlinePayload });
const inlineDispatchKey = inlineIntent.dispatch_key;
const normalizedInlinePayload = {
  ...inlinePayload, lease_id: input.lease_id, attempt: input.attempt, owner_epoch: input.owner_epoch
};
const changedInlinePayload = {
  ...normalizedInlinePayload, command: 'node -e "process.exit(0)"', instructions: 'substituted operation'
};
const changedInlinePayloadBytes = Buffer.from(`${JSON.stringify(changedInlinePayload, null, 2)}\n`);
const inlineTamperedEvidence = { ...p3Evidence, 'task-payload.json': changedInlinePayload };
const inlineTamperedBytes = { ...p3EvidenceBytes, 'task-payload.json': changedInlinePayloadBytes };
const inlinePayloadTamperProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('24680', inlineDispatchKey, 1, inlineIntent),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${inlineDispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 17, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/17' }] }), { status: 200 });
    throw new Error(`unexpected inline payload substitution request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: inlineTamperedEvidence, evidence_bytes: inlineTamperedBytes })
});
await assert.rejects(() => inlinePayloadTamperProvider.collectResult('24680'),
  /task payload evidence does not exactly match the immutable inline execution request/,
  'a command/instruction substitution in raw task-payload.json must not pass because correlation IDs still match');

// Ref-based payloads need the same immutable source binding as inline payloads.
// The artifact may preserve all correlation IDs and required_evidence while
// substituting the actual command; the source revision is the independent input.
const sourceReaderProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', fetchImpl: async () => new Response('{}')
});
const sourceReaderCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expectedGitBlobBytes = execFileSync('git', ['show', `${sourceReaderCommit}:package.json`], { encoding: 'buffer' });
assert.deepEqual(await sourceReaderProvider.taskPayloadSourceReader({ inputCommit: sourceReaderCommit, ref: 'package.json' }), expectedGitBlobBytes,
  'the default task-payload source reader must return exact bytes from the pinned Git commit');
assert.throws(() => sourceReaderProvider.taskPayloadSourceReader({ inputCommit: sourceReaderCommit, ref: '../package.json' }),
  /safe workspace-relative path/, 'the default source reader must reject traversal refs before invoking Git');
const refPayload = {
  schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect',
  required_evidence: [...input.required_evidence], command: 'true', instructions: 'source-approved operation'
};
const refPayloadBytes = Buffer.from(`${JSON.stringify(refPayload, null, 2)}\n`);
const refPayloadIntent = makeP3Intent({ ...input, role: 'architect', task_payload_ref: '.worker/tasks/task_p2.json' });
const refPayloadDispatchKey = refPayloadIntent.dispatch_key;
const substitutedRefPayload = { ...refPayload, command: 'node -e "process.exit(0)"', instructions: 'substituted operation' };
const normalizedSubstitutedRefPayload = {
  ...substitutedRefPayload, lease_id: input.lease_id, attempt: input.attempt, owner_epoch: input.owner_epoch
};
const refPayloadTamperEvidence = { ...p3Evidence, 'task-payload.json': normalizedSubstitutedRefPayload };
const refPayloadTamperBytes = {
  ...p3EvidenceBytes, 'task-payload.json': Buffer.from(`${JSON.stringify(normalizedSubstitutedRefPayload, null, 2)}\n`)
};
const normalizedSourcePayload = {
  ...refPayload, lease_id: input.lease_id, attempt: input.attempt, owner_epoch: input.owner_epoch
};
const refPayloadSourceEvidence = { ...p3Evidence, 'task-payload.json': normalizedSourcePayload };
const refPayloadSourceBytes = {
  ...p3EvidenceBytes, 'task-payload.json': Buffer.from(`${JSON.stringify(normalizedSourcePayload, null, 2)}\n`)
};
const refPayloadSourceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('24680', refPayloadDispatchKey, 1, refPayloadIntent),
  taskPayloadSourceReader: async () => refPayloadBytes,
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${refPayloadDispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 19, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/19' }] }), { status: 200 });
    throw new Error(`unexpected matching ref-based payload request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: refPayloadSourceEvidence, evidence_bytes: refPayloadSourceBytes })
});
const refPayloadSourceResult = await refPayloadSourceProvider.collectResult('24680');
assert.equal(refPayloadSourceResult.evidence_verification.valid, true,
  `the exact payload at the immutable input commit should remain accepted: ${refPayloadSourceResult.evidence_verification.errors.join('; ')}`);
const refPayloadTamperProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('24680', refPayloadDispatchKey, 1, refPayloadIntent),
  taskPayloadSourceReader: async ({ inputCommit, ref }) => {
    assert.equal(inputCommit, input.input_commit);
    assert.equal(ref, '.worker/tasks/task_p2.json');
    return refPayloadBytes;
  },
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${refPayloadDispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 18, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/18' }] }), { status: 200 });
    throw new Error(`unexpected ref-based payload substitution request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: refPayloadTamperEvidence, evidence_bytes: refPayloadTamperBytes })
});
await assert.rejects(() => refPayloadTamperProvider.collectResult('24680'),
  /task payload evidence does not match the payload at immutable input commit/,
  'ref-based task payload evidence must match the exact payload source from the pinned input commit');

const mismatchedRequiredEvidence = {
  ...p3Evidence,
  'task-payload.json': { ...p3Evidence['task-payload.json'], required_evidence: ['execution.json'] }
};
const mismatchedRequiredEvidenceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 16, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/16' }] }), { status: 200 });
    throw new Error(`unexpected required-evidence mismatch request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: mismatchedRequiredEvidence, evidence_bytes: {
    ...p3EvidenceBytes,
    'task-payload.json': Buffer.from(`${JSON.stringify(mismatchedRequiredEvidence['task-payload.json'], null, 2)}\n`)
  } })
});
await assert.rejects(() => mismatchedRequiredEvidenceProvider.collectResult('24680'),
  /task payload required_evidence does not match the immutable durable execution request/,
  'provider acceptance must bind the worker payload evidence contract to the immutable dispatch request');

const staleOwnerEpochResult = { ...p3Result, owner_epoch: input.owner_epoch + 1 };
const staleOwnerEpochProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 15, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/15' }] }), { status: 200 });
    throw new Error(`unexpected stale-owner-epoch request ${url}`);
  },
  artifactDownloader: async () => ({ result: staleOwnerEpochResult, evidence: p3Evidence,
    evidence_bytes: { ...p3EvidenceBytes, 'result.json': Buffer.from(`${JSON.stringify(staleOwnerEpochResult, null, 2)}\n`) } })
});
await assert.rejects(() => staleOwnerEpochProvider.collectResult('24680'), /result owner_epoch does not match/,
  'a result from a stale lease owner epoch must be rejected even when its task/lease IDs otherwise match');

// A rerun reuses the workflow run ID. A matching artifact name and the task
// attempt alone do not bind its result to the currently validated GitHub run
// attempt; the immutable result envelope must carry the exact provider attempt.
const priorAttemptResult = { ...p3Result, provider_run_attempt: 1 };
const priorAttemptResultBytes = Buffer.from(`${JSON.stringify(priorAttemptResult, null, 2)}\n`);
const priorAttemptProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore('24680', p3DispatchKey, 2),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 2, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 14, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/14' }] }), { status: 200 });
    throw new Error(`unexpected prior-attempt artifact request ${url}`);
  },
  artifactDownloader: async () => ({
    result: priorAttemptResult, evidence: p3Evidence,
    evidence_bytes: { ...p3EvidenceBytes, 'result.json': priorAttemptResultBytes }
  })
});
await assert.rejects(() => priorAttemptProvider.collectResult('24680'), /provider_run_attempt does not match/,
  'an artifact envelope from run_attempt 1 must not be accepted when the current GitHub run is attempt 2');

const changedWhitespaceBytes = { ...p3EvidenceBytes, 'execution.json': Buffer.from(`${JSON.stringify(p3Evidence['execution.json'])}\n`) };
const changedWhitespaceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  taskPayloadSourceReader: async () => legacyRefFixtureSourceBytes,
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 12, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/12' }] }), { status: 200 });
    throw new Error(`unexpected whitespace P3 request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: p3Evidence, evidence_bytes: changedWhitespaceBytes })
});
const changedWhitespace = await changedWhitespaceProvider.collectResult('24680');
assert.equal(changedWhitespace.evidence_verification.valid, true);
assert.notEqual(changedWhitespace.evidence_verification.evidence_hash, verifiedP3.evidence_verification.evidence_hash,
  'consumed evidence hash must change when raw file bytes change even when decoded JSON semantics remain identical');

const duplicateDecodedResultBytes = Buffer.from(resultBytes.toString('utf8').replace(
  '  "job_id": "job_p2",', '  "job_id": "attacker-job",\n  "job\\u005fid": "job_p2",'));
assert.equal(JSON.parse(duplicateDecodedResultBytes.toString('utf8')).job_id, p3Result.job_id,
  'fixture must decode to the same last-key-wins value as ordinary JSON.parse');
const duplicateDecodedKeyProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  taskPayloadSourceReader: async () => legacyRefFixtureSourceBytes,
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({ id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) return new Response(JSON.stringify({ artifacts: [{ id: 13, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/13' }] }), { status: 200 });
    throw new Error(`unexpected duplicate-key P3 request ${url}`);
  },
  artifactDownloader: async () => ({ result: p3Result, evidence: p3Evidence,
    evidence_bytes: { ...p3EvidenceBytes, 'result.json': duplicateDecodedResultBytes } })
});
await assert.rejects(() => duplicateDecodedKeyProvider.collectResult('24680'), /duplicate decoded object key "job_id"/,
  'the real provider acceptance path must reject duplicate decoded JSON keys in raw result evidence');

// Never disclose the GitHub bearer token to an artifact URL supplied by API
// response data unless it is the exact HTTPS artifact endpoint for this repo.
let untrustedArtifactFetches = 0;
const artifactUrlGuard = new GitHubActionsProvider({
  token: 'secret-test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async (url, options = {}) => {
    untrustedArtifactFetches++;
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.headers.authorization, 'Bearer secret-test-token');
    return new Response('not found', { status: 404 });
  }
});
await assert.rejects(() => artifactUrlGuard._downloadArtifact({ id: 17, name: 'p3-worker-24680', archive_download_url: 'https://attacker.example/collect' }), /not the exact HTTPS artifact endpoint/);
await assert.rejects(() => artifactUrlGuard._downloadArtifact({ id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/18/zip' }), /not the exact HTTPS artifact endpoint/);
assert.equal(untrustedArtifactFetches, 0, 'untrusted artifact URLs must be rejected before a credentialed request');
await assert.rejects(() => artifactUrlGuard._downloadArtifact({ id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip' }), /artifact download failed: 404/);
assert.equal(untrustedArtifactFetches, 1, 'only the exact same-repository artifact URL may receive the bearer token');

// ZIP central-directory Unix type bits are untrusted metadata too. The provider
// must reject symlinks/special files before any evidence member is read.
const zipTypeFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-artifact-zip-type-'));
try {
  fs.writeFileSync(path.join(zipTypeFixtureDir, 'target.txt'), 'fixture\n', { flag: 'wx' });
  fs.symlinkSync('target.txt', path.join(zipTypeFixtureDir, 'link.txt'));
  const regularZip = path.join(zipTypeFixtureDir, 'regular.zip');
  const symlinkZip = path.join(zipTypeFixtureDir, 'symlink.zip');
  execFileSync('zip', ['-q', regularZip, 'target.txt'], { cwd: zipTypeFixtureDir });
  execFileSync('zip', ['-q', '-y', symlinkZip, 'target.txt', 'link.txt'], { cwd: zipTypeFixtureDir });
  const artifactProviderForZip = zipBytes => new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
    fetchImpl: async url => {
      assert.equal(url, 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip');
      return new Response(zipBytes, { status: 200, headers: { 'content-type': 'application/zip' } });
    }
  });
  await assert.rejects(() => artifactProviderForZip(fs.readFileSync(symlinkZip))._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /symlink or special ZIP entry/);
  const specialArchiveBytes = fs.readFileSync(symlinkZip);
  const symlinkCentralOffset = specialArchiveBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(symlinkCentralOffset >= 0);
  specialArchiveBytes.writeUInt32LE(((0x1000 | 0o644) << 16) >>> 0, symlinkCentralOffset + 38);
  await assert.rejects(() => artifactProviderForZip(specialArchiveBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /symlink or special ZIP entry/, 'provider must reject Unix special-file mode bits before reading evidence');

  const adversarialDir = path.join(zipTypeFixtureDir, 'adversarial');
  fs.mkdirSync(path.join(adversarialDir, '.p3-worker'), { recursive: true });
  fs.writeFileSync(path.join(adversarialDir, '.p3-worker', 'result.json'), '{}\n', { flag: 'wx' });
  fs.writeFileSync(path.join(adversarialDir, 'payload.txt'), 'one\n', { flag: 'wx' });
  fs.writeFileSync(path.join(adversarialDir, 'other__.txt'), 'two\n', { flag: 'wx' });
  const adversarialZip = path.join(zipTypeFixtureDir, 'adversarial.zip');
  execFileSync('zip', ['-q', adversarialZip, '.p3-worker/result.json', 'payload.txt', 'other__.txt'], { cwd: adversarialDir });
  const replaceArchiveName = (sourceBytes, before, after) => {
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after), 'ZIP fixture entry-name mutation must preserve field length');
    const copy = Buffer.from(sourceBytes);
    let cursor = 0;
    let replacements = 0;
    while ((cursor = copy.indexOf(Buffer.from(before), cursor)) !== -1) {
      copy.write(after, cursor, 'utf8');
      cursor += Buffer.byteLength(after);
      replacements++;
    }
    assert.equal(replacements, 2, `fixture must mutate local and central-directory names for ${before}`);
    return copy;
  };
  const cleanAdversarialZipBytes = fs.readFileSync(adversarialZip);
  const duplicatePathZipBytes = replaceArchiveName(cleanAdversarialZipBytes, 'other__.txt', 'payload.txt');
  await assert.rejects(() => artifactProviderForZip(duplicatePathZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /empty or duplicate ZIP entry listing/, 'duplicate archive paths must fail before selecting result evidence');
  const centralOnlyNameMutation = Buffer.from(cleanAdversarialZipBytes);
  const centralNameOffset = centralOnlyNameMutation.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralNameOffset >= 0);
  const centralNameStart = centralNameOffset + 46;
  assert.equal(centralOnlyNameMutation.subarray(centralNameStart, centralNameStart + 10).toString(), '.p3-worker'.slice(0, 10));
  centralOnlyNameMutation[centralNameStart + 2] ^= 1;
  await assert.rejects(() => artifactProviderForZip(centralOnlyNameMutation)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /local and central headers disagree/, 'central-directory names must be bound to exact local-header names');
  const traversalPathZipBytes = replaceArchiveName(cleanAdversarialZipBytes, 'payload.txt', '../evil.txt');
  await assert.rejects(() => artifactProviderForZip(traversalPathZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /unsafe ZIP entry path/, 'traversal entry paths must be rejected before any content is read');
  const drivePathZipBytes = replaceArchiveName(cleanAdversarialZipBytes, 'payload.txt', 'C:/evil.txt');
  await assert.rejects(() => artifactProviderForZip(drivePathZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /unsafe ZIP entry path/, 'Windows drive-absolute ZIP paths must be rejected even when the provider runs on POSIX');
  const corruptMemberZipBytes = Buffer.from(cleanAdversarialZipBytes);
  const firstLocalNameLength = corruptMemberZipBytes.readUInt16LE(26);
  const firstLocalExtraLength = corruptMemberZipBytes.readUInt16LE(28);
  const firstLocalDataStart = 30 + firstLocalNameLength + firstLocalExtraLength;
  corruptMemberZipBytes[firstLocalDataStart] ^= 0x40;
  await assert.rejects(() => artifactProviderForZip(corruptMemberZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /ZIP|zip|CRC|compressed|inflate|invalid|error/i,
  'all archive members must pass integrity checks before evidence selection');

  // A bit-3 archive stores CRC/sizes in a data descriptor after the payload.
  // Build a structurally plausible descriptor-bearing fixture with a corrupt
  // descriptor CRC; central-directory integrity alone must not mask it.
  const descriptorSource = fs.readFileSync(regularZip);
  const sourceEocd = descriptorSource.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(sourceEocd >= 0, 'descriptor fixture source must have an EOCD');
  const sourceCentralOffset = descriptorSource.readUInt32LE(sourceEocd + 16);
  const sourceCentral = sourceCentralOffset;
  const descriptorBytes = Buffer.alloc(16);
  descriptorBytes.writeUInt32LE(0x08074b50, 0);
  descriptorBytes.writeUInt32LE((descriptorSource.readUInt32LE(sourceCentral + 16) ^ 1) >>> 0, 4);
  descriptorBytes.writeUInt32LE(descriptorSource.readUInt32LE(sourceCentral + 20), 8);
  descriptorBytes.writeUInt32LE(descriptorSource.readUInt32LE(sourceCentral + 24), 12);
  const descriptorZipBytes = Buffer.concat([
    descriptorSource.subarray(0, sourceCentralOffset), descriptorBytes,
    descriptorSource.subarray(sourceCentralOffset)
  ]);
  const descriptorEocd = sourceEocd + descriptorBytes.length;
  descriptorZipBytes.writeUInt32LE(sourceCentralOffset + descriptorBytes.length, descriptorEocd + 16);
  descriptorZipBytes.writeUInt16LE(descriptorZipBytes.readUInt16LE(6) | 0x0008, 6);
  descriptorZipBytes.writeUInt32LE(0, 14);
  descriptorZipBytes.writeUInt32LE(0, 18);
  descriptorZipBytes.writeUInt32LE(0, 22);
  const shiftedCentral = sourceCentralOffset + descriptorBytes.length;
  descriptorZipBytes.writeUInt16LE(descriptorZipBytes.readUInt16LE(shiftedCentral + 8) | 0x0008, shiftedCentral + 8);
  await assert.rejects(() => artifactProviderForZip(descriptorZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /invalid data descriptor/, 'descriptor CRC/sizes must match the authoritative central-directory record');

  const unsignedDescriptorBytes = Buffer.alloc(12);
  unsignedDescriptorBytes.writeUInt32LE(descriptorSource.readUInt32LE(sourceCentral + 16), 0);
  unsignedDescriptorBytes.writeUInt32LE(descriptorSource.readUInt32LE(sourceCentral + 20), 4);
  unsignedDescriptorBytes.writeUInt32LE(descriptorSource.readUInt32LE(sourceCentral + 24), 8);
  const unsignedDescriptorZipBytes = Buffer.concat([
    descriptorSource.subarray(0, sourceCentralOffset), unsignedDescriptorBytes,
    descriptorSource.subarray(sourceCentralOffset)
  ]);
  const unsignedDescriptorEocd = sourceEocd + unsignedDescriptorBytes.length;
  unsignedDescriptorZipBytes.writeUInt32LE(sourceCentralOffset + unsignedDescriptorBytes.length, unsignedDescriptorEocd + 16);
  unsignedDescriptorZipBytes.writeUInt16LE(unsignedDescriptorZipBytes.readUInt16LE(6) | 0x0008, 6);
  unsignedDescriptorZipBytes.writeUInt32LE(0, 14);
  unsignedDescriptorZipBytes.writeUInt32LE(0, 18);
  unsignedDescriptorZipBytes.writeUInt32LE(0, 22);
  const unsignedShiftedCentral = sourceCentralOffset + unsignedDescriptorBytes.length;
  unsignedDescriptorZipBytes.writeUInt16LE(unsignedDescriptorZipBytes.readUInt16LE(unsignedShiftedCentral + 8) | 0x0008, unsignedShiftedCentral + 8);
  await assert.rejects(() => artifactProviderForZip(unsignedDescriptorZipBytes)._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /does not contain its required result envelope/,
  'a valid unsigned data descriptor must be accepted before normal artifact-envelope validation');

  await assert.rejects(() => artifactProviderForZip(fs.readFileSync(regularZip))._downloadArtifact({
    id: 17, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/17/zip'
  }), /does not contain its required result envelope/);
} finally {
  fs.rmSync(zipTypeFixtureDir, { recursive: true, force: true });
}

let wrongWorkflowArtifactReads = 0;
const wrongWorkflowIdentityProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1,
      path: '.github/workflows/other.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }
    }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) wrongWorkflowArtifactReads++;
    throw new Error(`unexpected wrong-workflow request ${url}`);
  }
});
await assert.rejects(() => wrongWorkflowIdentityProvider.collectResult('24680'), /does not match the durable P3 dispatch key/);
assert.equal(wrongWorkflowArtifactReads, 0, 'wrong-workflow status must be rejected before artifact listing');

let staleRunArtifactReads = 0;
const staleRunTitleProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }, display_title: `P3 worker ${'c'.repeat(64)}`, created_at: p3CreatedAt
    }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) staleRunArtifactReads++;
    throw new Error(`unexpected stale-run request ${url}`);
  }
});
await assert.rejects(() => staleRunTitleProvider.collectResult('24680'), /does not match the durable P3 dispatch key/);
assert.equal(staleRunArtifactReads, 0, 'a valid workflow run with the wrong dispatch key must be rejected before artifacts');

let staleCreationArtifactReads = 0;
const staleCreationTimeProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: '2026-09-01T00:00:00.000Z'
    }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) staleCreationArtifactReads++;
    throw new Error(`unexpected stale-created-run request ${url}`);
  }
});
await assert.rejects(() => staleCreationTimeProvider.collectResult('24680'), /dispatch key, creation window, and input commit/);
assert.equal(staleCreationArtifactReads, 0, 'a stale run from outside the dispatch window must not reach artifact collection');

let runPaginationPages = 0;
const duplicateReconciliationIntent = makeP3Intent({ task_id: 'task-duplicate-reconciliation' });
const duplicateReconciliationKey = duplicateReconciliationIntent.dispatch_key;
const duplicateRun = {
  id: 99101, display_title: `P3 worker ${duplicateReconciliationKey}`, name: 'P3 Distributed Worker',
  status: 'in_progress', conclusion: null, html_url: 'https://github.com/example/run/99101', created_at: p3CreatedAt,
  path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
  repository: { full_name: 'example/repo' }, head_sha: input.input_commit, run_attempt: 1
};
const duplicatePagedRunsProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.includes('/actions/workflows/p3-worker.yml/runs?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      runPaginationPages++;
      if (page === 1) return new Response(JSON.stringify({ workflow_runs: [
        duplicateRun, ...Array.from({ length: 99 }, (_, i) => ({ id: 99200 + i, display_title: `unrelated-${i}`, created_at: p3CreatedAt }))
      ] }), { status: 200 });
      return new Response(JSON.stringify({ workflow_runs: [{ ...duplicateRun, id: 99102 }] }), { status: 200 });
    }
    throw new Error(`unexpected paginated reconciliation request ${url}`);
  }
});
assert.equal(await duplicatePagedRunsProvider.reconcileDispatchIntent({
  ...duplicateReconciliationIntent, created_at: p3CreatedAt
}), null, 'duplicate matching runs across pages must remain ambiguous');
assert.equal(runPaginationPages, 2, 'reconciliation must inspect later pages before claiming uniqueness');

const malformedPageIntent = makeP3Intent({ task_id: 'task-malformed-page' });
const malformedPageProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async () => new Response(JSON.stringify({ workflow_runs: null }), { status: 200 })
});
await assert.rejects(() => malformedPageProvider.reconcileDispatchIntent({
  ...malformedPageIntent, created_at: p3CreatedAt
}), /paginated workflow_runs response is malformed/,
'a malformed first-page envelope must not be interpreted as an empty match set');

let pageBoundRequests = 0;
const pageBoundIntent = makeP3Intent({ task_id: 'task-page-bound' });
const pageBoundProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async () => {
    pageBoundRequests++;
    return new Response(JSON.stringify({ workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: `${pageBoundRequests}-${i}` })) }), { status: 200 });
  }
});
await assert.rejects(() => pageBoundProvider.reconcileDispatchIntent({
  ...pageBoundIntent, created_at: p3CreatedAt
}), /workflow_runs pagination exceeded the 10-page safety limit/,
'a full final page at the hard limit must fail closed rather than claim uniqueness');
assert.equal(pageBoundRequests, 10, 'provider pagination must enforce its explicit maximum page count');

const partialIntent = makeP3Intent({ task_id: 'task-partial-pages' });
const partialDispatchKey = partialIntent.dispatch_key;
const partialStore = p3DispatchStore(partialDispatchKey, partialIntent);
let partialPageRequests = 0;
const partialPageProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: partialStore,
  fetchImpl: async url => {
    if (!url.includes('/actions/workflows/p3-worker.yml/runs?')) throw new Error(`unexpected partial-page request ${url}`);
    const page = Number(new URL(url).searchParams.get('page'));
    partialPageRequests++;
    if (page === 1) return new Response(JSON.stringify({ workflow_runs: [
      { id: '99001', display_title: 'not-the-dispatch', created_at: p3CreatedAt },
      ...Array.from({ length: 99 }, (_, i) => ({ id: `other-${i}`, display_title: `other-${i}`, created_at: p3CreatedAt }))
    ] }), { status: 200 });
    return new Response(JSON.stringify({ message: 'fixture service unavailable' }), { status: 503 });
  }
});
await assert.rejects(() => partialPageProvider.reconcileDispatchIntent({
  ...partialIntent, created_at: p3CreatedAt
}), /GitHub API 503/,
'a later-page API failure must not be treated as complete search evidence');
assert.equal(partialPageRequests, 2, 'partial failure fixture must fail on the second page');
const partialIntentAfterFailure = partialStore.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(partialDispatchKey);
assert.equal(partialIntentAfterFailure.state, 'DISPATCHING');
assert.equal(partialIntentAfterFailure.provider_run_id, null, 'partial pagination must not bind a provider run');

let duplicatePagedArtifactDownloads = 0;
let artifactPaginationPages = 0;
const duplicatePagedArtifactsProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: input.input_commit,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt
    }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) {
      const page = Number(new URL(url).searchParams.get('page'));
      artifactPaginationPages++;
      if (page === 1) return new Response(JSON.stringify({ artifacts: [
        { id: 11, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/11' },
        ...Array.from({ length: 99 }, (_, i) => ({ id: 100 + i, name: `other-${i}`, expired: false, archive_download_url: 'https://artifact.test/other' }))
      ] }), { status: 200 });
      return new Response(JSON.stringify({ artifacts: [{ id: 999, name: 'p3-worker-24680', expired: false, archive_download_url: 'https://artifact.test/999' }] }), { status: 200 });
    }
    throw new Error(`unexpected paginated artifact request ${url}`);
  },
  artifactDownloader: async () => { duplicatePagedArtifactDownloads++; throw new Error('ambiguous artifacts must not be downloaded'); }
});
await assert.rejects(() => duplicatePagedArtifactsProvider.collectResult('24680'), /ambiguous matching result artifacts/);
assert.equal(artifactPaginationPages, 2, 'artifact collection must inspect all pages before selecting one result');
assert.equal(duplicatePagedArtifactDownloads, 0, 'ambiguous artifact listings must be rejected before download');

let unledgeredArtifactReads = 0;
const unledgeredCollection = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
      id: 24680, status: 'completed', conclusion: 'success', run_attempt: 1,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }
    }), { status: 200 });
    if (url.includes('/actions/runs/24680/artifacts')) unledgeredArtifactReads++;
    throw new Error(`unexpected unledgered collection request ${url}`);
  }
});
await assert.rejects(() => unledgeredCollection.collectResult('24680'), /requires a durable dispatch\/run ledger record/);
assert.equal(unledgeredArtifactReads, 0, 'self-asserted P3 evidence cannot be collected without the durable dispatch identity');

const invalidUtf8Api = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async () => new Response(Buffer.from([0x7b,0xff,0x7d]), { status: 200 })
});
await assert.rejects(() => invalidUtf8Api.getStatus('24680'), /not valid UTF-8/);
const oversizedApiResponse = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: p3PersistedStore(),
  fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })
});
await assert.rejects(() => oversizedApiResponse.getStatus('24680'), /exceeds the 16777216-byte response limit/);
const oversizedArtifactResponse = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
  fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': String(128 * 1024 * 1024 + 1) } })
});
await assert.rejects(() => oversizedArtifactResponse._downloadArtifact({
  id: 19, name: 'p3-worker-24680', archive_download_url: 'https://api.github.com/repos/example/repo/actions/artifacts/19/zip'
}), /exceeds the 134217728-byte response limit/);

// Status and conclusion form one lifecycle contract. Malformed combinations
// must fail before artifact collection and cannot be accepted as execution evidence.
for (const invalidLifecycle of [
  { status: 'completed', conclusion: 'invented-success' },
  { status: 'in_progress', conclusion: 'success' },
  { status: 'queued', conclusion: 'failure' }
]) {
  let artifactReads = 0;
  const invalidLifecycleProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
    store: p3PersistedStore(),
    fetchImpl: async url => {
      if (url.endsWith('/actions/runs/24680')) return new Response(JSON.stringify({
        id: 24680, ...invalidLifecycle, run_attempt: 1, head_sha: input.input_commit,
        path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
        repository: { full_name: 'example/repo' }, display_title: `P3 worker ${p3DispatchKey}`, created_at: p3CreatedAt
      }), { status: 200 });
      if (url.includes('/actions/runs/24680/artifacts')) artifactReads++;
      throw new Error(`unexpected invalid lifecycle request ${url}`);
    }
  });
  await assert.rejects(() => invalidLifecycleProvider.collectResult('24680'),
    invalidLifecycle.status === 'completed' ? /unsupported conclusion/ : /conclusion before completion/);
  assert.equal(artifactReads, 0, 'invalid run lifecycle metadata must be rejected before artifact lookup');
}

assert.throws(() => new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', requestTimeoutMs: 0,
  fetchImpl: async () => { throw new Error('invalid timeout must reject before fetch'); }
}), /requestTimeoutMs must be a positive safe integer/,
'provider request deadlines must be validated as bounded positive integers');

const stalledHeadersProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', requestTimeoutMs: 25,
  fetchImpl: async () => new Promise(() => {}) // intentionally ignores AbortSignal to exercise the outer deadline race
});
const stalledHeadersStarted = Date.now();
await assert.rejects(() => stalledHeadersProvider.request('POST', '/repos/example/repo/actions/workflows/p3-worker.yml/dispatches', { ref: 'main' }),
  error => error.code === 'ERR_PROVIDER_REQUEST_TIMEOUT' && error.remoteOutcome === 'ambiguous',
'a stalled mutating API call must time out locally but remain an ambiguous remote outcome');
assert.ok(Date.now() - stalledHeadersStarted < 1000, 'provider request must settle promptly when fetch ignores cancellation');

const stalledBodyProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', requestTimeoutMs: 25,
  fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 })
});
const stalledBodyStarted = Date.now();
await assert.rejects(() => stalledBodyProvider.request('GET', '/repos/example/repo/actions/runs/24680'),
  error => error.code === 'ERR_PROVIDER_REQUEST_TIMEOUT' && error.remoteOutcome === 'not_sent',
'response-body reads must share the provider request deadline, not only wait for headers');
assert.ok(Date.now() - stalledBodyStarted < 1000, 'stalled response body must be canceled and released promptly');

console.log('github-actions-provider P2 PASS');
