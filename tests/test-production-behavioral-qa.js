#!/usr/bin/env node
// Local-only production workflow QA. This harness deliberately avoids the
// legacy test-tool-turn.js script, which contacts a local HTTP inference service
// and executes a command returned by that service. It starts an isolated MCP
// process against a temporary SQLite database and verifies bounded behavior
// through the public tool interface; no network, model API, or live provider is
// required.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = [
  path.join(pluginRoot, 'src/runtime/workflow/catalog/production.js'),
  path.join(pluginRoot, 'server/runtime/workflow/catalog/production.js')
].find(candidate => fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile());
if (!catalogPath) throw new Error('trusted production QA plan catalog is not present in this plugin build');
const { PRODUCTION_QA_HARNESS_SHA256 } = await import(pathToFileURL(catalogPath).href);
const thisHarnessBytes = fs.readFileSync(fileURLToPath(import.meta.url));
const thisHarnessSha256 = crypto.createHash('sha256').update(thisHarnessBytes).digest('hex');
assert.equal(thisHarnessSha256, PRODUCTION_QA_HARNESS_SHA256,
  `production behavioral QA harness source hash mismatch: ${thisHarnessSha256} != ${PRODUCTION_QA_HARNESS_SHA256}`);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-behavioral-qa-'));
const dataDir = path.join(tempRoot, 'private-data');
const workspace = path.join(tempRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

const env = { ...process.env };
for (const key of [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_BOT_TOKEN',
  'SLACK_TOKEN', 'OPENCLAW_GATEWAY_URL', 'CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR',
  'CHAT_ON_STEROIDS_TEST_RPC_QUEUE_DELAY_ID'
]) delete env[key];
Object.assign(env, {
  NODE_ENV: 'test',
  HOME: tempRoot,
  WORKFLOW_DATA_DIR: dataDir,
  WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  CHAT_ON_STEROIDS_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_WORKSPACE: workspace,
  WORKFLOW_WORKSPACE: workspace,
  EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime')
});

let child = null;
let stdout = '';
let stderr = '';
let inputBuffer = '';
let nextId = 1;
const waiters = new Map();
const RPC_TIMEOUT_MS = 15_000;

function rejectAll(error) {
  for (const [id, waiter] of waiters) {
    clearTimeout(waiter.timer);
    waiters.delete(id);
    waiter.reject(error);
  }
}

function sendRpc(method, params = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error(`isolated MCP process is not alive: ${stderr}`));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`production QA RPC timeout method=${method} id=${id}\nstdout=${stdout}\nstderr=${stderr}`));
    }, RPC_TIMEOUT_MS);
    waiters.set(id, {
      timer,
      resolve: response => { clearTimeout(timer); resolve(response); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = waiters.get(id);
      if (!waiter) return;
      waiters.delete(id);
      waiter.reject(error);
    });
  });
}

async function callTool(name, args = {}) {
  const response = await sendRpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `${name} returned JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, false, `${name} failed: ${response.result?.content?.[0]?.text}`);
  return response.result?.structuredContent;
}

async function shutdown() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        resolve();
      }, 1500))
    ]);
  }
  rejectAll(new Error('isolated MCP process shut down'));
}

try {
  child = spawn(process.execPath, [path.join(pluginRoot, 'server', 'index.js')], {
    cwd: pluginRoot, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    inputBuffer += chunk;
    let newline;
    while ((newline = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!Object.hasOwn(message, 'id')) continue;
      const waiter = waiters.get(message.id);
      if (!waiter) continue;
      waiters.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => rejectAll(error));
  child.once('exit', (code, signal) => rejectAll(new Error(`isolated MCP process exited code=${code} signal=${signal}\nstderr=${stderr}\nstdout=${stdout}`)));

  const initialized = await sendRpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'production-behavioral-qa', version: '1' }
  });
  assert.equal(initialized.result?.serverInfo?.name, 'runalith-agent-orchestrator');
  const listed = await sendRpc('tools/list');
  const tools = listed.result?.tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 50, 'the local plugin contract must expose exactly 50 tools');
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]));
  for (const name of ['workflow_create', 'workflow_approve', 'workflow_dispatch', 'workflow_prepare_tasks', 'workflow_next_task', 'workflow_validate_artifact', 'workflow_liveness_diagnostics']) {
    assert.ok(toolsByName.has(name), `required local QA tool is missing: ${name}`);
    assert.equal(toolsByName.get(name).inputSchema?.type, 'object', `${name} must expose an object schema`);
  }
  console.log('PRODUCTION QA MCP INITIALIZE/50-TOOL DISCOVERY PASS');

  const validQa = await callTool('workflow_validate_artifact', {
    artifact_type: 'qa-report', role: 'qa',
    artifact: {
      checks: ['isolated MCP tool contract validation'],
      results: ['input/output schema contract validated without network access'],
      decision: 'accept'
    }
  });
  assert.equal(validQa?.valid, true, `valid behavioral QA fixture rejected: ${JSON.stringify(validQa)}`);
  const invalidQa = await sendRpc('tools/call', {
    name: 'workflow_validate_artifact',
    arguments: { artifact_type: 'qa-report', role: 'qa', artifact: { checks: 'not-an-array', results: [], decision: 'accept' } }
  });
  assert.equal(invalidQa.result?.isError, false, 'typed validation errors are returned as structured tool results');
  assert.equal(invalidQa.result?.structuredContent?.valid, false, 'malformed QA report must be rejected by the real validator');
  assert.equal((await callTool('orchestrator_health')).status, 'ok', 'isolated local service should report healthy after startup');
  console.log('PRODUCTION QA BEHAVIORAL ARTIFACT VALIDATION PASS');

  const created = await callTool('workflow_create', {
    title: 'Production QA local immutable-plan fixture',
    task: 'Validate local workflow creation and the separately approved immutable plan without invoking any external provider.',
    workflow: 'standard-engineering', workspace
  });
  assert.equal(created?.created, true);
  assert.equal(created?.execution_authorized, undefined, 'workflow creation must not imply execution approval');
  const approved = await callTool('workflow_approve', {
    job_id: created.job_id,
    confirmation: 'Approve only the isolated local production QA fixture.'
  });
  const planHash = approved?.plan?.plan_hash || approved?.plan_hash;
  assert.match(String(planHash || ''), /^[a-f0-9]{64}$/, 'approval must return the immutable plan hash');
  const dispatched = await callTool('workflow_dispatch', { job_id: created.job_id });
  assert.equal(dispatched?.dispatched, true);
  const prepared = await callTool('workflow_prepare_tasks', { job_id: created.job_id });
  assert.ok(prepared?.tasks_created >= 0 || Array.isArray(prepared?.tasks), 'task preparation must return durable plan/task state');
  const next = await callTool('workflow_next_task', { job_id: created.job_id });
  assert.ok(['task', 'local_execution'].includes(next?.stage), `expected next planned task, got ${JSON.stringify(next)}`);
  assert.ok(next?.task?.task_id && next?.task?.role, 'next task must include durable task identity and role');
  const inspected = await callTool('workflow_get', { job_id: created.job_id });
  assert.equal(inspected?.job?.state, 'EXECUTING');
  assert.ok(inspected?.plan?.plan_hash === planHash || inspected?.execution_plan?.plan_hash === planHash,
    'the dispatched workflow must retain the exact approved plan hash');
  console.log('PRODUCTION QA APPROVAL/DISPATCH/IMMUTABLE-PLAN NEXT-TASK PASS');
} catch (error) {
  console.error(`[production-behavioral-qa] ${error?.stack || error}`);
  console.error(`stdout=${stdout}`);
  console.error(`stderr=${stderr}`);
  process.exitCode = 1;
} finally {
  await shutdown();
  // This suite never shares a DB or workspace with the user installation.
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch (error) { console.error(`[production-behavioral-qa] isolated cleanup failed: ${error.message}`); process.exitCode = 1; }
}
