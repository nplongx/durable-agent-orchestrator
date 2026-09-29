import assert from 'node:assert/strict';
import { verifyExecutionEvidence } from '../src/runtime/execution-verifier.js';

const result = {
  schema_version: 1,
  job_id: 'job-p4', task_id: 'task-p4', lease_id: 'lease-p4', attempt: 1,
  status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40),
  exit_code: 0, provider_run_id: '123', evidence_artifact: 'p3-worker-123',
  evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
  started_at: '2026-09-29T00:00:00.000Z', finished_at: '2026-09-29T00:00:01.000Z', error: null
};
const evidence = {
  'task-payload.json': { schema_version: 1, job_id: 'job-p4', task_id: 'task-p4', lease_id: 'lease-p4', attempt: 1 },
  'execution.json': { task_id: 'task-p4', exit_code: 0, timed_out: false },
  'stdout.txt': 'P4_OK\n', 'stderr.txt': '', 'git-status.txt': ''
};

const good = verifyExecutionEvidence({ result, evidence });
assert.equal(good.valid, true);
assert.equal(good.errors.length, 0);
assert.equal(good.evidence_hash.length, 64);

const tampered = verifyExecutionEvidence({ result, evidence: { ...evidence, 'execution.json': { ...evidence['execution.json'], exit_code: 7 } } });
assert.equal(tampered.valid, false);
assert.match(tampered.errors.join('; '), /exit_code mismatch/);

const wrongLease = verifyExecutionEvidence({ result, evidence: { ...evidence, 'task-payload.json': { ...evidence['task-payload.json'], lease_id: 'other' } } });
assert.equal(wrongLease.valid, false);
assert.match(wrongLease.errors.join('; '), /lease_id/);
console.log('execution-verifier P4 PASS');
