#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-m11-runner-'));
const db = path.join(temp, 'workflow.db');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 2000);
const env = {
  ...process.env,
  PORT: String(port),
  HTTP_HOST: '127.0.0.1',
  WORKFLOW_DB: db,
  WORKFLOW_DATA_DIR: temp,
  WORKFLOW_WORKSPACE: workspace,
  WORKFLOW_INPUT_COMMIT: process.env.M11_INPUT_COMMIT || '0123456789abcdef0123456789abcdef01234567',
  LANGGRAPH_ORCHESTRATOR: 'active',
  WORKFLOW_WORKER_PROVIDER: 'mock',
  M11_RUNNER_MODE: 'mock',
  M11_RUNNER_ID: 'm11-runner-1',
  SLACK_PROJECTION_GLOBAL: 'false',
  SESSION_TRANSPORT: 'shadow',
  ACCOUNT_COUNT: '0'
};

const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = ''; let stderr = '';
child.stdout.on('data', b => { stdout += b.toString(); });
child.stderr.on('data', b => { stderr += b.toString(); });

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`M11 adapter health timeout\n${stderr.slice(-4000)}`);
}

async function chat(messages) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-role': 'cto' },
    body: JSON.stringify({ model: 'chatgpt-cto', messages, stream: false, metadata: { agentRole: 'cto' } })
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}

async function trace(jobId) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/workflow/jobs/${encodeURIComponent(jobId)}/trace`);
  assert.equal(r.status, 200);
  return r.json();
}

async function waitForTrace(jobId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await trace(jobId);
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`M11 trace timeout for ${jobId}\n${JSON.stringify(last, null, 2)}\nserver stderr:\n${stderr.slice(-5000)}`);
}

try {
  await waitForHealth();
  const directive = 'Software development M11 runner-owned native E2E. Validate the durable standard-engineering workflow with product-owner, researcher, architect, engineer, security, qa, platform, writer, reviewer, then CTO synthesis. Local adapter must never create specialist OpenClaw sessions; GitHub Runner owns task execution.';
  const proposal = await chat([{ role: 'user', content: directive }]);
  assert.match(proposal.choices?.[0]?.message?.content || '', /proposal recorded/i);
  let first = await fetch(`http://127.0.0.1:${port}/v1/workflow/jobs?limit=10`).then(r => r.json());
  const job = first.jobs?.find(j => /software development m11 runner-owned/i.test(j.title || '')) || first[0];
  assert.ok(job?.job_id, 'M11 proposal must create a durable job');
  const jobId = job.job_id;
  console.log(`[M11] proposal job=${jobId}`);

  await chat([{ role: 'user', content: `Duyệt Job ${jobId}. Bắt đầu execution ngay.` }]);
  await waitForTrace(jobId, state => state.job?.state === 'EXECUTING');
  const completed = await waitForTrace(jobId, state => state.job?.state === 'COMPLETED', 90_000);

  const expectedRoles = ['cto', 'product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'];
  const tasks = completed.tasks || [];
  assert.deepEqual(tasks.map(t => t.role), expectedRoles, 'M11 must produce exactly the 9-agent DAG plus CTO synthesis');
  assert.ok(tasks.every(t => t.status === 'completed'), 'all M11 tasks must complete');
  assert.ok(tasks.every(t => !t.openclaw_session_key && !t.openclaw_run_id), 'M11 must not create local OpenClaw specialist sessions/runs');
  assert.ok(tasks.every(t => JSON.parse(t.metadata_json || '{}').runtime_owner === 'github-runner'), 'all M11 agent tasks must be runner-owned');
  assert.equal(completed.artifacts?.length || 0, 10, 'M11 must persist all 10 durable artifacts including CTO decision');
  const types = new Set((completed.artifacts || []).map(a => a.type || a.kind));
  for (const type of ['requirements', 'research', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation', 'review', 'cto-decision']) assert.ok(types.has(type), `missing artifact ${type}`);

  const verified = completed.events.filter(e => e.type === 'task.execution.verified').length;
  const dispatched = completed.events.filter(e => e.type === 'workflow.runner_task_dispatched').length;
  const leased = completed.events.filter(e => e.type === 'task.lease.completed').length;
  assert.equal(verified, 10);
  assert.equal(dispatched, 10);
  assert.equal(leased, 10);

  console.log('M11 NATIVE RUNNER E2E PASS');
  console.log(`job=${jobId}`);
  console.log(`tasks=${tasks.length} artifacts=${completed.artifacts.length} runnerDispatches=${dispatched}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  if (child.exitCode && child.exitCode !== 0) {
    console.error(stdout.slice(-5000));
    console.error(stderr.slice(-5000));
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
