import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';

const maxParallel = 4;
const total = 20;
const leases = new Map();
let active = 0;
let peak = 0;
const store = {
  db: { prepare(sql) {
    if (sql.includes("state='ACTIVE'")) return { get: () => ({ n: [...leases.values()].filter(x => x.state === 'ACTIVE').length }) };
    if (sql.includes('UPDATE task_leases')) return { run: () => ({ changes: 1 }) };
    throw new Error(sql);
  } },
  acquireTaskLease(taskId, opts) { const l = { lease_id: opts.leaseId, task_id: taskId, attempt: 1, state: 'ACTIVE' }; leases.set(taskId, l); return l; },
  listRunnableTasks({ limit }) { return [...Array(total)].map((_, i) => ({ task_id: `t-${i}`, job_id: 'j', role: 'executor' })).filter(t => !leases.get(t.task_id) || leases.get(t.task_id).state !== 'COMPLETED').slice(0, limit); },
  recordEvent() {},
  expireTaskLease() {},
  releaseBenchmarkLeases() { for (const l of leases.values()) l.state = 'COMPLETED'; }
};
const provider = { async dispatch() { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--; return { provider_run_id: `r-${Math.random()}` }; } };
const scheduler = new DistributedScheduler({ store, provider, maxParallel, workerId: 'p10-test' });
const started = performance.now();
let count = 0;
while (count < total) {
  const batch = await scheduler.dispatchPending({ inputCommit: 'a'.repeat(40), limit: maxParallel });
  count += batch.filter(x => x.status === 'fulfilled').length;
  store.releaseBenchmarkLeases();
}
assert.equal(count, total);
assert.ok(peak <= maxParallel, `peak ${peak} > maxParallel ${maxParallel}`);
assert.ok(performance.now() - started < 5000);
console.log(`p10-capacity P10 PASS peak=${peak} maxParallel=${maxParallel} tasks=${total}`);
