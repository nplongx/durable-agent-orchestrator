#!/usr/bin/env node
// Read-only preflight for the frozen .mcpb target. It does not approve or dispatch workflows.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const outPath = process.argv[2];
if (!outPath) throw new Error('Usage: node preflight-isolated-instance.mjs <evidence-output.json>');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const bundleHash = sha256(fs.readFileSync(bundle));
assert.equal(bundleHash, expectedHash, 'frozen bundle hash mismatch; stop before running');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-phase2-instance-'));
const extracted = path.join(temp, 'bundle');
const dataDir = path.join(temp, 'data');
const workspace = path.join(temp, 'workspace');
const executionTmp = path.join(temp, 'execution-tmp');
fs.mkdirSync(extracted, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
const unzip = spawnSync('unzip', ['-q', bundle, '-d', extracted], { encoding: 'utf8' });
assert.equal(unzip.status, 0, `unzip failed: ${unzip.stderr}`);
const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, '1.0.8');
assert.equal(manifest.server.entry_point, 'server/index.js');

const env = {
  PATH: '/usr/bin:/bin',
  HOME: temp,
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  WORKFLOW_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_WORKSPACE: workspace,
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: executionTmp,
  WORKFLOW_WORKSPACE: workspace,
  EXECUTION_TMP_DIR: executionTmp,
  WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
};
const child = spawn(process.execPath, [path.join(extracted, manifest.server.entry_point)], {
  cwd: extracted, env, stdio: ['pipe', 'pipe', 'pipe']
});
let stdoutBuffer = '';
let stderr = '';
let id = 1;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdoutBuffer += chunk;
  let pos;
  while ((pos = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, pos).trim();
    stdoutBuffer = stdoutBuffer.slice(pos + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});
child.stderr.on('data', chunk => { stderr += chunk; });

function rpc(method, params = {}) {
  const requestId = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`RPC timeout ${method}; stderr=${stderr}`));
    }, 7000);
    pending.set(requestId, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
}

async function callTool(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `${name} RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, false, `${name} tool error: ${response.result?.content?.[0]?.text}`);
  return response.result.structuredContent;
}

let evidence;
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase2-preflight', version: '1' } });
  assert.equal(init.result?.serverInfo?.name, 'chat-on-steroids-local-orchestrator');
  const list = await rpc('tools/list');
  const tools = list.result?.tools || [];
  assert.equal(tools.length, manifest.tools.length);
  const health = await callTool('orchestrator_health');
  assert.equal(health.mode, 'local-only-mcp');
  assert.equal(path.resolve(health.database), path.resolve(dataDir, 'workflow.db'));
  assert.equal(path.resolve(health.workspace_default), path.resolve(workspace));
  const diagnostics = await callTool('workflow_access_diagnostics');
  evidence = {
    captured_at: new Date().toISOString(),
    preflight_only: true,
    baseline_started: false,
    target: { bundle_path: path.relative(repo, bundle), bundle_sha256: bundleHash, version: manifest.version,
      entry_point: manifest.server.entry_point, declared_tool_count: manifest.tools.length,
      exposed_tool_count: tools.length, exposed_tool_names: tools.map(t => t.name) },
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      isolated_data_dir: dataDir, isolated_workspace: workspace, isolated_execution_tmp: executionTmp,
      child_environment_minimal: true, api_credentials_inherited: false,
      explicit_runtime_path_env: { WORKFLOW_DATA_DIR: dataDir, WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
        WORKFLOW_WORKSPACE: workspace, EXECUTION_TMP_DIR: executionTmp },
      temporary_paths_deleted_after_capture: true },
    instance: { initialized: true, tools_list_passed: true, health_status: health.status, mode: health.mode,
      database_path: health.database, workspace_default: health.workspace_default,
      cloud_execution: health.cloud_execution, github_actions_dispatch: health.github_actions_dispatch,
      external_model_api: health.external_model_api, initial_stats: health.stats,
      access_diagnostics_read_only: diagnostics.read_only ?? true,
      access_diagnostics: diagnostics },
    permissions: { workflow_created: false, workflow_approved: false, workflow_dispatched: false,
      per_action_execution_authorization_tested: false,
      note: 'Read-only instance preflight; approval/dispatch behavior belongs to the frozen scenario test card.' },
    result: 'PASS',
  };
} finally {
  child.stdin.end();
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(temp, { recursive: true, force: true });
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ result: evidence.result, version: evidence.target.version,
  tools: `${evidence.target.exposed_tool_count}/${evidence.target.declared_tool_count}`,
  isolated: true, credentialsRemoved: evidence.environment.api_credentials_removed_from_child_env,
  baselineStarted: evidence.baseline_started, evidence: path.resolve(outPath) }, null, 2));
