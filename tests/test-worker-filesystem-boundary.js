import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = path.resolve(fileURLToPath(new URL('../scripts/run-worker-task.js', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-filesystem-boundary-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspace, { mode: 0o700 });
fs.mkdirSync(outside, { mode: 0o700 });

function runWorker({ evidenceDir, payloadRef = 'payload.json', payloadJson = undefined }) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    JOB_ID: 'job-filesystem-boundary', TASK_ID: 'task-filesystem-boundary',
    LEASE_ID: 'lease-filesystem-boundary', ATTEMPT: '1', OWNER_EPOCH: '1',
    INPUT_COMMIT: fs.readFileSync(path.join(workspace, '.fixture-head'), 'utf8').trim(), GITHUB_RUN_ATTEMPT: '1',
    ROLE: 'engineer', PROVIDER_RUN_ID: 'local-filesystem-boundary-fixture',
    EVIDENCE_DIR: evidenceDir, TASK_PAYLOAD_REF: payloadRef,
    WORKFLOW_DATA_DIR: path.join(root, 'state'), WORKFLOW_DB: path.join(root, 'state', 'workflow.db'),
    WORKFLOW_WORKSPACE: workspace,
  };
  if (payloadJson !== undefined) env.TASK_PAYLOAD_JSON = payloadJson;
  else delete env.TASK_PAYLOAD_JSON;
  return spawnSync(process.execPath, [worker], { cwd: workspace, env, encoding: 'utf8', timeout: 15000 });
}

try {
  const init = spawnSync('git', ['init', '-q'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [key, value] of [['user.name', 'Phase 2 local fixture'], ['user.email', 'phase2-fixture@example.invalid']]) {
    const configured = spawnSync('git', ['config', key, value], { cwd: workspace, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
  }
  fs.writeFileSync(path.join(workspace, '.fixture'), 'local fixture\n', { flag: 'wx', mode: 0o600 });
  assert.equal(spawnSync('git', ['add', '.fixture'], { cwd: workspace }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'local fixture'], { cwd: workspace, env: {
    ...process.env, GIT_AUTHOR_NAME: 'Phase 2 local fixture', GIT_AUTHOR_EMAIL: 'phase2-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Phase 2 local fixture', GIT_COMMITTER_EMAIL: 'phase2-fixture@example.invalid'
  } }).status, 0);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  fs.writeFileSync(path.join(workspace, '.fixture-head'), `${head.stdout.trim()}\n`, { flag: 'wx', mode: 0o600 });

  fs.writeFileSync(path.join(outside, 'payload.json'), JSON.stringify({
    schema_version: 1, job_id: 'job-filesystem-boundary', task_id: 'task-filesystem-boundary',
    required_evidence: ['task-payload.json', 'execution.json'], command: 'true'
  }), { flag: 'wx', mode: 0o600 });
  fs.symlinkSync(path.join(outside, 'payload.json'), path.join(workspace, 'payload.json'));
  const symlinkPayloadEvidence = path.join(workspace, 'evidence-payload');
  const symlinkPayload = runWorker({ evidenceDir: symlinkPayloadEvidence });
  assert.equal(symlinkPayload.status, 1, `symlink payload must fail closed: ${symlinkPayload.stderr}`);
  const payloadFailure = JSON.parse(fs.readFileSync(path.join(symlinkPayloadEvidence, 'result.json'), 'utf8'));
  assert.equal(payloadFailure.status, 'FAILED');
  assert.match(payloadFailure.error, /ELOOP|symbolic link|too many levels/i);
  assert.equal(fs.existsSync(path.join(symlinkPayloadEvidence, 'task-payload.json')), false,
    'symlinked payload must not be recorded as accepted task evidence');
  assert.equal(fs.existsSync(path.join(symlinkPayloadEvidence, 'execution.json')), false,
    'symlinked payload must fail before execution');

  const symlinkEvidenceTarget = path.join(outside, 'redirected-evidence');
  fs.mkdirSync(symlinkEvidenceTarget, { mode: 0o700 });
  const symlinkEvidence = path.join(workspace, 'evidence-link');
  fs.symlinkSync(symlinkEvidenceTarget, symlinkEvidence, 'dir');
  const evidenceRedirect = runWorker({ evidenceDir: symlinkEvidence, payloadJson: JSON.stringify({
    schema_version: 1, job_id: 'job-filesystem-boundary', task_id: 'task-filesystem-boundary',
    required_evidence: ['task-payload.json', 'execution.json'], command: 'true'
  }) });
  assert.notEqual(evidenceRedirect.status, 0, 'symlinked evidence destination must be rejected before execution');
  assert.deepEqual(fs.readdirSync(symlinkEvidenceTarget), [], 'symlinked evidence destination must not receive files');

  const collisionEvidence = path.join(workspace, 'evidence-collision');
  fs.mkdirSync(collisionEvidence, { mode: 0o700 });
  const sentinel = path.join(collisionEvidence, 'task-payload.json');
  fs.writeFileSync(sentinel, 'preserve-existing-evidence\n', { flag: 'wx', mode: 0o600 });
  const collision = runWorker({ evidenceDir: collisionEvidence, payloadJson: JSON.stringify({
    schema_version: 1, job_id: 'job-filesystem-boundary', task_id: 'task-filesystem-boundary',
    required_evidence: ['task-payload.json', 'execution.json'], command: 'true'
  }) });
  assert.equal(collision.status, 1, `existing evidence file collision must fail closed: ${collision.stderr}`);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve-existing-evidence\n', 'worker must never overwrite an existing evidence file');
  assert.equal(fs.existsSync(path.join(collisionEvidence, 'execution.json')), false, 'collision must prevent task execution');

  const drivePathEvidence = path.join(workspace, 'evidence-drive-path');
  const drivePath = runWorker({ evidenceDir: drivePathEvidence, payloadJson: JSON.stringify({
    schema_version: 1, job_id: 'job-filesystem-boundary', task_id: 'task-filesystem-boundary',
    required_evidence: ['task-payload.json', 'C:/outside.json'], command: 'true'
  }) });
  assert.equal(drivePath.status, 1, `Windows drive-path evidence reference must fail before execution: ${drivePath.stderr}`);
  const drivePathResult = JSON.parse(fs.readFileSync(path.join(drivePathEvidence, 'result.json'), 'utf8'));
  assert.equal(drivePathResult.status, 'FAILED');
  assert.match(drivePathResult.error, /invalid evidence ref/);
  assert.equal(fs.existsSync(path.join(drivePathEvidence, 'execution.json')), false,
    'a drive-path evidence reference must be rejected before task execution or success evidence writes');

  console.log('WORKER FILESYSTEM BOUNDARY: symlink payload/evidence rejection and no-overwrite evidence writes PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
