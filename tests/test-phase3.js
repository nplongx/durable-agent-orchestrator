import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dbPath = path.join(tempDir('test-phase3-'), 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = path.dirname(dbPath);
const { WorkflowStore } = await import('../job-store.js');
const store = new WorkflowStore();

const job = store.createJob({ conversationKey: 'phase3-test', title: 'Phase 3 E2E' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyệt');
store.dispatch(job.job_id, { role: 'cto', description: 'Phase 3 E2E' });
const a1 = store.startAttempt(job.job_id);
const a2 = store.startAttempt(job.job_id);
assert.strictEqual(a1.attempt_id, a2.attempt_id, 'attempt start must be idempotent');

store.reconcileRuntimeRefs(job.job_id, [{ role: 'tool', content: '{"runId":"run-123","childSessionKey":"agent:cto:subagent:abc"}' }]);
const currentJob = store.getJob(job.job_id);
const attached = store.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(currentJob.active_task_id);
assert.strictEqual(attached.openclaw_run_id, 'run-123');
assert.strictEqual(attached.openclaw_session_key, 'agent:cto:subagent:abc');

const result1 = store.complete(job.job_id, 'PASS', 'success');
const result2 = store.complete(job.job_id, 'PASS', 'success');
assert.strictEqual(result1.job_id, result2.job_id);
assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM results').get().n, 1, 'completion must be idempotent');

const report1 = store.createReport(job.job_id, 'executive_summary', 'PASS');
const report2 = store.createReport(job.job_id, 'executive_summary', 'PASS');
assert.strictEqual(report1, report2, 'report creation must be idempotent');
assert.strictEqual(store.claimDelivery(job.job_id, report1, 'whatsapp', 'boss'), true);
assert.strictEqual(store.claimDelivery(job.job_id, report1, 'whatsapp', 'boss'), false, 'delivery claim must be idempotent');

const staleJob = store.createJob({ conversationKey: 'stale', title: 'stale' });
store.dispatch(staleJob.job_id, { role: 'cto', description: 'stale' });
const staleAttempt = store.startAttempt(staleJob.job_id);
store.db.prepare("UPDATE attempts SET started_at = ? WHERE attempt_id = ?").run(new Date(Date.now() - 3600_000).toISOString(), staleAttempt.attempt_id);
assert.strictEqual(store.reconcileStaleAttempts(60_000), 1);
assert.strictEqual(store.db.prepare('SELECT status FROM attempts WHERE attempt_id = ?').get(staleAttempt.attempt_id).status, 'timeout');

const terminalStatusJob = store.createJob({ conversationKey: 'stale-terminal-status', title: 'legacy terminal status fencing' });
const terminalStatusTask = store.dispatch(terminalStatusJob.job_id, { role: 'cto', description: 'legacy terminal status fencing' });
const terminalStatusAttempt = store.startAttempt(terminalStatusJob.job_id);
store.db.prepare("UPDATE attempts SET started_at=? WHERE attempt_id=?")
  .run(new Date(Date.now() - 3600_000).toISOString(), terminalStatusAttempt.attempt_id);
store.db.prepare("UPDATE jobs SET state='IDLE',status='failed' WHERE job_id=?").run(terminalStatusJob.job_id);
assert.strictEqual(store.reconcileStaleAttempts(60_000), 1);
assert.strictEqual(store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(terminalStatusAttempt.attempt_id).status, 'started',
  'stale-attempt recovery must not mutate an attempt belonging to a legacy terminal-status job');
assert.strictEqual(store.getTask(terminalStatusTask.task_id).status, 'running');
assert.strictEqual(store.complete(terminalStatusJob.job_id, 'late stale success', 'success').idempotent, true,
  'legacy terminal status must also fence a late complete() callback');
assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(terminalStatusTask.task_id).n, 0);

fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
console.log('PASS: Phase 3 idempotency, runtime reconciliation, stale-attempt recovery and delivery claims');
