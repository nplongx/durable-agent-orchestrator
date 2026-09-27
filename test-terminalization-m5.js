import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbPath = `/tmp/cos-m5-${process.pid}.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = '/tmp';

const { WorkflowStore } = await import('./job-store.js');
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

const prod = store.createJob({ conversationKey: `m5-prod-${process.pid}`, title: 'Production E2E acceptance terminalization' });
store.approve(prod.job_id, 'Duyet');
const cto = store.dispatch(prod.job_id, { role: 'cto', description: 'sessions_spawn Architect and QA' });
for (const [role, command] of [['architect', 'node --check /home/long/work/chatgpt-adapter/server.js'], ['qa', 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js']]) {
  const t = store.createChildTask(prod.job_id, { parentTaskId: cto.task_id, role, description: `Run exact command: ${command}.` });
  store.attachTaskRuntime(t.task_id, { runId: `run-${role}-m5`, sessionKey: `agent:${role}:subagent:m5-prod` });
  store.completeTaskByRuntime(prod.job_id, { runId: `run-${role}-m5`, sessionKey: `agent:${role}:subagent:m5-prod`, content: `<prompt-data>${command}\nexit status: 0</prompt-data>\n[ACTUAL TOOL RESULT EVIDENCE]\n${command}\nexit status: 0`, outcome: 'success' });
}
store.attachTaskRuntime(cto.task_id, { runId: 'run-cto-prod-m5', sessionKey: 'agent:cto:subagent:m5-prod' });
const synthesis = 'Architect: node --check /home/long/work/chatgpt-adapter/server.js exit status: 0; QA: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js exit status: 0';
store.completeTaskByRuntime(prod.job_id, { runId: 'run-cto-prod-m5', sessionKey: 'agent:cto:subagent:m5-prod', content: synthesis, outcome: 'success' });
const prodReport = store.createReport(prod.job_id, 'executive_summary', synthesis);
store.claimDelivery(prod.job_id, prodReport, 'slack', 'C0C3RJKNKPG');
const prodDone = store.terminalizeJob(prod.job_id, { reportId: prodReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis });
assert.equal(prodDone.job.state, 'COMPLETED');
console.log('M5 TERMINALIZATION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
