import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempDir } from './test-temp-dir.js';

const dataDir = tempDir('recovery-active-lease-guard-20261017-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
const { workflowStore } = await import('../job-store.js');
const { RecoveryManager } = await import('../recovery-manager.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');

const suffix = randomUUID();
new GitHubActionsProvider({
  token: 'local-test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', store: workflowStore,
  fetchImpl: async () => { throw new Error('test must not perform network requests'); }
});

const created = workflowStore.createJob({ conversationKey: `recovery-active-lease-${suffix}`, title: 'Recovery active lease guard regression' });
workflowStore.recordEvent(created.job_id, 'job.proposal_requested', {
  task: created.title, workspace: process.cwd(), workflowId: 'production', executionTarget: 'github-actions'
}, created.job_id);
workflowStore.approve(created.job_id, 'isolated regression fixture', 'test-fixture', { workspace: process.cwd() });
workflowStore.dispatch(created.job_id, { role: 'cto', description: 'Provider-backed task without OpenClaw session' });
const task = workflowStore.getTask(workflowStore.getJob(created.job_id).active_task_id);
assert.equal(task.openclaw_session_key, null);

const staleAt = new Date(Date.now() - 60 * 60_000).toISOString();
workflowStore.db.prepare('UPDATE jobs SET updated_at=? WHERE job_id=?').run(staleAt, created.job_id);
const lease = workflowStore.acquireTaskLease(task.task_id, {
  leaseId: `recovery-active-lease-${suffix}`, workerId: 'recovery-guard-test', ttlMs: 60_000
});
assert.equal(lease.state, 'ACTIVE');

const recovery = new RecoveryManager(workflowStore, { jobStaleMs: 1000, listSessions: async () => [] });
const result = await recovery.reconcile({ jobId: created.job_id });
assert.equal(workflowStore.getJob(created.job_id).state, 'EXECUTING',
  'stale job with active durable lease and no OpenClaw session must remain nonterminal');
assert.equal(workflowStore.getTaskLease(lease.lease_id).state, 'ACTIVE',
  'recovery must preserve the active lease for its owner/reconciler');
assert.ok(result.staleJobsDeferred.some(row => row.jobId === created.job_id &&
  row.reason === 'durable_lease_or_provider_outcome_unresolved'));

workflowStore.db.prepare('UPDATE task_leases SET state=?,released_at=?,last_error=? WHERE lease_id=?')
  .run('FAILED', new Date().toISOString(), 'test cleanup', lease.lease_id);
workflowStore.db.prepare("UPDATE jobs SET status='failed',state='FAILED',updated_at=? WHERE job_id=?")
  .run(new Date().toISOString(), created.job_id);
workflowStore.db.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.WORKFLOW_DB}${suffix}`, { force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('test-recovery-active-lease-guard-20261017: PASS');
