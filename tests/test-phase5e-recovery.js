import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('adapter-phase5e-recovery-');
const fakeOpenClaw = path.join(dir, 'openclaw');
const dbPath = path.join(dir, 'workflow.db');

const fakeScript = [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'const args = process.argv.slice(2);',
  "if (args[0] === 'sessions') {",
  "  if (args[1] === 'export-trajectory') {",
  "    const key = args[args.indexOf('--session-key') + 1];",
  "    if (key.includes('timeout')) { await new Promise(resolve => setTimeout(resolve, 2000)); process.exit(0); }",
  "    const output = args[args.indexOf('--output') + 1];",
  "    const workspace = args[args.indexOf('--workspace') + 1];",
  "    const root = path.join(workspace, '.openclaw', 'trajectory-exports', output);",
  "    fs.mkdirSync(root, { recursive: true });",
  "    const content = '[ACTUAL TOOL RESULT EVIDENCE]\\nexact command: node --check /home/long/work/chatgpt-adapter/server.js\\nexit status/code: 0\\nexecution status: completed\\n[/ACTUAL TOOL RESULT EVIDENCE]';",
  "    fs.writeFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ type: 'assistant.message', data: { message: { content } } }) + '\\n');",
  "    process.exit(0);",
  '  }',
  "  process.stdout.write(JSON.stringify({ sessions: [",
  "    { key: 'agent:architect:subagent:repair', status: 'done', runId: 'runtime-repair' },",
  "    { key: 'agent:architect:subagent:timeout', status: 'done', runId: 'runtime-timeout' }",
  "  ] }));",
  '  process.exit(0);',
  '}',
  'process.exit(2);'
].join('\n') + '\n';
fs.writeFileSync(fakeOpenClaw, fakeScript);
fs.chmodSync(fakeOpenClaw, 0o755);

process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dir;
process.env.OPENCLAW_BIN = fakeOpenClaw;

const { WorkflowStore } = await import('../job-store.js');
const { RecoveryManager } = await import('../recovery-manager.js');
const store = new WorkflowStore();

function makeFailedChild({ sessionKey, runId, title }) {
  const job = store.createJob({ conversationKey: 'phase5e:' + title, title });
  store.approve(job.job_id, 'approved', 'phase5e-test');
  store.dispatch(job.job_id, { role: 'cto', description: 'Delegate specialist work via sessions_spawn' });
  const ctoTask = store.getTask(store.getJob(job.job_id).active_task_id);
  const child = store.createChildTask(job.job_id, {
    parentTaskId: ctoTask.task_id,
    role: 'architect',
    description: 'Run the exact command immediately: node --check /home/long/work/chatgpt-adapter/server.js.'
  });
  store.attachTaskRuntime(child.task_id, { runId, sessionKey });
  store.completeTaskByRuntime(job.job_id, { runId, sessionKey, content: 'runtime path failed before actual evidence was recorded', outcome: 'success' });
  assert.equal(store.getTask(child.task_id).status, 'failed');
  const session = store.getSessionByTask(child.task_id);
  store.updateAgentSession(session.session_id, { state: 'STALE' });
  return { job, child, session };
}

const repair = makeFailedChild({
  sessionKey: 'agent:architect:subagent:repair',
  runId: 'runtime-repair',
  title: 'Production E2E recovery repair'
});
const beforeTaskCount = store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id = ?').get(repair.job.job_id).n;
const beforeSessionCount = store.db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE job_id = ?').get(repair.job.job_id).n;
const recovery = new RecoveryManager(store, { sessionStaleMs: 1, trajectoryTimeoutMs: 1500 });
await recovery.reconcile({ jobId: repair.job.job_id });
assert.equal(store.getTask(repair.child.task_id).status, 'completed');
assert.equal(store.getSession(repair.session.session_id).state, 'TERMINATED');
assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id = ?').get(repair.job.job_id).n, beforeTaskCount);
assert.equal(store.db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE job_id = ?').get(repair.job.job_id).n, beforeSessionCount);
const repairedResults = store.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at').all(repair.child.task_id);
assert.equal(repairedResults.length, 2);
assert.equal(repairedResults[0].outcome, 'failure');
assert.match(repairedResults[0].content, /runtime path failed/);
const repairedResult = repairedResults[1];
assert.equal(repairedResult.outcome, 'success');
assert.match(repairedResult.content, /\[ACTUAL TOOL RESULT EVIDENCE\]/);
assert.match(repairedResult.content, /exit status\/code: 0/);

const timeoutCase = makeFailedChild({
  sessionKey: 'agent:architect:subagent:timeout',
  runId: 'runtime-timeout',
  title: 'Production E2E recovery timeout'
});
const timeoutTaskBefore = store.getTask(timeoutCase.child.task_id);
const timeoutSessionBefore = store.getSession(timeoutCase.session.session_id);
const timeoutTaskCount = store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id = ?').get(timeoutCase.job.job_id).n;
const timeoutSessionCount = store.db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE job_id = ?').get(timeoutCase.job.job_id).n;
await recovery.reconcile({ jobId: timeoutCase.job.job_id });
assert.equal(store.getTask(timeoutCase.child.task_id).status, timeoutTaskBefore.status);
assert.equal(store.getSession(timeoutCase.session.session_id).state, timeoutSessionBefore.state);
assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tasks WHERE job_id = ?').get(timeoutCase.job.job_id).n, timeoutTaskCount);
assert.equal(store.db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE job_id = ?').get(timeoutCase.job.job_id).n, timeoutSessionCount);

fs.rmSync(dir, { recursive: true, force: true });
console.log('phase5e recovery tests: PASS');
