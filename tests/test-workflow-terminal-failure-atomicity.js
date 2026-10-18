import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-terminal-failure-atomicity-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const modulePath = path.resolve(process.env.PHASE2_TEST_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const moduleUrl = pathToFileURL(modulePath).href;
const { WorkflowStore } = await import(moduleUrl);
let db = new DatabaseSync(dbPath, { timeout: 5000 });
let store = new WorkflowStore(db);
process.on('exit', () => {
  try { db?.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const job = store.createJob({ conversationKey: `workflow-terminal-failure-${process.pid}`, title: 'Workflow verification failure atomicity' });
store.approve(job.job_id, 'isolated test approval');
store.dispatch(job.job_id, { role: 'cto', description: 'terminal failure fixture' });
assert.equal(store.getJob(job.job_id).state, 'EXECUTING');
const jobId = job.job_id;
store.db.close();
db = null;

const crashCode = `
  const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
  const store = new WorkflowStore();
  store.failWorkflowVerification(${JSON.stringify(jobId)}, { reason: 'synthetic verification failure', errors: ['missing result evidence'] });
`;
const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', crashCode], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root,
    NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_WORKFLOW_FAILURE_JOB_UPDATE: 'SIGKILL' }
});
assert.equal(crashed.signal, 'SIGKILL', `failure transition must crash at the injected in-transaction boundary: ${crashed.stderr}`);

db = new DatabaseSync(dbPath, { timeout: 5000 });
store = new WorkflowStore(db);
assert.equal(store.getJob(jobId).state, 'EXECUTING', 'SIGKILL must roll back the job terminal update');
assert.notEqual(store.getWorkflowRuntimeState(jobId).phase, 'FAILED', 'SIGKILL must roll back the workflow phase update');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('job.completed','job.failed','workflow.failed')").get(jobId).n, 0,
  'SIGKILL must roll back all terminal and workflow-failure events with the state writes');

const reason = 'synthetic verification failure';
const errors = ['missing result evidence'];
const failed = store.failWorkflowVerification(jobId, { reason, errors });
assert.equal(failed.job.state, 'FAILED');
assert.equal(store.getWorkflowRuntimeState(jobId).phase, 'FAILED');
assert.equal(store.getWorkflowRuntimeState(jobId).last_error, reason);
const terminalEvents = store.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')").all(jobId);
assert.equal(terminalEvents.length, 1);
assert.equal(terminalEvents[0].type, 'job.failed');
assert.deepEqual(JSON.parse(terminalEvents[0].payload_json), { reason, errors });
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM workflow_events WHERE job_id=? AND event='workflow.failed' AND to_phase='FAILED'").get(jobId).n, 1);
assert.equal(store.failWorkflowVerification(jobId, { reason, errors }).idempotent, true,
  'an exact retry must be idempotent only after validating the exact terminal lineage');

// Recover the specific legacy crash window where the old caller committed the
// workflow FAILED phase but died before transitioning the job or writing its
// terminal event. The new method must finish that exact lineage, not restart it.
const legacyCrashJob = store.createJob({ conversationKey: `workflow-terminal-failure-legacy-${process.pid}`, title: 'Legacy split failure transition' });
store.approve(legacyCrashJob.job_id, 'isolated test approval');
store.dispatch(legacyCrashJob.job_id, { role: 'cto', description: 'legacy split transition fixture' });
store.transitionWorkflowPhase(legacyCrashJob.job_id, 'FAILED', {
  lastError: reason, event: 'workflow.failed', payload: { reason, errors }
});
assert.equal(store.getJob(legacyCrashJob.job_id).state, 'EXECUTING');
store.db.close();
db = new DatabaseSync(dbPath, { timeout: 5000 });
store = new WorkflowStore(db);
const recoveredFailure = store.failWorkflowVerification(legacyCrashJob.job_id, { reason, errors });
assert.equal(recoveredFailure.job.state, 'FAILED');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')").get(legacyCrashJob.job_id).n, 1,
  'restart recovery must finish the existing FAILED workflow phase with exactly one job.failed terminal event');

const approvedJob = store.createJob({ conversationKey: `workflow-terminal-failure-approved-${process.pid}`, title: 'Approved phase failure' });
store.approve(approvedJob.job_id, 'isolated test approval');
assert.notEqual(store.getJob(approvedJob.job_id).state, 'EXECUTING', 'fixture must exercise failure before execution starts');
const approvedFailure = store.failWorkflowVerification(approvedJob.job_id, {
  reason: 'immutable execution plan missing', errors: ['immutable execution plan missing']
});
assert.equal(approvedFailure.job.state, 'FAILED', 'pre-execution governance/plan failure must also terminalize atomically');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')").get(approvedJob.job_id).n, 1);

const lateRuntimeJob = store.createJob({ conversationKey: `workflow-terminal-failure-late-runtime-${process.pid}`, title: 'Late runtime callback after terminal failure' });
store.approve(lateRuntimeJob.job_id, 'isolated test approval');
const lateCto = store.dispatch(lateRuntimeJob.job_id, { role: 'cto', description: 'late callback fixture' });
const lateChild = store.createChildTask(lateRuntimeJob.job_id, { parentTaskId: lateCto.task_id, role: 'architect', description: 'late callback child' });
store.attachTaskRuntime(lateChild.task_id, { runId: 'late-runtime-run', sessionKey: 'agent:architect:late-runtime' });
assert.equal(store.getTask(lateChild.task_id).status, 'running');
store.failWorkflowVerification(lateRuntimeJob.job_id, { reason: 'terminal verification failure', errors: ['required evidence missing'] });
const lateCallback = store.completeTaskByRuntime(lateRuntimeJob.job_id, {
  runId: 'late-runtime-run', sessionKey: 'agent:architect:late-runtime', content: 'success-shaped late callback', outcome: 'success'
});
assert.equal(lateCallback.status, 'running', 'a late runtime callback must not mutate a task after its parent job is terminal');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(lateChild.task_id).n, 0,
  'a late runtime callback must not append a false-success result after job failure');
assert.equal(store.getJob(lateRuntimeJob.job_id).state, 'FAILED');
assert.equal(store.reconcileRunningTaskForTerminalJob(lateChild.task_id).status, 'cancelled',
  'the independent terminal-job recovery path must settle the abandoned running task without trusting its late callback');
assert.equal(store.reconcileRunningTaskForTerminalJob(lateChild.task_id).status, 'cancelled',
  'repeated terminal-job recovery must be idempotent');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.runtime_reconciled' AND json_extract(payload_json,'$.taskId')=?")
  .get(lateRuntimeJob.job_id, lateChild.task_id).n, 1,
  'terminal-job recovery must preserve exactly one canonical reconciliation event');

// Provider-backed work can outlive its parent Job. Empty OpenClaw inventory
// must not cancel the local task while the durable provider run remains active.
store.db.exec(`CREATE TABLE provider_runs (
  provider_run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL
);`);
const providerRunningJob = store.createJob({ conversationKey: `workflow-terminal-provider-running-${process.pid}`, title: 'Unresolved provider recovery guard' });
store.approve(providerRunningJob.job_id, 'isolated test approval');
const providerRunningTask = store.createChildTask(providerRunningJob.job_id, {
  parentTaskId: store.dispatch(providerRunningJob.job_id, { role: 'cto', description: 'provider parent fixture' }).task_id,
  role: 'architect', description: 'provider-backed running task fixture'
});
store.attachTaskRuntime(providerRunningTask.task_id, { runId: 'provider-running-fixture', sessionKey: 'agent:architect:provider-running-fixture' });
store.failWorkflowVerification(providerRunningJob.job_id, { reason: 'provider recovery fixture terminal job', errors: ['synthetic'] });
store.db.prepare('INSERT INTO provider_runs(provider_run_id,job_id,state) VALUES(?,?,?)')
  .run('provider-run-unresolved-fixture', providerRunningJob.job_id, 'IN_PROGRESS');
assert.equal(store.reconcileRunningTaskForTerminalJob(providerRunningTask.task_id).status, 'running',
  'terminal-job recovery must defer while a durable provider run is nonterminal');
store.db.prepare('UPDATE provider_runs SET state=? WHERE provider_run_id=?').run('COMPLETED', 'provider-run-unresolved-fixture');
store.db.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,state,issued_at,heartbeat_at,expires_at)
  VALUES(?,?,?,?,?,'ACTIVE',?,?,?)`).run('active-provider-lease-fixture', providerRunningTask.task_id,
  providerRunningJob.job_id, 1, 'worker-fixture', new Date().toISOString(), new Date().toISOString(),
  new Date(Date.now() + 60_000).toISOString());
assert.equal(store.reconcileRunningTaskForTerminalJob(providerRunningTask.task_id).status, 'running',
  'terminal-job recovery must defer while a durable task lease remains active');
store.db.prepare("UPDATE task_leases SET state='RELEASED',released_at=? WHERE lease_id=?")
  .run(new Date().toISOString(), 'active-provider-lease-fixture');
assert.equal(store.reconcileRunningTaskForTerminalJob(providerRunningTask.task_id).status, 'cancelled',
  'terminal-job recovery must proceed after provider run is terminal and lease is released');

// The older complete() API must also roll back task/result/job writes together
// if SIGKILL lands after its job state update but before the completion event.
const legacyCrashCompleteJob = store.createJob({ conversationKey: `workflow-legacy-complete-crash-${process.pid}`, title: 'Legacy completion SIGKILL fixture' });
store.approve(legacyCrashCompleteJob.job_id, 'isolated test approval');
const legacyCrashTask = store.dispatch(legacyCrashCompleteJob.job_id, { role: 'architect', description: 'legacy completion SIGKILL fixture' });
const legacyCrashJobId = legacyCrashCompleteJob.job_id;
store.db.close();
db = null;
const legacyCompleteCrashCode = `
  const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
  const store = new WorkflowStore();
  store.complete(${JSON.stringify(legacyCrashJobId)}, 'legacy success bytes', 'success');
`;
const legacyCompleteCrash = spawnSync(process.execPath, ['--input-type=module', '-e', legacyCompleteCrashCode], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root,
    NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEGACY_COMPLETE_JOB_UPDATE: 'SIGKILL' }
});
assert.equal(legacyCompleteCrash.signal, 'SIGKILL', `legacy completion must crash at the injected transaction boundary: ${legacyCompleteCrash.stderr}`);
db = new DatabaseSync(dbPath, { timeout: 5000 });
store = new WorkflowStore(db);
assert.equal(store.getJob(legacyCrashJobId).state, 'EXECUTING', 'legacy complete SIGKILL must roll back the job state');
assert.equal(store.getTask(legacyCrashTask.task_id).status, 'running', 'legacy complete SIGKILL must roll back task status');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(legacyCrashTask.task_id).n, 0,
  'legacy complete SIGKILL must roll back the result row');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('task.completed','task.failed')").get(legacyCrashJobId).n, 0,
  'legacy complete SIGKILL must roll back completion events');
assert.equal(store.complete(legacyCrashJobId, 'recovered success bytes', 'success').state, 'COMPLETED');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(legacyCrashTask.task_id).n, 1,
  'retry after crash must write exactly one result');

// Two processes that preflight the same active job must serialize at the
// durable writer reservation; only the winning outcome may persist.
const concurrentJob = store.createJob({ conversationKey: `workflow-legacy-complete-race-${process.pid}`, title: 'Legacy completion concurrent writer fixture' });
store.approve(concurrentJob.job_id, 'isolated test approval');
const concurrentTask = store.dispatch(concurrentJob.job_id, { role: 'architect', description: 'legacy completion concurrent writer fixture' });
const concurrentJobId = concurrentJob.job_id;
store.db.close();
db = null;
const spawnCompletion = outcome => new Promise((resolve, reject) => {
  const code = `
    const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
    const store = new WorkflowStore();
    const result = store.complete(${JSON.stringify(concurrentJobId)}, ${JSON.stringify(`concurrent ${outcome} bytes`)}, ${JSON.stringify(outcome)});
    console.log(JSON.stringify({ state: result?.state, status: result?.status, idempotent: result?.idempotent }));
    store.db.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' }
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve({ outcome, stdout, stderr }) : reject(new Error(`concurrent ${outcome} writer exited ${code}: ${stderr}`)));
});
await Promise.all([spawnCompletion('success'), spawnCompletion('failure')]);
db = new DatabaseSync(dbPath, { timeout: 5000 });
store = new WorkflowStore(db);
const concurrentResultRows = store.db.prepare('SELECT result_id,outcome,content FROM results WHERE task_id=? ORDER BY rowid').all(concurrentTask.task_id);
assert.equal(concurrentResultRows.length, 1, 'concurrent success/failure writers must not append contradictory results');
const concurrentTaskEvents = store.db.prepare("SELECT type,payload_json FROM events WHERE job_id=? AND type IN ('task.completed','task.failed')").all(concurrentJobId);
assert.equal(concurrentTaskEvents.length, 1, 'concurrent completion writers must persist exactly one task terminal event');
assert.equal(concurrentTaskEvents[0].type, concurrentResultRows[0].outcome === 'success' ? 'task.completed' : 'task.failed');
const concurrentFinalJob = store.getJob(concurrentJobId);
assert.equal(concurrentFinalJob.status, concurrentResultRows[0].outcome === 'success' ? 'completed' : 'failed');

store.db.prepare("UPDATE events SET payload_json='{}' WHERE event_id=?").run(terminalEvents[0].event_id);
assert.throws(() => store.failWorkflowVerification(jobId, { reason, errors }), /idempotency conflicts with durable terminal lineage/,
  'a terminal failure replay must not accept tampered job.failed evidence');

console.log('WORKFLOW VERIFICATION FAILURE / JOB-PHASE-EVENT ATOMICITY / SIGKILL RECOVERY / EXACT IDEMPOTENCY PASS');
store.db.close();
db = null;
