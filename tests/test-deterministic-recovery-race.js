import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dbPath = path.join(tempDir('cos-deterministic-recovery-race-'), 'workflow.db');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = path.dirname(dbPath);
process.env.WORKFLOW_WORKSPACE = process.cwd();

const { WorkflowStore } = await import('../job-store.js');
const { ExecutionManager } = await import('../execution-manager.js');
const { RecoveryManager } = await import('../recovery-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `race-${process.pid}`, title: 'Production E2E deterministic recovery race' });
store.recordEvent(job.job_id, 'job.proposal_requested', { task: job.title, workspace: process.env.WORKFLOW_WORKSPACE }, `approved-workspace|${job.title}`);
store.approve(job.job_id, 'Duyet', 'test-fixture', { workspace: process.env.WORKFLOW_WORKSPACE });
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'sessions_spawn architect' });
const child = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'architect',
  description: `Run exact command: node --check /home/long/work/chatgpt-adapter/server.js.`
});
store.db.prepare("UPDATE tasks SET status='failed' WHERE task_id=?").run(child.task_id);
store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)")
  .run('race-native-tool-result', child.task_id, 'success', '[ACTUAL TOOL RESULT EVIDENCE]\nnode --check /home/long/work/chatgpt-adapter/server.js\nexit status: 0', new Date().toISOString());
const alreadyCompletedChild = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'qa',
  description: `Run exact command: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js.`
});
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(alreadyCompletedChild.task_id);
store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)")
  .run('race-completed-without-execution-identity', alreadyCompletedChild.task_id, 'success',
    '[ACTUAL TOOL RESULT EVIDENCE]\nnode --check /home/long/work/chatgpt-adapter/test-tool-turn.js\nexit status: 0', new Date().toISOString());

const executionManager = new ExecutionManager(store);
const recovery = new RecoveryManager(store, {
  listSessions: async () => [],
  executionManager
});
await recovery.reconcile({ jobId: job.job_id });

const recovered = store.getTask(child.task_id);
const result = store.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(child.task_id);
assert.equal(recovered.status, 'completed');
assert.equal(recovered.execution_status, 'completed');
assert.equal(recovered.execution_exit_code, 0);
assert.match(result.content, /\[ACTUAL EXECUTION EVIDENCE\]/i);
assert.match(result.content, /exact command: .*node.*--check.*\/home\/long\/work\/chatgpt-adapter\/server\.js/);
assert.match(result.content, /exit status\/code: 0/);
const completedWithoutExecution = store.getTask(alreadyCompletedChild.task_id);
assert.equal(completedWithoutExecution.status, 'completed');
assert.equal(completedWithoutExecution.execution_session_id, null,
  'recovery must not reopen a successfully completed task just because execution identity is missing');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.evidence_recovery_blocked' AND json_extract(payload_json,'$.taskId')=?")
  .get(job.job_id, alreadyCompletedChild.task_id).n, 1,
  'missing execution identity on a completed task must produce explicit fail-closed recovery evidence');
console.log('DETERMINISTIC RECOVERY RACE PASS');

for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
