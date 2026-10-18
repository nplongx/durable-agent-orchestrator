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
// A batch row created while a Job is active must not remain an execution
// capability after the parent Job terminalizes. Exercise both claim-time and
// post-claim/preparation races using only the isolated local SQLite fixture.
{
  const terminalJob = store.createJob({ conversationKey: 'batch-terminal-job-fence', title: 'Batch parent terminal fence' });
  store.approve(terminalJob.job_id, 'approved');
  const terminalParent = store.dispatch(terminalJob.job_id, { role: 'cto', description: 'terminal fence parent' });
  const command = "node -e \"process.stdout.write('MUST_NOT_RUN_AFTER_JOB_TERMINAL')\"";
  const taskA = store.createChildTask(terminalJob.job_id, {
    parentTaskId: terminalParent.task_id, role: 'executor', description: 'claim after terminal parent',
    metadata: { deterministic: true, command }
  });
  const batchA = store.createExecutionBatch(terminalJob.job_id, {
    parentTaskId: terminalParent.task_id, role: 'executor', items: [{ taskId: taskA.task_id, command }]
  });
  const itemA = store.listExecutionBatchItems(batchA.batch_id)[0];
  store.db.prepare("UPDATE jobs SET state='COMPLETED',status='completed',completed_at=? WHERE job_id=?")
    .run(new Date().toISOString(), terminalJob.job_id);
  assert.equal(store.markExecutionBatchItemRunning(batchA.batch_id, itemA.item_id, { expectedAttempt: 1 }), null,
    'claim CAS must refuse a terminal parent Job');
  assert.equal(store.listExecutionBatchItems(batchA.batch_id)[0].status, 'PENDING',
    'a rejected claim must not leave an orphaned RUNNING batch item');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(taskA.task_id).n, 0);
  const terminalManager = new ExecutionManager(store, { timeoutMs: 1000 });
  const cancelledBeforeStart = await terminalManager.executeBatch(batchA.batch_id);
  assert.equal(cancelledBeforeStart.status, 'CANCELLED',
    'production batch caller must durably cancel pending work instead of leaving a terminal-parent batch stuck');
  assert.equal(cancelledBeforeStart.items[0].status, 'CANCELLED');

  const activeJob = store.createJob({ conversationKey: 'batch-terminal-between-claim-and-prepare', title: 'Batch prepare terminal fence' });
  store.approve(activeJob.job_id, 'approved');
  const activeParent = store.dispatch(activeJob.job_id, { role: 'cto', description: 'prepare fence parent' });
  const taskB = store.createChildTask(activeJob.job_id, {
    parentTaskId: activeParent.task_id, role: 'executor', description: 'parent terminalizes after item claim',
    metadata: { deterministic: true, command }
  });
  const batchB = store.createExecutionBatch(activeJob.job_id, {
    parentTaskId: activeParent.task_id, role: 'executor', items: [{ taskId: taskB.task_id, command }]
  });
  const itemB = store.listExecutionBatchItems(batchB.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(batchB.batch_id, itemB.item_id, { expectedAttempt: 1 }));
  store.db.prepare("UPDATE jobs SET state='COMPLETED',status='completed',completed_at=? WHERE job_id=?")
    .run(new Date().toISOString(), activeJob.job_id);
  assert.throws(() => store.prepareExecutionForBatchClaim(taskB.task_id, {
    executionSessionId: 'exec-parent-terminal-before-prepare', attempt: 1, command, cwd: process.cwd(),
    startedAt: new Date().toISOString(), tmuxName: 'cos-exec-parent-terminal-before-prepare', boundaryIdentity: null
  }, { batchId: batchB.batch_id, itemId: itemB.item_id, batchAttempt: 1, itemAttempt: 1 }),
  /claim lost before durable task preparation/,
  'the parent Job is revalidated under the same writer reservation as durable task preparation');
  assert.equal(store.listExecutionBatchItems(batchB.batch_id)[0].status, 'RUNNING',
    'failed preparation preserves the item claim for explicit recovery instead of manufacturing a terminal result');
  assert.equal(store.getTask(taskB.task_id).execution_status, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=?").get(taskB.task_id).n, 0);
  const recoveredClaims = store.recoverUnstartedExecutionBatchClaims({
    staleBefore: new Date(Date.now() + 1000).toISOString()
  });
  assert.ok(recoveredClaims.some(claim => claim.batchId === batchB.batch_id && claim.itemId === itemB.item_id),
    'a claim that loses the parent Job before preparation must remain recoverable without creating a task attempt');
  assert.equal(store.listExecutionBatchItems(batchB.batch_id)[0].status, 'FAILED');
  assert.equal(store.getExecutionBatch(batchB.batch_id).status, 'FAILED');
  const terminalRetry = await terminalManager.executeBatch(batchB.batch_id);
  assert.equal(terminalRetry.status, 'FAILED', 'terminal-parent batches must not increment attempt and retry');
  assert.equal(store.getExecutionBatch(batchB.batch_id).attempt, 1);

  const spawnFenceJob = store.createJob({ conversationKey: 'batch-terminal-at-spawn-fence', title: 'Batch spawn authorization fence' });
  store.approve(spawnFenceJob.job_id, 'approved');
  const spawnFenceParent = store.dispatch(spawnFenceJob.job_id, { role: 'cto', description: 'spawn fence parent' });
  const spawnFenceTask = store.createChildTask(spawnFenceJob.job_id, {
    parentTaskId: spawnFenceParent.task_id, role: 'executor', description: 'parent terminalizes after durable task preparation',
    metadata: { deterministic: true, command }
  });
  const spawnFenceBatch = store.createExecutionBatch(spawnFenceJob.job_id, {
    parentTaskId: spawnFenceParent.task_id, role: 'executor', items: [{ taskId: spawnFenceTask.task_id, command }]
  });
  const spawnFenceManager = new ExecutionManager(store, { timeoutMs: 1000 });
  const originalSpawnAuthorization = spawnFenceManager._spawnUnderAuthorizationWriteLock.bind(spawnFenceManager);
  spawnFenceManager._spawnUnderAuthorizationWriteLock = async args => {
    store.db.prepare("UPDATE jobs SET state='COMPLETED',status='completed',completed_at=? WHERE job_id=?")
      .run(new Date().toISOString(), spawnFenceJob.job_id);
    return originalSpawnAuthorization(args);
  };
  const spawnFenceResult = await spawnFenceManager.executeBatch(spawnFenceBatch.batch_id);
  assert.equal(spawnFenceResult.status, 'FAILED',
    'a terminal parent discovered at the final spawn fence must settle the batch as a durable failure, not launch work');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_authorized'")
    .get(spawnFenceJob.job_id).n, 0, 'terminalizing the parent after preparation must block durable spawn authorization');
  assert.equal(store.getExecutionBatch(spawnFenceBatch.batch_id).status, 'FAILED');
  assert.equal(store.listExecutionBatchItems(spawnFenceBatch.batch_id)[0].status, 'FAILED');
  assert.equal(store.getTask(spawnFenceTask.task_id).execution_status, 'failed');
}
const job = store.createJob({ conversationKey: 'batch-test', title: 'Execution batch test' });
store.approve(job.job_id, 'approved');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'batch parent' });
const tasks = [
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check A', metadata: { deterministic: true, command: "node -e \"const s=Date.now(); setTimeout(()=>process.stdout.write(s+','+Date.now()),250)\"" } }),
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check B', metadata: { deterministic: true, command: "node -e \"const s=Date.now(); setTimeout(()=>process.stdout.write(s+','+Date.now()),250)\"" } }),
  store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: 'check C', metadata: { deterministic: true, command: "node -e \"process.stderr.write('CERR'); process.exit(3)\"" } })
];
const batchCountBeforeInvalidInput = store.db.prepare('SELECT COUNT(*) AS n FROM execution_batches').get().n;
const canonicalCommand = JSON.parse(tasks[0].metadata_json).command;
assert.throws(() => store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', attempt: 1.5,
  items: [{ taskId: tasks[0].task_id, command: canonicalCommand }]
}), /positive safe integer/, 'fractional batch attempts must not be coerced into SQLite state');
for (const timeout_ms of ['5000', true, 1.5, 600001]) {
  assert.throws(() => store.createExecutionBatch(job.job_id, {
    parentTaskId: cto.task_id, role: 'architect',
    items: [{ taskId: tasks[0].task_id, command: canonicalCommand, timeout_ms }]
  }), /timeout_ms must be a safe integer/, `timeout_ms=${String(timeout_ms)} must be rejected without type coercion`);
}
assert.throws(() => store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect',
  items: Array.from({ length: 33 }, () => ({ taskId: tasks[0].task_id, command: canonicalCommand }))
}), /1\.\.32 items/, 'batch concurrency must have a hard item-count bound');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM execution_batches').get().n, batchCountBeforeInvalidInput,
  'invalid batch schema must not create durable batch rows');
const batch = store.createExecutionBatch(job.job_id, { parentTaskId: cto.task_id, role: 'architect', items: tasks.map(t => ({ taskId: t.task_id, command: JSON.parse(t.metadata_json).command })) });
const malformedTypeTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: 'strict batch transition type validation',
  metadata: { deterministic: true, command: canonicalCommand }
});
const malformedTypeBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', items: [{ taskId: malformedTypeTask.task_id, command: canonicalCommand }]
});
const malformedTypeItem = store.listExecutionBatchItems(malformedTypeBatch.batch_id)[0];
assert.throws(() => store.markExecutionBatchItemRunning(malformedTypeBatch.batch_id, malformedTypeItem.item_id, { expectedAttempt: '1' }),
  /exact positive attempt/, 'claim attempt must not coerce a numeric string');
assert.equal(store.listExecutionBatchItems(malformedTypeBatch.batch_id)[0].status, 'PENDING');
assert.ok(store.markExecutionBatchItemRunning(malformedTypeBatch.batch_id, malformedTypeItem.item_id, { expectedAttempt: 1 }));
assert.throws(() => store.finishExecutionBatchItem(malformedTypeBatch.batch_id, malformedTypeItem.item_id, {
  expectedAttempt: 1, exitCode: '0', status: 'COMPLETED'
}), /exit code must be a canonical safe integer/, 'terminal result exit code must not coerce string to success');
assert.equal(store.listExecutionBatchItems(malformedTypeBatch.batch_id)[0].status, 'RUNNING',
  'malformed terminal result must not mutate the running item');
store.finishExecutionBatchItem(malformedTypeBatch.batch_id, malformedTypeItem.item_id, {
  expectedAttempt: 1, exitCode: null, status: 'FAILED', error: 'strict-type fixture terminalization'
});
store.finishExecutionBatch(malformedTypeBatch.batch_id, { status: 'FAILED', aggregateContent: 'strict-type fixture', expectedAttempt: 1 });
const nonDefaultAttemptTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: 'initial batch attempt must bind item attempts',
  metadata: { deterministic: true, command: canonicalCommand }
});
const nonDefaultAttemptBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', attempt: 2,
  items: [{ taskId: nonDefaultAttemptTask.task_id, command: canonicalCommand }]
});
const nonDefaultAttemptItem = store.listExecutionBatchItems(nonDefaultAttemptBatch.batch_id)[0];
assert.equal(nonDefaultAttemptItem.attempt, 2, 'new batch items must inherit the batch initial attempt fence');
assert.ok(store.markExecutionBatchItemRunning(nonDefaultAttemptBatch.batch_id, nonDefaultAttemptItem.item_id, { expectedAttempt: 2 }));
store.finishExecutionBatchItem(nonDefaultAttemptBatch.batch_id, nonDefaultAttemptItem.item_id, {
  expectedAttempt: 2, status: 'FAILED', error: 'non-default attempt fixture'
});
store.finishExecutionBatch(nonDefaultAttemptBatch.batch_id, { status: 'FAILED', aggregateContent: 'non-default attempt fixture', expectedAttempt: 2 });
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
for (const priorSuccess of result.items.filter(item => item.status === 'COMPLETED')) {
  const afterRetry = store.db.prepare('SELECT attempt,execution_session_id,status FROM execution_batch_items WHERE batch_id=? AND item_id=?')
    .get(batch.batch_id, priorSuccess.item_id);
  assert.equal(afterRetry.status, 'COMPLETED');
  assert.equal(afterRetry.attempt, 1, 'already-completed item retains its original attempt instead of replaying with the new batch attempt');
  assert.equal(afterRetry.execution_session_id, priorSuccess.execution_session_id,
    'a retried batch must preserve the original execution session for every previously completed item');
  assert.equal(store.getTask(priorSuccess.task_id).execution_attempt, 1,
    'a completed task is never re-executed just because a sibling failed and the aggregate batch is retried');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, priorSuccess.task_id).n, 1,
    'batch retry must not publish another execution-start event for a prior successful item');
}
assert.equal(store.getTask(retryTarget.task_id).execution_attempt, 2,
  'only the previously failed item advances to its second execution attempt');

// A process exit code of zero is not sufficient for batch success when the
// execution manager deliberately marks the durable task failed because output
// evidence exceeded its capture limit. This exercises the actual supervisor,
// collector, task terminal ledger and batch item/aggregate caller end-to-end.
const outputLimitedCommand = 'node -e "process.stdout.write(Buffer.alloc(5242880, 65))"';
const outputLimitedTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: 'zero-exit output-limit batch must fail',
  metadata: { deterministic: true, command: outputLimitedCommand }
});
const outputLimitedBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect',
  items: [{ taskId: outputLimitedTask.task_id, command: outputLimitedCommand }]
});
const outputLimitedResult = await manager.executeBatch(outputLimitedBatch.batch_id);
assert.equal(store.getTask(outputLimitedTask.task_id).execution_status, 'failed');
assert.equal(outputLimitedResult.status, 'FAILED',
  'a successful process code cannot override the durable task failure caused by truncated evidence');
assert.equal(outputLimitedResult.items[0].status, 'FAILED');
assert.equal(outputLimitedResult.items[0].exit_code, 0,
  'preserve the process exit code while the batch status expresses evidence failure');
assert.match(outputLimitedResult.items[0].error, /output was truncated/);
assert.match(outputLimitedResult.aggregate_content, /summary: total=1 passed=0 failed=1/);
console.log('EXECUTION BATCH ZERO-EXIT / OUTPUT-LIMIT DURABLE FAILURE / NO FALSE AGGREGATE SUCCESS PASS');

// Durable input permits multiple items, but the manager must cap actual local
// process fan-out independently. Replace only this test's executeTask adapter
// to measure scheduler concurrency without starting 17 real child processes.
const fanoutTasks = Array.from({ length: 17 }, (_, index) => store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: `bounded fan-out ${index}`,
  metadata: { deterministic: true, command: 'node --version' }
}));
const fanoutBatch = store.createExecutionBatch(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect',
  items: fanoutTasks.map(task => ({ taskId: task.task_id, command: 'node --version' }))
});
let activeLanes = 0;
let maxActiveLanes = 0;
manager.executeTask = async (taskId, { command, cwd, batchClaim }) => {
  activeLanes++;
  maxActiveLanes = Math.max(maxActiveLanes, activeLanes);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const taskBefore = store.getTask(taskId);
    const attempt = Number(taskBefore.execution_attempt || 0) + 1;
    const executionSessionId = `bounded-fanout-${taskId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    store.prepareExecutionForBatchClaim(taskId, {
      executionSessionId, attempt, command, cwd: cwd || process.cwd(),
      startedAt: new Date().toISOString(), tmuxName: `cos-exec-${executionSessionId}`, boundaryIdentity: null
    }, batchClaim);
    const result = store.finishExecution(taskId, {
      executionSessionId, attempt, command, exitCode: 0,
      stdout: 'bounded-test', stderr: '', status: 'completed', error: null
    });
    return { ...result, exitCode: 0, stdout: 'bounded-test', stderr: '', timedOut: false, outputLimited: false };
  } finally {
    activeLanes--;
  }
};
const fanoutResult = await manager.executeBatch(fanoutBatch.batch_id);
assert.equal(fanoutResult.status, 'COMPLETED');
assert.equal(fanoutResult.items.length, fanoutTasks.length);
assert.ok(maxActiveLanes > 1, 'independent batch items must still run concurrently');
assert.ok(maxActiveLanes <= 8, `batch spawned too many simultaneous lanes: ${maxActiveLanes}`);
assert.equal(fanoutResult.items.every(item => item.status === 'COMPLETED'), true);
console.log(`test-execution-batch: PASS (${elapsed}ms; max bounded lanes=${maxActiveLanes}/8)`);
