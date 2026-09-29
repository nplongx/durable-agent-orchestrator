import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-p3-worker-'));
const repo = root;
const payloadRef = path.join('.p3-test-task.json');
const payloadPath = path.join(repo, payloadRef);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
fs.writeFileSync(payloadPath, JSON.stringify({
  schema_version: 1,
  job_id: 'job-p3',
  task_id: 'task-p3',
  lease_id: 'lease-p3',
  attempt: 1,
  role: 'executor',
  command: "node -e \"process.stdout.write('P3_OK')\"",
  required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
}, null, 2));

const evidence = path.join(dir, 'evidence');
const env = {
  ...process.env,
  JOB_ID: 'job-p3', TASK_ID: 'task-p3', LEASE_ID: 'lease-p3', ATTEMPT: '1',
  INPUT_COMMIT: commit, TASK_PAYLOAD_REF: payloadRef, ROLE: 'executor', PROVIDER_RUN_ID: 'local-p3',
  EVIDENCE_DIR: evidence, WORKFLOW_DATA_DIR: path.join(dir, 'state'), WORKFLOW_DB: path.join(dir, 'state', 'worker.db')
};
try {
  execFileSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], { cwd: repo, env, stdio: 'pipe' });
} finally {
  fs.rmSync(payloadPath, { force: true });
}

const result = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
assert.equal(result.status, 'SUCCEEDED');
assert.equal(result.job_id, 'job-p3');
assert.equal(result.task_id, 'task-p3');
assert.equal(result.lease_id, 'lease-p3');
assert.equal(result.input_commit, commit);
assert.equal(result.output_commit, commit);
assert.equal(result.exit_code, 0);
assert.deepEqual(result.evidence_refs, ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']);
assert.equal(fs.readFileSync(path.join(evidence, 'stdout.txt'), 'utf8'), 'P3_OK');
console.log('worker-protocol P3 PASS');
