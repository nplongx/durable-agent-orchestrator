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
const commandA = "node -e \"const started=Date.now(); setTimeout(() => console.log(JSON.stringify({label:'A',started,finished:Date.now()})), 1200)\"";
const commandB = "node -e \"const started=Date.now(); setTimeout(() => console.log(JSON.stringify({label:'B',started,finished:Date.now()})), 1200)\"";
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
// Assert actual command execution overlap rather than total wall time: cold
// content-addressed executable pinning and shared-host scheduling contribute
// startup latency but do not determine whether the batch fan-outs in parallel.
// Two 1.2s commands that overlap have a measurable temporal intersection; a
// sequential dispatcher cannot satisfy this even on a fast host.
const timings = result.items.map(item => JSON.parse(item.stdout.trim()));
assert.deepEqual(timings.map(item => item.label).sort(), ['A', 'B']);
assert.ok(timings.every(item => Number.isSafeInteger(item.started) && Number.isSafeInteger(item.finished) && item.finished > item.started),
  'each actual command must report valid monotonic start/finish timestamps');
assert.ok(timings.every(item => item.finished - item.started >= 1000 && item.finished - item.started < 5000),
  'each command must have executed its planned 1.2-second delay within its local timeout');
assert.ok(timings[0].started < timings[1].finished && timings[1].started < timings[0].finished,
  `actual command intervals must overlap; observed ${JSON.stringify(timings)}`);
assert.ok(Math.abs(timings[0].started - timings[1].started) < 1200,
  `parallel lane starts must be closer than one command duration; observed ${JSON.stringify(timings)}`);
assert.ok(elapsed < 10000, `batch exceeded the independent execution timeout envelope: ${Math.round(elapsed)}ms`);
console.log(`M2 EXECUTION BATCH PASS (${Math.round(elapsed)}ms, measured overlapping independent tmux lanes)`);
fs.rmSync(dbPath, { force: true }); fs.rmSync(`${dbPath}-wal`, { force: true }); fs.rmSync(`${dbPath}-shm`, { force: true });
