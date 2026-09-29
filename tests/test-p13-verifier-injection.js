import assert from 'node:assert/strict';
import { verifyExecutionEvidence } from '../src/runtime/execution-verifier.js';

const ts = new Date().toISOString();
const base = { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 1, status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40), exit_code: 0, provider_run_id: 'r', evidence_artifact: 'artifact.zip', evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'git-status.txt'], started_at: ts, finished_at: ts };
const evidence = { 'task-payload.json': { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 1 }, 'execution.json': { task_id: 't', exit_code: 0, timed_out: false }, 'stdout.txt': 'ok', 'git-status.txt': '' };
assert.equal(verifyExecutionEvidence({ result: base, evidence }).valid, true);
evidence['task-payload.json'].lease_id = 'tampered';
assert.equal(verifyExecutionEvidence({ result: base, evidence }).valid, false);
const timeout = { ...base, status: 'TIMED_OUT', exit_code: 124, output_commit: undefined, checkpoint_commit: 'c'.repeat(40), evidence_refs: ['task-payload.json', 'execution.json', 'checkpoint.json'] };
const timeoutEvidence = { 'task-payload.json': { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 1 }, 'execution.json': { task_id: 't', exit_code: 124, timed_out: true }, 'checkpoint.json': { checkpoint_commit: 'c'.repeat(40) } };
assert.equal(verifyExecutionEvidence({ result: timeout, evidence: timeoutEvidence }).valid, true);
timeoutEvidence['checkpoint.json'].checkpoint_commit = 'd'.repeat(40);
assert.equal(verifyExecutionEvidence({ result: timeout, evidence: timeoutEvidence }).valid, false);
console.log('p13-verifier-injection P13 PASS');
