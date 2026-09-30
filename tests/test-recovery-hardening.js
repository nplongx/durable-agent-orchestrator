import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workflowStore } from '../job-store.js';
import { RecoveryManager, hasVerifiedSuccessfulRuntimeEvidence } from '../recovery-manager.js';

const store = workflowStore;
if (!process.env.WORKFLOW_DB) {
  throw new Error('test-recovery-hardening requires WORKFLOW_DB pointing to an isolated test database');
}
const testSuffix = randomUUID();
const job = store.createJob({
  conversationKey: 'test-recovery-hardening',
  title: 'Production E2E recovery hardening'
});
store.approve(job.job_id, 'duyệt');
store.dispatch(job.job_id, {
  role: 'cto',
  description: 'Production E2E recovery test'
});
const cto = store.getTask(store.getJob(job.job_id).active_task_id);

const makeChild = (role, sessionKey, command) => {
  const task = store.recordSpawn(job.job_id, {
    parentTaskId: cto.task_id,
    role,
    description: 'Durable Job ID: ' + job.job_id + '. Run immediately: ' + command + '. Return the exact command, actual stdout/stderr output, and exit status.',
    runId: 'run-' + role,
    sessionKey,
    metadata: { executor: 'ExecutionManager', deterministic: true, command }
  });
  return store.getTask(task.task_id);
};

const goodEvidence = command => [
  '<prompt-data>',
  '[ACTUAL TOOL RESULT EVIDENCE]',
  'exact command: ' + command,
  'stdout:',
  'stderr:',
  'exit status/code: 0',
  'execution status: completed',
  '</prompt-data>'
].join('\n');

const architectCommand = 'node --check /home/long/work/chatgpt-adapter/server.js';
const qaCommand = 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js';

const architect = makeChild('architect', 'agent:architect:subagent:recovery-hardening-' + testSuffix, architectCommand);
const qa = makeChild('qa', 'agent:qa:subagent:recovery-hardening-' + testSuffix, qaCommand);

assert.equal(
  store.completeTaskByRuntime(job.job_id, {
    runId: architect.openclaw_run_id,
    sessionKey: architect.openclaw_session_key,
    content: '<prompt-data>provider failure</prompt-data>',
    outcome: 'failure'
  }).status,
  'failed'
);
store.completeTaskByRuntime(job.job_id, {
  runId: qa.openclaw_run_id,
  sessionKey: qa.openclaw_session_key,
  content: goodEvidence(qaCommand),
  outcome: 'success'
});

const architectSession = store.getSessionByTask(architect.task_id);
store.markAgentSessionStale(architectSession.session_id, { reason: 'test stale-before-done' });

const taskCountBefore = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?').get(job.job_id).n;
const sessionCountBefore = store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE job_id = ?').get(job.job_id).n;

const recovery = new RecoveryManager(store, {
  trajectoryTimeoutMs: 100,
  listSessions: async () => [
    { key: architect.openclaw_session_key, status: 'done', runId: architect.openclaw_run_id },
    { key: qa.openclaw_session_key, status: 'done', runId: qa.openclaw_run_id }
  ],
  exportTrajectory: async sessionKey => sessionKey === architect.openclaw_session_key
    ? goodEvidence(architectCommand)
    : goodEvidence(qaCommand)
});
await recovery.reconcile({ jobId: job.job_id });

const recoveredArchitect = store.getTask(architect.task_id);
assert.equal(recoveredArchitect.status, 'completed');
assert.equal(store.getSessionByTask(architect.task_id).session_id, architectSession.session_id);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?').get(job.job_id).n, taskCountBefore);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE job_id = ?').get(job.job_id).n, sessionCountBefore);
assert.equal(store.db.prepare('SELECT outcome FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(architect.task_id).outcome, 'success');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get(architect.task_id).n, 1);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = ?').get(architect.task_id, 'completed').n, 1);

assert.equal(hasVerifiedSuccessfulRuntimeEvidence(
  { description: 'Run immediately: node --check /home/long/work/chatgpt-adapter/server.js.', metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: architectCommand }) },
  goodEvidence(architectCommand)
), true);
assert.equal(hasVerifiedSuccessfulRuntimeEvidence(
  { description: 'Run immediately: node --check /tmp/other.js.', metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /tmp/other.js' }) },
  goodEvidence(architectCommand)
), false);

const timeoutJob = store.createJob({
  conversationKey: 'test-recovery-timeout',
  title: 'Production E2E recovery timeout'
});
store.approve(timeoutJob.job_id, 'duyệt');
store.dispatch(timeoutJob.job_id, { role: 'cto', description: 'timeout test' });
const timeoutCto = store.getTask(store.getJob(timeoutJob.job_id).active_task_id);
const timeoutChild = store.createChildTask(timeoutJob.job_id, {
  parentTaskId: timeoutCto.task_id,
  role: 'architect',
  description: 'Run immediately: ' + architectCommand + '.',
  metadata: { executor: 'ExecutionManager', deterministic: true, command: architectCommand }
});
store.attachTaskRuntime(timeoutChild.task_id, {
  runId: 'run-timeout',
  sessionKey: 'agent:architect:subagent:recovery-timeout-' + testSuffix
});
store.completeTaskByRuntime(timeoutJob.job_id, {
  runId: 'run-timeout',
  sessionKey: 'agent:architect:subagent:recovery-timeout-' + testSuffix,
  content: 'provider failure',
  outcome: 'failure'
});
const timeoutRecovery = new RecoveryManager(store, {
  listSessions: async () => [{ key: timeoutChild.openclaw_session_key, status: 'done', runId: 'run-timeout' }],
  exportTrajectory: async () => { throw new Error('timeout'); }
});
await timeoutRecovery.reconcile({ jobId: timeoutJob.job_id });
assert.equal(store.getTask(timeoutChild.task_id).status, 'failed');

const runtimeTimeoutJob = store.createJob({
  conversationKey: 'test-runtime-timeout',
  title: 'Engineering M4 runtime timeout reconciliation'
});
store.approve(runtimeTimeoutJob.job_id, 'duyệt');
store.dispatch(runtimeTimeoutJob.job_id, { role: 'cto', description: 'runtime timeout test' });
const runtimeTimeoutCto = store.getTask(store.getJob(runtimeTimeoutJob.job_id).active_task_id);
const runtimeTimeoutChild = store.recordSpawn(runtimeTimeoutJob.job_id, {
  parentTaskId: runtimeTimeoutCto.task_id,
  role: 'architect',
  description: 'runtime timeout child',
  runId: 'run-runtime-timeout',
  sessionKey: 'agent:architect:subagent:runtime-timeout-' + testSuffix,
  metadata: { workflow_plan_task_id: 'engineering.architect' }
});
let trajectoryCalled = false;
const runtimeTimeoutRecovery = new RecoveryManager(store, {
  listSessions: async () => [{ key: runtimeTimeoutChild.openclaw_session_key, status: 'timeout', runId: 'run-runtime-timeout' }],
  exportTrajectory: async () => { trajectoryCalled = true; throw new Error('must not export timed-out runtime'); }
});
await runtimeTimeoutRecovery.reconcile({ jobId: runtimeTimeoutJob.job_id });
assert.equal(trajectoryCalled, false);
assert.equal(store.getTask(runtimeTimeoutChild.task_id).status, 'failed');
assert.equal(
  store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.runtime_reconciled'").get(runtimeTimeoutJob.job_id).n,
  1
);

const terminalJob = store.createJob({ conversationKey: 'test-terminal-running-task', title: 'Terminal running task reconciliation' });
const terminalCto = store.dispatch(terminalJob.job_id, { role: 'cto', description: 'terminal task test' });
store.transition(terminalJob.job_id, 'FAILED', 'failed');
const terminalTask = store.getTask(terminalCto.task_id);
assert.equal(terminalTask.status, 'running');
await timeoutRecovery.reconcile({ jobId: terminalJob.job_id });
assert.equal(store.getTask(terminalTask.task_id).status, 'cancelled');

const slackJob = store.createJob({
  conversationKey: 'test-slack-semantics',
  title: 'Slack projection semantics'
});
store.recordEvent(slackJob.job_id, 'session.heartbeat', {});
store.recordEvent(slackJob.job_id, 'session.stale', {});
store.recordEvent(slackJob.job_id, 'task.completed', { taskId: 'business-task' });
let projection = store.getSlackProjection(slackJob.job_id);
assert.equal(projection.totalEvents, 1);
assert.equal(projection.projectedEvents, 0);
assert.equal(projection.pendingEvents, 1);
const businessEvent = store.db.prepare(
  "SELECT event_id FROM events WHERE job_id = ? AND type = 'task.completed'"
).get(slackJob.job_id);
assert.equal(store.claimSlackProjection(businessEvent.event_id, slackJob.job_id, {
  channel: 'slack',
  target: 'C0C3RJKNKPG',
  messageId: 'test-message'
}), true);
projection = store.getSlackProjection(slackJob.job_id);
assert.equal(projection.totalEvents, 1);
assert.equal(projection.projectedEvents, 1);
assert.equal(projection.pendingEvents, 0);

console.log('test-recovery-hardening: PASS');
