#!/usr/bin/env node
// Host-neutral paired-run harness. A host adapter must invoke the actual model and
// tools; this runner deliberately cannot synthesize model/tool events itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
const configPath = option('--config');
const casePath = option('--case');
const outputPath = option('--output');
const probeOnly = args.includes('--probe-only');
if (!configPath || !casePath || !outputPath || args.some(a => a.startsWith('--') && !['--config','--case','--output','--probe-only'].includes(a))) {
  console.error('Usage: node paired-host-harness.mjs --config <host-config.json> --case <safe-probe.json> --output <evidence.json> [--probe-only]');
  process.exit(2);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const testCase = JSON.parse(fs.readFileSync(casePath, 'utf8'));
assert.equal(config.protocol, 'cos-paired-host-v1', 'unsupported host config protocol');
assert.equal(testCase.kind, 'read-only-host-probe', 'only a benign read-only host probe is allowed by this runner');
assert.equal(typeof testCase.prompt, 'string');
assert.ok(testCase.prompt.length > 0 && testCase.prompt.length <= 4000);
assert.equal(config.conditions?.plugin?.command, config.conditions?.control?.command,
  'paired conditions must use the same host executable');
assert.deepEqual(config.conditions?.plugin?.base_args ?? [], config.conditions?.control?.base_args ?? [],
  'paired conditions must use the same host base arguments');
for (const condition of ['plugin', 'control']) {
  const c = config.conditions?.[condition];
  assert.ok(c && Array.isArray(c.args), `missing ${condition} host args`);
  assert.ok(c.args.every(v => typeof v === 'string'), `${condition} args must be strings`);
}

const runId = randomUUID();
const promptBytes = Buffer.from(testCase.prompt, 'utf8');
const promptHash = sha256(promptBytes);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-paired-host-'));
const outputAbs = path.resolve(outputPath);
const persistentTraceRoot = `${outputAbs}.traces`;
const records = {};

function runHost(condition) {
  const spec = config.conditions[condition];
  const root = path.join(tempRoot, condition);
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  const executionTmp = path.join(root, 'execution-tmp');
  for (const dir of [workspace, dataDir, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fixturePath = path.join(workspace, 'benchmark-fixture.json');
  const fixtureBytes = Buffer.from(`${JSON.stringify({ fixture: 'synthetic-read-only-probe', status: 'ready', revision: 1 }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(fixturePath, fixtureBytes, { mode: 0o600, flag: 'wx' });
  const fixtureHash = sha256(fixtureBytes);
  const childEnv = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    COS_BENCHMARK_PROTOCOL: 'cos-paired-host-v1',
    COS_BENCHMARK_RUN_ID: runId,
    COS_BENCHMARK_CONDITION: condition,
    COS_BENCHMARK_PROBE_ONLY: probeOnly ? '1' : '0',
    COS_BENCHMARK_WORKSPACE: workspace,
    COS_BENCHMARK_DATA_DIR: dataDir,
    COS_BENCHMARK_EXECUTION_TMP_DIR: executionTmp,
    COS_BENCHMARK_PROMPT_SHA256: promptHash,
    COS_BENCHMARK_FIXTURE_PATH: fixturePath,
    COS_BENCHMARK_FIXTURE_SHA256: fixtureHash,
  };
  // Deliberately do not inherit credentials, user config paths, or arbitrary env vars.
  const child = spawn(spec.command, [...(config.conditions[condition].base_args ?? []), ...spec.args], {
    cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timeoutMs = Math.min(Math.max(config.timeout_ms ?? 30000, 1000), 120000);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { stderr += chunk.slice(0, 10000); });
  // A host that exits immediately (for example, a fail-closed negative test)
  // can close stdin before the request is written. Treat EPIPE as a normal
  // child-protocol failure so the close handler persists blocked evidence.
  child.stdin.on('error', err => {
    if (err.code !== 'EPIPE') stderr += `stdin write error: ${err.message}\n`;
  });
  const request = {
    protocol: 'cos-paired-host-v1', run_id: runId, condition,
    probe_only: probeOnly, case_id: testCase.case_id ?? 'HOST-PROBE-001',
    prompt: testCase.prompt, prompt_sha256: promptHash,
    tools_profile: condition === 'plugin' ? 'frozen-plugin-bundle' : 'basic-tools-only',
    workspace, data_directory: dataDir, execution_tmp_directory: executionTmp,
    fixture_path: fixturePath, fixture_sha256: fixtureHash,
    expected_model_match: true,
    requirements: {
      actual_model_invocation: true, native_tool_call_and_result_trace: true,
      effective_permission_snapshot: true, no_external_network: true,
      no_external_provider_credentials: true, no_live_runtime: true,
      no_workflow_approval_or_dispatch: true,
    },
  };
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return new Promise((resolve, reject) => {
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${condition} host adapter timed out`));
      if (code !== 0) return reject(new Error(`${condition} host adapter exited ${code}; stderr=${stderr.slice(-2000)}`));
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) return reject(new Error(`${condition} host must emit exactly one JSON line on stdout; got ${lines.length}`));
      let record;
      try { record = JSON.parse(lines[0]); } catch { return reject(new Error(`${condition} host emitted invalid JSON`)); }
      resolve({ record, stderr: stderr.slice(-2000), workspace, dataDir, executionTmp, fixtureHash });
    });
  });
}

function validateRecord(condition, result) {
  const r = result.record;
  assert.equal(r.protocol, 'cos-paired-host-v1', `${condition}: protocol mismatch`);
  assert.equal(r.run_id, runId, `${condition}: run id mismatch`);
  assert.equal(r.condition, condition, `${condition}: condition mismatch`);
  assert.equal(r.probe_only, probeOnly, `${condition}: probe mode mismatch`);
  assert.equal(r.prompt_sha256, promptHash, `${condition}: host did not attest to the exact prompt`);
  assert.equal(r.model?.provider && r.model?.id ? true : false, true, `${condition}: model identity missing`);
  assert.equal(r.invocation?.actual_model_invocation, true, `${condition}: actual model invocation not attested`);
  assert.equal(r.invocation?.synthetic_or_scripted, false, `${condition}: scripted/synthetic invocation is not accepted`);
  assert.ok(Array.isArray(r.tool_trace) && r.tool_trace.length > 0, `${condition}: native tool trace missing`);
  assert.ok(r.tool_trace.some(e => e.kind === 'model_tool_call' && e.native === true), `${condition}: native model tool-call event missing`);
  assert.ok(r.tool_trace.some(e => e.kind === 'tool_result' && e.native === true), `${condition}: native tool-result event missing`);
  assert.ok(typeof r.raw_trace?.path === 'string' && typeof r.raw_trace?.sha256 === 'string',
    `${condition}: durable raw host trace path/hash missing`);
  const tracePath = path.resolve(r.raw_trace.path);
  const realRoot = fs.realpathSync(result.workspace.slice(0, result.workspace.lastIndexOf(path.sep)));
  const realTracePath = fs.realpathSync(tracePath);
  assert.ok(realTracePath.startsWith(`${realRoot}${path.sep}`), `${condition}: raw trace must be stored inside its isolated condition directory`);
  assert.equal(sha256(fs.readFileSync(realTracePath)), r.raw_trace.sha256, `${condition}: raw trace SHA-256 mismatch`);
  assert.ok(r.permission_snapshot && r.permission_snapshot.captured_by_host === true,
    `${condition}: effective host permission snapshot missing`);
  assert.ok(Array.isArray(r.permission_snapshot.effective_tools), `${condition}: effective tools list missing`);
  assert.ok(r.permission_snapshot.effective_tools.length > 0, `${condition}: effective tools list is empty`);
  assert.equal(typeof r.permission_snapshot.authorization_policy, 'string', `${condition}: effective authorization policy missing`);
  assert.equal(r.environment?.external_network_used, false, `${condition}: external network must be disabled`);
  assert.equal(r.environment?.external_provider_credentials_used, false, `${condition}: provider credentials must not be used`);
  assert.equal(r.environment?.live_runtime_targeted, false, `${condition}: live runtime target forbidden`);
  assert.equal(r.environment?.workspace_path, result.workspace, `${condition}: workspace isolation not attested`);
  assert.equal(r.environment?.data_directory, result.dataDir, `${condition}: data isolation not attested`);
  assert.equal(r.environment?.execution_tmp_directory, result.executionTmp, `${condition}: execution temp isolation not attested`);
  assert.equal(r.environment?.initial_fixture_sha256, result.fixtureHash,
    `${condition}: host's initial fixture hash does not match harness-created fixture`);
  assert.equal(r.environment?.final_fixture_sha256, result.fixtureHash,
    `${condition}: read-only probe changed fixture state`);
  return r;
}

let evidence;
try {
  // Sequential launch avoids concurrent provider calls and keeps the prompt bytes identical.
  for (const condition of ['plugin', 'control']) {
    const result = await runHost(condition);
    records[condition] = validateRecord(condition, result);
  }
  assert.equal(records.plugin.model.provider, records.control.model.provider, 'paired provider differs');
  assert.equal(records.plugin.model.id, records.control.model.id, 'paired model differs');
  assert.equal(records.plugin.prompt_sha256, records.control.prompt_sha256, 'paired prompt differs');
  assert.equal(records.plugin.environment?.initial_fixture_sha256, records.control.environment?.initial_fixture_sha256,
    'paired initial fixture hash differs');
  const pluginTools = records.plugin.permission_snapshot.effective_tools.map(String);
  const controlTools = records.control.permission_snapshot.effective_tools.map(String);
  assert.ok(pluginTools.some(name => /orchestrator_health|chat.on.steroids|local.orchestrator/i.test(name)),
    'plugin condition does not expose an observed plugin health/orchestrator tool');
  assert.ok(controlTools.every(name => !/orchestrator_health|chat.on.steroids|local.orchestrator|workflow_approve|workflow_dispatch/i.test(name)),
    'control condition exposes plugin/orchestrator-only capabilities');
  assert.ok(records.plugin.tool_trace.some(e => e.kind === 'model_tool_call' && /orchestrator_health/i.test(String(e.tool_name))),
    'plugin condition did not invoke the expected read-only plugin health tool');
  assert.ok(records.control.tool_trace.some(e => e.kind === 'model_tool_call' && !/orchestrator_health|chat.on.steroids|local.orchestrator/i.test(String(e.tool_name))),
    'control condition did not invoke a basic tool');
  assert.notDeepEqual(pluginTools, controlTools, 'condition separation is not demonstrated: effective tool sets are identical');
  // Preserve the validated native traces before removing the isolated run roots.
  // The persistent copies are immutable per-run artifacts beside the evidence JSON.
  const persistentRunTraceDir = path.join(persistentTraceRoot, runId);
  fs.mkdirSync(persistentRunTraceDir, { recursive: true, mode: 0o700 });
  for (const condition of ['plugin', 'control']) {
    const source = path.resolve(records[condition].raw_trace.path);
    const target = path.join(persistentRunTraceDir, `${condition}.raw-trace.json`);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    records[condition].raw_trace = { path: target, sha256: sha256(fs.readFileSync(target)) };
  }
  evidence = {
    protocol: 'cos-paired-host-v1', run_id: runId, captured_at: new Date().toISOString(),
    probe_only: probeOnly, case_id: testCase.case_id ?? 'HOST-PROBE-001', prompt_sha256: promptHash,
    status: 'host-contract-verified', benchmark_scenarios_executed: false,
    model_pair_verified: true, exact_prompt_pair_verified: true,
    native_tool_call_and_result_traces_verified: true, paired_effective_permissions_captured: true,
    isolated_workspaces_verified: true, read_only_fixture_invariant_verified: true,
    persistent_raw_trace_directory: persistentRunTraceDir,
    conditions: records,
    limitations: ['A host-contract probe does not score any of the ten frozen scenarios.',
      'This probe verifies model/tool plumbing, not factual accuracy of the final prose against tool output.',
      'Scenario execution remains separately gated by the frozen Phase 1 protocol.'],
  };
} catch (error) {
  evidence = {
    protocol: 'cos-paired-host-v1', run_id: runId, captured_at: new Date().toISOString(),
    probe_only: probeOnly, case_id: testCase.case_id ?? 'HOST-PROBE-001', prompt_sha256: promptHash,
    status: 'blocked', benchmark_scenarios_executed: false,
    model_pair_verified: false, exact_prompt_pair_verified: false,
    native_tool_call_and_result_traces_verified: false, paired_effective_permissions_captured: false,
    isolated_workspaces_verified: true, failure: String(error.message),
    conditions_observed: Object.keys(records),
  };
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  fs.writeFileSync(outputAbs, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: evidence.status, probe_only: probeOnly,
  benchmark_scenarios_executed: false, evidence: outputAbs,
  failure: evidence.failure ?? null }, null, 2));
