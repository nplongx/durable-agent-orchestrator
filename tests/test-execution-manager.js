import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-phase4-'));
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../job-store.js');
const { ExecutionManager } = await import('../execution-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'phase4-test', title: 'Phase 4 deterministic execution' });
const task = store.ensureTask(job.job_id, { role: 'executor', description: 'deterministic command' });
const manager = new ExecutionManager(store, { timeoutMs: 5000 });

const ok = await manager.executeTask(task.task_id, { command: "node -e \"process.stdout.write('OUT'); process.stderr.write('ERR')\"" });
assert.equal(ok.exitCode, 0);
assert.equal(ok.stdout, 'OUT');
assert.equal(ok.stderr, 'ERR');
assert.equal(ok.timedOut, false);
const okTask = store.getTask(task.task_id);
assert.equal(okTask.execution_status, 'completed');
assert.equal(okTask.execution_attempt, 1);
assert.equal(okTask.execution_exit_code, 0);
assert.ok(Number.isInteger(okTask.execution_pid));
assert.equal(okTask.status, 'completed');

const badCommand = "node -e \"process.stderr.write('BAD'); process.exit(7)\"";
const bad = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id,
  role: 'executor',
  description: `Run immediately: ${badCommand}. Return exact command and exit status.`,
  metadata: { deterministic: true, command: badCommand }
});
const badResult = await manager.executeTask(bad.task_id, { command: badCommand });
assert.equal(badResult.exitCode, 7);
assert.equal(store.getTask(bad.task_id).execution_status, 'failed');
assert.equal(store.getTask(bad.task_id).execution_exit_code, 7);
assert.equal(store.findDeterministicTask(job.job_id, {
  role: 'executor',
  command: badCommand
}).task_id, bad.task_id);

const timeout = store.createChildTask(job.job_id, { parentTaskId: task.task_id, role: 'executor', description: 'timeout command' });
const timeoutResult = await manager.executeTask(timeout.task_id, { command: "node -e \"setTimeout(() => {}, 1000)\"", timeoutMs: 100 });
assert.equal(timeoutResult.timedOut, true);
assert.equal(store.getTask(timeout.task_id).execution_status, 'timeout');
assert.equal(store.getTask(timeout.task_id).execution_exit_code, null);

const trace = store.getJobTrace(job.job_id);
assert.ok(trace.results.some(r => r.content.includes('[ACTUAL EXECUTION EVIDENCE]')));
assert.ok(trace.events.some(e => e.type === 'execution.completed'));
assert.ok(trace.events.some(e => e.type === 'execution.failed'));

const authorized = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id,
  role: 'executor',
  description: 'deterministic command',
  metadata: { deterministic: true, command: 'node -e "process.stdout.write(\'AUTHORIZED\')"' }
});
const authorizedResult = await manager.executeAuthorizedTask(authorized.task_id);
assert.equal(authorizedResult.exitCode, 0);
assert.equal(authorizedResult.stdout, 'AUTHORIZED');
console.log('test-execution-manager: PASS');
