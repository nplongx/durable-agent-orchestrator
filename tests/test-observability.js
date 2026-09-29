import assert from 'node:assert/strict';
import { summarizeObservability, createStructuredLogger } from '../src/runtime/observability.js';

const summary = summarizeObservability({
  events: [{ type: 'task.lease.acquired' }, { type: 'task.lease.acquired' }, { type: 'task.execution.verified' }],
  tasks: [{ status: 'completed' }, { status: 'pending' }],
  leases: [{ state: 'COMPLETED', issued_at: '2026-01-01T00:00:00.000Z', released_at: '2026-01-01T00:00:01.000Z' }],
  providerRuns: [{ state: 'COMPLETED', conclusion: 'success', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:02.000Z' }]
});
assert.equal(summary.event_counts['task.lease.acquired'], 2);
assert.equal(summary.task_counts.completed, 1);
assert.equal(summary.provider_counts['COMPLETED:success'], 1);
assert.equal(summary.provider_latency_ms.avg, 2000);
assert.equal(summary.lease_lifetime_ms.avg, 1000);
const lines = [];
const logger = createStructuredLogger({ sink: { info: line => lines.push(line) }, base: { job_id: 'job-1' } });
const record = logger('info', 'provider dispatched', { task_id: 'task-1', provider_run_id: 'run-1' });
assert.equal(record.job_id, 'job-1');
assert.equal(JSON.parse(lines[0]).task_id, 'task-1');
console.log('observability P12 PASS');
