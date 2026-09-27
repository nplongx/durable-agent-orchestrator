import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbPath = `/tmp/cos-m5-${process.pid}.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = '/tmp';

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
const prodReport = store.createReport(prod.job_id, 'executive_summary', synthesis);
store.claimDelivery(prod.job_id, prodReport, 'slack', 'C0C3RJKNKPG');
const prodDone = store.terminalizeJob(prod.job_id, { reportId: prodReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis });
assert.equal(prodDone.job.state, 'COMPLETED');
console.log('M5 TERMINALIZATION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
