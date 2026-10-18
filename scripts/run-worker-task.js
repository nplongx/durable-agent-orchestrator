#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { openDirectoryWithin, readFileWithin, resolveWithinRoot, writeFileAtDirectory } from '../src/runtime/secure-filesystem.js';

const required = ['JOB_ID', 'TASK_ID', 'LEASE_ID', 'ATTEMPT', 'OWNER_EPOCH', 'INPUT_COMMIT', 'ROLE', 'PROVIDER_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'EVIDENCE_DIR'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`missing worker environment: ${key}`);
}
if (!process.env.TASK_PAYLOAD_REF && !process.env.TASK_PAYLOAD_JSON) throw new Error('missing worker task payload: TASK_PAYLOAD_REF or TASK_PAYLOAD_JSON');

function canonicalPositiveSafeIntegerEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive safe integer in canonical decimal form`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${name} must be a positive safe integer in canonical decimal form`);
  }
  return parsed;
}
// Attempt identifiers are part of the durable task/provider-run identity.
// Do not let Number() silently normalize values such as "01", "1.0", or an
// unsafe integer before payload correlation and result evidence are recorded.
const attempt = canonicalPositiveSafeIntegerEnv('ATTEMPT');
const providerRunAttempt = canonicalPositiveSafeIntegerEnv('GITHUB_RUN_ATTEMPT');

const workspaceRoot = process.cwd();
const evidenceDir = path.resolve(process.env.EVIDENCE_DIR);
if (evidenceDir === path.parse(evidenceDir).root) throw new Error('EVIDENCE_DIR must not be a filesystem root');
const evidenceDirectory = openDirectoryWithin(path.parse(evidenceDir).root, evidenceDir, { create: true, mode: 0o700 });
const writtenEvidenceFiles = new Set();
const writeEvidenceFile = (name, contents) => {
  writeFileAtDirectory(evidenceDirectory.fd, name, contents, { mode: 0o600 });
  writtenEvidenceFiles.add(name);
};
const RUNNER_AGENT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUNNER_AGENT_PROTECTED_ENV = new Set([
  'PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'SHELLOPTS', 'BASHOPTS',
  'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
  'ELECTRON_RUN_AS_NODE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'NPM_CONFIG_NODE_OPTIONS',
  'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL', 'RUNNER_TRACKING_ID'
]);
const ownerEpoch = Number(process.env.OWNER_EPOCH);
if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || String(ownerEpoch) !== process.env.OWNER_EPOCH) {
  throw new Error('OWNER_EPOCH must be a positive safe integer in canonical decimal form');
}
const payloadRef = process.env.TASK_PAYLOAD_REF || null;
const payloadPath = payloadRef ? resolveWithinRoot(workspaceRoot, payloadRef, 'TASK_PAYLOAD_REF') : null;
if (payloadPath) {
  if (payloadPath === resolveWithinRoot(workspaceRoot, '.', 'workspace root')) {
    throw new Error('task payload must name a file inside the checked-out workspace');
  }
}

function assertWorkspacePath(value, field) {
  const resolved = resolveWithinRoot(workspaceRoot, value || '.', field);
  const directory = openDirectoryWithin(workspaceRoot, resolved);
  directory.close();
  return resolved;
}

function assertEvidenceRef(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.startsWith('-') || /^[a-zA-Z]:/.test(value) || value.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid evidence ref: ${value}`);
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isoNow() { return new Date().toISOString(); }

function safeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }

async function runExternalRunnerAgent({ payload, sessionId, evidenceDir }) {
  const command = String(process.env.RUNNER_AGENT_COMMAND || '').trim();
  if (!command) throw new Error('production runner agent is not configured: RUNNER_AGENT_COMMAND is required');
  if (!path.isAbsolute(command) || command.includes('\0')) {
    throw new Error('RUNNER_AGENT_COMMAND must be an absolute executable path');
  }
  const commandStat = fs.lstatSync(command);
  if (!commandStat.isFile() || commandStat.isSymbolicLink() || fs.realpathSync(command) !== command || (commandStat.mode & 0o111) === 0) {
    throw new Error('RUNNER_AGENT_COMMAND must be a canonical regular executable, not a symlink or non-executable file');
  }
  let args = [];
  if (process.env.RUNNER_AGENT_ARGS_JSON) {
    try { args = parseStrictJson(process.env.RUNNER_AGENT_ARGS_JSON, 'RUNNER_AGENT_ARGS_JSON'); } catch (error) {
      throw new Error(`RUNNER_AGENT_ARGS_JSON must be a JSON array: ${error.message}`);
    }
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('RUNNER_AGENT_ARGS_JSON must be an array of strings');
  }
  const allowlistText = process.env.RUNNER_AGENT_ENV_ALLOWLIST || '';
  const allowlist = allowlistText ? allowlistText.split(',').map(value => value.trim()) : [];
  if (allowlist.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) || new Set(allowlist).size !== allowlist.length) {
    throw new Error('RUNNER_AGENT_ENV_ALLOWLIST must be a comma-separated list of unique environment variable names');
  }
  const agentEnv = {
    PATH: [...new Set([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(':'),
    HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8'
  };
  for (const name of allowlist) {
    const upperName = name.toUpperCase();
    if (RUNNER_AGENT_PROTECTED_ENV.has(upperName) || upperName.startsWith('GITHUB_') || upperName.startsWith('ACTIONS_') ||
        upperName.startsWith('GIT_CONFIG_KEY_') || upperName.startsWith('GIT_CONFIG_VALUE_')) {
      throw new Error(`RUNNER_AGENT_ENV_ALLOWLIST cannot expose protected runtime/control-plane variable ${name}`);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, name) || process.env[name] === undefined || process.env[name].includes('\0')) {
      throw new Error(`RUNNER_AGENT_ENV_ALLOWLIST names an unavailable environment variable: ${name}`);
    }
    agentEnv[name] = process.env[name];
  }
  const payloadFile = path.join(evidenceDir, 'runner-agent-input.json');
  writeEvidenceFile('runner-agent-input.json', safeJson({ payload, session_id: sessionId }));
  const suppliedTimeout = process.env.RUNNER_AGENT_TIMEOUT_MS === undefined ? null : Number(process.env.RUNNER_AGENT_TIMEOUT_MS);
  if (suppliedTimeout !== null && (!Number.isSafeInteger(suppliedTimeout) || suppliedTimeout < 1000 || suppliedTimeout > 25 * 60 * 1000)) {
    throw new Error('RUNNER_AGENT_TIMEOUT_MS must be an integer from 1000 through 1500000 milliseconds');
  }
  const timeoutMs = suppliedTimeout ?? 15 * 60 * 1000;
  agentEnv.RUNNER_AGENT_INPUT = payloadFile;
  agentEnv.RUNNER_AGENT_SESSION_ID = sessionId;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentEnv,
      detached: process.platform !== 'win32',
      windowsHide: true
    });
    let stdout = ''; let stderr = ''; let totalOutputBytes = 0; let settled = false;
    let abortReason = null; let killTimer = null; let killSent = false;
    let childClosed = false; let closeCode = null; let closeSignal = null;
    const signalGroup = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          try { child.kill(signal); } catch {}
        }
      }
    };
    const abortGroup = reason => {
      if (abortReason || settled) return;
      abortReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        killSent = true;
        finishAbort();
      }, 1000);
    };
    const removeParentSignalHandlers = () => {
      process.removeListener('SIGTERM', onParentSignal);
      process.removeListener('SIGINT', onParentSignal);
      process.removeListener('SIGHUP', onParentSignal);
    };
    const finishAbort = () => {
      // A descendant can escape the process group and keep inherited pipe
      // descriptors open after the group leader is gone. Do not make terminal
      // classification depend on ChildProcess's `close` event: after the
      // grace period we close our read ends and persist an ambiguous outcome.
      if (!abortReason || !killSent || settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      removeParentSignalHandlers();
      const stdoutBytes = Buffer.concat(out.chunks, out.byteLength);
      const stderrBytes = Buffer.concat(err.chunks, err.byteLength);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const error = new Error(`${abortReason}; process-group SIGKILL was attempted (leader exit observed=${childClosed}, signal=${closeSignal || 'none'}); descendant termination and external side effects remain uncertain and require reconciliation`);
      error.remoteOutcome = 'ambiguous';
      error.runnerAgentOutcome = {
        exitCode: closeCode,
        timedOut: abortReason.startsWith('runner agent timeout'),
        stdout: stdoutBytes.toString('utf8'),
        stderr: stderrBytes.toString('utf8'),
        stdoutBytes,
        stderrBytes,
        command
      };
      reject(error);
    };
    const onParentSignal = signal => abortGroup(`worker process received ${signal} while runner agent was active`);
    const timer = setTimeout(() => abortGroup(`runner agent timeout after ${timeoutMs}ms`), timeoutMs);
    const appendOutput = (stream, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, RUNNER_AGENT_MAX_OUTPUT_BYTES - totalOutputBytes);
      if (remaining > 0) {
        const accepted = bytes.subarray(0, remaining);
        stream.chunks.push(Buffer.from(accepted));
        stream.byteLength += accepted.length;
      }
      totalOutputBytes += bytes.length;
      if (totalOutputBytes > RUNNER_AGENT_MAX_OUTPUT_BYTES) {
        abortGroup(`runner agent exceeded ${RUNNER_AGENT_MAX_OUTPUT_BYTES} combined stdout/stderr bytes`);
      }
    };
    const out = { chunks: [], byteLength: 0 }; const err = { chunks: [], byteLength: 0 };
    process.once('SIGTERM', onParentSignal);
    process.once('SIGINT', onParentSignal);
    process.once('SIGHUP', onParentSignal);
    child.stdout.on('data', chunk => appendOutput(out, chunk));
    child.stderr.on('data', chunk => appendOutput(err, chunk));
    child.on('error', error => {
      if (settled) return;
      // ChildProcess emits `error` for failures other than initial spawn (for
      // example a failed kill). Once a PID exists, never call the outcome
      // definitely-unsent: the agent may already have produced side effects.
      if (!child.pid && !abortReason) {
        settled = true; clearTimeout(timer); clearTimeout(killTimer); removeParentSignalHandlers();
        error.remoteOutcome = 'not_sent';
        return reject(error);
      }
      if (!abortReason) abortGroup(`runner agent process error after spawn: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      childClosed = true; closeCode = code; closeSignal = signal;
      clearTimeout(timer);
      if (abortReason) { finishAbort(); return; }
      settled = true; clearTimeout(killTimer); removeParentSignalHandlers();
      const stdoutBytes = Buffer.concat(out.chunks, out.byteLength);
      const stderrBytes = Buffer.concat(err.chunks, err.byteLength);
      try {
        stdout = new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes);
        stderr = new TextDecoder('utf-8', { fatal: true }).decode(stderrBytes);
      } catch (cause) {
        const error = new Error(`runner agent stdout/stderr must be valid UTF-8: ${cause.message}; external side effects remain uncertain and require reconciliation`);
        error.remoteOutcome = 'ambiguous';
        error.runnerAgentOutcome = {
          exitCode: code, timedOut: false, stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8'),
          stdoutBytes, stderrBytes, command
        };
        return reject(error);
      }
      const execution = { exitCode: code, timedOut: false, stdout, stderr, stdoutBytes, stderrBytes, command };
      if (code !== 0) {
        const error = new Error(`runner agent exited with status ${code}: ${stderr.slice(-2000)}; external side effects remain uncertain and require reconciliation`);
        error.remoteOutcome = 'ambiguous'; error.runnerAgentOutcome = execution;
        return reject(error);
      }
      let output;
      try { output = parseStrictJson(stdout, 'runner agent stdout'); } catch (cause) {
        const error = new Error(`runner agent must emit one JSON object on stdout: ${cause.message}; external side effects remain uncertain and require reconciliation`);
        error.remoteOutcome = 'ambiguous'; error.runnerAgentOutcome = execution;
        return reject(error);
      }
      if (!output || typeof output !== 'object' || Array.isArray(output)) {
        const error = new Error('runner agent output must be a JSON object; external side effects remain uncertain and require reconciliation');
        error.remoteOutcome = 'ambiguous'; error.runnerAgentOutcome = execution;
        return reject(error);
      }
      resolve({ output: JSON.stringify(output), stdout, stderr, exitCode: code, timedOut: false, command });
    });
  });
}

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
  const output = structuredClone(RUNNER_ROLE_OUTPUTS[String(role).toLowerCase()] || { summary: `Runner completed role ${role}.` });
  if (String(role).toLowerCase() === 'engineer') {
    output.execution = { session_id: sessionId, exit_code: 0, command: 'runner-agent', verified_at: isoNow() };
  }
  if (String(role).toLowerCase() === 'cto') output.evidence_refs = [];
  return JSON.stringify(output);
}

async function publishCheckpoint() {
  const candidate = path.join(process.cwd(), '.worker', 'checkpoint.json');
  try {
    const checkpoint = parseStrictJson(readFileWithin(workspaceRoot, candidate), 'worker checkpoint');
    execFileSync('git', ['config', 'user.name', 'durable-agent-orchestrator']);
    execFileSync('git', ['config', 'user.email', 'actions@users.noreply.github.com']);
    execFileSync('git', ['add', '--', '.worker/checkpoint.json']);
    if (!git(['diff', '--cached', '--name-only']).split('\n').includes('.worker/checkpoint.json')) throw new Error('checkpoint file was not staged');
    execFileSync('git', ['commit', '-m', `checkpoint: ${process.env.TASK_ID} attempt ${process.env.ATTEMPT}`], { stdio: 'ignore' });
    const branch = `p9-checkpoint/${process.env.TASK_ID}/${process.env.PROVIDER_RUN_ID}`;
    execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'pipe' });
    checkpoint.checkpoint_commit = git(['rev-parse', 'HEAD']);
    checkpoint.checkpoint_ref = branch;
    writeEvidenceFile('checkpoint.json', safeJson(checkpoint));
    return checkpoint;
  } catch (error) {
    try { writeEvidenceFile('checkpoint-error.txt', `${error.message}\n`); } catch {}
    return null;
  }
}

const resultBase = {
  schema_version: 1,
  job_id: process.env.JOB_ID,
  task_id: process.env.TASK_ID,
  lease_id: process.env.LEASE_ID,
  attempt,
  owner_epoch: ownerEpoch,
  input_commit: process.env.INPUT_COMMIT,
  provider_run_id: process.env.PROVIDER_RUN_ID,
  provider_run_attempt: providerRunAttempt,
  evidence_artifact: `p3-worker-${process.env.PROVIDER_RUN_ID}`,
  evidence_refs: [],
  started_at: isoNow(),
  finished_at: null,
  error: null
};

let store = null;
let task = null;
let agentTask = false;
let execution = null;
let agentOutput = null;
let taskPayloadEvidenceWritten = false;
let taskPayloadEvidenceBytes = null;

try {
  const actualCommit = git(['rev-parse', 'HEAD']);
  if (actualCommit.toLowerCase() !== process.env.INPUT_COMMIT.toLowerCase()) {
    throw new Error(`worker checkout mismatch: expected ${process.env.INPUT_COMMIT}, got ${actualCommit}`);
  }

  const raw = process.env.TASK_PAYLOAD_JSON || readFileWithin(workspaceRoot, payloadPath);
  const payload = parseStrictJson(raw, 'worker task payload');
  const checkpointPath = path.join(process.cwd(), '.worker', 'checkpoint.json');
  let checkpoint = null;
  try {
    checkpoint = parseStrictJson(readFileWithin(workspaceRoot, checkpointPath), 'worker checkpoint');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const resuming = Boolean(checkpoint?.checkpoint_commit && checkpoint.checkpoint_commit.toLowerCase() === process.env.INPUT_COMMIT.toLowerCase());

  const expected = {
    job_id: process.env.JOB_ID,
    task_id: process.env.TASK_ID,
    lease_id: process.env.LEASE_ID,
    attempt,
    owner_epoch: ownerEpoch
  };
  if (payload.job_id !== expected.job_id) throw new Error('payload correlation mismatch: job_id');
  if (payload.task_id !== expected.task_id) throw new Error('payload correlation mismatch: task_id');
  if (!resuming && payload.lease_id != null && payload.lease_id !== expected.lease_id) throw new Error('payload correlation mismatch: lease_id');
  if (!resuming && payload.attempt != null && payload.attempt !== expected.attempt) throw new Error('payload correlation mismatch: attempt');
  if (!resuming && payload.owner_epoch != null && payload.owner_epoch !== expected.owner_epoch) throw new Error('payload correlation mismatch: owner_epoch');
  if (resuming && checkpoint.task_id && checkpoint.task_id !== expected.task_id) throw new Error('checkpoint correlation mismatch: task_id');
  if (resuming && checkpoint.job_id && checkpoint.job_id !== expected.job_id) throw new Error('checkpoint correlation mismatch: job_id');
  if (payload.role && payload.role !== process.env.ROLE) throw new Error('payload correlation mismatch: role');
  if (payload.schema_version !== 1) throw new Error(`unsupported task payload schema: ${payload.schema_version}`);
  if (!Array.isArray(payload.required_evidence) || payload.required_evidence.length === 0) {
    throw new Error('task payload required_evidence must be non-empty');
  }
  for (const ref of payload.required_evidence) assertEvidenceRef(ref);
  agentTask = payload.execution_mode === 'agent' || payload.runtime_owner === 'github-runner';
  if (!agentTask && !payload.command && !(payload.executable && Array.isArray(payload.args))) throw new Error('task payload must define command or structured executable/args');
  if (payload.command && typeof payload.command !== 'string') throw new Error('task payload command must be a string');
  if (payload.executable && (typeof payload.executable !== 'string' || payload.args.some(arg => typeof arg !== 'string'))) {
    throw new Error('task payload executable/args must be strings');
  }
  const taskPayloadEvidence = { ...payload, lease_id: expected.lease_id, attempt: expected.attempt, owner_epoch: expected.owner_epoch };
  // Keep the approved payload snapshot in memory while task code runs. The
  // task shares the runner UID and can otherwise rewrite files under .p3-worker
  // after this write but before artifact upload. Publish the immutable bytes
  // only after execution; if task code pre-creates the evidence path, the
  // exclusive writer fails closed rather than accepting worker-controlled bytes.
  taskPayloadEvidenceBytes = Buffer.from(safeJson(taskPayloadEvidence));

  // Import after the worker DB environment is fixed. ExecutionManager remains
  // the only component allowed to invoke the task command.
  process.env.WORKFLOW_DATA_DIR = path.join(evidenceDir, 'state');
  process.env.WORKFLOW_DB = path.join(process.env.WORKFLOW_DATA_DIR, 'worker.db');
  const { WorkflowStore } = await import('../src/runtime/job-store.js');
  const { ExecutionManager } = await import('../src/runtime/execution-manager.js');
  store = new WorkflowStore();
  const job = store.createJob({ conversationKey: `github-actions:${process.env.JOB_ID}`, title: `worker ${process.env.TASK_ID}` });
  task = store.ensureTask(job.job_id, {
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

  if (agentTask) {
    const sessionId = `runner:${process.env.ROLE}:${process.env.JOB_ID}:${process.env.TASK_ID}:attempt:${process.env.ATTEMPT}`;
    if (process.env.M11_RUNNER_MODE === 'mock') {
      agentOutput = payload.agent_output || buildRunnerAgentOutput(process.env.ROLE, sessionId);
      execution = { execution_session_id: sessionId, exitCode: 0, timedOut: false, stdout: agentOutput, stderr: '', command: 'm11-mock-agent' };
    } else {
      const external = await runExternalRunnerAgent({ payload, sessionId, evidenceDir });
      agentOutput = external.output;
      execution = {
        execution_session_id: sessionId, exitCode: external.exitCode, timedOut: external.timedOut,
        stdout: external.stdout, stderr: external.stderr, command: external.command
      };
    }
  } else {
    const manager = new ExecutionManager(store, { timeoutMs: Math.max(1000, Number(payload.timeout_ms) || Number(process.env.EXECUTION_TIMEOUT_MS) || 120000) });
    const executionCwd = payload.cwd ? assertWorkspacePath(payload.cwd, 'task cwd') : process.cwd();
    execution = await manager.executeAuthorizedTask(task.task_id, { cwd: executionCwd });
  }

  const stdoutBytes = execution.stdoutBytes || Buffer.from(execution.stdout || '');
  const stderrBytes = execution.stderrBytes || Buffer.from(execution.stderr || '');
  const outputCommit = git(['rev-parse', 'HEAD']);
  const gitStatusBytes = Buffer.from(`${git(['status', '--short'])}\n`);
  writeEvidenceFile('task-payload.json', taskPayloadEvidenceBytes);
  taskPayloadEvidenceWritten = true;
  writeEvidenceFile('stdout.txt', stdoutBytes);
  writeEvidenceFile('stderr.txt', stderrBytes);
  writeEvidenceFile('git-status.txt', gitStatusBytes);
  writeEvidenceFile('execution.json', safeJson({
    task_id: process.env.TASK_ID, execution_session_id: execution.execution_session_id || null,
    exit_code: execution.exitCode, timed_out: Boolean(execution.timedOut), output_commit: outputCommit,
    stdout_bytes: stdoutBytes.length, stderr_bytes: stderrBytes.length,
    git_status_bytes: gitStatusBytes.length,
    stdout_sha256: crypto.createHash('sha256').update(stdoutBytes).digest('hex'),
    stderr_sha256: crypto.createHash('sha256').update(stderrBytes).digest('hex'),
    git_status_sha256: crypto.createHash('sha256').update(gitStatusBytes).digest('hex'),
    agent_output: agentOutput
  }));

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
  let executionMayHaveStarted = Boolean(error?.runnerAgentOutcome || agentOutput !== null || execution);
  if (!executionMayHaveStarted && store && task) {
    try {
      const currentTask = store.getTask(task.task_id);
      executionMayHaveStarted = Boolean(currentTask?.execution_session_id || currentTask?.execution_status === 'running');
    } catch { executionMayHaveStarted = true; }
  }
  const agentOutcome = error?.runnerAgentOutcome || null;
  const timedOut = Boolean(agentOutcome?.timedOut || execution?.timedOut);
  resultBase.status = timedOut ? 'TIMED_OUT' : executionMayHaveStarted ? 'UNKNOWN' : 'FAILED';
  resultBase.output_commit = executionMayHaveStarted ? (() => { try { return git(['rev-parse', 'HEAD']); } catch { return null; } })() : null;
  resultBase.exit_code = agentOutcome?.exitCode ?? execution?.exitCode ?? null;
  resultBase.evidence_refs = [];
  resultBase.finished_at = isoNow();
  resultBase.error = executionMayHaveStarted
    ? `REMOTE_AGENT_EFFECT_UNCERTAIN: ${error?.message || String(error)}; automatic retry is forbidden until explicit reconciliation`
    : (error?.message || String(error));
  if (taskPayloadEvidenceBytes) {
    const stdout = agentOutcome?.stdout ?? execution?.stdout ?? '';
    const stderr = agentOutcome?.stderr ?? execution?.stderr ?? '';
    const stdoutBytes = agentOutcome?.stdoutBytes ?? execution?.stdoutBytes ?? Buffer.from(stdout);
    const stderrBytes = agentOutcome?.stderrBytes ?? execution?.stderrBytes ?? Buffer.from(stderr);
    try {
      if (!taskPayloadEvidenceWritten) {
        writeEvidenceFile('task-payload.json', taskPayloadEvidenceBytes);
        taskPayloadEvidenceWritten = true;
      }
      writeEvidenceFile('stdout.txt', stdoutBytes);
      writeEvidenceFile('stderr.txt', stderrBytes);
      const gitStatusBytes = Buffer.from(`${git(['status', '--short'])}\n`);
      writeEvidenceFile('git-status.txt', gitStatusBytes);
      writeEvidenceFile('execution.json', safeJson({
        task_id: process.env.TASK_ID, execution_session_id: execution?.execution_session_id || null,
        exit_code: resultBase.exit_code, timed_out: timedOut,
        stdout_bytes: stdoutBytes.length, stderr_bytes: stderrBytes.length,
        git_status_bytes: gitStatusBytes.length,
        stdout_sha256: crypto.createHash('sha256').update(stdoutBytes).digest('hex'),
        stderr_sha256: crypto.createHash('sha256').update(stderrBytes).digest('hex'),
        git_status_sha256: crypto.createHash('sha256').update(gitStatusBytes).digest('hex'),
        agent_output: null
      }));
    } catch (evidenceError) {
      resultBase.error += `; complete failure evidence could not be written without overwriting existing files: ${evidenceError.message}`;
    }
  }
  try { writeEvidenceFile('worker-error.txt', `${resultBase.error}\n`); } catch {}
  resultBase.evidence_refs = ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
    .filter(name => writtenEvidenceFiles.has(name));
}

writeEvidenceFile('result.json', safeJson(resultBase));
evidenceDirectory.close();
console.log(safeJson(resultBase));
if (resultBase.status !== 'SUCCEEDED') process.exitCode = 1;
