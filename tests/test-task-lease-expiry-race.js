import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('task-lease-expiry-race-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const moduleUrl = pathToFileURL(path.resolve(fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)))).href;
const { WorkflowStore } = await import(moduleUrl);
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `lease-expiry-race-${process.pid}`, title: 'Lease expiry stale-candidate regression' });
const task = store.ensureTask(job.job_id, { role: 'executor', description: 'must remain owned after heartbeat' });
const lease = store.acquireTaskLease(task.task_id, { leaseId: `lease-race-${process.pid}`, workerId: 'worker-race', ttlMs: 10000, attempt: 1 });

// Simulate a reaper that selected an expiry candidate using a slightly future
// clock/cutoff, then pauses before taking its writer reservation. A heartbeat
// renews the lease in a second process; the stale reaper must re-check expiry
// after the renewal rather than resetting the still-owned task to pending.
const barrier = path.join(root, 'barrier');
fs.mkdirSync(barrier, { mode: 0o700 });
const childSource = `
  import fs from 'node:fs';
  const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
  const s = new WorkflowStore();
  const ready = ${JSON.stringify(path.join(barrier, 'selected'))};
  const release = ${JSON.stringify(path.join(barrier, 'release'))};
  const original = s.expireTaskLease.bind(s);
  s.expireTaskLease = (leaseId, options) => {
    fs.writeFileSync(ready, 'candidate-selected', { flag: 'wx', mode: 0o600 });
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    return original(leaseId, options);
  };
  try { console.log('REAP_COUNT:' + s.reapExpiredTaskLeases({ now: Date.now() + 15000 })); }
  finally { s.db.close(); }
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
  cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: process.env.WORKFLOW_DB, WORKFLOW_DATA_DIR: root,
    WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', value => { stdout += value; });
child.stderr.on('data', value => { stderr += value; });
const completed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
const deadline = Date.now() + 10000;
while (!fs.existsSync(path.join(barrier, 'selected'))) {
  if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`reaper did not select its stale candidate: ${stderr}`); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const heartbeat = store.heartbeatTaskLease(lease.lease_id, { workerId: 'worker-race', ttlMs: 60000 });
assert.equal(heartbeat.ok, true, 'the owner heartbeat must renew before the reaper obtains its writer lock');
fs.writeFileSync(path.join(barrier, 'release'), 'release', { flag: 'wx', mode: 0o600 });
const outcome = await completed;
assert.equal(outcome.code, 0, `${stderr}\n${stdout}`);
assert.match(stdout, /REAP_COUNT:0/);
assert.equal(store.getTaskLease(lease.lease_id).state, 'ACTIVE');
assert.ok(Date.parse(store.getTaskLease(lease.lease_id).expires_at) > Date.now());
assert.equal(store.getTask(task.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.expired' AND json_extract(payload_json,'$.leaseId')=?").get(job.job_id, lease.lease_id).n, 0);
console.log('TASK LEASE STALE-REAPER CANDIDATE VS CROSS-PROCESS HEARTBEAT PASS');

// A caller-supplied attempt is still untrusted input. Reusing an attempt after
// expiry would alias a prior execution identity and can collide with durable
// checkpoints/results. The monotonicity check must use the task row inside the
// writer transaction, not the pre-lock task snapshot.
const retryJob = store.createJob({ conversationKey: `lease-attempt-monotonic-${process.pid}`, title: 'Attempt identity monotonicity fixture' });
const retryTask = store.ensureTask(retryJob.job_id, { role: 'executor', description: 'attempt identity must remain monotonic' });
const firstAttempt = store.acquireTaskLease(retryTask.task_id, {
  leaseId: `lease-attempt-one-${process.pid}`, workerId: 'worker-attempt-one', attempt: 1
});
store.expireTaskLease(firstAttempt.lease_id, { reason: 'attempt identity regression fixture' });
assert.equal(store.getTask(retryTask.task_id).execution_attempt, 1);
assert.throws(() => store.acquireTaskLease(retryTask.task_id, {
  leaseId: `lease-attempt-reused-${process.pid}`, workerId: 'worker-attempt-reused', attempt: 1
}), /lease attempt must advance beyond task execution_attempt/,
'expired attempt numbers must never be reused for a new lease');
const secondAttempt = store.acquireTaskLease(retryTask.task_id, {
  leaseId: `lease-attempt-two-${process.pid}`, workerId: 'worker-attempt-two'
});
assert.equal(secondAttempt.attempt, 2, 'automatic retry must advance from the latest durable attempt');
assert.equal(secondAttempt.owner_epoch, firstAttempt.owner_epoch + 1, 'owner epoch must advance independently of attempt validation');
console.log('TASK LEASE ATTEMPT MONOTONICITY AFTER EXPIRY PASS');
