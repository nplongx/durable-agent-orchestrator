import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-phase5-'));
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dir;

const { WorkflowStore } = await import('./job-store.js');
const { RecoveryManager } = await import('./recovery-manager.js');

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
const recovery = new RecoveryManager(store, { sessionStaleMs: 60_000, executionStaleMs: 60_000 });
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
assert.equal(store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE job_id = ? AND task_id = ?").get(job.job_id, cto.task_id).n, 1);
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'task.retry_started'));

// Deterministic execution recovery uses the same durable task, with a new execution attempt.
const execTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  description: 'Run the exact command immediately: node --check /home/long/work/chatgpt-adapter/server.js.',
  metadata: { deterministic: true, command: 'node --check /home/long/work/chatgpt-adapter/server.js' }
});
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
assert.equal(store.getTask(execTask.task_id).execution_status, 'stale');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-phase5-recovery: PASS');
