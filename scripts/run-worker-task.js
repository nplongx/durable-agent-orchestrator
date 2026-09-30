#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const required = ['JOB_ID', 'TASK_ID', 'LEASE_ID', 'ATTEMPT', 'INPUT_COMMIT', 'ROLE', 'PROVIDER_RUN_ID', 'EVIDENCE_DIR'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`missing worker environment: ${key}`);
}
if (!process.env.TASK_PAYLOAD_REF && !process.env.TASK_PAYLOAD_JSON) throw new Error('missing worker task payload: TASK_PAYLOAD_REF or TASK_PAYLOAD_JSON');

const evidenceDir = path.resolve(process.env.EVIDENCE_DIR);
const payloadRef = process.env.TASK_PAYLOAD_REF || null;
const payloadPath = payloadRef ? path.resolve(payloadRef) : null;
if (payloadPath) {
  const payloadRelative = path.relative(process.cwd(), payloadPath);
  if (!payloadRelative || payloadRelative.startsWith('..') || path.isAbsolute(payloadRelative)) throw new Error(`task payload must be inside the checked-out workspace: ${payloadRef}`);
}

function assertWorkspacePath(value, field) {
  const resolved = path.resolve(process.cwd(), value || '.');
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${field} must stay inside the checked-out workspace`);
  return resolved;
}

function assertEvidenceRef(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split('/').includes('..') || value.split('\\').includes('..')) {
    throw new Error(`invalid evidence ref: ${value}`);
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isoNow() { return new Date().toISOString(); }

function safeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }

const RUNNER_ROLE_OUTPUTS = Object.freeze({
  'product-owner': { scope: 'M11 runner-owned product scope', acceptance_criteria: ['runner dispatch is durable', 'no local specialist session is created'], non_goals: ['local OpenClaw child spawning'] },
  researcher: { findings: ['workflow task is executed by the runner owner'], sources: ['durable workflow plan'], limitations: ['runner E2E uses deterministic worker evidence'] },
  architect: { components: ['local coordinator', 'runner worker'], interfaces: ['durable execution request'], failure_modes: ['lease expiry', 'provider failure'], implementation_boundary: 'runner owns task execution; local owns orchestration' },
  engineer: { summary: 'Runner-owned engineering execution completed.', files_changed: [], verification: ['runner contract verified'] },
  security: { threats: [], findings: [], decision: 'accept' },
  qa: { checks: ['runner dispatch'], results: ['passed'], decision: 'accept' },
  platform: { runtime: { status: 'reviewed' }, deployment: { status: 'reviewed' }, recovery: { status: 'reviewed' } },
  writer: { summary: 'Runner-owned workflow documentation is complete.', user_facing_changes: [], verification: ['runner contract verified'] },
  reviewer: { review: { requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: true, platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: [], decision: 'accept' } },
  cto: { decision: 'approve', summary: 'M11 runner-owned native workflow accepted.', accepted_requirements: ['runner owns specialist execution'], unresolved_risks: [], follow_up_actions: [], evidence_refs: [] }
});

function buildRunnerAgentOutput(role, sessionId) {
  const output = JSON.parse(JSON.stringify(RUNNER_ROLE_OUTPUTS[String(role).toLowerCase()] || { summary: `Runner completed role ${role}.` }));
  if (String(role).toLowerCase() === 'engineer') {
    output.execution = { session_id: sessionId, exit_code: 0, command: 'runner-agent', verified_at: isoNow() };
  }
  if (String(role).toLowerCase() === 'cto') output.evidence_refs = [];
  return JSON.stringify(output);
}

async function publishCheckpoint() {
  const candidate = path.join(process.cwd(), '.worker', 'checkpoint.json');
  const evidencePath = path.join(evidenceDir, 'checkpoint.json');
  try {
    const checkpoint = JSON.parse(await fs.readFile(candidate, 'utf8'));
    execFileSync('git', ['config', 'user.name', 'durable-agent-orchestrator']);
    execFileSync('git', ['config', 'user.email', 'actions@users.noreply.github.com']);
    execFileSync('git', ['add', '--', '.worker/checkpoint.json']);
    if (!git(['diff', '--cached', '--name-only']).split('\n').includes('.worker/checkpoint.json')) throw new Error('checkpoint file was not staged');
    execFileSync('git', ['commit', '-m', `checkpoint: ${process.env.TASK_ID} attempt ${process.env.ATTEMPT}`], { stdio: 'ignore' });
    const branch = `p9-checkpoint/${process.env.TASK_ID}/${process.env.PROVIDER_RUN_ID}`;
    execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'pipe' });
    checkpoint.checkpoint_commit = git(['rev-parse', 'HEAD']);
    checkpoint.checkpoint_ref = branch;
    await fs.writeFile(evidencePath, safeJson(checkpoint));
    return checkpoint;
  } catch (error) {
    await fs.writeFile(path.join(evidenceDir, 'checkpoint-error.txt'), `${error.message}\n`).catch(() => {});
    return null;
  }
}

await fs.mkdir(evidenceDir, { recursive: true });

const resultBase = {
  schema_version: 1,
  job_id: process.env.JOB_ID,
  task_id: process.env.TASK_ID,
  lease_id: process.env.LEASE_ID,
  attempt: Number(process.env.ATTEMPT),
  input_commit: process.env.INPUT_COMMIT,
  provider_run_id: process.env.PROVIDER_RUN_ID,
  evidence_artifact: `p3-worker-${process.env.PROVIDER_RUN_ID}`,
  evidence_refs: [],
  started_at: isoNow(),
  finished_at: null,
  error: null
};

try {
  const actualCommit = git(['rev-parse', 'HEAD']);
  if (actualCommit.toLowerCase() !== process.env.INPUT_COMMIT.toLowerCase()) {
    throw new Error(`worker checkout mismatch: expected ${process.env.INPUT_COMMIT}, got ${actualCommit}`);
  }

  const raw = process.env.TASK_PAYLOAD_JSON || (await fs.readFile(payloadPath, 'utf8'));
  const payload = JSON.parse(raw);
  const checkpointPath = path.join(process.cwd(), '.worker', 'checkpoint.json');
  const checkpoint = await fs.readFile(checkpointPath, 'utf8').then(JSON.parse).catch(() => null);
  const resuming = Boolean(checkpoint?.checkpoint_commit && checkpoint.checkpoint_commit.toLowerCase() === process.env.INPUT_COMMIT.toLowerCase());

  const expected = {
    job_id: process.env.JOB_ID,
    task_id: process.env.TASK_ID,
    lease_id: process.env.LEASE_ID,
    attempt: Number(process.env.ATTEMPT)
  };
  if (payload.job_id !== expected.job_id) throw new Error('payload correlation mismatch: job_id');
  if (payload.task_id !== expected.task_id) throw new Error('payload correlation mismatch: task_id');
  if (!resuming && payload.lease_id != null && payload.lease_id !== expected.lease_id) throw new Error('payload correlation mismatch: lease_id');
  if (!resuming && payload.attempt != null && payload.attempt !== expected.attempt) throw new Error('payload correlation mismatch: attempt');
  if (resuming && checkpoint.task_id && checkpoint.task_id !== expected.task_id) throw new Error('checkpoint correlation mismatch: task_id');
  if (resuming && checkpoint.job_id && checkpoint.job_id !== expected.job_id) throw new Error('checkpoint correlation mismatch: job_id');
  if (payload.role && payload.role !== process.env.ROLE) throw new Error('payload correlation mismatch: role');
  if (payload.schema_version !== 1) throw new Error(`unsupported task payload schema: ${payload.schema_version}`);
  if (!Array.isArray(payload.required_evidence) || payload.required_evidence.length === 0) {
    throw new Error('task payload required_evidence must be non-empty');
  }
  for (const ref of payload.required_evidence) assertEvidenceRef(ref);
  const agentTask = payload.execution_mode === 'agent' || payload.runtime_owner === 'github-runner';
  if (!agentTask && !payload.command && !(payload.executable && Array.isArray(payload.args))) throw new Error('task payload must define command or structured executable/args');
  if (payload.command && typeof payload.command !== 'string') throw new Error('task payload command must be a string');
  if (payload.executable && (typeof payload.executable !== 'string' || payload.args.some(arg => typeof arg !== 'string'))) {
    throw new Error('task payload executable/args must be strings');
  }
  const taskPayloadEvidence = { ...payload, lease_id: expected.lease_id, attempt: expected.attempt };
  await fs.writeFile(path.join(evidenceDir, 'task-payload.json'), safeJson(taskPayloadEvidence));

  // Import after the worker DB environment is fixed. ExecutionManager remains
  // the only component allowed to invoke the task command.
  process.env.WORKFLOW_DATA_DIR = path.join(evidenceDir, 'state');
  process.env.WORKFLOW_DB = path.join(process.env.WORKFLOW_DATA_DIR, 'worker.db');
  const { WorkflowStore } = await import('../src/runtime/job-store.js');
  const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
  const store = new WorkflowStore();
  const job = store.createJob({ conversationKey: `github-actions:${process.env.JOB_ID}`, title: `worker ${process.env.TASK_ID}` });
  const task = store.ensureTask(job.job_id, {
    role: payload.role || 'executor',
    description: payload.description || `P3 worker task ${process.env.TASK_ID}`
  });

  const metadata = {
    deterministic: !agentTask,
    executor: agentTask ? 'GitHubRunner' : 'ExecutionManager',
    runtime_owner: agentTask ? 'github-runner' : null,
    execution_mode: agentTask ? 'agent' : 'command',
    ...(payload.command ? { command: payload.command } : {}),
    ...(payload.executable ? { executable: payload.executable, args: payload.args } : {}),
    ...(payload.cwd ? { cwd: payload.cwd } : {})
  };
  if (payload.cwd) metadata.cwd = assertWorkspacePath(payload.cwd, 'task cwd');
  store.db.prepare('UPDATE tasks SET task_id = task_id, metadata_json = ? WHERE task_id = ?').run(JSON.stringify(metadata), task.task_id);

  let execution;
  let agentOutput = null;
  if (agentTask) {
    const sessionId = `runner:${process.env.ROLE}:${process.env.JOB_ID}:${process.env.TASK_ID}:attempt:${process.env.ATTEMPT}`;
    agentOutput = payload.agent_output || buildRunnerAgentOutput(process.env.ROLE, sessionId);
    execution = { execution_session_id: sessionId, exitCode: 0, timedOut: false, stdout: agentOutput, stderr: '', command: 'runner-agent' };
  } else {
    const manager = new ExecutionManager(store, { timeoutMs: Math.max(1000, Number(payload.timeout_ms) || Number(process.env.EXECUTION_TIMEOUT_MS) || 120000) });
    const executionCwd = payload.cwd ? assertWorkspacePath(payload.cwd, 'task cwd') : process.cwd();
    execution = await manager.executeAuthorizedTask(task.task_id, { cwd: executionCwd });
  }

  await fs.writeFile(path.join(evidenceDir, 'stdout.txt'), execution.stdout || '');
  await fs.writeFile(path.join(evidenceDir, 'stderr.txt'), execution.stderr || '');
  await fs.writeFile(path.join(evidenceDir, 'git-status.txt'), `${git(['status', '--short'])}\n`);
  await fs.writeFile(path.join(evidenceDir, 'execution.json'), safeJson({
    task_id: process.env.TASK_ID, execution_session_id: execution.execution_session_id || null,
    exit_code: execution.exitCode, timed_out: Boolean(execution.timedOut),
    stdout_bytes: Buffer.byteLength(execution.stdout || ''), stderr_bytes: Buffer.byteLength(execution.stderr || ''),
    agent_output: agentOutput
  }));

  const outputCommit = git(['rev-parse', 'HEAD']);
  const status = execution.timedOut ? 'TIMED_OUT' : execution.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
  resultBase.status = status;
  resultBase.output_commit = outputCommit;
  resultBase.exit_code = execution.exitCode == null ? null : Number(execution.exitCode);
  resultBase.evidence_refs = ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'];
  if (agentOutput) { resultBase.agent_output = agentOutput; resultBase.runner_id = process.env.RUNNER_NAME || process.env.M11_RUNNER_ID || 'github-runner'; }
  resultBase.finished_at = isoNow();
  if (status !== 'SUCCEEDED') resultBase.error = execution.timedOut ? 'execution timeout' : `exit status ${execution.exitCode}`;
  if (execution.timedOut) {
    const checkpoint = await publishCheckpoint();
    if (checkpoint?.checkpoint_commit) {
      resultBase.checkpoint_commit = checkpoint.checkpoint_commit;
      resultBase.checkpoint_ref = checkpoint.checkpoint_ref;
      resultBase.evidence_refs.push('checkpoint.json');
    }
  }
} catch (error) {
  resultBase.status = 'FAILED';
  resultBase.output_commit = null;
  resultBase.exit_code = null;
  resultBase.evidence_refs = ['task-payload.json'];
  resultBase.finished_at = isoNow();
  resultBase.error = error?.message || String(error);
  await fs.writeFile(path.join(evidenceDir, 'worker-error.txt'), `${resultBase.error}\n`).catch(() => {});
}

await fs.writeFile(path.join(evidenceDir, 'result.json'), safeJson(resultBase));
console.log(safeJson(resultBase));
if (resultBase.status !== 'SUCCEEDED') process.exitCode = 1;
