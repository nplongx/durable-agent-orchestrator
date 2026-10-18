import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('provider-pre-send-recovery-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { createExecutionRequest } = await import('../src/runtime/execution-contract.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const {
  canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchConfig, providerDispatchKey
} = await import('../src/runtime/provider-dispatch-identity.js');

const store = new WorkflowStore();
let now = Date.now();
let posts = 0;
let runLookups = 0;
const mockRunIdByDispatchKey = new Map();
const provider = new GitHubActionsProvider({
  token: 'local-mock-token', owner: 'example', repo: 'recovery-fixture', workflow: 'p3-worker.yml', ref: 'main', store,
  now: () => now,
  fetchImpl: async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/dispatches') && options.method === 'POST') {
      posts++;
      const dispatchBody = JSON.parse(options.body);
      mockRunIdByDispatchKey.set(dispatchBody.inputs.dispatch_key, 782000 + posts);
      return new Response(null, { status: 204 });
    }
    if (target.includes('/actions/workflows/p3-worker.yml/runs?')) {
      runLookups++;
      const parsed = new URL(target);
      const range = parsed.searchParams.get('created');
      assert.ok(range, 'recovery lookup must constrain results by the durable actual-send time');
      const [start, end] = range.split('..').map(Date.parse);
      assert.ok(start <= now && end >= now, `run lookup window must include the new claim time, got ${range}`);
      const intentKey = parsed.searchParams.get('dispatch_key');
      assert.ok(!intentKey, 'dispatch identity is matched against run metadata, not an invented query parameter');
      const row = store.db.prepare("SELECT * FROM provider_dispatch_intents WHERE state='DISPATCHING' AND dispatch_claim_id IS NOT NULL ORDER BY dispatch_claimed_at DESC LIMIT 1").get();
      assert.ok(row, 'test fixture should have a durable send claim before the remote request');
      const mockRunId = mockRunIdByDispatchKey.get(row.dispatch_key);
      if (!mockRunId) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      return new Response(JSON.stringify({ workflow_runs: [{
        id: mockRunId,
        display_title: `P3 worker ${row.dispatch_key}`,
        name: 'P3 worker', status: 'in_progress', conclusion: null,
        html_url: `https://github.com/example/recovery-fixture/actions/runs/${mockRunId}`,
        created_at: new Date(now).toISOString(),
        path: '.github/workflows/p3-worker.yml@refs/heads/main',
        event: 'workflow_dispatch', head_branch: 'main',
        repository: { full_name: 'example/recovery-fixture' },
        head_sha: row.input_commit, run_attempt: 1
      }] }), { status: 200 });
    }
    throw new Error(`unexpected local mock request ${target}`);
  }
});

const job = store.createJob({ conversationKey: `pre-send-recovery-${process.pid}`, title: 'Pre-send dispatch recovery fixture' });
const task = store.ensureTask(job.job_id, { role: 'engineer', description: 'resume the same immutable request' });
const lease = store.acquireTaskLease(task.task_id, {
  leaseId: `lease-pre-send-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
const request = createExecutionRequest({
  job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id, attempt: lease.attempt,
  owner_epoch: lease.owner_epoch,
  role: 'engineer', input_commit: 'e'.repeat(40), task_payload_ref: `task://${task.task_id}`,
  workspace: 'ephemeral', required_evidence: ['task-payload.json', 'execution.json'],
  task_payload_inline: {
    schema_version: 1, job_id: job.job_id, task_id: task.task_id, role: 'engineer',
    required_evidence: ['task-payload.json', 'execution.json'], command: 'true',
    instructions: 'execute the already-approved local test fixture'
  }
});
const identity = createProviderDispatchIdentity(request, providerDispatchConfig(provider));
const dispatchKey = providerDispatchKey(identity);
const nowIso = new Date(now).toISOString();
const strandedAt = new Date(now - 25 * 60 * 1000).toISOString();
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,NULL,NULL,?,?)`)
  .run(dispatchKey, identity.job_id, identity.task_id, identity.lease_id, identity.attempt, identity.owner_epoch, identity.provider,
    identity.input_commit, identity.request_sha256, canonicalProviderDispatchRequest(request), identity.api_base,
    identity.workflow, identity.repository, identity.event, identity.ref, strandedAt, strandedAt);

const scheduler = new DistributedScheduler({ store, provider, workerId: 'recovery-operator' });
const inventory = await scheduler.reconcileProviderDispatches({ maxAgeMs: 60_000 });
assert.equal(inventory.length, 1);
assert.equal(inventory[0].status, 'SAFE_PRE_SEND_RETRY_AVAILABLE',
  'old unclaimed intents must remain operator-visible and not disappear behind an age cutoff');
assert.equal(posts, 0, 'listing recovery options must never send');
assert.equal(runLookups, 0, 'unclaimed intents must not be mistaken for a potentially accepted remote send');

const recovered = await scheduler.retryPreSendDispatch(dispatchKey);
assert.equal(recovered.status, 'RETRIED_AND_BOUND');
assert.equal(posts, 1, 'explicit recovery should perform one single-send attempt after the one-way claim');
assert.equal(runLookups, 1, 'the retry uses a run-search window based on dispatch_claimed_at, not the 25-minute-old intent');
const durable = store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
assert.equal(durable.state, 'DISPATCHED');
assert.equal(durable.provider_run_id, '782001');
assert.ok(durable.dispatch_claim_id);
assert.equal(durable.request_sha256, identity.request_sha256);
assert.equal(durable.request_json, canonicalProviderDispatchRequest(request));
assert.ok(Date.parse(durable.dispatch_claimed_at) >= Date.parse(strandedAt));
const run = store.db.prepare('SELECT dispatch_key,request_sha256,run_attempt FROM provider_runs WHERE provider_run_id=?').get('782001');
assert.deepEqual({ ...run }, { dispatch_key: dispatchKey, request_sha256: identity.request_sha256, run_attempt: 1 });

const staleEpochJob = store.createJob({ conversationKey: `pre-send-stale-epoch-${process.pid}`, title: 'Stale owner epoch recovery fixture' });
const staleEpochTask = store.ensureTask(staleEpochJob.job_id, { role: 'engineer', description: 'stale epoch must not dispatch' });
const staleEpochLease = store.acquireTaskLease(staleEpochTask.task_id, {
  leaseId: `lease-stale-epoch-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
const staleEpochRequest = createExecutionRequest({
  job_id: staleEpochJob.job_id, task_id: staleEpochTask.task_id, lease_id: staleEpochLease.lease_id,
  attempt: staleEpochLease.attempt, owner_epoch: staleEpochLease.owner_epoch, role: 'engineer',
  input_commit: 'd'.repeat(40), task_payload_ref: `task://${staleEpochTask.task_id}`,
  workspace: 'ephemeral', required_evidence: ['execution.json']
});
const staleEpochIdentity = createProviderDispatchIdentity(staleEpochRequest, providerDispatchConfig(provider));
const staleEpochKey = providerDispatchKey(staleEpochIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
  .run(staleEpochKey, staleEpochIdentity.job_id, staleEpochIdentity.task_id, staleEpochIdentity.lease_id,
    staleEpochIdentity.attempt, staleEpochIdentity.owner_epoch, staleEpochIdentity.provider, staleEpochIdentity.input_commit,
    staleEpochIdentity.request_sha256, canonicalProviderDispatchRequest(staleEpochRequest), staleEpochIdentity.api_base,
    staleEpochIdentity.workflow, staleEpochIdentity.repository, staleEpochIdentity.event, staleEpochIdentity.ref, nowIso, nowIso);
store.db.prepare('UPDATE task_leases SET owner_epoch=owner_epoch+1 WHERE lease_id=?').run(staleEpochLease.lease_id);
const staleEpochRetry = await scheduler.retryPreSendDispatch(staleEpochKey);
assert.equal(staleEpochRetry.status, 'LEASE_STALE_NO_SEND');
assert.equal(posts, 1, 'a lease-owner epoch change after intent reservation must prevent the pre-send retry');
const staleEpochInventory = await scheduler.reconcileProviderDispatches();
assert.equal(staleEpochInventory.find(item => item.dispatchKey === staleEpochKey)?.status, 'LEASE_STALE_NO_SEND',
  'reconciliation inventory must not advertise an inactive owner-epoch as safely retryable');

// A lease can expire while provider commit resolution is awaiting I/O. The
// original retry-path precheck is not sufficient: the provider boundary must
// revalidate the exact active lease after the await and before its send claim.
const expireDuringResolveJob = store.createJob({ conversationKey: `pre-send-expire-during-resolve-${process.pid}`, title: 'Lease expires during provider resolution' });
const expireDuringResolveTask = store.ensureTask(expireDuringResolveJob.job_id, { role: 'engineer', description: 'expired lease must not reach provider send' });
const expireDuringResolveProvider = new GitHubActionsProvider({
  token: 'local-mock-token', owner: 'example', repo: 'recovery-fixture', workflow: 'p3-worker.yml', ref: 'main', store,
  now: () => now,
  fetchImpl: async (url, options = {}) => {
    if (String(url).endsWith('/dispatches') && options.method === 'POST') posts++;
    throw new Error(`expired-lease fixture crossed the network boundary unexpectedly: ${url}`);
  }
});
const originalResolveCommit = expireDuringResolveProvider.resolveCommit.bind(expireDuringResolveProvider);
expireDuringResolveProvider.resolveCommit = async commit => {
  const resolved = await originalResolveCommit(commit);
  store.db.prepare("UPDATE task_leases SET expires_at=? WHERE task_id=? AND state='ACTIVE'")
    .run(new Date(now - 1).toISOString(), expireDuringResolveTask.task_id);
  return resolved;
};
const postsBeforeExpiredLease = posts;
await assert.rejects(
  () => new DistributedScheduler({ store, provider: expireDuringResolveProvider, workerId: 'lease-expiry-race' })
    .dispatchTask(expireDuringResolveTask, { inputCommit: '9'.repeat(40) }),
  /exact active, unexpired durable lease/,
  'provider must re-check lease validity after asynchronous commit resolution'
);
const expiredLeaseIntent = store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE task_id=?').get(expireDuringResolveTask.task_id);
assert.ok(expiredLeaseIntent, 'the durable request reservation remains as recovery evidence');
assert.equal(expiredLeaseIntent.dispatch_claim_id, null, 'an expired lease must not receive a one-way send claim');
assert.equal(posts, postsBeforeExpiredLease, 'expired lease must never cross the mocked POST boundary');
const expiredLeaseInventory = await scheduler.reconcileProviderDispatches();
assert.equal(expiredLeaseInventory.find(item => item.dispatchKey === expiredLeaseIntent.dispatch_key)?.status, 'LEASE_STALE_NO_SEND',
  'an expired lease reservation must not be reported as a safe pre-send retry');

// Also expire the lease after a successful claim but immediately before the
// final pre-send check. The claim can be released only because no fetch began.
const expireAfterClaimJob = store.createJob({ conversationKey: `pre-send-expire-after-claim-${process.pid}`, title: 'Lease expires after claim' });
const expireAfterClaimTask = store.ensureTask(expireAfterClaimJob.job_id, { role: 'engineer', description: 'last-boundary lease fence' });
let tokenReadCount = 0;
const expireAfterClaimProvider = new GitHubActionsProvider({
  token: 'local-mock-token', owner: 'example', repo: 'recovery-fixture', workflow: 'p3-worker.yml', ref: 'main', store,
  now: () => now,
  fetchImpl: async url => { throw new Error(`last-boundary expired lease crossed the network boundary unexpectedly: ${url}`); }
});
let tokenValue = expireAfterClaimProvider.token;
Object.defineProperty(expireAfterClaimProvider, 'token', {
  configurable: true,
  get() {
    tokenReadCount++;
    if (tokenReadCount === 2) {
      store.db.prepare("UPDATE task_leases SET expires_at=? WHERE task_id=? AND state='ACTIVE'")
        .run(new Date(now - 1).toISOString(), expireAfterClaimTask.task_id);
    }
    return tokenValue;
  },
  set(value) { tokenValue = value; }
});
const postsBeforeLastBoundaryExpiry = posts;
await assert.rejects(
  () => new DistributedScheduler({ store, provider: expireAfterClaimProvider, workerId: 'lease-last-boundary-race' })
    .dispatchTask(expireAfterClaimTask, { inputCommit: '8'.repeat(40) }),
  /exact active, unexpired durable lease/,
  'the final synchronous pre-send boundary must fence a lease that expires after claim creation'
);
const expiredAfterClaimIntent = store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE task_id=?').get(expireAfterClaimTask.task_id);
assert.equal(expiredAfterClaimIntent.dispatch_claim_id, null, 'a verified not-sent lease expiry releases only its own claim');
assert.equal(expiredAfterClaimIntent.provider_run_id, null);
assert.equal(posts, postsBeforeLastBoundaryExpiry, 'last-boundary lease expiry must not issue a POST');

// Two recovery callers race the same durable unclaimed intent through separate
// async dispatch paths. The SQLite one-way send claim must admit at most one
// POST; the losing caller may only reconcile and must not create a second run.
const concurrentJob = store.createJob({ conversationKey: `pre-send-concurrent-${process.pid}`, title: 'Concurrent pre-send recovery fixture' });
const concurrentTask = store.ensureTask(concurrentJob.job_id, { role: 'engineer', description: 'single send claim under concurrent recovery' });
const concurrentLease = store.acquireTaskLease(concurrentTask.task_id, {
  leaseId: `lease-pre-send-concurrent-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
const concurrentRequest = createExecutionRequest({
  job_id: concurrentJob.job_id, task_id: concurrentTask.task_id, lease_id: concurrentLease.lease_id,
  attempt: concurrentLease.attempt, owner_epoch: concurrentLease.owner_epoch, role: 'engineer',
  input_commit: 'c'.repeat(40), task_payload_ref: `task://${concurrentTask.task_id}`,
  workspace: 'ephemeral', required_evidence: ['execution.json']
});
const concurrentIdentity = createProviderDispatchIdentity(concurrentRequest, providerDispatchConfig(provider));
const concurrentKey = providerDispatchKey(concurrentIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
  .run(concurrentKey, concurrentIdentity.job_id, concurrentIdentity.task_id, concurrentIdentity.lease_id,
    concurrentIdentity.attempt, concurrentIdentity.owner_epoch, concurrentIdentity.provider, concurrentIdentity.input_commit,
    concurrentIdentity.request_sha256, canonicalProviderDispatchRequest(concurrentRequest), concurrentIdentity.api_base,
    concurrentIdentity.workflow, concurrentIdentity.repository, concurrentIdentity.event, concurrentIdentity.ref, nowIso, nowIso);
const postsBeforeConcurrentRecovery = posts;
const concurrentRecovery = await Promise.all([
  scheduler.retryPreSendDispatch(concurrentKey),
  scheduler.retryPreSendDispatch(concurrentKey)
]);
assert.equal(posts - postsBeforeConcurrentRecovery, 1,
  'two concurrent recovery calls for one durable intent must cross the remote POST boundary once at most');
assert.ok(concurrentRecovery.every(item => ['RETRIED_AND_BOUND', 'RETRIED_PENDING_RECONCILIATION'].includes(item.status)),
  'both recovery callers must return a known bound result or explicit reconciliation-only state');
const concurrentDurable = store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(concurrentKey);
assert.ok(concurrentDurable.dispatch_claim_id, 'the winning durable send claim must survive concurrent recovery');
assert.ok(!concurrentDurable.provider_run_id || String(concurrentDurable.provider_run_id) === String(mockRunIdByDispatchKey.get(concurrentKey)),
  'the provider-run binding must match the one mock run allocated to the original dispatch key');

await assert.rejects(() => scheduler.retryPreSendDispatch(dispatchKey), /only an unresolved DISPATCHING intent/,
  'a resolved intent cannot be re-dispatched by an operator retry');
assert.equal(posts, postsBeforeConcurrentRecovery + 1, 'retrying an already-resolved intent must not cross the remote boundary');

// A claimed ambiguous intent can only be reconciled. The explicit retry path
// must not issue a POST, even if no provider run is currently bound.
const ambiguousJob = store.createJob({ conversationKey: `pre-send-claimed-${process.pid}`, title: 'Claimed ambiguous intent fixture' });
const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'engineer', description: 'no blind retry' });
const ambiguousLease = store.acquireTaskLease(ambiguousTask.task_id, {
  leaseId: `lease-claimed-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
const ambiguousRequest = createExecutionRequest({
  job_id: ambiguousJob.job_id, task_id: ambiguousTask.task_id, lease_id: ambiguousLease.lease_id, attempt: ambiguousLease.attempt,
  owner_epoch: ambiguousLease.owner_epoch,
  role: 'engineer', input_commit: 'f'.repeat(40), task_payload_ref: `task://${ambiguousTask.task_id}`,
  workspace: 'ephemeral', required_evidence: ['execution.json']
});
const ambiguousIdentity = createProviderDispatchIdentity(ambiguousRequest, providerDispatchConfig(provider));
const ambiguousKey = providerDispatchKey(ambiguousIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,'prior-send-claim',?,?,?)`)
  .run(ambiguousKey, ambiguousIdentity.job_id, ambiguousIdentity.task_id, ambiguousIdentity.lease_id, ambiguousIdentity.attempt, ambiguousIdentity.owner_epoch,
    ambiguousIdentity.provider, ambiguousIdentity.input_commit, ambiguousIdentity.request_sha256,
    canonicalProviderDispatchRequest(ambiguousRequest), ambiguousIdentity.api_base, ambiguousIdentity.workflow,
    ambiguousIdentity.repository, ambiguousIdentity.event, ambiguousIdentity.ref, nowIso, nowIso, nowIso);
await assert.rejects(() => scheduler.retryPreSendDispatch(ambiguousKey), /send claim already exists/);
assert.equal(posts, postsBeforeConcurrentRecovery + 1, 'claimed ambiguous intents remain in reconciliation-only mode');

// Task/lease identifiers are opaque case-sensitive durable identities. Only
// Git commit IDs are case-insensitive. A reordered/forged remote observation
// with a case-mutated task ID must not bind a provider run to this intent.
const originalReconcileDispatchIntent = provider.reconcileDispatchIntent.bind(provider);
provider.reconcileDispatchIntent = async intent => ({
  provider_run_id: '782999', job_id: intent.job_id, task_id: intent.task_id.toUpperCase(),
  lease_id: intent.lease_id, attempt: Number(intent.attempt), owner_epoch: Number(intent.owner_epoch),
  input_commit: intent.input_commit, workflow: intent.workflow, ref: intent.ref, run_attempt: 1, state: 'RUNNING'
});
const caseMutationInventory = await scheduler.reconcileProviderDispatches();
assert.equal(caseMutationInventory.find(item => item.dispatchKey === ambiguousKey)?.status, 'RECONCILIATION_ERROR',
  'a case-mutated task identifier must not be accepted as the same remote execution');
assert.match(caseMutationInventory.find(item => item.dispatchKey === ambiguousKey)?.error || '', /exact durable task_id binding/);
assert.equal(store.db.prepare('SELECT provider_run_id,state FROM provider_dispatch_intents WHERE dispatch_key=?').get(ambiguousKey).provider_run_id, null,
  'a case-mutated task identifier must not change the durable dispatch binding');
provider.reconcileDispatchIntent = async intent => ({
  provider_run_id: '782998', job_id: intent.job_id, task_id: intent.task_id,
  lease_id: intent.lease_id, attempt: Number(intent.attempt), owner_epoch: Number(intent.owner_epoch),
  input_commit: intent.input_commit, workflow: intent.workflow, ref: intent.ref, run_attempt: 1, state: 'RUNNING'
});
const ledgerlessInventory = await scheduler.reconcileProviderDispatches();
assert.equal(ledgerlessInventory.find(item => item.dispatchKey === ambiguousKey)?.status, 'RECONCILIATION_ERROR',
  'a P3 provider observation without the matching durable provider_runs row must not be acknowledged');
assert.match(ledgerlessInventory.find(item => item.dispatchKey === ambiguousKey)?.error || '', /not durably bound.*provider_runs/);
assert.equal(store.db.prepare('SELECT provider_run_id,state FROM provider_dispatch_intents WHERE dispatch_key=?').get(ambiguousKey).provider_run_id, null,
  'a remote observation without a durable run ledger must leave the dispatch quarantined');
provider.reconcileDispatchIntent = originalReconcileDispatchIntent;

// A durable row whose request bytes change after reservation must not be
// treated as a safe pre-send retry. This models local storage tampering or a
// partial/incorrect migration while keeping the original digest immutable.
const tamperedJob = store.createJob({ conversationKey: `pre-send-tampered-${process.pid}`, title: 'Tampered durable request fixture' });
const tamperedTask = store.ensureTask(tamperedJob.job_id, { role: 'engineer', description: 'reject request substitution after restart' });
const tamperedLease = store.acquireTaskLease(tamperedTask.task_id, {
  leaseId: `lease-tampered-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
const tamperedRequest = createExecutionRequest({
  job_id: tamperedJob.job_id, task_id: tamperedTask.task_id, lease_id: tamperedLease.lease_id,
  attempt: tamperedLease.attempt, owner_epoch: tamperedLease.owner_epoch, role: 'engineer',
  input_commit: 'b'.repeat(40), task_payload_ref: `task://${tamperedTask.task_id}`,
  workspace: 'ephemeral', required_evidence: ['execution.json']
});
const tamperedIdentity = createProviderDispatchIdentity(tamperedRequest, providerDispatchConfig(provider));
const tamperedKey = providerDispatchKey(tamperedIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
  .run(tamperedKey, tamperedIdentity.job_id, tamperedIdentity.task_id, tamperedIdentity.lease_id,
    tamperedIdentity.attempt, tamperedIdentity.owner_epoch, tamperedIdentity.provider, tamperedIdentity.input_commit,
    tamperedIdentity.request_sha256, canonicalProviderDispatchRequest(tamperedRequest), tamperedIdentity.api_base,
    tamperedIdentity.workflow, tamperedIdentity.repository, tamperedIdentity.event, tamperedIdentity.ref, nowIso, nowIso);
store.db.prepare('UPDATE provider_dispatch_intents SET request_json=? WHERE dispatch_key=?')
  .run(canonicalProviderDispatchRequest({ ...tamperedRequest, role: 'reviewer' }), tamperedKey);
const postsBeforeTamperedRecovery = posts;
const tamperedInventory = await scheduler.reconcileProviderDispatches({ maxAgeMs: 60_000 });
assert.equal(tamperedInventory.find(item => item.dispatchKey === tamperedKey)?.status, 'RECONCILIATION_ERROR',
  'changed durable request bytes must be visible as a binding failure, not a safe pre-send retry');
await assert.rejects(() => scheduler.retryPreSendDispatch(tamperedKey), /request bytes do not match the immutable request_sha256 binding/,
  'restart recovery must reject request bytes that no longer match the reserved digest');
assert.equal(posts, postsBeforeTamperedRecovery, 'tampered durable request bytes must never cross the provider POST boundary');

// Corrupted history can contain two different immutable request intents for
// the same lease/attempt. Neither is a safe pre-send retry: without tuple-wide
// fencing, a second dispatch key could acquire its own send claim and create a
// second remote workflow for the same execution identity.
const siblingJob = store.createJob({ conversationKey: `pre-send-sibling-intents-${process.pid}`, title: 'Sibling dispatch intent quarantine' });
const siblingTask = store.ensureTask(siblingJob.job_id, { role: 'engineer', description: 'sibling dispatch intents must not send' });
const siblingLease = store.acquireTaskLease(siblingTask.task_id, {
  leaseId: `lease-sibling-intents-${process.pid}`, workerId: 'original-scheduler', ttlMs: 5 * 60 * 1000
});
// Simulate a tampered/legacy schema where the tuple uniqueness guard was
// dropped; the runtime must still fail closed rather than rely solely on DDL.
store.db.exec('DROP INDEX idx_provider_dispatch_intents_attempt_tuple');
const siblingRequests = ['a'.repeat(40), 'f'.repeat(40)].map((commit, index) => createExecutionRequest({
  job_id: siblingJob.job_id, task_id: siblingTask.task_id, lease_id: siblingLease.lease_id,
  attempt: siblingLease.attempt, owner_epoch: siblingLease.owner_epoch, role: 'engineer',
  input_commit: commit, task_payload_ref: `task://${siblingTask.task_id}/${index}`,
  workspace: 'ephemeral', required_evidence: ['execution.json']
}));
const siblingIdentities = siblingRequests.map(request => createProviderDispatchIdentity(request, providerDispatchConfig(provider)));
const siblingKeys = siblingIdentities.map(providerDispatchKey);
for (let i = 0; i < siblingRequests.length; i++) {
  const siblingIdentity = siblingIdentities[i];
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`).run(
      siblingKeys[i], siblingIdentity.job_id, siblingIdentity.task_id, siblingIdentity.lease_id,
      siblingIdentity.attempt, siblingIdentity.owner_epoch, siblingIdentity.provider, siblingIdentity.input_commit,
      siblingIdentity.request_sha256, canonicalProviderDispatchRequest(siblingRequests[i]), siblingIdentity.api_base,
      siblingIdentity.workflow, siblingIdentity.repository, siblingIdentity.event, siblingIdentity.ref, nowIso, nowIso
    );
}
const postsBeforeSiblingFence = posts;
const siblingInventory = await scheduler.reconcileProviderDispatches();
for (const key of siblingKeys) {
  assert.equal(siblingInventory.find(item => item.dispatchKey === key)?.status, 'AMBIGUOUS_SIBLING_DISPATCH_INTENTS_REQUIRES_OPERATOR');
  await assert.rejects(() => scheduler.retryPreSendDispatch(key), /multiple dispatch intents claim the same lease\/attempt/);
}
await assert.rejects(() => provider.dispatch({ ...siblingRequests[0], dispatch_key: siblingKeys[0] }),
  /lost its durable one-way send claim before any remote side effect/,
  'provider-side claim CAS must reject a sibling intent even if a caller bypasses scheduler preflight');
assert.equal(posts, postsBeforeSiblingFence, 'ambiguous sibling intents must not cross the remote POST boundary');

// Exercise the real scheduler caller, not only the lease-store method: a stale
// scheduler may retain a pending task snapshot after the parent job is
// terminalized. The transactional lease fence must reject before any provider
// dispatch intent or external POST can be created.
const terminalParentJob = store.createJob({
  conversationKey: `pre-send-terminal-parent-${process.pid}`,
  title: 'Terminal parent must fence stale scheduler'
});
const terminalParentTask = store.ensureTask(terminalParentJob.job_id, {
  role: 'engineer', description: 'must not dispatch after parent terminalization'
});
store.transition(terminalParentJob.job_id, 'CANCELLED', 'cancelled');
const postsBeforeTerminalParent = posts;
await assert.rejects(() => scheduler.dispatchTask(terminalParentTask, { inputCommit: 'c'.repeat(40) }),
  /cannot lease task in terminal or missing job/);
assert.equal(posts, postsBeforeTerminalParent, 'terminal parent task must be fenced before provider POST');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatch_intents WHERE task_id=?').get(terminalParentTask.task_id).n, 0,
  'terminal parent rejection must not leave a dispatch intent');

console.log('provider full-request hash, stale-safe pre-send recovery, terminal-parent scheduler fence, and no-replay boundaries: PASS');
store.db.close();
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
