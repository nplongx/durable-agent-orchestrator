import assert from 'node:assert/strict';
import { LangGraphControlLoop } from '../src/runtime/langgraph-control-loop.js';

const events = [];
const store = {
  db: { prepare(sql) {
    if (sql.includes('provider_runs')) return { all: () => [] };
    if (sql.includes('FROM tasks')) return { all: () => [] };
    if (sql.includes('FROM results')) return { all: () => [] };
    throw new Error(`unexpected query: ${sql}`);
  } },
  getJob: () => ({ job_id: 'job-p7', state: 'RUNNING' }),
  getExecutionPlan: () => null,
  getWorkflowRuntimeState: () => ({ phase: 'WAIT', attempt: 1 }),
  reapExpiredTaskLeases: () => 0,
  recordEvent: (...args) => events.push(args),
};
const scheduler = { dispatchPending: async () => [], dispatchTask: async () => ({}) };
const provider = { getStatus: async () => ({ status: 'COMPLETED' }), collectResult: async () => null };
const graph = async input => { assert.equal(input.persist, true); assert.equal(input.job.job_id, 'job-p7'); return { action: 'WAIT', reason: 'test' }; };
const loop = new LangGraphControlLoop({ store, scheduler, provider, graph });
const out = await loop.tick({ jobId: 'job-p7', inputCommit: 'a'.repeat(40) });
assert.equal(out.decision.action, 'WAIT');
assert.deepEqual(out.dispatched, []);
console.log('langgraph-control-loop P7 PASS');
