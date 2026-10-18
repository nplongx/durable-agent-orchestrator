import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('batch-unstarted-claim-recovery-');
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'workflow.db');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Object.assign(process.env, { WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' });
const storeUrl = new URL('../src/runtime/job-store.js', import.meta.url).href;
const { WorkflowStore } = await import(storeUrl);
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();

try {
  const job = store.createJob({ conversationKey: `batch-unstarted-recovery-${process.pid}`, title: 'Unstarted batch claim recovery' });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'isolated crash-recovery fixture', 'test-fixture', { workspace: root });
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'batch parent' });
  const sentinel = path.join(root, 'MUST_NOT_EXECUTE');
  const command = `node -e "require('node:fs').writeFileSync('${sentinel}', 'executed', {flag:'wx'})"`;
  const task = store.createChildTask(job.job_id, { parentTaskId: parent.task_id, role: 'executor',
    description: 'claim may crash before task attempt exists', metadata: { deterministic: true, command } });
  const batch = store.createExecutionBatch(job.job_id, { parentTaskId: parent.task_id, role: 'executor',
    items: [{ taskId: task.task_id, command }] });
  const item = store.listExecutionBatchItems(batch.batch_id)[0];

  const childSource = `
    const { WorkflowStore } = await import(${JSON.stringify(storeUrl)});
    const s = new WorkflowStore();
    try {
      const row = s.markExecutionBatchItemRunning(${JSON.stringify(batch.batch_id)}, ${JSON.stringify(item.item_id)}, { expectedAttempt: 1 });
      if (!row) throw new Error('fixture could not claim batch item');
      const task = s.getTask(${JSON.stringify(task.task_id)});
      const attempts = s.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(task.task_id).n;
      if (task.execution_status === 'running' || task.execution_session_id || attempts !== 0) throw new Error('fixture crossed task execution boundary unexpectedly');
      console.log('CLAIM_COMMITTED_NO_TASK_ATTEMPT');
      process.kill(process.pid, 'SIGKILL');
    } finally { s.db.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, 'SIGKILL', `${stderr}\n${stdout}`);
  assert.match(stdout, /CLAIM_COMMITTED_NO_TASK_ATTEMPT/);
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING');
  assert.equal(store.getTask(task.task_id).execution_session_id, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(task.task_id).n, 0);

  // Force only the durable claim timestamp stale; no process/workload runs.
  store.db.prepare('UPDATE execution_batch_items SET started_at=? WHERE batch_id=? AND item_id=?')
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), batch.batch_id, item.item_id);
  const manager = new ExecutionManager(store, { timeoutMs: 1000, executionTmpDir: path.join(root, 'runtime') });
  let simulatedExecutions = 0;
  manager.executeTask = async (taskId, { command, cwd, batchClaim }) => {
    simulatedExecutions++;
    assert.equal(taskId, task.task_id);
    const nextAttempt = Number(store.getTask(taskId).execution_attempt || 0) + 1;
    const executionSessionId = `recovered-unstarted-${process.pid}`;
    store.prepareExecutionForBatchClaim(taskId, {
      executionSessionId, attempt: nextAttempt, command, cwd: cwd || root,
      startedAt: new Date().toISOString(), tmuxName: `cos-exec-recovered-unstarted-${process.pid}`, boundaryIdentity: null
    }, batchClaim);
    const result = store.finishExecution(taskId, {
      executionSessionId, attempt: nextAttempt, command, exitCode: 0,
      stdout: 'SIMULATED_LOCAL_RESULT', stderr: '', status: 'completed', error: null
    });
    return { ...result, exitCode: 0, stdout: 'SIMULATED_LOCAL_RESULT', stderr: '', timedOut: false, outputLimited: false };
  };
  const recoveredBatch = await manager.executeBatch(batch.batch_id);
  assert.equal(recoveredBatch.status, 'COMPLETED', 'the shipped batch caller must recover and retry the stale unstarted claim');
  assert.equal(simulatedExecutions, 1, 'only the post-recovery retry is executed by the isolated test stub');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'COMPLETED');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].attempt, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.item_recovered_unstarted'")
    .get(job.job_id).n, 1);
  assert.equal(fs.existsSync(sentinel), false, 'recovery must never execute the task command');
  assert.equal(fs.existsSync(sentinel), false, 'proving retryability must not dispatch a local workload');
  console.log('EXECUTION BATCH SIGKILL BEFORE TASK PREPARATION / STALE CLAIM RECOVERY / SAFE RETRY PASS');
} finally {
  try { store.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
