import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const root = process.cwd();
const dir = tempDir('cos-p3-worker-');
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
  owner_epoch: 5,
  role: 'executor',
  command: "node -e \"process.stdout.write('P3_OK')\"",
  required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
}, null, 2));

const evidence = path.join(dir, 'evidence');
const env = {
  ...process.env,
  JOB_ID: 'job-p3', TASK_ID: 'task-p3', LEASE_ID: 'lease-p3', ATTEMPT: '1', OWNER_EPOCH: '5',
  INPUT_COMMIT: commit, TASK_PAYLOAD_REF: payloadRef, ROLE: 'executor', PROVIDER_RUN_ID: 'local-p3', GITHUB_RUN_ATTEMPT: '1',
  EVIDENCE_DIR: evidence, WORKFLOW_DATA_DIR: path.join(dir, 'state'), WORKFLOW_DB: path.join(dir, 'state', 'worker.db')
};
try {
  const staleEvidence = path.join(dir, 'stale-epoch-evidence');
  const staleEpoch = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: repo, env: { ...env, OWNER_EPOCH: '6', EVIDENCE_DIR: staleEvidence }, encoding: 'utf8', timeout: 15000
  });
  assert.equal(staleEpoch.status, 1, 'a task payload carrying an old owner epoch must fail before execution');
  const staleResult = JSON.parse(fs.readFileSync(path.join(staleEvidence, 'result.json'), 'utf8'));
  assert.match(staleResult.error, /payload correlation mismatch: owner_epoch/);
  assert.equal(fs.existsSync(path.join(staleEvidence, 'execution.json')), false,
    'stale owner-epoch rejection must not produce execution evidence');
  execFileSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], { cwd: repo, env, stdio: 'pipe' });
} finally {
  fs.rmSync(payloadPath, { force: true });
}

const result = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
assert.equal(result.status, 'SUCCEEDED');
assert.equal(result.job_id, 'job-p3');
assert.equal(result.task_id, 'task-p3');
assert.equal(result.lease_id, 'lease-p3');
assert.equal(result.owner_epoch, 5);
assert.equal(result.input_commit, commit);
assert.equal(result.output_commit, commit);
assert.equal(result.exit_code, 0);
assert.deepEqual(result.evidence_refs, ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']);
assert.equal(fs.readFileSync(path.join(evidence, 'stdout.txt'), 'utf8'), 'P3_OK');
const workerExecution = JSON.parse(fs.readFileSync(path.join(evidence, 'execution.json'), 'utf8'));
const workerGitStatus = fs.readFileSync(path.join(evidence, 'git-status.txt'));
assert.equal(workerExecution.git_status_bytes, workerGitStatus.length);
assert.equal(workerExecution.git_status_sha256, (await import('node:crypto')).createHash('sha256').update(workerGitStatus).digest('hex'));

// A task command runs with the same OS identity as the worker. It must not be
// able to rewrite the already-approved payload evidence and still return a
// successful result. This adversarial fixture deliberately puts EVIDENCE_DIR
// inside the task workspace, matching the production workflow's trust shape.
const tamperEvidence = path.join(dir, 'evidence-tamper');
const tamperPayload = {
  schema_version: 1, job_id: 'job-p3', task_id: 'task-p3', lease_id: 'lease-p3', attempt: 1,
  owner_epoch: 5, role: 'executor',
  command: `node -e "require('node:fs').writeFileSync('${path.join(tamperEvidence, 'task-payload.json')}', 'tampered')"`,
  required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
};
const tamperRun = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
  cwd: repo,
  env: { ...env, TASK_PAYLOAD_JSON: JSON.stringify(tamperPayload), EVIDENCE_DIR: tamperEvidence },
  encoding: 'utf8', timeout: 15000
});
assert.equal(tamperRun.status, 1,
  'worker must fail closed if task code can substitute task-payload.json evidence in the shared workspace');
const tamperResult = JSON.parse(fs.readFileSync(path.join(tamperEvidence, 'result.json'), 'utf8'));
assert.notEqual(tamperResult.status, 'SUCCEEDED', 'a successful result must never accompany task-controlled payload evidence');
assert.match(tamperResult.error, /could not be written without overwriting existing files|EEXIST|already exists/i,
  'payload evidence collision after task execution must be reported as an integrity failure');
fs.rmSync(tamperEvidence, { recursive: true, force: true });
console.log('worker-protocol P3 PASS');
