import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-batch-terminal-recovery-');
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(dataDir, 'runtime');
const dbPath = path.join(dataDir, 'workflow.db');
const tmuxStub = path.join(root, 'tmux-control-stub');
const tmuxLog = path.join(root, 'tmux-control.log');
const shouldNeverRun = path.join(root, 'command-must-not-run');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root,
  EXECUTION_TMP_DIR: runtimeDir, NODE_ENV: 'test'
});
fs.writeFileSync(tmuxStub, `#!/bin/sh
case "$1" in
  new-session) printf 'new-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  display-message) printf '12345\\n'; exit 0 ;;
  kill-session) printf 'kill-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  has-session) printf 'session remains active\\n' >&2; exit 0 ;;
  *) exit 31 ;;
esac
`, { flag: 'wx', mode: 0o700 });
fs.chmodSync(tmuxStub, 0o700);

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();

try {
  const job = store.createJob({ conversationKey: `batch-terminal-recovery-${process.pid}`, title: 'Batch terminal-task recovery' });
  store.approve(job.job_id, 'isolated terminal recovery fixture', 'test-fixture');
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'batch recovery parent' });

  // Simulate a crash after the task's complete terminal ledger commits but
  // before finishExecutionBatchItem runs. Recovery must use the immutable
  // batch claim embedded in execution.started and replay the durable terminal
  // validator; it must not launch the task again.
  const command = "node -e \"process.stdout.write('DURABLE_TERMINAL_RESULT')\"";
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'terminal result awaiting batch-item persistence',
    metadata: { deterministic: true, command }
  });
  const batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: task.task_id, command }]
  });
  const item = store.listExecutionBatchItems(batch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(batch.batch_id, item.item_id, { expectedAttempt: 1 }));
  store.prepareExecutionForBatchClaim(task.task_id, {
    executionSessionId: 'exec-durable-terminal-batch-fixture', attempt: 1, command, cwd: root,
    startedAt: new Date().toISOString(), tmuxName: 'cos-exec-durable-terminal-batch-fixture', boundaryIdentity: null
  }, { batchId: batch.batch_id, itemId: item.item_id, batchAttempt: 1, itemAttempt: 1 });
  store.finishExecution(task.task_id, {
    executionSessionId: 'exec-durable-terminal-batch-fixture', attempt: 1, command,
    exitCode: 0, stdout: 'DURABLE_TERMINAL_RESULT', stderr: '', status: 'completed', error: null
  });
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING',
    'fixture must stop exactly between task terminalization and batch-item terminalization');

  const recoveredManager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
  let accidentalRuns = 0;
  recoveredManager.executeTask = async () => {
    accidentalRuns++;
    throw new Error('durable terminal recovery must not re-execute a task');
  };
  const recoveredBatch = await recoveredManager.executeBatch(batch.batch_id);
  assert.equal(recoveredBatch.status, 'COMPLETED');
  assert.equal(recoveredBatch.items[0].status, 'COMPLETED');
  assert.equal(recoveredBatch.items[0].stdout, 'DURABLE_TERMINAL_RESULT');
  assert.equal(accidentalRuns, 0, 'recovery must use verified durable task result rather than spawning a second execution');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.item_recovered_from_terminal_task' AND json_extract(payload_json,'$.itemId')=?")
    .get(job.job_id, item.item_id).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(task.task_id).n, 1);

  // A second crash window: the supervisor has written a durable exit marker,
  // but the manager died before finishExecution committed any task result. The
  // package runtime must recover from that exact marker and start-event claim,
  // not strand the batch as RUNNING or spawn the deterministic command twice.
  const markerCommand = "node -e \"process.stdout.write('RECOVERED_FROM_EXIT_MARKER')\"";
  const markerTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'exit marker exists before result transaction',
    metadata: { deterministic: true, command: markerCommand }
  });
  const markerBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: markerTask.task_id, command: markerCommand }]
  });
  const markerItem = store.listExecutionBatchItems(markerBatch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(markerBatch.batch_id, markerItem.item_id, { expectedAttempt: 1 }));
  const markerSession = 'exec-terminal-marker-before-result';
  const markerTmux = `cos-exec-${markerSession.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const markerHash = 'a'.repeat(64);
  const markerBoundary = {
    schema_version: 1, task_id: markerTask.task_id, attempt: 1, command: markerCommand,
    cwd: { requested: path.resolve(root), realpath: path.resolve(root) },
    environment_sha256: markerHash,
    executable: { realpath: process.execPath, sha256: markerHash },
    tmux: { realpath: process.execPath, sha256: markerHash }
  };
  store.prepareExecutionForBatchClaim(markerTask.task_id, {
    executionSessionId: markerSession, attempt: 1, command: markerCommand, cwd: root,
    startedAt: new Date().toISOString(), tmuxName: markerTmux, boundaryIdentity: markerBoundary
  }, { batchId: markerBatch.batch_id, itemId: markerItem.item_id, batchAttempt: 1, itemAttempt: 1 });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, `${markerTmux}.stdout`), 'RECOVERED_FROM_EXIT_MARKER', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, `${markerTmux}.stderr`), '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, `${markerTmux}.exit`), '0', { flag: 'wx', mode: 0o600 });
  const markerRecoveryManager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
  markerRecoveryManager.executeTask = async () => { throw new Error('exit-marker recovery must not start a new process'); };
  const originalFinishExecution = store.finishExecution.bind(store);
  store.finishExecution = () => { throw new Error('injected durable result commit failure'); };
  await assert.rejects(() => markerRecoveryManager.executeBatch(markerBatch.batch_id), /injected durable result commit failure/);
  store.finishExecution = originalFinishExecution;
  assert.equal(store.listExecutionBatchItems(markerBatch.batch_id)[0].status, 'RUNNING',
    'failed result persistence must not terminalize the batch item');
  assert.equal(store.getTask(markerTask.task_id).execution_status, 'running',
    'failed result persistence must not publish task terminal state');
  assert.equal(fs.existsSync(path.join(runtimeDir, `${markerTmux}.exit`)), true,
    'failed result persistence must preserve the only durable exit marker for retry/recovery');
  assert.equal(fs.readFileSync(path.join(runtimeDir, `${markerTmux}.stdout`), 'utf8'), 'RECOVERED_FROM_EXIT_MARKER');
  const markerRecoveredBatch = await markerRecoveryManager.executeBatch(markerBatch.batch_id);
  assert.equal(markerRecoveredBatch.status, 'COMPLETED');
  assert.equal(markerRecoveredBatch.items[0].status, 'COMPLETED');
  assert.equal(markerRecoveredBatch.items[0].stdout, 'RECOVERED_FROM_EXIT_MARKER');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(markerTask.task_id).n, 1);
  assert.equal(fs.existsSync(path.join(runtimeDir, `${markerTmux}.exit`)), false,
    'exit/output evidence is retired only after the exact durable task result has been accepted');

  // Reconcile an inconsistent legacy batch where an older runtime marked the
  // item FAILED even though task execution remained unresolved. Retrying that
  // batch must not write another false item failure or authorize a new spawn.
  const legacyTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'legacy failed item with still-running task',
    metadata: { deterministic: true, command: "node --version" }
  });
  const legacyBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: legacyTask.task_id, command: 'node --version' }]
  });
  const legacyItem = store.listExecutionBatchItems(legacyBatch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(legacyBatch.batch_id, legacyItem.item_id, { expectedAttempt: 1 }));
  store.prepareExecutionForBatchClaim(legacyTask.task_id, {
    executionSessionId: 'exec-legacy-unresolved-batch-item', attempt: 1, command: 'node --version', cwd: root,
    startedAt: new Date().toISOString(), tmuxName: 'cos-exec-exec-legacy-unresolved-batch-item', boundaryIdentity: null
  }, { batchId: legacyBatch.batch_id, itemId: legacyItem.item_id, batchAttempt: 1, itemAttempt: 1 });
  store.finishExecutionBatchItem(legacyBatch.batch_id, legacyItem.item_id, {
    expectedAttempt: 1, status: 'FAILED', error: 'simulated historical false-failure row'
  });
  assert.throws(() => store.finishExecutionBatch(legacyBatch.batch_id, {
    status: 'FAILED', aggregateContent: 'simulated historical false-failure aggregate', expectedAttempt: 1
  }), /failed batch item conflicts with a live or incomplete task execution/,
  'a failed item row cannot terminalize an aggregate while its task still owns a live execution');
  assert.equal(store.getExecutionBatch(legacyBatch.batch_id).status, 'RUNNING',
    'rejected false-failure aggregation must roll the batch terminal write back');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.failed' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, legacyBatch.batch_id).n, 0, 'rejected false-failure aggregation must not emit a terminal event');
  // Model a historical, already-persisted inconsistent aggregate directly in
  // SQLite; the current public terminalization API must refuse to create it.
  store.db.prepare("UPDATE execution_batches SET status='FAILED',finished_at=?,aggregate_content=? WHERE batch_id=?")
    .run(new Date().toISOString(), 'historical false-failure aggregate', legacyBatch.batch_id);
  const legacyRecoveryManager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
  await assert.rejects(() => legacyRecoveryManager.executeBatch(legacyBatch.batch_id),
    error => error?.code === 'ERR_EXECUTION_ATTEMPT_UNRESOLVED');
  assert.equal(store.listExecutionBatchItems(legacyBatch.batch_id)[0].status, 'RUNNING',
    'an unresolved prior task must not be converted back to FAILED during batch retry');
  assert.equal(store.getExecutionBatch(legacyBatch.batch_id).status, 'WAITING');
  assert.equal(store.getTask(legacyTask.task_id).execution_status, 'running');

  // A second case reaches the real post-spawn quarantine path. Fake tmux
  // reports accepted session creation then fails local PID persistence while
  // still reporting the exact session as present. No task command is actually
  // executed. The batch item and batch must remain non-terminal/uncertain.
  const ambiguousCommand = `node -e "require('node:fs').writeFileSync(${JSON.stringify(shouldNeverRun)}, 'executed')"`;
  const ambiguousTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'accepted spawn with ambiguous local outcome',
    metadata: { deterministic: true, command: ambiguousCommand }
  });
  const ambiguousBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: ambiguousTask.task_id, command: ambiguousCommand }]
  });
  const manager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
  const originalSetExecutionPid = store.setExecutionPid.bind(store);
  store.setExecutionPid = () => { throw new Error('injected post-spawn PID persistence failure'); };
  try {
    await assert.rejects(() => manager.executeBatch(ambiguousBatch.batch_id), /outcome is not verified|injected post-spawn PID persistence failure/);
  } finally {
    store.setExecutionPid = originalSetExecutionPid;
  }
  const ambiguousItem = store.listExecutionBatchItems(ambiguousBatch.batch_id)[0];
  const ambiguousBatchState = store.getExecutionBatch(ambiguousBatch.batch_id);
  assert.equal(ambiguousItem.status, 'RUNNING', 'an accepted but unresolved task must not be terminalized as a failed batch item');
  assert.equal(ambiguousBatchState.status, 'WAITING', 'the batch must not claim a terminal aggregate while the task outcome is unknown');
  assert.equal(store.getTask(ambiguousTask.task_id).execution_status, 'running');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_reconciliation_required' AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, ambiguousTask.task_id).n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.failed' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, ambiguousBatch.batch_id).n, 0, 'no false batch failure event is allowed while the session is unresolved');
  assert.equal(fs.existsSync(shouldNeverRun), false, 'tmux stub must not execute the submitted task command');
  await assert.rejects(() => manager.executeBatch(ambiguousBatch.batch_id), /already has active item attempts/);
  assert.equal(fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).filter(line => line === 'new-session').length, 1,
    'a second batch caller must not spawn a duplicate while the first session is unresolved');
  console.log('BATCH POST-SPAWN AMBIGUITY QUARANTINE / TERMINAL TASK CRASH RECOVERY / NO REPLAY PASS');
} finally {
  try { store.db.close(); } catch {}
}
