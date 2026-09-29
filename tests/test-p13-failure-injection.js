import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyExecutionEvidence } from '../src/runtime/execution-verifier.js';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';
import { summarizeObservability } from '../src/runtime/observability.js';
import { tempDir } from './test-temp-dir.js';

const requested = process.argv.slice(2);
if (!process.env.P13_CHILD) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, ...requested], { env: { ...process.env, P13_CHILD: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', x => { out += x; });
  const code = await new Promise(resolve => child.on('close', resolve));
  process.stdout.write(out); process.exit(code);
}

const dataDir = tempDir('p13-failure-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();

const results = [];
const run = async (name, fn) => {
  try { await fn(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
};

function makeTask(label) {
  const job = store.createJob({ conversationKey: `p13-${label}`, title: label });
  const task = store.ensureTask(job.job_id, { role: 'executor', description: label });
  return { job, task };
}

if (requested.includes('stale-lease')) await run('stale-lease', () => {
  const { job, task } = makeTask('stale');
  const lease = store.acquireTaskLease(task.task_id, { leaseId: 'p13-stale-a', workerId: 'a', ttlMs: 1000, attempt: 1 });
  store.db.prepare("UPDATE task_leases SET expires_at=? WHERE lease_id=?").run(new Date(Date.now() - 1000).toISOString(), lease.lease_id);
  assert.equal(store.reapExpiredTaskLeases({ jobId: job.job_id }), 1);
  assert.equal(store.getTaskLease(lease.lease_id).state, 'EXPIRED');
  assert.equal(store.getTask(task.task_id).status, 'pending');
  const next = store.acquireTaskLease(task.task_id, { leaseId: 'p13-stale-b', workerId: 'b', attempt: 2 });
  assert.equal(next.attempt, 2);
});

if (requested.includes('duplicate-result')) await run('duplicate-result', () => {
  const { job, task } = makeTask('duplicate');
  const lease = store.acquireTaskLease(task.task_id, { leaseId: 'p13-dup', workerId: 'a', attempt: 1 });
  const base = { schema_version: 1, job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id, attempt: 1, status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40), exit_code: 0, provider_run_id: 'p13-dup-run', evidence_artifact: 'artifact', evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'], started_at: new Date().toISOString(), finished_at: new Date().toISOString() };
  const evidence = { 'task-payload.json': { schema_version: 1, job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id, attempt: 1 }, 'execution.json': { task_id: task.task_id, exit_code: 0, timed_out: false }, 'stdout.txt': 'ok', 'stderr.txt': '', 'git-status.txt': '' };
  assert.equal(verifyExecutionEvidence({ result: base, evidence }).valid, true);
  assert.equal(store.applyVerifiedExecutionResult(base).status, 'VERIFIED');
  assert.equal(store.applyVerifiedExecutionResult(base).status, 'REJECTED');
});

if (requested.includes('provider-failure')) await run('provider-failure', async () => {
  const { job, task } = makeTask('provider-failure');
  const store2 = {
    ...store,
    db: store.db,
    acquireTaskLease: (...args) => store.acquireTaskLease(...args),
    expireTaskLease: (...args) => store.expireTaskLease(...args),
    recordEvent: (...args) => store.recordEvent(...args),
    listRunnableTasks: (...args) => store.listRunnableTasks(...args)
  };
  const provider = { dispatch: async () => { throw new Error('injected provider outage'); } };
  const scheduler = new DistributedScheduler({ store: store2, provider, maxParallel: 1, workerId: 'p13' });
  await assert.rejects(() => scheduler.dispatchTask(task, { inputCommit: 'a'.repeat(40), role: 'executor', requiredEvidence: ['execution.json'] }), /injected provider outage/);
  assert.equal(store.getTaskLease(store.db.prepare('SELECT lease_id FROM task_leases WHERE task_id=? ORDER BY issued_at DESC LIMIT 1').get(task.task_id).lease_id).state, 'EXPIRED');
});

if (requested.includes('corrupt-evidence')) await run('corrupt-evidence', () => {
  const ts = new Date().toISOString();
  const result = { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 1, status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40), exit_code: 0, provider_run_id: 'r', evidence_artifact: 'artifact.zip', evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'git-status.txt'], started_at: ts, finished_at: ts };
  const evidence = { 'task-payload.json': { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'WRONG', attempt: 1 }, 'execution.json': { task_id: 't', exit_code: 0, timed_out: false }, 'stdout.txt': 'ok', 'git-status.txt': '' };
  const verification = verifyExecutionEvidence({ result, evidence });
  assert.equal(verification.valid, false);
  assert.ok(verification.errors.some(x => x.includes('payload correlation mismatch')));
});

if (requested.includes('checkpoint-timeout')) await run('checkpoint-timeout', () => {
  const ts = new Date().toISOString();
  const result = { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 2, status: 'TIMED_OUT', input_commit: 'a'.repeat(40), exit_code: 124, provider_run_id: 'r', evidence_artifact: 'artifact.zip', checkpoint_commit: 'c'.repeat(40), checkpoint_ref: 'p9-checkpoint/t/r', evidence_refs: ['task-payload.json', 'execution.json', 'checkpoint.json'], started_at: ts, finished_at: ts };
  const evidence = { 'task-payload.json': { schema_version: 1, job_id: 'j', task_id: 't', lease_id: 'l', attempt: 2 }, 'execution.json': { task_id: 't', exit_code: 124, timed_out: true }, 'checkpoint.json': { checkpoint_commit: 'c'.repeat(40) } };
  assert.equal(verifyExecutionEvidence({ result, evidence }).valid, true);
  evidence['checkpoint.json'].checkpoint_commit = 'd'.repeat(40);
  assert.equal(verifyExecutionEvidence({ result, evidence }).valid, false);
});

const failed = results.filter(x => x.status === 'FAIL').length;
console.log(JSON.stringify({ passed: results.filter(x => x.status === 'PASS').length, failed, results, observability: summarizeObservability({ events: [] }) }));
if (failed) process.exitCode = 1;
