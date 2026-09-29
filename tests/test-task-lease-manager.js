import assert from 'node:assert/strict';
import path from 'node:path';
import { TaskLeaseManager } from '../src/runtime/task-lease-manager.js';
import { tempDir } from './test-temp-dir.js';

const dataDir = tempDir('p5-lease-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'p5-test', title: 'P5' });
const task = store.ensureTask(job.job_id, { role: 'executor', description: 'p5 lease' });

const a = new TaskLeaseManager(store, { workerId: 'worker-a', ttlMs: 5000 });
const lease = a.acquire(task.task_id);
assert.equal(lease.state, 'ACTIVE');
assert.equal(lease.attempt, 1);
assert.equal(a.heartbeat(lease.lease_id).ok, true);

const b = new TaskLeaseManager(store, { workerId: 'worker-b', ttlMs: 5000 });
assert.equal(b.heartbeat(lease.lease_id).ok, false);
assert.equal(b.complete(lease.lease_id).reason, 'worker_fenced');
assert.throws(() => b.acquire(task.task_id), /already leased/);
assert.equal(a.complete(lease.lease_id, { success: false, error: 'simulated worker loss' }).ok, true);

const expired = new TaskLeaseManager(store, { workerId: 'worker-a', ttlMs: 5000 });
const old = expired.acquire(task.task_id, { attempt: 2 });
// The active lease still exists, so force its expiry through the durable store.
store.db.prepare("UPDATE task_leases SET expires_at=? WHERE lease_id=?").run(new Date(Date.now() - 1000).toISOString(), old.lease_id);
assert.equal(store.reapExpiredTaskLeases(), 1);
assert.equal(store.getTaskLease(old.lease_id).state, 'EXPIRED');
assert.equal(store.getTask(task.task_id).status, 'pending');

const next = b.acquire(task.task_id, { attempt: 2 });
assert.equal(next.state, 'ACTIVE');
assert.equal(next.attempt, 2);
assert.equal(b.complete(next.lease_id, { success: true }).ok, true);
assert.equal(store.getTaskLease(next.lease_id).state, 'COMPLETED');
console.log('task-lease-manager P5 PASS');
