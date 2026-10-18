import assert from 'node:assert/strict';
import {
  ExecutionContractVersion,
  createExecutionRequest,
  createExecutionResult,
  validateExecutionRequest,
  validateExecutionResult
} from '../src/runtime/execution-contract.js';

const request = createExecutionRequest({
  job_id: 'job_test',
  task_id: 'task_engineer_001',
  lease_id: 'lease_test',
  attempt: 1,
  role: 'engineer',
  input_commit: '0123456789abcdef0123456789abcdef01234567',
  task_payload_ref: 'task://job_test/task_engineer_001',
  workspace: '/workspace',
  required_evidence: ['exit_code', 'test_result', 'output_commit', 'evidence_artifact']
});

assert.equal(request.schema_version, ExecutionContractVersion);
assert.equal(validateExecutionRequest(request), request);

assert.throws(() => validateExecutionRequest({ ...request, attempt: 0 }), /attempt/);
assert.throws(() => validateExecutionRequest({ ...request, attempt: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'the direct request validator must reject rounded attempt identities even when callers bypass createExecutionRequest');
assert.throws(() => validateExecutionRequest({ ...request, owner_epoch: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'the direct request validator must reject rounded owner epochs');
assert.throws(() => validateExecutionRequest({ ...request, input_commit: 'not-a-sha' }), /input_commit/);
assert.throws(() => validateExecutionRequest({ ...request, surprise: true }), /unsupported field/);
assert.throws(() => validateExecutionRequest({ ...request, required_evidence: [] }), /required_evidence/);

const inlinePayload = { schema_version: 1, job_id: 'job_test', task_id: 'task_engineer_001', command: 'true' };
const callerEvidence = ['task-payload.json', 'execution.json'];
const immutableRequest = createExecutionRequest({
  job_id: 'job_test', task_id: 'task_engineer_001', lease_id: 'lease_test', attempt: 1, role: 'engineer',
  input_commit: '0123456789abcdef0123456789abcdef01234567', task_payload_ref: '.worker/tasks/task_engineer_001.json',
  workspace: 'ephemeral', required_evidence: callerEvidence, task_payload_inline: inlinePayload
});
callerEvidence[0] = 'substituted.json';
inlinePayload.command = 'unapproved-command';
assert.deepEqual(immutableRequest.required_evidence, ['task-payload.json', 'execution.json'],
  'request construction must snapshot nested evidence lists instead of retaining caller-owned arrays');
assert.equal(immutableRequest.task_payload_inline.command, 'true',
  'request construction must snapshot nested inline payloads before a dispatch identity is calculated');
assert.equal(Object.isFrozen(immutableRequest.required_evidence), true);
assert.equal(Object.isFrozen(immutableRequest.task_payload_inline), true);
assert.throws(() => immutableRequest.required_evidence.push('later.json'), TypeError);
let accessorCalls = 0;
const accessorRequest = {
  job_id: 'job_test', task_id: 'task_engineer_001', lease_id: 'lease_test', attempt: 1, role: 'engineer',
  input_commit: '0123456789abcdef0123456789abcdef01234567', task_payload_ref: 'task://fixture',
  required_evidence: ['execution.json']
};
Object.defineProperty(accessorRequest, 'role', { enumerable: true, get() { accessorCalls++; return 'engineer'; } });
assert.throws(() => createExecutionRequest(accessorRequest), /not an enumerable data property/);
assert.equal(accessorCalls, 0, 'accessor-backed request fields must be rejected without executing the getter');
const sparseEvidence = ['execution.json'];
sparseEvidence.length = 2;
assert.throws(() => createExecutionRequest({ ...request, required_evidence: sparseEvidence }), /sparse or accessor-backed array entry/);

const result = createExecutionResult({
  job_id: request.job_id,
  task_id: request.task_id,
  lease_id: request.lease_id,
  attempt: request.attempt,
  status: 'SUCCEEDED',
  input_commit: request.input_commit,
  output_commit: 'fedcba9876543210fedcba9876543210fedcba98',
  exit_code: 0,
  provider_run_id: 'provider-run-test',
  evidence_artifact: 'artifact://provider-run-test/evidence',
  evidence_refs: ['artifact://provider-run-test/result.json'],
  started_at: '2026-09-29T00:00:00.000Z',
  finished_at: '2026-09-29T00:01:00.000Z',
  error: null
});

assert.equal(validateExecutionResult(result), result);
let durableAccessorReads = 0;
const accessorDurableResult = { ...result };
Object.defineProperty(accessorDurableResult, 'exit_code', {
  enumerable: true,
  get() { durableAccessorReads++; return 0; }
});
assert.throws(() => validateExecutionResult(accessorDurableResult), /exit_code is not an enumerable data property/,
  'the direct durable result contract must reject accessors before reading a success-critical field');
assert.equal(durableAccessorReads, 0, 'durable result validation must not execute caller-controlled accessors');
let durableArrayAccessorReads = 0;
const accessorEvidenceRefs = [...result.evidence_refs];
Object.defineProperty(accessorEvidenceRefs, '0', {
  enumerable: true,
  get() { durableArrayAccessorReads++; return result.evidence_refs[0]; }
});
assert.throws(() => validateExecutionResult({ ...result, evidence_refs: accessorEvidenceRefs }), /evidence_refs\[0\] is not an enumerable data property/,
  'the direct durable result contract must reject accessor-backed evidence references before iteration');
assert.equal(durableArrayAccessorReads, 0, 'durable result validation must not execute evidence-reference array accessors');
const customPrototypeEvidenceRefs = [...result.evidence_refs];
Object.setPrototypeOf(customPrototypeEvidenceRefs, Object.assign(Object.create(Array.prototype), {
  map() { throw new Error('untrusted inherited array method executed'); }
}));
assert.throws(() => validateExecutionResult({ ...result, evidence_refs: customPrototypeEvidenceRefs }), /evidence_refs must be a plain JSON array/,
  'durable result validation must reject custom-prototype evidence arrays');
assert.throws(() => validateExecutionResult(Object.assign(Object.create({ exit_code: 0 }), {
  ...result, exit_code: undefined
})), /plain JSON object/,
  'the direct durable result contract must reject custom-prototype objects');
assert.throws(() => validateExecutionResult({ ...result, exit_code: -0 }), /canonical safe integer or null/,
  'the direct durable result validator must reject negative zero instead of treating it as an exact successful exit code');
assert.throws(() => validateExecutionResult({ ...result, started_at: '1' }), /valid ISO date-time/,
  'durable result timestamps must not rely on implementation-dependent Date.parse formats');
assert.throws(() => validateExecutionResult({ ...result, started_at: result.finished_at, finished_at: result.started_at }), /must not precede/,
  'durable result finish time must not precede its start time');
const callerResultRefs = ['artifact://provider-run-test/result.json'];
const immutableResult = createExecutionResult({
  ...result, evidence_refs: callerResultRefs
});
callerResultRefs.push('substituted.json');
assert.deepEqual(immutableResult.evidence_refs, ['artifact://provider-run-test/result.json'],
  'result construction must snapshot nested evidence references');
assert.equal(Object.isFrozen(immutableResult.evidence_refs), true);
assert.throws(() => validateExecutionResult({ ...result, exit_code: 1 }), /SUCCEEDED requires exit_code 0/);
assert.throws(() => validateExecutionResult({ ...result, output_commit: null }), /output_commit/);
assert.throws(() => validateExecutionResult({ ...result, evidence_refs: [] }), /evidence_refs/);
assert.throws(() => validateExecutionResult({ ...result, input_commit: request.input_commit.slice(0, 6) }), /input_commit/);

const failed = createExecutionResult({
  ...result,
  status: 'FAILED',
  output_commit: null,
  exit_code: 1,
  evidence_artifact: null,
  evidence_refs: [],
  error: 'tests failed'
});
assert.equal(failed.status, 'FAILED');
assert.throws(() => validateExecutionResult({ ...failed, attempt: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'the direct result validator must reject rounded attempt identities');
assert.throws(() => validateExecutionResult({ ...failed, provider_run_attempt: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'provider run attempts must remain exact integers');
assert.throws(() => validateExecutionResult({ ...failed, exit_code: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/,
  'exit codes must not accept rounded numeric values');

const checkpointed = createExecutionResult({
  ...result,
  status: 'TIMED_OUT',
  output_commit: null,
  exit_code: null,
  error: 'execution timeout',
  checkpoint_commit: 'abcdef1234567890abcdef1234567890abcdef12',
  checkpoint_ref: 'p9-checkpoint/task/provider'
});
assert.equal(checkpointed.checkpoint_commit, 'abcdef1234567890abcdef1234567890abcdef12');
assert.equal(validateExecutionResult(checkpointed), checkpointed);
assert.throws(() => validateExecutionResult({ ...checkpointed, checkpoint_commit: 'nope' }), /checkpoint_commit/);

assert.throws(() => createExecutionResult({
  ...result,
  status: 'TIMED_OUT',
  output_commit: null,
  exit_code: null,
  evidence_artifact: null,
  evidence_refs: [],
  error: null
}), /TIMED_OUT requires error or exit_code/);

console.log('execution-contract P0 PASS');
