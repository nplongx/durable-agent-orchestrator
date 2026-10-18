import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const dataDir = tempDir('session-authorization-expiry-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/job-store.js');
const { WorkflowStore } = await import(pathToFileURL(modulePath));
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `session-auth-expiry-${process.pid}`, title: 'Session access expiry validation' });
const task = store.ensureTask(job.job_id, { role: 'cto', description: 'session authorization test' });
const session = store.createAgentSession(task.task_id, { sessionKey: `agent:cto:subagent:auth-expiry-${process.pid}`, role: 'cto' });
assert.throws(() => store.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'TAKEOVER' }),
  /grantedBy must be a non-empty string/, 'grant APIs must not default omitted actor identity to privileged system');

// Session creation and state transitions must be atomic with their lineage
// events. Inject failures after the row write and verify the old durable state
// remains visible from the live store.
let transitionSession;
{
  const secondaryJob = store.createJob({ conversationKey: `session-auth-secondary-${process.pid}`, title: 'Session creation rollback fixture' });
  const anotherTask = store.ensureTask(secondaryJob.job_id, { role: 'architect', description: 'session create rollback fixture' });
  const eventCount = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(secondaryJob.job_id).n;
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.created') throw new Error('injected session creation event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.createAgentSession(anotherTask.task_id, {
      sessionKey: `agent:architect:subagent:create-rollback-${process.pid}`, role: 'architect'
    }), /injected session creation event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.getSessionByTask(anotherTask.task_id), null,
    'failed session-created event must roll back the durable agent_sessions row');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(secondaryJob.job_id).n, eventCount);
  transitionSession = store.createAgentSession(anotherTask.task_id, {
    sessionKey: `agent:architect:subagent:transition-${process.pid}`, role: 'architect'
  });
}
{
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.state_changed') throw new Error('injected session state event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.updateAgentSession(transitionSession.session_id, { state: 'ACTIVE' }), /injected session state event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.getSession(transitionSession.session_id).state, 'CREATED',
    'failed state event persistence must roll back the session state change');
  assert.equal(store.updateAgentSession(transitionSession.session_id, { state: 'ACTIVE' }).state, 'ACTIVE');
  store.updateAgentSession(transitionSession.session_id, { state: 'STALE' });
  store.updateAgentSession(transitionSession.session_id, { state: 'ACTIVE' });
  store.updateAgentSession(transitionSession.session_id, { state: 'STALE' });
  store.updateAgentSession(transitionSession.session_id, { state: 'ACTIVE' });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.state_changed' AND json_extract(payload_json,'$.sessionId')=?")
    .get(transitionSession.job_id, transitionSession.session_id).n, 5,
  'repeated STALE/ACTIVE ownership cycles must each receive a distinct lineage event');
  store.updateAgentSession(transitionSession.session_id, { state: 'TERMINATED' });
  assert.throws(() => store.updateAgentSession(transitionSession.session_id, { state: 'ACTIVE' }), /invalid agent session state transition/,
    'terminated session must not be resurrected by a stale runtime receipt');
  assert.equal(store.getSession(transitionSession.session_id).state, 'TERMINATED');
}

const validExpiry = new Date(Date.now() + 60_000).toISOString();
store.updateAgentSession(session.session_id, { state: 'STALE' });
const grant = store.grantSessionAccess(session.session_id, {
  accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'cto', expiresAt: validExpiry
});
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), true);
assert.throws(() => store.revokeSessionAccess(grant.access_id), /revoke actor must be a non-empty string/,
  'revoke APIs must not default omitted actor identity to privileged system');
assert.equal(store.getSessionAccess(grant.access_id).revoked_at, null);
{
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.takeover') throw new Error('injected session takeover event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.takeoverAgentSession(session.session_id, { actorRole: 'architect', reason: 'fault injection' }),
      /injected session takeover event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.getSession(session.session_id).state, 'STALE',
    'failed takeover audit event must roll back the ownership state transition');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='session.takeover' AND json_extract(payload_json,'$.sessionId')=?")
    .get(job.job_id, session.session_id).n, 0);
  assert.equal(store.takeoverAgentSession(session.session_id, { actorRole: 'architect', reason: 'authorized recovery' }).state, 'ACTIVE');
}

// New grant writes and grant renewals must roll back together with their audit
// event when event persistence fails.
{
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.access_granted') throw new Error('injected session grant event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.grantSessionAccess(session.session_id, {
      accessorRole: 'qa', permission: 'MESSAGE', grantedBy: 'cto'
    }), /injected session grant event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM session_access WHERE session_id=? AND accessor_role=? AND permission=?')
    .get(session.session_id, 'qa', 'MESSAGE').n, 0,
  'failed grant event persistence must not leave an unauthorized durable grant');
}
{
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.access_updated') throw new Error('injected session grant renewal event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.grantSessionAccess(session.session_id, {
      accessorRole: 'architect', permission: 'TAKEOVER', grantedBy: 'system',
      expiresAt: new Date(Date.now() + 120_000).toISOString()
    }), /injected session grant renewal event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.getSessionAccess(grant.access_id).expires_at, validExpiry,
    'failed renewal event persistence must roll back the updated expiry and authority');
}

assert.throws(() => store.grantSessionAccess(session.session_id, {
  accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto', expiresAt: 'zzzz-unbounded-expiry'
}), /expiresAt must be a canonical UTC timestamp/,
'malformed expiry must be rejected before a durable grant is inserted');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM session_access WHERE session_id=? AND accessor_role=? AND permission=?')
  .get(session.session_id, 'architect', 'MESSAGE').n, 0);

// Simulate malformed historical/corrupt state. Lexicographic SQL comparison
// would treat this text as later than normal ISO timestamps, so permission
// evaluation must parse the stored value and fail closed instead.
store.db.prepare('UPDATE session_access SET expires_at=? WHERE access_id=?').run('zzzz-unbounded-expiry', grant.access_id);
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), false,
  'malformed durable expiry must never grant TAKEOVER');
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER', { at: 'not-a-timestamp' }), false,
  'malformed authorization evaluation time must fail closed');
assert.equal(store.hasSessionPermission(session.session_id, 123, 'TAKEOVER'), false,
  'non-string authorization identity must not be coerced');

// Null expiry means explicitly non-expiring only when it is an intentional,
// schema-valid null—not an empty string or malformed time.
store.db.prepare('UPDATE session_access SET expires_at=? WHERE access_id=?').run('', grant.access_id);
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), false);
store.db.prepare('UPDATE session_access SET expires_at=NULL WHERE access_id=?').run(grant.access_id);
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), true);
assert.equal(store.hasSessionPermission(session.session_id, 'cto', 'OBSERVE'), true,
  'the session owner keeps only the explicitly documented implicit permission set');
assert.equal(store.hasSessionPermission(session.session_id, 'cto', 'TAKEOVER'), false,
  'TAKEOVER must never be implicit for the session owner');

// Revoke is also a multi-row authorization/audit transition and must be atomic.
{
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, key) => {
    if (type === 'session.access_revoked') throw new Error('injected session revoke event failure');
    return originalRecordEvent(jobId, type, payload, key);
  };
  try {
    assert.throws(() => store.revokeSessionAccess(grant.access_id, { actor: 'cto' }), /injected session revoke event failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.getSessionAccess(grant.access_id).revoked_at, null,
    'failed revoke event persistence must roll back the revoke instead of creating an un-audited state transition');
  assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'TAKEOVER'), true);
}

const expiredGrant = store.grantSessionAccess(session.session_id, {
  accessorRole: 'qa', permission: 'MESSAGE', grantedBy: 'cto', expiresAt: new Date(Date.now() - 1000).toISOString()
});
assert.ok(expiredGrant.access_id);
assert.equal(store.hasSessionPermission(session.session_id, 'qa', 'MESSAGE'), false);

console.log('SESSION AUTHORIZATION EXPIRY / MALFORMED DURABLE GRANT FAIL-CLOSED PASS');
store.db.close();
