const EXECUTION_CONTRACT_VERSION = 1;

export const ExecutionContractVersion = EXECUTION_CONTRACT_VERSION;

export const ExecutionResultStatus = Object.freeze([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'UNKNOWN'
]);

const RESULT_STATUS_SET = new Set(ExecutionResultStatus);

function fail(message) {
  throw new TypeError(`execution contract validation failed: ${message}`);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
}

function optionalString(value, field) {
  if (value !== null && value !== undefined) requiredString(value, field);
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) fail(`${field} must be an integer >= 1`);
}

function exactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${field} contains unsupported field ${key}`);
  }
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
}

function isoDate(value, field) {
  requiredString(value, field);
  if (Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO date-time`);
}

function gitCommit(value, field) {
  requiredString(value, field);
  if (!/^[0-9a-f]{7,64}$/i.test(value)) fail(`${field} must be a Git commit SHA`);
}

export function validateExecutionRequest(request) {
  object(request, 'execution request');
  exactKeys(request, [
    'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt',
    'role', 'input_commit', 'task_payload_ref', 'workspace', 'required_evidence'
  ], 'execution request');

  if (request.schema_version !== EXECUTION_CONTRACT_VERSION) fail(`schema_version must be ${EXECUTION_CONTRACT_VERSION}`);
  requiredString(request.job_id, 'job_id');
  requiredString(request.task_id, 'task_id');
  requiredString(request.lease_id, 'lease_id');
  positiveInteger(request.attempt, 'attempt');
  requiredString(request.role, 'role');
  gitCommit(request.input_commit, 'input_commit');
  requiredString(request.task_payload_ref, 'task_payload_ref');
  optionalString(request.workspace, 'workspace');

  if (!Array.isArray(request.required_evidence) || request.required_evidence.length === 0) {
    fail('required_evidence must be a non-empty array');
  }
  const evidence = new Set();
  for (const item of request.required_evidence) {
    requiredString(item, 'required_evidence item');
    if (evidence.has(item)) fail(`duplicate required_evidence item ${item}`);
    evidence.add(item);
  }
  return request;
}

export function validateExecutionResult(result) {
  object(result, 'execution result');
  exactKeys(result, [
    'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt', 'status',
    'input_commit', 'output_commit', 'exit_code', 'provider_run_id',
    'evidence_artifact', 'evidence_refs', 'started_at', 'finished_at', 'error',
    'checkpoint_commit', 'checkpoint_ref'
  ], 'execution result');

  if (result.schema_version !== EXECUTION_CONTRACT_VERSION) fail(`schema_version must be ${EXECUTION_CONTRACT_VERSION}`);
  requiredString(result.job_id, 'job_id');
  requiredString(result.task_id, 'task_id');
  requiredString(result.lease_id, 'lease_id');
  positiveInteger(result.attempt, 'attempt');
  if (!RESULT_STATUS_SET.has(result.status)) fail(`invalid status ${result.status}`);
  gitCommit(result.input_commit, 'input_commit');
  optionalString(result.output_commit, 'output_commit');
  if (result.exit_code !== null && result.exit_code !== undefined && !Number.isInteger(result.exit_code)) {
    fail('exit_code must be an integer or null');
  }
  requiredString(result.provider_run_id, 'provider_run_id');
  optionalString(result.evidence_artifact, 'evidence_artifact');

  if (!Array.isArray(result.evidence_refs)) fail('evidence_refs must be an array');
  for (const ref of result.evidence_refs) requiredString(ref, 'evidence_refs item');

  isoDate(result.started_at, 'started_at');
  isoDate(result.finished_at, 'finished_at');
  optionalString(result.error, 'error');
  optionalString(result.checkpoint_commit, 'checkpoint_commit');
  optionalString(result.checkpoint_ref, 'checkpoint_ref');
  if (result.checkpoint_commit && !/^[0-9a-f]{7,64}$/i.test(result.checkpoint_commit)) fail('checkpoint_commit must be a Git commit SHA');

  if (result.status === 'SUCCEEDED') {
    if (result.exit_code !== 0) fail('SUCCEEDED requires exit_code 0');
    gitCommit(result.output_commit, 'output_commit');
    requiredString(result.evidence_artifact, 'evidence_artifact');
    if (result.evidence_refs.length === 0) fail('SUCCEEDED requires evidence_refs');
  }

  if (result.status === 'FAILED' || result.status === 'TIMED_OUT') {
    if (!result.error && result.exit_code == null) {
      fail(`${result.status} requires error or exit_code`);
    }
  }

  return result;
}

export function createExecutionRequest(input) {
  const request = { schema_version: EXECUTION_CONTRACT_VERSION, ...input };
  return Object.freeze(validateExecutionRequest(request));
}

export function createExecutionResult(input) {
  const result = { schema_version: EXECUTION_CONTRACT_VERSION, ...input };
  return Object.freeze(validateExecutionResult(result));
}
