import fs from 'node:fs';
import path from 'node:path';

export const COS_AP_PROTOCOL = 'cos-ap';
export const COS_AP_VERSION = 1;

export const COS_AP_MESSAGE_TYPES = Object.freeze([
  'job.proposed', 'job.approved', 'session.spawn', 'session.message',
  'execution.batch', 'execution.result', 'child.result', 'synthesis.request',
  'synthesis.result', 'job.progress', 'job.completed', 'job.failed', 'provider.status'
]);

const MESSAGE_TYPE_SET = new Set(COS_AP_MESSAGE_TYPES);
const ROOT = path.dirname(new URL(import.meta.url).pathname);

function fail(message) { throw new TypeError(`COS-AP validation failed: ${message}`); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`); }
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`); }
function exactKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${field} contains unsupported field ${key}`);
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
  if (!Number.isInteger(input.attempt) || input.attempt < 1) fail('attempt must be an integer >= 1');
  requiredString(input.sender, 'sender');
  requiredString(input.recipient, 'recipient');
  if (input.correlation_id !== null && input.correlation_id !== undefined) requiredString(input.correlation_id, 'correlation_id');
  if (typeof input.created_at !== 'string' || Number.isNaN(Date.parse(input.created_at))) fail('created_at must be ISO date-time');
  object(input.payload, 'payload');
  return input;
}

export function validateExecutionBatch(payload) {
  object(payload, 'execution.batch payload');
  exactKeys(payload, ['batch_id', 'wait', 'tasks'], 'execution.batch payload');
  requiredString(payload.batch_id, 'batch_id');
  if (payload.wait !== 'all') fail('execution.batch wait must be all');
  if (!Array.isArray(payload.tasks) || payload.tasks.length < 1) fail('execution.batch tasks must be non-empty');
  const ids = new Set();
  for (const [i, task] of payload.tasks.entries()) {
    object(task, `tasks[${i}]`);
    exactKeys(task, ['id', 'task_id', 'command', 'cwd', 'timeout_ms'], `tasks[${i}]`);
    requiredString(task.id, `tasks[${i}].id`);
    requiredString(task.task_id, `tasks[${i}].task_id`);
    requiredString(task.command, `tasks[${i}].command`);
    if (ids.has(task.id)) fail(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.cwd !== undefined) requiredString(task.cwd, `tasks[${i}].cwd`);
    if (task.timeout_ms !== undefined && (!Number.isInteger(task.timeout_ms) || task.timeout_ms < 1)) fail(`tasks[${i}].timeout_ms must be positive integer`);
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
  for (const field of ['total', 'passed', 'failed']) if (!Number.isInteger(payload.summary[field]) || payload.summary[field] < 0) fail(`summary.${field} must be non-negative integer`);
  if (!Array.isArray(payload.items)) fail('items must be an array');
  for (const [i, item] of payload.items.entries()) {
    object(item, `items[${i}]`);
    exactKeys(item, ['id', 'task_id', 'command', 'status', 'exit_code', 'execution_session_id', 'stdout', 'stderr', 'error'], `items[${i}]`);
    requiredString(item.id, `items[${i}].id`);
    requiredString(item.task_id, `items[${i}].task_id`);
    requiredString(item.command, `items[${i}].command`);
    if (!['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'PENDING', 'RUNNING'].includes(item.status)) fail(`items[${i}].status invalid`);
    if (item.exit_code !== null && item.exit_code !== undefined && !Number.isInteger(item.exit_code)) fail(`items[${i}].exit_code must be integer/null`);
    for (const field of ['execution_session_id', 'stdout', 'stderr', 'error']) if (item[field] !== null && item[field] !== undefined && typeof item[field] !== 'string') fail(`items[${i}].${field} must be string/null`);
  }
  const { total, passed, failed } = payload.summary;
  if (total !== payload.items.length) fail('summary.total must equal items.length');
  if (passed + failed > total) fail('summary passed+failed exceeds total');
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
