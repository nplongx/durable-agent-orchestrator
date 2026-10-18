import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-batch-ambiguous-spawn-successor-');
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(dataDir, 'runtime');
const tmuxStub = path.join(root, 'tmux-control-stub');
const tmuxLog = path.join(root, 'tmux-control.log');
const commandSentinel = path.join(root, 'task-command-must-not-run.txt');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  WORKFLOW_DATA_DIR: dataDir,
  WORKFLOW_WORKSPACE: root,
  EXECUTION_TMP_DIR: runtimeDir,
  NODE_ENV: 'test'
});

// The fake control client models an accepted session that remains live. It
// never launches the supervisor or task command, and makes reconciliation's
// exact-session probe deterministically report presence.
fs.writeFileSync(tmuxStub, `#!/bin/sh
case "$1" in
  new-session) printf 'new-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  display-message) printf '12345\\n'; exit 0 ;;
  kill-session) printf 'kill-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  has-session) printf 'has-session\\n' >> ${JSON.stringify(tmuxLog)}; printf 'session remains active\\n' >&2; exit 0 ;;
  *) exit 31 ;;
esac
`, { flag: 'wx', mode: 0o700 });
fs.chmodSync(tmuxStub, 0o700);

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
const manager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
const originalSetExecutionPid = store.setExecutionPid.bind(store);

try {
  const job = store.createJob({ conversationKey: `batch-ambiguous-spawn-${process.pid}`, title: 'Batch ambiguous spawn quarantine' });
  store.approve(job.job_id, 'isolated successor regression fixture', 'test-fixture');
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'batch parent' });
  const command = `node -e "require('node:fs').writeFileSync(${JSON.stringify(commandSentinel)}, 'must not execute')"`;
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    description: 'accepted session remains ambiguous after local persistence failure',
    metadata: { deterministic: true, command }
  });
  const batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    items: [{ taskId: task.task_id, command }]
  });

  // Fail a local persistence write after tmux has accepted the session. The
  // manager must retain the open task attempt and must not translate the
  // executeTask rejection into a terminal batch-item status.
  store.setExecutionPid = () => { throw new Error('injected post-spawn PID persistence failure'); };
  await assert.rejects(() => manager.executeBatch(batch.batch_id), /outcome is not verified|injected post-spawn PID persistence failure/);
  store.setExecutionPid = originalSetExecutionPid;

  const persistedTask = store.getTask(task.task_id);
  const persistedBatch = store.getExecutionBatch(batch.batch_id);
  const [persistedItem] = store.listExecutionBatchItems(batch.batch_id);
  assert.equal(persistedTask.status, 'running');
  assert.equal(persistedTask.execution_status, 'running', 'ambiguous task must remain open for reconciliation');
  assert.ok(persistedTask.execution_session_id);
  assert.equal(persistedBatch.status, 'WAITING', 'aggregate batch must not become terminal while the item outcome is unresolved');
  assert.equal(persistedItem.status, 'RUNNING', 'executeBatch must preserve item ownership for reconciliation');
  assert.equal(persistedItem.finished_at, null, 'ambiguous item must not receive a terminal timestamp');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'")
    .get(task.task_id).n, 1, 'the exact task attempt must remain open');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_reconciliation_required' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
    .get(job.job_id, task.task_id).n, 1, 'durable reconciliation event must bind the ambiguous task attempt');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('execution.batch.failed','execution.batch.completed','execution.batch.cancelled') AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, batch.batch_id).n, 0, 'no terminal batch event may be emitted while the item remains ambiguous');
  assert.equal(fs.existsSync(commandSentinel), false, 'fake tmux never executes the task command');
  const controlCalls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(controlCalls.filter(line => line === 'new-session').length, 1, 'the ambiguous attempt must not be replayed');
  assert.ok(controlCalls.includes('has-session'), 'the exact accepted session must be probed during reconciliation');

  console.log('BATCH AMBIGUOUS POST-SPAWN STATE PRESERVED FOR RECONCILIATION PASS');
} finally {
  store.setExecutionPid = originalSetExecutionPid;
  try { store.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
