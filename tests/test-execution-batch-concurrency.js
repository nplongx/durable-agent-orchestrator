import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-batch-concurrency-');
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(root, 'runtime');
const dbPath = path.join(dataDir, 'workflow.db');
const startedMarker = path.join(root, 'external-command-started');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.EXECUTION_TMP_DIR = runtimeDir;
process.env.EXECUTION_TIMEOUT_MS = '10000';
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
const manager = new ExecutionManager(store, { timeoutMs: 10000, executionTmpDir: runtimeDir });
let batch = null;

function launchBatchOwner(label) {
  const childSource = `
    const { WorkflowStore } = await import(${JSON.stringify(new URL('../src/runtime/job-store.js', import.meta.url).href)});
    const { ExecutionManager } = await import(${JSON.stringify(new URL('../src/runtime/execution-manager.js', import.meta.url).href)});
    const store = new WorkflowStore();
    const manager = new ExecutionManager(store, { timeoutMs: 10000, executionTmpDir: ${JSON.stringify(runtimeDir)} });
    try {
      const result = await manager.executeBatch(${JSON.stringify(batch.batch_id)});
      console.log(${JSON.stringify(label + '_RESULT:')} + result.status);
    } catch (error) {
      console.error(${JSON.stringify(label + '_ERROR:')} + String(error?.message || error));
      process.exitCode = 2;
    } finally { store.db.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(),
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, EXECUTION_TMP_DIR: runtimeDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

let owner;
let contender;
try {
  const job = store.createJob({ conversationKey: `batch-concurrency-${process.pid}`, title: 'Batch ownership race' });
  store.approve(job.job_id, 'isolated local batch concurrency fixture', 'test-fixture');
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'Batch concurrency fixture parent' });
  const markerForSource = startedMarker.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const command = `node -e "require('node:fs').writeFileSync('${markerForSource}', 'started', {flag:'wx'}); setTimeout(() => console.log('BATCH_OWNER_ONLY'), 4000)"`;
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'one exact batch item across processes',
    metadata: { deterministic: true, command }
  });
  batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: task.task_id, command, timeout_ms: 8000 }]
  });

  owner = launchBatchOwner('OWNER');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(startedMarker)) {
    if (Date.now() >= deadline) throw new Error(`first batch owner never reached its actual local command: ${owner.child.pid}`);
    assert.equal(owner.child.exitCode, null, `owner exited before command start: ${owner.child.exitCode}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const runningItem = store.listExecutionBatchItems(batch.batch_id)[0];
  assert.equal(runningItem.status, 'RUNNING', 'the first process must own a durably claimed batch item before the competing request');
  assert.equal(store.getTask(task.task_id).execution_status, 'running');

  contender = launchBatchOwner('CONTENDER');
  const contenderResult = await contender.done;
  assert.equal(contenderResult.code, 2, `competing process must be rejected without changing the winner: ${contenderResult.stderr}\n${contenderResult.stdout}`);
  assert.match(contenderResult.stderr, /batch already has active item attempts; duplicate batch execution refused/);
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING',
    'a losing batch caller must not mark the in-flight item failed');

  const ownerResult = await owner.done;
  assert.equal(ownerResult.code, 0, `winning batch process must complete: ${ownerResult.stderr}\n${ownerResult.stdout}`);
  assert.match(ownerResult.stdout, /OWNER_RESULT:COMPLETED/);
  assert.doesNotMatch(ownerResult.stdout, /BATCH_OWNER_ONLY/,
    'the runtime output is collected once from the actual process, not emitted by competing callers');

  const finalBatch = store.getExecutionBatch(batch.batch_id);
  const finalItem = store.listExecutionBatchItems(batch.batch_id)[0];
  assert.equal(finalBatch.status, 'COMPLETED');
  assert.equal(finalItem.status, 'COMPLETED');
  assert.equal(finalItem.attempt, 1);
  assert.equal(finalItem.exit_code, 0);
  assert.match(finalItem.stdout, /BATCH_OWNER_ONLY/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(task.task_id).n, 1,
    'only one durable execution attempt may be created for the claimed batch item');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
    .get(job.job_id, task.task_id).n, 1, 'only one exact terminal execution event may be persisted');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.completed' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, batch.batch_id).n, 1, 'batch row and terminal event must settle once');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.failed' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, batch.batch_id).n, 0, 'the losing caller must not emit a contradictory batch failure');

  // Crash/restart boundary: all item rows are durable terminal evidence, but
  // the owner dies before writing the batch aggregate/status/event. Re-entry
  // must rebuild the aggregate without launching the task a second time.
  const replayCommand = "node -e \"process.stdout.write('MUST_NOT_SPAWN')\"";
  const replayTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'terminal item aggregate recovery',
    metadata: { deterministic: true, command: replayCommand }
  });
  const replayBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', items: [{ taskId: replayTask.task_id, command: replayCommand }]
  });
  const replayItem = store.listExecutionBatchItems(replayBatch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(replayBatch.batch_id, replayItem.item_id, { expectedAttempt: 1 }));
  const replaySession = 'exec-precommitted-batch-item';
  store.prepareExecutionForBatchClaim(replayTask.task_id, {
    executionSessionId: replaySession, attempt: 1, command: replayCommand, cwd: root,
    startedAt: new Date().toISOString(), tmuxName: 'cos-exec-precommitted-batch-item', boundaryIdentity: null
  }, { batchId: replayBatch.batch_id, itemId: replayItem.item_id, batchAttempt: 1, itemAttempt: 1 });
  store.finishExecution(replayTask.task_id, {
    executionSessionId: replaySession, attempt: 1, command: replayCommand,
    exitCode: 0, stdout: 'DURABLE_ITEM_RESULT', stderr: '', status: 'completed', error: null
  });
  store.finishExecutionBatchItem(replayBatch.batch_id, replayItem.item_id, {
    expectedAttempt: 1, executionSessionId: replaySession, exitCode: 0,
    stdout: 'DURABLE_ITEM_RESULT', stderr: '', status: 'COMPLETED'
  });
  assert.equal(store.getExecutionBatch(replayBatch.batch_id).status, 'RUNNING',
    'fixture represents a crash after item commit but before the batch terminal transaction');
  const recoveredBatch = await manager.executeBatch(replayBatch.batch_id);
  assert.equal(recoveredBatch.status, 'COMPLETED');
  assert.match(recoveredBatch.aggregate_content, /DURABLE_ITEM_RESULT/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(replayTask.task_id).n, 1,
    'aggregate recovery must not create a second attempt when the exact successful task/item evidence is already terminal');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.completed' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, replayBatch.batch_id).n, 1, 'aggregate recovery must persist exactly one terminal batch event');
  console.log('EXECUTION BATCH TWO-PROCESS DUPLICATE OWNERSHIP / STALE FAILURE WRITE FENCE PASS');
} finally {
  for (const item of [contender, owner]) {
    if (item?.child.exitCode === null && item?.child.signalCode === null) item.child.kill('SIGKILL');
  }
  try { store.db.close(); } catch {}
}
