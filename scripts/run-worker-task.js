#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const required = ['JOB_ID', 'TASK_ID', 'LEASE_ID', 'ATTEMPT', 'INPUT_COMMIT', 'TASK_PAYLOAD_REF', 'PROVIDER_RUN_ID', 'EVIDENCE_DIR'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`missing worker environment: ${key}`);
}

const evidenceDir = path.resolve(process.env.EVIDENCE_DIR);
const payloadRef = process.env.TASK_PAYLOAD_REF;
const payloadPath = path.resolve(payloadRef);
const payloadRelative = path.relative(process.cwd(), payloadPath);
if (!payloadRelative || payloadRelative.startsWith('..') || path.isAbsolute(payloadRelative)) {
  throw new Error(`task payload must be inside the checked-out workspace: ${payloadRef}`);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isoNow() { return new Date().toISOString(); }

function safeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }

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

  const raw = await fs.readFile(payloadPath, 'utf8');
  const payload = JSON.parse(raw);
  await fs.writeFile(path.join(evidenceDir, 'task-payload.json'), safeJson(payload));

  const expected = {
    job_id: process.env.JOB_ID,
    task_id: process.env.TASK_ID,
    lease_id: process.env.LEASE_ID,
    attempt: Number(process.env.ATTEMPT)
  };
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) throw new Error(`payload correlation mismatch: ${key}`);
  }
  if (payload.role && payload.role !== process.env.ROLE) throw new Error('payload correlation mismatch: role');
  if (payload.schema_version !== 1) throw new Error(`unsupported task payload schema: ${payload.schema_version}`);
  if (!Array.isArray(payload.required_evidence) || payload.required_evidence.length === 0) {
    throw new Error('task payload required_evidence must be non-empty');
  }
  if (!payload.command && !(payload.executable && Array.isArray(payload.args))) {
    throw new Error('task payload must define command or structured executable/args');
  }

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
    deterministic: true,
    executor: 'ExecutionManager',
    ...(payload.command ? { command: payload.command } : {}),
    ...(payload.executable ? { executable: payload.executable, args: payload.args } : {}),
    ...(payload.cwd ? { cwd: payload.cwd } : {})
  };
  store.db.prepare('UPDATE tasks SET task_id = task_id, metadata_json = ? WHERE task_id = ?').run(JSON.stringify(metadata), task.task_id);

  const manager = new ExecutionManager(store, {
    timeoutMs: Math.max(1000, Number(payload.timeout_ms) || Number(process.env.EXECUTION_TIMEOUT_MS) || 120000)
  });
  const execution = await manager.executeAuthorizedTask(task.task_id, {
    cwd: payload.cwd ? path.resolve(payload.cwd) : process.cwd()
  });

  await fs.writeFile(path.join(evidenceDir, 'stdout.txt'), execution.stdout || '');
  await fs.writeFile(path.join(evidenceDir, 'stderr.txt'), execution.stderr || '');
  await fs.writeFile(path.join(evidenceDir, 'git-status.txt'), `${git(['status', '--short'])}\n`);
  await fs.writeFile(path.join(evidenceDir, 'execution.json'), safeJson({
    task_id: process.env.TASK_ID,
    execution_session_id: execution.execution_session_id || null,
    exit_code: execution.exitCode,
    timed_out: Boolean(execution.timedOut),
    stdout_bytes: Buffer.byteLength(execution.stdout || ''),
    stderr_bytes: Buffer.byteLength(execution.stderr || '')
  }));

  const outputCommit = git(['rev-parse', 'HEAD']);
  const status = execution.timedOut ? 'TIMED_OUT' : execution.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
  resultBase.status = status;
  resultBase.output_commit = outputCommit;
  resultBase.exit_code = execution.exitCode == null ? null : Number(execution.exitCode);
  resultBase.evidence_refs = ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'];
  resultBase.finished_at = isoNow();
  if (status !== 'SUCCEEDED') resultBase.error = execution.timedOut ? 'execution timeout' : `exit status ${execution.exitCode}`;
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
