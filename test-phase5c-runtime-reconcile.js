import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-phase5c-runtime-'));
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
const { workflowStore } = await import('./job-store.js');

const job = workflowStore.createJob({ conversationKey: 'phase5c-runtime', title: 'runtime reconciliation' });
workflowStore.dispatch(job.job_id, { role: 'cto', description: 'verify runtime reconciliation' });
workflowStore.startAttempt(job.job_id);
workflowStore.attachOpenClawRun(job.job_id, {
  runId: 'cto-run-1',
  sessionKey: 'agent:cto:subagent:cto-1'
});

const child = workflowStore.createChildTask(job.job_id, {
  parentTaskId: workflowStore.getJob(job.job_id).active_task_id,
  role: 'engineer',
  description: 'Durable Job ID: test. Specialist role: engineer.'
});
assert.equal(child.status, 'pending');

workflowStore.reconcileRuntimeRefs(job.job_id, [
  { role: 'user', content: `Durable Job ID: ${job.job_id}` },
  { role: 'assistant', content: 'Child session: agent:engineer:subagent:child-1 Run ID: child-run-1' }
]);

const attached = workflowStore.getTask(child.task_id);
assert.equal(attached.openclaw_session_key, 'agent:engineer:subagent:child-1');
assert.equal(attached.openclaw_run_id, 'child-run-1');

workflowStore.reconcileRuntimeRefs(job.job_id, [
  { role: 'user', content: `Durable Job ID: ${job.job_id}` },
  { role: 'assistant', content: 'Child session: agent:engineer:subagent:child-1 Run ID: child-run-1' }
]);
assert.equal(workflowStore.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id=? AND role=\'engineer\'').get(job.job_id).n, 1);

// Native sessions_spawn receipt may be present in repeated transcript turns.
// Reconciliation must not create duplicate child tasks for the same runtime.
const spawnCall = {
  role: 'assistant',
  tool_calls: [{
    function: {
      name: 'sessions_spawn',
      arguments: JSON.stringify({ agentId: 'engineer', task: 'Durable Job ID: test. Specialist role: engineer.' })
    }
  }]
};
const spawnReceipt = {
  role: 'tool',
  content: '{"childSessionKey":"agent:engineer:subagent:child-1","runId":"child-run-1"}'
};
workflowStore.reconcileRuntimeRefs(job.job_id, [spawnCall, spawnReceipt]);
workflowStore.reconcileRuntimeRefs(job.job_id, [spawnCall, spawnReceipt]);
assert.equal(workflowStore.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id=? AND role=\'engineer\'').get(job.job_id).n, 1);

console.log('phase5c runtime reconciliation tests: PASS');
