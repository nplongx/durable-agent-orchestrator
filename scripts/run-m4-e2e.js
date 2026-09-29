import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowStore } from '../job-store.js';

const execFileAsync = promisify(execFile);
const OPENCLAW = process.env.OPENCLAW_BIN || '/home/long/.config/nvm/versions/node/v24.21.0/bin/openclaw';
const NATIVE_GATEWAY_TIMEOUT_MS = Math.max(30_000, Number(process.env.OPENCLAW_NATIVE_GATEWAY_TIMEOUT_MS) || 180_000);
const NATIVE_GATEWAY_PROCESS_TIMEOUT_MS = NATIVE_GATEWAY_TIMEOUT_MS + 15_000;
const NATIVE_GATEWAY_OBSERVER_TIMEOUT_MS = Math.max(15_000, Number(process.env.OPENCLAW_NATIVE_GATEWAY_OBSERVER_TIMEOUT_MS) || 30_000);
const NATIVE_GATEWAY_OBSERVER_PROCESS_TIMEOUT_MS = NATIVE_GATEWAY_OBSERVER_TIMEOUT_MS + 10_000;
const SESSION_KEY = `m4-e2e-${randomUUID()}`;
const E2E_ID = randomUUID();
const DIRECTIVE = `Engineering M4 E2E ${E2E_ID}. First turn MUST be proposal only. After approval, LangGraph owns workflow control. Required specialists are Architect, Engineer, QA, Reviewer in dependency order. Scope: make one minimal workspace change by creating .m4-engineer-proof.js exporting m4EngineerProof=true; Engineer must make that exact change through the authorized ExecutionManager command; QA must verify the resulting file with the authorized ExecutionManager command; Architect must return an architecture artifact describing this change, boundaries, and verification contract; Reviewer must return only the required JSON review artifact using actual durable evidence from Architect, Engineer, and QA. CTO only synthesizes evidence and must not orchestrate. No agents_wait, no self-spawn, no prose-only success.`;
let nativeSessionCreated = false;

async function openclaw(message, timeoutSeconds = 900) {
  const method = nativeSessionCreated ? 'sessions.send' : 'sessions.create';
  const params = method === 'sessions.create'
  ? { key: SESSION_KEY, agentId: 'cto', message }
    : { key: SESSION_KEY, agentId: 'cto', message, idempotencyKey: `${SESSION_KEY}:send:${Date.now()}` };
  const rpcTimeoutMs = NATIVE_GATEWAY_TIMEOUT_MS;
  const processTimeoutMs = NATIVE_GATEWAY_PROCESS_TIMEOUT_MS;
  console.log(`[M4-E2E:native-call] ${method} rpcTimeout=${rpcTimeoutMs}ms processTimeout=${processTimeoutMs}ms`);
  const { stdout, stderr } = await execFileAsync(
    OPENCLAW,
    ['gateway', 'call', method, '--timeout', String(rpcTimeoutMs), '--params', JSON.stringify(params)],
    { timeout: processTimeoutMs, maxBuffer: 20 * 1024 * 1024 }
  );
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`invalid ${method} response: ${stderr || stdout}`);
  const payload = JSON.parse(stdout.slice(start));
  if (method === 'sessions.create' && !payload?.ok) throw new Error(`${method} rejected: ${JSON.stringify(payload)}`);
  if (method === 'sessions.send' && payload?.status !== 'started' && !payload?.ok) throw new Error(`${method} rejected: ${JSON.stringify(payload)}`);
  nativeSessionCreated = true;
  return payload;
}

async function waitForNativeTurnIdle(timeoutMs = 300000) {
  const started = Date.now();
  let lastUpdatedAt = null;
  let stableSince = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const { stdout } = await execFileAsync(
        OPENCLAW,
        ['gateway', 'call', 'sessions.describe', '--timeout', String(NATIVE_GATEWAY_OBSERVER_TIMEOUT_MS), '--params', JSON.stringify({ key: `agent:cto:${SESSION_KEY}` })],
        { timeout: NATIVE_GATEWAY_OBSERVER_PROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
      );
      const start = stdout.indexOf('{');
      if (start >= 0) {
        const payload = JSON.parse(stdout.slice(start));
        const session = payload.session || payload;
        if (session && session.status !== 'running' && session.hasActiveRun !== true) return session;
        const updatedAt = Number(session?.updatedAt || 0);
        if (updatedAt && updatedAt === lastUpdatedAt) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= 10_000 && Number(session?.messageCount || 0) >= 2) return session;
        } else {
          lastUpdatedAt = updatedAt;
          stableSince = Date.now();
        }
      }
    } catch (error) {
      console.log(`[M4-E2E:native-observation-retry] sessions.describe failed: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`timeout waiting for native proposal turn to finish: ${SESSION_KEY}`);
}

function snapshot(jobId) {
  const job = workflowStore.getJob(jobId);
  const runtime = workflowStore.getWorkflowRuntimeState(jobId);
  const trace = workflowStore.getJobTrace(jobId);
  return {
    job, runtime,
    tasks: (trace?.tasks || []).map(t => ({ task_id: t.task_id, role: t.role, status: t.status, run: t.openclaw_run_id, session: t.openclaw_session_key, execution_status: t.execution_status, execution_exit_code: t.execution_exit_code, metadata: t.metadata_json })),
    results: (trace?.results || []).map(r => ({ task_id: r.task_id, outcome: r.outcome, content: r.content })),
    slack: workflowStore.getSlackProjection(jobId)
  };
}

async function waitFor(jobId, predicate, label, timeoutMs = 900000) {
  const started = Date.now(); let last = '';
  while (Date.now() - started < timeoutMs) {
    const state = snapshot(jobId);
    const compact = JSON.stringify({ state: state.job?.state, phase: state.runtime?.phase, tasks: state.tasks.map(t => [t.role, t.status, t.execution_status, t.execution_exit_code]) });
    if (compact !== last) { console.log(`[M4-E2E:${label}] ${compact}`); last = compact; }
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(snapshot(jobId))}`);
}

await openclaw(DIRECTIVE);
const startedAt = Date.now();
let jobId = null;
while (Date.now() - startedAt < 120000 && !jobId) {
  jobId = workflowStore.db.prepare('SELECT job_id FROM jobs WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1').get(`%${E2E_ID}%`)?.job_id || null;
  if (!jobId) await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(jobId, `durable Job not created for E2E_ID=${E2E_ID}`);
let state = await waitFor(jobId, s => s.runtime?.phase === 'PROPOSED' && s.job?.state === 'PROPOSED', 'proposal-durable', 120000);
assert.equal(state.tasks.some(t => t.role === 'cto' && t.session), false);
console.log(`[E2E] proposal-only PASS job=${jobId}`);

await waitForNativeTurnIdle();
await openclaw(`Duyệt Job ${jobId}. Bắt đầu Engineering M4 execution ngay.`);
state = await waitFor(jobId, s => s.job?.state === 'EXECUTING' && s.tasks.find(t => t.role === 'cto')?.session, 'approval-native-cto', 600000);
assert.equal(state.job.state, 'EXECUTING');
assert.ok(state.tasks.find(t => t.role === 'cto')?.session);

state = await waitFor(jobId, s => {
  const children = s.tasks.filter(t => ['architect', 'engineer', 'qa', 'reviewer'].includes(String(t.role).toLowerCase()));
  return children.length === 4;
}, 'native-specialists', 900000);
const children = state.tasks.filter(t => ['architect', 'engineer', 'qa', 'reviewer'].includes(String(t.role).toLowerCase()));
assert.equal(children.length, 4);
assert.deepEqual(new Set(children.map(t => t.role.toLowerCase())), new Set(['architect', 'engineer', 'qa', 'reviewer']));
for (const child of children) {
  const metadata = JSON.parse(child.metadata || '{}');
  assert.ok(['architecture.design', 'code.modify', 'code.verify', 'change.review'].includes(metadata.capability));
}
console.log('[E2E] four specialists materialized PASS');

state = await waitFor(jobId, s => s.tasks.filter(t => ['architect', 'engineer', 'qa', 'reviewer'].includes(String(t.role).toLowerCase())).every(t => ['completed', 'failed', 'cancelled'].includes(String(t.status).toLowerCase())), 'specialists-terminal', 900000);
const terminalChildren = state.tasks.filter(t => ['architect', 'engineer', 'qa', 'reviewer'].includes(String(t.role).toLowerCase()));
assert.ok(terminalChildren.every(t => t.status === 'completed'), JSON.stringify(terminalChildren));
for (const child of terminalChildren.filter(t => ['engineer', 'qa'].includes(String(t.role).toLowerCase()))) {
  assert.equal(child.execution_status, 'completed', `${child.role} missing ExecutionManager terminal status`);
  assert.equal(Number(child.execution_exit_code), 0, `${child.role} exit != 0`);
  const result = state.results.find(r => r.task_id === child.task_id);
  assert.ok(result);
  assert.match(result.content, /\[ACTUAL (?:TOOL RESULT|EXECUTION BATCH) EVIDENCE\]/i);
}
const reviewer = terminalChildren.find(t => t.role === 'reviewer');
const reviewerResult = state.results.find(r => r.task_id === reviewer.task_id);
assert.ok(reviewerResult);
const review = JSON.parse(reviewerResult.content.trim());
assert.equal(review.review.requirementsSatisfied, true);
assert.equal(review.review.architectureConformant, true);
assert.deepEqual(review.review.blockingIssues, []);
console.log('[E2E] durable execution evidence + reviewer artifact PASS');

state = await waitFor(jobId, s => s.job?.state === 'COMPLETED' && s.runtime?.phase === 'COMPLETED', 'job-terminal', 900000);
assert.ok(workflowStore.db.prepare('SELECT 1 FROM reports WHERE job_id=? LIMIT 1').get(jobId));
if (String(process.env.SLACK_PROJECTION_GLOBAL || '').toLowerCase() === 'true') {
  state = await waitFor(jobId, s => s.slack.pendingEvents === 0, 'slack-projection', 240000);
  assert.equal(state.slack.pendingEvents, 0);
} else {
  console.log(`[E2E] Slack projection disabled; pendingEvents=${state.slack.pendingEvents} not an acceptance gate`);
}
console.log(JSON.stringify({ jobId, runtime: state.runtime, tasks: state.tasks, slack: state.slack }, null, 2));
console.log('run-m4-e2e: PASS');
