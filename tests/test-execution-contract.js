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
assert.throws(() => validateExecutionRequest({ ...request, input_commit: 'not-a-sha' }), /input_commit/);
assert.throws(() => validateExecutionRequest({ ...request, surprise: true }), /unsupported field/);
assert.throws(() => validateExecutionRequest({ ...request, required_evidence: [] }), /required_evidence/);

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
