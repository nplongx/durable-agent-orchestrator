import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-plan-binding-'));
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'approved-workspace');
const execTmp = path.join(dataDir, 'exec-tmp');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
fs.mkdirSync(execTmp, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = workspace;
process.env.NODE_ENV = 'test';
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// A local tmux stand-in executes only the explicitly provided, fixture-scoped
// command and answers the small subset of tmux calls the manager uses. It never
// accesses a real tmux session or any network/external system.
const tmuxStub = path.join(root, 'tmux-fixture');
const spawnLog = path.join(root, 'tmux-spawn-log.txt');
fs.writeFileSync(tmuxStub, `#!/bin/sh\ncase "$1" in\n  new-session) printf '%s\\n' new-session >> ${JSON.stringify(spawnLog)}; shift; while [ "$#" -gt 0 ]; do case "$1" in -d) shift ;; -s|-e) shift 2 ;; *) break ;; esac; done; "$@" ;;\n  display-message) printf "12345\\n" ;;\n  kill-session) exit 0 ;;\n  *) exit 31 ;;\nesac\n`, { flag: 'wx', mode: 0o700 });
fs.chmodSync(tmuxStub, 0o700);
fs.writeFileSync(path.join(workspace, 'server.js'), 'export const fixture = true;\n', { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(workspace, 'test-tool-turn.js'), 'export const fixture = true;\n', { flag: 'wx', mode: 0o600 });

const job = store.createJob({ conversationKey: `execution-plan-binding-${process.pid}`, title: 'Production E2E immutable execution plan binding' });
store.recordEvent(job.job_id, 'job.proposal_requested', { task: job.title, workspace }, `approved-workspace|${job.title}`);
store.approve(job.job_id, 'local isolated plan binding regression', 'test-fixture', { workspace });
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'plan-bound execution test' });
const plan = store.getExecutionPlan(job.job_id);
const planned = plan.children.find(task => task.role === 'architect');
assert.ok(planned?.execution?.deterministic);
const task = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: 'run the approved architect syntax-check command',
  metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
});
assert.equal(task.metadata_json && JSON.parse(task.metadata_json).workflow_plan_task_id, planned.id);
const manager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 3000, executionTmpDir: execTmp });
const originalTmuxArgs = manager._tmuxExecutionArgs.bind(manager);
manager._tmuxExecutionArgs = (tmuxName, ...args) => {
  assert.equal(store.db.isTransaction, false,
    'the DB writer transaction must be closed before the asynchronous OS-spawn boundary');
  const ownerRows = store.db.prepare("SELECT task_id,job_id,execution_attempt,execution_session_id,metadata_json FROM tasks WHERE execution_status='running'").all()
    .filter(row => JSON.parse(row.metadata_json || '{}').tmuxName === tmuxName);
  assert.equal(ownerRows.length, 1, 'each OS spawn must bind to one exact prepared running task/session/attempt');
  const owner = ownerRows[0];
  const authorizations = store.db.prepare(`SELECT event_id,job_id,payload_json FROM events
    WHERE job_id=? AND type='execution.spawn_authorized' AND json_extract(payload_json,'$.taskId')=?
      AND json_extract(payload_json,'$.executionSessionId')=? AND json_extract(payload_json,'$.attempt')=?`)
    .all(owner.job_id, owner.task_id, owner.execution_session_id, Number(owner.execution_attempt));
  assert.equal(authorizations.length, 1,
    'the exact spawn-authorization record must commit before the OS command boundary');
  const payload = JSON.parse(authorizations[0].payload_json);
  assert.equal(payload.taskId, owner.task_id);
  assert.equal(payload.executionSessionId, owner.execution_session_id);
  assert.equal(payload.attempt, Number(owner.execution_attempt));
  assert.match(payload.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(payload.tmuxSha256, /^[a-f0-9]{64}$/);
  const independent = new DatabaseSync(process.env.WORKFLOW_DB, { timeout: 5000 });
  try {
    assert.equal(independent.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(authorizations[0].event_id).n, 1,
      'spawn authorization must be visible to an independent SQLite connection before spawn, not merely inside an open transaction');
  } finally { independent.close(); }
  return originalTmuxArgs(tmuxName, ...args);
};
const authorizingArgsBuilder = manager._tmuxExecutionArgs.bind(manager);

// An immutable command/environment plan is not sufficient if an approved
// `node ...` process inherits ambient NODE_OPTIONS from the adapter process.
// This preload would run before the approved command itself, despite no env
// overrides appearing in the plan or request.
const envTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'architect', description: 'run the approved command with an isolated environment',
  metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
});
const preloadSentinel = path.join(root, 'UNAPPROVED_NODE_PRELOAD_EXECUTED.txt');
const preloadModule = path.join(root, 'ambient-preload.cjs');
const bashPreloadSentinel = path.join(root, 'UNAPPROVED_BASH_ENV_EXECUTED.txt');
const bashPreloadFile = path.join(root, 'ambient-bash-env.sh');
const fakeBin = path.join(root, 'ambient-bin');
const fakeNodeSentinel = path.join(root, 'UNAPPROVED_PATH_NODE_EXECUTED.txt');
fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
fs.writeFileSync(preloadModule,
  `require('node:fs').writeFileSync(${JSON.stringify(preloadSentinel)}, 'ambient NODE_OPTIONS was executed');\n`,
  { flag: 'wx', mode: 0o600 });
fs.writeFileSync(bashPreloadFile, `printf '%s' 'ambient BASH_ENV was executed' > ${JSON.stringify(bashPreloadSentinel)}\n`,
  { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(fakeBin, 'node'), `#!/bin/sh\nprintf '%s' 'ambient PATH was executed' > ${JSON.stringify(fakeNodeSentinel)}\nexit 99\n`,
  { flag: 'wx', mode: 0o700 });
fs.chmodSync(path.join(fakeBin, 'node'), 0o700);
const priorEnvironment = { NODE_OPTIONS: process.env.NODE_OPTIONS, BASH_ENV: process.env.BASH_ENV, PATH: process.env.PATH };
const startedEventsBeforeEnvTest = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started'").get(job.job_id).n;
try {
  process.env.NODE_OPTIONS = `--require=${preloadModule}`;
  process.env.BASH_ENV = bashPreloadFile;
  process.env.PATH = fakeBin;
  const isolatedResult = await manager.executeAuthorizedTask(envTask.task_id, {
    timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
  });
  assert.equal(isolatedResult.exitCode, 0, 'the exact approved command should still execute');
  assert.equal(fs.existsSync(preloadSentinel), false,
    'approved execution must not run a preload inherited from the adapter process');
  assert.equal(fs.existsSync(bashPreloadSentinel), false,
    'approved execution must not source BASH_ENV from the adapter process');
  assert.equal(fs.existsSync(fakeNodeSentinel), false,
    'approved executable lookup must not resolve the adapter process PATH');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started'").get(job.job_id).n,
    startedEventsBeforeEnvTest + 1, 'exactly the isolated approved command should create an execution-start event');
  const durableBoundary = JSON.parse(store.getTask(envTask.task_id).metadata_json).execution_boundary_identity;
  assert.equal(durableBoundary.schema_version, 1);
  assert.equal(durableBoundary.task_id, envTask.task_id);
  assert.equal(durableBoundary.attempt, 1);
  assert.equal(durableBoundary.plan_hash, store.getExecutionPlan(job.job_id).plan_hash);
  assert.equal(durableBoundary.approval.approval_id, store.getLatestApproval(job.job_id).approval_id);
  assert.match(durableBoundary.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(durableBoundary.tmux.sha256, /^[a-f0-9]{64}$/);
  assert.ok(durableBoundary.cwd.dev && durableBoundary.cwd.ino && durableBoundary.cwd.realpath === workspace);
  assert.match(durableBoundary.environment_sha256, /^[a-f0-9]{64}$/);
  const startPayload = JSON.parse(store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='execution.started' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(job.job_id).payload_json);
  assert.deepEqual(startPayload.executionBoundaryIdentity, durableBoundary,
    'the durable start event must carry the same executable/cwd/plan/approval/environment identity as task state');
} finally {
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
console.log('IMMUTABLE PLAN REJECTS AMBIENT NODE_OPTIONS PRELOAD: PASS');

// An exception while constructing local tmux argv happens before the spawn
// helper is called and therefore proves no OS process was created. It must be
// terminalized as a known local failure, not left in RUNNING/ambiguous state.
{
  const argvFailureTask = store.createChildTask(job.job_id, {
    parentTaskId: cto.task_id, role: 'architect', description: 'local argv builder failure before spawn',
    metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
  });
  const startsBefore = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  manager._tmuxExecutionArgs = () => { throw new Error('injected local tmux argv construction failure'); };
  try {
    await assert.rejects(() => manager.executeAuthorizedTask(argvFailureTask.task_id, {
      timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
    }), /injected local tmux argv construction failure/);
  } finally {
    manager._tmuxExecutionArgs = authorizingArgsBuilder;
  }
  const failed = store.getTask(argvFailureTask.task_id);
  assert.equal(failed.execution_status, 'failed', 'definite local pre-spawn failure must settle the attempt');
  assert.equal(failed.status, 'failed');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(argvFailureTask.task_id).n, 0,
    'the pre-spawn local exception must not strand an open durable attempt');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.failed' AND json_extract(payload_json,'$.taskId')=?")
    .get(job.job_id, argvFailureTask.task_id).n, 1);
  assert.equal(fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length, startsBefore,
    'an argument-construction failure must not invoke the tmux executable');
  console.log('LOCAL SPAWN-ARGUMENT FAILURE / NO FALSE AMBIGUOUS OUTCOME / DURABLE ATTEMPT SETTLEMENT PASS');
}

// Reproduce the trust gap: editing task metadata while retaining the plan ID
// used to make executeAuthorizedTask invoke a different local command before
// terminal-ledger validation had a chance to reject the detached evidence.
const sentinel = path.join(root, 'UNAPPROVED_COMMAND_EXECUTED.txt');
const maliciousArgs = ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`];
store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify({
  ...planned.execution,
  executable: planned.execution.executable, args: maliciousArgs, cwd: planned.execution.cwd,
  timeout_ms: planned.execution.timeout_ms,
  deterministic: true, executor: 'ExecutionManager', workflow_plan_task_id: planned.id
}), task.task_id);
await assert.rejects(() => manager.executeAuthorizedTask(task.task_id, {
  timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
}),
  /immutable .*plan|approved execution contract|plan binding/i,
  'execution must be rejected before spawning a command whose executable/args differ from the immutable plan');
assert.equal(fs.existsSync(sentinel), false, 'rejected plan substitution must never create the fixture side-effect file');
const after = store.getTask(task.task_id);
assert.equal(after.execution_session_id, null, 'rejected command must not prepare a new execution session');
assert.ok(!after.execution_status, 'rejected command must not mutate execution status');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(task.task_id).n, 0);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started'").get(job.job_id).n,
  startedEventsBeforeEnvTest + 2, 'rejected tampered metadata must not create another execution-start event beyond the successful and injected pre-spawn-failure attempts');
console.log('EXECUTION MANAGER REJECTS TAMPERED METADATA BEFORE COMMAND SPAWN: PASS');

// Corrupting only a stored plan hash must also fail closed instead of trusting
// the plan row as its own authority root.
const storedPlan = store.db.prepare('SELECT plan_hash FROM workflow_plans WHERE job_id=?').get(job.job_id);
assert.ok(storedPlan);
store.db.prepare('UPDATE workflow_plans SET plan_hash=? WHERE job_id=?').run('0'.repeat(64), job.job_id);
try {
  assert.throws(() => store.getExecutionPlan(job.job_id), /immutable execution plan|plan hash|plan lineage/i,
    'the plan row hash must be cross-bound to the compiled plan bytes and event');
} finally {
  store.db.prepare('UPDATE workflow_plans SET plan_hash=? WHERE job_id=?').run(storedPlan.plan_hash, job.job_id);
}
assert.equal(store.getExecutionPlan(job.job_id).plan_hash, storedPlan.plan_hash);
console.log('EXECUTION PLAN ROW HASH ALTERATION REJECTION: PASS');

// The preflight plan check and the durable execution.start transaction are
// separate operations. Revoke the current approval from an independent SQL
// statement just before prepareExecution; the writer transaction must re-check
// approval against the exact current proposal and refuse to start an attempt.
{
  const approvalJob = store.createJob({ conversationKey: `execution-approval-race-${process.pid}`, title: 'Production E2E approval revocation race' });
  store.recordEvent(approvalJob.job_id, 'job.proposal_requested', { task: approvalJob.title, workspace }, `approved-workspace|${approvalJob.title}`);
  store.approve(approvalJob.job_id, 'local isolated approval race fixture', 'test-fixture', { workspace });
  const cto = store.dispatch(approvalJob.job_id, { role: 'cto', description: 'approval race synthesis coordinator' });
  const approvalPlan = store.getExecutionPlan(approvalJob.job_id);
  const architect = approvalPlan.children.find(item => item.role === 'architect');
  const approvalTask = store.createChildTask(approvalJob.job_id, {
    parentTaskId: cto.task_id, role: 'architect', description: 'execute only when approved',
    metadata: { ...architect.execution, workflow_plan_task_id: architect.id }
  });
  const approvalMeta = JSON.parse(approvalTask.metadata_json);
  const command = [approvalMeta.executable, ...approvalMeta.args].map(value => `'${String(value).replace(/'/g, `'\\''`)}'`).join(' ');
  const approvalParams = { executionSessionId: `approval-revoked-${process.pid}`, attempt: 1, command,
    cwd: approvalMeta.cwd, tmuxName: `approval-revoked-${process.pid}` };
  const approvalRow = store.getLatestApproval(approvalJob.job_id);
  assert.equal(approvalRow.decision, 'approved');
  store.db.prepare('UPDATE approvals SET decision=? WHERE approval_id=?').run('rejected', approvalRow.approval_id);
  assert.throws(() => store.prepareExecution(approvalTask.task_id, approvalParams), /approval is not current|approval.*revoked|not approved/i,
    'prepareExecution must re-check current approval inside its writer-serialized transaction');
  const afterRevoke = store.getTask(approvalTask.task_id);
  assert.equal(afterRevoke.execution_session_id, null);
  assert.equal(afterRevoke.execution_status, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(approvalTask.task_id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.started'").get(approvalJob.job_id).n, 0);
  store.db.prepare('UPDATE approvals SET decision=? WHERE approval_id=?').run('approved', approvalRow.approval_id);
  console.log('PREPARE EXECUTION APPROVAL-REVOCATION RACE REJECTION PASS');
}

// Revoke approval after the durable execution-start transaction commits but
// before the manager crosses the OS process-spawn boundary. The second plan
// check must reject the launch; a durable failed attempt is acceptable, but no
// tmux new-session/process may be created under revoked approval.
{
  const spawnRaceJob = store.createJob({ conversationKey: `execution-spawn-approval-race-${process.pid}`, title: 'Production E2E OS spawn approval revocation race' });
  store.recordEvent(spawnRaceJob.job_id, 'job.proposal_requested', { task: spawnRaceJob.title, workspace }, `approved-workspace|${spawnRaceJob.title}`);
  store.approve(spawnRaceJob.job_id, 'local isolated OS spawn approval race fixture', 'test-fixture', { workspace });
  const spawnCto = store.dispatch(spawnRaceJob.job_id, { role: 'cto', description: 'spawn approval race synthesis coordinator' });
  const spawnPlan = store.getExecutionPlan(spawnRaceJob.job_id);
  const spawnArchitect = spawnPlan.children.find(item => item.role === 'architect');
  const spawnTask = store.createChildTask(spawnRaceJob.job_id, {
    parentTaskId: spawnCto.task_id, role: 'architect', description: 'must not launch after approval revocation',
    metadata: { ...spawnArchitect.execution, workflow_plan_task_id: spawnArchitect.id }
  });
  const approvalRow = store.getLatestApproval(spawnRaceJob.job_id);
  const startsBefore = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  const originalPrepare = store.prepareExecution.bind(store);
  store.prepareExecution = (...args) => {
    const prepared = originalPrepare(...args);
    store.db.prepare('UPDATE approvals SET decision=? WHERE approval_id=?').run('rejected', approvalRow.approval_id);
    return prepared;
  };
  try {
    await assert.rejects(() => manager.executeAuthorizedTask(spawnTask.task_id, {
      timeoutMs: Math.min(3000, Number(spawnArchitect.execution.timeout_ms)), cwd: workspace
    }), /approval is not current|approval.*revoked|not approved/i,
    'approval revoked after durable prepare must fail before OS spawn');
  } finally {
    store.prepareExecution = originalPrepare;
    store.db.prepare('UPDATE approvals SET decision=? WHERE approval_id=?').run('approved', approvalRow.approval_id);
  }
  const startsAfter = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  assert.equal(startsAfter, startsBefore, 'post-prepare approval revocation must not create a tmux process');
  assert.equal(store.getTask(spawnTask.task_id).execution_status, 'failed', 'rejected launch remains durably visible for reconciliation');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(spawnTask.task_id).n, 1,
    'durable prepare/failure evidence must not be erased when OS launch is rejected');
  console.log('OS SPAWN BOUNDARY RECHECK REJECTS POST-PREPARE APPROVAL REVOCATION PASS');
}

// The durable boundary binds the cwd filesystem identity, not just its string
// path. Mutating the approved workspace after prepare changes its directory
// metadata; the final pre-spawn identity check must reject before tmux starts.
{
  const cwdRaceJob = store.createJob({ conversationKey: `execution-cwd-identity-race-${process.pid}`, title: 'Production E2E OS spawn cwd identity substitution' });
  store.recordEvent(cwdRaceJob.job_id, 'job.proposal_requested', { task: cwdRaceJob.title, workspace }, `approved-workspace|${cwdRaceJob.title}`);
  store.approve(cwdRaceJob.job_id, 'local isolated cwd identity fixture', 'test-fixture', { workspace });
  const parent = store.dispatch(cwdRaceJob.job_id, { role: 'cto', description: 'cwd identity fixture parent' });
  const cwdPlan = store.getExecutionPlan(cwdRaceJob.job_id);
  const child = cwdPlan.children.find(item => item.role === 'architect');
  const cwdTask = store.createChildTask(cwdRaceJob.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'reject cwd identity substitution',
    metadata: { ...child.execution, workflow_plan_task_id: child.id }
  });
  const startsBefore = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  const changedPath = path.join(workspace, `post-prepare-cwd-mutation-${process.pid}.txt`);
  const originalPrepare = store.prepareExecution.bind(store);
  store.prepareExecution = (...args) => {
    const prepared = originalPrepare(...args);
    fs.writeFileSync(changedPath, 'cwd changed after durable preparation\n', { flag: 'wx', mode: 0o600 });
    return prepared;
  };
  try {
    await assert.rejects(() => manager.executeAuthorizedTask(cwdTask.task_id, {
      timeoutMs: Math.min(3000, Number(child.execution.timeout_ms)), cwd: workspace
    }), /OS-boundary identity changed|cwd|identity/i);
  } finally {
    store.prepareExecution = originalPrepare;
    fs.rmSync(changedPath, { force: true });
  }
  const startsAfter = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  assert.equal(startsAfter, startsBefore, 'changed cwd filesystem identity must be rejected before tmux process creation');
  assert.equal(store.getTask(cwdTask.task_id).execution_status, 'failed');
  console.log('OS SPAWN BOUNDARY REJECTS POST-PREPARE CWD FILESYSTEM IDENTITY CHANGE PASS');
}

// The tmux executable itself is part of the process-spawn boundary. Replacing
// its bytes after durable preparation must be detected before the executable
// is invoked; the fixture's cleanup branch remains valid during reconciliation.
{
  const tmuxRaceJob = store.createJob({ conversationKey: `execution-tmux-identity-race-${process.pid}`, title: 'Production E2E OS spawn tmux executable substitution' });
  store.recordEvent(tmuxRaceJob.job_id, 'job.proposal_requested', { task: tmuxRaceJob.title, workspace }, `approved-workspace|${tmuxRaceJob.title}`);
  store.approve(tmuxRaceJob.job_id, 'local isolated tmux identity fixture', 'test-fixture', { workspace });
  const parent = store.dispatch(tmuxRaceJob.job_id, { role: 'cto', description: 'tmux identity fixture parent' });
  const tmuxPlan = store.getExecutionPlan(tmuxRaceJob.job_id);
  const child = tmuxPlan.children.find(item => item.role === 'architect');
  const tmuxTask = store.createChildTask(tmuxRaceJob.job_id, {
    parentTaskId: parent.task_id, role: 'architect', description: 'reject tmux executable substitution',
    metadata: { ...child.execution, workflow_plan_task_id: child.id }
  });
  const startsBefore = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  const originalTmux = fs.readFileSync(tmuxStub);
  const originalPrepare = store.prepareExecution.bind(store);
  store.prepareExecution = (...args) => {
    const prepared = originalPrepare(...args);
    fs.appendFileSync(tmuxStub, '\n# changed after execution boundary was durably captured\n');
    return prepared;
  };
  try {
    await assert.rejects(() => manager.executeAuthorizedTask(tmuxTask.task_id, {
      timeoutMs: Math.min(3000, Number(child.execution.timeout_ms)), cwd: workspace
    }), /OS-boundary identity changed|executable changed|identity/i);
  } finally {
    store.prepareExecution = originalPrepare;
    fs.writeFileSync(tmuxStub, originalTmux, { mode: 0o700 });
    fs.chmodSync(tmuxStub, 0o700);
  }
  const startsAfter = fs.readFileSync(spawnLog, 'utf8').split(/\r?\n/).filter(Boolean).length;
  assert.equal(startsAfter, startsBefore, 'substituted tmux executable must not create an execution session');
  assert.equal(store.getTask(tmuxTask.task_id).execution_status, 'failed');
  console.log('OS SPAWN BOUNDARY REJECTS POST-PREPARE TMUX EXECUTABLE SUBSTITUTION PASS');
}

// Path hashing followed by execution of the same mutable pathname still had
// a final-check-to-exec race: a replacement after _assertExecutionBoundaryUnchanged
// could run even though the durable boundary carried the original hash. The
// manager now executes a private content-addressed copy, not the mutable source
// pathname. Mutate that source from the narrow post-check hook and prove that
// only the pinned fixture runs.
{
  const marker = path.join(root, 'UNPINNED_TMUX_REPLACEMENT_EXECUTED.txt');
  const originalBytes = fs.readFileSync(tmuxStub);
  const originalArgsBuilder = manager._tmuxExecutionArgs.bind(manager);
  const raceTask = store.createChildTask(job.job_id, {
    parentTaskId: cto.task_id, role: 'architect', description: 'execute only the content-pinned tmux binary',
    metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
  });
  manager._tmuxExecutionArgs = (...args) => {
    const result = originalArgsBuilder(...args);
    fs.writeFileSync(tmuxStub,
      `#!/bin/sh\nprintf '%s' 'replacement ran' > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o700 });
    fs.chmodSync(tmuxStub, 0o700);
    return result;
  };
  try {
    const result = await manager.executeAuthorizedTask(raceTask.task_id, {
      timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
    });
    assert.equal(result.exitCode, 0, 'the content-pinned original tmux fixture must complete the approved command');
    assert.equal(fs.existsSync(marker), false,
      'replacing the source pathname after final identity verification must not change the executable bytes used');
    const boundary = JSON.parse(store.getTask(raceTask.task_id).metadata_json).execution_boundary_identity;
    assert.equal(boundary.tmux.pinned, true);
    assert.equal(boundary.tmux.source_realpath, tmuxStub);
    assert.notEqual(boundary.tmux.realpath, tmuxStub,
      'the durable boundary must point execution at the private content-addressed copy');
    assert.match(boundary.tmux.sha256, /^[a-f0-9]{64}$/,
      'the durable boundary must bind the digest of the private executable copy');
  } finally {
    manager._tmuxExecutionArgs = originalArgsBuilder;
    fs.writeFileSync(tmuxStub, originalBytes, { mode: 0o700 });
    fs.chmodSync(tmuxStub, 0o700);
  }
  console.log('OS SPAWN BOUNDARY PINS EXECUTABLE BYTES ACROSS FINAL-CHECK-TO-EXEC WINDOW PASS');
}

// A content-addressed pathname can still be replaced or modified by another
// process running as the service UID after the final identity check. On Linux,
// invoke the already-open, identity-checked tmux inode through an inherited fd
// so pathname substitution in this exact window is rejected before spawn.
{
  const marker = path.join(root, 'PINNED_TMUX_PATH_REPLACEMENT_EXECUTED.txt');
  const originalTmux = fs.readFileSync(tmuxStub);
  const digest = crypto.createHash('sha256').update(originalTmux).digest('hex');
  const pinnedPath = path.join(execTmp, '.pinned-executables', `${digest}.bin`);
  const originalPinned = fs.readFileSync(pinnedPath);
  const originalArgsBuilder = manager._tmuxExecutionArgs.bind(manager);
  const raceTask = store.createChildTask(job.job_id, {
    parentTaskId: cto.task_id, role: 'architect', description: 'reject post-check pinned tmux replacement',
    metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
  });
  manager._tmuxExecutionArgs = (...args) => {
    const result = originalArgsBuilder(...args);
    fs.chmodSync(pinnedPath, 0o700);
    fs.writeFileSync(pinnedPath,
      `#!/bin/sh\nprintf '%s' 'replacement ran' > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o700 });
    fs.chmodSync(pinnedPath, 0o700);
    return result;
  };
  try {
    await assert.rejects(() => manager.executeAuthorizedTask(raceTask.task_id, {
      timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
    }), /pinned execution-control executable (filesystem identity|bytes) changed/,
    'a replacement of the pinned control executable after final recheck must fail before OS spawn');
    assert.equal(fs.existsSync(marker), false, 'the substituted pinned tmux image must never execute');
    assert.equal(store.getTask(raceTask.task_id).execution_status, 'failed');
  } finally {
    manager._tmuxExecutionArgs = originalArgsBuilder;
    fs.chmodSync(pinnedPath, 0o700);
    fs.writeFileSync(pinnedPath, originalPinned, { mode: 0o700 });
    fs.chmodSync(pinnedPath, 0o500);
  }
  console.log('OS SPAWN BOUNDARY REJECTS POST-CHECK PINNED TMUX PATH SUBSTITUTION PASS');
}

// A tmux client can lose its response after the server has accepted the new
// session. A non-zero/ambiguous result at this boundary must not terminalize
// the durable attempt as failed or permit an automatic second launch.
{
  const ambiguousMarker = path.join(root, 'ambiguous-tmux-session-created.txt');
  const ambiguousTmux = path.join(root, 'tmux-ambiguous-response-fixture');
  fs.writeFileSync(ambiguousTmux, `#!/bin/sh\ncase "$1" in\n  new-session) printf '%s\\n' accepted > ${JSON.stringify(ambiguousMarker)}; exit 9 ;;\n  display-message) printf "12345\\n" ;;\n  kill-session) exit 0 ;;\n  *) exit 31 ;;\nesac\n`, { flag: 'wx', mode: 0o700 });
  fs.chmodSync(ambiguousTmux, 0o700);
  const ambiguousTask = store.createChildTask(job.job_id, {
    parentTaskId: cto.task_id, role: 'architect', description: 'reconcile uncertain process creation',
    metadata: { ...planned.execution, workflow_plan_task_id: planned.id }
  });
  const ambiguousManager = new ExecutionManager(store, { tmuxBin: ambiguousTmux, timeoutMs: 3000, executionTmpDir: execTmp });
  await assert.rejects(() => ambiguousManager.executeAuthorizedTask(ambiguousTask.task_id, {
    timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
  }), /OS process creation outcome is ambiguous/);
  assert.equal(fs.readFileSync(ambiguousMarker, 'utf8').trim(), 'accepted',
    'fixture models a server-side session acceptance before the client reports failure');
  assert.equal(store.getTask(ambiguousTask.task_id).execution_status, 'running',
    'uncertain process creation must remain running/reconciliation-only rather than being falsely terminalized failed');
  await assert.rejects(() => ambiguousManager.executeAuthorizedTask(ambiguousTask.task_id, {
    timeoutMs: Math.min(3000, Number(planned.execution.timeout_ms)), cwd: workspace
  }), /task already executing/);
  assert.equal(fs.readFileSync(ambiguousMarker, 'utf8').trim(), 'accepted', 'a retry must not replay an uncertain spawn');
  console.log('OS SPAWN AMBIGUOUS RESPONSE / DURABLE RUNNING STATE / NO AUTOMATIC REPLAY PASS');
}

console.log('test-execution-plan-binding: PASS');
