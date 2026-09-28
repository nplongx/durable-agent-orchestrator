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
  outcome: exit === 0 ? 'success' : 'failure',
  content: `[ACTUAL TOOL RESULT EVIDENCE]\nROLE=${role}\nexact command: ${role === 'architect' ? 'node --check /home/long/work/chatgpt-adapter/server.js' : 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js'}\nexit status/code: ${exit}`
});

const runtime = phase => ({ phase });
const approved = await evaluateLangGraph({ job: { ...baseJob, state: 'APPROVED' }, runtime: runtime('APPROVED') });
assert.equal(approved.action, LangGraphActions.SPAWN_CTO);

const missing = await evaluateLangGraph({ job: baseJob, tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, child('architect', 'completed')], runtime: runtime('ASSIGN_CHILDREN') });
assert.equal(missing.action, LangGraphActions.ASSIGN_CHILDREN);

const waiting = await evaluateLangGraph({
  job: baseJob,
  tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, child('architect', 'completed'), child('qa', 'running')],
  runtime: runtime('WAIT')
});
assert.equal(waiting.action, LangGraphActions.WAIT);

const blockedEvidence = await evaluateLangGraph({
  job: baseJob,
  tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, child('architect', 'completed'), child('qa', 'completed')],
  results: [{ task_id: 'task_architect', content: '[ACTUAL TOOL RESULT EVIDENCE] exit status: 0' }, { task_id: 'task_qa', content: '[ACTUAL TOOL RESULT EVIDENCE] exit status: 0' }],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(blockedEvidence.action, LangGraphActions.BLOCK);
assert.match(blockedEvidence.reason, /qa/);

const ready = await evaluateLangGraph({
  job: baseJob,
  tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, { ...child('architect', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/server.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0 }, { ...child('qa', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0 }],
  results: [result('task_architect', 'architect'), result('task_qa', 'qa')],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(ready.action, LangGraphActions.SYNTHESIZE);

const failed = await evaluateLangGraph({
  job: baseJob,
  tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, child('architect', 'failed'), child('qa', 'completed')],
  results: [result('task_architect', 'architect', 1), result('task_qa', 'qa')],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(failed.action, LangGraphActions.BLOCK);

console.log('test-langgraph-orchestrator: PASS');
