import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-phase3-store-'));
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'm12-phase3-test', title: 'M12 Phase 3' });
const task = store.ensureTask(job.job_id, { role: 'researcher', description: 'native specialist' });
const lease = store.acquireTaskLease(task.task_id, { leaseId: 'lease-m12-phase3', workerId: 'runner-test', ttlMs: 120000, attempt: 1 });

// Expiring a lease after a native run has been durably attached must quarantine
// the task, not return it to the runnable queue where a second turn could start.
{
  const expiryJob = store.createJob({ conversationKey: 'm12-native-expiry-test', title: 'Native run expiry fencing' });
  const expiryTask = store.ensureTask(expiryJob.job_id, { role: 'researcher', description: 'native runtime must not be replayed after expiry' });
  const expiryLease = store.acquireTaskLease(expiryTask.task_id, {
    leaseId: 'lease-m12-native-expiry', workerId: 'runner-expiry-test', ttlMs: 120000, attempt: 1
  });
  store.attachM12NativeSpecialistRuntime(expiryTask.task_id, {
    attempt: 1, sessionKey: 'agent:m12-test:expiry:1', nativeSessionId: 'native-expiry-session',
    runId: 'native-expiry-run', environmentId: 'worker:test', nodeId: 'node-test',
    leaseId: expiryLease.lease_id, ownerEpoch: expiryLease.owner_epoch,
  });
  const cutoff = new Date(Date.now() - 1000).toISOString();
  store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run(cutoff, expiryLease.lease_id);
  const expired = store.expireTaskLease(expiryLease.lease_id, {
    reason: 'native runtime lease expired with possible remote effects', expiredBefore: new Date().toISOString(), requireExpired: true
  });
  if (expired?.state !== 'FAILED') throw new Error('expired native runtime lease was not quarantined as uncertain');
  if (store.getTask(expiryTask.task_id).status !== 'failed') throw new Error('native runtime expiry was incorrectly returned to pending');
  if (store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?").get(expiryJob.job_id, expiryLease.lease_id).n !== 1) {
    throw new Error('native runtime expiry quarantine event was not durably recorded exactly once');
  }
  if (store.listRunnableTasks({ jobId: expiryJob.job_id }).some(row => row.task_id === expiryTask.task_id)) {
    throw new Error('quarantined native task re-entered the runnable queue');
  }
  if (store.expireTaskLease(expiryLease.lease_id, { reason: 'duplicate expiry must not emit another quarantine' }) !== null) {
    throw new Error('repeated native expiry was not idempotent');
  }
  console.log('M12 NATIVE RUN LEASE EXPIRY QUARANTINE / NO AUTOMATIC REPLAY PASS');
}

// A lease-to-native-runtime lookup must never choose an arbitrary row when
// corrupted history maps the same lease to multiple native turns. Such a lease
// is quarantined with explicit cardinality evidence, not reset to pending.
{
  const ambiguousJob = store.createJob({ conversationKey: 'm12-native-ambiguous-lease', title: 'Ambiguous native runtime mapping' });
  const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'researcher', description: 'duplicate native mapping must quarantine' });
  const ambiguousLease = store.acquireTaskLease(ambiguousTask.task_id, {
    leaseId: 'lease-m12-native-ambiguous', workerId: 'runner-ambiguous-test', ttlMs: 120000, attempt: 1
  });
  store.attachM12NativeSpecialistRuntime(ambiguousTask.task_id, {
    attempt: 1, sessionKey: 'agent:m12-test:ambiguous:1', nativeSessionId: 'native-ambiguous-session-1',
    runId: 'native-ambiguous-run-1', environmentId: 'worker:test', nodeId: 'node-test',
    leaseId: ambiguousLease.lease_id, ownerEpoch: ambiguousLease.owner_epoch,
  });
  store.db.prepare(`INSERT INTO m12_native_specialist_runtime
    (task_id,attempt,session_key,native_session_id,run_id,environment_id,node_id,lease_id,owner_epoch,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
      ambiguousTask.task_id, 2, 'agent:m12-test:ambiguous:2', 'native-ambiguous-session-2',
      'native-ambiguous-run-2', 'worker:test', 'node-test', ambiguousLease.lease_id,
      ambiguousLease.owner_epoch, new Date().toISOString(), new Date().toISOString()
    );
  const ambiguousResult = store.reconcileM12NativeSpecialistResult({
    taskId: ambiguousTask.task_id, attempt: 1, leaseId: ambiguousLease.lease_id,
    runId: 'native-ambiguous-run-1', nativeSessionId: 'native-ambiguous-session-1',
    status: 'SUCCEEDED', output: 'must not commit under ambiguous lease mapping',
  });
  if (ambiguousResult.status !== 'REJECTED' || ambiguousResult.reason !== 'native_runtime_lease_runtime_cardinality_mismatch') {
    throw new Error('native result reconciliation accepted an ambiguous lease-to-runtime mapping');
  }
  if (store.getTask(ambiguousTask.task_id).status !== 'running' || store.getTaskLease(ambiguousLease.lease_id).state !== 'ACTIVE' ||
      store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(ambiguousTask.task_id).n !== 0) {
    throw new Error('ambiguous native result mapping mutated task, lease or result state');
  }
  const quarantined = store.expireTaskLease(ambiguousLease.lease_id, { reason: 'ambiguous native runtime mapping' });
  if (quarantined?.state !== 'FAILED') throw new Error('ambiguous native runtime mapping was not quarantined');
  const quarantineEvent = store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?")
    .get(ambiguousJob.job_id, ambiguousLease.lease_id);
  if (!quarantineEvent || JSON.parse(quarantineEvent.payload_json).dispatchState !== 'AMBIGUOUS_NATIVE_RUNTIME_CARDINALITY') {
    throw new Error('ambiguous native runtime cardinality was not recorded in quarantine lineage');
  }
  if (store.getTask(ambiguousTask.task_id).status !== 'failed' || store.listRunnableTasks({ jobId: ambiguousJob.job_id }).some(row => row.task_id === ambiguousTask.task_id)) {
    throw new Error('ambiguous native runtime lease was reopened for replay');
  }
  console.log('M12 AMBIGUOUS LEASE-TO-NATIVE-RUNTIME CARDINALITY QUARANTINE PASS');
}

// Runtime attachment must bind its epoch to the actual durable task lease, not
// to an arbitrary caller-supplied value or a numeric string.
for (const invalid of [
  { attempt: '1', ownerEpoch: lease.owner_epoch },
  { attempt: 1, ownerEpoch: String(lease.owner_epoch) },
  { attempt: 1, ownerEpoch: lease.owner_epoch + 1 },
]) {
  let rejected = false;
  try {
    store.attachM12NativeSpecialistRuntime(task.task_id, {
      attempt: invalid.attempt, sessionKey: 'agent:m12-test:invalid:1', nativeSessionId: 'native-session-invalid',
      runId: 'native-run-invalid', environmentId: 'worker:test', nodeId: 'node-test',
      leaseId: lease.lease_id, ownerEpoch: invalid.ownerEpoch,
    });
  } catch { rejected = true; }
  if (!rejected) throw new Error('native attachment accepted a coerced or lease-mismatched identity');
  if (store.getM12NativeSpecialistRuntime(task.task_id, 1)) throw new Error('rejected native attachment leaked a runtime row');
  if (store.getTask(task.task_id).openclaw_run_id || store.getTask(task.task_id).openclaw_session_key) throw new Error('rejected native attachment mutated task identity');
  if (store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(task.task_id).n !== 0) throw new Error('rejected native attachment created an attempt');
}

const runtime = store.attachM12NativeSpecialistRuntime(task.task_id, {
  attempt: 1,
  sessionKey: 'agent:m12-test:specialist:1',
  nativeSessionId: 'native-session-1',
  runId: 'native-run-1',
  environmentId: 'worker:test',
  nodeId: 'node-test',
  leaseId: lease.lease_id,
  ownerEpoch: 1,
});
if (runtime.native_session_id !== 'native-session-1') throw new Error('native session identity was not persisted');
if (store.getTask(task.task_id).openclaw_run_id !== 'native-run-1') throw new Error('run identity was not attached');

const duplicate = store.attachM12NativeSpecialistRuntime(task.task_id, {
  attempt: 1,
  sessionKey: 'agent:m12-test:specialist:1',
  nativeSessionId: 'native-session-1',
  runId: 'native-run-1',
  environmentId: 'worker:test',
  nodeId: 'node-test',
  leaseId: lease.lease_id,
  ownerEpoch: 1,
});
if (duplicate.run_id !== 'native-run-1') throw new Error('duplicate attach was not idempotent');

// A compatibility caller cannot use an otherwise valid-looking native result
// to bypass provider evidence verification. The dedicated authenticated M12
// bridge reconciles directly only after gateway/lease/epoch identity checks.
const startedAt = new Date().toISOString();
const finishedAt = new Date(Date.parse(startedAt) + 1).toISOString();
const nativeExecutionEnvelope = {
  schema_version: 1, job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id,
  attempt: 1, owner_epoch: lease.owner_epoch, status: 'SUCCEEDED',
  input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40), exit_code: 0,
  provider_run_id: 'unverified-provider-run', evidence_artifact: 'unverified-evidence.zip',
  evidence_refs: ['result.json'], started_at: startedAt, finished_at: finishedAt,
  native_specialist: {
    session_id: 'native-session-1', run_id: 'native-run-1', session_key: 'agent:m12-test:specialist:1',
    environment_id: 'worker:test', node_id: 'node-test', owner_epoch: lease.owner_epoch,
    status: 'SUCCEEDED', output: 'must not be committed without verified evidence',
  },
};
const unverifiedNative = store.applyVerifiedExecutionResult(nativeExecutionEnvelope);
if (unverifiedNative.status !== 'REJECTED' || unverifiedNative.reason !== 'execution_evidence_not_verified') {
  throw new Error('native_specialist compatibility path bypassed evidence verification');
}
if (store.getM12NativeSpecialistRuntime(task.task_id, 1).state !== 'ACTIVE' || store.getTaskLease(lease.lease_id).state !== 'ACTIVE') {
  throw new Error('unverified native result mutated runtime or lease state');
}
if (store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n !== 0) {
  throw new Error('unverified native result leaked a durable result row');
}
const wrongJobNative = store.applyVerifiedExecutionResult({
  ...nativeExecutionEnvelope,
  job_id: 'job_wrong_binding',
  evidence_verification: { valid: true, errors: [], evidence_hash: 'a'.repeat(64) },
});
if (wrongJobNative.status !== 'REJECTED' || wrongJobNative.reason !== 'native_specialist_execution_identity_mismatch') {
  throw new Error('native compatibility envelope accepted a mismatched job/task/lease binding');
}
if (store.getM12NativeSpecialistRuntime(task.task_id, 1).state !== 'ACTIVE' ||
    store.getTaskLease(lease.lease_id).state !== 'ACTIVE' ||
    store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n !== 0) {
  throw new Error('mismatched native execution envelope mutated durable state');
}

// Malformed historical epoch types are not coerced during completion recovery.
store.db.prepare('UPDATE m12_native_specialist_runtime SET owner_epoch=? WHERE task_id=? AND attempt=?')
  .run('corrupt-epoch', task.task_id, 1);
const malformedEpochResult = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED',
  output: 'must not commit', result: { sessionId: 'native-session-1', runId: 'native-run-1' },
});
if (malformedEpochResult.status !== 'REJECTED' || malformedEpochResult.reason !== 'native_runtime_durable_identity_malformed') {
  throw new Error('malformed native runtime epoch was not explicitly rejected');
}
if (store.getM12NativeSpecialistRuntime(task.task_id, 1).state !== 'ACTIVE') throw new Error('malformed native runtime epoch mutated runtime state');
if (store.getTaskLease(lease.lease_id).state !== 'ACTIVE' || store.getTask(task.task_id).status === 'completed') {
  throw new Error('malformed runtime epoch changed task/lease state');
}
store.db.prepare('UPDATE m12_native_specialist_runtime SET owner_epoch=? WHERE task_id=? AND attempt=?')
  .run(lease.owner_epoch, task.task_id, 1);
try {
  store.reconcileM12NativeSpecialistResult({
    taskId: task.task_id, attempt: '1', leaseId: lease.lease_id,
    runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED', output: 'coerced attempt',
  });
  throw new Error('native reconciliation accepted a string attempt identity');
} catch (error) {
  if (!/positive safe-integer attempt/.test(String(error?.message || error))) throw error;
}

// Attachment is a multi-row durable transition too. Force the final lineage
// event to fail after the runtime/session/attempt writes have started and prove
// that SQLite rolls the entire attachment back before a clean retry.
const attachFailureTask = store.createChildTask(job.job_id, { parentTaskId: task.task_id, role: 'm12-attach-failure', description: 'attachment failure injection' });
const attachFailureLease = store.acquireTaskLease(attachFailureTask.task_id, { leaseId: 'lease-m12-attach-failure', workerId: 'runner-test', ttlMs: 120000, attempt: 1 });
store.db.exec(`CREATE TRIGGER fail_native_attach_event BEFORE INSERT ON events
  WHEN NEW.type = 'm12.specialist.runtime_attached'
  BEGIN SELECT RAISE(ABORT, 'injected native attach event failure'); END`);
try {
  let attachError;
  try {
    store.attachM12NativeSpecialistRuntime(attachFailureTask.task_id, {
      attempt: 1, sessionKey: 'agent:m12-test:attach-failure:1', nativeSessionId: 'native-session-attach-failure',
      runId: 'native-run-attach-failure', environmentId: 'worker:test', nodeId: 'node-test',
      leaseId: attachFailureLease.lease_id, ownerEpoch: 1,
    });
  } catch (error) { attachError = error; }
  if (!attachError || !/injected native attach event failure/.test(attachError.message)) throw new Error('native attachment failure injection did not fire');
  if (store.getM12NativeSpecialistRuntime(attachFailureTask.task_id, 1)) throw new Error('failed native attachment leaked runtime row');
  const rolledBackTask = store.getTask(attachFailureTask.task_id);
  if (rolledBackTask.openclaw_run_id || rolledBackTask.openclaw_session_key) throw new Error('failed native attachment leaked task runtime identity');
  if (store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(attachFailureTask.task_id).n !== 0) throw new Error('failed native attachment leaked active attempt');
  if (store.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id=? AND openclaw_session_key=?").get(attachFailureTask.task_id, 'agent:m12-test:attach-failure:1').n !== 0) throw new Error('failed native attachment leaked agent session');
  if (store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('task.runtime_attached','attempt.started','m12.specialist.runtime_attached') AND payload_json LIKE '%attach-failure%'").get(job.job_id).n !== 0) throw new Error('failed native attachment leaked lineage event');
} finally {
  store.db.exec('DROP TRIGGER IF EXISTS fail_native_attach_event');
}
const recoveredAttach = store.attachM12NativeSpecialistRuntime(attachFailureTask.task_id, {
  attempt: 1, sessionKey: 'agent:m12-test:attach-failure:1', nativeSessionId: 'native-session-attach-failure',
  runId: 'native-run-attach-failure', environmentId: 'worker:test', nodeId: 'node-test',
  leaseId: attachFailureLease.lease_id, ownerEpoch: 1,
});
if (recoveredAttach.state !== 'ACTIVE' || store.getTask(attachFailureTask.task_id).openclaw_run_id !== 'native-run-attach-failure') throw new Error('native attachment retry after rollback did not persist consistent state');

// Exercise real process reopen and concurrent duplicate attachment against the
// same SQLite database. Both processes must observe the same committed lineage
// rather than creating duplicate attempts/sessions or leaking partial state.
const childSource = `import { WorkflowStore } from './src/runtime/job-store.js';
const store = new WorkflowStore();
const row = store.attachM12NativeSpecialistRuntime(${JSON.stringify(attachFailureTask.task_id)}, { attempt: 1, sessionKey: 'agent:m12-test:attach-failure:1', nativeSessionId: 'native-session-attach-failure', runId: 'native-run-attach-failure', environmentId: 'worker:test', nodeId: 'node-test', leaseId: 'lease-m12-attach-failure', ownerEpoch: 1 });
if (row.state !== 'ACTIVE') throw new Error('reopened runtime is not active');
console.log('M12_ATTACH_REOPEN_OK');`;
const runChild = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(),
    env: { ...process.env, WORKFLOW_DATA_DIR: dir, WORKFLOW_DB: path.join(dir, 'workflow.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 && stdout.includes('M12_ATTACH_REOPEN_OK')
    ? resolve({ stdout, stderr })
    : reject(new Error(`M12 attachment child failed code=${code}: ${stderr} ${stdout}`)));
});
await Promise.all([runChild(), runChild()]);
if (store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(attachFailureTask.task_id).n !== 1) throw new Error('concurrent process replay created duplicate active attempts');
if (store.db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE task_id=?').get(attachFailureTask.task_id).n !== 1) throw new Error('concurrent process replay created duplicate agent sessions');
if (store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='m12.specialist.runtime_attached' AND payload_json LIKE '%native-run-attach-failure%'").get(job.job_id).n !== 1) throw new Error('concurrent process replay created duplicate native attachment events');

const wrong = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'wrong-run', nativeSessionId: 'native-session-1', status: 'SUCCEEDED'
});
if (wrong.status !== 'REJECTED' || wrong.reason !== 'native_runtime_identity_mismatch') throw new Error('wrong runtime identity was accepted');

// Inject a late ledger failure after runtime/result/task/lease updates have
// begun. All terminal state must roll back, leaving the native run recoverable.
store.db.exec(`CREATE TRIGGER fail_native_terminal_event BEFORE INSERT ON events
  WHEN NEW.type IN ('m12.specialist.completed','m12.specialist.failed')
  BEGIN SELECT RAISE(ABORT, 'injected native terminal event failure'); END`);
const beforeResults = store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n;
try {
  let injected;
  try {
    store.reconcileM12NativeSpecialistResult({
      taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
      runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED',
      output: 'native result', result: { sessionId: 'native-session-1', runId: 'native-run-1' }
    });
  } catch (error) { injected = error; }
  if (!injected || !/injected native terminal event failure/.test(injected.message)) throw new Error('terminal event failure injection did not fire');
  if (store.getM12NativeSpecialistRuntime(task.task_id, 1).state !== 'ACTIVE') throw new Error('failed reconciliation left runtime terminal');
  if (store.getTask(task.task_id).status === 'completed' || store.getTask(task.task_id).status === 'failed') throw new Error('failed reconciliation left task terminal');
  if (store.getTaskLease(lease.lease_id).state !== 'ACTIVE') throw new Error('failed reconciliation left lease terminal');
  if (store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n !== beforeResults) throw new Error('failed reconciliation leaked a result row');
} finally {
  store.db.exec('DROP TRIGGER IF EXISTS fail_native_terminal_event');
}

const completed = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED',
  output: 'native result', result: { sessionId: 'native-session-1', runId: 'native-run-1' }
});
if (completed.status !== 'COMPLETED') throw new Error(`native reconciliation failed: ${completed.status}`);
if (store.getTask(task.task_id).status !== 'completed') throw new Error('task did not complete');
if (store.getTaskLease(lease.lease_id).state !== 'COMPLETED') throw new Error('lease did not complete');
const replay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED'
});
if (replay.status !== 'IDEMPOTENT') throw new Error('terminal replay was not idempotent');
const durableNativeTerminalEvent = store.db.prepare("SELECT event_id, payload_json FROM events WHERE job_id=? AND type='m12.specialist.completed' AND json_extract(payload_json,'$.leaseId')=? AND json_extract(payload_json,'$.runId')=?")
  .get(job.job_id, lease.lease_id, 'native-run-1');
if (!durableNativeTerminalEvent) throw new Error('native terminal event missing after first completion');
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run('{"tampered":true}', durableNativeTerminalEvent.event_id);
const eventTamperedReplay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED'
});
if (eventTamperedReplay.status !== 'REJECTED' || eventTamperedReplay.reason !== 'native_terminal_result_lineage_inconsistent') {
  throw new Error('native terminal retry hid a tampered canonical terminal event');
}
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(durableNativeTerminalEvent.payload_json, durableNativeTerminalEvent.event_id);
store.db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(task.task_id);
const reopenedTaskReplay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED'
});
if (reopenedTaskReplay.status !== 'REJECTED' || reopenedTaskReplay.reason !== 'native_terminal_result_lineage_inconsistent') {
  throw new Error('native terminal retry hid a reopened/tampered task status');
}
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(task.task_id);
const conflictingOutputReplay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED', output: 'tampered replay output'
});
if (conflictingOutputReplay.status !== 'REJECTED' || conflictingOutputReplay.reason !== 'native_terminal_retry_conflicts_with_durable_result') {
  throw new Error('terminal replay accepted conflicting output bytes');
}
const conflictingNestedReplay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED',
  output: 'native result', result: { sessionId: 'native-session-1', runId: 'native-run-1', provenance: 'conflicting' }
});
if (conflictingNestedReplay.status !== 'REJECTED' || conflictingNestedReplay.reason !== 'native_terminal_retry_conflicts_with_durable_result') {
  throw new Error('terminal replay accepted conflicting nested result provenance');
}
if (store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n !== 1) {
  throw new Error('conflicting terminal replay changed durable result count');
}
if (store.getM12NativeSpecialistRuntime(task.task_id, 1).state !== 'COMPLETED' || store.getTaskLease(lease.lease_id).state !== 'COMPLETED') {
  throw new Error('conflicting terminal replay mutated completed runtime or lease state');
}
store.db.prepare("UPDATE results SET content=json_set(content, '$.result.provenance', 'tampered') WHERE result_id=?").run(completed.resultId);
const tamperedDurableReplay = store.reconcileM12NativeSpecialistResult({
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  runId: 'native-run-1', nativeSessionId: 'native-session-1', status: 'SUCCEEDED'
});
if (tamperedDurableReplay.status !== 'REJECTED' || tamperedDurableReplay.reason !== 'native_terminal_retry_conflicts_with_durable_result') {
  throw new Error('terminal replay did not detect divergence between runtime result and durable result bytes');
}

// A failed native run still settles its lifecycle attempt as completed; the
// task/result outcome carries failure. Preserve that legacy distinction when
// validating idempotent terminal callbacks.
const failedNativeJob = store.createJob({ conversationKey: 'm12-failed-native-idempotency', title: 'Failed native terminal replay compatibility' });
const failedNativeTask = store.ensureTask(failedNativeJob.job_id, { role: 'researcher', description: 'failed native attempt should be idempotent' });
const failedNativeLease = store.acquireTaskLease(failedNativeTask.task_id, {
  leaseId: 'lease-m12-failed-native-idempotency', workerId: 'runner-failed-native', ttlMs: 120000, attempt: 1
});
store.attachM12NativeSpecialistRuntime(failedNativeTask.task_id, {
  attempt: 1, sessionKey: 'agent:m12-test:failed:1', nativeSessionId: 'native-failed-session',
  runId: 'native-failed-run', environmentId: 'worker:test', nodeId: 'node-test',
  leaseId: failedNativeLease.lease_id, ownerEpoch: failedNativeLease.owner_epoch,
});
const failedNativeResult = store.reconcileM12NativeSpecialistResult({
  taskId: failedNativeTask.task_id, attempt: 1, leaseId: failedNativeLease.lease_id,
  runId: 'native-failed-run', nativeSessionId: 'native-failed-session', status: 'FAILED', output: 'expected local fixture failure'
});
if (failedNativeResult.status !== 'FAILED') throw new Error('native failure fixture did not settle as failed');
const failedNativeReplay = store.reconcileM12NativeSpecialistResult({
  taskId: failedNativeTask.task_id, attempt: 1, leaseId: failedNativeLease.lease_id,
  runId: 'native-failed-run', nativeSessionId: 'native-failed-session', status: 'FAILED', output: 'expected local fixture failure'
});
if (failedNativeReplay.status !== 'IDEMPOTENT') throw new Error('failed native terminal replay lost lifecycle attempt compatibility');

console.log('m12-phase3-reconciliation PASS');
