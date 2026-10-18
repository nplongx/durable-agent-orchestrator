import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('batch-claim-preparation-fence-');
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'workflow.db');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Object.assign(process.env, { WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' });
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
const recoveryStore = new WorkflowStore();

try {
  const job = store.createJob({ conversationKey: `claim-prep-fence-${process.pid}`, title: 'Batch claim preparation fence' });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'isolated test fixture', 'test-fixture', { workspace: root });
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'batch parent' });
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    description: 'must not spawn after recovery wins the claim',
    metadata: { deterministic: true, command: "node -e \"process.stdout.write('MUST_NOT_RUN')\"" }
  });
  const batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    items: [{ taskId: task.task_id, command: JSON.parse(task.metadata_json).command }]
  });
  const item = store.listExecutionBatchItems(batch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(batch.batch_id, item.item_id, { expectedAttempt: 1 }));
  store.db.prepare('UPDATE execution_batch_items SET started_at=? WHERE batch_id=? AND item_id=?')
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), batch.batch_id, item.item_id);

  let signalPreparationStarted;
  const preparationStarted = new Promise(resolve => { signalPreparationStarted = resolve; });
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  let spawnCalls = 0;
  const manager = new ExecutionManager(store, { timeoutMs: 1000, executionTmpDir: path.join(root, 'runtime') });
  manager._prepareExecutionEnvironment = async env => env;
  manager._captureExecutionBoundary = async (taskId, { command, cwd, env, executable, attempt }) => {
    signalPreparationStarted();
    await preparationGate;
    const digest = 'a'.repeat(64);
    return {
      schema_version: 1,
      task_id: taskId,
      attempt,
      command,
      cwd: { requested: path.resolve(cwd), realpath: path.resolve(cwd) },
      environment_sha256: digest,
      executable: { token: executable, realpath: process.execPath, sha256: digest },
      tmux: { realpath: process.execPath, sha256: digest },
      supervisor: { realpath: process.execPath },
      lease: null
    };
  };
  manager._spawnUnderAuthorizationWriteLock = async () => {
    spawnCalls++;
    throw new Error('test harness must never reach spawn');
  };

  const execution = manager.executeTask(task.task_id, {
    command: item.command,
    cwd: root,
    timeoutMs: 1000,
    batchClaim: { batchId: batch.batch_id, itemId: item.item_id, batchAttempt: 1, itemAttempt: 1 }
  });
  await preparationStarted;
  const recovered = recoveryStore.recoverUnstartedExecutionBatchClaims({
    staleBefore: new Date(Date.now() - 60_000).toISOString()
  });
  assert.equal(recovered.length, 1, 'recovery wins while the executor is blocked in async preflight');
  releasePreparation();
  await assert.rejects(execution, error => error?.code === 'ERR_EXECUTION_BATCH_CLAIM_LOST');

  assert.equal(spawnCalls, 0, 'the stale owner must never cross the process spawn boundary');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'FAILED');
  assert.equal(store.getTask(task.task_id).execution_status, null,
    'losing preflight must not create a task execution state/session');
  assert.equal(store.getTask(task.task_id).execution_session_id, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'")
    .get(task.task_id).n, 0, 'no attempt ledger row may appear after recovery wins');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started'")
    .get(job.job_id).n, 0, 'no execution.started event may appear after the claim was recovered');

  // Reverse the winner: once durable task preparation has committed under the
  // item claim, later stale-claim recovery must not classify it as unstarted.
  const protectedTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    description: 'durable preparation must fence subsequent stale recovery',
    metadata: { deterministic: true, command: "node -e \"process.stdout.write('PREPARED')\"" }
  });
  const protectedBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'executor',
    items: [{ taskId: protectedTask.task_id, command: JSON.parse(protectedTask.metadata_json).command }]
  });
  const protectedItem = store.listExecutionBatchItems(protectedBatch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(protectedBatch.batch_id, protectedItem.item_id, { expectedAttempt: 1 }));
  store.db.prepare('UPDATE execution_batch_items SET started_at=? WHERE batch_id=? AND item_id=?')
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), protectedBatch.batch_id, protectedItem.item_id);
  store.prepareExecutionForBatchClaim(protectedTask.task_id, {
    executionSessionId: 'exec_prepared_before_stale_recovery',
    attempt: 1,
    command: protectedItem.command,
    cwd: root,
    startedAt: new Date().toISOString(),
    tmuxName: 'cos-exec-prepared-before-stale-recovery',
    boundaryIdentity: null
  }, {
    batchId: protectedBatch.batch_id,
    itemId: protectedItem.item_id,
    batchAttempt: 1,
    itemAttempt: 1
  });
  assert.deepEqual(recoveryStore.recoverUnstartedExecutionBatchClaims({
    staleBefore: new Date(Date.now() - 60_000).toISOString()
  }), [], 'a durably prepared task must not be recovered as an unstarted claim');
  assert.equal(store.listExecutionBatchItems(protectedBatch.batch_id)[0].status, 'RUNNING');
  assert.equal(store.getTask(protectedTask.task_id).execution_status, 'running');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'")
    .get(protectedTask.task_id).n, 1);
  console.log('BATCH CLAIM RECOVERY VS ASYNC PREFLIGHT / ATOMIC PREPARE FENCE / NO SPAWN PASS');
} finally {
  try { store.db.close(); } catch {}
  try { recoveryStore.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
