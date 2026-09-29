import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { tempDir } from './test-temp-dir.js';

const tempRoot = tempDir('execution-batch-m2-');
const dbPath = `${tempRoot}/workflow.db`;
try { fs.rmSync(dbPath, { force: true }); fs.rmSync(`${dbPath}-wal`, { force: true }); fs.rmSync(`${dbPath}-shm`, { force: true }); } catch (_) {}
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = tempRoot;
process.env.EXECUTION_TIMEOUT_MS = '10000';

const { WorkflowStore } = await import('../job-store.js');
const { ExecutionManager } = await import('../execution-manager.js');
const store = new WorkflowStore();
const manager = new ExecutionManager(store, { timeoutMs: 10000 });

const job = store.createJob({ conversationKey: `m2-${process.pid}`, title: 'M2 batch protocol test' });
store.approve(job.job_id, 'approved', 'test');
const parent = store.dispatch(job.job_id, { role: 'architect', description: 'M2 batch parent' });
const commandA = "node -e \"setTimeout(() => console.log('A'), 1200)\"";
const commandB = "node -e \"setTimeout(() => console.log('B'), 1200)\"";
const a = store.createChildTask(job.job_id, { parentTaskId: parent.task_id, role: 'architect', description: 'batch A', metadata: { deterministic: true, command: commandA } });
const b = store.createChildTask(job.job_id, { parentTaskId: parent.task_id, role: 'architect', description: 'batch B', metadata: { deterministic: true, command: commandB } });
const batch = store.createExecutionBatch(job.job_id, {
  parentTaskId: parent.task_id,
  role: 'architect',
  items: [
    { taskId: a.task_id, command: commandA, timeout_ms: 5000 },
    { taskId: b.task_id, command: commandB, timeout_ms: 5000 }
  ]
});
assert.equal(batch.status, 'RUNNING');
const started = performance.now();
const result = await manager.executeBatch(batch.batch_id);
const elapsed = performance.now() - started;
assert.equal(result.status, 'COMPLETED');
assert.equal(result.items.length, 2);
assert.equal(result.items.every(i => i.status === 'COMPLETED' && i.exit_code === 0), true);
assert.equal(new Set(result.items.map(i => i.execution_session_id)).size, 2);
assert.match(result.aggregate_content, /protocol_result_json:/);
assert.match(result.aggregate_content, /exact command: node -e/);
// Sequential execution would be ~2.4s. Allow host/process jitter while still
// rejecting clearly sequential execution.
assert.ok(elapsed < 3000, `batch did not fan out in parallel: ${Math.round(elapsed)}ms`);
console.log(`M2 EXECUTION BATCH PASS (${Math.round(elapsed)}ms, 2 independent tmux lanes)`);
fs.rmSync(dbPath, { force: true }); fs.rmSync(`${dbPath}-wal`, { force: true }); fs.rmSync(`${dbPath}-shm`, { force: true });
