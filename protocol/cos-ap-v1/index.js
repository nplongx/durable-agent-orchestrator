import fs from 'node:fs';
import path from 'node:path';

export const COS_AP_PROTOCOL = 'cos-ap';
export const COS_AP_VERSION = 1;
export const MAX_EXECUTION_BATCH_ITEMS = 32;
export const MAX_EXECUTION_COMMAND_CHARS = 32768;
export const MAX_EXECUTION_TIMEOUT_MS = 600000;

export const COS_AP_MESSAGE_TYPES = Object.freeze([
  'job.proposed', 'job.approved', 'session.spawn', 'session.message',
  'execution.batch', 'execution.result', 'child.result', 'synthesis.request',
  'synthesis.result', 'job.progress', 'job.completed', 'job.failed', 'provider.status'
]);

const MESSAGE_TYPE_SET = new Set(COS_AP_MESSAGE_TYPES);
const ROOT = path.dirname(new URL(import.meta.url).pathname);

function fail(message) { throw new TypeError(`COS-AP validation failed: ${message}`); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`); }
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${field} must be a plain JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${field} contains a symbol-keyed field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${field}.${key} is not an enumerable data property`);
    }
  }
}
function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${field} must be a plain JSON array`);
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length || String(Number(key)) !== key) {
      fail(`${field} contains an unsupported array property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${field}[${key}] is not an enumerable data property`);
    }
  }
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${field} contains a sparse or accessor-backed entry at index ${index}`);
    }
  }
}
function isStrictIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z' && (Number(zoneHourText) > 23 || Number(zoneMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
function exactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${field} contains unsupported field ${key}`);
  for (const key of allowedSet) {
    if (!Object.prototype.hasOwnProperty.call(value, key) && key in value) fail(`${field}.${key} must not be inherited`);
  }
}

export function validateEnvelope(input) {
  object(input, 'envelope');
  exactKeys(input, ['protocol', 'version', 'message_id', 'message_type', 'job_id', 'task_id', 'attempt', 'sender', 'recipient', 'correlation_id', 'created_at', 'payload'], 'envelope');
  if (input.protocol !== COS_AP_PROTOCOL) fail(`protocol must be ${COS_AP_PROTOCOL}`);
  if (input.version !== COS_AP_VERSION) fail(`version must be ${COS_AP_VERSION}`);
  requiredString(input.message_id, 'message_id');
  if (!MESSAGE_TYPE_SET.has(input.message_type)) fail(`unsupported message_type ${input.message_type}`);
  if (!/^job_[A-Za-z0-9_-]+$/.test(String(input.job_id || ''))) fail('job_id must start with job_');
  if (input.task_id !== null && input.task_id !== undefined) requiredString(input.task_id, 'task_id');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) fail('attempt must be a safe integer >= 1');
  requiredString(input.sender, 'sender');
  requiredString(input.recipient, 'recipient');
  if (input.correlation_id !== null && input.correlation_id !== undefined) requiredString(input.correlation_id, 'correlation_id');
  if (!isStrictIsoDateTime(input.created_at)) fail('created_at must be a valid ISO date-time with an explicit timezone');
  object(input.payload, 'payload');
  return input;
}

// Durable P2/P3 execution contracts are distinct from the COS-AP batch
// response envelope, but live in this already-packaged protocol module so the
// local runtime keeps one exact schema without an extra payload file.
const DURABLE_EXECUTION_CONTRACT_VERSION = 1;
export const DurableExecutionResultStatus = Object.freeze([
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN'
]);
const DURABLE_EXECUTION_RESULT_STATUS_SET = new Set(DurableExecutionResultStatus);
function durableContractFail(message) { throw new TypeError(`execution contract validation failed: ${message}`); }
function durableRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) durableContractFail(`${field} must be a non-empty string`);
}
function durableOptionalString(value, field) {
  if (value !== null && value !== undefined) durableRequiredString(value, field);
}
function durablePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) durableContractFail(`${field} must be a safe integer >= 1`);
}
function durableExactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') durableContractFail(`${field} contains a symbol-keyed field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      durableContractFail(`${field}.${key} is not an enumerable data property`);
    }
    if (!allowedSet.has(key)) durableContractFail(`${field} contains unsupported field ${key}`);
  }
  for (const key of allowedSet) {
    if (!Object.prototype.hasOwnProperty.call(value, key) && key in value) {
      durableContractFail(`${field}.${key} must not be inherited`);
    }
  }
}
function durableObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) durableContractFail(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) durableContractFail(`${field} must be a plain JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') durableContractFail(`${field} contains a symbol-keyed field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      durableContractFail(`${field}.${key} is not an enumerable data property`);
    }
  }
}
function durableArray(value, field) {
  if (!Array.isArray(value)) durableContractFail(`${field} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) durableContractFail(`${field} must be a plain JSON array`);
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length || String(Number(key)) !== key) {
      durableContractFail(`${field} contains an unsupported array property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      durableContractFail(`${field}[${key}] is not an enumerable data property`);
    }
  }
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      durableContractFail(`${field} contains a sparse or accessor-backed entry at index ${index}`);
    }
  }
}
function durableIsoDate(value, field) {
  durableRequiredString(value, field);
  if (!isStrictIsoDateTime(value)) durableContractFail(`${field} must be a valid ISO date-time with an explicit timezone`);
}
function durableGitCommit(value, field) {
  durableRequiredString(value, field);
  if (!/^[0-9a-f]{7,64}$/i.test(value)) durableContractFail(`${field} must be a Git commit SHA`);
}

export function validateDurableExecutionRequest(request) {
  durableObject(request, 'execution request');
  durableExactKeys(request, [
    'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch',
    'role', 'input_commit', 'task_payload_ref', 'workspace', 'required_evidence', 'task_payload_inline'
  ], 'execution request');
  if (request.schema_version !== DURABLE_EXECUTION_CONTRACT_VERSION) durableContractFail(`schema_version must be ${DURABLE_EXECUTION_CONTRACT_VERSION}`);
  durableRequiredString(request.job_id, 'job_id');
  durableRequiredString(request.task_id, 'task_id');
  durableRequiredString(request.lease_id, 'lease_id');
  durablePositiveInteger(request.attempt, 'attempt');
  if (request.owner_epoch !== undefined) durablePositiveInteger(request.owner_epoch, 'owner_epoch');
  durableRequiredString(request.role, 'role');
  durableGitCommit(request.input_commit, 'input_commit');
  durableRequiredString(request.task_payload_ref, 'task_payload_ref');
  durableOptionalString(request.workspace, 'workspace');
  if (request.task_payload_inline !== undefined && (request.task_payload_inline === null || typeof request.task_payload_inline !== 'object' || Array.isArray(request.task_payload_inline))) durableContractFail('task_payload_inline must be an object');
  durableArray(request.required_evidence, 'required_evidence');
  if (request.required_evidence.length === 0) durableContractFail('required_evidence must be a non-empty array');
  const evidence = new Set();
  for (const item of request.required_evidence) {
    durableRequiredString(item, 'required_evidence item');
    if (evidence.has(item)) durableContractFail(`duplicate required_evidence item ${item}`);
    evidence.add(item);
  }
  return request;
}

export function validateDurableExecutionResult(result) {
  durableObject(result, 'execution result');
  durableExactKeys(result, [
    'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'status',
    'input_commit', 'output_commit', 'exit_code', 'provider_run_id', 'provider_run_attempt',
    'evidence_artifact', 'evidence_refs', 'started_at', 'finished_at', 'error',
    'checkpoint_commit', 'checkpoint_ref', 'agent_output', 'runner_id', 'native_specialist'
  ], 'execution result');
  if (result.schema_version !== DURABLE_EXECUTION_CONTRACT_VERSION) durableContractFail(`schema_version must be ${DURABLE_EXECUTION_CONTRACT_VERSION}`);
  durableRequiredString(result.job_id, 'job_id');
  durableRequiredString(result.task_id, 'task_id');
  durableRequiredString(result.lease_id, 'lease_id');
  durablePositiveInteger(result.attempt, 'attempt');
  if (result.owner_epoch !== undefined && result.owner_epoch !== null) durablePositiveInteger(result.owner_epoch, 'owner_epoch');
  if (result.provider_run_attempt !== undefined && result.provider_run_attempt !== null) {
    durablePositiveInteger(result.provider_run_attempt, 'provider_run_attempt');
  }
  if (!DURABLE_EXECUTION_RESULT_STATUS_SET.has(result.status)) durableContractFail(`invalid status ${result.status}`);
  durableGitCommit(result.input_commit, 'input_commit');
  durableOptionalString(result.output_commit, 'output_commit');
  if (result.exit_code !== null && result.exit_code !== undefined &&
      (!Number.isSafeInteger(result.exit_code) || Object.is(result.exit_code, -0))) {
    durableContractFail('exit_code must be a canonical safe integer or null');
  }
  durableRequiredString(result.provider_run_id, 'provider_run_id');
  durableOptionalString(result.evidence_artifact, 'evidence_artifact');
  durableArray(result.evidence_refs, 'evidence_refs');
  for (const ref of result.evidence_refs) durableRequiredString(ref, 'evidence_refs item');
  durableIsoDate(result.started_at, 'started_at');
  durableIsoDate(result.finished_at, 'finished_at');
  if (Date.parse(result.finished_at) < Date.parse(result.started_at)) {
    durableContractFail('finished_at must not precede started_at');
  }
  durableOptionalString(result.error, 'error');
  durableOptionalString(result.checkpoint_commit, 'checkpoint_commit');
  durableOptionalString(result.checkpoint_ref, 'checkpoint_ref');
  durableOptionalString(result.agent_output, 'agent_output');
  durableOptionalString(result.runner_id, 'runner_id');
  if (result.native_specialist !== undefined && result.native_specialist !== null) {
    durableObject(result.native_specialist, 'native_specialist');
    durableExactKeys(result.native_specialist, ['session_id', 'run_id', 'session_key', 'environment_id', 'node_id', 'owner_epoch', 'status', 'output'], 'native_specialist');
    for (const key of ['session_id', 'run_id', 'session_key', 'environment_id', 'node_id', 'status']) durableRequiredString(result.native_specialist[key], `native_specialist.${key}`);
    durablePositiveInteger(result.native_specialist.owner_epoch, 'native_specialist.owner_epoch');
    durableOptionalString(result.native_specialist.output, 'native_specialist.output');
  }
  if (result.checkpoint_commit && !/^[0-9a-f]{7,64}$/i.test(result.checkpoint_commit)) durableContractFail('checkpoint_commit must be a Git commit SHA');
  if (result.status === 'SUCCEEDED') {
    if (result.exit_code !== 0) durableContractFail('SUCCEEDED requires exit_code 0');
    durableGitCommit(result.output_commit, 'output_commit');
    durableRequiredString(result.evidence_artifact, 'evidence_artifact');
    if (result.evidence_refs.length === 0) durableContractFail('SUCCEEDED requires evidence_refs');
  }
  if (result.status === 'FAILED' || result.status === 'TIMED_OUT') {
    if (!result.error && result.exit_code == null) durableContractFail(`${result.status} requires error or exit_code`);
  }
  return result;
}

export function validateExecutionBatch(payload) {
  object(payload, 'execution.batch payload');
  exactKeys(payload, ['batch_id', 'wait', 'tasks'], 'execution.batch payload');
  requiredString(payload.batch_id, 'batch_id');
  if (payload.wait !== 'all') fail('execution.batch wait must be all');
  array(payload.tasks, 'tasks');
  if (payload.tasks.length < 1 || payload.tasks.length > MAX_EXECUTION_BATCH_ITEMS) {
    fail(`execution.batch tasks must contain 1..${MAX_EXECUTION_BATCH_ITEMS} items`);
  }
  const ids = new Set();
  for (const [i, task] of payload.tasks.entries()) {
    object(task, `tasks[${i}]`);
    exactKeys(task, ['id', 'task_id', 'command', 'cwd', 'timeout_ms'], `tasks[${i}]`);
    requiredString(task.id, `tasks[${i}].id`);
    requiredString(task.task_id, `tasks[${i}].task_id`);
    requiredString(task.command, `tasks[${i}].command`);
    if (task.command.length > MAX_EXECUTION_COMMAND_CHARS) fail(`tasks[${i}].command exceeds ${MAX_EXECUTION_COMMAND_CHARS} characters`);
    if (ids.has(task.id)) fail(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.cwd !== undefined) {
      requiredString(task.cwd, `tasks[${i}].cwd`);
      if (task.cwd.length > 4096) fail(`tasks[${i}].cwd exceeds 4096 characters`);
    }
    if (task.timeout_ms !== undefined && (!Number.isSafeInteger(task.timeout_ms) || task.timeout_ms < 1 || task.timeout_ms > MAX_EXECUTION_TIMEOUT_MS)) {
      fail(`tasks[${i}].timeout_ms must be a safe integer in 1..${MAX_EXECUTION_TIMEOUT_MS}`);
    }
  }
  return payload;
}

export function validateExecutionResult(payload) {
  object(payload, 'execution.result payload');
  exactKeys(payload, ['batch_id', 'status', 'summary', 'items'], 'execution.result payload');
  requiredString(payload.batch_id, 'batch_id');
  if (!['completed', 'failed', 'partial'].includes(payload.status)) fail('invalid execution result status');
  object(payload.summary, 'summary');
  exactKeys(payload.summary, ['total', 'passed', 'failed'], 'summary');
  for (const field of ['total', 'passed', 'failed']) {
    if (!Number.isSafeInteger(payload.summary[field]) || payload.summary[field] < 0 || Object.is(payload.summary[field], -0)) {
      fail(`summary.${field} must be a canonical non-negative safe integer`);
    }
  }
  array(payload.items, 'items');
  if (payload.items.length < 1 || payload.items.length > MAX_EXECUTION_BATCH_ITEMS) {
    fail(`items must contain 1..${MAX_EXECUTION_BATCH_ITEMS} terminal results`);
  }
  const itemIds = new Set();
  const taskIds = new Set();
  let passedCount = 0;
  for (const [i, item] of payload.items.entries()) {
    object(item, `items[${i}]`);
    exactKeys(item, ['id', 'task_id', 'command', 'status', 'exit_code', 'execution_session_id', 'stdout', 'stderr', 'error'], `items[${i}]`);
    for (const field of ['id', 'task_id', 'command', 'status', 'exit_code', 'execution_session_id', 'stdout', 'stderr', 'error']) {
      if (!Object.hasOwn(item, field)) fail(`items[${i}].${field} is required`);
    }
    requiredString(item.id, `items[${i}].id`);
    requiredString(item.task_id, `items[${i}].task_id`);
    requiredString(item.command, `items[${i}].command`);
    if (!['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status)) fail(`items[${i}].status must be terminal`);
    if (itemIds.has(item.id)) fail(`duplicate execution result item id ${item.id}`);
    if (taskIds.has(item.task_id)) fail(`duplicate execution result task_id ${item.task_id}`);
    itemIds.add(item.id);
    taskIds.add(item.task_id);
    if (item.exit_code !== null && (!Number.isSafeInteger(item.exit_code) || Object.is(item.exit_code, -0))) {
      fail(`items[${i}].exit_code must be a canonical safe integer/null`);
    }
    for (const field of ['execution_session_id', 'stdout', 'stderr', 'error']) {
      if (item[field] !== null && typeof item[field] !== 'string') fail(`items[${i}].${field} must be string/null`);
    }
    if (item.status === 'COMPLETED') {
      if (item.exit_code !== 0) fail(`items[${i}] COMPLETED requires exact numeric exit_code 0`);
      requiredString(item.execution_session_id, `items[${i}].execution_session_id for COMPLETED`);
      if (item.error !== null) fail(`items[${i}] COMPLETED cannot carry a terminal error`);
      passedCount++;
    }
    if (item.status === 'FAILED' && item.exit_code === 0 && (typeof item.error !== 'string' || !item.error.trim())) {
      fail(`items[${i}] FAILED with exit_code 0 requires an explicit failure reason`);
    }
  }
  const total = payload.items.length;
  const failedCount = total - passedCount;
  const expectedStatus = passedCount === total ? 'completed' : passedCount === 0 ? 'failed' : 'partial';
  if (payload.summary.total !== total) fail('summary.total must equal items.length');
  if (payload.summary.passed !== passedCount) fail('summary.passed must equal the number of COMPLETED items');
  if (payload.summary.failed !== failedCount) fail('summary.failed must equal the number of non-COMPLETED items');
  if (payload.status !== expectedStatus) fail(`status must be ${expectedStatus} for the exact terminal item summary`);
  return payload;
}

export function validatePayload(messageType, payload) {
  switch (messageType) {
    case 'execution.batch': return validateExecutionBatch(payload);
    case 'execution.result': return validateExecutionResult(payload);
    case 'child.result':
    case 'synthesis.result':
      object(payload, `${messageType} payload`);
      exactKeys(payload, ['status', 'evidence_refs', 'summary'], `${messageType} payload`);
      if (!['passed', 'failed', 'partial'].includes(payload.status)) fail(`${messageType} status invalid`);
      if (!Array.isArray(payload.evidence_refs)) fail(`${messageType} evidence_refs must be array`);
      return payload;
    case 'provider.status':
      object(payload, 'provider.status payload');
      exactKeys(payload, ['state', 'provider', 'account', 'cooldown_until'], 'provider.status payload');
      if (!['READY', 'IN_USE', 'COOLDOWN', 'PROBE'].includes(payload.state)) fail('invalid provider state');
      return payload;
    default:
      object(payload, `${messageType} payload`);
      return payload;
  }
}

export function createEnvelope({ messageId, messageType, jobId, taskId = null, attempt = 1, sender, recipient, correlationId = null, payload = {}, createdAt = new Date().toISOString() }) {
  const envelope = { protocol: COS_AP_PROTOCOL, version: COS_AP_VERSION, message_id: messageId, message_type: messageType, job_id: jobId, task_id: taskId, attempt, sender, recipient, correlation_id: correlationId, created_at: createdAt, payload };
  validateEnvelope(envelope);
  validatePayload(messageType, payload);
  return Object.freeze(envelope);
}

export function schemaPath(name) { return path.join(ROOT, `${name}.schema.json`); }
export function readSchema(name) { return JSON.parse(fs.readFileSync(schemaPath(name), 'utf8')); }
