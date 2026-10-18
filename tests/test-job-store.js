import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-job-store-private-'));
fs.chmodSync(testDataDir, 0o700);
const testDb = path.join(testDataDir, `test-workflow-${crypto.randomUUID()}.db`);
process.env.WORKFLOW_DB = testDb;
process.env.WORKFLOW_DATA_DIR = path.dirname(testDb);

const { WorkflowStore, conversationKeyFromMessages } = await import('../job-store.js');
const { parseOpenClawAgentReceipt } = await import('../session-transport.js');

const store = new WorkflowStore();
const messages = [{ role: 'user', content: 'Triển khai Phase 2 durable workflow.' }];
const conversationKey = conversationKeyFromMessages(messages);

const job = store.getOrCreateJob({ conversationKey, title: messages[0].content });
assert.strictEqual(job.state, 'IDLE');
assert.strictEqual(job.status, 'active');

store.transition(job.job_id, 'PROPOSED');
store.recordEvent(job.job_id, 'job.proposal_requested', { task: job.title }, job.title);
store.recordEvent(job.job_id, 'job.proposal_requested', { task: job.title }, job.title);
assert.strictEqual(store.getStats().events, 1);

store.approve(job.job_id, 'Duyệt, triển khai đi.');
const task = store.dispatch(job.job_id, { role: 'cto', description: job.title });
assert.strictEqual(store.getJob(job.job_id).state, 'EXECUTING');
assert.strictEqual(task.status, 'running');

store.attachOpenClawRun(job.job_id, { runId: 'run-test-1', sessionKey: 'agent:cto:subagent:test' });
const runningTask = store.getJob(job.job_id);
assert.ok(runningTask.active_task_id);
const ctoSession = store.getSessionByTask(runningTask.active_task_id);
assert.ok(ctoSession);
assert.strictEqual(ctoSession.openclaw_session_key, 'agent:cto:subagent:test');
assert.strictEqual(ctoSession.role, 'cto');
assert.strictEqual(ctoSession.state, 'ACTIVE');
const heartbeatAt = ctoSession.last_activity_at;
const heartbeat = store.heartbeatAgentSession(ctoSession.session_id, { currentTurnId: 'turn-test-1' });
assert.strictEqual(heartbeat.current_turn_id, 'turn-test-1');
assert.ok(heartbeat.last_activity_at >= heartbeatAt);
assert.strictEqual(store.getSessionByOpenClawKey('agent:cto:subagent:test').session_id, ctoSession.session_id);
assert.strictEqual(store.listAgentSessions({ jobId: job.job_id }).length, 1);
const observeGrant = store.grantSessionAccess(ctoSession.session_id, {
  accessorRole: 'architect', permission: 'OBSERVE', grantedBy: 'cto'
});
assert.strictEqual(observeGrant.permission, 'OBSERVE');
assert.strictEqual(store.hasSessionPermission(ctoSession.session_id, 'architect', 'OBSERVE'), true);
assert.strictEqual(store.hasSessionPermission(ctoSession.session_id, 'architect', 'MESSAGE'), false);
assert.throws(() => store.attachAgentSession(ctoSession.session_id, { actorRole: 'architect', mode: 'interact' }), /Session access denied/);
const messageGrant = store.grantSessionAccess(ctoSession.session_id, {
  accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto',
  expiresAt: new Date(Date.now() + 60_000).toISOString()
});
assert.strictEqual(store.attachAgentSession(ctoSession.session_id, { actorRole: 'architect', mode: 'interact' }).permission, 'MESSAGE');
assert.ok(store.revokeSessionAccess(messageGrant.access_id, { actor: 'cto' }).revoked_at);
assert.strictEqual(store.hasSessionPermission(ctoSession.session_id, 'architect', 'MESSAGE'), false);
assert.throws(() => store.attachAgentSession(ctoSession.session_id, { actorRole: 'architect', mode: 'interact' }), /Session access denied/);
assert.throws(() => store.takeoverAgentSession(ctoSession.session_id, { actorRole: 'architect' }), /Session access denied/);
store.updateAgentSession(ctoSession.session_id, { state: 'STALE' });
const takeoverGrant = store.grantSessionAccess(ctoSession.session_id, { accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto' });
assert.strictEqual(store.takeoverAgentSession(ctoSession.session_id, { actorRole: 'architect', reason: 'recovery test' }).state, 'ACTIVE');
assert.ok(takeoverGrant.access_id);
assert.throws(() => store.grantSessionAccess(ctoSession.session_id, { accessorRole: 'qa', permission: 'INVALID', grantedBy: 'cto' }), /Invalid session permission/);
store.grantSessionAccess(ctoSession.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });

// Phase 3: durable session inbox, delivery lease, ACK, idempotent enqueue and retry.
const queuedMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect',
  payload: { command: 'node --check /home/long/work/chatgpt-adapter/server.js' },
  correlationId: 'turn-phase3-1', dedupeKey: 'phase3-command-1'
});
assert.strictEqual(queuedMessage.status, 'QUEUED');
assert.strictEqual(store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect',
  payload: { command: 'node --check /home/long/work/chatgpt-adapter/server.js' },
  correlationId: 'turn-phase3-1', dedupeKey: 'phase3-command-1'
}).message_id, queuedMessage.message_id);
assert.throws(() => store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { command: 'unreviewed substituted command' },
  correlationId: 'substituted-correlation', dedupeKey: 'phase3-command-1'
}), /dedupe key conflicts with existing durable message payload/,
'reusing a queue dedupe key with changed command/correlation must not silently return the prior message');
const deliveredMessage = store.claimNextSessionMessage(ctoSession.session_id, { recipientRole: 'architect', leaseMs: 60_000 });
assert.strictEqual(deliveredMessage.status, 'DELIVERED');
assert.strictEqual(deliveredMessage.attempt, 1);
assert.throws(() => store.ackSessionMessage(queuedMessage.message_id, { recipientRole: 'qa' }), /Session access denied|Message recipient mismatch/);
store.recordSessionDeliveryStarted(queuedMessage.message_id, {
  attempt: deliveredMessage.attempt, leaseUntil: deliveredMessage.lease_until
});
store.recordSessionDeliveryReceipt(queuedMessage.message_id, {
  attempt: deliveredMessage.attempt, status: 'OK', runId: 'job-store-ack-proof-run',
  sessionKey: ctoSession.openclaw_session_key, response: { accepted: true }, error: null
});
assert.strictEqual(store.ackSessionMessage(queuedMessage.message_id, { recipientRole: 'architect' }).status, 'ACKED');
assert.strictEqual(store.claimNextSessionMessage(ctoSession.session_id, { recipientRole: 'architect' }), null);

const retryMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { kind: 'retry-test' }, dedupeKey: 'phase3-retry-1'
});
const firstDelivery = store.claimSessionMessage(retryMessage.message_id, { recipientRole: 'architect', leaseMs: 1 });
assert.strictEqual(firstDelivery.attempt, 1);
await new Promise(resolve => setTimeout(resolve, 5));
const retryCount = store.retryExpiredSessionMessages({ sessionId: ctoSession.session_id, maxAttempts: 3 });
assert.strictEqual(retryCount, 1);
assert.strictEqual(store.getSessionMessage(retryMessage.message_id).status, 'QUEUED');
const secondDelivery = store.claimSessionMessage(retryMessage.message_id, { recipientRole: 'architect', leaseMs: 60_000 });
assert.strictEqual(secondDelivery.attempt, 2);
assert.strictEqual(store.retrySessionMessage(retryMessage.message_id, { error: 'test retry' }).status, 'QUEUED');
assert.strictEqual(store.getJobTrace(job.job_id).sessionMessages.length >= 2, true);
const transportMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { kind: 'transport-test' }, dedupeKey: 'phase35-transport-1'
});
const transportResult = await store.deliverSessionMessage(transportMessage.message_id, async (session, message) => ({
  status: 'OK', runId: 'transport-run-1', sessionKey: session.openclaw_session_key,
  result: `delivered:${message.message_id}`
}));
assert.strictEqual(transportResult.status, 'ACKED');
assert.strictEqual(store.getSessionMessage(transportMessage.message_id).status, 'ACKED');
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'session.message_receipt'));
assert.strictEqual(parseOpenClawAgentReceipt('{"runId":"r1","sessionKey":"agent:architect:subagent:test","result":"ok"}').runId, 'r1');
assert.strictEqual(parseOpenClawAgentReceipt('plain reply').status, 'ERROR');

// Phase 3.6: lease recovery, exponential backoff, dead-letter and restart reconciliation.
const backoffMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { kind: 'backoff-test' }, dedupeKey: 'phase36-backoff-1'
});
const backoffFirst = store.claimSessionMessage(backoffMessage.message_id, { recipientRole: 'architect', leaseMs: 1 });
assert.strictEqual(backoffFirst.attempt, 1);
await new Promise(resolve => setTimeout(resolve, 5));
assert.strictEqual(store.reconcileSessionDelivery({ sessionId: ctoSession.session_id, maxAttempts: 5, baseDelayMs: 20, maxDelayMs: 100 }), 1);
const backoffQueued = store.getSessionMessage(backoffMessage.message_id);
assert.strictEqual(backoffQueued.status, 'QUEUED');
assert.ok(new Date(backoffQueued.available_at).getTime() - Date.now() >= 10);
await new Promise(resolve => setTimeout(resolve, 25));
const backoffSecond = store.claimSessionMessage(backoffMessage.message_id, { recipientRole: 'architect', leaseMs: 1 });
assert.strictEqual(backoffSecond.attempt, 2);
await new Promise(resolve => setTimeout(resolve, 5));
store.retrySessionMessage(backoffMessage.message_id, { error: 'second failure', baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 5 });
const backoffQueued2 = store.getSessionMessage(backoffMessage.message_id);
assert.ok(new Date(backoffQueued2.available_at).getTime() - Date.now() >= 15);

const deadMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { kind: 'dead-letter-test' }, dedupeKey: 'phase36-dead-1'
});
store.claimSessionMessage(deadMessage.message_id, { recipientRole: 'architect', leaseMs: 1 });
await new Promise(resolve => setTimeout(resolve, 5));
assert.strictEqual(store.reconcileSessionDelivery({ sessionId: ctoSession.session_id, maxAttempts: 1, baseDelayMs: 1 }), 1);
assert.strictEqual(store.getSessionMessage(deadMessage.message_id).status, 'FAILED');
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'session.message_failed'));

const restartMessage = store.enqueueSessionMessage(ctoSession.session_id, {
  senderRole: 'cto', recipientRole: 'architect', payload: { kind: 'restart-recovery-test' }, dedupeKey: 'phase36-restart-1'
});
store.claimSessionMessage(restartMessage.message_id, { recipientRole: 'architect', leaseMs: 1 });
await new Promise(resolve => setTimeout(resolve, 5));
const restartedStore = new WorkflowStore();
assert.strictEqual(restartedStore.reconcileSessionDelivery({ sessionId: ctoSession.session_id, baseDelayMs: 1 }), 1);
assert.strictEqual(restartedStore.getSessionMessage(restartMessage.message_id).status, 'QUEUED');
assert.strictEqual(restartedStore.getSessionMessage(restartMessage.message_id).attempt, 1);
assert.strictEqual(restartedStore.getSessionMessage(transportMessage.message_id).status, 'ACKED');

store.complete(job.job_id, 'E2E PASS 100%', 'success');
const completed = store.getJob(job.job_id);
assert.strictEqual(completed.status, 'completed');
assert.strictEqual(completed.state, 'COMPLETED');
assert.strictEqual(store.complete(job.job_id, 'idempotent legacy success', 'success').idempotent, true,
  'legacy completed Job success replay remains idempotent');
assert.strictEqual(store.getActiveJob(conversationKey), null);

const legacyFailedJob = store.getOrCreateJob({
  conversationKey: `${conversationKey}:legacy-idle-failed`, title: 'Preserve legacy IDLE/failed completion semantics'
});
store.transition(legacyFailedJob.job_id, 'IDLE', 'failed');
assert.strictEqual(store.complete(legacyFailedJob.job_id, 'legacy failure replay', 'failure').idempotent, true,
  'legacy IDLE/failed Job state must remain an idempotent failure replay');
assert.strictEqual(store.complete(legacyFailedJob.job_id, 'late success callback', 'success').idempotent, true,
  'legacy IDLE/failed late callbacks remain no-op idempotent for compatibility');
assert.equal(store.getJob(legacyFailedJob.job_id).status, 'failed', 'legacy late success must not rewrite failed Job status');

const afterRestart = new WorkflowStore();
assert.strictEqual(afterRestart.getJob(job.job_id).status, 'completed');
assert.ok(afterRestart.getStats().events >= 4);

// CTO delegation invariant: a successful CTO completion without specialist
// children must fail the durable Job instead of silently completing it.
const noChildJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':no-child',
  title: 'Delegate specialist work with sessions_spawn'
});
store.transition(noChildJob.job_id, 'PROPOSED');
store.approve(noChildJob.job_id, 'Duyệt');
const noChildTask = store.dispatch(noChildJob.job_id, { role: 'cto', description: 'Delegate specialist work with sessions_spawn' });
const noChildResult = store.complete(noChildJob.job_id, 'CTO says done', 'success');
assert.strictEqual(noChildResult.status, 'failed');
assert.strictEqual(noChildResult.state, 'IDLE');
const noChildResultCount = store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(noChildTask.task_id).n;
const noChildTerminalEventCount = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')")
  .get(noChildJob.job_id).n;
const lateLegacySuccess = store.complete(noChildJob.job_id, 'late stale CTO success', 'success');
assert.equal(lateLegacySuccess.idempotent, true,
  'legacy IDLE/failed state must be treated as terminal based on status as well as state');
assert.equal(store.getJob(noChildJob.job_id).state, 'IDLE');
assert.equal(store.getJob(noChildJob.job_id).status, 'failed');
assert.throws(() => store.transition(noChildJob.job_id, 'EXECUTING', 'active'), /cannot transition terminal Job/,
  'direct state-transition callers must not reopen a legacy IDLE/failed terminal Job');
assert.equal(store.getJob(noChildJob.job_id).state, 'IDLE');
assert.equal(store.getJob(noChildJob.job_id).status, 'failed');
assert.throws(() => store.approve(noChildJob.job_id, 'late approval'), /cannot approve terminal\/inactive Job/,
  'approval writer must not reopen a legacy IDLE/failed terminal Job');
assert.throws(() => store.dispatch(noChildJob.job_id, { role: 'cto', description: 'late dispatch' }), /dispatch requires an active approved Job/,
  'direct dispatch writer must not reopen a terminal Job');
assert.throws(() => store.createChildTask(noChildJob.job_id, { role: 'qa', description: 'late replayed child' }), /cannot create child task for terminal\/inactive Job/,
  'transcript replay must not create child tasks after the Job is terminal');
assert.throws(() => store.ensureTask(noChildJob.job_id, { role: 'qa', description: 'late replayed task' }), /cannot create task for terminal\/inactive Job/,
  'direct ensureTask writer must not add runnable tasks after the Job is terminal');
assert.throws(() => store.beginRuntimeAttempt(noChildTask.task_id, { runId: 'late-runtime-attempt' }), /runtime attempt requires an active executing Job and nonterminal task/,
  'a direct runtime-attempt writer must not resurrect a terminal Job/task');
assert.throws(() => store.rearmTaskRuntime(noChildTask.task_id, { runId: 'late-runtime-rearm' }), /runtime rearm requires an active executing Job and nonterminal task/,
  'runtime rearm must not resurrect a terminal Job/task');
assert.equal(store.getJob(noChildJob.job_id).state, 'IDLE');
assert.equal(store.getJob(noChildJob.job_id).status, 'failed');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(noChildTask.task_id).n, noChildResultCount,
  'a late success must not append a result to a legacy job whose durable status is failed');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')")
  .get(noChildJob.job_id).n, noChildTerminalEventCount,
  'a late success must not add terminal events to a legacy failed job');

const staleAttachJob = store.createJob({ conversationKey: `${conversationKey}:stale-attach`, title: 'Fence runtime attachment to terminal parent' });
const staleAttachTask = store.ensureTask(staleAttachJob.job_id, { role: 'qa', description: 'must remain pending after terminal parent' });
store.db.prepare("UPDATE jobs SET state='FAILED', status='failed' WHERE job_id=?").run(staleAttachJob.job_id);
assert.throws(() => store.attachTaskRuntime(staleAttachTask.task_id, { runId: 'late-attach-run', sessionKey: 'agent:qa:late-attach' }),
  /runtime attach requires an active nonterminal parent Job/);
assert.equal(store.getTask(staleAttachTask.task_id).status, 'pending');
assert.equal(store.getTask(staleAttachTask.task_id).openclaw_run_id, null);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(staleAttachTask.task_id).n, 0);
const staleSpawnTaskCount = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(staleAttachJob.job_id).n;
assert.throws(() => store.recordSpawn(staleAttachJob.job_id, {
  role: 'qa', description: 'must not partially create a child after parent terminalization', runId: 'late-spawn-run'
}), /cannot create child task for terminal\/inactive Job/);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(staleAttachJob.job_id).n, staleSpawnTaskCount);

// CTO completion with a completed specialist child may complete the Job.
const childJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':with-child',
  title: 'Delegate specialist work with sessions_spawn'
});
store.transition(childJob.job_id, 'PROPOSED');
store.approve(childJob.job_id, 'Duyệt');
const ctoTask = store.dispatch(childJob.job_id, { role: 'cto', description: 'Delegate specialist work with sessions_spawn' });
const childTask = store.createChildTask(childJob.job_id, {
  parentTaskId: ctoTask.task_id,
  role: 'qa',
  description: 'Run exact verification command'
});
store.attachTaskRuntime(childTask.task_id, { runId: 'run-child-1', sessionKey: 'agent:qa:subagent:test' });
const childSession = store.getSessionByTask(childTask.task_id);
assert.ok(childSession);
assert.strictEqual(childSession.role, 'qa');
assert.strictEqual(childSession.state, 'ACTIVE');
store.completeTaskByRuntime(childJob.job_id, {
  runId: 'run-child-1',
  content: 'Exact command: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js\nstdout: (empty)\nstderr: (empty)\nexit status: 0',
  outcome: 'success'
});
const childResult = store.complete(childJob.job_id, 'CTO synthesized child evidence', 'success');
assert.strictEqual(childResult.status, 'completed');
assert.strictEqual(childResult.state, 'COMPLETED');

// Runtime reconciliation race: a CTO transcript may arrive before the
// coordinator's own spawn receipt. Child runIds must never be attached to CTO.
const raceJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':runtime-race',
  title: 'sessions_spawn runtime reconciliation race'
});
store.transition(raceJob.job_id, 'PROPOSED');
store.approve(raceJob.job_id, 'Duyệt');
store.dispatch(raceJob.job_id, { role: 'cto', description: 'Use sessions_spawn for specialist delegation' });
store.reconcileRuntimeRefs(raceJob.job_id, [{
  role: 'assistant',
  tool_calls: [{
    function: {
      name: 'sessions_spawn',
      arguments: JSON.stringify({ agentId: 'architect', task: 'run exact command' })
    }
  }]
}, {
  role: 'tool',
  content: JSON.stringify({ runId: 'child-run-race', childSessionKey: 'agent:architect:subagent:race' })
}]);
let raceTrace = store.getJobTrace(raceJob.job_id);
const raceCto = raceTrace.tasks.find(t => t.role === 'cto');
const raceChild = raceTrace.tasks.find(t => t.role === 'architect');
assert.strictEqual(raceCto.openclaw_run_id, null);
assert.strictEqual(raceChild.openclaw_run_id, 'child-run-race');
store.reconcileRuntimeRefs(raceJob.job_id, [{
  role: 'assistant',
  tool_calls: [{
    function: {
      name: 'sessions_spawn',
      arguments: JSON.stringify({ agentId: 'cto', task: 'delegate specialist work' })
    }
  }]
}, {
  role: 'tool',
  content: JSON.stringify({ runId: 'cto-run-race', childSessionKey: 'agent:cto:subagent:race' })
}]);
raceTrace = store.getJobTrace(raceJob.job_id);
assert.strictEqual(raceTrace.tasks.find(t => t.role === 'cto').openclaw_run_id, 'cto-run-race');

// Specialist refusal/prose-only completion must not count as execution success.
const evidenceJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':evidence-validation',
  title: 'specialist execution evidence validation'
});
store.transition(evidenceJob.job_id, 'PROPOSED');
store.approve(evidenceJob.job_id, 'Duyệt');
const evidenceCto = store.dispatch(evidenceJob.job_id, {
  role: 'cto',
  description: 'Delegate specialist execution via sessions_spawn'
});
const evidenceChild = store.createChildTask(evidenceJob.job_id, {
  parentTaskId: evidenceCto.task_id,
  role: 'architect',
  description: 'Run the exact command immediately: node --check /home/long/work/chatgpt-adapter/server.js.'
});
store.attachTaskRuntime(evidenceChild.task_id, { runId: 'evidence-run', sessionKey: 'agent:architect:subagent:evidence' });
const rejected = store.completeTaskByRuntime(evidenceJob.job_id, {
  runId: 'evidence-run',
  content: 'Không thể cung cấp kết quả execution vì không có native OpenClaw exec tool khả dụng.',
  outcome: 'success'
});
assert.strictEqual(rejected.status, 'failed');
assert.strictEqual(store.getJob(evidenceJob.job_id).state, 'EXECUTING');
console.log('PASS: specialist refusal/prose-only result is rejected as failed');

// Restart reconciliation must not infer task completion from a result row,
// especially when created_at ties make multiple rows share one timestamp.
const lineageJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':result-reconciliation-lineage',
  title: 'result reconciliation requires exact terminal lineage'
});
store.transition(lineageJob.job_id, 'PROPOSED');
store.approve(lineageJob.job_id, 'Duyệt');
const lineageTask = store.dispatch(lineageJob.job_id, { role: 'architect', description: 'lineage reconciliation fixture' });
const lineageAttempt = store.startAttempt(lineageJob.job_id);
store.db.prepare("UPDATE attempts SET status='completed',finished_at=? WHERE attempt_id=? AND status='started'")
  .run(new Date().toISOString(), lineageAttempt.attempt_id);
const tiedTimestamp = new Date().toISOString();
store.db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)')
  .run('lineage-result-older', lineageTask.task_id, 'success', 'older success', tiedTimestamp);
store.db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)')
  .run('lineage-result-latest', lineageTask.task_id, 'success', 'latest success', tiedTimestamp);
store.reconcileRuntimeRefs(lineageJob.job_id, []);
assert.equal(store.getTask(lineageTask.task_id).status, 'running',
  'an isolated result and settled attempt cannot terminalize a task without its exact completion event');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.result_reconciliation_blocked' AND json_extract(payload_json,'$.resultId')='lineage-result-latest'")
  .get(lineageJob.job_id).n, 1, 'missing terminal lineage must be explicitly quarantined');
store.recordEvent(lineageJob.job_id, 'task.completed', {
  taskId: lineageTask.task_id,
  resultId: 'lineage-result-latest',
  attemptId: lineageAttempt.attempt_id,
  outcome: 'success'
}, `${lineageTask.task_id}|success|lineage-result-latest`);
store.reconcileRuntimeRefs(lineageJob.job_id, []);
assert.equal(store.getTask(lineageTask.task_id).status, 'completed',
  'reconciliation may terminalize only after the latest tied-timestamp result has exactly matching attempt/event lineage');
assert.throws(() => store.transition(lineageJob.job_id, 'PROPOSED'), /illegal active Job state transition/,
  'a stale coordinator turn must not move an executing Job back into proposal state');
assert.equal(store.getJob(lineageJob.job_id).state, 'EXECUTING');

const terminalTaskJob = store.getOrCreateJob({
  conversationKey: conversationKey + ':terminal-task-no-job-promotion',
  title: 'terminal task cannot promote active job'
});
store.transition(terminalTaskJob.job_id, 'PROPOSED');
store.approve(terminalTaskJob.job_id, 'Duyệt');
const terminalTask = store.dispatch(terminalTaskJob.job_id, { role: 'architect', description: 'failed terminal task fixture' });
const terminalTaskAttempt = store.startAttempt(terminalTaskJob.job_id);
const terminalTaskResultId = 'terminal-task-failure-result';
const terminalTaskTs = new Date().toISOString();
store.db.prepare("UPDATE tasks SET status='failed' WHERE task_id=?").run(terminalTask.task_id);
store.db.prepare("UPDATE attempts SET status='failed',finished_at=? WHERE attempt_id=? AND status='started'")
  .run(terminalTaskTs, terminalTaskAttempt.attempt_id);
store.db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)')
  .run(terminalTaskResultId, terminalTask.task_id, 'failure', 'durable task failure', terminalTaskTs);
store.recordEvent(terminalTaskJob.job_id, 'task.failed', {
  taskId: terminalTask.task_id,
  resultId: terminalTaskResultId,
  attemptId: terminalTaskAttempt.attempt_id,
  outcome: 'failure'
}, `${terminalTask.task_id}|failure|${terminalTaskResultId}`);
assert.throws(() => store.complete(terminalTaskJob.job_id, 'late success-shaped synthesis', 'success'),
  /contradictory already-terminal task outcome/,
  'a failed task with valid failure lineage must not be promoted to a completed Job by a late success callback');
assert.equal(store.getJob(terminalTaskJob.job_id).state, 'EXECUTING');
assert.equal(store.getJob(terminalTaskJob.job_id).status, 'active');
assert.equal(store.getTask(terminalTask.task_id).status, 'failed');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(terminalTask.task_id).n, 1);

fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-wal`, { force: true });
fs.rmSync(`${testDb}-shm`, { force: true });
fs.rmSync(testDataDir, { recursive: true, force: true });
console.log('PASS: Phase 2 Job/Task/Approval/Event store, idempotency, completion and restart persistence');
