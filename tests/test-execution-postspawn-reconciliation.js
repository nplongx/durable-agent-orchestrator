import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-postspawn-reconciliation-');
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(dataDir, 'runtime');
const dbPath = path.join(dataDir, 'workflow.db');
const tmuxStub = path.join(root, 'tmux-control-stub');
const tmuxLog = path.join(root, 'tmux-control.log');
const commandSentinel = path.join(root, 'task-command-must-not-run.txt');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.EXECUTION_TMP_DIR = runtimeDir;
process.env.NODE_ENV = 'test';

fs.writeFileSync(tmuxStub, `#!/bin/sh
case "$1" in
  new-session) printf 'new-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  display-message) printf '12345\\n'; exit 0 ;;
  kill-session) printf 'kill-session\\n' >> ${JSON.stringify(tmuxLog)}; exit 0 ;;
  has-session) printf 'has-session\\n' >> ${JSON.stringify(tmuxLog)}; printf 'session remains active\\n' >&2; exit 0 ;;
  *) exit 31 ;;
esac
`, { flag: 'wx', mode: 0o700 });
fs.chmodSync(tmuxStub, 0o700);

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
const store = new WorkflowStore();
const manager = new ExecutionManager(store, { tmuxBin: tmuxStub, timeoutMs: 1000, executionTmpDir: runtimeDir });
const originalSetExecutionPid = store.setExecutionPid.bind(store);

try {
  const job = store.createJob({ conversationKey: `postspawn-${process.pid}`, title: 'Post-spawn local-control failure quarantine' });
  const task = store.ensureTask(job.job_id, { role: 'executor', description: 'command whose accepted session needs reconciliation' });
  const command = `node -e "require('node:fs').writeFileSync(${JSON.stringify(commandSentinel)}, 'must not execute in this fixture')"`;

  // new-session returns success, and display-message returns a valid PID, so the
  // process/session boundary is definitely past the accepted-spawn point. The
  // next local DB write is injected to fail, while has-session continues to
  // report that the session exists. This models an adapter DB failure after
  // launch without launching any actual task command or contacting a provider.
  store.setExecutionPid = () => { throw new Error('injected post-spawn PID persistence failure'); };
  await assert.rejects(() => manager.executeTask(task.task_id, { command, cwd: root, timeoutMs: 1000 }),
    /outcome is not verified|injected post-spawn PID persistence failure/);
  store.setExecutionPid = originalSetExecutionPid;

  const persisted = store.getTask(task.task_id);
  assert.equal(persisted.execution_status, 'running',
    'a post-spawn local failure must not terminalize an accepted, still-present session as failed');
  assert.equal(persisted.status, 'running');
  assert.ok(persisted.execution_session_id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(task.task_id).n, 1,
    'the original execution attempt must stay open while outcome reconciliation is required');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.spawn_reconciliation_required' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
    .get(job.job_id, task.task_id).n, 1, 'durable reconciliation-required event must bind exact task/session attempt');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.failed' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=1")
    .get(job.job_id, task.task_id).n, 0, 'no false failed terminal event is allowed while the accepted session remains');
  assert.equal(fs.existsSync(commandSentinel), false, 'fake tmux never launches the command or creates its sentinel');

  await assert.rejects(() => manager.executeTask(task.task_id, { command, cwd: root, timeoutMs: 1000 }), /already executing/,
    'retry must be fenced until recovery resolves the exact accepted session and attempt');
  const commands = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(commands.filter(line => line === 'new-session').length, 1,
    'a locally retrying caller must not create a second tmux session during unresolved first-session state');
  assert.ok(commands.includes('kill-session') && commands.includes('has-session'),
    'reconciliation must try termination and then probe actual exact-session absence');
  console.log('POST-SPAWN LOCAL FAILURE / LIVE-SESSION QUARANTINE / NO DUPLICATE RETRY PASS');
} finally {
  store.setExecutionPid = originalSetExecutionPid;
  try { store.db.close(); } catch {}
}
