import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';
import { canonicalExecutionEvidenceContent } from '../src/runtime/workflow/evidence.js';

const tempRoot = tempDir('m5-');
const dbPath = `${tempRoot}/workflow.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = tempRoot;

const storeModulePath = path.resolve(process.env.M5_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m5-${process.pid}`, title: 'M5 terminalization' });
store.approve(job.job_id, 'Duyệt');
const parent = store.dispatch(job.job_id, { role: 'cto', description: 'M5 terminalization test' });
const child = store.createChildTask(job.job_id, { parentTaskId: parent.task_id, role: 'qa', description: 'deterministic check' });
store.attachTaskRuntime(child.task_id, { runId: 'run-m5', sessionKey: 'agent:qa:subagent:m5' });
store.completeTaskByRuntime(job.job_id, { runId: 'run-m5', sessionKey: 'agent:qa:subagent:m5', content: '[ACTUAL TOOL RESULT EVIDENCE]\nnode --check x\nexit status: 0', outcome: 'success' });
store.attachTaskRuntime(parent.task_id, { runId: 'run-cto-m5', sessionKey: 'agent:cto:subagent:m5' });
store.completeTaskByRuntime(job.job_id, { runId: 'run-cto-m5', sessionKey: 'agent:cto:subagent:m5', content: 'synthesis', outcome: 'success' });

assert.throws(() => store.terminalizeJob(job.job_id), /without durable report/);
const reportId = store.createReport(job.job_id, 'executive_summary', 'M5 PASS');
// Recovery contract: report creation and delivery claims may be replayed after
// a transient failure between synthesis persistence and Job terminalization.
assert.equal(store.createReport(job.job_id, 'executive_summary', 'M5 PASS'), reportId);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind='executive_summary' AND content='M5 PASS'").get(job.job_id).n, 1);
assert.throws(() => store.terminalizeJob(job.job_id, { reportId }), /without delivery claim/);
assert.equal(store.claimDelivery(job.job_id, reportId, 'slack', 'C0C3RJKNKPG'), true);
assert.equal(store.claimDelivery(job.job_id, reportId, 'slack', 'C0C3RJKNKPG'), false);
const done = store.terminalizeJob(job.job_id, { reportId, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: 'M5 PASS' });
assert.equal(done.job.state, 'COMPLETED');
assert.equal(done.job.status, 'completed');
const second = store.terminalizeJob(job.job_id, { reportId, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG' });
assert.equal(second.idempotent, true);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.completed'").get(job.job_id).n, 1);

// A stale attempt arriving after terminal success must not overwrite the Job.
const staleBefore = store.getJob(job.job_id);
store.complete(job.job_id, '[STALE COMPLETION]', 'failure');
assert.equal(store.getJob(job.job_id).state, 'COMPLETED');
assert.equal(store.getJob(job.job_id).status, 'completed');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.failed'").get(job.job_id).n, 0);

const prod = store.createJob({ conversationKey: `m5-prod-${process.pid}`, title: 'Production E2E acceptance terminalization' });
store.approve(prod.job_id, 'Duyet');
const prodPlan = store.getExecutionPlan(prod.job_id);
const cto = store.dispatch(prod.job_id, { role: 'cto', description: 'sessions_spawn Architect and QA' });
for (const [role, command] of [['architect', 'node --check /home/long/work/chatgpt-adapter/server.js'], ['qa', 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js']]) {
  const t = store.createChildTask(prod.job_id, { parentTaskId: cto.task_id, role, description: `Run exact command: ${command}.` });
  store.db.prepare("UPDATE tasks SET execution_session_id=?, execution_status='completed', execution_attempt=1, execution_exit_code=0 WHERE task_id=?").run(`exec-${role}-m5`, t.task_id);
  store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(t.task_id);
  const resultId = `result-${role}-m5`;
  const resultContent = `[ACTUAL TOOL RESULT EVIDENCE]\n[ACTUAL EXECUTION EVIDENCE]\ntask_id: ${t.task_id}\nexecution_session_id: exec-${role}-m5\nattempt: 1\nexact command: ${command}\nexit status/code: 0\nexecution status: completed`;
  const completedAt = new Date().toISOString();
  store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)").run(resultId, t.task_id, 'success', resultContent, completedAt);
  const childAttemptId = `attempt-${role}-m5`;
  store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,started_at,finished_at) VALUES(?,?,'completed',?,?)")
    .run(childAttemptId, t.task_id, completedAt, completedAt);
  const artifactType = prodPlan.children.find(item => item.role === role)?.execution?.output_artifact_type || (role === 'architect' ? 'architecture' : 'qa-report');
  const artifactContent = role === 'architect'
    ? { components: ['isolated M5 fixture'], interfaces: [], failure_modes: [], implementation_boundary: 'test fixture only' }
    : { checks: ['fixture command'], results: [resultContent], decision: 'accept' };
  store.createArtifact({ artifact_id: `${artifactType}-${resultId}`, job_id: prod.job_id, task_id: t.task_id,
    type: artifactType, producer_role: role, content: artifactContent, evidence: [resultId] });
  store.recordEvent(prod.job_id, 'task.local_completed', { taskId: t.task_id, resultId, attemptId: childAttemptId, executor: 'chat-on-steroids-plugin' }, resultId);
}
const nullExitProductionChild = store.db.prepare("SELECT task_id FROM tasks WHERE job_id=? AND role='architect' AND parent_task_id=?")
  .get(prod.job_id, cto.task_id);
store.db.prepare('UPDATE tasks SET execution_exit_code=NULL WHERE task_id=?').run(nullExitProductionChild.task_id);
assert.throws(() => store.assertSupportedCtoChildEvidence(prod.job_id),
  /invalid structured execution evidence for child role=architect/,
  'supported workflow evidence must reject NULL exit code even if execution_status is completed and a session ID exists');
store.db.prepare('UPDATE tasks SET execution_exit_code=0 WHERE task_id=?').run(nullExitProductionChild.task_id);
const originalArchitectMetadata = store.getTask(nullExitProductionChild.task_id).metadata_json;
const downgradedArchitectMetadata = JSON.parse(originalArchitectMetadata);
downgradedArchitectMetadata.executor = 'ChatOnSteroidsHost';
downgradedArchitectMetadata.deterministic = false;
store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify(downgradedArchitectMetadata), nullExitProductionChild.task_id);
assert.throws(() => store.assertSupportedCtoChildEvidence(prod.job_id),
  /metadata executor differs from immutable plan for role=architect/,
  'task metadata must not downgrade a planned deterministic production child and bypass terminalization evidence requirements');
store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(originalArchitectMetadata, nullExitProductionChild.task_id);

// Exercise the runtime completion caller itself, not only the later
// terminalization gate: a deterministic production task must not be completed
// from a success-shaped OpenClaw transcript when its structured execution
// ledger is missing the numeric exit code and there is no durable execution
// result bound to its session/attempt.
const runtimeNullExitJob = store.createJob({
  conversationKey: `m5-null-exit-runtime-${process.pid}`,
  title: 'Production E2E acceptance runtime null-exit contract'
});
store.approve(runtimeNullExitJob.job_id, 'isolated M5 runtime-success-contract fixture');
const runtimeNullExitPlan = store.getExecutionPlan(runtimeNullExitJob.job_id);
const runtimeNullExitCto = store.dispatch(runtimeNullExitJob.job_id, { role: 'cto', description: 'runtime null-exit contract fixture' });
const runtimeNullExitSpec = runtimeNullExitPlan.children.find(item => item.role === 'architect');
assert.ok(runtimeNullExitSpec?.execution?.executor === 'ExecutionManager');
const runtimeNullExitTask = store.recordSpawn(runtimeNullExitJob.job_id, {
  parentTaskId: runtimeNullExitCto.task_id,
  role: runtimeNullExitSpec.role,
  description: `Run exact command: ${runtimeNullExitSpec.execution.command}.`,
  runId: `m5-null-exit-run-${process.pid}`,
  sessionKey: `agent:architect:subagent:m5-null-exit-${process.pid}`,
  metadata: { ...runtimeNullExitSpec.execution, workflow_plan_task_id: runtimeNullExitSpec.id }
});
store.db.prepare("UPDATE tasks SET execution_session_id=?, execution_status='completed', execution_attempt=1, execution_exit_code=NULL WHERE task_id=?")
  .run(`exec-m5-null-exit-${process.pid}`, runtimeNullExitTask.task_id);
const runtimeNullExitCompletion = store.completeTaskByRuntime(runtimeNullExitJob.job_id, {
  runId: runtimeNullExitTask.openclaw_run_id,
  sessionKey: runtimeNullExitTask.openclaw_session_key,
  content: [
    '<prompt-data>', '[ACTUAL TOOL RESULT EVIDENCE]', '[ACTUAL EXECUTION EVIDENCE]',
    `task_id: ${runtimeNullExitTask.task_id}`, `execution_session_id: exec-m5-null-exit-${process.pid}`,
    'attempt: 1', `exact command: ${runtimeNullExitSpec.execution.command}`,
    'stdout: success-shaped fixture output', 'stderr:', 'exit status/code: 0', 'execution status: completed', '</prompt-data>'
  ].join('\n'),
  outcome: 'success'
});
assert.equal(runtimeNullExitCompletion.status, 'failed',
  'production runtime completion must derive success from the durable execution row, not transcript claims');
assert.equal(store.db.prepare('SELECT outcome FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
  .get(runtimeNullExitTask.task_id).outcome, 'failure');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?")
  .get(runtimeNullExitJob.job_id, runtimeNullExitTask.task_id).n, 0,
  'missing exit status must not emit a successful task.completed event');

const resultRaceJob = store.createJob({
  conversationKey: `m5-execution-result-race-${process.pid}`,
  title: 'Production E2E acceptance execution result race'
});
store.approve(resultRaceJob.job_id, 'isolated M5 durable-result-race fixture');
const resultRacePlan = store.getExecutionPlan(resultRaceJob.job_id);
const resultRaceCto = store.dispatch(resultRaceJob.job_id, { role: 'cto', description: 'durable execution result race fixture' });
const resultRaceSpec = resultRacePlan.children.find(item => item.role === 'architect');
const resultRaceRunId = `m5-result-race-run-${process.pid}`;
const resultRaceSessionKey = `agent:architect:subagent:m5-result-race-${process.pid}`;
const resultRaceTask = store.recordSpawn(resultRaceJob.job_id, {
  parentTaskId: resultRaceCto.task_id, role: resultRaceSpec.role,
  description: `Run exact command: ${resultRaceSpec.execution.command}.`,
  runId: resultRaceRunId, sessionKey: resultRaceSessionKey,
  metadata: { ...resultRaceSpec.execution, workflow_plan_task_id: resultRaceSpec.id }
});
const resultRaceExecutionSession = `exec-m5-result-race-${process.pid}`;
store.db.prepare("UPDATE tasks SET execution_session_id=?,execution_status='completed',execution_attempt=1,execution_exit_code=0 WHERE task_id=?")
  .run(resultRaceExecutionSession, resultRaceTask.task_id);
const resultRacePriorId = `result-m5-execution-race-prior-${process.pid}`;
const resultRacePriorContent = canonicalExecutionEvidenceContent({
  taskId: resultRaceTask.task_id, executionSessionId: resultRaceExecutionSession, attempt: 1,
  command: resultRaceSpec.execution.command, exitCode: 0, status: 'completed', stdout: '', stderr: ''
});
store.db.prepare('INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)')
  .run(resultRacePriorId, resultRaceTask.task_id, 'success', resultRacePriorContent, new Date().toISOString());
const resultRaceBarrierDir = path.join(tempRoot, 'runtime-completion-result-outcome-race-barrier');
fs.mkdirSync(resultRaceBarrierDir, { mode: 0o700 });
const resultRaceRuntimeContent = canonicalExecutionEvidenceContent({
  taskId: resultRaceTask.task_id, executionSessionId: resultRaceExecutionSession, attempt: 1,
  command: resultRaceSpec.execution.command, exitCode: 0, status: 'completed', stdout: '', stderr: ''
});
const resultRaceChildCode = `
  const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
  const store = new WorkflowStore();
  try {
    const result = store.completeTaskByRuntime(${JSON.stringify(resultRaceJob.job_id)}, {
      runId: ${JSON.stringify(resultRaceRunId)}, sessionKey: ${JSON.stringify(resultRaceSessionKey)},
      content: ${JSON.stringify(resultRaceRuntimeContent)}, outcome: 'success'
    });
    console.log('RESULT_OUTCOME_RACE_TERMINAL:' + result.status);
  } catch (error) {
    console.error('RESULT_OUTCOME_RACE_ERROR:' + String(error?.message || error));
    process.exitCode = 24;
  } finally { try { store.db.close(); } catch {} }
`;
const resultRaceChild = spawn(process.execPath, ['--input-type=module', '-e', resultRaceChildCode], {
  cwd: process.cwd(),
  env: {
    ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: tempRoot,
    NODE_ENV: 'test', M5_WORKFLOW_STORE_MODULE: storeModulePath,
    CHAT_ON_STEROIDS_TEST_RUNTIME_COMPLETION_BARRIER_DIR: resultRaceBarrierDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let resultRaceStdout = ''; let resultRaceStderr = '';
resultRaceChild.stdout.setEncoding('utf8'); resultRaceChild.stderr.setEncoding('utf8');
resultRaceChild.stdout.on('data', data => { resultRaceStdout += data; });
resultRaceChild.stderr.on('data', data => { resultRaceStderr += data; });
const resultRaceClosed = new Promise(resolve => resultRaceChild.on('close', (code, signal) => resolve({ code, signal })));
const resultRaceReadyPath = path.join(resultRaceBarrierDir, `${resultRaceChild.pid}.ready`);
const resultRaceDeadline = Date.now() + 15000;
while (!fs.existsSync(resultRaceReadyPath)) {
  if (Date.now() >= resultRaceDeadline) {
    resultRaceChild.kill('SIGKILL');
    throw new Error('durable execution result race did not reach the pre-write barrier');
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const resultRaceInjector = new DatabaseSync(dbPath, { timeout: 5000 });
try {
  const corrupt = resultRaceInjector.prepare("UPDATE results SET outcome='failure' WHERE result_id=? AND task_id=? AND outcome='success'")
    .run(resultRacePriorId, resultRaceTask.task_id);
  assert.equal(corrupt.changes, 1, 'adversarial writer must change exactly the result observed as successful at preflight');
} finally { resultRaceInjector.close(); }
fs.writeFileSync(path.join(resultRaceBarrierDir, 'release'), 'release after durable result outcome changed\n', { flag: 'wx', mode: 0o600 });
const resultRaceExit = await resultRaceClosed;
assert.equal(resultRaceExit.code, 0, `completion race child should fail closed, not crash; stderr=${resultRaceStderr}`);
assert.match(resultRaceStdout, /RESULT_OUTCOME_RACE_TERMINAL:failed/,
  'the under-lock result re-read must downgrade success after the latest durable result changes');
const inspectResultRace = new DatabaseSync(dbPath, { timeout: 5000 });
try {
  assert.equal(inspectResultRace.prepare('SELECT status FROM tasks WHERE task_id=?').get(resultRaceTask.task_id).status, 'failed');
  assert.equal(inspectResultRace.prepare("SELECT COUNT(*) AS n FROM results WHERE task_id=? AND outcome='success'").get(resultRaceTask.task_id).n, 0,
    'no successful durable result may remain after the result-outcome race');
  assert.equal(inspectResultRace.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?")
    .get(resultRaceJob.job_id, resultRaceTask.task_id).n, 0);
  assert.equal(inspectResultRace.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.failed' AND json_extract(payload_json,'$.taskId')=?")
    .get(resultRaceJob.job_id, resultRaceTask.task_id).n, 1);
} finally { inspectResultRace.close(); }
console.log('M5 DURABLE EXECUTION RESULT OUTCOME / COMPLETION WRITE-LOCK RACE PASS');

store.attachTaskRuntime(cto.task_id, { runId: 'run-cto-prod-m5', sessionKey: 'agent:cto:subagent:m5-prod' });
const synthesis = 'Architect: node --check /home/long/work/chatgpt-adapter/server.js exit status: 0; QA: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js exit status: 0';
// This intentionally stale pre-synthesis report lets the missing-result guard
// be exercised first; successful terminalization must later use a report
// created from the actual CTO result bytes.
const prodReport = store.createReport(prod.job_id, 'executive_summary', `${synthesis} (stale pre-synthesis report)`);
store.claimDelivery(prod.job_id, prodReport, 'slack', 'C0C3RJKNKPG');
// Adversarially reproduce the gap: completed child evidence, CTO task status,
// report and delivery are not sufficient without a durable CTO result/artifact.
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(cto.task_id);
store.db.prepare("UPDATE agent_sessions SET state='TERMINATED' WHERE task_id=?").run(cto.task_id);
assert.throws(() => store.terminalizeJob(prod.job_id, { reportId: prodReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis }), /durable successful CTO result/);
const ctoResultId = 'result-cto-m5-prod';
const ctoAttempt = store.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC LIMIT 1").get(cto.task_id);
const ctoAttemptId = ctoAttempt?.attempt_id || 'attempt-cto-m5-prod';
if (!ctoAttempt) {
  store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,started_at,finished_at) VALUES(?,?,'completed',?,?)")
    .run(ctoAttemptId, cto.task_id, new Date().toISOString(), new Date().toISOString());
} else {
  store.db.prepare("UPDATE attempts SET status='completed', finished_at=? WHERE attempt_id=?").run(new Date().toISOString(), ctoAttemptId);
}
store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,'success',?,?)")
  .run(ctoResultId, cto.task_id, synthesis, new Date().toISOString());
store.recordEvent(prod.job_id, 'task.local_completed', { taskId: cto.task_id, resultId: ctoResultId, attemptId: ctoAttemptId, executor: 'chat-on-steroids-plugin' }, ctoResultId);
assert.throws(() => store.terminalizeJob(prod.job_id, { reportId: prodReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis }), /active CTO decision artifact/);
store.createArtifact({
  artifact_id: `cto-decision-${ctoResultId}`, job_id: prod.job_id, task_id: cto.task_id,
  type: 'cto-decision', producer_role: 'cto',
  content: { decision: 'approve', summary: synthesis, accepted_requirements: [], unresolved_risks: [], follow_up_actions: [], evidence_refs: [] },
  evidence: [ctoResultId]
});
const prodFinalReport = store.createReport(prod.job_id, 'executive_summary', synthesis);
store.claimDelivery(prod.job_id, prodFinalReport, 'slack', 'C0C3RJKNKPG');
const prodDone = store.terminalizeJob(prod.job_id, { reportId: prodFinalReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis });
assert.equal(prodDone.job.state, 'COMPLETED');
// Idempotent retries must revalidate terminal lineage instead of returning a
// cached success after durable CTO evidence is removed or corrupted.
const architectArtifactType = prodPlan.children.find(item => item.role === 'architect')?.execution?.output_artifact_type || 'architecture';
const architectArtifactId = `${architectArtifactType}-result-architect-m5`;
store.db.prepare("UPDATE artifacts SET status='invalidated' WHERE artifact_id=?").run(architectArtifactId);
assert.throws(() => store.terminalizeJob(prod.job_id, { reportId: prodFinalReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis }), /child .* lacks a typed artifact bound to its result/);
store.db.prepare("UPDATE artifacts SET status='active' WHERE artifact_id=?").run(architectArtifactId);
store.db.prepare("UPDATE reports SET content=? WHERE report_id=?").run('tampered after terminalization', prodFinalReport);
assert.throws(() => store.terminalizeJob(prod.job_id, { reportId: prodFinalReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis }), /report bytes do not match/);
store.db.prepare("UPDATE reports SET content=? WHERE report_id=?").run(synthesis, prodFinalReport);
store.db.prepare("DELETE FROM artifacts WHERE artifact_id=?").run(`cto-decision-${ctoResultId}`);
assert.throws(() => store.terminalizeJob(prod.job_id, { reportId: prodFinalReport, deliveryChannel: 'slack', deliveryTarget: 'C0C3RJKNKPG', content: synthesis }), /active CTO decision artifact/);
assert.equal(store.getJob(prod.job_id).state, 'COMPLETED', 'failed idempotent verification must not rewrite terminal job state');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.completed'").get(prod.job_id).n, 1,
  'failed idempotent verification must not append a duplicate terminal event');

// Terminalization must not race live runtime resources even when all business tasks are terminal.
const guard = store.createJob({ conversationKey: `m5-guard-${process.pid}`, title: 'M5 terminal resource guards' });
store.approve(guard.job_id, 'Duyet');
const guardTask = store.dispatch(guard.job_id, { role: 'cto', description: 'guard task' });
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(guardTask.task_id);
const guardReport = store.createReport(guard.job_id, 'executive_summary', 'guard');
store.claimDelivery(guard.job_id, guardReport, 'slack', 'guard-target');
store.createAgentSession(guardTask.task_id, { sessionKey: 'agent:cto:guard-active', role: 'cto', state: 'ACTIVE' });
assert.throws(() => store.terminalizeJob(guard.job_id, { reportId: guardReport, deliveryChannel: 'slack', deliveryTarget: 'guard-target' }), /active agent sessions/);
store.db.prepare("UPDATE agent_sessions SET state='TERMINATED' WHERE openclaw_session_key=?").run('agent:cto:guard-active');
store.db.prepare("INSERT INTO execution_batches(batch_id, job_id, parent_task_id, role, status, attempt, created_at, started_at) VALUES(?,?,?,?,?,?,?,?)")
  .run('batch-m5-guard', guard.job_id, guardTask.task_id, 'cto', 'RUNNING', 1, new Date().toISOString(), new Date().toISOString());
assert.throws(() => store.terminalizeJob(guard.job_id, { reportId: guardReport, deliveryChannel: 'slack', deliveryTarget: 'guard-target' }), /active execution batches/);

// Reproduce a second-process writer landing after terminalization preflight
// but before BEGIN IMMEDIATE. The injected row is committed before the
// terminalizer acquires its writer lock; lock-time validation must refuse to
// terminalize around newly pending work.
const race = store.createJob({ conversationKey: `m5-race-${process.pid}`, title: 'M5 terminalization preflight race' });
store.approve(race.job_id, 'Duyet');
const raceCto = store.dispatch(race.job_id, { role: 'cto', description: 'race fixture' });
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(raceCto.task_id);
store.db.prepare("UPDATE jobs SET active_task_id=? WHERE job_id=?").run(raceCto.task_id, race.job_id);
const raceReport = store.createReport(race.job_id, 'executive_summary', 'race fixture');
store.claimDelivery(race.job_id, raceReport, 'slack', 'race-target');
const originalGetTask = store.getTask.bind(store);
let injectedRaceTask = false;
store.getTask = taskId => {
  if (!injectedRaceTask && taskId === raceCto.task_id) {
    injectedRaceTask = true;
    const ts = new Date().toISOString();
    store.db.prepare("INSERT INTO tasks(task_id,job_id,role,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('m5-race-pending-task', race.job_id, 'qa', 'concurrent pending task', 'pending', ts, ts);
  }
  return originalGetTask(taskId);
};
try {
  assert.throws(() => store.terminalizeJob(race.job_id, { reportId: raceReport, deliveryChannel: 'slack', deliveryTarget: 'race-target' }), /open tasks/);
  assert.equal(store.getJob(race.job_id).state, 'EXECUTING', 'terminalization must not commit after concurrent pending work appears');
  assert.equal(store.getTask('m5-race-pending-task').status, 'pending', 'concurrent writer state must survive terminalization refusal');
} finally {
  store.getTask = originalGetTask;
}

// Runtime completion used to write the result before creating the derived
// typed artifact without a surrounding transaction. Injecting an artifact
// persistence failure left an orphan result and an apparently running task.
// The completion savepoint must roll the whole transition back so retry can
// safely persist one coherent result/artifact/task/attempt/event chain.
const atomic = store.createJob({ conversationKey: `m5-runtime-atomic-${process.pid}`, title: 'Engineering M4 runtime completion atomicity' });
store.transition(atomic.job_id, 'PROPOSED');
store.approve(atomic.job_id, 'Duyet');
const atomicPlan = store.getExecutionPlan(atomic.job_id);
const atomicCto = store.dispatch(atomic.job_id, { role: 'cto', description: 'runtime completion atomicity fixture' });
const engineerSpec = atomicPlan.children.find(item => item.role === 'engineer');
const architectSpec = atomicPlan.children.find(item => item.role === 'architect');
const taskCountBeforeWrongPlanBinding = store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(atomic.job_id).n;
assert.throws(() => store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'architect', description: 'forged architect-to-engineer plan binding',
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
}), /workflow_plan_task_id does not match the immutable plan entry/);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE job_id=?').get(atomic.job_id).n, taskCountBeforeWrongPlanBinding,
  'invalid role-to-plan binding must be rejected before creating a durable task row');
const engineerTask = store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'engineer', description: 'create implementation evidence',
  dependencies: engineerSpec.dependencies,
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
});
store.beginLocalTask(engineerTask.task_id);
const implementationResult = store.completeLocalTask(engineerTask.task_id, {
  content: 'durable implementation result',
  artifact: {
    summary: 'Implementation artifact for runtime-completion rollback fixture.',
    files_changed: [], verification: ['typed implementation evidence persisted'],
    execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:m5:runtime-atomicity'] }
  }
});
assert.ok(implementationResult.resultId);
// Even if a task's metadata is tampered after creation, artifact type selection
// cannot be redirected to another role's immutable plan entry.
const tamperTask = store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'architect', description: 'mutable plan-id tamper fixture',
  dependencies: architectSpec.dependencies,
  metadata: { ...(architectSpec.execution || {}), workflow_plan_task_id: architectSpec.id }
});
store.beginLocalTask(tamperTask.task_id);
store.db.prepare("UPDATE tasks SET metadata_json=json_set(metadata_json,'$.workflow_plan_task_id',?) WHERE task_id=?").run(engineerSpec.id, tamperTask.task_id);
assert.throws(() => store.completeLocalTask(tamperTask.task_id, {
  content: 'must not redirect architect output to engineer type', outcome: 'success',
  artifact: {
    summary: 'Attempted wrong-plan artifact type.', files_changed: [], verification: ['must roll back'],
    execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:m5:wrong-plan-id'] }
  }
}), /workflow_plan_task_id does not match the immutable plan entry/);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(tamperTask.task_id).n, 0,
  'post-creation plan-ID tampering must roll back the result insertion');
assert.equal(store.getTask(tamperTask.task_id).status, 'running');
const qaSpec = atomicPlan.children.find(item => item.role === 'qa');
const qaTask = store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'qa', description: 'persist QA report atomically',
  dependencies: qaSpec.dependencies,
  metadata: { ...(qaSpec.execution || {}), workflow_plan_task_id: qaSpec.id }
});
const qaAttempt = store.beginRuntimeAttempt(qaTask.task_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic', reason: 'atomicity regression'
});
const originalCreateArtifact = store.createArtifact.bind(store);
let injectedArtifactFailure = false;
store.createArtifact = input => {
  if (!injectedArtifactFailure && input.type === 'qa-report') {
    injectedArtifactFailure = true;
    throw new Error('injected typed-artifact write failure');
  }
  return originalCreateArtifact(input);
};
try {
  assert.throws(() => store.completeTaskByRuntime(atomic.job_id, {
    runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
    content: 'QA verified the isolated runtime transition', outcome: 'success'
  }), /injected typed-artifact write failure/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(qaTask.task_id).n, 0,
    'failed runtime completion must not leave an orphan result');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE task_id=?').get(qaTask.task_id).n, 0,
    'failed runtime completion must not leave a typed artifact');
  assert.equal(store.getTask(qaTask.task_id).status, 'running');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id=? AND status='started'").get(qaAttempt.attempt_id).n, 1,
    'failed runtime completion must preserve the attempt so retry can resolve it');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?").get(atomic.job_id, qaTask.task_id).n, 0,
    'failed runtime completion must not publish a completion event');
} finally {
  store.createArtifact = originalCreateArtifact;
}
const recoveredRuntimeTask = store.completeTaskByRuntime(atomic.job_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
  content: 'QA verified the isolated runtime transition', outcome: 'success'
});
assert.equal(recoveredRuntimeTask.status, 'completed');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=? AND outcome=\'success\'').get(qaTask.task_id).n, 1);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=? AND kind='qa-report' AND status='active'").get(qaTask.task_id).n, 1);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id=? AND status='completed'").get(qaAttempt.attempt_id).n, 1);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?").get(atomic.job_id, qaTask.task_id).n, 1);
const exactRuntimeReplay = store.completeTaskByRuntime(atomic.job_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
  content: 'QA verified the isolated runtime transition', outcome: 'success'
});
assert.equal(exactRuntimeReplay.status, 'completed', 'exact terminal runtime replay must preserve idempotent compatibility');
assert.throws(() => store.completeTaskByRuntime(atomic.job_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
  content: 'conflicting replay content', outcome: 'success'
}), /result\/attempt\/event lineage conflicts with the replay/,
'terminal runtime replay must not hide conflicting result bytes');
assert.throws(() => store.completeTaskByRuntime(atomic.job_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
  content: 'QA verified the isolated runtime transition', outcome: 'failure'
}), /conflicts with the already-terminal task outcome/,
'terminal runtime replay must not reinterpret completed work as failed');
const completionEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?")
  .get(atomic.job_id, qaTask.task_id);
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run('{"tampered":true}', completionEvent.event_id);
assert.throws(() => store.completeTaskByRuntime(atomic.job_id, {
  runId: 'run-m5-runtime-atomic', sessionKey: 'agent:qa:subagent:m5-runtime-atomic',
  content: 'QA verified the isolated runtime transition', outcome: 'success'
}), /ambiguous or missing completion-event lineage|result\/attempt\/event lineage conflicts with the replay/,
'terminal runtime replay must not hide a tampered canonical completion event');
store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(completionEvent.payload_json, completionEvent.event_id);

// Consequential crash boundary: kill a separate runtime process immediately
// after its result INSERT while the completion savepoint is still open. A new
// SQLite connection must see no orphan result/artifact/completion event; a
// retry must then produce one complete durable transition.
const crashQaTask = store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'qa', description: 'SIGKILL after runtime result INSERT',
  dependencies: qaSpec.dependencies,
  metadata: { ...(qaSpec.execution || {}), workflow_plan_task_id: qaSpec.id }
});
const crashRunId = 'run-m5-runtime-result-sigkill';
const crashSessionKey = 'agent:qa:subagent:m5-runtime-result-sigkill';
const crashAttempt = store.beginRuntimeAttempt(crashQaTask.task_id, {
  runId: crashRunId, sessionKey: crashSessionKey, reason: 'actual process death after result INSERT'
});
const crashCode = `
  const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
  const store = new WorkflowStore();
  store.completeTaskByRuntime(${JSON.stringify(atomic.job_id)}, {
    runId: ${JSON.stringify(crashRunId)}, sessionKey: ${JSON.stringify(crashSessionKey)},
    content: 'QA result interrupted by process death', outcome: 'success'
  });
`;
const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', crashCode], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  env: {
    ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: tempRoot,
    NODE_ENV: 'test', M5_WORKFLOW_STORE_MODULE: storeModulePath,
    CHAT_ON_STEROIDS_TEST_CRASH_AFTER_RUNTIME_RESULT_INSERT: 'SIGKILL'
  }
});
assert.equal(crashed.signal, 'SIGKILL', `child should die at the injected transaction boundary; stderr=${crashed.stderr}`);
assert.equal(crashed.status, null);
const inspectAfterCrash = () => {
  const inspector = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      task: inspector.prepare('SELECT status FROM tasks WHERE task_id=?').get(crashQaTask.task_id),
      results: inspector.prepare('SELECT result_id, outcome FROM results WHERE task_id=?').all(crashQaTask.task_id),
      artifacts: inspector.prepare('SELECT artifact_id FROM artifacts WHERE task_id=?').all(crashQaTask.task_id),
      attempts: inspector.prepare('SELECT attempt_id, status FROM attempts WHERE task_id=?').all(crashQaTask.task_id),
      completionEvents: inspector.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?").all(atomic.job_id, crashQaTask.task_id)
    };
  } finally { inspector.close(); }
};
const afterProcessDeath = inspectAfterCrash();
assert.equal(afterProcessDeath.task.status, 'running');
assert.equal(afterProcessDeath.results.length, 0, 'uncommitted result INSERT must be rolled back when the writer process dies');
assert.equal(afterProcessDeath.artifacts.length, 0);
assert.equal(afterProcessDeath.attempts.filter(item => item.status === 'started').length, 1);
assert.equal(afterProcessDeath.completionEvents.length, 0);
const afterCrashRetry = store.completeTaskByRuntime(atomic.job_id, {
  runId: crashRunId, sessionKey: crashSessionKey,
  content: 'QA result recovered after process death', outcome: 'success'
});
assert.equal(afterCrashRetry.status, 'completed');
const afterRecovery = inspectAfterCrash();
assert.equal(afterRecovery.results.length, 1);
assert.equal(afterRecovery.results[0].outcome, 'success');
assert.equal(afterRecovery.artifacts.length, 1);
assert.equal(afterRecovery.attempts.filter(item => item.status === 'completed').length, 1);
assert.equal(afterRecovery.completionEvents.length, 1);
console.log('M5 RUNTIME COMPLETION SIGKILL/RECOVERY PASS');

// Two real writer processes race the same durable runtime completion after both
// have passed preflight. The task-row compare-and-set must elect one winner;
// the other process must reject instead of persisting a second result/artifact.
const raceQaTask = store.createChildTask(atomic.job_id, {
  parentTaskId: atomicCto.task_id, role: 'qa', description: 'two-process runtime completion race',
  dependencies: qaSpec.dependencies,
  metadata: { ...(qaSpec.execution || {}), workflow_plan_task_id: qaSpec.id }
});
const raceRunId = 'run-m5-two-process-completion-race';
const raceSessionKey = 'agent:qa:subagent:m5-two-process-completion-race';
const raceAttempt = store.beginRuntimeAttempt(raceQaTask.task_id, {
  runId: raceRunId, sessionKey: raceSessionKey, reason: 'two-process completion compare-and-set regression'
});
const raceBarrierDir = path.join(tempRoot, 'runtime-completion-two-process-barrier');
fs.mkdirSync(raceBarrierDir, { mode: 0o700 });
const raceCode = `
  const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
  const store = new WorkflowStore();
  try {
    const task = store.completeTaskByRuntime(${JSON.stringify(atomic.job_id)}, {
      runId: ${JSON.stringify(raceRunId)}, sessionKey: ${JSON.stringify(raceSessionKey)},
      content: 'same runtime result raced from two processes', outcome: 'success'
    });
    console.log('RUNTIME_COMPLETION_ACCEPTED:' + task.status);
  } catch (error) {
    console.error('RUNTIME_COMPLETION_REJECTED:' + String(error?.message || error));
    process.exitCode = 23;
  } finally {
    try { store.db.close(); } catch {}
  }
`;
const raceChildren = Array.from({ length: 2 }, () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', raceCode], {
    cwd: process.cwd(),
    env: {
      ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: tempRoot,
      NODE_ENV: 'test', M5_WORKFLOW_STORE_MODULE: storeModulePath,
      CHAT_ON_STEROIDS_TEST_RUNTIME_COMPLETION_BARRIER_DIR: raceBarrierDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, closed };
});
const raceReadyPaths = raceChildren.map(({ child }) => path.join(raceBarrierDir, `${child.pid}.ready`));
const raceReadyDeadline = Date.now() + 15000;
while (!raceReadyPaths.every(file => fs.existsSync(file))) {
  if (Date.now() >= raceReadyDeadline) {
    for (const { child } of raceChildren) child.kill('SIGKILL');
    throw new Error('two-process runtime completion regression did not reach the deterministic barrier');
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
fs.writeFileSync(path.join(raceBarrierDir, 'release'), 'release both completion writers\n', { flag: 'wx', mode: 0o600 });
const raceOutcomes = await Promise.all(raceChildren.map(({ closed }) => closed));
assert.equal(raceOutcomes.filter(item => item.code === 0 && item.stdout.includes('RUNTIME_COMPLETION_ACCEPTED:completed')).length, 1,
  `exactly one writer must complete the task; observed=${JSON.stringify(raceOutcomes)}`);
assert.equal(raceOutcomes.filter(item => item.code === 23 && item.stderr.includes('RUNTIME_COMPLETION_REJECTED:runtime task completion lost its task-state compare-and-set race')).length, 1,
  `the losing writer must be refused at the task-state compare-and-set; observed=${JSON.stringify(raceOutcomes)}`);
const inspectRaceConnection = new DatabaseSync(dbPath, { timeout: 5000 });
try {
  assert.equal(inspectRaceConnection.prepare('SELECT status FROM tasks WHERE task_id=?').get(raceQaTask.task_id).status, 'completed');
  assert.equal(inspectRaceConnection.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(raceQaTask.task_id).n, 1);
  assert.equal(inspectRaceConnection.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=? AND kind='qa-report' AND status='active'").get(raceQaTask.task_id).n, 1);
  assert.equal(inspectRaceConnection.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status=\'completed\'').get(raceQaTask.task_id).n, 1);
  assert.equal(inspectRaceConnection.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.completed' AND json_extract(payload_json,'$.taskId')=?").get(atomic.job_id, raceQaTask.task_id).n, 1);
  assert.equal(inspectRaceConnection.prepare("SELECT COUNT(*) AS n FROM attempts WHERE attempt_id=? AND status='started'").get(raceAttempt.attempt_id).n, 0);
} finally { inspectRaceConnection.close(); }
console.log('M5 RUNTIME COMPLETION TWO-PROCESS RACE PASS');
console.log('M5 RUNTIME COMPLETION ATOMICITY PASS');

// A second writer can also change active_task_id after preflight. Previously,
// lock-time CTO validation was conditional on the newly read task still being
// named "cto"; swapping that pointer to a completed non-CTO task skipped all
// CTO guards. Reproduce the interleaving and require fail-closed refusal.
const swap = store.createJob({ conversationKey: `m5-active-task-swap-${process.pid}`, title: 'Production E2E acceptance active task swap' });
store.approve(swap.job_id, 'Duyet');
const swapPlan = store.getExecutionPlan(swap.job_id);
const swapCto = store.dispatch(swap.job_id, { role: 'cto', description: 'active-task swap regression' });
for (const spec of swapPlan.children) {
  const child = store.createChildTask(swap.job_id, {
    parentTaskId: swapCto.task_id, role: spec.role, description: `M5 active-task swap ${spec.role}`,
    dependencies: spec.dependencies,
    metadata: { ...(spec.execution || {}), workflow_plan_task_id: spec.id }
  });
  const metadata = JSON.parse(child.metadata_json || '{}');
  store.db.prepare("UPDATE tasks SET status='completed', execution_session_id=?, execution_status='completed', execution_attempt=1, execution_exit_code=0 WHERE task_id=?")
    .run(`exec-swap-${spec.role}`, child.task_id);
  store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?, 'success', ?, ?)")
    .run(`result-swap-${spec.role}`, child.task_id, `[ACTUAL TOOL RESULT EVIDENCE]\n[ACTUAL EXECUTION EVIDENCE]\ncommand: ${metadata.command || metadata.executable || 'fixture command'}\nexit status/code: 0`, new Date().toISOString());
}
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(swapCto.task_id);
const swapDecoyId = 'm5-active-task-swap-decoy';
const swapTs = new Date().toISOString();
store.db.prepare("INSERT INTO tasks(task_id,job_id,role,description,status,parent_task_id,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(swapDecoyId, swap.job_id, 'engineer', 'decoy active task', 'completed', swapCto.task_id, '{}', swapTs, swapTs);
const swapReport = store.createReport(swap.job_id, 'executive_summary', 'must not terminalize on active-task swap');
store.claimDelivery(swap.job_id, swapReport, 'slack', 'swap-target');
const originalGetTaskForSwap = store.getTask.bind(store);
let activeTaskSwitched = false;
store.getTask = taskId => {
  if (!activeTaskSwitched && taskId === swapCto.task_id) {
    activeTaskSwitched = true;
    store.db.prepare('UPDATE jobs SET active_task_id=? WHERE job_id=?').run(swapDecoyId, swap.job_id);
  }
  return originalGetTaskForSwap(taskId);
};
try {
  assert.throws(() => store.terminalizeJob(swap.job_id, {
    reportId: swapReport, deliveryChannel: 'slack', deliveryTarget: 'swap-target', content: 'must not terminalize'
  }), /without the active CTO synthesis task/);
  assert.equal(store.getJob(swap.job_id).state, 'EXECUTING', 'active-task pointer race must not terminalize the job');
  assert.equal(store.getJob(swap.job_id).active_task_id, swapDecoyId, 'the concurrent writer state should remain traceable after refusal');
} finally {
  store.getTask = originalGetTaskForSwap;
}
console.log('M5 ACTIVE-TASK SWAP GUARD PASS');
console.log('M5 TERMINALIZATION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
