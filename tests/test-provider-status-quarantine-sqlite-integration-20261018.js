import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('provider-status-quarantine-sqlite-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { LangGraphControlLoop } = await import('../src/runtime/langgraph-control-loop.js');
const openDatabases = [];
process.on('exit', () => {
  for (const database of openDatabases) {
    try { database.close(); } catch {}
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const store = new WorkflowStore();
openDatabases.push(store.db);
new GitHubActionsProvider({
  token: 'local-integration-fixture-token', owner: 'example', repo: 'quarantine-fixture',
  workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async () => { throw new Error('status quarantine integration must not perform network requests'); }
});
const job = store.createJob({ conversationKey: `status-quarantine-${process.pid}`, title: 'Provider status quarantine integration' });
const task = store.ensureTask(job.job_id, { role: 'engineer', description: 'status-read failure must quarantine a real durable lease' });
const lease = store.acquireTaskLease(task.task_id, {
  leaseId: `lease-status-quarantine-${process.pid}`, workerId: 'integration-scheduler', ttlMs: 60_000
});
const providerRunId = `provider-status-quarantine-${process.pid}`;
const runTimestamp = new Date().toISOString();
store.db.prepare(`INSERT INTO provider_runs
  (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,workflow,ref,state,
   conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
  VALUES(?,'github-actions',?,?,?,?,?,?, 'p3-worker.yml','main','RUNNING',NULL,NULL,NULL,NULL,1,?,?)`)
  .run(providerRunId, job.job_id, task.task_id, lease.lease_id, lease.attempt, lease.owner_epoch,
    'a'.repeat(40), runTimestamp, runTimestamp);

let statusCalls = 0;
let collectionCalls = 0;
let dispatchCalls = 0;
let applyCalls = 0;
const statusError = Object.assign(new Error('integration status read failed'), { code: 'ECONNRESET' });
const failingProvider = {
  async getStatus() { statusCalls++; throw statusError; },
  async collectResult() { collectionCalls++; throw new Error('must not collect without a known provider status'); }
};
const scheduler = {
  leaseTtlMs: 60_000,
  async dispatchTask() { dispatchCalls++; throw new Error('quarantined work must not be redispatched'); }
};
const originalApply = store.applyVerifiedExecutionResult.bind(store);
store.applyVerifiedExecutionResult = (...args) => { applyCalls++; return originalApply(...args); };

const firstLoop = new LangGraphControlLoop({ store, scheduler, provider: failingProvider });
const first = await firstLoop.reconcile(job.job_id);
assert.equal(first.length, 1);
assert.equal(first[0].status, 'QUARANTINED_STATUS_REQUIRES_RECONCILIATION');
const failedLease = store.getTaskLease(lease.lease_id);
assert.equal(failedLease.state, 'FAILED', 'real SQLite lease must stop being active after ambiguous status failure');
assert.match(failedLease.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
const firstEvents = store.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='task.execution.quarantine_status_failed'").all(job.job_id);
assert.equal(firstEvents.length, 1, 'status failure must be durably recorded exactly once');
assert.equal(firstEvents[0].job_id, job.job_id);
const firstPayload = JSON.parse(firstEvents[0].payload_json);
assert.equal(firstPayload.taskId, task.task_id);
assert.equal(firstPayload.leaseId, lease.lease_id);
assert.equal(firstPayload.applied, false);
assert.equal(firstPayload.reconciliationRequired, true);
assert.equal(firstPayload.statusErrorSha256, crypto.createHash('sha256').update(statusError.message).digest('hex'));
assert.equal(statusCalls, 1);
assert.equal(collectionCalls, 0);
assert.equal(dispatchCalls, 0);
assert.equal(applyCalls, 0);

// Reopen the actual SQLite file through a fresh connection. Reconciliation of
// the persisted uncertain lease must be idempotent and must not renew it.
store.db.close();
const reopenedDatabase = new DatabaseSync(dbPath);
openDatabases.push(reopenedDatabase);
const reopenedStore = new WorkflowStore(reopenedDatabase);
let reopenedHeartbeatCalls = 0;
const originalHeartbeat = reopenedStore.heartbeatTaskLease.bind(reopenedStore);
reopenedStore.heartbeatTaskLease = (...args) => { reopenedHeartbeatCalls++; return originalHeartbeat(...args); };
const secondLoop = new LangGraphControlLoop({ store: reopenedStore, scheduler, provider: failingProvider });
const second = await secondLoop.reconcile(job.job_id);
assert.equal(second.length, 1);
assert.equal(second[0].status, 'QUARANTINED_STATUS_REQUIRES_RECONCILIATION');
assert.equal(reopenedStore.getTaskLease(lease.lease_id).state, 'FAILED');
assert.equal(reopenedHeartbeatCalls, 0, 'recovered quarantined lease must not be renewed');
assert.equal(reopenedStore.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.execution.quarantine_status_failed'").get(job.job_id).n,
  1, 'same status failure after DB reopen must reuse the durable dedupe identity');
assert.equal(statusCalls, 2);
assert.equal(collectionCalls, 0);
assert.equal(dispatchCalls, 0);
assert.equal(applyCalls, 0);

console.log('REAL SQLITE PROVIDER STATUS-FAILURE QUARANTINE / FRESH CONNECTION / IDEMPOTENT RECOVERY PASS');
