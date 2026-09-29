import assert from 'node:assert/strict';
import { AutonomousDeliveryRunner } from '../src/runtime/autonomous-delivery.js';
import { LangGraphControlLoop } from '../src/runtime/langgraph-control-loop.js';
import { WorkflowPhase } from '../src/runtime/workflow/phases.js';

let phase = WorkflowPhase.WAIT;
let state = 'RUNNING';
let ticks = 0;
let heartbeats = 0;
let events = [];

const store = {
  db: { prepare(sql) {
    if (sql.includes('provider_runs')) return { all: () => [] };
    if (sql.includes('FROM tasks')) return { all: () => [] };
    if (sql.includes('FROM results')) return { all: () => [] };
    throw new Error(`unexpected query: ${sql}`);
  } },
  getJob: () => ({ job_id: 'job-p8', state, status: 'active' }),
  getExecutionPlan: () => null,
  getWorkflowRuntimeState: () => ({ phase, attempt: 1 }),
  reapExpiredTaskLeases: () => 0,
  listTaskLeases: () => [],
  heartbeatTaskLease: () => { heartbeats++; return { ok: true }; },
  recordEvent: (...args) => events.push(args),
};
const scheduler = { workerId: 'p8-test-worker', leaseTtlMs: 5000, dispatchPending: async () => [], dispatchTask: async () => ({}) };
const provider = { getStatus: async () => ({ status: 'RUNNING' }) };
const graph = async input => {
  assert.equal(input.persist, true);
  ticks++;
  if (ticks >= 2) {
    phase = WorkflowPhase.COMPLETED;
    state = 'COMPLETED';
  }
  return { action: 'WAIT', reason: 'p8 test tick' };
};

const loop = new LangGraphControlLoop({ store, scheduler, provider, graph });
const runner = new AutonomousDeliveryRunner({ controlLoop: loop, store, scheduler, pollMs: 0, maxTicks: 5 });
const result = await runner.run({ jobId: 'job-p8', inputCommit: 'a'.repeat(40) });

assert.equal(result.job.state, 'COMPLETED');
assert.equal(result.ticks, 2);
assert.equal(result.history.length, 2);
assert.equal(heartbeats, 0);
assert.ok(events.length >= 0);
console.log('autonomous-delivery P8 PASS');
