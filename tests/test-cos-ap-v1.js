import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const db = path.join(tempDir('test-cos-ap-v1-'), 'workflow.db');
process.env.WORKFLOW_DB = db;
process.env.WORKFLOW_DATA_DIR = path.dirname(db);

const {
  COS_AP_PROTOCOL,
  COS_AP_VERSION,
  createEnvelope,
  validateEnvelope,
  validateExecutionBatch,
  validateExecutionResult,
  MAX_EXECUTION_BATCH_ITEMS,
  MAX_EXECUTION_COMMAND_CHARS,
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
assert.throws(() => validateEnvelope({ ...envelope, created_at: '1' }), /valid ISO date-time/,
  'wire timestamps must not accept implementation-dependent Date.parse formats');
assert.throws(() => validateEnvelope({ ...envelope, created_at: '2026-02-31T12:00:00Z' }), /valid ISO date-time/,
  'wire timestamps must reject normalized invalid calendar dates');
assert.throws(() => validateEnvelope({ ...envelope, attempt: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'wire envelope attempts must be exact safe integers');
assert.equal(validateExecutionBatch(batch), batch);
assert.throws(() => validateExecutionBatch({ ...batch, tasks: [{ ...batch.tasks[0], timeout_ms: Number.MAX_SAFE_INTEGER + 1 }] }), /1\.\.600000/,
  'execution timeouts must be bounded exact integers');
assert.throws(() => validateExecutionBatch({ ...batch, tasks: Array.from({ length: MAX_EXECUTION_BATCH_ITEMS + 1 }, (_, index) => ({ id: `item-${index}`, task_id: `task_${index}`, command: 'node --version' })) }), /1\.\.32 items/);
assert.throws(() => validateExecutionBatch({ ...batch, tasks: [{ ...batch.tasks[0], command: 'x'.repeat(MAX_EXECUTION_COMMAND_CHARS + 1) }] }), /exceeds 32768 characters/);
assert.throws(() => validateExecutionBatch({ ...batch, tasks: [{ ...batch.tasks[0], id: 'a' }, { ...batch.tasks[1], id: 'a' }] }), /duplicate task id/);
assert.throws(() => validateEnvelope({ ...envelope, version: 99 }), /version/);
assert.throws(() => validateEnvelope({ ...envelope, message_type: 'exec.magic' }), /unsupported message_type/);
assert.throws(() => validateEnvelope({ ...envelope, surprise: true }), /unsupported field surprise/);
assert.throws(() => createEnvelope({ messageId: 'msg_bad', messageType: 'execution.batch', jobId: 'job_test', taskId: 'task_parent', sender: 'architect', recipient: 'executor', payload: { ...batch, wait: 'any' } }), /wait must be all/);
const validExecutionResult = { batch_id: 'batch_test', status: 'completed', summary: { total: 2, passed: 2, failed: 0 }, items: [
  { id: 'a', task_id: 'task_a', command: 'node --check /tmp/a.js', status: 'COMPLETED', exit_code: 0, execution_session_id: 'exec_a', stdout: '', stderr: '', error: null },
  { id: 'b', task_id: 'task_b', command: 'node --check /tmp/b.js', status: 'COMPLETED', exit_code: 0, execution_session_id: 'exec_b', stdout: '', stderr: '', error: null }
] };
assert.equal(validateExecutionResult(validExecutionResult), validExecutionResult);
let protocolAccessorReads = 0;
const accessorBatchResult = { ...validExecutionResult };
Object.defineProperty(accessorBatchResult, 'batch_id', {
  enumerable: true,
  get() { protocolAccessorReads++; return 'batch_test'; }
});
assert.throws(() => validateExecutionResult(accessorBatchResult), /batch_id is not an enumerable data property/,
  'protocol validators must reject accessor-backed identity before reading it');
assert.equal(protocolAccessorReads, 0, 'protocol validation must not execute caller-controlled accessors');
let protocolArrayAccessorReads = 0;
const accessorItems = [...validExecutionResult.items];
Object.defineProperty(accessorItems, '0', {
  enumerable: true,
  get() { protocolArrayAccessorReads++; return validExecutionResult.items[0]; }
});
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: accessorItems }), /items\[0\] is not an enumerable data property/,
  'protocol validation must reject accessor-backed array entries before iteration');
assert.equal(protocolArrayAccessorReads, 0, 'protocol validation must not execute array entry accessors');
const customPrototypeItems = [...validExecutionResult.items];
Object.setPrototypeOf(customPrototypeItems, Object.assign(Object.create(Array.prototype), {
  map() { throw new Error('untrusted inherited array method executed'); }
}));
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: customPrototypeItems }), /items must be a plain JSON array/,
  'protocol validation must reject array prototypes that can replace downstream built-in methods');
assert.throws(() => validateExecutionResult(Object.assign(Object.create({ batch_id: 'batch_test' }), {
  status: validExecutionResult.status, summary: validExecutionResult.summary, items: validExecutionResult.items
})), /plain JSON object/,
  'protocol validation must reject objects with attacker-controlled prototypes');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  { ...validExecutionResult.items[0], exit_code: -0 }, validExecutionResult.items[1]
] }), /canonical safe integer\/null/,
'negative zero must not alias the exact numeric exit code zero in an in-memory batch result');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, summary: { total: 2, passed: -0, failed: 0 } }), /canonical non-negative safe integer/,
  'negative zero must not alias a canonical batch summary counter');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  validExecutionResult.items[0], { ...validExecutionResult.items[1], status: 'FAILED', exit_code: 9, error: 'exit status 9' }
] }), /summary\.passed must equal/,
'a success-shaped summary must not hide a failed item');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  validExecutionResult.items[0], { ...validExecutionResult.items[1], exit_code: null }
] }), /COMPLETED requires exact numeric exit_code 0/,
'a completed item must carry exact numeric exit code zero');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  validExecutionResult.items[0], { ...validExecutionResult.items[1], error: 'contradictory error' }
] }), /COMPLETED cannot carry a terminal error/,
'a completed item may not carry an error');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  validExecutionResult.items[0], { ...validExecutionResult.items[1], status: 'RUNNING' }
] }), /status must be terminal/,
'execution.result must not contain a still-running item');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, summary: { total: 2, passed: 1, failed: 0 } }), /summary\.passed must equal/,
'summary counters must exactly reconcile with terminal item states');
assert.throws(() => validateExecutionResult({ ...validExecutionResult, items: [
  validExecutionResult.items[0], { ...validExecutionResult.items[1], id: validExecutionResult.items[0].id }
] }), /duplicate execution result item id/,
'execution result item identities must be unique');
assert.throws(() => validateExecutionResult({
  batch_id: 'batch_failed_zero_exit', status: 'failed', summary: { total: 1, passed: 0, failed: 1 }, items: [
    { id: 'a', task_id: 'task_a', command: 'node --version', status: 'FAILED', exit_code: 0, execution_session_id: null, stdout: '', stderr: '', error: null }
  ]
}), /FAILED with exit_code 0 requires an explicit failure reason/,
'zero-exit failure results must explain the evidence/contract failure');
const partialExecutionResult = {
  ...validExecutionResult,
  status: 'partial',
  summary: { total: 2, passed: 1, failed: 1 },
  items: [validExecutionResult.items[0], { ...validExecutionResult.items[1], status: 'FAILED', exit_code: 9, error: 'exit status 9' }]
};
assert.equal(validateExecutionResult(partialExecutionResult), partialExecutionResult,
  'consistent mixed terminal results remain valid partial results');
for (const schema of ['envelope', 'execution-batch', 'execution-result', 'child-result', 'synthesis', 'provider-status']) {
  const parsed = readSchema(schema);
  assert.equal(parsed.$id, `cos-ap/1/${schema}`);
  if (schema === 'execution-batch') {
    assert.equal(parsed.properties.tasks.maxItems, MAX_EXECUTION_BATCH_ITEMS, 'published JSON schema item limit must match runtime validator');
    assert.equal(parsed.properties.tasks.items.properties.command.maxLength, MAX_EXECUTION_COMMAND_CHARS,
      'published JSON schema command length limit must match runtime validator');
    assert.equal(parsed.properties.tasks.items.properties.cwd.maxLength, 4096);
    assert.equal(parsed.properties.tasks.items.properties.timeout_ms.maximum, 600000,
      'published JSON schema timeout bound must match runtime validator');
  } else if (schema === 'execution-result') {
    assert.equal(parsed.properties.items.minItems, 1);
    assert.equal(parsed.properties.items.maxItems, MAX_EXECUTION_BATCH_ITEMS);
    assert.equal(parsed.properties.summary.properties.total.minimum, 1);
    assert.equal(parsed.properties.summary.properties.total.maximum, MAX_EXECUTION_BATCH_ITEMS);
    assert.deepEqual(parsed.properties.items.items.properties.status.enum, ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
      'published result schema must reject non-terminal item states');
    assert.deepEqual(parsed.properties.items.items.required,
      ['id', 'task_id', 'command', 'status', 'exit_code', 'execution_session_id', 'stdout', 'stderr', 'error'],
      'published result schema must require every output/identity field');
    assert.equal(parsed.properties.items.items.allOf[1].then.properties.error.pattern, '\\S',
      'published result schema must reject whitespace-only failure reasons for zero-exit FAILED items');
    assert.equal(parsed.allOf.length, 3, 'published result schema must constrain status/summary combinations');
    assert.equal(parsed.allOf[0].then.properties.summary.properties.failed.const, 0,
      'completed result schema must not permit failed items');
    assert.equal(parsed.allOf[1].then.properties.summary.properties.passed.const, 0,
      'failed result schema must not permit passed items');
    assert.equal(parsed.allOf[2].then.properties.summary.properties.passed.minimum, 1);
    assert.equal(parsed.allOf[2].then.properties.summary.properties.failed.minimum, 1,
      'partial result schema must require at least one passed and failed item');
  }
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
const claimedMessage = store.claimSessionMessage(message.message_id, { recipientRole: 'cto' });
assert.equal(claimedMessage.attempt, 1, 'wire construction must use a claimed positive delivery attempt');
const wire = buildDurableWireEnvelope(session, claimedMessage);
const wireLines = wire.split('\n');
const wireEnvelope = JSON.parse(wireLines[1]);
assert.equal(wireEnvelope.protocol, 'cos-ap');
assert.equal(wireEnvelope.version, 1);
assert.equal(wireEnvelope.job_id, job.job_id);
assert.equal(wireEnvelope.message_id, message.message_id);
assert.equal(wireEnvelope.payload.batch_id, 'batch_test');

console.log('COS-AP v1 PASS');
try { fs.rmSync(db, { force: true }); fs.rmSync(`${db}-wal`, { force: true }); fs.rmSync(`${db}-shm`, { force: true }); } catch (_) {}
try { fs.rmSync(path.dirname(db), { recursive: true, force: true }); } catch (_) {}
