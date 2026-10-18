import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('dispatch-lease-quarantine-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { createExecutionRequest } = await import('../src/runtime/execution-contract.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const {
  canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchConfig, providerDispatchKey
} = await import('../src/runtime/provider-dispatch-identity.js');

const store = new WorkflowStore();
let dispatchCalls = 0;
let reconciliationCalls = 0;
const provider = {
  providerName: 'github-actions', owner: 'example', repo: 'quarantine-fixture', workflow: 'p3-worker.yml', ref: 'main',
  async dispatch() { dispatchCalls++; throw new Error('dispatch must not be called by this test'); },
  async reconcileDispatchIntent() { reconciliationCalls++; return null; }
};
const scheduler = new DistributedScheduler({ store, provider, workerId: 'quarantine-test-worker' });

function reserveIntent(label, claimed) {
  const job = store.createJob({ conversationKey: `dispatch-quarantine-${label}-${process.pid}`, title: `dispatch quarantine ${label}` });
  const task = store.ensureTask(job.job_id, { role: 'engineer', description: 'do not replay an uncertain provider effect' });
  const lease = store.acquireTaskLease(task.task_id, { leaseId: `lease-quarantine-${label}-${process.pid}`, workerId: 'quarantine-test-worker', ttlMs: 60_000 });
  const request = createExecutionRequest({
    job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id, attempt: lease.attempt,
    owner_epoch: lease.owner_epoch, role: 'engineer', input_commit: 'a'.repeat(40),
    task_payload_ref: `.worker/tasks/${task.task_id}.json`, workspace: 'ephemeral', required_evidence: ['task-payload.json', 'execution.json']
  });
  const identity = createProviderDispatchIdentity(request, providerDispatchConfig(provider));
  const dispatchKey = providerDispatchKey(identity);
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?,?,?)`)
    .run(dispatchKey, identity.job_id, identity.task_id, identity.lease_id, identity.attempt, identity.owner_epoch,
      identity.provider, identity.input_commit, identity.request_sha256, canonicalProviderDispatchRequest(request), identity.api_base,
      identity.workflow, identity.repository, identity.event, identity.ref,
      claimed ? `claim-${label}` : null, claimed ? now : null, now, now);
  store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run(new Date(Date.now() - 1000).toISOString(), lease.lease_id);
  return { job, task, lease, request, identity, dispatchKey };
}

try {
  const uncertain = reserveIntent('uncertain', true);
  const reconciliation = await scheduler.reconcileProviderDispatches();
  assert.equal(reconciliation.length, 1);
  assert.equal(reconciliation[0].status, 'NOT_FOUND_RECONCILIATION_ONLY');
  assert.equal(reconciliationCalls, 1);
  assert.equal(dispatchCalls, 0, 'inventorying an ambiguous send must never issue a provider dispatch');

  assert.equal(store.reapExpiredTaskLeases({ now: Date.now() + 1000 }), 1);
  const quarantinedLease = store.getTaskLease(uncertain.lease.lease_id);
  assert.equal(quarantinedLease.state, 'FAILED');
  assert.match(quarantinedLease.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
  assert.equal(store.getTask(uncertain.task.task_id).status, 'failed');
  assert.equal(store.listRunnableTasks().some(task => task.task_id === uncertain.task.task_id), false,
    'an expired lease with a durable possible-send claim must never return to the runnable queue');
  const quarantineEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='task.lease.quarantined'").get(uncertain.job.job_id);
  assert.ok(quarantineEvent);
  const payload = JSON.parse(quarantineEvent.payload_json);
  assert.equal(payload.dispatchKey, uncertain.dispatchKey);
  assert.equal(payload.leaseId, uncertain.lease.lease_id);
  assert.equal(payload.remoteEffect, 'uncertain');
  assert.equal(payload.reconciliationRequired, true);
  await assert.rejects(() => scheduler.retryPreSendDispatch(uncertain.dispatchKey), /send claim already exists/);
  assert.equal(dispatchCalls, 0, 'quarantined claimed intents must remain reconciliation-only');

  // A FAILED intent is not necessarily proof that no workflow_dispatch reached
  // GitHub. The durable send claim is written before the network call; a crash
  // or later bookkeeping failure can leave the intent FAILED without a bound
  // provider_runs row. Lease expiry must honor the one-way claim, not trust the
  // mutable summary state to make the task runnable again.
  const failedAfterClaim = reserveIntent('failed-after-claim', true);
  store.db.prepare("UPDATE provider_dispatch_intents SET state='FAILED' WHERE dispatch_key=?").run(failedAfterClaim.dispatchKey);
  const providerRunTable = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs'").get();
  assert.equal(providerRunTable ? store.db.prepare('SELECT COUNT(*) AS n FROM provider_runs WHERE lease_id=?').get(failedAfterClaim.lease.lease_id).n : 0, 0,
    'fixture must model a claimed send with no provider-run row');
  assert.equal(store.reapExpiredTaskLeases({ now: Date.now() + 1000 }), 1);
  assert.equal(store.getTaskLease(failedAfterClaim.lease.lease_id).state, 'FAILED',
    'a failed intent retaining its send claim must be quarantined');
  assert.equal(store.getTask(failedAfterClaim.task.task_id).status, 'failed');
  assert.equal(store.listRunnableTasks().some(task => task.task_id === failedAfterClaim.task.task_id), false,
    'a claimed-but-unbound failed intent must never re-enter the runnable queue');
  const failedClaimEvent = store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='task.lease.quarantined'").get(failedAfterClaim.job.job_id);
  assert.ok(failedClaimEvent);
  assert.equal(JSON.parse(failedClaimEvent.payload_json).dispatchState, 'FAILED');
  assert.equal(dispatchCalls, 0);

  const definitelyUnsent = reserveIntent('unsent', false);
  assert.equal(store.reapExpiredTaskLeases({ now: Date.now() + 1000 }), 1);
  assert.equal(store.getTaskLease(definitelyUnsent.lease.lease_id).state, 'EXPIRED');
  assert.equal(store.getTask(definitelyUnsent.task.task_id).status, 'pending',
    'an intent with no send claim remains safely retryable because the send boundary was never crossed');
  assert.equal(store.listRunnableTasks().some(task => task.task_id === definitelyUnsent.task.task_id), true);

  console.log('DISPATCH LEASE QUARANTINE: possible remote effects never re-enter runnable queue; definitely-unsent leases remain retryable PASS');
} finally {
  try { store.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
