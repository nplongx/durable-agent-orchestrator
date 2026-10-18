import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempDir } from './test-temp-dir.js';

const dataDir = tempDir('terminal-recovery-provider-boundary-20261018-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.NODE_ENV = 'test';
const { workflowStore } = await import('../job-store.js');
const { RecoveryManager } = await import('../recovery-manager.js');
const suffix = randomUUID();
process.on('exit', () => {
  try { workflowStore.db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.WORKFLOW_DB}${suffix}`, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

workflowStore.db.exec(`CREATE TABLE provider_runs (
  provider_run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL
);
CREATE TABLE provider_dispatch_intents (
  dispatch_intent_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL,
  provider_run_id TEXT, dispatch_claim_id TEXT
);`);

const job = workflowStore.createJob({
  conversationKey: `terminal-provider-boundary-${suffix}`,
  title: 'Terminal recovery must respect remote execution ownership'
});
const task = workflowStore.dispatch(job.job_id, { role: 'cto', description: 'provider-backed task' });
const lease = workflowStore.acquireTaskLease(task.task_id, {
  leaseId: `terminal-provider-lease-${suffix}`, workerId: 'terminal-recovery-regression', ttlMs: 60_000
});
assert.equal(lease.state, 'ACTIVE');
workflowStore.db.prepare('INSERT INTO provider_runs(provider_run_id,job_id,state) VALUES(?,?,?)')
  .run(`provider-run-${suffix}`, job.job_id, 'IN_PROGRESS');
workflowStore.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_intent_id,job_id,state,provider_run_id,dispatch_claim_id) VALUES(?,?,'DISPATCHING',NULL,?)`)
  .run(`dispatch-intent-${suffix}`, job.job_id, `claim-${suffix}`);
workflowStore.db.prepare("UPDATE jobs SET state='FAILED',status='failed',updated_at=? WHERE job_id=?")
  .run(new Date().toISOString(), job.job_id);

let reconciliationCalls = 0;
const originalReconcile = workflowStore.reconcileRunningTaskForTerminalJob.bind(workflowStore);
workflowStore.reconcileRunningTaskForTerminalJob = (...args) => {
  reconciliationCalls += 1;
  return originalReconcile(...args);
};

const recovery = new RecoveryManager(workflowStore, { listSessions: async () => [] });
await recovery.reconcile({ jobId: job.job_id });

assert.equal(reconciliationCalls, 0,
  'RecoveryManager must not attempt terminal task reconciliation while durable provider execution is unresolved');
assert.equal(workflowStore.getTask(task.task_id).status, 'running',
  'terminal recovery must preserve the task while its lease/provider run/dispatch claim remain unresolved');
assert.equal(workflowStore.getTaskLease(lease.lease_id).state, 'ACTIVE');

workflowStore.db.prepare("UPDATE task_leases SET state='FAILED',released_at=? WHERE lease_id=?")
  .run(new Date().toISOString(), lease.lease_id);
workflowStore.db.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.WORKFLOW_DB}${suffix}`, { force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('test-terminal-recovery-provider-boundary-20261018: PASS');
