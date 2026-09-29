import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('adapter-phase5c-');
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
const { workflowStore } = await import('../job-store.js');

const job = workflowStore.createJob({ conversationKey: 'phase5c', title: 'collaboration graph' });
workflowStore.dispatch(job.job_id, { role: 'cto', description: 'lead task' });
const parent = workflowStore.getTask(workflowStore.getJob(job.job_id).active_task_id);
assert.equal(parent.role, 'cto');

workflowStore.reconcileRuntimeRefs(job.job_id, [
  { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn', arguments: JSON.stringify({ agentId: 'cto', task: 'lead task' }) } }] },
  { role: 'tool', content: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:cto:subagent:parent', runId: 'run-parent' }) }
]);
assert.equal(workflowStore.getTask(parent.task_id).openclaw_run_id, 'run-parent');

const child = workflowStore.createChildTask(job.job_id, {
  parentTaskId: parent.task_id,
  role: 'architect',
  description: 'design architecture',
  dependencies: [],
  metadata: { lane: 'architect' }
});
workflowStore.attachTaskRuntime(child.task_id, {
  runId: 'run-architect',
  sessionKey: 'agent:architect:subagent:test'
});
assert.equal(workflowStore.hasOpenTasks(job.job_id), true);

const completed = workflowStore.completeTaskByRuntime(job.job_id, {
  runId: 'run-architect',
  content: 'architecture ready',
  outcome: 'success'
});
assert.equal(completed.status, 'completed');
assert.equal(workflowStore.hasOpenTasks(job.job_id), true, 'parent CTO remains open after child completion');

const messages = [
  { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn', arguments: JSON.stringify({ agentId: 'qa', task: 'run regression suite' }) } }] },
  { role: 'tool', content: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:qa:subagent:test', runId: 'run-qa' }) }
];
workflowStore.reconcileRuntimeRefs(job.job_id, messages);
const trace = workflowStore.getJobTrace(job.job_id);
const qa = trace.tasks.find(t => t.role === 'qa');
assert.ok(qa);
assert.equal(qa.openclaw_run_id, 'run-qa');
assert.equal(qa.parent_task_id, parent.task_id);

const terminalJob = workflowStore.createJob({ conversationKey: 'phase5c-terminal', title: 'terminal runtime completion' });
workflowStore.dispatch(terminalJob.job_id, { role: 'cto', description: 'terminal task' });
workflowStore.startAttempt(terminalJob.job_id);
workflowStore.attachOpenClawRun(terminalJob.job_id, { runId: 'run-terminal', sessionKey: 'agent:cto:subagent:terminal' });
workflowStore.completeTaskByRuntime(terminalJob.job_id, {
  runId: 'run-terminal', sessionKey: 'agent:cto:subagent:terminal', content: 'done', outcome: 'success'
});
assert.equal(workflowStore.getJob(terminalJob.job_id).state, 'EXECUTING', 'runtime completion must not close durable Job');
const terminalChild = workflowStore.createChildTask(terminalJob.job_id, {
  parentTaskId: terminalJob.active_task_id,
  role: 'architect',
  description: 'terminal specialist'
});
workflowStore.completeTaskByRuntime(terminalJob.job_id, {
  taskId: terminalChild.task_id,
  runId: 'run-terminal-child',
  sessionKey: 'agent:architect:subagent:terminal-child',
  content: 'child done',
  outcome: 'success'
});
workflowStore.complete(terminalJob.job_id, 'synthesis complete', 'success');
assert.equal(workflowStore.getJob(terminalJob.job_id).state, 'COMPLETED', 'explicit business completion closes durable Job');

console.log('phase5c collaboration tests: PASS');
