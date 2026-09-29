import assert from 'node:assert/strict';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';

const calls = [];
const provider = { dispatch: async request => {
  calls.push(request);
  return { provider_run_id: `run-${request.task_id}`, state: 'QUEUED' };
} };

const store = {
  db: { __p6Fake: true, prepare(sql) {
    if (/COUNT\(\*\)/.test(sql)) return { get: () => ({ n: 0 }) };
    return { run() {} };
  } },
  leases: [],
  acquireTaskLease(taskId, opts) {
    const lease = { lease_id: opts.leaseId, task_id: taskId, attempt: 1, state: 'ACTIVE' };
    this.leases.push(lease); return lease;
  },
  listRunnableTasks() { return [
    { task_id: 'task-a', job_id: 'job', role: 'executor', payload_ref: '.worker/a.json' },
    { task_id: 'task-b', job_id: 'job', role: 'executor', payload_ref: '.worker/b.json' }
  ]; },
  recordEvent() {},
  expireTaskLease() {}
};

const scheduler = new DistributedScheduler({ store, provider, maxParallel: 2, workerId: 'scheduler-test' });
const results = await scheduler.dispatchPending({ inputCommit: 'a'.repeat(40) });
assert.equal(results.length, 2);
assert.equal(results.every(r => r.status === 'fulfilled'), true, JSON.stringify(results, (_, v) => v instanceof Error ? v.message : v));
assert.equal(calls.length, 2);
assert.deepEqual(calls.map(x => x.task_id).sort(), ['task-a', 'task-b']);
assert.notEqual(calls[0].lease_id, calls[1].lease_id);
assert.equal(calls[0].input_commit, 'a'.repeat(40));
console.log('distributed-scheduler P6 PASS');
