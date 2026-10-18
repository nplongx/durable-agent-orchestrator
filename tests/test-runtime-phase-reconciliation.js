import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const temp = tempDir('runtime-phase-reconciliation-');
const dbPath = path.join(temp, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = temp;

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();

function makeTerminalizableJob(title, phase = null) {
  const job = store.createJob({ conversationKey: title, title });
  store.approve(job.job_id, 'approved for regression test');
  const task = store.dispatch(job.job_id, { role: 'cto', description: title });
  store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(task.task_id);
  if (phase) store.setWorkflowRuntimeState(job.job_id, phase);
  const reportId = store.createReport(job.job_id, 'final', `${title} result`);
  store.claimDelivery(job.job_id, reportId, 'test', 'local');
  return { job, reportId };
}

const local = makeTerminalizableJob('local terminal phase reconciliation');
assert.equal(store.getWorkflowRuntimeState(local.job.job_id).phase, 'SPAWN_CTO');
const completed = store.terminalizeJob(local.job.job_id, {
  reportId: local.reportId, deliveryChannel: 'test', deliveryTarget: 'local', content: 'done'
});
assert.equal(completed.job.state, 'COMPLETED');
assert.equal(store.getWorkflowRuntimeState(local.job.job_id).phase, 'COMPLETED');
assert.equal(store.listActiveJobs().some(item => item.job_id === local.job.job_id), false);
assert.equal(store.getStats().workflowPhaseMismatches, 0);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='workflow.terminal_phase_reconciled'").get(local.job.job_id).n, 1);

const projection = makeTerminalizableJob('projection queue keeps its phase', 'PROJECT');
store.terminalizeJob(projection.job.job_id, {
  reportId: projection.reportId, deliveryChannel: 'test', deliveryTarget: 'local', content: 'done'
});
assert.equal(store.getWorkflowRuntimeState(projection.job.job_id).phase, 'PROJECT');
assert.equal(store.listProjectableJobs().some(item => item.job_id === projection.job.job_id), true);
assert.equal(store.getStats().workflowPhaseMismatches, 0);

// Idempotent terminalization also repairs stale phase data left by older runs.
store.setWorkflowRuntimeState(local.job.job_id, 'SPAWN_CTO');
const replayed = store.terminalizeJob(local.job.job_id, {
  reportId: local.reportId, deliveryChannel: 'test', deliveryTarget: 'local', content: 'replay'
});
assert.equal(replayed.idempotent, true);
assert.equal(store.getWorkflowRuntimeState(local.job.job_id).phase, 'COMPLETED');
assert.equal(store.getStats().workflowPhaseMismatches, 0);

const failed = makeTerminalizableJob('failed terminal phase reconciliation');
store.db.prepare("UPDATE tasks SET status='failed' WHERE job_id=?").run(failed.job.job_id);
store.terminalizeJob(failed.job.job_id, {
  outcome: 'failure', reportId: failed.reportId, deliveryChannel: 'test', deliveryTarget: 'local', content: 'failed'
});
assert.equal(store.getWorkflowRuntimeState(failed.job.job_id).phase, 'FAILED');
assert.equal(store.getStats().failedJobs, 1);
assert.equal(store.getStats().workflowPhaseMismatches, 0);

const tamperedDelivery = makeTerminalizableJob('tampered delivery claim cannot terminalize');
const deliveryRow = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='delivery.claimed'")
  .get(tamperedDelivery.job.job_id);
const canonicalDelivery = deliveryRow.payload_json;
const alteredDelivery = { ...JSON.parse(canonicalDelivery), channel: 'substituted-channel' };
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(alteredDelivery), deliveryRow.event_id);
assert.throws(() => store.terminalizeJob(tamperedDelivery.job.job_id, {
  outcome: 'failure', reportId: tamperedDelivery.reportId, content: 'failed despite tampered claim'
}), /delivery claim with conflicting deterministic identity/,
'a reportId-only existence check must not accept a tampered delivery channel after the claim was persisted');
assert.equal(store.getJob(tamperedDelivery.job.job_id).state, 'EXECUTING',
  'a tampered delivery claim must not terminalize the job');
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalDelivery, deliveryRow.event_id);
store.terminalizeJob(tamperedDelivery.job.job_id, {
  outcome: 'failure', reportId: tamperedDelivery.reportId, content: 'valid claim restored'
});
assert.equal(store.getJob(tamperedDelivery.job.job_id).state, 'FAILED');

console.log('RUNTIME PHASE RECONCILIATION / TAMPERED DELIVERY CLAIM TERMINAL FENCE PASS');
store.close?.();
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
