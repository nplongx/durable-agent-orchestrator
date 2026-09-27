import assert from 'node:assert/strict';
import { evaluateLangGraph, LangGraphActions } from '../langgraph-orchestrator.js';

const baseJob = {
  job_id: 'job_poc',
  title: 'Production E2E acceptance native clean',
  state: 'EXECUTING',
  active_task_id: 'task_cto'
};

const child = (role, status) => ({
  task_id: `task_${role}`,
  parent_task_id: 'task_cto',
  role,
  status
});

const result = (task_id, role, exit = 0) => ({
  task_id,
  content: `[ACTUAL TOOL RESULT EVIDENCE]\nROLE=${role}\nCOMMAND=node --check /x\nexit status: ${exit}`
});

const approved = await evaluateLangGraph({ ...baseJob, job: { ...baseJob, state: 'APPROVED' } });
assert.equal(approved.action, LangGraphActions.SPAWN_CTO);

const missing = await evaluateLangGraph({ job: baseJob, tasks: [child('architect', 'completed')] });
assert.equal(missing.action, LangGraphActions.SPAWN_CTO);
assert.match(missing.reason, /qa/);

const waiting = await evaluateLangGraph({
  job: baseJob,
  tasks: [child('architect', 'completed'), child('qa', 'running')]
});
assert.equal(waiting.action, LangGraphActions.WAIT_CHILDREN);

const blockedEvidence = await evaluateLangGraph({
  job: baseJob,
  tasks: [child('architect', 'completed'), child('qa', 'completed')],
  results: [{ task_id: 'task_architect', content: '[ACTUAL TOOL RESULT EVIDENCE] exit status: 0' }]
});
assert.equal(blockedEvidence.action, LangGraphActions.BLOCK);
assert.match(blockedEvidence.reason, /qa/);

const ready = await evaluateLangGraph({
  job: baseJob,
  tasks: [child('architect', 'completed'), child('qa', 'completed')],
  results: [result('task_architect', 'architect'), result('task_qa', 'qa')]
});
assert.equal(ready.action, LangGraphActions.SYNTHESIZE);

const failed = await evaluateLangGraph({
  job: baseJob,
  tasks: [child('architect', 'failed'), child('qa', 'completed')],
  results: [result('task_architect', 'architect', 1), result('task_qa', 'qa')]
});
assert.equal(failed.action, LangGraphActions.SYNTHESIZE);

console.log('test-langgraph-orchestrator: PASS');
