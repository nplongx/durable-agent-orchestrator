import crypto from 'node:crypto';
import { validateExecutionResult } from './execution-contract.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`evidence verification failed: ${field} is empty`);
}

export function verifyExecutionEvidence({ result, evidence = {} } = {}) {
  validateExecutionResult(result);
  const errors = [];

  for (const field of ['job_id', 'task_id', 'lease_id', 'provider_run_id']) {
    try { nonEmpty(result[field], field); } catch (error) { errors.push(error.message); }
  }

  const refs = new Set(result.evidence_refs || []);
  for (const ref of refs) {
    if (!(ref in evidence)) errors.push(`missing evidence ref: ${ref}`);
  }

  const payload = evidence['task-payload.json'];
  if (!payload) errors.push('task payload evidence missing');
  else {
    const expected = { job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id, attempt: result.attempt };
    for (const [key, value] of Object.entries(expected)) {
      if (payload[key] !== value) errors.push(`payload correlation mismatch: ${key}`);
    }
    if (payload.schema_version !== 1) errors.push('unsupported task payload schema');
  }

  const execution = evidence['execution.json'];
  if (!execution) errors.push('execution evidence missing');
  else {
    if (execution.exit_code !== result.exit_code) errors.push('execution exit_code mismatch');
    if (execution.timed_out !== (result.status === 'TIMED_OUT')) errors.push('execution timeout mismatch');
    if (execution.task_id !== result.task_id) errors.push('execution task_id mismatch');
  }

  if (result.status === 'SUCCEEDED') {
    if (result.exit_code !== 0 || !result.output_commit) errors.push('successful result lacks zero exit code/output commit');
    if (!String(evidence['stdout.txt'] ?? '').trim() && !String(evidence['stderr.txt'] ?? '').trim()) {
      errors.push('successful execution has no stdout or stderr evidence');
    }
    const status = String(evidence['git-status.txt'] ?? '');
    if (!('git-status.txt' in evidence)) errors.push('git status evidence missing');
    if (status.includes('\0')) errors.push('git status evidence contains NUL');
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors,
    evidence_hash: sha256(JSON.stringify(Object.keys(evidence).sort().reduce((out, key) => {
      out[key] = evidence[key];
      return out;
    }, {})))
  });
}

export function assertExecutionEvidence(input) {
  const verification = verifyExecutionEvidence(input);
  if (!verification.valid) throw new Error(`execution evidence verification failed: ${verification.errors.join('; ')}`);
  return verification;
}
