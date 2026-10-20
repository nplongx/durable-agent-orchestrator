import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('verified-execution-result-atomicity-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = root;
const storeModulePath = path.resolve(process.env.PHASE2_TEST_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey } = await import('../src/runtime/provider-dispatch-identity.js');
const store = new WorkflowStore();
const timestamp = () => new Date().toISOString();
// Synthetic Git SHA/digest values below exist only to exercise isolated SQLite
// result/artifact transaction rollback mechanics. They do not represent a real
// repository revision, worker authenticity, or an independent output attestation.
const TEST_ONLY_SYNTHETIC_INPUT_COMMIT = 'a'.repeat(40);
const TEST_ONLY_SYNTHETIC_OUTPUT_COMMIT = 'b'.repeat(40);
const TEST_ONLY_SYNTHETIC_EVIDENCE_HASH = 'c'.repeat(64);
const architectureOutput = JSON.stringify({
  components: ['isolated provider result fixture'], interfaces: [], failure_modes: [],
  implementation_boundary: 'test-only; validates durable result/artifact transaction'
});

function makeLease(label) {
  const job = store.createJob({ conversationKey: `verified-result-${label}-${process.pid}`, title: `Verified result ${label}` });
  const task = store.ensureTask(job.job_id, { role: 'architect', description: `Typed provider result ${label}` });
  const metadata = JSON.parse(task.metadata_json || '{}');
  metadata.runtime_owner = 'github-runner';
  store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify(metadata), task.task_id);
  const lease = store.acquireTaskLease(task.task_id, {
    leaseId: `lease-${label}-${process.pid}`, workerId: `worker-${label}`, ttlMs: 120000, attempt: 1
  });
  return { job, task: store.getTask(task.task_id), lease };
}

function resultFor({ job, task, lease }, providerRunId) {
  const started = timestamp();
  return {
    schema_version: 1, job_id: job.job_id, task_id: task.task_id, lease_id: lease.lease_id,
    attempt: lease.attempt, owner_epoch: lease.owner_epoch, provider_run_attempt: 1,
    status: 'SUCCEEDED', input_commit: TEST_ONLY_SYNTHETIC_INPUT_COMMIT, output_commit: TEST_ONLY_SYNTHETIC_OUTPUT_COMMIT,
    exit_code: 0, provider_run_id: providerRunId, evidence_artifact: `artifact-${providerRunId}`,
    evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
    started_at: started, finished_at: timestamp(), agent_output: architectureOutput,
    evidence_verification: { evidence_hash: TEST_ONLY_SYNTHETIC_EVIDENCE_HASH, errors: [], valid: true }
  };
}

function inspectIndependent(taskId, jobId) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      task: db.prepare('SELECT task_id, job_id, status, execution_attempt FROM tasks WHERE task_id=?').get(taskId),
      results: db.prepare('SELECT result_id, task_id, outcome, content FROM results WHERE task_id=? ORDER BY rowid').all(taskId),
      artifacts: db.prepare('SELECT artifact_id, task_id, kind, status, evidence_json FROM artifacts WHERE task_id=? ORDER BY rowid').all(taskId),
      attempts: db.prepare('SELECT attempt_id, task_id, status, started_at, finished_at FROM attempts WHERE task_id=? ORDER BY rowid').all(taskId),
      lease: db.prepare('SELECT lease_id, task_id, attempt, state FROM task_leases WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId),
      completionEvents: db.prepare("SELECT event_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.completed','task.failed','task.local_completed','task.local_failed') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId),
      resultEvents: db.prepare("SELECT event_id, type, payload_json FROM events WHERE job_id=? AND type IN ('task.execution.verified','task.execution.checkpointed','task.execution.rejected') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId),
      leaseEvents: db.prepare("SELECT event_id, type, payload_json FROM events WHERE job_id=? AND type='task.lease.completed' AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId)
    };
  } finally { db.close(); }
}

// A worker-reported output commit is only an internally consistent claim, not
// an independently attested output revision. It must not terminalize a task
// or publish a result until a separate trust domain can attest that commit.
{
  const fixture = makeLease('unattested-output-commit');
  const result = resultFor(fixture, `provider-unattested-output-${process.pid}`);
  result.evidence_verification = {
    ...result.evidence_verification,
    output_commit_provenance: 'worker_reported_and_execution_json_bound_not_independently_attested'
  };
  const rejected = store.applyVerifiedExecutionResult(result);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'output_commit_attestation_required',
    'unattested output commits need an explicit fail-closed disposition, not a generic evidence-shape error');
  const afterReject = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterReject.task.status, 'running');
  assert.equal(afterReject.results.length, 0);
  assert.equal(afterReject.artifacts.length, 0);
  assert.equal(afterReject.attempts.length, 0);
  assert.equal(afterReject.lease.state, 'ACTIVE');
  assert.equal(afterReject.completionEvents.length, 0);
  assert.equal(afterReject.resultEvents.length, 0);
  assert.equal(afterReject.leaseEvents.length, 0);
}

// 1. Deterministic artifact-write failure after result INSERT must roll the
// whole result/typed-artifact/task/lease/event transition back; same lease retry
// must then settle one coherent state.
{
  const fixture = makeLease('rollback');
  const result = resultFor(fixture, `provider-rollback-${process.pid}`);
  assert.equal(store.applyVerifiedExecutionResult({
    ...result, evidence_verification: { valid: true, errors: [], evidence_hash: 'd'.repeat(64), skipped: true }
  }).reason, 'execution_evidence_not_verified', 'legacy skipped verification must not enter the durable result consumer');
  const originalCreateArtifact = store.createArtifact.bind(store);
  let injected = false;
  store.createArtifact = input => {
    if (!injected && input.type === 'architecture') {
      injected = true;
      throw new Error('injected provider typed-artifact persistence failure');
    }
    return originalCreateArtifact(input);
  };
  try {
    assert.throws(() => store.applyVerifiedExecutionResult(result), /injected provider typed-artifact persistence failure/);
    assert.equal(injected, true);
    const afterFailure = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.results.length, 0, 'a failed artifact write must not leave a durable success result');
    assert.equal(afterFailure.artifacts.length, 0);
    assert.equal(afterFailure.attempts.length, 0, 'artifact failure must not leave a detached attempt row');
    assert.equal(afterFailure.lease.state, 'ACTIVE');
    assert.equal(afterFailure.completionEvents.length, 0);
    assert.equal(afterFailure.resultEvents.length, 0);
    assert.equal(afterFailure.leaseEvents.length, 0);
  } finally { store.createArtifact = originalCreateArtifact; }
  assert.equal(store.applyVerifiedExecutionResult(result).status, 'VERIFIED');
  const recovered = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(recovered.task.status, 'completed');
  assert.equal(recovered.results.length, 1);
  assert.equal(JSON.parse(recovered.results[0].content).provider_run_id, result.provider_run_id);
  assert.equal(recovered.artifacts.length, 1);
  assert.equal(recovered.artifacts[0].kind, 'architecture');
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].status, 'completed');
  assert.ok(recovered.attempts[0].finished_at);
  assert.equal(recovered.lease.state, 'COMPLETED');
  assert.equal(recovered.completionEvents.length, 1);
  assert.equal(recovered.resultEvents.length, 1);
  assert.equal(recovered.leaseEvents.length, 1);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'duplicate_provider_result');
  assert.equal(store.applyVerifiedExecutionResult({ ...result, output_commit: 'f'.repeat(40) }).reason, 'provider_result_duplicate_conflict',
    'same provider_run_id with substituted terminal output must not be reported as an exact duplicate');
  const executionEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='task.execution.verified' AND json_extract(payload_json,'$.leaseId')=?")
    .get(fixture.job.job_id, fixture.lease.lease_id);
  const canonicalExecutionEvent = executionEvent.payload_json;
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
    .run(canonicalExecutionEvent.replace('"evidenceHash":', '"evidenceHash":"tampered","evidenceHash":'), executionEvent.event_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'exact duplicate result bytes cannot mask a tampered terminal execution event');
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalExecutionEvent, executionEvent.event_id);
  const canonicalResult = store.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE task_id=?').get(fixture.task.task_id);
  store.db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)')
    .run(`duplicate-${canonicalResult.result_id}`, canonicalResult.task_id, canonicalResult.outcome, canonicalResult.content, timestamp());
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'two durable rows claiming the same provider_run_id must not be collapsed into an idempotent duplicate');
  store.db.prepare('DELETE FROM results WHERE result_id=?').run(`duplicate-${canonicalResult.result_id}`);

  const artifactRow = store.db.prepare('SELECT artifact_id,content FROM artifacts WHERE task_id=?').get(fixture.task.task_id);
  store.db.prepare('UPDATE artifacts SET content=? WHERE artifact_id=?').run(`${artifactRow.content} `, artifactRow.artifact_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a duplicate callback must revalidate the artifact bytes against its immutable artifact.created digest');
  store.db.prepare('UPDATE artifacts SET content=? WHERE artifact_id=?').run(artifactRow.content, artifactRow.artifact_id);

  const attemptRow = store.db.prepare('SELECT attempt_id,status FROM attempts WHERE task_id=?').get(fixture.task.task_id);
  store.db.prepare("UPDATE attempts SET status='failed' WHERE attempt_id=?").run(attemptRow.attempt_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a duplicate callback must reconcile the exact attempt row instead of trusting the completion event alone');
  store.db.prepare("UPDATE attempts SET status='completed' WHERE attempt_id=?").run(attemptRow.attempt_id);

  const leaseEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='task.lease.completed' AND json_extract(payload_json,'$.leaseId')=?")
    .get(fixture.job.job_id, fixture.lease.lease_id);
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
    .run(leaseEvent.payload_json.replace('"success":true', '"success":false'), leaseEvent.event_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a duplicate callback must not mask a contradictory terminal lease event');
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(leaseEvent.payload_json, leaseEvent.event_id);
  console.log('VERIFIED RESULT ARTIFACT-FAILURE ROLLBACK/RETRY PASS');
}

// 2. Kill a separate writer after the result row is inserted but while its
// savepoint is still open. A fresh connection must not observe an orphan row.
{
  const fixture = makeLease('sigkill');
  const result = resultFor(fixture, `provider-sigkill-${process.pid}`);
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.applyVerifiedExecutionResult(${JSON.stringify(result)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_VERIFIED_RESULT_INSERT: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `writer should be killed at the open-savepoint boundary: ${child.stderr}`);
  const afterCrash = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterCrash.task.status, 'running');
  assert.equal(afterCrash.results.length, 0, 'SIGKILL must roll back uncommitted provider result bytes');
  assert.equal(afterCrash.artifacts.length, 0);
  assert.equal(afterCrash.attempts.length, 0);
  assert.equal(afterCrash.lease.state, 'ACTIVE');
  assert.equal(afterCrash.completionEvents.length, 0);
  assert.equal(afterCrash.resultEvents.length, 0);
  assert.equal(afterCrash.leaseEvents.length, 0);
  assert.equal(store.applyVerifiedExecutionResult(result).status, 'VERIFIED');
  const afterRestartRetry = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterRestartRetry.results.length, 1);
  assert.equal(afterRestartRetry.artifacts.length, 1);
  assert.equal(afterRestartRetry.attempts.length, 1);
  assert.equal(afterRestartRetry.attempts[0].status, 'completed');
  assert.equal(afterRestartRetry.task.status, 'completed');
  assert.equal(afterRestartRetry.lease.state, 'COMPLETED');
  assert.equal(afterRestartRetry.completionEvents.length, 1);
  assert.equal(afterRestartRetry.resultEvents.length, 1);
  assert.equal(afterRestartRetry.leaseEvents.length, 1);
  console.log('VERIFIED RESULT SIGKILL/INDEPENDENT REOPEN/RETRY PASS');
}

// Crash later in the same transaction, after task/result/artifact/attempt have
// been updated and the lease row is switched to COMPLETED but before either
// lease or result completion events are recorded. The outer result savepoint
// must roll the entire transition back, including the nested lease savepoint.
{
  const fixture = makeLease('lease-complete-sigkill');
  const result = resultFor(fixture, `provider-lease-complete-sigkill-${process.pid}`);
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.applyVerifiedExecutionResult(${JSON.stringify(result)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_COMPLETE_STATE_UPDATE: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `writer should die after changing the lease but before event persistence: ${child.stderr}`);
  const afterCrash = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterCrash.task.status, 'running');
  assert.equal(afterCrash.results.length, 0);
  assert.equal(afterCrash.artifacts.length, 0);
  assert.equal(afterCrash.attempts.length, 0);
  assert.equal(afterCrash.lease.state, 'ACTIVE', 'nested lease update must roll back with the outer result transaction');
  assert.equal(afterCrash.resultEvents.length, 0);
  assert.equal(afterCrash.completionEvents.length, 0);
  assert.equal(afterCrash.leaseEvents.length, 0);
  assert.equal(store.applyVerifiedExecutionResult(result).status, 'VERIFIED');
  const afterRecovery = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterRecovery.task.status, 'completed');
  assert.equal(afterRecovery.results.length, 1);
  assert.equal(afterRecovery.artifacts.length, 1);
  assert.equal(afterRecovery.attempts.length, 1);
  assert.equal(afterRecovery.lease.state, 'COMPLETED');
  assert.equal(afterRecovery.resultEvents.length, 1);
  assert.equal(afterRecovery.completionEvents.length, 1);
  assert.equal(afterRecovery.leaseEvents.length, 1);
  console.log('VERIFIED RESULT SIGKILL AFTER LEASE STATE CHANGE/ATOMIC RECOVERY PASS');
}

// 3. Two real processes cross the same preflight barrier and attempt to apply
// one provider result. Writer serialization must elect one winner; duplicate
// provider identity and all durable rows/events must remain singular.
{
  const fixture = makeLease('race');
  const result = resultFor(fixture, `provider-race-${process.pid}`);
  const barrierDir = path.join(root, 'verified-result-writer-barrier');
  fs.mkdirSync(barrierDir, { mode: 0o700 });
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    try { const answer = store.applyVerifiedExecutionResult(${JSON.stringify(result)}); console.log('RESULT_OUTCOME:' + JSON.stringify(answer)); }
    catch (error) { console.error('RESULT_ERROR:' + String(error?.message || error)); process.exitCode = 31; }
    finally { try { store.db.close(); } catch {} }
  `;
  const children = Array.from({ length: 2 }, () => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root,
        NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_VERIFIED_RESULT_BARRIER_DIR: barrierDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { proc, closed };
  });
  try {
    const readyFiles = children.map(({ proc }) => path.join(barrierDir, `${proc.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyFiles.every(file => fs.existsSync(file))) {
      if (Date.now() >= deadline) throw new Error('verified-result processes did not both reach barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    fs.writeFileSync(path.join(barrierDir, 'release'), 'release both provider result writers\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(children.map(({ closed }) => closed));
    assert.equal(outcomes.filter(item => item.code === 0 && item.stdout.includes('"status":"VERIFIED"')).length, 1,
      `exactly one provider result writer should win: ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes.filter(item => item.code === 0 && item.stdout.includes('"reason":"duplicate_provider_result"')).length, 1,
      `the loser should be rejected as duplicate provider result: ${JSON.stringify(outcomes)}`);
    const afterRace = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterRace.results.length, 1);
    assert.equal(afterRace.artifacts.length, 1);
    assert.equal(afterRace.attempts.length, 1);
    assert.equal(afterRace.attempts[0].status, 'completed');
    assert.equal(afterRace.task.status, 'completed');
    assert.equal(afterRace.lease.state, 'COMPLETED');
    assert.equal(afterRace.completionEvents.length, 1);
    assert.equal(afterRace.resultEvents.length, 1);
    assert.equal(afterRace.leaseEvents.length, 1);
  } finally {
    for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  console.log('VERIFIED RESULT TWO-PROCESS DUPLICATE RACE PASS');
}

// When the provider-run ledger exists (the production GitHub Actions setup),
// task/lease identity alone is not enough: provider-run ID, input commit and
// output commit must agree with the durable dispatch/run record. A consistent
// but substituted output-commit claim must not create a task result.
{
  new GitHubActionsProvider({ token: 'local-test-token', owner: 'example', repo: 'verified-result', workflow: 'test-worker.yml', ref: 'main', store,
    fetchImpl: async () => { throw new Error('provider schema bootstrap must not call the network'); } });
  const fixture = makeLease('provider-ledger-binding');
  const result = resultFor(fixture, `provider-ledger-${process.pid}`);
  const now = timestamp();
  const request = { schema_version: 1, job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
    attempt: result.attempt, owner_epoch: result.owner_epoch, role: 'engineer', input_commit: result.input_commit,
    task_payload_ref: `task://${result.task_id}`, workspace: 'ephemeral', required_evidence: ['task-payload.json', 'execution.json'] };
  const config = { provider: 'github-actions', api_base: 'https://api.github.com', workflow: 'test-worker.yml',
    repository: 'example/verified-result', event: 'workflow_dispatch', ref: 'main' };
  const identity = createProviderDispatchIdentity(request, config);
  const dispatchKey = providerDispatchKey(identity);
  const requestJson = canonicalProviderDispatchRequest(request);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?,?)`)
    .run(dispatchKey, identity.job_id, identity.task_id, identity.lease_id, identity.attempt, identity.owner_epoch, identity.provider,
      identity.input_commit, identity.request_sha256, requestJson, identity.api_base, identity.workflow, identity.repository,
      identity.event, identity.ref, result.provider_run_id, now, now);
  store.db.prepare(`INSERT INTO provider_runs
    (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,artifact_id,output_commit,run_attempt,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'COMPLETED','success',?,?,1,?,?)`)
    .run(result.provider_run_id, 'github-actions', result.job_id, result.task_id, result.lease_id, result.attempt,
      result.owner_epoch, result.input_commit, dispatchKey, identity.request_sha256, identity.workflow, identity.ref,
      '9001', 'c'.repeat(40), now, now);
  store.db.prepare("UPDATE provider_runs SET conclusion='failure' WHERE provider_run_id=?").run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_run_result_binding_mismatch',
    'a successful result cannot be accepted against a contradictory provider failure conclusion');
  assert.equal(inspectIndependent(fixture.task.task_id, fixture.job.job_id).results.length, 0);
  store.db.prepare("UPDATE provider_runs SET conclusion='success' WHERE provider_run_id=?").run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_run_result_binding_mismatch');
  assert.equal(inspectIndependent(fixture.task.task_id, fixture.job.job_id).results.length, 0,
    'provider run output commit mismatch must not publish a task result');
  store.db.prepare('UPDATE provider_runs SET output_commit=? WHERE provider_run_id=?').run(result.output_commit, result.provider_run_id);
  store.db.prepare('UPDATE provider_runs SET artifact_id=NULL WHERE provider_run_id=?').run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_run_result_binding_mismatch',
    'a verified result cannot be committed if the durable provider-run artifact provenance pointer is missing');
  store.db.prepare("UPDATE provider_runs SET artifact_id='9001' WHERE provider_run_id=?").run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).status, 'VERIFIED');
  const afterBindingRetry = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterBindingRetry.results.length, 1);
  assert.equal(afterBindingRetry.lease.state, 'COMPLETED');
  assert.equal(afterBindingRetry.completionEvents.length, 1);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'duplicate_provider_result',
    'an exact duplicate remains a no-op only while provider-run and immutable dispatch-intent lineage reconcile');
  store.db.prepare("UPDATE provider_runs SET conclusion='failure' WHERE provider_run_id=?").run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a late duplicate callback must not hide a provider-run conclusion changed after result commit');
  store.db.prepare("UPDATE provider_runs SET conclusion='success' WHERE provider_run_id=?").run(result.provider_run_id);
  store.db.prepare('UPDATE provider_dispatch_intents SET request_json=? WHERE dispatch_key=?')
    .run(`${requestJson} `, dispatchKey);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a late duplicate callback must revalidate exact canonical request bytes and digest');
  store.db.prepare('UPDATE provider_dispatch_intents SET request_json=? WHERE dispatch_key=?').run(requestJson, dispatchKey);
  store.db.prepare("UPDATE provider_dispatch_intents SET state='DISPATCHING' WHERE dispatch_key=?").run(dispatchKey);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a terminal result cannot conceal a dispatch intent that has regressed from DISPATCHED');
  store.db.prepare("UPDATE provider_dispatch_intents SET state='DISPATCHED' WHERE dispatch_key=?").run(dispatchKey);
  store.db.prepare('UPDATE provider_runs SET artifact_id=NULL WHERE provider_run_id=?').run(result.provider_run_id);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'provider_result_duplicate_terminal_lineage_mismatch',
    'a duplicate callback must reject a missing durable provider artifact pointer');
  store.db.prepare("UPDATE provider_runs SET artifact_id='9001' WHERE provider_run_id=?").run(result.provider_run_id);
  console.log('VERIFIED RESULT EXACT DISPATCH INTENT / REQUEST DIGEST / OWNER EPOCH / RUN ATTEMPT BINDING PASS');

  const tamperedFixture = makeLease('provider-ledger-tampered-intent');
  const tamperedResult = resultFor(tamperedFixture, `provider-ledger-tampered-${process.pid}`);
  const tamperedRequest = { ...request, job_id: tamperedResult.job_id, task_id: tamperedResult.task_id,
    lease_id: tamperedResult.lease_id, attempt: tamperedResult.attempt, owner_epoch: tamperedResult.owner_epoch };
  const tamperedIdentity = createProviderDispatchIdentity(tamperedRequest, config);
  const tamperedKey = providerDispatchKey(tamperedIdentity);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?,?)`)
    .run(tamperedKey, tamperedIdentity.job_id, tamperedIdentity.task_id, tamperedIdentity.lease_id, tamperedIdentity.attempt,
      tamperedIdentity.owner_epoch, tamperedIdentity.provider, tamperedIdentity.input_commit, tamperedIdentity.request_sha256,
      canonicalProviderDispatchRequest(tamperedRequest), tamperedIdentity.api_base, tamperedIdentity.workflow, tamperedIdentity.repository,
      tamperedIdentity.event, tamperedIdentity.ref, tamperedResult.provider_run_id, now, now);
  store.db.prepare(`INSERT INTO provider_runs
    (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,artifact_id,output_commit,run_attempt,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'COMPLETED','success',?,?,1,?,?)`)
    .run(tamperedResult.provider_run_id, 'github-actions', tamperedResult.job_id, tamperedResult.task_id, tamperedResult.lease_id,
      tamperedResult.attempt, tamperedResult.owner_epoch, tamperedResult.input_commit, tamperedKey, tamperedIdentity.request_sha256,
      tamperedIdentity.workflow, tamperedIdentity.ref, '9002', tamperedResult.output_commit, now, now);
  store.db.prepare('UPDATE provider_dispatch_intents SET request_json=? WHERE dispatch_key=?')
    .run(requestJson, tamperedKey);
  assert.equal(store.applyVerifiedExecutionResult(tamperedResult).reason, 'provider_dispatch_intent_result_binding_mismatch',
    'tampered request bytes with an otherwise matching run/lease must not publish a result');
  assert.equal(inspectIndependent(tamperedFixture.task.task_id, tamperedFixture.job.job_id).results.length, 0);
  store.db.prepare('UPDATE provider_dispatch_intents SET request_json=? WHERE dispatch_key=?')
    .run(canonicalProviderDispatchRequest(tamperedRequest), tamperedKey);
  store.db.prepare('UPDATE provider_dispatch_intents SET owner_epoch=owner_epoch+1 WHERE dispatch_key=?').run(tamperedKey);
  assert.equal(store.applyVerifiedExecutionResult(tamperedResult).reason, 'provider_dispatch_intent_result_binding_mismatch',
    'a stale owner epoch in the intent must not authorize result publication');
  store.db.prepare('UPDATE provider_dispatch_intents SET owner_epoch=? WHERE dispatch_key=?')
    .run(tamperedIdentity.owner_epoch, tamperedKey);
  assert.throws(() => store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    SELECT ?,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at
    FROM provider_dispatch_intents WHERE dispatch_key=?`).run('f'.repeat(64), tamperedKey),
  /UNIQUE constraint failed/, 'the durable schema must prevent a second intent for the same attempt tuple');
  store.db.prepare('DELETE FROM provider_dispatch_intents WHERE dispatch_key=?').run(tamperedKey);
  assert.equal(store.applyVerifiedExecutionResult(tamperedResult).reason, 'provider_dispatch_intent_result_binding_mismatch',
    'a provider-run row without its durable dispatch intent must not publish a result');
  assert.equal(store.applyVerifiedExecutionResult({ ...tamperedResult, owner_epoch: tamperedResult.owner_epoch + 1 }).reason, 'provider_run_result_binding_mismatch',
    'a result from a stale lease owner epoch must not be accepted');
  assert.equal(store.applyVerifiedExecutionResult({ ...tamperedResult, provider_run_attempt: 2 }).reason, 'provider_run_result_binding_mismatch',
    'a stale or substituted provider run_attempt must not be accepted');
  console.log('VERIFIED RESULT PROVIDER-LEDGER INPUT/OUTPUT BINDING PASS');
}

// 4. Lease expiry mutates lease state, task state, and the event ledger. A
// persistence exception and a real process death after both row updates must
// roll all three back; the recovery retry must then settle them coherently.
{
  const fixture = makeLease('expire-rollback');
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.lease.expired') throw new Error('injected lease-expiry event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.expireTaskLease(fixture.lease.lease_id, { reason: 'injected expiry transaction failure' }), /injected lease-expiry event persistence failure/);
    const afterFailure = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterFailure.lease.state, 'ACTIVE');
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.leaseEvents.length, 0);
  } finally { store.recordEvent = originalRecordEvent; }
  assert.equal(store.expireTaskLease(fixture.lease.lease_id, { reason: 'retry expiry after rolled-back write' }).state, 'EXPIRED');
  const afterRetry = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(afterRetry.lease.state, 'EXPIRED');
  assert.equal(afterRetry.task.status, 'pending');
  assert.equal(afterRetry.leaseEvents.length, 0, 'expiry event is not the lease-completed event inspected by the common result trace helper');

  const crashFixture = makeLease('expire-sigkill');
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.expireTaskLease(${JSON.stringify(crashFixture.lease.lease_id)}, { reason: 'writer killed after task reset' });
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_EXPIRE_STATE_UPDATE: 'SIGKILL' }
  });
  assert.equal(crashed.signal, 'SIGKILL', `lease expiry child should die while savepoint is open: ${crashed.stderr}`);
  const afterProcessDeath = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(afterProcessDeath.lease.state, 'ACTIVE');
  assert.equal(afterProcessDeath.task.status, 'running');
  assert.equal(afterProcessDeath.leaseEvents.length, 0);
  const expiryEventCount = () => {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    try { return db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.expired' AND json_extract(payload_json,'$.leaseId')=?")
      .get(crashFixture.job.job_id, crashFixture.lease.lease_id).n; }
    finally { db.close(); }
  };
  assert.equal(expiryEventCount(), 0);
  assert.equal(store.expireTaskLease(crashFixture.lease.lease_id, { reason: 'recovery expiry after SIGKILL' }).state, 'EXPIRED');
  assert.equal(expiryEventCount(), 1);
  assert.equal(store.expireTaskLease(crashFixture.lease.lease_id, { reason: 'repeated expiry must be a no-op' }), null);
  assert.equal(expiryEventCount(), 1, 'repeated expiry must not create duplicate ledger events');
  const settled = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(settled.lease.state, 'EXPIRED');
  assert.equal(settled.task.status, 'pending');
  console.log('TASK LEASE EXPIRY FAILURE-ROLLBACK/SIGKILL-RECOVERY PASS');
}

// A standalone lease completion also has a row-state -> event-write failure
// window. Both injected event failure and process death after the state update
// must roll back the lease row, not leave an untraceable completed lease.
{
  const fixture = makeLease('complete-rollback');
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'task.lease.completed') throw new Error('injected lease-completion event persistence failure');
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.completeTaskLease(fixture.lease.lease_id, { workerId: fixture.lease.worker_id, success: true }), /injected lease-completion event persistence failure/);
    const afterFailure = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
    assert.equal(afterFailure.lease.state, 'ACTIVE');
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.leaseEvents.length, 0);
  } finally { store.recordEvent = originalRecordEvent; }
  const completed = store.completeTaskLease(fixture.lease.lease_id, { workerId: fixture.lease.worker_id, success: true });
  assert.equal(completed.ok, true);
  assert.equal(completed.lease.state, 'COMPLETED');
  assert.equal(inspectIndependent(fixture.task.task_id, fixture.job.job_id).leaseEvents.length, 1);

  const crashFixture = makeLease('complete-sigkill');
  const childCode = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.completeTaskLease(${JSON.stringify(crashFixture.lease.lease_id)}, { workerId: ${JSON.stringify(crashFixture.lease.worker_id)}, success: true });
  `;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, NODE_ENV: 'test',
      CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_COMPLETE_STATE_UPDATE: 'SIGKILL' }
  });
  assert.equal(crashed.signal, 'SIGKILL', `lease completion child should die while savepoint is open: ${crashed.stderr}`);
  const afterCrash = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(afterCrash.lease.state, 'ACTIVE');
  assert.equal(afterCrash.leaseEvents.length, 0);
  assert.equal(store.completeTaskLease(crashFixture.lease.lease_id, { workerId: crashFixture.lease.worker_id, success: true }).lease.state, 'COMPLETED');
  const recovered = inspectIndependent(crashFixture.task.task_id, crashFixture.job.job_id);
  assert.equal(recovered.lease.state, 'COMPLETED');
  assert.equal(recovered.leaseEvents.length, 1);
  console.log('TASK LEASE COMPLETION FAILURE-ROLLBACK/SIGKILL-RECOVERY PASS');
}

// A corrupted expiry value is not comparable as a normal timestamp. It must
// never pass the provider-result gate merely because `NaN <= Date.now()` is
// false; malformed durable lease state is quarantined before result/artifact
// writes, with the result rejected and no false success.
{
  const fixture = makeLease('malformed-expiry');
  store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?')
    .run('not-a-canonical-expiry', fixture.lease.lease_id);
  const result = resultFor(fixture, `provider-malformed-expiry-${process.pid}`);
  const rejected = store.applyVerifiedExecutionResult(result);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'lease_expiry_malformed');
  const after = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(after.task.status, 'failed');
  assert.equal(after.lease.state, 'FAILED');
  assert.equal(after.results.length, 0, 'malformed lease expiry must not allow provider result persistence');
  assert.equal(after.artifacts.length, 0, 'malformed lease expiry must not allow typed artifact persistence');
  assert.equal(after.completionEvents.length, 0, 'malformed lease expiry must not emit task result events');
  assert.equal(after.resultEvents.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?")
    .get(fixture.job.job_id, fixture.lease.lease_id).n, 1,
  'malformed expiry quarantine must be recorded exactly once');
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'lease_not_active',
    'a repeated callback cannot reapply result after expiry quarantine');
  console.log('VERIFIED RESULT MALFORMED LEASE EXPIRY / NO FALSE SUCCESS / QUARANTINE PASS');
}

// A completed/failed/cancelled parent is an authority boundary for result
// persistence. A late provider callback must not revive success or emit result
// artifacts; the active lease is settled without re-opening the terminal job.
{
  const fixture = makeLease('terminal-parent');
  store.transition(fixture.job.job_id, 'FAILED', 'failed');
  const result = resultFor(fixture, `provider-terminal-parent-${process.pid}`);
  const rejected = store.applyVerifiedExecutionResult(result);
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'parent_job_not_active');
  const after = inspectIndependent(fixture.task.task_id, fixture.job.job_id);
  assert.equal(store.getJob(fixture.job.job_id).status, 'failed');
  assert.ok(['pending', 'failed', 'cancelled', 'completed'].includes(after.task.status));
  assert.notEqual(after.lease.state, 'ACTIVE');
  assert.equal(after.results.length, 0);
  assert.equal(after.artifacts.length, 0);
  assert.equal(after.completionEvents.length, 0);
  assert.equal(store.applyVerifiedExecutionResult(result).reason, 'lease_not_active',
    'repeated late callbacks must not reopen a result for a terminal parent');
  console.log('VERIFIED RESULT TERMINAL PARENT / NO FALSE SUCCESS / LEASE SETTLEMENT PASS');
}

console.log('VERIFIED EXECUTION RESULT ATOMICITY PASS');
