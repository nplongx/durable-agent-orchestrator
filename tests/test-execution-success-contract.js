import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-success-contract-');
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager, isVerifiedSuccessfulLocalExecution, isSuccessfulLocalExecutionSummary } = await import('../src/runtime/execution-manager.js');
const { resolveTaskBatchRoute } = await import('../src/runtime/workflow/plan.js');
const store = new WorkflowStore();

try {
  const unattestedJob = store.createJob({ conversationKey: `success-contract-unattested-${process.pid}`, title: 'Unattested output-commit rejection' });
  const unattestedTask = store.ensureTask(unattestedJob.job_id, { role: 'architect', description: 'worker output commit must fail closed' });
  const unattestedLease = store.acquireTaskLease(unattestedTask.task_id, {
    leaseId: `success-contract-unattested-lease-${process.pid}`,
    workerId: `success-contract-unattested-worker-${process.pid}`, ttlMs: 120000, attempt: 1
  });
  const startedAt = new Date().toISOString();
  const finishTime = new Date(Date.now() + 1).toISOString();
  const untrustedOutputClaim = {
    schema_version: 1, job_id: unattestedJob.job_id, task_id: unattestedTask.task_id, lease_id: unattestedLease.lease_id,
    attempt: unattestedLease.attempt, owner_epoch: unattestedLease.owner_epoch, provider_run_attempt: 1,
    status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40), exit_code: 0,
    provider_run_id: `success-contract-untrusted-provider-${process.pid}`,
    evidence_artifact: 'test-only-synthetic-worker-claim',
    evidence_refs: ['task-payload.json', 'execution.json'], started_at: startedAt, finished_at: finishTime, error: null,
    evidence_verification: { valid: true, errors: [], evidence_hash: 'c'.repeat(64) }
  };
  const snapshotUntrustedState = () => {
    const task = store.getTask(unattestedTask.task_id);
    const lease = store.getTaskLease(unattestedLease.lease_id);
    return {
      taskStatus: task.status, executionStatus: task.execution_status, executionAttempt: task.execution_attempt,
      leaseState: lease.state,
      resultCount: store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(unattestedTask.task_id).n,
      artifactCount: store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE task_id=?').get(unattestedTask.task_id).n,
      attemptCount: store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(unattestedTask.task_id).n,
      completionEvents: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('task.completed','task.failed','task.local_completed','task.local_failed') AND json_extract(payload_json,'$.taskId')=?")
        .get(unattestedJob.job_id, unattestedTask.task_id).n,
      verifiedEvents: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('task.execution.verified','task.execution.checkpointed','task.execution.rejected') AND json_extract(payload_json,'$.taskId')=?")
        .get(unattestedJob.job_id, unattestedTask.task_id).n,
      leaseCompletionEvents: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.completed' AND json_extract(payload_json,'$.taskId')=?")
        .get(unattestedJob.job_id, unattestedTask.task_id).n
    };
  };
  const untrustedBefore = snapshotUntrustedState();
  const markedWorkerClaim = {
    ...untrustedOutputClaim,
    evidence_verification: {
      ...untrustedOutputClaim.evidence_verification,
      output_commit_provenance: 'worker_reported_and_execution_json_bound_not_independently_attested'
    }
  };
  const missingOutputCommit = { ...untrustedOutputClaim };
  delete missingOutputCommit.output_commit;
  const nullOutputCommit = { ...untrustedOutputClaim, output_commit: null };
  const emptyOutputCommit = { ...untrustedOutputClaim, output_commit: '' };
  const successShapeVariants = [
    ['stripped worker provenance', untrustedOutputClaim],
    ['worker provenance marker present', markedWorkerClaim],
    ['successful result without output_commit', missingOutputCommit],
    ['successful result with null output_commit', nullOutputCommit],
    ['successful result with empty output_commit', emptyOutputCommit]
  ];
  for (const [label, candidate] of successShapeVariants) {
    const rejected = store.applyVerifiedExecutionResult(candidate);
    assert.equal(rejected.status, 'REJECTED', `${label} must be rejected before durable success is applied`);
    assert.equal(rejected.reason, 'output_commit_attestation_required', `${label} must use the stable quarantine classifier`);
    assert.deepEqual(snapshotUntrustedState(), untrustedBefore,
      `${label} must not publish a result, artifact, attempt, completion event or terminal lease transition`);
    const replay = store.applyVerifiedExecutionResult(candidate);
    assert.equal(replay.status, 'REJECTED');
    assert.equal(replay.reason, 'output_commit_attestation_required', `${label} replay remains fail-closed`);
    assert.deepEqual(snapshotUntrustedState(), untrustedBefore, `${label} replay must be a non-mutating rejection`);
  }

  const validLocalExecution = {
    task_id: 'task-local-success', execution_attempt: 1,
    status: 'completed', execution_status: 'completed', execution_exit_code: 0,
    exitCode: 0, execution_session_id: 'exec-local-success', timedOut: false, outputLimited: false
  };
  assert.equal(isVerifiedSuccessfulLocalExecution(validLocalExecution, 'task-local-success'), true);
  const durableReplaySuccess = { ...validLocalExecution };
  delete durableReplaySuccess.exitCode;
  assert.equal(isVerifiedSuccessfulLocalExecution(durableReplaySuccess, 'task-local-success'), true,
    'idempotent calls that return the exact already-completed durable task row may omit the transient process exitCode');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, exitCode: 0, execution_status: 'failed', status: 'failed', outputLimited: true }, 'task-local-success'), false,
    'an output-limited zero-exit result is not successful for artifacts/runtime reconciliation');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, status: 'failed' }, 'task-local-success'), false,
    'durable task failure must override a zero process exit code');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, outputLimited: true }, 'task-local-success'), false,
    'an output-limit marker must veto even an otherwise success-shaped result');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, timedOut: true }, 'task-local-success'), false,
    'a timeout marker must veto even an otherwise success-shaped result');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, timedOut: 'false' }, 'task-local-success'), false,
    'a malformed string timeout flag must not be treated as false');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, outputLimited: 'false' }, 'task-local-success'), false,
    'a malformed string output-limit flag must not be treated as false');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, execution_session_id: '' }, 'task-local-success'), false,
    'success requires an exact durable execution session identity');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, execution_exit_code: '0' }, 'task-local-success'), false,
    'durable exit codes must not be coercible strings');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, exitCode: null }, 'task-local-success'), false,
    'a supplied non-zero/null process exit result cannot conflict with durable success');
  assert.equal(isVerifiedSuccessfulLocalExecution(validLocalExecution, 'another-task'), false,
    'the result identity must match the production caller’s exact task identity');
  assert.equal(isVerifiedSuccessfulLocalExecution({ ...validLocalExecution, execution_attempt: '1' }, 'task-local-success'), false,
    'durable success requires a positive safe-integer attempt, not a numeric string');
  const validLocalSummary = {
    executed_locally: true, execution_status: 'completed', exit_code: 0, execution_session_id: 'exec-summary',
    returned_task_id: 'task-summary',
    task: { task_id: 'task-summary', status: 'completed', execution_status: 'completed', execution_exit_code: 0,
      execution_session_id: 'exec-summary', execution_attempt: 1 }
  };
  assert.equal(isSuccessfulLocalExecutionSummary(validLocalSummary, 'task-summary'), true);
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, execution_status: 'failed' }, 'task-summary'), false,
    'the E2E workflow loop must not advance on zero exit when durable execution status failed');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, exit_code: '0' }, 'task-summary'), false,
    'the E2E workflow loop must require an exact numeric exit code');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, executed_locally: false }, 'task-summary'), false,
    'the E2E workflow loop must require an actual local execution response');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, task: { ...validLocalSummary.task, status: 'failed' } }, 'task-summary'), false,
    'the E2E workflow loop must not trust top-level success when the durable task status is failed');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, task: { ...validLocalSummary.task, execution_exit_code: null } }, 'task-summary'), false,
    'the E2E workflow loop must reject NULL durable exit evidence');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, task: { ...validLocalSummary.task, execution_session_id: 'other-session' } }, 'task-summary'), false,
    'the E2E workflow loop must bind summary and task to the same execution session');
  assert.equal(isSuccessfulLocalExecutionSummary({ ...validLocalSummary, task: { ...validLocalSummary.task, execution_attempt: '1' } }, 'task-summary'), false,
    'the E2E workflow loop must require a positive numeric durable attempt');
  assert.equal(isSuccessfulLocalExecutionSummary(validLocalSummary, 'wrong-task'), false,
    'the E2E workflow loop must bind the response to the exact requested task');

  const job = store.createJob({ conversationKey: `success-contract-${process.pid}`, title: 'Execution success contract' });
  store.approve(job.job_id, 'isolated success-contract regression fixture', 'test-fixture', { workspace: root });
  const parent = store.dispatch(job.job_id, { role: 'architect', description: 'success-contract parent' });
  const command = 'node --version';
  const task = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    description: 'completion must require an exact success exit code',
    metadata: { deterministic: true, command }
  });
  const executionSessionId = `success-contract-session-${process.pid}`;
  store.prepareExecution(task.task_id, {
    executionSessionId,
    attempt: 1,
    command,
    cwd: root,
    startedAt: new Date().toISOString(),
    tmuxName: `cos-exec-success-contract-${process.pid}`
  });

  for (const invalid of [
    { exitCode: null, error: null },
    { exitCode: 17, error: null },
    { exitCode: 0, error: 'contradictory terminal error' }
  ]) {
    assert.throws(() => store.finishExecution(task.task_id, {
      executionSessionId, attempt: 1, command, stdout: 'must-not-commit', stderr: '',
      status: 'completed', ...invalid
    }), /completed execution (?:requires exact numeric exit code 0|cannot carry a terminal error)/);
  }
  assert.throws(() => store.finishExecution(task.task_id, {
    executionSessionId, attempt: 1, command, exitCode: '0', stdout: 'must-not-commit', stderr: '',
    status: 'completed', error: null
  }), /exit code must be a canonical safe integer/,
  'numeric-string zero must fail before transaction mutation');
  assert.throws(() => store.finishExecution(task.task_id, {
    executionSessionId, attempt: 1, command, exitCode: -0, stdout: 'must-not-commit', stderr: '',
    status: 'completed', error: null
  }), /exit code must be a canonical safe integer/,
  'negative zero must not become a successful durable terminal event');
  assert.equal(store.getTask(task.task_id).execution_status, 'running',
    'invalid success-shaped completion must not mutate the running task');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'")
    .get(task.task_id).n, 1, 'invalid completion must preserve the exact open attempt for valid reconciliation');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled') AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, task.task_id).n, 0, 'invalid completion must not publish a terminal event');

  store.finishExecution(task.task_id, {
    executionSessionId, attempt: 1, command, exitCode: 0, stdout: 'verified-success', stderr: '',
    status: 'completed', error: null
  });
  assert.equal(store.getTask(task.task_id).execution_status, 'completed');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, task.task_id).n, 1);

  // A process can exit 0 but still fail the evidence contract (for example,
  // because stdout/stderr were truncated). Such a failure needs an explicit
  // reason instead of allowing status and process code to contradict silently.
  const limitedTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    description: 'zero exit with incomplete evidence is not completed',
    metadata: { deterministic: true, command }
  });
  const limitedSession = `success-contract-limited-${process.pid}`;
  store.prepareExecution(limitedTask.task_id, {
    executionSessionId: limitedSession, attempt: 1, command, cwd: root,
    startedAt: new Date().toISOString(), tmuxName: `cos-exec-success-contract-limited-${process.pid}`
  });
  assert.throws(() => store.finishExecution(limitedTask.task_id, {
    executionSessionId: limitedSession, attempt: 1, command, exitCode: 0,
    stdout: 'truncated', stderr: '', status: 'failed', error: null
  }), /failed execution with exit code 0 requires an explicit failure reason/);
  store.finishExecution(limitedTask.task_id, {
    executionSessionId: limitedSession, attempt: 1, command, exitCode: 0,
    stdout: 'truncated', stderr: '', status: 'failed', error: 'output evidence truncated'
  });
  assert.equal(store.getTask(limitedTask.task_id).execution_status, 'failed');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, limitedTask.task_id).n, 0,
  'zero process exit with incomplete evidence must not publish execution.completed');

  const batchTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    description: 'batch completion must require exit code zero',
    metadata: { deterministic: true, command }
  });
  const batch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    items: [{ taskId: batchTask.task_id, command }]
  });
  const item = store.listExecutionBatchItems(batch.batch_id)[0];
  assert.ok(store.markExecutionBatchItemRunning(batch.batch_id, item.item_id, { expectedAttempt: 1 }));
  assert.throws(() => store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
    expectedAttempt: 1, executionSessionId: 'forged-success-without-task-ledger',
    status: 'COMPLETED', exitCode: 0, stdout: 'success-shaped-no-ledger', error: null
  }), /completed batch item lacks exact successful durable task\/session\/result evidence/,
  'the store must not accept a success-shaped batch item without a task execution ledger bound to this claim');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING',
    'rejected success-shaped item must roll its tentative CAS back');
  for (const invalid of [
    { exitCode: null, error: null },
    { exitCode: 9, error: null },
    { exitCode: 0, error: 'contradictory terminal error' }
  ]) {
    assert.throws(() => store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
      expectedAttempt: 1, status: 'COMPLETED', stdout: 'must-not-commit', ...invalid
    }), /completed execution batch item (?:requires exact numeric exit code 0|cannot carry a terminal error)/);
  }
  assert.throws(() => store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
    expectedAttempt: 1, status: 'COMPLETED', exitCode: -0, stdout: 'must-not-commit', error: null
  }), /exit code must be a canonical safe integer/,
  'negative zero must be rejected before the batch item can be marked COMPLETED');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING',
    'invalid batch success must leave the current owner claim unchanged');
  const batchSession = `success-contract-batch-session-${process.pid}`;
  const batchStartedAt = new Date().toISOString();
  store.prepareExecutionForBatchClaim(batchTask.task_id, {
    executionSessionId: batchSession, attempt: 1, command, cwd: root,
    startedAt: batchStartedAt, tmuxName: `cos-exec-success-contract-batch-${process.pid}`, boundaryIdentity: null
  }, { batchId: batch.batch_id, itemId: item.item_id, batchAttempt: 1, itemAttempt: 1 });
  store.finishExecution(batchTask.task_id, {
    executionSessionId: batchSession, attempt: 1, command,
    exitCode: 0, stdout: 'verified-success', stderr: '', status: 'completed', error: null
  });
  assert.throws(() => store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
    expectedAttempt: 1, executionSessionId: 'substituted-session', status: 'COMPLETED',
    exitCode: 0, stdout: 'verified-success', stderr: '', error: null
  }), /completed batch item lacks exact successful durable task\/session\/result evidence/,
  'a different execution session must not be attached to a successful task ledger');
  assert.throws(() => store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
    expectedAttempt: 1, executionSessionId: batchSession, status: 'COMPLETED',
    exitCode: 0, stdout: 'substituted-output', stderr: '', error: null
  }), /completed batch item lacks exact successful durable task\/session\/result evidence/,
  'substituted stdout must not be attached to a successful task ledger');
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'RUNNING',
    'mismatched session/output must roll the terminal item transition back');
  store.finishExecutionBatchItem(batch.batch_id, item.item_id, {
    expectedAttempt: 1, executionSessionId: batchSession, status: 'COMPLETED',
    exitCode: 0, stdout: 'verified-success', stderr: '', error: null
  });
  assert.equal(store.listExecutionBatchItems(batch.batch_id)[0].status, 'COMPLETED');
  store.finishExecutionBatch(batch.batch_id, {
    status: 'COMPLETED', aggregateContent: 'validated successful batch fixture', expectedAttempt: 1
  });
  const validationManager = new ExecutionManager(store, { timeoutMs: 1000, executionTmpDir: path.join(root, 'runtime') });
  assert.equal((await validationManager.executeBatch(batch.batch_id)).status, 'COMPLETED',
    'completed batch re-entry must accept a matching durable task/item ledger');
  // Simulate a pre-guard historical false-success projection without touching
  // any repository artifact: a batch row still says COMPLETED while its task
  // terminal state no longer says successful. Re-entry must fail closed.
  store.db.prepare("UPDATE tasks SET status='failed',execution_status='failed' WHERE task_id=?").run(batchTask.task_id);
  await assert.rejects(() => validationManager.executeBatch(batch.batch_id),
    /completed batch item lacks exact successful durable task\/session\/result evidence/);
  assert.equal(store.getExecutionBatch(batch.batch_id).status, 'COMPLETED',
    'validation must not rewrite a historical terminal batch while rejecting its inconsistent success projection');

  const limitedBatchTask = store.createChildTask(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    description: 'batch consumer must not elevate failed zero-exit evidence to success',
    metadata: { deterministic: true, command }
  });
  const limitedBatch = store.createExecutionBatch(job.job_id, {
    parentTaskId: parent.task_id,
    role: 'architect',
    items: [{ taskId: limitedBatchTask.task_id, command }]
  });
  const manager = new ExecutionManager(store, { timeoutMs: 1000, executionTmpDir: path.join(root, 'runtime') });
  manager.executeTask = async () => ({
    execution_status: 'failed', execution_exit_code: 0,
    exitCode: 0, stdout: 'bounded/truncated output', stderr: '', timedOut: false, outputLimited: true
  });
  const limitedAggregate = await manager.executeBatch(limitedBatch.batch_id);
  assert.equal(limitedAggregate.status, 'FAILED',
    'a zero-exit result whose durable task status is failed must not produce a completed batch');
  assert.equal(limitedAggregate.items[0].status, 'FAILED');
  assert.equal(limitedAggregate.items[0].exit_code, 0,
    'preserve the observed process exit code while representing the evidence failure in status/error');
  assert.match(limitedAggregate.items[0].error, /output was truncated/);
  assert.match(limitedAggregate.aggregate_content, /summary: total=1 passed=0 failed=1/);
  assert.match(limitedAggregate.aggregate_content, /"status":"failed","summary":\{"total":1,"passed":0,"failed":1\}/);

  // The immutable plan binds dependency edges too, not only command metadata.
  // A caller can invoke task_execute_local directly without workflow_next_task,
  // so tampering dependency_json must be rejected at every execution/terminal
  // policy boundary before any OS spawn or success evidence is written.
  const productionJob = store.createJob({
    conversationKey: `dependency-binding-${process.pid}`,
    title: 'Production E2E dependency binding regression'
  });
  store.recordEvent(productionJob.job_id, 'job.proposal_requested', {
    task: 'verify immutable dependency edges', workspace: root, workflowId: 'production', executionTarget: 'local'
  }, 'dependency-binding-proposal');
  store.approve(productionJob.job_id, 'isolated dependency binding fixture', 'test-fixture', { workspace: root });
  const productionPlan = store.getExecutionPlan(productionJob.job_id);
  assert.equal(productionPlan.workflow_id, 'production');
  assert.equal(productionPlan.schema_version, 2);
  assert.equal(productionPlan.batch_execution_policy.mode, 'required');
  const productionParent = store.dispatch(productionJob.job_id, { role: 'cto', description: 'dependency binding parent' });
  const architectSpec = productionPlan.children.find(item => item.role === 'architect');
  assert.equal(resolveTaskBatchRoute(productionPlan, architectSpec).required, true,
    'deterministic local tasks must bind to an immutable mandatory batch route');
  const plannedTask = store.createChildTask(productionJob.job_id, {
    parentTaskId: productionParent.task_id,
    role: architectSpec.role,
    description: 'dependency binding planned task',
    dependencies: architectSpec.dependencies,
    metadata: architectSpec.execution
  });
  const structuredCommand = [architectSpec.execution.executable, ...architectSpec.execution.args]
    .map(value => `'${String(value).replace(/'/g, `'\\''`)}'`).join(' ');
  assert.doesNotThrow(() => store.assertPreparedExecutionPlan(plannedTask, {
    command: structuredCommand, cwd: architectSpec.execution.cwd
  }));
  assert.doesNotThrow(() => store.assertSupportedTaskPlanBinding(plannedTask, productionPlan));
  const originalDependencies = plannedTask.dependency_json;
  for (const corruptedDependencies of ['not-json', '["qa-check"]']) {
    store.db.prepare('UPDATE tasks SET dependency_json=? WHERE task_id=?').run(corruptedDependencies, plannedTask.task_id);
    assert.throws(() => store.assertPreparedExecutionPlan(store.getTask(plannedTask.task_id), {
      command: structuredCommand, cwd: architectSpec.execution.cwd
    }), /durable dependencies (?:are malformed|differ from the immutable execution plan)/,
    'execution preparation must reject malformed or substituted durable dependency edges');
    assert.throws(() => store.assertSupportedTaskPlanBinding(store.getTask(plannedTask.task_id), productionPlan),
      /durable dependencies (?:are malformed|differ from the immutable execution plan)/,
      'terminal policy validation must reject dependency-edge tampering');
    await assert.rejects(() => validationManager.executeStructuredTask(plannedTask.task_id, {
      executable: architectSpec.execution.executable,
      args: architectSpec.execution.args,
      timeoutMs: architectSpec.execution.timeout_ms,
      cwd: architectSpec.execution.cwd,
      env: {}
    }), /durable dependencies (?:are malformed|differ from the immutable execution plan)/,
    'the direct ExecutionManager caller must still validate immutable dependencies before enforcing the batch route');
    assert.equal(store.getTask(plannedTask.task_id).execution_attempt ?? 0, 0,
      'dependency tampering must not allocate a durable execution attempt');
  }
  store.db.prepare('UPDATE tasks SET dependency_json=? WHERE task_id=?').run(originalDependencies, plannedTask.task_id);
  const directExecutionAttempt = () => validationManager.executeStructuredTask(plannedTask.task_id, {
    executable: architectSpec.execution.executable,
    args: architectSpec.execution.args,
    timeoutMs: architectSpec.execution.timeout_ms,
    cwd: architectSpec.execution.cwd,
    env: {}
  });
  await assert.rejects(directExecutionAttempt, /batch-required.*direct ExecutionManager execution/,
    'a valid deterministic plan task still cannot bypass the durable batch route');
  await assert.rejects(directExecutionAttempt, /batch-required.*direct ExecutionManager execution/,
    'repeated low-level bypass must remain denied');
  const directDenialRows = store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='batch_execution.policy_denied' AND json_extract(payload_json,'$.rejectedRoute')='execution_manager_single_task' AND json_extract(payload_json,'$.taskId')=?")
    .all(productionJob.job_id, plannedTask.task_id);
  assert.equal(directDenialRows.length, 1, 'low-level bypass audit must be idempotent');
  const directDenial = JSON.parse(directDenialRows[0].payload_json);
  assert.equal(directDenial.reasonCode, 'batch_route_required');
  assert.equal(directDenial.policyVersion, 1);
  assert.equal(Object.hasOwn(directDenial, 'command'), false);
  assert.equal(Object.hasOwn(directDenial, 'args'), false);
  assert.equal(Object.hasOwn(directDenial, 'env'), false);
  assert.equal(JSON.stringify(directDenial).includes(architectSpec.execution.executable), false,
    'low-level denial audit must not store the caller command/executable');
  assert.equal(JSON.stringify(directDenial).includes(JSON.stringify(architectSpec.execution.args)), false,
    'low-level denial audit must not store command arguments');
  assert.equal(store.getTask(plannedTask.task_id).execution_attempt ?? 0, 0,
    'the batch-route guard must reject before allocating an OS execution attempt');
  assert.doesNotThrow(() => store.assertPreparedExecutionPlan(store.getTask(plannedTask.task_id), {
    command: structuredCommand, cwd: architectSpec.execution.cwd
  }), 'restoring the exact immutable dependency list should restore validation');

  console.log('EXECUTION COMPLETION AND BATCH AGGREGATE SUCCESS/EXIT-CODE/EVIDENCE CONTRACT PASS');
} finally {
  try { store.db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
