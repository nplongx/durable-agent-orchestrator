import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const testDb = `/home/long/work/chatgpt-adapter/data/test-workflow-${crypto.randomUUID()}.db`;
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
  senderRole: 'cto', recipientRole: 'architect', payload: { duplicate: true }, dedupeKey: 'phase3-command-1'
}).message_id, queuedMessage.message_id);
const deliveredMessage = store.claimNextSessionMessage(ctoSession.session_id, { recipientRole: 'architect', leaseMs: 60_000 });
assert.strictEqual(deliveredMessage.status, 'DELIVERED');
assert.strictEqual(deliveredMessage.attempt, 1);
assert.throws(() => store.ackSessionMessage(queuedMessage.message_id, { recipientRole: 'qa' }), /Session access denied|Message recipient mismatch/);
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
assert.strictEqual(parseOpenClawAgentReceipt('plain reply').status, 'NON_JSON');

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
assert.strictEqual(store.getActiveJob(conversationKey), null);

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
store.dispatch(noChildJob.job_id, { role: 'cto', description: 'Delegate specialist work with sessions_spawn' });
const noChildResult = store.complete(noChildJob.job_id, 'CTO says done', 'success');
assert.strictEqual(noChildResult.status, 'failed');
assert.strictEqual(noChildResult.state, 'IDLE');

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

fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-wal`, { force: true });
fs.rmSync(`${testDb}-shm`, { force: true });
console.log('PASS: Phase 2 Job/Task/Approval/Event store, idempotency, completion and restart persistence');
