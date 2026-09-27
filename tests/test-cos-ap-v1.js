import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const db = `/home/long/work/chatgpt-adapter/data/test-cos-ap-${crypto.randomUUID()}.db`;
process.env.WORKFLOW_DB = db;
process.env.WORKFLOW_DATA_DIR = path.dirname(db);

const {
  COS_AP_PROTOCOL,
  COS_AP_VERSION,
  createEnvelope,
  validateEnvelope,
  validateExecutionBatch,
  validateExecutionResult,
  readSchema
} = await import('../protocol/cos-ap-v1/index.js');

const batch = {
  batch_id: 'batch_test',
  wait: 'all',
  tasks: [
    { id: 'a', task_id: 'task_a', command: 'node --check /tmp/a.js' },
    { id: 'b', task_id: 'task_b', command: 'node --check /tmp/b.js' }
  ]
};

const envelope = createEnvelope({
  messageId: 'msg_test',
  messageType: 'execution.batch',
  jobId: 'job_test',
  taskId: 'task_parent',
  sender: 'architect',
  recipient: 'executor',
  correlationId: 'turn_test',
  payload: batch
});

assert.equal(envelope.protocol, COS_AP_PROTOCOL);
assert.equal(envelope.version, COS_AP_VERSION);
assert.equal(validateEnvelope(envelope), envelope);
assert.equal(validateExecutionBatch(batch), batch);
assert.throws(() => validateExecutionBatch({ ...batch, tasks: [{ ...batch.tasks[0], id: 'a' }, { ...batch.tasks[1], id: 'a' }] }), /duplicate task id/);
assert.throws(() => validateEnvelope({ ...envelope, version: 99 }), /version/);
assert.throws(() => validateEnvelope({ ...envelope, message_type: 'exec.magic' }), /unsupported message_type/);
assert.throws(() => validateEnvelope({ ...envelope, surprise: true }), /unsupported field surprise/);
assert.throws(() => createEnvelope({ messageId: 'msg_bad', messageType: 'execution.batch', jobId: 'job_test', taskId: 'task_parent', sender: 'architect', recipient: 'executor', payload: { ...batch, wait: 'any' } }), /wait must be all/);
assert.doesNotThrow(() => validateExecutionResult({ batch_id: 'batch_test', status: 'completed', summary: { total: 2, passed: 2, failed: 0 }, items: [
  { id: 'a', task_id: 'task_a', command: 'node --check /tmp/a.js', status: 'COMPLETED', exit_code: 0, execution_session_id: 'exec_a', stdout: '', stderr: '', error: null },
  { id: 'b', task_id: 'task_b', command: 'node --check /tmp/b.js', status: 'COMPLETED', exit_code: 0, execution_session_id: 'exec_b', stdout: '', stderr: '', error: null }
] }));
for (const schema of ['envelope', 'execution-batch', 'execution-result', 'child-result', 'synthesis', 'provider-status']) {
  const parsed = readSchema(schema);
  assert.equal(parsed.$id, `cos-ap/1/${schema}`);
}

const { WorkflowStore } = await import('../job-store.js');
const { buildDurableWireEnvelope } = await import('../session-transport.js');
const store = new WorkflowStore();
const job = store.getOrCreateJob({ conversationKey: 'cos-ap-test', title: 'protocol test' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyệt');
store.dispatch(job.job_id, { role: 'cto', description: 'protocol test' });
const task = store.getTask(store.getJob(job.job_id).active_task_id);
store.attachTaskRuntime(task.task_id, { runId: 'run_protocol', sessionKey: 'agent:cto:subagent:protocol' });
const session = store.getSessionByTask(task.task_id);
store.grantSessionAccess(session.session_id, { accessorRole: 'cto', permission: 'MESSAGE', grantedBy: 'cto' });
const message = store.enqueueSessionMessage(session.session_id, {
  senderRole: 'cto', recipientRole: 'cto',
  messageType: 'execution.batch', payload: batch,
  correlationId: 'turn_protocol', dedupeKey: 'protocol-message-1'
});
assert.equal(message.protocol, 'cos-ap');
assert.equal(message.protocol_version, 1);
assert.equal(message.message_type, 'execution.batch');
assert.equal(store.enqueueSessionMessage(session.session_id, {
  senderRole: 'cto', recipientRole: 'cto', messageType: 'execution.batch', payload: batch,
  correlationId: 'turn_protocol', dedupeKey: 'protocol-message-1'
}).message_id, message.message_id);
const wire = buildDurableWireEnvelope(session, message);
const wireLines = wire.split('\n');
const wireEnvelope = JSON.parse(wireLines[1]);
assert.equal(wireEnvelope.protocol, 'cos-ap');
assert.equal(wireEnvelope.version, 1);
assert.equal(wireEnvelope.job_id, job.job_id);
assert.equal(wireEnvelope.message_id, message.message_id);
assert.equal(wireEnvelope.payload.batch_id, 'batch_test');

console.log('COS-AP v1 PASS');
try { fs.rmSync(db, { force: true }); fs.rmSync(`${db}-wal`, { force: true }); fs.rmSync(`${db}-shm`, { force: true }); } catch (_) {}
