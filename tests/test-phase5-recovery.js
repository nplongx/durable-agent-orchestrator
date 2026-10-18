import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('cos-phase5-');
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dir;

const { WorkflowStore } = await import('../job-store.js');
const { RecoveryManager } = await import('../recovery-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'phase5-recovery', title: 'Phase 5 recovery' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyệt');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'recover same task' });
store.attachOpenClawRun(job.job_id, { runId: 'cto-run-phase5', sessionKey: 'agent:cto:subagent:phase5' });
const session = store.getSessionByTask(cto.task_id);

// Heartbeat-age reconciliation must mark only the registered session stale.
store.db.prepare("UPDATE agent_sessions SET last_activity_at = ? WHERE session_id = ?")
  .run(new Date(Date.now() - 10 * 60_000).toISOString(), session.session_id);
const recovery = new RecoveryManager(store, { sessionStaleMs: 60_000, executionStaleMs: 60_000, listSessions: async () => [] });
const report = await recovery.reconcile({ jobId: job.job_id });
assert.equal(report.staleSessions.length, 1);
assert.equal(store.getSession(session.session_id).state, 'STALE');

// Takeover must be explicitly granted; no implicit takeover.
assert.throws(() => store.beginAgentRetry(cto.task_id, { actorRole: 'architect' }), /Session access denied/);
store.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto' });
const prepared = store.beginAgentRetry(cto.task_id, { actorRole: 'architect', reason: 'phase5 test' });
assert.equal(prepared.task.task_id, cto.task_id);
assert.equal(prepared.session.session_id, session.session_id);
assert.equal(prepared.session.state, 'ACTIVE');
assert.equal(prepared.attempt, 2);
assert.equal(store.getTask(cto.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) n FROM attempts WHERE task_id=? AND status='started'").get(cto.task_id).n, 1,
  'same-task retry must settle the stale attempt before creating the new live attempt');
assert.equal(store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE job_id = ? AND task_id = ?").get(job.job_id, cto.task_id).n, 1);
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'task.retry_started'));

// Deterministic execution recovery uses the same durable task, with a new execution attempt.
const execTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  description: 'Run the exact command immediately: node --check /home/long/work/chatgpt-adapter/server.js.',
  metadata: { deterministic: true, command: 'node --check /home/long/work/chatgpt-adapter/server.js' }
});
const staleExecutionBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  items: [{ taskId: execTask.task_id, command: 'node --check /home/long/work/chatgpt-adapter/server.js', timeout_ms: 5000 }]
});
const staleBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.ok(store.markExecutionBatchItemRunning(staleExecutionBatch.batch_id, staleBatchItem.item_id, { expectedAttempt: 1 }));
const started = new Date(Date.now() - 10 * 60_000).toISOString();
store.prepareExecution(execTask.task_id, {
  executionSessionId: 'exec_stale_phase5',
  attempt: 1,
  command: 'node --check /home/long/work/chatgpt-adapter/server.js',
  cwd: '/home/long/work/chatgpt-adapter',
  startedAt: started,
  tmuxName: 'cos-exec-missing-phase5'
});
const execReport = await recovery.reconcile({ jobId: job.job_id });
assert.ok(execReport.staleExecutions.some(t => t.task_id === execTask.task_id));
const terminalizedStale = store.getTask(execTask.task_id);
assert.equal(terminalizedStale.execution_status, 'failed',
  'stale recovery must use the canonical terminal state instead of leaving an unrecognized execution_status');
assert.equal(terminalizedStale.status, 'failed');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(execTask.task_id).n, 0,
  'stale recovery must settle the exact durable attempt, or the retry precondition will remain permanently blocked');
assert.equal(store.getExecutionBatch(staleExecutionBatch.batch_id).status, 'FAILED',
  'recovering the only stale running batch item must atomically terminalize the orphaned batch');
const recoveredStaleBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.equal(recoveredStaleBatchItem.status, 'FAILED');
assert.equal(recoveredStaleBatchItem.attempt, 1);
assert.match(recoveredStaleBatchItem.error, /supervisor\/session missing/);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.failed' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
  .get(job.job_id, execTask.task_id).n, 1, 'stale recovery must create one canonical attempt-terminal event');
const retryPrepared = store.prepareExecution(execTask.task_id, {
  executionSessionId: 'exec_retry_after_stale_phase5',
  attempt: 2,
  command: 'node --check /home/long/work/chatgpt-adapter/server.js',
  cwd: '/home/long/work/chatgpt-adapter',
  tmuxName: 'cos-exec-retry-after-stale-phase5'
});
assert.equal(retryPrepared.execution_status, 'running', 'the same durable task must accept a monotonic retry after stale-attempt recovery');
assert.equal(Number(retryPrepared.execution_attempt), 2);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(execTask.task_id).n, 1,
  'only the retry attempt should remain open after recovery settles attempt 1');
const retryBatch = store.prepareExecutionBatchRetry(staleExecutionBatch.batch_id);
assert.equal(retryBatch.status, 'RUNNING');
assert.equal(retryBatch.attempt, 2);
const retryBatchItem = store.listExecutionBatchItems(staleExecutionBatch.batch_id)[0];
assert.equal(retryBatchItem.status, 'PENDING');
assert.equal(retryBatchItem.attempt, 2, 'the recovered batch must expose a new monotonic item attempt');

// The stale-attempt reaper must not settle one row from a corrupt task that has
// multiple active attempts, because that could terminalize the task while a
// different attempt still owns the runtime.
const ambiguousJob = store.createJob({ conversationKey: `phase5-ambiguous-stale-${process.pid}`, title: 'Ambiguous stale attempt lineage' });
const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'qa', description: 'fail closed on multiple started attempts' });
const staleStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
store.db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(ambiguousTask.task_id);
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(`phase5-ambiguous-a-${process.pid}`, ambiguousTask.task_id, staleStartedAt);
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(`phase5-ambiguous-b-${process.pid}`, ambiguousTask.task_id, staleStartedAt);
assert.throws(() => store.reconcileStaleAttempts(60_000), /ambiguous active-attempt lineage/);
assert.throws(() => store.completeActiveAttempt(ambiguousTask.task_id, { reason: 'must not choose one corrupt attempt' }), /ambiguous active-attempt ledger/);
assert.equal(store.getTask(ambiguousTask.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(ambiguousTask.task_id).n, 2);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='attempt.timeout' AND json_extract(payload_json,'$.taskId')=?")
  .get(ambiguousJob.job_id, ambiguousTask.task_id).n, 0);
console.log('PASS: stale-attempt reconciliation rejects duplicate active attempts without partial terminalization');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-phase5-recovery: PASS');
