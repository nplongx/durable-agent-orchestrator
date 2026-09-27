import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowStore } from '../job-store.js';
import { RecoveryManager } from '../recovery-manager.js';

const execFileAsync = promisify(execFile);
const ADAPTER_URL = 'http://127.0.0.1:8318/v1/chat/completions';
const OPENCLAW = '/home/long/.config/nvm/versions/node/v24.21.0/bin/openclaw';
const DIRECTIVE = `Production E2E v27 ${randomUUID()}. First turn MUST be proposal only. After approval CTO must native sessions_spawn exactly two independent children in parallel: Architect runs the exact command node --check /home/long/work/chatgpt-adapter/server.js; QA runs the exact command node --check /home/long/work/chatgpt-adapter/test-tool-turn.js. Command paths are byte-exact: NEVER abbreviate /home/long/work/chatgpt-adapter as ~/work/chatgpt-adapter or any relative path. Children return actual command, output, exit status. CTO waits for both, synthesizes actual results, then completes Job. No prose-only success.`;
const TOOLS = [{ type: 'function', function: {
  name: 'sessions_spawn',
  description: 'Spawn a subagent for a task',
  parameters: { type: 'object', properties: { agentId: { type: 'string' }, task: { type: 'string' } }, required: ['agentId', 'task'] }
}}];

async function chat(messages) {
  const response = await fetch(ADAPTER_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt-coordinator', tools: TOOLS, stream: false, messages })
  });
  assert.equal(response.ok, true, `adapter HTTP ${response.status}`);
  return response.json();
}

async function runOpenClaw(sessionKey, message, timeoutSeconds = 180) {
  console.log(`[OpenClaw] session=${sessionKey} message=${message.slice(0, 180)}...`);
  try {
    const { stdout, stderr } = await execFileAsync(OPENCLAW, [
      'agent', '--agent', 'cto', '--session-key', sessionKey,
      '--message', message, '--json', '--timeout', String(timeoutSeconds)
    ], { timeout: (timeoutSeconds + 20) * 1000, maxBuffer: 10 * 1024 * 1024 });
    if (stderr.trim()) console.log('[OpenClaw stderr]', stderr.trim().slice(-4000));
    console.log('[OpenClaw stdout]', stdout.trim().slice(-12000));
    return stdout;
  } catch (error) {
    const stdout = String(error.stdout || '');
    if (
      stdout.includes('"status": "timeout"')
      || stdout.includes('"status":"timeout"')
      || error?.code === 143
      || error?.signal === 'SIGTERM'
    ) {
      console.warn(`[OpenClaw] provider timeout; preserving same session for durable recovery session=${sessionKey}`);
      return stdout;
    }
    throw error;
  }
}

function snapshot(jobId) {
  const job = workflowStore.getJob(jobId);
  const trace = workflowStore.getJobTrace(jobId);
  return {
    job,
    tasks: (trace?.tasks || []).map(t => ({ task_id: t.task_id, role: t.role, status: t.status, run: t.openclaw_run_id, session: t.openclaw_session_key })),
    results: (trace?.results || []).map(r => ({ task_id: r.task_id, outcome: r.outcome, content: r.content })),
    slack: workflowStore.getSlackProjection(jobId)
  };
}

async function waitFor(jobId, predicate, label, timeoutMs = 240000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const s = snapshot(jobId);
    const compact = JSON.stringify({ state: s.job?.state, status: s.job?.status, tasks: s.tasks.map(t => [t.role, t.status, t.session]) });
    if (compact !== last) { console.log(`[E2E:${label}] ${compact}`); last = compact; }
    if (predicate(s)) return s;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(snapshot(jobId))}`);
}

const base = { role: 'system', content: 'Runtime: name=Chief of Staff | agent=coordinator' };
const firstMessages = [base, { role: 'user', content: DIRECTIVE }];
const first = await chat(firstMessages);
const proposal = first.choices?.[0]?.message;
assert.ok(proposal, 'missing proposal');
assert.equal(Boolean(proposal.tool_calls?.some(x => x.function?.name === 'sessions_spawn')), false, 'proposal spawned');
console.log('[E2E] proposal-only PASS');

const secondMessages = [...firstMessages, proposal, { role: 'user', content: 'Duyệt proposal. Bắt đầu execution ngay.' }];
let second = await chat(secondMessages);
let approvalMessage = second.choices?.[0]?.message;
let spawn = approvalMessage?.tool_calls?.find(x => x.function?.name === 'sessions_spawn');
for (let retry = 0; !spawn && retry < 2; retry++) {
  console.warn('[E2E] approval turn returned no native spawn; retrying SAME approval turn once');
  second = await chat(secondMessages);
  approvalMessage = second.choices?.[0]?.message;
  spawn = approvalMessage?.tool_calls?.find(x => x.function?.name === 'sessions_spawn');
}
if (!spawn) {
  const approvalJobId = workflowStore.findJobIdFromMessages(secondMessages);
  const waitingJob = approvalJobId ? workflowStore.getJob(approvalJobId) : null;
  if (waitingJob?.provider_waiting && waitingJob.provider_retry_at) {
    const waitMs = Math.max(0, new Date(waitingJob.provider_retry_at).getTime() - Date.now()) + 1000;
    console.warn('[E2E] provider admission waiting; preserving SAME approval until cooldown expires');
    await new Promise(r => setTimeout(r, waitMs));
    second = await chat(secondMessages);
    approvalMessage = second.choices?.[0]?.message;
    spawn = approvalMessage?.tool_calls?.find(x => x.function?.name === 'sessions_spawn');
  }
}
assert.ok(spawn, 'approval did not produce native CTO sessions_spawn');
const spawnArgs = JSON.parse(spawn.function.arguments);
assert.equal(spawnArgs.agentId, 'cto');
const jobId = [...String(spawnArgs.task).matchAll(/Durable Job ID:\s*(job_[A-Za-z0-9-]+)/g)].at(-1)?.[1];
assert.ok(jobId, 'missing durable Job ID in CTO task');
console.log(`[E2E] approval/native CTO spawn PASS job=${jobId}`);

const pre = snapshot(jobId);
assert.equal(pre.job.state, 'EXECUTING');
assert.equal(pre.tasks.filter(t => t.role === 'cto').length, 1);

// This is the real OpenClaw execution boundary. The harness does NOT mutate
// workflow.db or manufacture child runtime IDs. OpenClaw owns sessions_spawn.
const ctoSessionKey = `agent:cto:subagent:${randomUUID()}`;
workflowStore.attachOpenClawRun(jobId, { runId: null, sessionKey: ctoSessionKey });
assert.equal(workflowStore.getTask(workflowStore.getJob(jobId).active_task_id).openclaw_session_key, ctoSessionKey);
await runOpenClaw(ctoSessionKey, spawnArgs.task, 180);

let state = await waitFor(jobId,
  s => s.tasks.some(t => t.role === 'architect') || s.tasks.some(t => t.role === 'qa') || ['completed','failed'].includes(s.job?.state),
  'children-created', 180000);

if (!state.tasks.some(t => String(t.role).toLowerCase() === 'qa')) {
  await runOpenClaw(ctoSessionKey,
    `Continue the SAME CTO session for Job ${jobId}. Architect has already been spawned. Do NOT wait for Architect and do NOT replace it. Immediately native sessions_spawn the independent QA child with this exact scope: run node --check /home/long/work/chatgpt-adapter/test-tool-turn.js and return exact command, stdout/stderr, and exit status. Both Architect and QA must run independently in parallel.`,
    180);
}

state = await waitFor(jobId,
  s => {
    const children = s.tasks.filter(t => ['architect','qa'].includes(String(t.role).toLowerCase()));
    return children.length >= 2 && children.every(t => ['completed','failed','cancelled'].includes(String(t.status).toLowerCase()));
  },
  'children-terminal', 300000);

const failedChildren = state.tasks.filter(t => ['architect','qa'].includes(String(t.role).toLowerCase()) && String(t.status).toLowerCase() === 'failed');
if (failedChildren.length) {
  const recovery = new RecoveryManager(workflowStore, { trajectoryTimeoutMs: 60_000 });
  for (const child of failedChildren) {
    console.log(`[E2E] same-task recovery retry role=${child.role} task=${child.task_id}`);
    const session = workflowStore.getSessionByTask(child.task_id);
    if (session && session.state !== 'ACTIVE') {
      workflowStore.grantSessionAccess(session.session_id, {
        accessorRole: 'cto',
        permission: 'TAKEOVER',
        grantedBy: 'recovery-policy',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      });
    }
    await recovery.retryAgentTask(child.task_id, {
      actorRole: 'cto',
      timeoutSeconds: 180,
      reason: 'Production E2E provider/runtime failure; retry SAME durable task/session'
    });
  }
  state = await waitFor(jobId,
    s => {
      const children = s.tasks.filter(t => ['architect','qa'].includes(String(t.role).toLowerCase()));
      return children.length >= 2 && children.every(t => ['completed','failed','cancelled'].includes(String(t.status).toLowerCase()));
    },
    'children-terminal-after-recovery', 300000);
}

const children = state.tasks.filter(t => ['architect','qa'].includes(String(t.role).toLowerCase()));
assert.equal(children.length, 2, `expected 2 required children, got ${JSON.stringify(children)}`);
for (const child of children) {
  assert.ok(child.session || child.run, `${child.role} missing OpenClaw runtime identity`);
  const durableTask = workflowStore.getTask(child.task_id);
  assert.equal(durableTask.execution_status, 'completed', `${child.role} missing ExecutionManager terminal status`);
  assert.equal(durableTask.execution_exit_code, 0, `${child.role} durable execution exit != 0`);
  const result = state.results.find(r => r.task_id === child.task_id);
  assert.ok(result, `${child.role} missing durable result`);
  assert.match(result.content, /\[ACTUAL TOOL RESULT EVIDENCE\]/i, `${child.role} missing actual evidence`);
}
console.log('[E2E] Architect + QA terminal with durable actual evidence PASS');

// Resume the SAME CTO session. No new CTO task/session is created.
await runOpenClaw(ctoSessionKey,
  `Continue the same Durable Job ${jobId}. Do not spawn replacement children. Read the current durable child state and actual results. Both required children have now reached terminal state. Synthesize their actual command/output/exit status and complete the Job only if the durable DoD allows it. Return the factual final result.`,
  180);

// Provider timeout is not itself a child failure. Reconcile the same CTO
// session against OpenClaw trajectory/runtime evidence before declaring E2E
// failure or success.
await new RecoveryManager(workflowStore, { trajectoryTimeoutMs: 60_000 }).reconcile({ jobId });

state = await waitFor(jobId,
  s => ['COMPLETED','FAILED','CANCELLED'].includes(String(s.job?.state).toUpperCase()) || ['success','failed'].includes(String(s.job?.status).toLowerCase()),
  'job-terminal', 180000);

console.log(JSON.stringify({
  jobId,
  job: state.job,
  tasks: state.tasks,
  results: state.results.map(r => ({ task_id: r.task_id, outcome: r.outcome, content: r.content })),
  slack: state.slack
}, null, 2));

assert.equal(String(state.job.state).toUpperCase(), 'COMPLETED', `Job not completed: ${state.job.state}/${state.job.status}`);
state = await waitFor(jobId, s => s.slack.pendingEvents === 0, 'slack-projection', 240000);
assert.equal(state.slack.pendingEvents, 0, `UNPROJECTED != 0: ${JSON.stringify(state.slack)}`);
console.log('run-v27-e2e: PASS');
