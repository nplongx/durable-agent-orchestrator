import assert from 'node:assert/strict';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';

const calls = [];
const store = {
  db: { __p6Fake: true, prepare(sql) {
    if (sql.includes("state='ACTIVE'")) return { get: () => ({ n: 0 }) };
    if (sql.includes('UPDATE task_leases')) return { run: () => ({ changes: 1 }) };
    throw new Error(`unexpected query: ${sql}`);
  } },
  acquireTaskLease(taskId, options) { return { lease_id: options.leaseId, task_id: taskId, attempt: 2 }; },
  recordEvent() {},
  expireTaskLease() {}
};
const provider = {
  async dispatch(request) { calls.push(request); return { provider_run_id: 'gha-p9' }; }
};

const scheduler = new DistributedScheduler({ store, provider, maxParallel: 1, workerId: 'p9-test' });
const task = {
  job_id: 'job-p9', task_id: 'task-p9', role: 'engineer',
  metadata_json: JSON.stringify({ resume_input_commit: 'fedcba9876543210fedcba9876543210fedcba98' }),
  payload_ref: '.worker/tasks/task-p9.json'
};
const out = await scheduler.dispatchTask(task, { inputCommit: '0123456789abcdef0123456789abcdef01234567' });

assert.equal(out.request.input_commit, 'fedcba9876543210fedcba9876543210fedcba98');
assert.equal(calls[0].input_commit, out.request.input_commit);
assert.equal(out.request.attempt, 2);
console.log('p9-resume P9 PASS');
