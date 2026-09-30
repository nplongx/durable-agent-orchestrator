import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from './test-temp-dir.js';

const tempRoot = tempDir('m5-');
const dbPath = `${tempRoot}/workflow.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = tempRoot;

const { WorkflowStore } = await import('../job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m5-${process.pid}`, title: 'M5 terminalization' });
store.approve(job.job_id, 'Duyệt');
const parent = store.dispatch(job.job_id, { role: 'cto', description: 'M5 terminalization test' });
const child = store.createChildTask(job.job_id, { parentTaskId: parent.task_id, role: 'qa', description: 'deterministic check' });
store.attachTaskRuntime(child.task_id, { runId: 'run-m5', sessionKey: 'agent:qa:subagent:m5' });
store.completeTaskByRuntime(job.job_id, { runId: 'run-m5', sessionKey: 'agent:qa:subagent:m5', content: '[ACTUAL TOOL RESULT EVIDENCE]\nnode --check x\nexit status: 0', outcome: 'success' });
store.attachTaskRuntime(parent.task_id, { runId: 'run-cto-m5', sessionKey: 'agent:cto:subagent:m5' });
store.completeTaskByRuntime(job.job_id, { runId: 'run-cto-m5', sessionKey: 'agent:cto:subagent:m5', content: 'synthesis', outcome: 'success' });

assert.throws(() => store.terminalizeJob(job.job_id), /without durable report/);
const reportId = store.createReport(job.job_id, 'executive_summary', 'M5 PASS');
assert.throws(() => store.terminalizeJob(job.job_id, { reportId }), /without delivery claim/);
assert.equal(store.claimDelivery(job.job_id, reportId, 'slack', 'C0C3RJKNKPG'), true);
const done = store.terminalizeJob(job.job_id, { reportId, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: 'M5 PASS' });
assert.equal(done.job.state, 'COMPLETED');
assert.equal(done.job.status, 'completed');
const second = store.terminalizeJob(job.job_id, { reportId, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG' });
assert.equal(second.idempotent, true);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.completed'").get(job.job_id).n, 1);

// A stale attempt arriving after terminal success must not overwrite the Job.
const staleBefore = store.getJob(job.job_id);
store.complete(job.job_id, '[STALE COMPLETION]', 'failure');
assert.equal(store.getJob(job.job_id).state, 'COMPLETED');
assert.equal(store.getJob(job.job_id).status, 'completed');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.failed'").get(job.job_id).n, 0);

const prod = store.createJob({ conversationKey: `m5-prod-${process.pid}`, title: 'Production E2E acceptance terminalization' });
store.approve(prod.job_id, 'Duyet');
const cto = store.dispatch(prod.job_id, { role: 'cto', description: 'sessions_spawn Architect and QA' });
for (const [role, command] of [['architect', 'node --check /home/long/work/chatgpt-adapter/server.js'], ['qa', 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js']]) {
  const t = store.createChildTask(prod.job_id, { parentTaskId: cto.task_id, role, description: `Run exact command: ${command}.` });
  store.db.prepare("UPDATE tasks SET execution_session_id=?, execution_status='completed', execution_attempt=1, execution_exit_code=0 WHERE task_id=?").run(`exec-${role}-m5`, t.task_id);
  store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(t.task_id);
  store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)").run(`result-${role}-m5`, t.task_id, 'success', `[ACTUAL TOOL RESULT EVIDENCE]\n[ACTUAL EXECUTION EVIDENCE]\ntask_id: ${t.task_id}\nexecution_session_id: exec-${role}-m5\nattempt: 1\nexact command: ${command}\nexit status/code: 0\nexecution status: completed`, new Date().toISOString());
}
store.attachTaskRuntime(cto.task_id, { runId: 'run-cto-prod-m5', sessionKey: 'agent:cto:subagent:m5-prod' });
const synthesis = 'Architect: node --check /home/long/work/chatgpt-adapter/server.js exit status: 0; QA: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js exit status: 0';
// Fixture only: terminalization guard is under test; child completion is already durable.
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(cto.task_id);
store.db.prepare("UPDATE agent_sessions SET state='TERMINATED' WHERE task_id=?").run(cto.task_id);
const prodReport = store.createReport(prod.job_id, 'executive_summary', synthesis);
store.claimDelivery(prod.job_id, prodReport, 'slack', 'C0C3RJKNKPG');
const prodDone = store.terminalizeJob(prod.job_id, { reportId: prodReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis });
assert.equal(prodDone.job.state, 'COMPLETED');

// Terminalization must not race live runtime resources even when all business tasks are terminal.
const guard = store.createJob({ conversationKey: `m5-guard-${process.pid}`, title: 'M5 terminal resource guards' });
store.approve(guard.job_id, 'Duyet');
const guardTask = store.dispatch(guard.job_id, { role: 'cto', description: 'guard task' });
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(guardTask.task_id);
const guardReport = store.createReport(guard.job_id, 'executive_summary', 'guard');
store.claimDelivery(guard.job_id, guardReport, 'slack', 'guard-target');
store.createAgentSession(guardTask.task_id, { sessionKey: 'agent:cto:guard-active', role: 'cto', state: 'ACTIVE' });
assert.throws(() => store.terminalizeJob(guard.job_id, { reportId: guardReport, deliveryChannel: 'slack', deliveryTarget: 'guard-target' }), /active agent sessions/);
store.db.prepare("UPDATE agent_sessions SET state='TERMINATED' WHERE openclaw_session_key=?").run('agent:cto:guard-active');
store.db.prepare("INSERT INTO execution_batches(batch_id, job_id, parent_task_id, role, status, attempt, created_at, started_at) VALUES(?,?,?,?,?,?,?,?)")
  .run('batch-m5-guard', guard.job_id, guardTask.task_id, 'cto', 'RUNNING', 1, new Date().toISOString(), new Date().toISOString());
assert.throws(() => store.terminalizeJob(guard.job_id, { reportId: guardReport, deliveryChannel: 'slack', deliveryTarget: 'guard-target' }), /active execution batches/);
console.log('M5 TERMINALIZATION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
