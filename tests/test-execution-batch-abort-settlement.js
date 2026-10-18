import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-batch-abort-settlement-');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.EXECUTION_TMP_DIR = path.join(dataDir, 'runtime');
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
const manager = new ExecutionManager(store, { timeoutMs: 5000, executionTmpDir: process.env.EXECUTION_TMP_DIR });
const controller = new AbortController();
const started = new Set();
const settled = new Set();
let resolveAllStarted;
const allStarted = new Promise(resolve => { resolveAllStarted = resolve; });

try {
  const job = store.createJob({ conversationKey: `batch-abort-${process.pid}`, title: 'Batch abort settlement barrier' });
  store.approve(job.job_id, 'isolated cancellation coordinator test', 'test-fixture');
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'cancellation fixture parent' });
  const commands = [1, 2, 3].map(i => `node -e "process.stdout.write('fixture-${i}')"`);
  const tasks = commands.map((command, index) => store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: `cancel fixture item ${index + 1}`,
    metadata: { deterministic: true, command }
  }));
  const batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id, role: 'architect',
    items: tasks.map((task, index) => ({ taskId: task.task_id, command: commands[index] }))
  });

  // Inject only the process-work promise so the coordinator cleanup barrier is
  // deterministic; actual execution-manager cancellation and process-group
  // teardown remain covered by test-execution-control-process-boundary.js and
  // test-execution-plan-binding.js. Each lane takes a different time to unwind.
  manager.executeTask = (taskId, { signal }) => new Promise((resolve, reject) => {
    started.add(taskId);
    if (started.size === tasks.length) resolveAllStarted();
    const onAbort = () => {
      const index = tasks.findIndex(task => task.task_id === taskId);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        settled.add(taskId);
        // Model the production promise contract: rejecting means local cleanup
        // and task terminalization have finished, not merely started.
        reject(Object.assign(new Error('Request aborted by caller'), { code: 'ABORT_ERR' }));
      }, 40 + index * 90);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  const execution = manager.executeBatch(batch.batch_id, { signal: controller.signal });
  await allStarted;
  controller.abort();
  await assert.rejects(execution, /Request aborted by caller/);

  assert.equal(settled.size, tasks.length,
    'executeBatch must not return/reject until every lane has finished abort cleanup');
  const finalBatch = store.getExecutionBatch(batch.batch_id);
  assert.equal(finalBatch.status, 'CANCELLED');
  const items = store.listExecutionBatchItems(batch.batch_id);
  assert.equal(items.length, tasks.length);
  assert.ok(items.every(item => item.status === 'CANCELLED'),
    'every item must be durably cancelled only after its owner has unwound');
  assert.ok(items.every(item => item.finished_at), 'each cancellation must have a durable terminal timestamp');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.batch.cancelled' AND json_extract(payload_json,'$.batchId')=?")
    .get(job.job_id, batch.batch_id).n, 1, 'the batch cancellation event must commit once after all lane cleanup promises settle');
  console.log('EXECUTION BATCH ABORT DRAINS ALL LANE CLEANUP BEFORE TERMINALIZATION PASS');
} finally {
  try { store.db.close(); } catch {}
}
