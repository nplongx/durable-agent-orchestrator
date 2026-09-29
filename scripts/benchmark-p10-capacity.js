#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { DistributedScheduler } from '../src/runtime/distributed-scheduler.js';

const maxParallel = Math.max(1, Number(process.env.P10_MAX_PARALLEL || 8));
const taskCount = Math.max(maxParallel, Number(process.env.P10_TASKS || maxParallel * 8));
const providerDelayMs = Math.max(0, Number(process.env.P10_PROVIDER_DELAY_MS || 10));
const rounds = Math.max(1, Number(process.env.P10_ROUNDS || 3));

const percentile = (values, p) => {
  const xs = [...values].sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
};

function makeHarness() {
  const leases = new Map();
  const store = {
    db: { prepare(sql) {
      if (sql.includes("state='ACTIVE'")) return { get: () => ({ n: [...leases.values()].filter(x => x.state === 'ACTIVE').length }) };
      if (sql.includes('UPDATE task_leases')) return { run: () => ({ changes: 1 }) };
      throw new Error(`unexpected benchmark SQL: ${sql}`);
    } },
    acquireTaskLease(taskId, opts) {
      const lease = { lease_id: opts.leaseId, task_id: taskId, attempt: 1, state: 'ACTIVE' };
      leases.set(taskId, lease);
      return lease;
    },
    listRunnableTasks({ limit }) {
      return [...Array(taskCount)].map((_, i) => ({
        task_id: `p10-task-${i + 1}`,
        job_id: 'p10-job', role: 'executor', payload_ref: `.worker/tasks/p10-${i + 1}.json`
      })).filter(t => !leases.has(t.task_id)).slice(0, limit);
    },
    recordEvent() {},
    releaseBenchmarkLeases() {
      for (const lease of leases.values()) lease.state = 'COMPLETED';
    },
    expireTaskLease(leaseId) {
      for (const lease of leases.values()) if (lease.lease_id === leaseId) lease.state = 'EXPIRED';
    }
  };
  let active = 0;
  let peak = 0;
  const provider = {
    async dispatch(request) {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, providerDelayMs));
      active--;
      return { provider_run_id: `p10-${request.task_id}` };
    }
  };
  return { store, provider, getPeak: () => peak };
}

async function runRound() {
  const { store, provider, getPeak } = makeHarness();
  const scheduler = new DistributedScheduler({ store, provider, maxParallel, workerId: 'p10-benchmark' });
  const samples = [];
  const started = performance.now();
  let dispatched = 0;
  while (dispatched < taskCount) {
    const t0 = performance.now();
    const results = await scheduler.dispatchPending({ inputCommit: 'a'.repeat(40), limit: maxParallel });
    samples.push(performance.now() - t0);
    dispatched += results.filter(r => r.status === 'fulfilled').length;
    // The provider run has completed its simulated dispatch, so free leases.
    store.releaseBenchmarkLeases();
  }
  const elapsedMs = performance.now() - started;
  return { elapsedMs, throughput: dispatched / (elapsedMs / 1000), dispatchP50Ms: percentile(samples, 50), dispatchP95Ms: percentile(samples, 95), peakProviderConcurrency: getPeak() };
}

const results = [];
for (let i = 0; i < rounds; i++) results.push(await runRound());
const summary = {
  phase: 'P10', benchmark: 'control-plane dispatch capacity',
  maxParallel, taskCount, providerDelayMs, rounds,
  runs: results,
  bestThroughputTasksPerSec: Math.max(...results.map(x => x.throughput)),
  medianThroughputTasksPerSec: percentile(results.map(x => x.throughput), 50)
};
console.log(JSON.stringify(summary, null, 2));
