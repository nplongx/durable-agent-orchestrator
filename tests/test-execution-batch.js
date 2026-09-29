import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('cos-batch-');
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../job-store.js');
const { ExecutionManager } = await import('../execution-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'batch-test', title: 'Execution batch test' });
store.approve(job.job_id, 'approved');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'batch parent' });
const tasks = [
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check A', metadata: { deterministic: true, command: "node -e \"const s=Date.now(); setTimeout(()=>process.stdout.write(s+','+Date.now()),250)\"" } }),
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check B', metadata: { deterministic: true, command: "node -e \"const s=Date.now(); setTimeout(()=>process.stdout.write(s+','+Date.now()),250)\"" } }),
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check C', metadata: { deterministic: true, command: "node -e \"process.stderr.write('CERR'); process.exit(3)\"" } })
];
const batch = store.createExecutionBatch(job.job_id, { parentTaskId: cto.task_id, role: 'architect', items: tasks.map(t => ({ taskId: t.task_id, command: JSON.parse(t.metadata_json).command })) });
const manager = new ExecutionManager(store, { timeoutMs: 5000 });
const started = Date.now();
const result = await manager.executeBatch(batch.batch_id);
const elapsed = Date.now() - started;

assert.equal(result.status, 'FAILED');
assert.equal(result.items.length, 3);
assert.equal(result.items.filter(i => i.status === 'COMPLETED').length, 2);
assert.equal(result.items.filter(i => i.exit_code === 0).length, 2);
assert.equal(result.items.find(i => i.command.includes("'CERR'"))?.exit_code, 3);
assert.ok(result.aggregate_content.includes('[ACTUAL EXECUTION BATCH EVIDENCE]'));
assert.ok(result.aggregate_content.includes('exact command:'));
const successful = result.items.filter(i => i.exit_code === 0).map(i => i.stdout.trim().split(',').map(Number));
assert.equal(successful.length, 2);
assert.ok(Math.max(...successful.map(x => x[0])) - Math.min(...successful.map(x => x[0])) < 200, `tmux workers did not start together: ${JSON.stringify(successful)}`);
assert.ok(Math.min(...successful.map(x => x[1] - x[0])) >= 200, `worker did not actually wait: ${JSON.stringify(successful)}`);
assert.equal(store.listExecutionBatchItems(batch.batch_id).every(i => i.execution_session_id), true);
const retryTarget = result.items.find(i => i.exit_code === 3);
assert.ok(retryTarget);
const retryCommand = "node -e \"process.stdout.write('RETRIED')\"";
store.db.prepare("UPDATE tasks SET metadata_json=? WHERE task_id=?").run(JSON.stringify({ deterministic: true, command: retryCommand }), retryTarget.task_id);
store.db.prepare("UPDATE execution_batch_items SET command=? WHERE batch_id=? AND item_id=?").run(retryCommand, batch.batch_id, retryTarget.item_id);
const retried = await manager.executeBatch(batch.batch_id);
assert.equal(retried.status, 'COMPLETED');
assert.equal(retried.items.filter(i => i.status === 'COMPLETED').length, 3);
assert.equal(retried.items.find(i => i.item_id === retryTarget.item_id)?.stdout, 'RETRIED');
assert.equal(retried.attempt, 2);
console.log(`test-execution-batch: PASS (${elapsed}ms)`);
