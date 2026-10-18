import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const root = process.cwd();
const dir = tempDir('cos-m12-runner-agent-');
const payloadRef = '.m12-task.json';
const payloadPath = path.join(root, payloadRef);
if (fs.existsSync(payloadPath) || fs.lstatSync(payloadPath, { throwIfNoEntry: false })) {
  throw new Error(`refusing to overwrite an existing runner-agent fixture path: ${payloadPath}`);
}
let payloadCreated = false;
const agentPath = path.join(dir, 'fake-runner-agent.cjs');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
fs.writeFileSync(agentPath, `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.env.RUNNER_AGENT_INPUT, 'utf8'));
const output = JSON.stringify({ role: input.payload.role, decision: 'accept', session_id: input.session_id, unicode_boundary: '€',
  explicit_token: process.env.PRIVATE_TEST_TOKEN || null,
  control_plane_token_present: Boolean(process.env.GITHUB_TOKEN),
  node_options_present: Boolean(process.env.NODE_OPTIONS) });
const bytes = Buffer.from(output);
const split = bytes.indexOf(Buffer.from('€')) + 1;
process.stdout.write(bytes.subarray(0, split));
setTimeout(() => process.stdout.write(bytes.subarray(split)), 15);
`);
fs.writeFileSync(payloadPath, JSON.stringify({
  schema_version: 1, job_id: 'job-m12', task_id: 'task-m12', lease_id: 'lease-m12', attempt: 1,
  role: 'security', runtime_owner: 'github-runner', execution_mode: 'agent',
  required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
}), { flag: 'wx', mode: 0o600 });
payloadCreated = true;

const evidence = path.join(dir, 'evidence');
const baseEnv = {
  ...process.env,
  JOB_ID: 'job-m12', TASK_ID: 'task-m12', LEASE_ID: 'lease-m12', ATTEMPT: '1', OWNER_EPOCH: '7', INPUT_COMMIT: commit, GITHUB_RUN_ATTEMPT: '1',
  TASK_PAYLOAD_REF: payloadRef, ROLE: 'security', PROVIDER_RUN_ID: 'm12-run', EVIDENCE_DIR: evidence,
  WORKFLOW_DATA_DIR: path.join(dir, 'state'), WORKFLOW_DB: path.join(dir, 'state', 'worker.db'),
  RUNNER_AGENT_COMMAND: process.execPath, RUNNER_AGENT_ARGS_JSON: JSON.stringify([agentPath]),
  RUNNER_AGENT_ENV_ALLOWLIST: 'PRIVATE_TEST_TOKEN', PRIVATE_TEST_TOKEN: 'fixture-explicit-token', GITHUB_TOKEN: 'fixture-control-plane-secret'
};

function runWorker(env) {
  try {
    return execFileSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
      cwd: root, env, stdio: 'pipe'
    }).toString('utf8');
  } catch (error) {
    throw new Error(`worker fixture failed (status=${error?.status}, signal=${error?.signal}):\nstdout=${Buffer.from(error?.stdout || '').toString('utf8')}\nstderr=${Buffer.from(error?.stderr || '').toString('utf8')}`, { cause: error });
  }
}

try {
  runWorker(baseEnv);
  const result = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
  assert.equal(result.status, 'SUCCEEDED');
  assert.match(result.agent_output, /"role":"security"/);
  const agentOutput = JSON.parse(result.agent_output);
  assert.equal(agentOutput.explicit_token, 'fixture-explicit-token', 'only explicitly allowlisted custom credentials reach the agent');
  assert.equal(agentOutput.control_plane_token_present, false, 'GitHub control-plane credentials must never be inherited by the agent');
  assert.equal(agentOutput.node_options_present, false, 'ambient Node code-loading variables must not reach the agent');
  assert.equal(agentOutput.unicode_boundary, '€', 'UTF-8 code points split across stdout chunks must survive byte-exact buffering');
  const executionEvidence = JSON.parse(fs.readFileSync(path.join(evidence, 'execution.json'), 'utf8'));
  assert.equal(executionEvidence.agent_output !== null, true);
  const stdoutBytes = fs.readFileSync(path.join(evidence, 'stdout.txt'));
  assert.equal(executionEvidence.stdout_bytes, stdoutBytes.length);
  assert.equal(executionEvidence.stdout_sha256, crypto.createHash('sha256').update(stdoutBytes).digest('hex'));

  const mockEvidence = path.join(dir, 'mock-evidence');
  runWorker({ ...baseEnv, EVIDENCE_DIR: mockEvidence, M11_RUNNER_MODE: 'mock', RUNNER_AGENT_COMMAND: '' });
  const mock = JSON.parse(fs.readFileSync(path.join(mockEvidence, 'result.json'), 'utf8'));
  assert.equal(mock.status, 'SUCCEEDED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(mockEvidence, 'execution.json'), 'utf8')).agent_output !== null, true);

  const protectedEvidence = path.join(dir, 'protected-env');
  const protectedEnv = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, encoding: 'utf8', env: { ...baseEnv, EVIDENCE_DIR: protectedEvidence, RUNNER_AGENT_ENV_ALLOWLIST: 'GITHUB_TOKEN' }
  });
  assert.equal(protectedEnv.status, 1, 'explicitly allowlisting a protected control-plane variable must fail closed');
  const protectedResult = JSON.parse(fs.readFileSync(path.join(protectedEvidence, 'result.json'), 'utf8'));
  assert.equal(protectedResult.status, 'FAILED');
  assert.match(protectedResult.error, /cannot expose protected runtime\/control-plane variable/);
  assert.deepEqual(protectedResult.evidence_refs, ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']);

  const partialEvidence = path.join(dir, 'partial-evidence');
  fs.mkdirSync(partialEvidence, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(partialEvidence, 'stderr.txt'), 'pre-existing evidence must remain untouched\n', { flag: 'wx', mode: 0o600 });
  const partialRun = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, encoding: 'utf8', env: { ...baseEnv, EVIDENCE_DIR: partialEvidence }
  });
  assert.equal(partialRun.status, 1, 'a partially occupied evidence directory must fail closed after execution');
  const partialResult = JSON.parse(fs.readFileSync(path.join(partialEvidence, 'result.json'), 'utf8'));
  assert.equal(partialResult.status, 'UNKNOWN', 'successful external execution followed by evidence-write failure is not a clean failure or success');
  assert.deepEqual(partialResult.evidence_refs, ['task-payload.json', 'stdout.txt'], 'result must reference only evidence files actually created by this attempt');
  assert.equal(fs.readFileSync(path.join(partialEvidence, 'stderr.txt'), 'utf8'), 'pre-existing evidence must remain untouched\n');
  assert.match(partialResult.error, /REMOTE_AGENT_EFFECT_UNCERTAIN/);

  const invalidUtf8AgentPath = path.join(dir, 'invalid-utf8-runner-agent.cjs');
  fs.writeFileSync(invalidUtf8AgentPath, `process.stdout.write(Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));\n`, { flag: 'wx', mode: 0o600 });
  const invalidUtf8Evidence = path.join(dir, 'invalid-utf8-evidence');
  const invalidUtf8Run = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, encoding: 'utf8', env: { ...baseEnv, EVIDENCE_DIR: invalidUtf8Evidence, RUNNER_AGENT_ARGS_JSON: JSON.stringify([invalidUtf8AgentPath]) }
  });
  assert.equal(invalidUtf8Run.status, 1, 'invalid UTF-8 from a possibly side-effecting agent must be quarantined');
  const invalidUtf8Result = JSON.parse(fs.readFileSync(path.join(invalidUtf8Evidence, 'result.json'), 'utf8'));
  assert.equal(invalidUtf8Result.status, 'UNKNOWN');
  assert.match(invalidUtf8Result.error, /REMOTE_AGENT_EFFECT_UNCERTAIN/);
  const invalidStdout = fs.readFileSync(path.join(invalidUtf8Evidence, 'stdout.txt'));
  assert.deepEqual([...invalidStdout], [0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d], 'invalid bytes must be preserved exactly rather than replacement-decoded');
  const invalidExecution = JSON.parse(fs.readFileSync(path.join(invalidUtf8Evidence, 'execution.json'), 'utf8'));
  assert.equal(invalidExecution.stdout_sha256, crypto.createHash('sha256').update(invalidStdout).digest('hex'));

  const timeoutAgentPath = path.join(dir, 'timeout-runner-agent.cjs');
  const descendantSentinel = path.join(dir, 'descendant-survived-timeout.txt');
  fs.writeFileSync(timeoutAgentPath, `
const { spawn } = require('node:child_process');
const childCode = ${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync(${JSON.stringify(descendantSentinel)},'survived'),2300);setInterval(()=>{},1000);`)};
spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`, { flag: 'wx', mode: 0o600 });
  const timeoutEvidence = path.join(dir, 'timeout-evidence');
  const timeoutRun = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...baseEnv, EVIDENCE_DIR: timeoutEvidence, RUNNER_AGENT_ARGS_JSON: JSON.stringify([timeoutAgentPath]), RUNNER_AGENT_TIMEOUT_MS: '1000' }
  });
  assert.equal(timeoutRun.status, 1, `timed-out agent must fail closed: ${timeoutRun.stderr}`);
  const timeoutResult = JSON.parse(fs.readFileSync(path.join(timeoutEvidence, 'result.json'), 'utf8'));
  assert.equal(timeoutResult.status, 'TIMED_OUT');
  assert.match(timeoutResult.error, /REMOTE_AGENT_EFFECT_UNCERTAIN/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(timeoutEvidence, 'execution.json'), 'utf8')).timed_out, true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(descendantSentinel), false, 'timeout must kill the complete runner-agent process group, not only its leader');

  // A descendant can deliberately leave the runner-agent process group while
  // retaining the agent's stdout/stderr descriptors. The worker must still
  // persist an ambiguous timeout result instead of waiting forever for the
  // descendant to close inherited pipes. This fixture is local-only and is
  // explicitly killed below; it is not evidence that escaped children stop.
  if (process.platform !== 'win32') {
    const escapedAgentPath = path.join(dir, 'escaped-pipe-runner-agent.cjs');
    const escapedPidFile = path.join(dir, 'escaped-pipe-descendant.pid');
    fs.writeFileSync(escapedAgentPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const childCode = ${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(escapedPidFile)},String(process.pid));setInterval(()=>{},1000);`)};
const child = spawn(process.execPath, ['-e', childCode], { detached: true, stdio: ['ignore', 1, 2] });
child.unref();
setInterval(() => {}, 1000);
`, { flag: 'wx', mode: 0o600 });
    const escapedEvidence = path.join(dir, 'escaped-pipe-evidence');
    const startedAt = Date.now();
    const escapedRun = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
      cwd: root, encoding: 'utf8', timeout: 7000,
      env: { ...baseEnv, EVIDENCE_DIR: escapedEvidence, RUNNER_AGENT_ARGS_JSON: JSON.stringify([escapedAgentPath]), RUNNER_AGENT_TIMEOUT_MS: '1000' }
    });
    try {
      assert.equal(escapedRun.status, 1, `escaped descendant must still yield a fail-closed worker result: ${escapedRun.stderr}`);
      assert.ok(Date.now() - startedAt < 6000, 'escaped descendant retaining pipes must not hold worker completion open');
      const escapedResult = JSON.parse(fs.readFileSync(path.join(escapedEvidence, 'result.json'), 'utf8'));
      assert.equal(escapedResult.status, 'TIMED_OUT');
      assert.match(escapedResult.error, /REMOTE_AGENT_EFFECT_UNCERTAIN/);
      assert.match(escapedResult.error, /descendant termination and external side effects remain uncertain/);
    } finally {
      if (fs.existsSync(escapedPidFile)) {
        const escapedPid = Number(fs.readFileSync(escapedPidFile, 'utf8').trim());
        if (Number.isSafeInteger(escapedPid) && escapedPid > 1) {
          try { process.kill(escapedPid, 'SIGKILL'); } catch {}
        }
      }
    }
  }

  const noisyAgentPath = path.join(dir, 'output-limit-runner-agent.cjs');
  fs.writeFileSync(noisyAgentPath, `
process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 0x78));
setInterval(() => {}, 1000);
`, { flag: 'wx', mode: 0o600 });
  const noisyEvidence = path.join(dir, 'output-limit-evidence');
  const noisyRun = spawnSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...baseEnv, EVIDENCE_DIR: noisyEvidence, RUNNER_AGENT_ARGS_JSON: JSON.stringify([noisyAgentPath]), RUNNER_AGENT_TIMEOUT_MS: '5000' }
  });
  assert.equal(noisyRun.status, 1, 'runner output-limit breach must fail closed');
  const noisyResult = JSON.parse(fs.readFileSync(path.join(noisyEvidence, 'result.json'), 'utf8'));
  assert.equal(noisyResult.status, 'UNKNOWN', 'output overflow after process start must not be misclassified as definitely unsent');
  assert.match(noisyResult.error, /REMOTE_AGENT_EFFECT_UNCERTAIN/);
  assert.match(noisyResult.error, /exceeded 8388608 combined stdout\/stderr bytes/);
  const noisyStdout = fs.readFileSync(path.join(noisyEvidence, 'stdout.txt'));
  assert.ok(noisyStdout.length <= 8 * 1024 * 1024, 'runner-agent retained output must remain bounded to the configured combined limit');

  const productionWithoutAgent = path.join(dir, 'no-agent');
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts/run-worker-task.js')], {
    cwd: root, env: { ...baseEnv, EVIDENCE_DIR: productionWithoutAgent, RUNNER_AGENT_COMMAND: '' }, stdio: 'pipe'
  }), error => String(error?.stdout || '').includes('production runner agent is not configured'));

  assert.equal(fs.existsSync(path.join(root, 'scripts/runner-agent-openclaw.js')), true);
} finally {
  if (payloadCreated) fs.rmSync(payloadPath, { force: true });
}

console.log('M12 RUNNER AGENT CONTRACT PASS');
