#!/usr/bin/env node
// Local-only paired host adapter for the benign Phase 2 host-contract probe.
// It exposes exactly one read-only function per condition and fails closed if
// Ollama does not emit a native function call. It never approves/dispatches work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const MODEL_ID = 'qwen3:4b-instruct';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
let activePluginChild;

function log(message) { process.stderr.write(`[ollama-paired-host] ${message}\n`); }
function readRequest() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
      if (text.length > 100_000) reject(new Error('request exceeds size limit'));
      const index = text.indexOf('\n');
      if (index >= 0) {
        process.stdin.removeAllListeners('data');
        try { resolve(JSON.parse(text.slice(0, index))); } catch (error) { reject(error); }
      }
    });
    process.stdin.on('end', () => {
      if (!text.trim()) reject(new Error('missing request line'));
      else if (!text.includes('\n')) {
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      }
    });
    process.stdin.on('error', reject);
  });
}

async function ollamaChat(messages, tools) {
  const body = { model: MODEL_ID, stream: false, think: false,
    options: { temperature: 0, num_ctx: 4096, num_predict: 128 }, messages };
  if (tools) body.tools = tools;
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`local Ollama HTTP ${response.status}: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text);
  if (parsed.model !== MODEL_ID) throw new Error(`unexpected model identity: ${String(parsed.model)}`);
  return parsed;
}

function startPluginServer(root, request) {
  const bytes = fs.readFileSync(bundle);
  assert.equal(sha256(bytes), expectedBundleHash, 'frozen plugin bundle SHA-256 mismatch');
  const extracted = path.join(root, 'plugin-bundle');
  fs.mkdirSync(extracted, { mode: 0o700 });
  const unzip = spawn('/usr/bin/unzip', ['-q', bundle, '-d', extracted], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    unzip.stderr.setEncoding('utf8'); unzip.stderr.on('data', s => { stderr += s; });
    unzip.once('error', reject);
    unzip.once('close', code => {
      if (code !== 0) return reject(new Error(`unzip failed (${code}): ${stderr.slice(-1000)}`));
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, '1.0.8');
        const dataDir = request.data_directory;
        const workspace = request.workspace;
        const executionTmp = request.execution_tmp_directory;
        for (const dir of [dataDir, workspace, executionTmp]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const child = spawn(process.execPath, [path.join(extracted, manifest.server.entry_point)], {
          cwd: extracted,
          env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC',
            CHAT_ON_STEROIDS_DATA_DIR: dataDir, CHAT_ON_STEROIDS_WORKSPACE: workspace,
            CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: executionTmp, WORKFLOW_DB: path.join(dataDir, 'workflow.db') },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        resolve({ child, dataDir, workspace, executionTmp, extracted });
      } catch (error) { reject(error); }
    });
  });
}

function makeRpc(client) {
  let id = 0;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  client.child.stdout.setEncoding('utf8');
  client.child.stderr.setEncoding('utf8');
  client.child.stdout.on('data', chunk => {
    buffer += chunk;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
      }
    }
  });
  client.child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  client.child.once('exit', code => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited ${code}; ${stderr}`)); }
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP RPC timeout: ${method}`)); }, 10_000);
    pending.set(requestId, { resolve, reject, timer });
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
}

async function main() {
  const request = await readRequest();
  assert.equal(request.protocol, 'cos-paired-host-v1');
  assert.ok(['plugin', 'control'].includes(request.condition));
  assert.equal(request.probe_only, true, 'this adapter is limited to probe-only requests');
  assert.equal(request.requirements?.no_workflow_approval_or_dispatch, true);
  assert.equal(request.tools_profile, request.condition === 'plugin' ? 'frozen-plugin-bundle' : 'basic-tools-only');
  assert.equal(sha256(Buffer.from(request.prompt, 'utf8')), request.prompt_sha256, 'prompt SHA-256 mismatch');
  const root = path.dirname(request.workspace);
  assert.equal(path.dirname(request.data_directory), root);
  assert.equal(path.dirname(request.execution_tmp_directory), root);
  assert.ok(fs.realpathSync(request.workspace).startsWith(fs.realpathSync(root) + path.sep));
  assert.equal(sha256(fs.readFileSync(request.fixture_path)), request.fixture_sha256);

  const trace = { protocol: 'cos-local-ollama-native-trace-v1', run_id: request.run_id,
    condition: request.condition, captured_at: now(), model_id: MODEL_ID,
    external_provider_credentials_used: false, external_network_used: false,
    model_events: [], tool_events: [], notes: ['Ollama is contacted only via loopback 127.0.0.1:11434.'] };
  let mcpClient;
  let mcpRpc;
  let effectiveTools;
  let policy;
  let toolDefinition;

  if (request.condition === 'plugin') {
    mcpClient = await startPluginServer(root, request);
    activePluginChild = mcpClient.child;
    mcpRpc = makeRpc(mcpClient);
    const init = await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'ollama-paired-host-adapter', version: '1' } });
    assert.equal(init.error, undefined, `MCP initialize failed: ${JSON.stringify(init.error)}`);
    const listed = await mcpRpc('tools/list');
    const health = listed.result?.tools?.find(t => t.name === 'orchestrator_health');
    assert.ok(health, 'frozen bundle does not expose orchestrator_health');
    // Do not expose any other plugin function to the model, even though the bundle has 33.
    effectiveTools = ['orchestrator_health'];
    policy = 'Probe-only allowlist: only orchestrator_health is exposed to the model; all other plugin tools are denied by adapter policy. No approval/dispatch calls.';
    toolDefinition = [{ type: 'function', function: { name: 'orchestrator_health',
      description: 'Read-only check of this isolated plugin instance health and SQLite state; does not probe remote services.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }];
    trace.plugin_server = { bundle_sha256: expectedBundleHash, bundle_version: '1.0.8',
      discovered_tool_count: listed.result.tools.length, model_visible_tool_names: effectiveTools };
  } else {
    effectiveTools = ['read_fixture'];
    policy = 'Probe-only allowlist: read_fixture may read only the exact harness-created synthetic fixture path; no writes, subprocess tools, network tools, or plugin tools are exposed.';
    toolDefinition = [{ type: 'function', function: { name: 'read_fixture',
      description: 'Read the provided synthetic benchmark fixture by its exact absolute path. This tool is read-only and rejects any other path.',
      parameters: { type: 'object', properties: { path: { type: 'string', enum: [request.fixture_path], description: `Required exact path: ${request.fixture_path}` } },
        required: ['path'], additionalProperties: false } } }];
  }

  const system = 'You are operating in a read-only benchmark host probe. Use one available tool to inspect the isolated environment. Do not invent tool results. After receiving the result, summarize it briefly. Do not perform any other action.';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: request.prompt }];
  const modelCallAt = now();
  const modelResponse = await ollamaChat(messages, toolDefinition);
  trace.model_events.push({ kind: 'model_request', timestamp: modelCallAt, model: modelResponse.model,
    prompt_sha256: request.prompt_sha256, tools_offered: effectiveTools, messages });
  trace.model_events.push({ kind: 'model_response', timestamp: now(), response: modelResponse });
  const modelMessage = modelResponse.message;
  const calls = modelMessage?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) throw new Error(`expected exactly one native model tool call; got ${Array.isArray(calls) ? calls.length : 0}`);
  const call = calls[0];
  const name = call.function?.name;
  const toolArgs = call.function?.arguments ?? {};
  if (!effectiveTools.includes(name)) throw new Error(`model requested a tool outside the effective allowlist: ${String(name)}`);
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) throw new Error('model tool arguments must be an object');

  const callEvent = { kind: 'model_tool_call', native: true, tool_name: name, arguments: toolArgs, timestamp: now() };
  let toolResult;
  if (request.condition === 'plugin') {
    if (Object.keys(toolArgs).length !== 0) throw new Error('orchestrator_health accepts no arguments');
    const rpcResponse = await mcpRpc('tools/call', { name: 'orchestrator_health', arguments: {} });
    if (rpcResponse.error || rpcResponse.result?.isError) throw new Error(`plugin health tool failed: ${JSON.stringify(rpcResponse.error ?? rpcResponse.result)}`);
    toolResult = rpcResponse.result?.structuredContent ?? rpcResponse.result?.content ?? rpcResponse.result;
    trace.tool_events.push({ kind: 'mcp_tools_call_request', timestamp: now(), method: 'tools/call', name, arguments: toolArgs });
    trace.tool_events.push({ kind: 'mcp_tools_call_response', timestamp: now(), response: rpcResponse });
  } else {
    if (name !== 'read_fixture' || toolArgs.path !== request.fixture_path) throw new Error(`control tool may read only the exact synthetic fixture path; observed arguments=${JSON.stringify(toolArgs)}`);
    const bytes = fs.readFileSync(request.fixture_path);
    if (sha256(bytes) !== request.fixture_sha256) throw new Error('fixture hash changed before control read');
    toolResult = { path: request.fixture_path, content: bytes.toString('utf8'), sha256: sha256(bytes), read_only: true };
    trace.tool_events.push({ kind: 'basic_tool_call', timestamp: now(), name, arguments: toolArgs });
    trace.tool_events.push({ kind: 'basic_tool_result', timestamp: now(), result: toolResult });
  }
  const resultBytes = Buffer.from(JSON.stringify(toolResult));
  const resultEvent = { kind: 'tool_result', native: true, tool_name: name,
    result_sha256: sha256(resultBytes), timestamp: now() };
  trace.tool_events.push({ ...callEvent });
  trace.tool_events.push({ ...resultEvent });

  const roundTripMessages = [...messages, modelMessage,
    { role: 'tool', tool_name: name, content: JSON.stringify(toolResult) }];
  const followupAt = now();
  const followup = await ollamaChat(roundTripMessages, undefined);
  if (Array.isArray(followup.message?.tool_calls) && followup.message.tool_calls.length) {
    throw new Error('model attempted an additional tool call after the one-call probe result');
  }
  trace.model_events.push({ kind: 'model_followup_request', timestamp: followupAt, messages: roundTripMessages });
  trace.model_events.push({ kind: 'model_followup_response', timestamp: now(), response: followup });

  if (sha256(fs.readFileSync(request.fixture_path)) !== request.fixture_sha256) throw new Error('fixture changed during probe');
  const rawTracePath = path.join(request.workspace, 'host-native-trace.json');
  fs.writeFileSync(rawTracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const rawTraceBytes = fs.readFileSync(rawTracePath);
  const result = {
    protocol: 'cos-paired-host-v1', run_id: request.run_id, condition: request.condition,
    probe_only: true, prompt_sha256: request.prompt_sha256,
    model: { provider: 'ollama-local', id: modelResponse.model },
    invocation: { actual_model_invocation: true, synthetic_or_scripted: false },
    tool_trace: [callEvent, resultEvent],
    raw_trace: { path: rawTracePath, sha256: sha256(rawTraceBytes) },
    permission_snapshot: { captured_by_host: true, effective_tools: effectiveTools, authorization_policy: policy },
    environment: { workspace_path: request.workspace, data_directory: request.data_directory,
      execution_tmp_directory: request.execution_tmp_directory, external_network_used: false,
      external_provider_credentials_used: false, live_runtime_targeted: false,
      initial_fixture_sha256: request.fixture_sha256,
      final_fixture_sha256: sha256(fs.readFileSync(request.fixture_path)) },
    observed_tool_result_summary: String(followup.message?.content ?? '').slice(0, 500),
  };
  if (mcpClient?.child) {
    mcpClient.child.stdin.end();
    await new Promise(resolve => {
      if (mcpClient.child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { mcpClient.child.kill('SIGTERM'); resolve(); }, 1500);
      mcpClient.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    activePluginChild = undefined;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(async error => {
  if (activePluginChild && activePluginChild.exitCode === null) {
    activePluginChild.kill('SIGTERM');
    await Promise.race([new Promise(resolve => activePluginChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  log(error?.stack ?? String(error));
  process.exitCode = 1;
});
