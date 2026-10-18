import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-execution-terminal-ledger-'));
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
for (const name of ['server.js', 'test-tool-turn.js']) fs.writeFileSync(path.join(workspace, name), 'export const fixture = true;\n', { mode: 0o600, flag: 'wx' });
const dbPath = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = workspace;
process.env.NODE_ENV = 'test';
const storeModulePath = path.resolve(process.env.PHASE2_TEST_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const store = new WorkflowStore();
// Every database/workspace/barrier in this test belongs to the mkdtemp root;
// clean only that owned fixture even when an assertion throws or SIGKILL
// injection aborts one of the child writers.
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const timestamp = () => new Date().toISOString();

function fixture(label, { prepare = true } = {}) {
  const job = store.createJob({ conversationKey: `finish-execution-${label}-${process.pid}`, title: `Production E2E finishExecution ${label}` });
  store.recordEvent(job.job_id, 'job.proposal_requested', { task: job.title, workspace }, `approved-workspace|${job.title}`);
  store.approve(job.job_id, 'test-only approval for isolated local fixture', 'test-fixture', { workspace });
  const cto = store.dispatch(job.job_id, { role: 'cto', description: 'fixture synthesis coordinator' });
  const task = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'architect', description: `fixture task ${label}` });
  const plan = store.getExecutionPlan(job.job_id);
  const planned = plan.children.find(item => item.role === 'architect');
  const command = [planned.execution.executable, ...planned.execution.args].map(shellQuote).join(' ');
  const params = { executionSessionId: `session-${label}-${process.pid}`, attempt: 1, command, cwd: planned.execution.cwd, tmuxName: `tmux-${label}-${process.pid}` };
  if (prepare) store.prepareExecution(task.task_id, params);
  return { job, cto, task: store.getTask(task.task_id), plan, command, params,
    completion: { executionSessionId: params.executionSessionId, attempt: 1, command, exitCode: 0, stdout: `stdout-${label}`, stderr: '', status: 'completed', error: null } };
}

function inspect(taskId, jobId) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      task: db.prepare('SELECT task_id,job_id,status,execution_status,execution_session_id,execution_attempt,execution_exit_code,execution_stdout,execution_stderr FROM tasks WHERE task_id=?').get(taskId),
      attempts: db.prepare('SELECT attempt_id,task_id,status,started_at,finished_at,error FROM attempts WHERE task_id=? ORDER BY rowid').all(taskId),
      results: db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE task_id=? ORDER BY rowid').all(taskId),
      artifacts: db.prepare('SELECT artifact_id,job_id,task_id,kind,status,evidence_json,content_hash FROM artifacts WHERE task_id=? ORDER BY rowid').all(taskId),
      executionStarted: db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId),
      terminalEvents: db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid").all(jobId, taskId)
    };
  } finally { db.close(); }
}

function finish(f) { return store.finishExecution(f.task.task_id, f.completion); }

// PID persistence is a separate post-spawn write. A late owner from attempt 1
// must not overwrite the PID belonging to retry attempt 2 after recovery has
// terminalized the old attempt and allowed monotonic retry.
{
  const f = fixture('pid-owner-fence');
  store.finishExecution(f.task.task_id, {
    executionSessionId: f.params.executionSessionId, attempt: 1, command: f.command,
    exitCode: null, stdout: '', stderr: 'synthetic local failure', status: 'failed', error: 'synthetic local failure'
  });
  const retryParams = {
    ...f.params,
    executionSessionId: `session-pid-owner-fence-retry-${process.pid}`,
    attempt: 2,
    tmuxName: `tmux-pid-owner-fence-retry-${process.pid}`
  };
  store.prepareExecution(f.task.task_id, retryParams);
  assert.throws(() => store.setExecutionPid(f.task.task_id, 11111, {
    executionSessionId: f.params.executionSessionId, attempt: 1
  }), /lost task\/session\/attempt ownership/, 'late prior-attempt PID write must be fenced');
  assert.equal(store.getTask(f.task.task_id).execution_pid, null, 'rejected stale PID must not mutate retry state');
  assert.throws(() => store.setExecutionPid(f.task.task_id, '22222', {
    executionSessionId: retryParams.executionSessionId, attempt: 2
  }), /positive safe PID/, 'PID persistence must reject string coercion');
  store.setExecutionPid(f.task.task_id, 22222, {
    executionSessionId: retryParams.executionSessionId, attempt: 2
  });
  assert.equal(store.getTask(f.task.task_id).execution_pid, 22222);
  store.finishExecution(f.task.task_id, {
    executionSessionId: retryParams.executionSessionId, attempt: 2, command: f.command,
    exitCode: 0, stdout: 'retry-owner-result', stderr: '', status: 'completed', error: null
  });
  console.log('FINISH EXECUTION STALE PID WRITE VS NEW RETRY OWNER FENCE PASS');
}

// The start transaction is also atomic: killing it after task mutation,
// attempt insertion or start-event insertion must leave no partial session claim.
for (const [label, crashEnv] of [
  ['after-task', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_TASK_UPDATE'],
  ['after-attempt', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_ATTEMPT_INSERT'],
  ['after-event', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_EVENT_INSERT']
]) {
  const f = fixture(`prepare-sigkill-${label}`, { prepare: false });
  if (label === 'after-task') {
    assert.throws(() => store.prepareExecution(f.task.task_id, { ...f.params, attempt: '1' }), /exact task\/session\/attempt\/command identity/,
      'execution attempt must not coerce a numeric string');
    assert.equal(store.getTask(f.task.task_id).execution_session_id, null,
      'rejected string attempt must not claim the durable task');
  }
  const childSource = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.prepareExecution(${JSON.stringify(f.task.task_id)}, ${JSON.stringify(f.params)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: workspace,
      NODE_ENV: 'test', [crashEnv]: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `expected execution-start writer to die at ${label}: ${child.stderr}`);
  const afterCrash = inspect(f.task.task_id, f.job.job_id);
  assert.equal(afterCrash.task.execution_session_id, null);
  assert.ok(afterCrash.task.execution_status == null);
  assert.equal(afterCrash.attempts.length, 0);
  assert.equal(afterCrash.executionStarted.length, 0);
  assert.equal(afterCrash.terminalEvents.length, 0);
  store.prepareExecution(f.task.task_id, f.params);
  const recovered = inspect(f.task.task_id, f.job.job_id);
  assert.equal(recovered.task.execution_session_id, f.params.executionSessionId);
  assert.equal(recovered.task.execution_status, 'running');
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.executionStarted.length, 1);
  console.log(`PREPARE EXECUTION SIGKILL ${label} / ROLLBACK / RETRY PASS`);
}

// Successful execution is a single durable result/artifact/attempt/event chain;
// a same-input retry is read-only/idempotent, while changed output is rejected.
const happy = fixture('happy');
assert.throws(() => store.finishExecution(happy.task.task_id, { ...happy.completion, attempt: '1' }), /exact task\/session\/attempt\/command identity/,
  'terminal attempt identity must reject coercible strings');
assert.throws(() => store.finishExecution(happy.task.task_id, { ...happy.completion, exitCode: '0' }), /exit code must be a canonical safe integer/,
  'numeric strings must not be persisted as process exit codes');
assert.throws(() => store.finishExecution(happy.task.task_id, { ...happy.completion, status: 'completed-ish' }), /invalid execution completion status/,
  'unknown terminal status must fail closed instead of silently becoming failure');
assert.equal(store.getTask(happy.task.task_id).execution_status, 'running', 'rejected type/status must leave task attempt untouched');
const happyFinished = finish(happy);
assert.equal(happyFinished.execution_status, 'completed');
const happyPlan = store.getExecutionPlan(happy.job.job_id);
const happyLineage = store.assertSupportedTaskArtifactLineage(happy.job.job_id, happyFinished, happyPlan);
assert.equal(happyLineage.result.outcome, 'success');
assert.equal(happyLineage.artifact.type, 'architecture');
const happyBeforeRetry = inspect(happy.task.task_id, happy.job.job_id);
assert.equal(happyBeforeRetry.results.length, 1);
assert.equal(happyBeforeRetry.artifacts.length, 1);
assert.equal(happyBeforeRetry.attempts.length, 1);
assert.equal(happyBeforeRetry.terminalEvents.length, 1);
finish(happy);
const happyAfterRetry = inspect(happy.task.task_id, happy.job.job_id);
assert.equal(happyAfterRetry.results.length, 1);
assert.equal(happyAfterRetry.artifacts.length, 1);
assert.equal(happyAfterRetry.attempts.length, 1);
assert.equal(happyAfterRetry.terminalEvents.length, 1);
assert.throws(() => store.finishExecution(happy.task.task_id, { ...happy.completion, stdout: 'substituted stdout' }), /retry conflicts with the exact durable result/);
console.log('FINISH EXECUTION EXACT RETRY / DURABLE LINEAGE PASS');

// The savepoint composes with a caller-owned transaction: an outer rollback
// must undo the completed transition rather than accidentally committing it.
{
  const f = fixture('outer-transaction');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    finish(f);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(f.task.task_id).n, 1);
    store.db.exec('ROLLBACK');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  const afterOuterRollback = inspect(f.task.task_id, f.job.job_id);
  assert.equal(afterOuterRollback.task.status, 'running');
  assert.equal(afterOuterRollback.task.execution_status, 'running');
  assert.equal(afterOuterRollback.results.length, 0);
  assert.equal(afterOuterRollback.artifacts.length, 0);
  assert.equal(afterOuterRollback.attempts[0].status, 'started');
  assert.equal(afterOuterRollback.terminalEvents.length, 0);
  finish(f);
  console.log('FINISH EXECUTION NESTED SAVEPOINT / OUTER ROLLBACK PASS');
}

// An artifact persistence failure after the result insert must roll back result,
// artifact, task terminal update, attempt settlement and event as one savepoint.
{
  const f = fixture('artifact-fault');
  const original = store.createArtifact.bind(store);
  let injected = false;
  store.createArtifact = input => {
    if (!injected && input.type === 'architecture') { injected = true; throw new Error('injected architecture artifact write failure'); }
    return original(input);
  };
  try {
    assert.throws(() => finish(f), /injected architecture artifact write failure/);
    assert.equal(injected, true);
    const afterFailure = inspect(f.task.task_id, f.job.job_id);
    assert.equal(afterFailure.task.status, 'running');
    assert.equal(afterFailure.task.execution_status, 'running');
    assert.equal(afterFailure.results.length, 0);
    assert.equal(afterFailure.artifacts.length, 0);
    assert.equal(afterFailure.attempts.length, 1);
    assert.equal(afterFailure.attempts[0].status, 'started');
    assert.equal(afterFailure.executionStarted.length, 1);
    assert.equal(afterFailure.terminalEvents.length, 0);
  } finally { store.createArtifact = original; }
  finish(f);
  assert.equal(inspect(f.task.task_id, f.job.job_id).results.length, 1);
  console.log('FINISH EXECUTION ARTIFACT-FAILURE ROLLBACK / RETRY PASS');
}

// Event insertion can fail after task/artifact/attempt writes have occurred;
// the exact original exception must survive rollback and a later retry succeed.
{
  const f = fixture('terminal-event-fault');
  const originalRecordEvent = store.recordEvent.bind(store);
  let injected = false;
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (!injected && type === 'execution.completed') { injected = true; throw new Error('injected terminal event persistence failure'); }
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => finish(f), /injected terminal event persistence failure/);
    assert.equal(injected, true);
    const failed = inspect(f.task.task_id, f.job.job_id);
    assert.equal(failed.task.execution_status, 'running');
    assert.equal(failed.results.length, 0);
    assert.equal(failed.artifacts.length, 0);
    assert.equal(failed.attempts[0].status, 'started');
    assert.equal(failed.terminalEvents.length, 0);
  } finally { store.recordEvent = originalRecordEvent; }
  finish(f);
  assert.equal(inspect(f.task.task_id, f.job.job_id).terminalEvents.length, 1);
  console.log('FINISH EXECUTION TERMINAL-EVENT FAILURE ROLLBACK / ORIGINAL ERROR / RETRY PASS');
}

// On SIGKILL at three distinct uncommitted write boundaries, an independent
// SQLite connection must see no partial terminal state, then a restarted writer
// can finish one coherent lineage.
for (const [label, crashEnv] of [
  ['after-result', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_RESULT_INSERT'],
  ['after-task', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_TASK_UPDATE'],
  ['after-attempt', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_ATTEMPT_UPDATE'],
  ['before-savepoint-release', 'CHAT_ON_STEROIDS_TEST_CRASH_BEFORE_EXECUTION_SAVEPOINT_RELEASE']
]) {
  const f = fixture(`sigkill-${label}`);
  const childSource = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    store.finishExecution(${JSON.stringify(f.task.task_id)}, ${JSON.stringify(f.completion)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: workspace,
      NODE_ENV: 'test', [crashEnv]: 'SIGKILL' }
  });
  assert.equal(child.signal, 'SIGKILL', `expected child process to die at ${label}: ${child.stderr}`);
  const afterCrash = inspect(f.task.task_id, f.job.job_id);
  assert.equal(afterCrash.task.status, 'running');
  assert.equal(afterCrash.task.execution_status, 'running');
  assert.equal(afterCrash.results.length, 0, `${label} must not leave a result row`);
  assert.equal(afterCrash.artifacts.length, 0, `${label} must not leave a typed artifact`);
  assert.equal(afterCrash.attempts.length, 1);
  assert.equal(afterCrash.attempts[0].status, 'started');
  assert.equal(afterCrash.terminalEvents.length, 0);
  finish(f);
  const recovered = inspect(f.task.task_id, f.job.job_id);
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.artifacts.length, 1);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].status, 'completed');
  assert.equal(recovered.terminalEvents.length, 1);
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  console.log(`FINISH EXECUTION SIGKILL ${label} / INDEPENDENT REOPEN / RETRY PASS`);
}

// Two independent processes which pass preflight together must serialize at
// the writer reservation; exact duplicate completion is idempotent, with one
// result/artifact/attempt and a single terminal event.
{
  const f = fixture('two-process-race');
  const barrierDir = path.join(root, 'finish-race-barrier');
  fs.mkdirSync(barrierDir, { mode: 0o700 });
  const source = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const store = new WorkflowStore();
    try { const value = store.finishExecution(${JSON.stringify(f.task.task_id)}, ${JSON.stringify(f.completion)}); console.log('FINISH_RESULT:' + JSON.stringify({taskId:value.task_id,status:value.execution_status})); }
    catch (error) { console.error('FINISH_ERROR:' + String(error?.message || error)); process.exitCode=27; }
    finally { try { store.db.close(); } catch {} }
  `;
  const procs = Array.from({ length: 2 }, () => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
        WORKFLOW_WORKSPACE: workspace, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_FINISH_EXECUTION_BARRIER_DIR: barrierDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    return { proc, done: new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
  });
  try {
    const readyFiles = procs.map(({ proc }) => path.join(barrierDir, `${proc.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyFiles.every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error('finishExecution race writers did not both reach the preflight barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    fs.writeFileSync(path.join(barrierDir, 'release'), 'release writers\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(procs.map(({ done }) => done));
    assert.ok(outcomes.every(item => item.code === 0 && item.stdout.includes('FINISH_RESULT:')), JSON.stringify(outcomes));
  } finally {
    for (const { proc } of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  const raced = inspect(f.task.task_id, f.job.job_id);
  assert.equal(raced.results.length, 1);
  assert.equal(raced.artifacts.length, 1);
  assert.equal(raced.attempts.length, 1);
  assert.equal(raced.attempts[0].status, 'completed');
  assert.equal(raced.terminalEvents.length, 1);
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  console.log('FINISH EXECUTION TWO-PROCESS SAME-RESULT RACE PASS');
}

// Conflicting outputs for the same task/session/attempt cannot both win. One
// process publishes its full result and the other must reject rather than
// treating identity-only equality as an idempotent retry.
{
  const f = fixture('two-process-conflict-race');
  const barrierDir = path.join(root, 'finish-conflict-race-barrier');
  fs.mkdirSync(barrierDir, { mode: 0o700 });
  const procs = ['winner-candidate-A', 'winner-candidate-B'].map((stdoutValue, index) => {
    const completion = { ...f.completion, stdout: stdoutValue };
    const source = `
      const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
      const store = new WorkflowStore();
      try { const value = store.finishExecution(${JSON.stringify(f.task.task_id)}, ${JSON.stringify(completion)}); console.log('FINISH_RESULT:' + JSON.stringify({taskId:value.task_id,status:value.execution_status,stdout:${JSON.stringify(stdoutValue)}})); }
      catch (error) { console.error('FINISH_ERROR:' + String(error?.message || error)); process.exitCode=27; }
      finally { try { store.db.close(); } catch {} }
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
        WORKFLOW_WORKSPACE: workspace, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_FINISH_EXECUTION_BARRIER_DIR: barrierDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    return { proc, done: new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
  });
  try {
    const readyFiles = procs.map(({ proc }) => path.join(barrierDir, `${proc.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyFiles.every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error('conflicting finishExecution writers did not both reach preflight');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    fs.writeFileSync(path.join(barrierDir, 'release'), 'release\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(procs.map(({ done }) => done));
    assert.equal(outcomes.filter(item => item.code === 0 && item.stdout.includes('FINISH_RESULT:')).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(item => item.code === 27 && item.stderr.includes('retry conflicts with the exact durable result')).length, 1, JSON.stringify(outcomes));
    const raced = inspect(f.task.task_id, f.job.job_id);
    assert.equal(raced.results.length, 1);
    assert.equal(raced.artifacts.length, 1);
    assert.equal(raced.attempts.length, 1);
    assert.equal(raced.terminalEvents.length, 1);
    store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
    console.log('FINISH EXECUTION TWO-PROCESS CONFLICTING-OUTPUT RACE PASS');
  } finally {
    for (const { proc } of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
}

// Reject forged, detached, duplicated and byte-substituted terminal-ledger rows.
{
  const f = fixture('attacks');
  finish(f);
  const row = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=?").get(f.job.job_id, f.task.task_id);
  const originalPayload = row.payload_json;
  const originalStart = store.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?").get(f.job.job_id, f.task.task_id);
  const assertRejected = label => assert.throws(() => store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan), /completion event|lineage|typed artifact|successful result|execution event/i, label);
  try {
    const forgedSession = { ...JSON.parse(originalPayload), executionSessionId: 'detached-session' };
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(forgedSession), row.event_id);
    assertRejected('forged execution session must be rejected');
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPayload, row.event_id);

    const forgedAttempt = { ...JSON.parse(originalPayload), attempt: 2 };
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(forgedAttempt), row.event_id);
    assertRejected('wrong attempt must be rejected');
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPayload, row.event_id);

    store.db.prepare('DELETE FROM events WHERE event_id=?').run(store.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?").get(f.job.job_id, f.task.task_id).event_id);
    assertRejected('missing durable start event must be rejected');
  } finally {
    // Restore the canonical event before proceeding with the isolated fixture's
    // remaining tampering probes; no official or historical database is used.
    const presentStart = store.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?").get(f.job.job_id, f.task.task_id);
    if (!presentStart && originalStart) {
      store.db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run(originalStart.event_id, originalStart.job_id, originalStart.type, originalStart.payload_json, originalStart.created_at);
    }
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPayload, row.event_id);
  }
  // Duplicate same-result completion under another event key is a replay, not a
  // second acceptable path to terminal state.
  const duplicateId = `attacker-duplicate-${process.pid}-${f.task.task_id}`;
  store.db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
    .run(duplicateId, f.job.job_id, 'execution.completed', originalPayload, timestamp());
  try { assertRejected('duplicate completion event must be rejected'); }
  finally { store.db.prepare('DELETE FROM events WHERE event_id=?').run(duplicateId); }

  const result = store.db.prepare('SELECT result_id,content FROM results WHERE task_id=? AND outcome=\'success\'').get(f.task.task_id);
  store.db.prepare('UPDATE results SET content=? WHERE result_id=?').run(`${result.content}\nforged`, result.result_id);
  try { assertRejected('substituted exact result bytes must be rejected'); }
  finally { store.db.prepare('UPDATE results SET content=? WHERE result_id=?').run(result.content, result.result_id); }

  const artifact = store.db.prepare('SELECT artifact_id,evidence_json,status FROM artifacts WHERE task_id=?').get(f.task.task_id);
  store.db.prepare('UPDATE artifacts SET status=\'invalidated\' WHERE artifact_id=?').run(artifact.artifact_id);
  try { assertRejected('substituted artifact status must be rejected'); }
  finally { store.db.prepare('UPDATE artifacts SET status=? WHERE artifact_id=?').run(artifact.status, artifact.artifact_id); }
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  console.log('FINISH EXECUTION FORGED SESSION / ATTEMPT / MISSING START / DUPLICATE / TAMPER REGRESSIONS PASS');
}

// A last-wins JSON.parse can hide duplicate decoded keys while leaving the
// resulting object identical. Start-event verification must bind canonical raw
// JSON, not merely Object.keys() and parsed field values.
{
  const f = fixture('duplicate-start-event-key');
  const startRow = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=?")
    .get(f.job.job_id, f.task.task_id);
  assert.ok(startRow);
  const canonical = startRow.payload_json;
  const duplicate = canonical.replace('"attempt":1', '"attempt":1,"attempt":1');
  assert.notEqual(duplicate, canonical);
  assert.deepEqual(JSON.parse(duplicate), JSON.parse(canonical), 'duplicate start-event key fixture must retain same last-wins semantic object');
  try {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicate, startRow.event_id);
    assert.throws(() => finish(f), /canonical|start-event\/task\/session\/attempt binding/i,
      'finishExecution must reject duplicate decoded keys in execution.started');
    const afterRejectedFinish = inspect(f.task.task_id, f.job.job_id);
    assert.equal(afterRejectedFinish.results.length, 0);
    assert.equal(afterRejectedFinish.artifacts.length, 0);
    assert.equal(afterRejectedFinish.task.execution_status, 'running');
    assert.equal(afterRejectedFinish.attempts[0].status, 'started');
    assert.equal(afterRejectedFinish.terminalEvents.length, 0);
  } finally {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonical, startRow.event_id);
  }
  finish(f);
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  try {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicate, startRow.event_id);
    assert.throws(() => store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan),
      /completion\/attempt lineage is invalid or non-canonical/i,
      'terminal-ledger validation must independently reject duplicate decoded keys added after successful completion');
  } finally {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonical, startRow.event_id);
  }
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  const artifactEventRow = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='artifact.created' AND json_extract(payload_json,'$.artifactId')=?")
    .get(f.job.job_id, `architecture-${inspect(f.task.task_id, f.job.job_id).results[0].result_id}`);
  assert.ok(artifactEventRow);
  const canonicalArtifactEvent = artifactEventRow.payload_json;
  const duplicateArtifactEvent = canonicalArtifactEvent.replace(/"contentHash":"([a-f0-9]{64})"/, '"contentHash":"$1","contentHash":"$1"');
  assert.notEqual(duplicateArtifactEvent, canonicalArtifactEvent);
  assert.deepEqual(JSON.parse(duplicateArtifactEvent), JSON.parse(canonicalArtifactEvent), 'duplicate artifact event key must retain the same last-wins object');
  try {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicateArtifactEvent, artifactEventRow.event_id);
    assert.throws(() => store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan),
      /artifact event does not bind its durable bytes/i,
      'terminal-ledger validator must reject a duplicate decoded contentHash key in artifact.created');
  } finally {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalArtifactEvent, artifactEventRow.event_id);
  }
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  console.log('FINISH EXECUTION DUPLICATE-DECODED-KEY START EVENT REJECTION PASS');
}

// A newer attempt may recover failed work, but it must never reopen an
// already successful task: doing so would leave two success results and
// invalidate the terminal ledger after the second run.
{
  const f = fixture('no-reexecute-terminal-success');
  finish(f);
  assert.throws(() => store.prepareExecution(f.task.task_id, {
    executionSessionId: `session-replay-${process.pid}`, attempt: 2, command: f.command,
    cwd: f.params.cwd, tmuxName: `tmux-replay-${process.pid}`
  }), /completed task|terminal success|cannot reopen/i,
  'prepareExecution must not start a new attempt after durable successful completion');
  const after = inspect(f.task.task_id, f.job.job_id);
  assert.equal(after.task.status, 'completed');
  assert.equal(after.task.execution_status, 'completed');
  assert.equal(Number(after.task.execution_attempt), 1);
  assert.equal(after.attempts.length, 1);
  assert.equal(after.results.length, 1);
  assert.equal(after.artifacts.length, 1);
  assert.equal(after.terminalEvents.length, 1);
  console.log('PREPARE EXECUTION REPLAY AFTER TERMINAL SUCCESS REJECTION PASS');
}

// Retry remains permitted after an actual failed attempt. The retry must move
// business task state back to running while preserving the failed attempt/result,
// then complete one coherent success lineage without reopening successful work.
{
  const f = fixture('failed-attempt-retry');
  store.finishExecution(f.task.task_id, {
    ...f.completion, status: 'failed', exitCode: 1, stdout: 'first-attempt-failed', error: 'fixture failure'
  });
  let state = inspect(f.task.task_id, f.job.job_id);
  assert.equal(state.task.status, 'failed');
  assert.equal(state.task.execution_status, 'failed');
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, 'failed');
  const nextParams = { executionSessionId: `session-retry-${process.pid}`, attempt: 2, command: f.command,
    cwd: f.params.cwd, tmuxName: `tmux-retry-${process.pid}` };
  const reopened = store.prepareExecution(f.task.task_id, nextParams);
  assert.equal(reopened.status, 'running');
  assert.equal(reopened.execution_status, 'running');
  assert.equal(Number(reopened.execution_attempt), 2);
  const retried = store.finishExecution(f.task.task_id, {
    executionSessionId: nextParams.executionSessionId, attempt: 2, command: f.command,
    exitCode: 0, stdout: 'retry-succeeded', stderr: '', status: 'completed', error: null
  });
  assert.equal(retried.status, 'completed');
  assert.equal(Number(retried.execution_attempt), 2);
  state = inspect(f.task.task_id, f.job.job_id);
  assert.equal(state.attempts.length, 2);
  assert.deepEqual(state.attempts.map(item => item.status), ['failed', 'completed']);
  assert.equal(state.results.filter(item => item.outcome === 'failure').length, 1);
  assert.equal(state.results.filter(item => item.outcome === 'success').length, 1);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.terminalEvents.filter(item => item.type === 'execution.failed').length, 1);
  assert.equal(state.terminalEvents.filter(item => item.type === 'execution.completed').length, 1);
  store.assertSupportedTaskArtifactLineage(f.job.job_id, store.getTask(f.task.task_id), f.plan);
  console.log('PREPARE EXECUTION FAILED ATTEMPT RETRY / SUCCESSFUL TERMINAL LEDGER PASS');
}

console.log('test-finish-execution-terminal-ledger: PASS');
store.db.close();
