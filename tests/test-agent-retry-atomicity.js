import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('agent-retry-atomicity-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_DB = dbPath;
process.env.NODE_ENV = 'test';

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/job-store.js');
const { WorkflowStore } = await import(pathToFileURL(modulePath));
const store = new WorkflowStore();

function prepareFixture(label) {
  const job = store.createJob({ conversationKey: `agent-retry-${label}-${process.pid}`, title: 'Atomic agent retry' });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'approved for local test');
  const task = store.dispatch(job.job_id, { role: 'cto', description: `test same-task retry ${label}` });
  const runId = `agent-retry-run-${label}-${process.pid}`;
  const sessionKey = `agent:cto:subagent:retry-${label}-${process.pid}`;
  store.attachOpenClawRun(job.job_id, {
    runId,
    sessionKey
  });
  const session = store.getSessionByTask(task.task_id);
  assert.ok(session, 'fixture must have a registered durable agent session');
  store.db.prepare("UPDATE agent_sessions SET state='STALE' WHERE session_id=?").run(session.session_id);
  store.grantSessionAccess(session.session_id, {
    accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto'
  });
  return { job, task: store.getTask(task.task_id), session: store.getSession(session.session_id) };
}

// A late write failure must roll back takeover/session events, attempt state,
// and the task retry event as one logical operation.
{
  const fixture = prepareFixture('injected-failure');
  const before = {
    task: store.getTask(fixture.task.task_id),
    session: store.getSession(fixture.session.session_id),
    attemptCount: store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n,
    eventCount: store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n
  };
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.retry_started') throw new Error('injected task retry event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.beginAgentRetry(fixture.task.task_id, {
      actorRole: 'architect', reason: 'fault injection'
    }), /injected task retry event persistence failure/);
  } finally { store.recordEvent = originalRecordEvent; }

  assert.equal(store.getTask(fixture.task.task_id).status, before.task.status);
  assert.equal(store.getSession(fixture.session.session_id).state, 'STALE');
  assert.equal(store.getSession(fixture.session.session_id).attempt, before.session.attempt);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n, before.attemptCount);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(fixture.task.task_id).n, 1,
    'failure rollback must preserve the original active attempt');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n, before.eventCount,
    'no partial takeover/retry event may survive the failed transaction');

  const retried = store.beginAgentRetry(fixture.task.task_id, {
    actorRole: 'architect', reason: 'retry after rolled back write'
  });
  assert.equal(retried.attempt, 2);
  assert.equal(retried.session.state, 'ACTIVE');
  assert.equal(retried.task.status, 'running');
  assert.equal(retried.attemptRecord.status, 'started');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(fixture.task.task_id).n, 1,
    'successful retry must leave exactly one live attempt');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='failed'").get(fixture.task.task_id).n, 1,
    'successful retry must settle exactly one previous stale attempt');
  assert.throws(() => store.beginAgentRetry(fixture.task.task_id, {
    actorRole: 'architect', reason: 'duplicate while active'
  }), /requires STALE, FAILED, or PAUSED/,
  'duplicate retry request must not create a second attempt while the session is active');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(fixture.task.task_id).n, 1);
  console.log('AGENT RETRY EVENT-WRITE FAILURE ROLLBACK / RETRY / DUPLICATE GUARD PASS');
}

// Kill a second process after takeover state/events have been written but before
// the retry attempt and terminal retry event. A separate SQLite connection must
// observe the pre-retry state: the outer savepoint fences interrupted writes.
{
  const fixture = prepareFixture('sigkill');
  const baseline = {
    taskStatus: fixture.task.status,
    sessionAttempt: fixture.session.attempt,
    attemptCount: store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n,
    eventCount: store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n
  };
  const source = `
    const { WorkflowStore } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const store = new WorkflowStore();
    store.beginAgentRetry(${JSON.stringify(fixture.task.task_id)}, { actorRole: 'architect', reason: 'SIGKILL atomicity test' });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_AGENT_RETRY_TAKEOVER: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `child must die inside the retry savepoint: ${child.stderr}`);

  const independent = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    assert.equal(independent.prepare('SELECT status FROM tasks WHERE task_id=?').get(fixture.task.task_id).status, baseline.taskStatus);
    const session = independent.prepare('SELECT state,attempt FROM agent_sessions WHERE session_id=?').get(fixture.session.session_id);
    assert.equal(session.state, 'STALE');
    assert.equal(session.attempt, baseline.sessionAttempt);
    assert.equal(independent.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n, baseline.attemptCount);
    assert.equal(independent.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n, baseline.eventCount,
      'uncommitted takeover and retry events must disappear after writer process death');
  } finally { independent.close(); }
  const recovered = store.beginAgentRetry(fixture.task.task_id, {
    actorRole: 'architect', reason: 'retry after SIGKILL rollback'
  });
  assert.equal(recovered.attempt, 2);
  assert.equal(recovered.session.state, 'ACTIVE');
  console.log('AGENT RETRY SIGKILL / INDEPENDENT SQLITE REOPEN / SAFE RECOVERY PASS');
}

// Validate arguments before acquiring any durable state. In particular a truthy
// object must not be stringified into an audit reason or authorization identity.
{
  const fixture = prepareFixture('input-validation');
  const eventCount = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n;
  assert.throws(() => store.beginAgentRetry(fixture.task.task_id, { actorRole: 'architect', reason: { detail: 'bad' } }),
    /retry reason must be a non-empty string/);
  assert.throws(() => store.beginAgentRetry(fixture.task.task_id, { actorRole: 42 }),
    /retry actorRole must be a non-empty string/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n, eventCount);
  assert.equal(store.getSession(fixture.session.session_id).state, 'STALE');
  const activeLease = store.acquireTaskLease(fixture.task.task_id, {
    leaseId: `agent-retry-blocked-lease-${process.pid}`, workerId: 'provider-worker', ttlMs: 60_000, attempt: 1
  });
  const attemptsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n;
  const eventsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n;
  assert.throws(() => store.beginAgentRetry(fixture.task.task_id, {
    actorRole: 'architect', reason: 'must not race active provider lease'
  }), /prior task lease to be settled or quarantined/);
  assert.equal(store.getTaskLease(activeLease.lease_id).state, 'ACTIVE');
  assert.equal(store.getSession(fixture.session.session_id).state, 'STALE');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(fixture.task.task_id).n, attemptsBefore);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(fixture.job.job_id).n, eventsBefore,
    'retry must not mutate task/session/event state while an independent active lease remains');
}

console.log('test-agent-retry-atomicity: PASS');
store.db.close();
