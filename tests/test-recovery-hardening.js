import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDir } from './test-temp-dir.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const recoveryDataDir = tempDir('recovery-hardening-20261017-');
process.env.WORKFLOW_DATA_DIR = recoveryDataDir;
process.env.WORKFLOW_DB = path.join(recoveryDataDir, 'workflow.db');
process.env.WORKFLOW_WORKSPACE = process.cwd();
process.env.EXECUTION_TMP_DIR = path.join(recoveryDataDir, 'runtime');
const [{ workflowStore: store }, { RecoveryManager, extractTrajectoryExecutionEvidence, hasVerifiedSuccessfulRuntimeEvidence },
  { ExecutionManager }, { GitHubActionsProvider }] = await Promise.all([
  import('../job-store.js'), import('../recovery-manager.js'),
  import('../src/runtime/execution-manager.js'), import('../src/runtime/github-actions-provider.js')
]);
const testSuffix = randomUUID();
// Install the durable provider-ledger schema in this isolated test database;
// this constructor is local-only and the fetch stub must never be called.
new GitHubActionsProvider({
  token: 'recovery-test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', store,
  fetchImpl: async () => { throw new Error('recovery schema fixture must not issue HTTP'); }
});
const executionManager = new ExecutionManager(store, {
  timeoutMs: 5000,
  executionTmpDir: path.join(process.env.WORKFLOW_DATA_DIR || '/tmp', 'runtime-recovery-hardening')
});
const job = store.createJob({
  conversationKey: 'test-recovery-hardening',
  title: 'Production E2E recovery hardening'
});
store.recordEvent(job.job_id, 'job.proposal_requested', {
  task: job.title, workspace: process.cwd(), workflowId: 'production', executionTarget: 'local'
}, job.job_id);
store.approve(job.job_id, 'duyệt', 'recovery-hardening-test', { workspace: process.cwd() });
store.dispatch(job.job_id, {
  role: 'cto',
  description: 'Production E2E recovery test'
});
const cto = store.getTask(store.getJob(job.job_id).active_task_id);
const productionPlan = store.getExecutionPlan(job.job_id);
const architectExecution = productionPlan.children.find(item => item.role === 'architect')?.execution;
const qaExecution = productionPlan.children.find(item => item.role === 'qa')?.execution;
assert.ok(architectExecution?.command && qaExecution?.command,
  'production recovery fixtures must derive commands from the immutable plan, not stale test constants');

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

const architectCommand = architectExecution.command;
const qaCommand = qaExecution.command;

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
const qaTranscriptOnlyCompletion = store.completeTaskByRuntime(job.job_id, {
  runId: qa.openclaw_run_id,
  sessionKey: qa.openclaw_session_key,
  content: [
    goodEvidence(qaCommand),
    'PRODUCTION QA MCP INITIALIZE/33-TOOL DISCOVERY PASS',
    'PRODUCTION QA BEHAVIORAL ARTIFACT VALIDATION PASS',
    'PRODUCTION QA APPROVAL/DISPATCH/IMMUTABLE-PLAN NEXT-TASK PASS'
  ].join('\n'),
  outcome: 'success'
});
assert.equal(qaTranscriptOnlyCompletion.status, 'failed',
  'success-shaped QA transcript and copied acceptance markers must not substitute for the ExecutionManager result/attempt/session ledger');

const architectSession = store.getSessionByTask(architect.task_id);
store.markAgentSessionStale(architectSession.session_id, { reason: 'test stale-before-done' });

const taskCountBefore = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?').get(job.job_id).n;
const sessionCountBefore = store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE job_id = ?').get(job.job_id).n;

const recovery = new RecoveryManager(store, {
  trajectoryTimeoutMs: 100,
  executionManager,
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
assert.equal(store.db.prepare('SELECT outcome FROM results WHERE task_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(architect.task_id).outcome, 'success');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get(architect.task_id).n, 2,
  'recovery must retain the failed native attempt and record the distinct local ExecutionManager attempt instead of promoting transcript text');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = ?').get(architect.task_id, 'failed').n, 1);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = ?').get(architect.task_id, 'completed').n, 1);
assert.equal(store.getTask(architect.task_id).execution_status, 'completed');
assert.equal(store.getTask(architect.task_id).execution_exit_code, 0);
assert.ok(store.getTask(architect.task_id).execution_session_id);

assert.equal(hasVerifiedSuccessfulRuntimeEvidence(
  { description: 'Run immediately: node --check /home/long/work/chatgpt-adapter/server.js.', metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: architectCommand }) },
  goodEvidence(architectCommand)
), true);
assert.equal(hasVerifiedSuccessfulRuntimeEvidence(
  { description: 'Run immediately: node --check /tmp/other.js.', metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check /tmp/other.js' }) },
  goodEvidence(architectCommand)
), false);
const architectTaskForEvidence = { metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: architectCommand }) };
for (const forgedExit of [
  'exit status/code: 0suffix',
  'exit status/code: -0',
  'exit status/code: 0 but command failed',
  'exit status/code: 0\nexit status/code: 1'
]) {
  assert.equal(hasVerifiedSuccessfulRuntimeEvidence(architectTaskForEvidence,
    `[ACTUAL TOOL RESULT EVIDENCE]\nexact command: ${architectCommand}\n${forgedExit}\nexecution status: completed`), false,
  `recovery must reject non-canonical or contradictory exit markers: ${JSON.stringify(forgedExit)}`);
}
const negativeZeroTrajectory = [
  { type: 'tool.call', data: { toolCallId: 'negative-zero-exit', name: 'exec', args: { command: architectCommand } } },
  { type: 'tool.result', data: { toolCallId: 'negative-zero-exit', success: true, details: { exitCode: -0 }, result: { content: [{ text: 'looks successful' }] } } }
].map(event => JSON.stringify(event)).join('\n');
const negativeZeroTrajectoryWithExactToken = negativeZeroTrajectory.replace('"exitCode":0', '"exitCode":-0');
assert.throws(() => extractTrajectoryExecutionEvidence(negativeZeroTrajectoryWithExactToken), /negative zero is not supported/,
  'trajectory recovery must reject a non-canonical negative-zero exit token before it can become a success observation');

const timeoutJob = store.createJob({
  conversationKey: 'test-recovery-timeout',
  title: 'Production E2E recovery timeout'
});
store.recordEvent(timeoutJob.job_id, 'job.proposal_requested', {
  task: timeoutJob.title, workspace: process.cwd(), workflowId: 'production', executionTarget: 'local'
}, timeoutJob.job_id);
store.approve(timeoutJob.job_id, 'duyệt', 'recovery-hardening-test', { workspace: process.cwd() });
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
store.recordEvent(runtimeTimeoutJob.job_id, 'job.proposal_requested', {
  task: runtimeTimeoutJob.title, workspace: process.cwd(), workflowId: 'engineering', executionTarget: 'local'
}, runtimeTimeoutJob.job_id);
store.approve(runtimeTimeoutJob.job_id, 'duyệt', 'recovery-hardening-test', { workspace: process.cwd() });
store.dispatch(runtimeTimeoutJob.job_id, { role: 'cto', description: 'runtime timeout test' });
const runtimeTimeoutCto = store.getTask(store.getJob(runtimeTimeoutJob.job_id).active_task_id);
const runtimeTimeoutArchitectPlanTask = store.getExecutionPlan(runtimeTimeoutJob.job_id).children.find(item => item.role === 'architect');
assert.ok(runtimeTimeoutArchitectPlanTask, 'runtime timeout fixture must use the immutable plan task identity');
const runtimeTimeoutChild = store.recordSpawn(runtimeTimeoutJob.job_id, {
  parentTaskId: runtimeTimeoutCto.task_id,
  role: 'architect',
  description: 'runtime timeout child',
  dependencies: runtimeTimeoutArchitectPlanTask.dependencies,
  runId: 'run-runtime-timeout',
  sessionKey: 'agent:architect:subagent:runtime-timeout-' + testSuffix,
  metadata: { workflow_plan_task_id: runtimeTimeoutArchitectPlanTask.id }
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

// Provider-backed work can legitimately have no OpenClaw session key. A stale
// EXECUTING job must not be failed while its durable GitHub run is still live.
async function createStaleProviderJob(name) {
  const created = store.createJob({ conversationKey: `${name}-${testSuffix}`, title: name });
  store.recordEvent(created.job_id, 'job.proposal_requested', {
    task: created.title, workspace: process.cwd(), workflowId: 'production', executionTarget: 'github-actions'
  }, created.job_id);
  store.approve(created.job_id, 'approval for local recovery regression', 'test-fixture', { workspace: process.cwd() });
  store.dispatch(created.job_id, { role: 'cto', description: `${name} provider recovery fixture` });
  const task = store.getTask(store.getJob(created.job_id).active_task_id);
  assert.equal(task.status, 'running');
  assert.equal(task.openclaw_session_key, null);
  store.db.prepare('UPDATE jobs SET updated_at=? WHERE job_id=?')
    .run(new Date(Date.now() - 60 * 60_000).toISOString(), created.job_id);
  return { job: store.getJob(created.job_id), task };
}

{
  const { job: providerJob, task } = await createStaleProviderJob('stale-job-live-provider-run');
  const lease = store.acquireTaskLease(task.task_id, {
    leaseId: `lease-recovery-provider-${testSuffix}`,
    workerId: 'github-actions-recovery-test', ttlMs: 60_000
  });
  // Make the lease stale so the provider-run guard is tested independently of
  // the simpler ACTIVE-lease guard below. A remote RUNNING ledger row remains
  // authoritative even after local ownership expiry.
  store.db.prepare("UPDATE task_leases SET state='EXPIRED', expires_at=?, released_at=? WHERE lease_id=?")
    .run(new Date(Date.now() - 1000).toISOString(), new Date().toISOString(), lease.lease_id);
  const now = new Date().toISOString();
  const runId = `recovery-run-${testSuffix}`;
  const dispatchKey = randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64);
  const requestHash = 'b'.repeat(64);
  store.db.prepare(`INSERT INTO provider_runs
    (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, 'github-actions', providerJob.job_id, task.task_id,
      lease.lease_id, lease.attempt, lease.owner_epoch, 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6', dispatchKey,
      requestHash, 'p3-worker.yml', 'main', 'RUNNING', null, now, now);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?,?,?,?)`).run(dispatchKey, providerJob.job_id, task.task_id,
      lease.lease_id, lease.attempt, lease.owner_epoch, 'github-actions', 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
      requestHash, '{}', 'https://api.github.com', 'p3-worker.yml', 'example/repo', 'workflow_dispatch', 'main', runId,
      'claim-recovery-provider-run', now, now, now);
  // Even an already-failed task row is not proof that a nonterminal remote run
  // can no longer produce effects. Recovery must consult the provider ledger
  // independently of the task's local status projection.
  store.db.prepare("UPDATE tasks SET status='failed', updated_at=? WHERE task_id=?").run(now, task.task_id);
  const recovery = new RecoveryManager(store, { jobStaleMs: 1000, listSessions: async () => [] });
  const result = await recovery.reconcile({ jobId: providerJob.job_id });
  assert.equal(store.getJob(providerJob.job_id).state, 'EXECUTING',
    'provider-backed work without an OpenClaw session must not be terminalized as an orphan');
  assert.ok(result.staleJobsDeferred.some(row => row.jobId === providerJob.job_id && row.reason === 'durable_lease_or_provider_outcome_unresolved'));
}

{
  const { job: claimedJob, task } = await createStaleProviderJob('stale-job-ambiguous-provider-claim');
  const lease = store.acquireTaskLease(task.task_id, {
    leaseId: `lease-recovery-claim-${testSuffix}`,
    workerId: 'github-actions-recovery-test', ttlMs: 60_000
  });
  store.db.prepare("UPDATE task_leases SET state='EXPIRED', expires_at=?, released_at=? WHERE lease_id=?")
    .run(new Date(Date.now() - 1000).toISOString(), new Date().toISOString(), lease.lease_id);
  const now = new Date().toISOString();
  const dispatchKey = 'c'.repeat(64);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?,?,?)`).run(dispatchKey, claimedJob.job_id, task.task_id,
      lease.lease_id, lease.attempt, lease.owner_epoch, 'github-actions', 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
      'd'.repeat(64), '{}', 'https://api.github.com', 'p3-worker.yml', 'example/repo', 'workflow_dispatch', 'main',
      'claim-with-no-run-id', now, now, now);
  const recovery = new RecoveryManager(store, { jobStaleMs: 1000, listSessions: async () => [] });
  const result = await recovery.reconcile({ jobId: claimedJob.job_id });
  assert.equal(store.getJob(claimedJob.job_id).state, 'EXECUTING',
    'expired local lease does not prove that a one-way remote dispatch claim had no effect');
  assert.ok(result.staleJobsDeferred.some(row => row.jobId === claimedJob.job_id && row.reason === 'durable_lease_or_provider_outcome_unresolved'));
}

console.log('test-recovery-hardening: PASS');
store.db.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.WORKFLOW_DB}${suffix}`, { force: true });
fs.rmSync(recoveryDataDir, { recursive: true, force: true });
