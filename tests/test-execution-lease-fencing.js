import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-lease-fencing-');
let store = null;
// The test pins a local Node executable (~126 MiB) into its disposable runtime.
// Clean only this test's private temp root on normal exit or assertion failure.
process.once('exit', () => {
  try { store?.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
const dataDir = path.join(root, 'data');
const barrierDir = path.join(root, 'finish-barrier');
const executionTmpDir = path.join(dataDir, 'runtime');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(barrierDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';

const jobStorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/job-store.js');
const executionManagerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/execution-manager.js');
const { WorkflowStore } = await import(pathToFileURL(jobStorePath));
store = new WorkflowStore();
const job = store.createJob({ conversationKey: `lease-fence-${process.pid}`, title: 'Completion lease fence regression' });
const task = store.ensureTask(job.job_id, { role: 'executor', description: 'must not commit after lease expiry' });
assert.throws(() => store.acquireTaskLease(task.task_id, {
  leaseId: `lease-fence-coerced-attempt-${process.pid}`, workerId: `worker-fence-${process.pid}`, attempt: '1'
}), /attempt must be a positive safe integer/,
'attempt identity must not be silently coerced from a string');
assert.throws(() => store.acquireTaskLease(task.task_id, {
  leaseId: `lease-fence-coerced-ttl-${process.pid}`, workerId: `worker-fence-${process.pid}`, ttlMs: '60000'
}), /ttlMs must be a positive safe integer/,
'lease TTL must not be silently coerced from a string');
assert.equal(store.getTask(task.task_id).status, 'pending', 'rejected lease inputs must not mutate task state');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE task_id=?').get(task.task_id).n, 0,
  'rejected lease inputs must not create durable lease rows');
store.db.prepare('UPDATE tasks SET execution_attempt=? WHERE task_id=?').run('malformed-attempt', task.task_id);
assert.throws(() => store.acquireTaskLease(task.task_id, {
  leaseId: `lease-fence-malformed-stored-attempt-${process.pid}`, workerId: `worker-fence-${process.pid}`
}), /malformed durable task execution_attempt/,
'malformed persisted attempt identity must fail closed before lease or state mutation');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE task_id=?').get(task.task_id).n, 0);
assert.equal(store.getTask(task.task_id).status, 'pending');
store.db.prepare('UPDATE tasks SET execution_attempt=0 WHERE task_id=?').run(task.task_id);
const acquireRollbackJob = store.createJob({ conversationKey: `lease-acquire-rollback-${process.pid}`, title: 'Lease acquisition event rollback' });
const acquireRollbackTask = store.ensureTask(acquireRollbackJob.job_id, { role: 'executor', description: 'lease acquisition must be row/event atomic' });
store.db.exec(`CREATE TRIGGER fail_task_lease_acquired_event BEFORE INSERT ON events
  WHEN NEW.type='task.lease.acquired'
  BEGIN SELECT RAISE(ABORT, 'injected task lease acquisition event failure'); END`);
try {
  assert.throws(() => store.acquireTaskLease(acquireRollbackTask.task_id, {
    leaseId: `lease-acquire-rollback-${process.pid}`, workerId: 'lease-acquire-rollback-worker'
  }), /injected task lease acquisition event failure/);
  assert.equal(store.getTask(acquireRollbackTask.task_id).status, 'pending');
  assert.equal(store.getTask(acquireRollbackTask.task_id).execution_attempt, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE task_id=?').get(acquireRollbackTask.task_id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.acquired'").get(acquireRollbackJob.job_id).n, 0);
} finally {
  store.db.exec('DROP TRIGGER IF EXISTS fail_task_lease_acquired_event');
}
const lease = store.acquireTaskLease(task.task_id, {
  leaseId: `lease-fence-${process.pid}`, workerId: `worker-fence-${process.pid}`, ttlMs: 60_000, attempt: 1
});
assert.throws(() => store.heartbeatTaskLease(lease.lease_id, { workerId: lease.worker_id, ttlMs: '60000' }),
  /ttlMs must be a positive safe integer/, 'heartbeat TTL must not be silently coerced from a string');
assert.throws(() => store.completeTaskLease(lease.lease_id, { workerId: lease.worker_id, success: 'false' }),
  /success must be a boolean/, 'string "false" must not be truthily coerced into successful lease completion');
assert.equal(store.getTaskLease(lease.lease_id).state, 'ACTIVE', 'rejected completion inputs must preserve the active lease');
assert.throws(() => store.expireTaskLease(lease.lease_id, { reason: { invalid: true } }),
  /expiry reason must be a non-empty string/, 'malformed expiry reason must be rejected before durable state changes');
assert.throws(() => store.reapExpiredTaskLeases({ now: '9999999999999' }),
  /non-negative safe integer timestamp/, 'reaper clock must not be coerced from a string');
assert.equal(store.getTaskLease(lease.lease_id).state, 'ACTIVE', 'rejected reaper input must not mutate lease state');
const executionLease = {
  leaseId: lease.lease_id, workerId: lease.worker_id,
  ownerEpoch: Number(lease.owner_epoch), attempt: Number(lease.attempt)
};

// Run the real ExecutionManager in another process. The test-only barrier pauses
// finishExecution after process completion but before its SQLite writer lock,
// letting this process expire the lease at the exact race boundary.
const childSource = `
  import { pathToFileURL } from 'node:url';
  const { WorkflowStore } = await import(${JSON.stringify(pathToFileURL(jobStorePath).href)});
  const { ExecutionManager } = await import(${JSON.stringify(pathToFileURL(executionManagerPath).href)});
  const store = new WorkflowStore();
  const manager = new ExecutionManager(store, { timeoutMs: 5000, executionTmpDir: ${JSON.stringify(executionTmpDir)} });
  try {
    const result = await manager.executeTask(${JSON.stringify(task.task_id)}, {
      command: ${JSON.stringify("node -e \"process.stdout.write('STALE_LEASE_OUTPUT')\"")},
      timeoutMs: 5000, cwd: ${JSON.stringify(root)}, executionLease: ${JSON.stringify(executionLease)}
    });
    console.log('UNEXPECTED_SUCCESS:' + JSON.stringify(result));
    process.exitCode = 3;
  } catch (error) {
    console.log('STALE_COMPLETION_REJECTED:' + String(error?.message || error));
  } finally { store.db.close(); }
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  env: {
    ...process.env,
    WORKFLOW_DATA_DIR: dataDir,
    WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
    WORKFLOW_WORKSPACE: root,
    EXECUTION_TMP_DIR: executionTmpDir,
    CHAT_ON_STEROIDS_TEST_FINISH_EXECUTION_BARRIER_DIR: barrierDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', value => { stdout += value; });
child.stderr.on('data', value => { stderr += value; });
const completed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
const readyPath = path.join(barrierDir, `${child.pid}.ready`);
const deadline = Date.now() + 20_000;
while (!fs.existsSync(readyPath)) {
  if (Date.now() >= deadline) {
    child.kill('SIGKILL');
    throw new Error(`execution did not reach the pre-commit barrier: ${stderr}\n${stdout}`);
  }
  // Yield the parent event loop while waiting. A synchronous Atomics.wait here
  // prevents stdout/stderr and child-close events from being delivered; when
  // the child exits before publishing the barrier, the test then waits the full
  // timeout and reports empty diagnostics instead of the real startup failure.
  if (child.exitCode !== null || child.signalCode !== null) {
    const exit = await completed;
    throw new Error(`execution child exited before the pre-commit barrier (code=${exit.code}, signal=${exit.signal}): ${stderr}\n${stdout}`);
  }
  await new Promise(resolve => setTimeout(resolve, 5));
}

const expired = store.expireTaskLease(lease.lease_id, { reason: 'adversarial expiry before completion writer reservation' });
assert.equal(expired.state, 'EXPIRED', 'the second process must durably expire the exact active lease');
fs.writeFileSync(path.join(barrierDir, 'release'), 'continue', { flag: 'wx', mode: 0o600 });
const exit = await completed;
assert.equal(exit.code, 0, `child must report the rejected stale completion: ${stderr}\n${stdout}`);
assert.match(stdout, /STALE_COMPLETION_REJECTED:execution lease lost before completion persistence/,
  'a completed OS process must not publish a result after its lease was expired by another process');
assert.doesNotMatch(stdout, /UNEXPECTED_SUCCESS:/);

const finalTask = store.getTask(task.task_id);
assert.equal(finalTask.status, 'failed', 'the exact in-flight attempt must terminalize as failure instead of remaining stuck pending/running');
assert.equal(finalTask.execution_status, 'failed');
assert.equal(store.getTaskLease(lease.lease_id).state, 'EXPIRED');
assert.equal(finalTask.execution_exit_code, null);
assert.equal(finalTask.execution_stdout, '', 'stale stdout must be discarded rather than persisted as accepted output');
assert.match(finalTask.execution_stderr, /lease lost.*stale process output discarded/);
const durableResults = store.db.prepare('SELECT result_id,outcome,content FROM results WHERE task_id=?').all(task.task_id);
assert.equal(durableResults.length, 1, 'the exact attempt must persist one explicit failure record so it is not stranded in EXECUTING');
assert.equal(durableResults[0].outcome, 'failure');
assert.match(durableResults[0].content, /lease lost.*stale process output discarded/);
assert.doesNotMatch(durableResults[0].content, /stdout:\nSTALE_LEASE_OUTPUT/,
  'output from a process whose lease was lost must not enter accepted durable evidence');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=?").get(job.job_id, task.task_id).n, 0,
  'no execution.completed event may be emitted by the stale owner');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.failed' AND json_extract(payload_json,'$.taskId')=?").get(job.job_id, task.task_id).n, 1,
  'the stale execution must close as one failure event, not a success event or an open attempt');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(task.task_id).n, 0,
  'lease-loss terminalization must settle the exact attempt and unblock safe monotonic retry');
const retryLease = store.acquireTaskLease(task.task_id, {
  leaseId: `lease-fence-retry-${process.pid}`, workerId: `worker-fence-retry-${process.pid}`, ttlMs: 60_000
});
assert.equal(retryLease.attempt, 2, 'a retry after quarantining stale output must use a new monotonic attempt');
assert.ok(retryLease.owner_epoch > lease.owner_epoch, 'a retry must advance the independent owner epoch');

// A task can remain pending in old or partially recovered databases after its
// parent job becomes terminal. A stale scheduler must not turn that row into a
// fresh executable lease merely because the task itself is not terminal yet.
for (const terminal of [
  { state: 'COMPLETED', status: 'completed' },
  { state: 'FAILED', status: 'failed' },
  { state: 'CANCELLED', status: 'cancelled' }
]) {
  const terminalJob = store.createJob({
    conversationKey: `terminal-parent-lease-${terminal.status}-${process.pid}`,
    title: `Reject lease for ${terminal.status} parent job`
  });
  const terminalTask = store.ensureTask(terminalJob.job_id, {
    role: 'executor', description: 'must not be scheduled after parent terminalization'
  });
  store.transition(terminalJob.job_id, terminal.state, terminal.status);
  assert.throws(() => store.acquireTaskLease(terminalTask.task_id, {
    leaseId: `forbidden-terminal-parent-${terminal.status}-${process.pid}`,
    workerId: 'stale-scheduler', ttlMs: 60_000
  }), /cannot lease task in terminal or missing job/,
  `a ${terminal.status} parent job must fence stale task lease acquisition`);
  assert.equal(store.getTask(terminalTask.task_id).status, 'pending',
    'rejected lease acquisition must not mutate the historical pending task');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE task_id=?').get(terminalTask.task_id).n, 0,
    'rejected terminal-parent lease must not create a durable lease row');
}
// A lease acquired before terminalization must not be renewed or completed as
// success by a late worker, and expiry must not reset the task to pending under
// a terminal parent Job.
{
  const lateJob = store.createJob({ conversationKey: `late-terminal-lease-${process.pid}`, title: 'Late lease callback after parent terminalization' });
  const lateTask = store.ensureTask(lateJob.job_id, { role: 'executor', description: 'must not be reopened by lease expiry' });
  const lateLease = store.acquireTaskLease(lateTask.task_id, {
    leaseId: `late-terminal-lease-${process.pid}`, workerId: 'late-worker', ttlMs: 60_000
  });
  store.db.prepare("UPDATE jobs SET state='FAILED', status='failed' WHERE job_id=?").run(lateJob.job_id);
  assert.deepEqual(store.heartbeatTaskLease(lateLease.lease_id, { workerId: lateLease.worker_id }),
    { ok: false, reason: 'parent_job_terminal' });
  assert.deepEqual(store.completeTaskLease(lateLease.lease_id, { workerId: lateLease.worker_id, success: true }),
    { ok: false, reason: 'parent_job_terminal' });
  assert.equal(store.getTaskLease(lateLease.lease_id).state, 'ACTIVE');
  store.expireTaskLease(lateLease.lease_id, { reason: 'terminal parent stale lease reconciliation' });
  assert.equal(store.getTaskLease(lateLease.lease_id).state, 'EXPIRED');
  assert.equal(store.getTask(lateTask.task_id).status, 'failed',
    'expired lease must settle the exact attempt as failed rather than reopen a pending task under a terminal parent');
}
// Corrupt historical owner_epoch values must not be coerced by SQLite arithmetic
// into a reused epoch. Rejection must happen under the lease writer reservation
// before any new lease row or task transition is persisted.
{
  const corruptJob = store.createJob({ conversationKey: `lease-corrupt-epoch-${process.pid}`, title: 'Corrupt owner epoch fence' });
  const corruptTask = store.ensureTask(corruptJob.job_id, { role: 'executor', description: 'reject corrupt historical owner epoch' });
  const timestamp = new Date().toISOString();
  store.db.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,issued_at,heartbeat_at,expires_at)
    VALUES(?,?,?,?,?,?,'EXPIRED',?,?,?)`).run(
    `lease-corrupt-epoch-${process.pid}`, corruptTask.task_id, corruptJob.job_id, 1, 'historical-worker', 'corrupt-epoch', timestamp, timestamp, timestamp
  );
  assert.throws(() => store.acquireTaskLease(corruptTask.task_id, {
    leaseId: `lease-after-corrupt-epoch-${process.pid}`, workerId: 'new-worker'
  }), /malformed durable task lease owner_epoch ledger/);
  assert.equal(store.getTask(corruptTask.task_id).status, 'pending');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_leases WHERE task_id=?').get(corruptTask.task_id).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.acquired'").get(corruptJob.job_id).n, 0);
}
// A malformed persisted expiry timestamp must not make an ACTIVE lease invisible
// to the reaper or cause it to be recycled as definitely unsent.
{
  const corruptExpiryJob = store.createJob({ conversationKey: `lease-corrupt-expiry-${process.pid}`, title: 'Corrupt lease expiry fence' });
  const corruptExpiryTask = store.ensureTask(corruptExpiryJob.job_id, { role: 'executor', description: 'reject malformed lease expiry' });
  const corruptExpiryLease = store.acquireTaskLease(corruptExpiryTask.task_id, {
    leaseId: `lease-corrupt-expiry-${process.pid}`, workerId: 'worker-corrupt-expiry', ttlMs: 60_000
  });
  store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run('not-a-valid-timestamp', corruptExpiryLease.lease_id);
  assert.equal(store.reapExpiredTaskLeases({ jobId: corruptExpiryJob.job_id }), 1,
    'the lease reaper must discover malformed active expiry values');
  assert.equal(store.getTaskLease(corruptExpiryLease.lease_id).state, 'FAILED',
    'a lease with malformed expiry must be quarantined, not treated as definitely unsent');
  assert.equal(store.getTask(corruptExpiryTask.task_id).status, 'failed');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.dispatchState')='MALFORMED_LEASE_EXPIRY'")
    .get(corruptExpiryJob.job_id).n, 1);
  assert.equal(store.listRunnableTasks({ jobId: corruptExpiryJob.job_id }).some(row => row.task_id === corruptExpiryTask.task_id), false);
  assert.equal(store.expireTaskLease(corruptExpiryLease.lease_id, { reason: 'duplicate corrupt expiry reaping' }), null,
    'a quarantined malformed expiry must remain idempotent');
  console.log('MALFORMED DURABLE LEASE EXPIRY / REAPER FAIL-CLOSED QUARANTINE PASS');
}
// Multiple provider-run rows mapped to one lease are not resolved by picking
// the newest timestamp: that could hide a duplicate remote dispatch. Expiry
// must quarantine the ambiguous lease and preserve no-replay semantics.
{
  const ambiguousProviderJob = store.createJob({ conversationKey: `lease-provider-cardinality-${process.pid}`, title: 'Ambiguous provider-run mapping' });
  const ambiguousProviderTask = store.ensureTask(ambiguousProviderJob.job_id, { role: 'executor', description: 'duplicate provider runs must quarantine' });
  const ambiguousProviderLease = store.acquireTaskLease(ambiguousProviderTask.task_id, {
    leaseId: `lease-provider-cardinality-${process.pid}`, workerId: 'provider-cardinality-worker', ttlMs: 60_000
  });
  store.db.exec(`CREATE TABLE provider_runs (
    provider_run_id TEXT PRIMARY KEY, provider TEXT NOT NULL, job_id TEXT NOT NULL, task_id TEXT NOT NULL,
    lease_id TEXT NOT NULL, attempt INTEGER NOT NULL, owner_epoch INTEGER, state TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const ts = new Date().toISOString();
  for (const runId of ['provider-run-cardinality-a', 'provider-run-cardinality-b']) {
    store.db.prepare(`INSERT INTO provider_runs(provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'IN_PROGRESS',?,?)`).run(
        runId, 'github-actions', ambiguousProviderJob.job_id, ambiguousProviderTask.task_id,
        ambiguousProviderLease.lease_id, ambiguousProviderLease.attempt, ambiguousProviderLease.owner_epoch, ts, ts
      );
  }
  const quarantined = store.expireTaskLease(ambiguousProviderLease.lease_id, { reason: 'ambiguous provider run mapping' });
  assert.equal(quarantined?.state, 'FAILED');
  const quarantine = store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?")
    .get(ambiguousProviderJob.job_id, ambiguousProviderLease.lease_id);
  assert.equal(JSON.parse(quarantine.payload_json).dispatchState, 'AMBIGUOUS_PROVIDER_RUN_CARDINALITY');
  assert.equal(store.getTask(ambiguousProviderTask.task_id).status, 'failed');
  assert.equal(store.listRunnableTasks({ jobId: ambiguousProviderJob.job_id }).some(row => row.task_id === ambiguousProviderTask.task_id), false);
}
console.log('TERMINAL PARENT JOB VS STALE SCHEDULER LEASE ACQUISITION FENCE: PASS');
console.log('CROSS-PROCESS EXECUTION LEASE EXPIRY VS COMPLETION COMMIT FENCE: PASS');
store.db.close();
