import assert from 'node:assert/strict';
import { evaluateLangGraph, LangGraphActions } from '../langgraph-orchestrator.js';
import { canonicalExecutionEvidenceContent } from '../src/runtime/workflow/evidence.js';

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
  content: canonicalExecutionEvidenceContent({
    taskId: task_id, executionSessionId: `exec_${task_id}`, attempt: 1,
    command: role === 'architect'
      ? 'node --check /home/long/work/chatgpt-adapter/server.js'
      : 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js',
    exitCode: exit, status: exit === 0 ? 'completed' : 'failed', stdout: '', stderr: ''
  })
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
  tasks: [
    { task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' },
    { ...child('architect', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/server.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0, execution_session_id: 'exec_task_architect', execution_attempt: 1, execution_stdout: '', execution_stderr: '' },
    { ...child('qa', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0, execution_session_id: 'exec_task_qa', execution_attempt: 1, execution_stdout: '', execution_stderr: '' }
  ],
  results: [result('task_architect', 'architect'), result('task_qa', 'qa')],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(ready.action, LangGraphActions.SYNTHESIZE);

const productionValidTasks = [
  { task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' },
  { ...child('architect', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/server.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0, execution_session_id: 'exec_task_architect', execution_attempt: 1, execution_stdout: '', execution_stderr: '' },
  { ...child('qa', 'completed'), metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js', cwd: '/home/long/work/chatgpt-adapter' }), execution_status: 'completed', execution_exit_code: 0, execution_session_id: 'exec_task_qa', execution_attempt: 1, execution_stdout: '', execution_stderr: '' }
];
const validProductionResults = [result('task_architect', 'architect'), result('task_qa', 'qa')];
const missingSession = await evaluateLangGraph({
  job: baseJob,
  tasks: productionValidTasks.map(task => task.task_id === 'task_architect' ? { ...task, execution_session_id: null } : task),
  results: validProductionResults, runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(missingSession.action, LangGraphActions.BLOCK,
  'a completed/zero-exit task without durable session identity must not authorize CTO synthesis');
const mismatchedSession = await evaluateLangGraph({
  job: baseJob, tasks: productionValidTasks,
  results: [
    { ...validProductionResults[0], content: validProductionResults[0].content.replace('execution_session_id: exec_task_architect', 'execution_session_id: forged-session') },
    validProductionResults[1]
  ], runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(mismatchedSession.action, LangGraphActions.BLOCK,
  'success-shaped content with a substituted session identity must not authorize CTO synthesis');
const nullExit = await evaluateLangGraph({
  job: baseJob,
  tasks: productionValidTasks.map(task => task.task_id === 'task_qa' ? { ...task, execution_exit_code: null } : task),
  results: validProductionResults, runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(nullExit.action, LangGraphActions.BLOCK,
  'success-shaped execution status must not turn a NULL durable exit code into success');
const failedTask = await evaluateLangGraph({
  job: baseJob,
  tasks: productionValidTasks.map(task => task.task_id === 'task_architect' ? { ...task, status: 'failed' } : task),
  results: validProductionResults, runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(failedTask.action, LangGraphActions.BLOCK,
  'a failed durable task must not be promoted to success by a completed zero-exit execution ledger');

// Durable timestamps have millisecond resolution. When two revisions for the
// same immutable plan slot share a timestamp, the later row in JobStore's
// (created_at,rowid) order must win; otherwise the older completed success can
// shadow a failed revision and authorize synthesis.
const graphPlan = { children: [
  {
    id: 'architect-check', role: 'architect', dependencies: [],
    execution: {
      executor: 'ExecutionManager', deterministic: true,
      command: 'node --check /home/long/work/chatgpt-adapter/server.js',
      executable: 'node', args: ['--check', '/home/long/work/chatgpt-adapter/server.js'],
      cwd: '/home/long/work/chatgpt-adapter', timeout_ms: 120000
    }
  },
  {
    id: 'qa-check', role: 'qa', dependencies: [],
    execution: {
      executor: 'ExecutionManager', deterministic: true,
      command: 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js',
      executable: 'node', args: ['--check', '/home/long/work/chatgpt-adapter/test-tool-turn.js'],
      cwd: '/home/long/work/chatgpt-adapter', timeout_ms: 120000
    }
  }
] };
const tiedCreatedAt = '2026-10-16T10:00:00.000Z';
const revisedArchitectMetadata = {
  executor: 'ExecutionManager', deterministic: true, workflow_plan_task_id: 'architect-check',
  command: graphPlan.children[0].execution.command, executable: 'node',
  args: ['--check', '/home/long/work/chatgpt-adapter/server.js'],
  cwd: '/home/long/work/chatgpt-adapter', timeout_ms: 120000
};
const tiedOldSuccess = {
  ...productionValidTasks[1], task_id: 'task_architect_revision_old', created_at: tiedCreatedAt,
  execution_session_id: 'exec_task_architect_revision_old',
  metadata_json: JSON.stringify(revisedArchitectMetadata)
};
const tiedLatestFailure = {
  ...productionValidTasks[1], task_id: 'task_architect_revision_latest', status: 'failed', created_at: tiedCreatedAt,
  execution_session_id: 'exec_task_architect_revision_latest',
  metadata_json: JSON.stringify(revisedArchitectMetadata)
};
const tiedTimestampLatestFailure = await evaluateLangGraph({
  job: baseJob, plan: graphPlan,
  tasks: [
    productionValidTasks[0], tiedOldSuccess, tiedLatestFailure,
    { ...productionValidTasks[2], metadata_json: JSON.stringify({
      executor: 'ExecutionManager', deterministic: true, workflow_plan_task_id: 'qa-check',
      command: graphPlan.children[1].execution.command, executable: 'node',
      args: ['--check', '/home/long/work/chatgpt-adapter/test-tool-turn.js'],
      cwd: '/home/long/work/chatgpt-adapter', timeout_ms: 120000
    }) }
  ],
  results: [result(tiedOldSuccess.task_id, 'architect'), result(tiedLatestFailure.task_id, 'architect'), result('task_qa', 'qa')],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(tiedTimestampLatestFailure.action, LangGraphActions.BLOCK,
  'same-millisecond latest failed revision must shadow older success and block synthesis');

const failed = await evaluateLangGraph({
  job: baseJob,
  tasks: [{ task_id: 'task_cto', role: 'cto', status: 'running', openclaw_session_key: 'agent:cto:test' }, child('architect', 'failed'), child('qa', 'completed')],
  results: [result('task_architect', 'architect', 1), result('task_qa', 'qa')],
  runtime: runtime('VALIDATE_EVIDENCE')
});
assert.equal(failed.action, LangGraphActions.BLOCK);

console.log('test-langgraph-orchestrator: PASS');
