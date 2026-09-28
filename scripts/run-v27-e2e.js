import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowStore } from '../job-store.js';

const execFileAsync = promisify(execFile);
const OPENCLAW = process.env.OPENCLAW_BIN || '/home/long/.config/nvm/versions/node/v24.21.0/bin/openclaw';
const SESSION_KEY = `e2e-v27-${randomUUID()}`;
const E2E_ID = randomUUID();
const DIRECTIVE = `Production E2E v27 ${E2E_ID}. First turn MUST be proposal only. After approval CTO must native sessions_spawn exactly two independent children in parallel: Architect runs the exact command node --check /home/long/work/chatgpt-adapter/server.js; QA runs the exact command node --check /home/long/work/chatgpt-adapter/test-tool-turn.js. Command paths are byte-exact: NEVER abbreviate /home/long/work/chatgpt-adapter as ~/work/chatgpt-adapter or any relative path. Children return actual command, output, exit status. Runtime owns waiting and synthesis from durable evidence. No prose-only success.`;
let nativeSessionCreated = false;

async function openclaw(message, timeoutSeconds = 600) {
  const method = nativeSessionCreated ? 'sessions.send' : 'sessions.create';
  const params = method === 'sessions.create'
    ? { key: SESSION_KEY, agentId: 'coordinator', message }
    : { key: SESSION_KEY, agentId: 'coordinator', message, idempotencyKey: `${SESSION_KEY}:send:${Date.now()}` };
  const { stdout, stderr } = await execFileAsync(OPENCLAW, [
    'gateway', 'call', method, '--timeout', '10000', '--params', JSON.stringify(params)
  ], { timeout: (timeoutSeconds + 20) * 1000, maxBuffer: 20 * 1024 * 1024 });
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`invalid ${method} response: ${stderr || stdout}`);
  const payload = JSON.parse(stdout.slice(start));
  if (!payload?.ok && method === 'sessions.create') throw new Error(`sessions.create rejected: ${JSON.stringify(payload)}`);
  nativeSessionCreated = true;
  return payload;
}

function snapshot(jobId) {
  const job = workflowStore.getJob(jobId);
  const runtime = workflowStore.getWorkflowRuntimeState(jobId);
  const trace = workflowStore.getJobTrace(jobId);
  return {
    job,
    runtime,
    tasks: (trace?.tasks || []).map(t => ({
      task_id: t.task_id,
      role: t.role,
      status: t.status,
      run: t.openclaw_run_id,
      session: t.openclaw_session_key,
      execution_status: t.execution_status,
      execution_exit_code: t.execution_exit_code,
      metadata: t.metadata_json
    })),
    results: (trace?.results || []).map(r => ({ task_id: r.task_id, outcome: r.outcome, content: r.content })),
    slack: workflowStore.getSlackProjection(jobId)
  };
}

async function waitFor(jobId, predicate, label, timeoutMs = 900000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const state = snapshot(jobId);
    const compact = JSON.stringify({
      state: state.job?.state,
      phase: state.runtime?.phase,
      tasks: state.tasks.map(t => [t.role, t.status, t.execution_status, t.execution_exit_code])
    });
    if (compact !== last) { console.log(`[E2E:${label}] ${compact}`); last = compact; }
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(snapshot(jobId))}`);
}

const first = await openclaw(DIRECTIVE);
assert.ok(first, 'missing OpenClaw proposal response');

const startedAt = Date.now();
let jobId = null;
while (Date.now() - startedAt < 120000 && !jobId) {
  jobId = workflowStore.db.prepare('SELECT job_id FROM jobs WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1').get(`%${E2E_ID}%`)?.job_id || null;
  if (!jobId) await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(jobId, `durable Job not created for E2E_ID=${E2E_ID}`);
const proposed = await waitFor(
  jobId,
  s => s.runtime?.phase === 'PROPOSED' && s.job?.state === 'PROPOSED' && String(s.job?.title || '').includes(E2E_ID),
  'proposal-durable',
  120000
);
jobId = proposed.job.job_id;
assert.equal(proposed.runtime.phase, 'PROPOSED');
assert.equal(proposed.tasks.some(t => t.role === 'cto' && t.session), false, 'CTO runtime exists before approval');
console.log(`[E2E] proposal-only PASS job=${jobId}`);

await openclaw(`Duyệt Job ${jobId}. Bắt đầu execution ngay.`);

let state = await waitFor(jobId,
  s => s.job?.state === 'EXECUTING' && s.tasks.find(t => t.role === 'cto')?.session,
  'approval-native-cto',
  600000);
assert.equal(state.job.state, 'EXECUTING');
assert.ok(['SPAWN_CTO', 'ASSIGN_CHILDREN', 'RUN_CHILDREN', 'WAIT', 'VALIDATE_EVIDENCE', 'SYNTHESIZE', 'TERMINALIZE', 'PROJECT', 'COMPLETED'].includes(state.runtime.phase));
assert.equal(state.tasks.filter(t => t.role === 'cto').length, 1);
assert.ok(state.tasks.find(t => t.role === 'cto')?.session, 'native CTO runtime missing');
console.log('[E2E] approval/native CTO spawn PASS');

state = await waitFor(jobId, s => {
  const children = s.tasks.filter(t => ['architect', 'qa'].includes(String(t.role).toLowerCase()));
  return children.length === 2 && children.every(t => t.session || t.run);
}, 'native-children', 600000);
const children = state.tasks.filter(t => ['architect', 'qa'].includes(String(t.role).toLowerCase()));
assert.equal(new Set(children.map(t => t.role.toLowerCase())).size, 2);
assert.ok(children.every(t => t.session || t.run), 'child native runtime identity missing');
assert.ok(children.every(t => {
  const metadata = JSON.parse(t.metadata || '{}');
  return metadata.executor === 'ExecutionManager'
    && metadata.cwd === '/home/long/work/chatgpt-adapter'
    && ((t.role === 'architect' && metadata.command === 'node --check /home/long/work/chatgpt-adapter/server.js')
      || (t.role === 'qa' && metadata.command === 'node --check /home/long/work/chatgpt-adapter/test-tool-turn.js'));
}), 'typed child execution spec missing');
console.log('[E2E] Architect + QA native independent spawns PASS');

state = await waitFor(jobId, s => {
  const childRows = s.tasks.filter(t => ['architect', 'qa'].includes(String(t.role).toLowerCase()));
  return childRows.length === 2 && childRows.every(t =>
    ['completed', 'failed', 'cancelled'].includes(String(t.status).toLowerCase())
  );
}, 'children-terminal', 600000);

for (const child of children) {
  const durable = workflowStore.getTask(child.task_id);
  assert.equal(durable.execution_status, 'completed', `${child.role} missing ExecutionManager terminal status`);
  assert.equal(Number(durable.execution_exit_code), 0, `${child.role} durable execution exit != 0`);
  const result = state.results.find(r => r.task_id === child.task_id);
  assert.ok(result, `${child.role} missing durable result`);
  assert.match(result.content, /\[ACTUAL (?:TOOL RESULT|EXECUTION BATCH) EVIDENCE\]/i, `${child.role} missing actual evidence`);
}
console.log('[E2E] Architect + QA terminal with durable actual evidence PASS');

state = await waitFor(jobId,
  s => String(s.job?.state).toUpperCase() === 'COMPLETED'
    && String(s.runtime?.phase).toUpperCase() === 'COMPLETED',
  'job-terminal',
  900000);
assert.equal(state.runtime.phase, 'COMPLETED');
assert.ok(workflowStore.db.prepare('SELECT 1 FROM reports WHERE job_id=? LIMIT 1').get(jobId));
state = await waitFor(jobId, s => s.slack.pendingEvents === 0, 'slack-projection', 240000);
assert.equal(state.slack.pendingEvents, 0, `UNPROJECTED != 0: ${JSON.stringify(state.slack)}`);
console.log(JSON.stringify({ jobId, runtime: state.runtime, job: state.job, tasks: state.tasks, slack: state.slack }, null, 2));
console.log('run-v27-e2e: PASS');
