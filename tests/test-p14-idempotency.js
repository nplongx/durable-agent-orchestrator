import assert from 'node:assert/strict';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';

const leases = new Map([['lease-1', { lease_id: 'lease-1', task_id: 'task-1', job_id: 'job-1', attempt: 1, state: 'ACTIVE', worker_id: 'worker-1' }]]);
const providerRuns = new Map([['lease-1', { provider_run_id: 'run-1', lease_id: 'lease-1', task_id: 'task-1', job_id: 'job-1', attempt: 1, state: 'RUNNING' }]]);
const store = {
  db: { prepare(sql) { return { get: (...args) => sql.includes('provider_runs') ? providerRuns.get(args[0]) || null : [...leases.values()].find(x => x.task_id === args[0] && x.state === 'ACTIVE') || null, run() {} }; } },
  acquireTaskLease() { throw new Error('must not acquire a second lease'); },
  recordEvent() {},
  expireTaskLease() {}
};
const scheduler = new DistributedScheduler({ store, provider: { dispatch: async () => { throw new Error('must not dispatch twice'); } }, workerId: 'worker-1' });
const out = await scheduler.dispatchTask({ task_id: 'task-1', job_id: 'job-1', role: 'executor' }, { inputCommit: 'a'.repeat(40) });
assert.equal(out.idempotent, true);
assert.equal(out.run.provider_run_id, 'run-1');
console.log('p14-idempotency P14 PASS');
