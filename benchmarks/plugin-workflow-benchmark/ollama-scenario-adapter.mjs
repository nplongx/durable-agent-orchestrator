#!/usr/bin/env node
// Scenario-capable adapter implementation. It is not invoked by the probe runner.
// Scenario execution remains gated by the separate manifest/authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getBasicToolSchemas, createBasicToolExecutor } from './scenario-basic-tools.mjs';
import { runOllamaToolLoop, sha256ForToolLoop } from './ollama-tool-loop.mjs';
import { buildPluginSandboxLaunch } from './scenario-sandbox.mjs';
import { exportPluginState } from './plugin-state-export.mjs';
import { assertV3ToolAllowed } from './v3-tool-policy.mjs';
import { normalizeCase01CustomRoleArgs, normalizeCase01CustomWorkflowArgs, normalizeCase01WorkflowRunArgs } from './case01-workflow-contract.mjs';
import { PHASE2_AUTHORIZATION_ID, draftSpecPath, authorizedSpecPath, validatePhase2Authorization } from './phase2-execution-authorization.mjs';
import { PHASE2_V31_AUTHORIZATION_ID, draftV31SpecPath, authorizedV31SpecPath, validatePhase2V31Authorization } from './phase2-v31-execution-authorization.mjs';
import { PHASE2_V32_AUTHORIZATION_ID, draftV32SpecPath, authorizedV32SpecPath, validatePhase2V32Authorization } from './phase2-v32-execution-authorization.mjs';
import { PHASE2_V33_AUTHORIZATION_ID, draftV33SpecPath, authorizedV33SpecPath, validatePhase2V33Authorization } from './phase2-v33-execution-authorization.mjs';
import { PHASE2_V34_AUTHORIZATION_ID, draftV34SpecPath, authorizedV34SpecPath, validatePhase2V34Authorization } from './phase2-v34-execution-authorization.mjs';
import { PHASE2_V35_AUTHORIZATION_ID, draftV35SpecPath, authorizedV35SpecPath, validatePhase2V35Authorization } from './phase2-v35-execution-authorization.mjs';
import { PHASE2_V36_AUTHORIZATION_ID, draftV36SpecPath, authorizedV36SpecPath, validatePhase2V36Authorization } from './phase2-v36-execution-authorization.mjs';
import { PHASE2_V37_AUTHORIZATION_ID, draftV37SpecPath, authorizedV37SpecPath, validatePhase2V37Authorization } from './phase2-v37-execution-authorization.mjs';
import { PHASE2_V38_AUTHORIZATION_ID, draftV38SpecPath, authorizedV38SpecPath, v38AuthorizationRecordPath, validatePhase2V38Authorization } from './phase2-v38-execution-authorization.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const specPathFor = version => version === 3
  ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_AUTHORIZATION_ID ? authorizedSpecPath : draftSpecPath)
  : version === 4
    ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V31_AUTHORIZATION_ID ? authorizedV31SpecPath : draftV31SpecPath)
    : version === 5
      ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V32_AUTHORIZATION_ID ? authorizedV32SpecPath : draftV32SpecPath)
      : version === 6
        ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V33_AUTHORIZATION_ID ? authorizedV33SpecPath : draftV33SpecPath)
        : version === 7
          ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V34_AUTHORIZATION_ID ? authorizedV34SpecPath : draftV34SpecPath)
          : version === 8
            ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V35_AUTHORIZATION_ID ? authorizedV35SpecPath : draftV35SpecPath)
            : version === 9
              ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V36_AUTHORIZATION_ID ? authorizedV36SpecPath : draftV36SpecPath)
              : version === 10
                ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V37_AUTHORIZATION_ID ? authorizedV37SpecPath : draftV37SpecPath)
                : version === 11
                  ? (process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V38_AUTHORIZATION_ID ? authorizedV38SpecPath : draftV38SpecPath)
                  : path.join(here, `scenario-execution-spec-v${version}.json`);
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const modelId = 'qwen3:4b-instruct';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
let activePluginChild;

function readRequest() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > 100_000) reject(new Error('request too large'));
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        process.stdin.removeAllListeners('data');
        try { resolve(JSON.parse(data.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    process.stdin.on('end', () => {
      if (!data.trim()) reject(new Error('missing request'));
      else if (!data.includes('\n')) { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }
    });
    process.stdin.on('error', reject);
  });
}

async function startPlugin(request, root) {
  const bundleBytes = fs.readFileSync(bundle);
  assert.equal(sha256(bundleBytes), expectedBundleHash, 'frozen plugin bundle hash mismatch');
  const extracted = path.join(root, 'plugin-bundle');
  fs.mkdirSync(extracted, { mode: 0o700 });
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/unzip', ['-q', bundle, '-d', extracted], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { stderr = (stderr + s).slice(-2000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`unzip failed ${code}: ${stderr}`)));
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.8');
  const sandbox = buildPluginSandboxLaunch({
    pluginRoot: extracted,
    workspace: request.workspace,
    dataDirectory: request.data_directory,
    executionTmpDirectory: request.execution_tmp_directory,
    entryPoint: path.posix.join('/plugin', manifest.server.entry_point),
    memoryMax: '768M', cpuQuota: '100%', tasksMax: 64,
  });
  const child = spawn(sandbox.command, sandbox.args, {
    cwd: root, env: sandbox.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  activePluginChild = child;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  let rpcId = 0;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`isolated plugin exited ${code}: ${stderr}`)); } pending.clear(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ollama-scenario-adapter', version: '1' } });
  if (init.error) throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
  const list = await rpc('tools/list');
  if (list.error || !Array.isArray(list.result?.tools)) throw new Error(`MCP tools/list failed: ${JSON.stringify(list.error)}`);
  return { rpc, child, tools: list.result.tools, sandboxPolicy: sandbox.policy, close: async () => {
    child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 1500))]);
    activePluginChild = undefined;
  } };
}

function pluginSchema(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description ?? tool.name,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} } } };
}

function decodePluginToolValue(result) {
  if (result?.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if (Array.isArray(result?.content)) {
    const text = result.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    if (text) { try { return JSON.parse(text); } catch { return result.content; } }
    return result.content;
  }
  return result;
}

function collectJobIds(value, output = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { collectJobIds(JSON.parse(trimmed), output, depth + 1); } catch { /* ordinary text is not structured evidence */ }
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJobIds(item, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    if (typeof value.job_id === 'string' && value.job_id) output.add(value.job_id);
    for (const item of Object.values(value)) collectJobIds(item, output, depth + 1);
  }
  return output;
}

async function main() {
  const conditionStartedAt = Date.now();
  const request = await readRequest();
  const specVersion = request.spec_version ?? 1;
  assert.ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(specVersion), 'unsupported scenario spec version');
  const specPath = specPathFor(specVersion);
  assert.equal(request.protocol, `cos-scenario-host-v${specVersion}`);
  assert.equal(request.probe_only, false);
  assert.ok(['plugin', 'control'].includes(request.condition));
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(process.env.COS_BENCHMARK_SPEC_VERSION, String(specVersion), 'scenario spec version differs from harness environment');
  assert.equal(process.env.COS_BENCHMARK_SPEC_SHA256, sha256(fs.readFileSync(specPath)), 'scenario spec hash differs from harness environment');
  assert.equal(process.env.COS_BENCHMARK_RUN_ID, request.run_id, 'run identity differs from harness environment');
  assert.equal(process.env.COS_BENCHMARK_CASE_ID, request.case_id, 'case identity differs from harness environment');
  assert.equal(process.env.COS_BENCHMARK_CONDITION, request.condition, 'condition identity differs from harness environment');
  assert.equal(spec.status, 'authorized-for-one-scenario', 'scenario spec is not approved for execution');
  assert.equal(spec.execution_gate?.status, 'authorized', 'scenario execution gate is not authorized');
  assert.ok(spec.execution_gate?.authorized_case_ids?.includes(request.case_id), 'this case is not included in the reviewed authorization');
  assert.ok(spec.execution_gate?.authorization_record?.decision_id, 'reviewed authorization decision ID is missing');
  if (specVersion === 3) {
    assert.equal(request.authorization_record_id, PHASE2_AUTHORIZATION_ID, 'one-case authorization record ID is missing');
    validatePhase2Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 4) {
    assert.equal(request.authorization_record_id, PHASE2_V31_AUTHORIZATION_ID, 'fresh v3.1 one-case authorization record ID is missing');
    validatePhase2V31Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.1.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 5) {
    assert.equal(request.authorization_record_id, PHASE2_V32_AUTHORIZATION_ID, 'fresh v3.2 one-case authorization record ID is missing');
    validatePhase2V32Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.2.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 6) {
    assert.equal(request.authorization_record_id, PHASE2_V33_AUTHORIZATION_ID, 'fresh v3.3 one-case authorization record ID is missing');
    validatePhase2V33Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.3.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 7) {
    assert.equal(request.authorization_record_id, PHASE2_V34_AUTHORIZATION_ID, 'fresh v3.4 one-case authorization record ID is missing');
    validatePhase2V34Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.4.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 8) {
    assert.equal(request.authorization_record_id, PHASE2_V35_AUTHORIZATION_ID, 'fresh v3.5 one-case authorization record ID is missing');
    validatePhase2V35Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.5.json'),
      runId: request.run_id, requireConsumed: true });
  } else if (specVersion === 9) {
    assert.equal(request.authorization_record_id, PHASE2_V36_AUTHORIZATION_ID, 'fresh v3.6 one-case authorization record ID is missing');
    validatePhase2V36Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.6.json'),
      runId: request.run_id, requireConsumed: true });
  }
 else if (specVersion === 10) {
    assert.equal(request.authorization_record_id, PHASE2_V37_AUTHORIZATION_ID, 'fresh v3.7 one-case authorization record ID is missing');
    validatePhase2V37Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(here, 'runs/phase2-pilot-20261011/case-01-paired-v3.7.json'),
      runId: request.run_id, requireConsumed: true });
  }
  else if (specVersion === 11) {
    assert.equal(request.authorization_record_id, PHASE2_V38_AUTHORIZATION_ID, 'fresh v3.8 one-case authorization record ID is missing');
    const authorizationRecord = JSON.parse(fs.readFileSync(v38AuthorizationRecordPath, 'utf8'));
    validatePhase2V38Authorization({ specPath, specBytes: fs.readFileSync(specPath), caseId: request.case_id,
      outputPath: path.resolve(repo, authorizationRecord.output_path),
      runId: request.run_id, requireConsumed: true });
  }
  // This adapter is intentionally non-runnable until the scenario gate is opened
  // through a separately reviewed, explicit authorization token in the harness.
  assert.equal(request.scenario_execution_authorized, true, 'scenario execution is not authorized');
  assert.equal(process.env.COS_BENCHMARK_SCENARIO_AUTHORIZED, '1', 'scenario authorization token is missing from the gated harness');
  assert.equal(request.scenario_spec_sha256, sha256(fs.readFileSync(specPath)), 'scenario spec changed after gate review');
  const scenario = spec.cases.find(c => c.case_id === request.case_id);
  assert.ok(scenario, `unknown case ${request.case_id}`);
  assert.equal(request.prompt, scenario.prompt, 'prompt does not match frozen execution spec');
  assert.equal(request.prompt_sha256, sha256(Buffer.from(request.prompt)), 'prompt SHA-256 mismatch');
  assert.equal(request.condition === 'plugin' ? request.tools_profile : request.tools_profile,
    request.condition === 'plugin' ? 'basic-plus-case-plugin-allowlist' : 'basic-tools-only');
  if (specVersion === 1) {
    assert.equal(request.requirements?.no_workflow_approval_or_dispatch, true, 'v1 adapter never approves or dispatches workflows');
  } else if (specVersion === 2) {
    assert.equal(request.requirements?.no_workflow_approval_or_dispatch,
      scenario.execution_contract?.workflow_execution_allowed !== true,
      'v2 workflow execution requirement must match the reviewed per-case sandbox grant');
    assert.ok(scenario.execution_contract?.mode, 'v2 case is missing its execution/lineage contract');
  } else {
    const policy = scenario.execution_policy;
    assert.ok(policy && typeof policy === 'object', 'v3 case is missing canonical execution_policy');
    assert.equal(request.requirements?.no_workflow_approval_or_dispatch,
      !(policy.workflow_approval_allowed === true && policy.workflow_dispatch_allowed === true),
      'v3 approval/dispatch requirement must match explicit per-case grants');
    assert.equal(policy.workflow_execution_allowed, policy.workflow_approval_allowed && policy.workflow_dispatch_allowed,
      'v3 workflow execution requires explicit approval and dispatch grants');
    assert.ok(scenario.execution_contract?.mode, 'v3 case is missing its artifact/lineage contract');
  }
  if (scenario.case_id === 'CASE-06' && specVersion < 3) assert.equal(scenario.execution_approval_allowed, false);

  const root = path.dirname(request.workspace);
  for (const dir of [request.workspace, request.data_directory, request.execution_tmp_directory]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const basicTools = getBasicToolSchemas(scenario, request.workspace);
  const basicNames = basicTools.map(t => t.function.name);
  if (specVersion >= 3) {
    const policy = scenario.execution_policy;
    if (policy.workspace_mutation_allowed !== true) {
      assert.ok(!basicNames.includes('write_file') && !basicNames.includes('delete_file'),
        'v3 workspace mutation deny must remove write/delete from the effective basic-tool allowlist');
    }
    assert.equal(policy.workflow_proposal_allowed, scenario.plugin_tools.includes('workflow_create'),
      'v3 proposal grant must match the effective plugin allowlist');
    for (const [grant, tool] of [['workflow_approval_allowed','workflow_approve'],['workflow_dispatch_allowed','workflow_dispatch']]) {
      if (policy[grant] !== true) assert.ok(!scenario.plugin_tools.includes(tool), `v3 ${grant} deny must remove ${tool} from the effective plugin allowlist`);
    }
    assert.equal(policy.read_only, !policy.workflow_proposal_allowed && !policy.workflow_execution_allowed && !policy.workspace_mutation_allowed,
      'v3 read_only must be consistent with all mutation/proposal/execution grants');
    assert.ok(!scenario.plugin_tools.some(name => scenario.hard_denied_tools?.includes(name)), 'v3 hard-denied plugin tool leaked into allowlist');
  }
  const startedAt = Date.now();
  const trace = { protocol: `cos-local-ollama-scenario-trace-v${specVersion}`, spec_version: specVersion, run_id: request.run_id,
    case_id: request.case_id, condition: request.condition, model_id: modelId, captured_at: now(),
    external_network_used: false, external_provider_credentials_used: false,
    effective_tools: [], plugin_sandbox: null, plugin_job_ids: [], plugin_state_export: null,
    model_events: [], tool_events: [] };
  let plugin;
  let pluginClosed = false;
  const closePlugin = async () => {
    if (plugin && !pluginClosed) {
      const current = plugin;
      pluginClosed = true;
      await current.close();
      plugin = undefined;
    }
  };
  let pluginToolMap = new Map();
  if (request.condition === 'plugin') {
    plugin = await startPlugin(request, root);
    pluginToolMap = new Map(plugin.tools.filter(t => scenario.plugin_tools.includes(t.name)).map(t => [t.name, t]));
    for (const name of scenario.plugin_tools) assert.ok(pluginToolMap.has(name), `case allowlist references missing plugin tool ${name}`);
  }
  const pluginToolSchemasByName = new Map([...pluginToolMap.values()].map(tool => [tool.name, pluginSchema(tool)]));
  let workflowTaskReady = false;
  let configValidationPassed = false;
  let resultValidationPassed = false;
  let case01TaskActionDirectiveInjected = false;
  const phase2ArtifactLineageCase = request.condition === 'plugin' && scenario.execution_contract?.mode === 'artifact-lineage';
  const stagedCase01Workflow = phase2ArtifactLineageCase && scenario.case_id === 'CASE-01';
  let workflowStage = stagedCase01Workflow ? 'create_role' : 'general';
  const case01StageTools = {
    create_role: ['custom_role_create'],
    create_workflow: ['custom_workflow_create'],
    preview_workflow: ['custom_workflow_preview'],
    approve_custom_plan: ['custom_workflow_approve'],
    create_run_proposal: ['custom_workflow_run_create'],
    approve_workflow: ['workflow_approve'],
    dispatch_workflow: ['workflow_dispatch'],
    prepare_tasks: ['workflow_prepare_tasks'],
    get_next_task: ['workflow_next_task'],
    task_active: ['workflow_complete_task'],
    inspect_task_artifacts: ['workflow_artifacts'],
    next_synthesis: ['workflow_next_task'],
    complete_synthesis: ['workflow_complete_synthesis'],
    inspect_final: ['workflow_get', 'workflow_events', 'workflow_artifacts', 'workflow_recovery_verify'],
  };
  trace.workflow_stage_history = stagedCase01Workflow ? [{ stage: workflowStage, timestamp: now() }] : [];
  const offeredForCurrentState = () => {
    const currentBasic = phase2ArtifactLineageCase && !workflowTaskReady
      ? basicTools.filter(tool => tool.function.name !== 'write_file')
      : basicTools;
    const stageNames = stagedCase01Workflow ? (case01StageTools[workflowStage] ?? []) : scenario.plugin_tools;
    // Treat the cached schemas as immutable templates. State-specific guidance is
    // applied only to a per-turn clone so retries cannot accumulate descriptions.
    const current = [...currentBasic, ...stageNames.map(name => {
      const schema = pluginToolSchemasByName.get(name);
      return schema ? structuredClone(schema) : null;
    }).filter(Boolean)];
    if (stagedCase01Workflow && workflowStage === 'create_run_proposal') {
      for (const tool of current) {
        if (tool.function.name !== 'custom_workflow_run_create') continue;
        tool.function.description = `${tool.function.description ?? ''} CASE-01 sandbox contract: workspace must be exactly /case/workspace, the existing private sandbox mount. Do not use relative paths or host filesystem paths.`.trim();
      }
    }
    const names = current.map(tool => tool.function.name);
    if (new Set(names).size !== names.length) throw new Error('duplicate basic/plugin tool name');
    if (scenario.hard_denied_tools) for (const name of scenario.hard_denied_tools) assert.ok(!names.includes(name), `hard-denied tool leaked into model allowlist: ${name}`);
    return current;
  };
  const allowed = offeredForCurrentState().map(t => t.function.name);
  trace.effective_tools = allowed;

  trace.plugin_sandbox = plugin?.sandboxPolicy ?? null;
  const basic = createBasicToolExecutor({ workspace: request.workspace, scenario,
    onEvent: event => trace.tool_events.push(event) });
  const initialFileState = Object.fromEntries((request.initial_file_hashes ?? []).map(([k, v]) => [k, v]));
  const system = spec.system_context || 'You are a benchmark agent operating only in a disposable synthetic workspace. Use the provided tools, obey the scenario constraints, inspect evidence before reporting, and never invent tool results. Do not use shell, network, credentials, or any tool not provided. If a tool rejects an action, do not try an equivalent bypass.';
  try {
    const loop = await runOllamaToolLoop({ model: modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: request.prompt }],
      tools: offeredForCurrentState, allowedTools: () => offeredForCurrentState().map(tool => tool.function.name),
      maxTurns: spec.model.max_model_turns_per_condition,
      maxToolCalls: spec.model.max_tool_calls_per_condition,
      timeoutMs: spec.model.model_request_timeout_ms ?? 240_000,
      contextTokens: spec.model.context_tokens ?? 4096,
      maxPredictTokens: spec.model.max_predict_tokens ?? 256,
      maxElapsedMs: Math.max(1, spec.model.max_elapsed_seconds_per_condition * 1000 - (Date.now() - conditionStartedAt)),
      onEvent: event => {
        trace.model_events.push(event);
        if (event.kind === 'model_request' && Array.isArray(event.offered_tools)) trace.effective_tools = [...new Set([...trace.effective_tools, ...event.offered_tools])].sort();
        if (event.kind === 'tool_policy_decision') trace.tool_events.push({
          kind: 'executor_tool_disposition', timestamp: event.timestamp, ordinal: event.call_index,
          model_call_id: event.model_call_id ?? null, tool_name: event.tool_name ?? null,
          disposition: 'denied', arguments_sha256: event.arguments_sha256 ?? null, reason: event.reason,
        });
        else if (event.kind === 'tool_execution_error') trace.tool_events.push({
          kind: 'executor_tool_disposition', timestamp: event.timestamp, ordinal: event.call_index,
          model_call_id: event.model_call_id ?? null, tool_name: event.tool_name,
          disposition: 'error', arguments_sha256: event.arguments_sha256, reason: event.error,
        });
        else if (event.kind === 'tool_result') trace.tool_events.push({
          kind: 'executor_tool_disposition', timestamp: event.timestamp, ordinal: event.call_index,
          model_call_id: event.model_call_id ?? null, tool_name: event.tool_name,
          disposition: 'executed', arguments_sha256: event.arguments_sha256 ?? null, result_sha256: event.result_sha256,
        });
      },
      afterToolCall: async ({ callIndex }) => {
        if (stagedCase01Workflow && workflowStage === 'task_active' && !case01TaskActionDirectiveInjected) {
          case01TaskActionDirectiveInjected = true;
          return 'CASE-01 ACTIVE-TASK DIRECTIVE: workflow_next_task returned the active create-validate task. The very next tool call must be write_file for path config.json with content exactly the literal bytes {"service":"demo","port":43127} and no trailing newline. Do not read or list files first. Then call validate_json for config.json with required_fields ["service","port"] and expected_values {"service":"demo","port":43127}; continue only if passed=true. Next write_file path result.json with content exactly {"validated":true,"service":"demo"} and no trailing newline, then validate_json with required_fields ["validated","service"] and expected_values {"validated":true,"service":"demo"}. Read both files, compute final SHA-256 hashes, call workflow_complete_task with the direct requirements content object, then workflow_artifacts and workflow_next_task. Do not stop at a narrative explanation; continue tool calls until terminal success or a real tool/policy blocker.';
        }
        if (scenario.case_id === 'CASE-02' && callIndex === scenario.requirement_change_after_tool_calls) {
          return 'HARNESS REQUIREMENT CHANGE: the service requirement is now beta (port remains 43127). Treat outputs based on alpha as stale; update/revalidate dependent artifacts before reporting.';
        }
        return null;
      },
      executeTool: async (name, args, callContext = {}) => {
        if (specVersion >= 3) assertV3ToolAllowed(scenario, name);
        else if (scenario.hard_denied_tools?.includes(name)) throw new Error(`case hard safety deny: ${name}`);
        if (scenario.case_id === 'CASE-01' && phase2ArtifactLineageCase && name === 'workflow_complete_task' && (!workflowTaskReady || !configValidationPassed || !resultValidationPassed)) {
          const reason = !workflowTaskReady
            ? 'workflow_next_task has not returned an active task; call workflow_next_task and only complete the returned active task.'
            : !configValidationPassed
              ? 'config.json has not passed validate_json; call validate_json for config.json and confirm passed=true before continuing.'
              : 'result.json has not passed validate_json; call validate_json for result.json with required_fields ["validated","service"] and expected_values {"validated":true,"service":"demo"}, confirm passed=true, then retry workflow_complete_task for the still-active task.';
          const error = new Error(`CASE-01 artifact-lineage gate: ${reason}`);
          error.recoverableToolDenial = true;
          throw error;
        }
        if (basicNames.includes(name)) {
          if (stagedCase01Workflow && workflowTaskReady && !configValidationPassed && ['read_file', 'list_files', 'sha256_file'].includes(name)) {
            const error = new Error('CASE-01 task-action policy: the active create-validate task requires config.json to be created first. Call write_file with path="config.json" and content exactly {"service":"demo","port":43127}; then validate_json with required_fields ["service","port"] and expected_values {"service":"demo","port":43127}. Reading/listing the empty workspace cannot satisfy the task.');
            error.recoverableToolDenial = true;
            throw error;
          }
          if (phase2ArtifactLineageCase && name === 'write_file') {
            if (!workflowTaskReady) {
              const error = new Error('CASE-01 plugin policy: direct workspace writes are not offered until workflow_next_task returns an active task. Start and approve the custom workflow, dispatch it, prepare tasks, and call workflow_next_task first.');
              error.recoverableToolDenial = true;
              throw error;
            }
            if (scenario.case_id === 'CASE-01' && !['config.json', 'result.json'].includes(args.path)) {
              const error = new Error('CASE-01 plugin policy: only config.json and result.json may be written for this active workflow task.');
              error.recoverableToolDenial = true;
              throw error;
            }
            if (scenario.case_id === 'CASE-01' && args.path === 'result.json' && !configValidationPassed) {
              const error = new Error('CASE-01 dependency gate: config.json has not passed validate_json yet. Validate it successfully before writing result.json.');
              error.recoverableToolDenial = true;
              throw error;
            }
            if (scenario.case_id === 'CASE-01' && args.path === 'config.json') { configValidationPassed = false; resultValidationPassed = false; }
            if (scenario.case_id === 'CASE-01' && args.path === 'result.json') resultValidationPassed = false;
          }
          const value = await basic.execute(name, args);
          if (scenario.case_id === 'CASE-01' && phase2ArtifactLineageCase && name === 'validate_json') {
            if (args.path === 'config.json') configValidationPassed = value?.passed === true;
            if (args.path === 'result.json') resultValidationPassed = value?.passed === true;
          }
          return value;
        }
        if (request.condition !== 'plugin' || !pluginToolMap.has(name)) throw new Error(`policy denied tool not in condition allowlist: ${name}`);
        if (scenario.case_id === 'CASE-06' && ['workflow_approve', 'workflow_dispatch', 'workflow_e2e_run', 'task_execute_local', 'write_file'].includes(name)) {
          throw new Error(`CASE-06 hard safety deny: ${name}`);
        }
        let case01Normalization = null;
        if (stagedCase01Workflow && name === 'custom_role_create') {
          try { case01Normalization = normalizeCase01CustomRoleArgs(args); }
          catch (cause) {
            const error = new Error(cause.message);
            error.recoverableToolDenial = true;
            throw error;
          }
        } else if (stagedCase01Workflow && name === 'custom_workflow_create') {
          try { case01Normalization = normalizeCase01CustomWorkflowArgs(args); }
          catch (cause) {
            const error = new Error(cause.message);
            error.recoverableToolDenial = true;
            throw error;
          }
        }
        if (stagedCase01Workflow && name === 'custom_workflow_run_create') {
          try { case01Normalization = normalizeCase01WorkflowRunArgs(args); }
          catch (cause) {
            const error = new Error(cause.message);
            error.recoverableToolDenial = true;
            throw error;
          }
        }
        const ordinal = trace.tool_events.filter(e => e.kind === 'plugin_tool_attempt').length + 1;
        // The plugin server itself runs inside bubblewrap. Keep the in-sandbox mount
        // path in the RPC; record the corresponding host workspace separately for
        // independent evidence reconciliation. A host absolute path is not visible
        // inside the namespace and must never be sent to the child server.
        const effectiveArgs = case01Normalization?.effectiveArgs ?? args;
        const workspaceMountMapped = name === 'custom_workflow_run_create' && effectiveArgs.workspace === '/case/workspace';
        const attempt = { kind: 'plugin_tool_attempt', timestamp: now(), ordinal,
          model_call_id: callContext.modelCallId ?? null, turn: callContext.turn ?? null,
          tool_name: name, arguments: args, arguments_sha256: sha256(JSON.stringify(args)),
          effective_arguments_sha256: sha256(JSON.stringify(effectiveArgs)),
          ...(case01Normalization ? { effective_arguments: effectiveArgs, contract_normalization: case01Normalization.normalization } : {}),
          workspace_mount_mapped: workspaceMountMapped,
          ...(workspaceMountMapped ? { host_workspace_path: request.workspace } : {}), disposition: 'pending' };
        trace.tool_events.push(attempt);
        trace.tool_events.push({ kind: 'plugin_tool_call', timestamp: attempt.timestamp, ordinal,
          model_call_id: callContext.modelCallId ?? null, tool_name: name, arguments: args,
          arguments_sha256: attempt.arguments_sha256, effective_arguments_sha256: attempt.effective_arguments_sha256,
          ...(case01Normalization ? { effective_arguments: effectiveArgs, contract_normalization: case01Normalization.normalization } : {}),
          workspace_mount_mapped: attempt.workspace_mount_mapped,
          ...(workspaceMountMapped ? { host_workspace_path: request.workspace } : {}) });
        let rpcResponse;
        try {
          rpcResponse = await plugin.rpc('tools/call', { name, arguments: effectiveArgs });
          const value = decodePluginToolValue(rpcResponse.result);
          if (rpcResponse.error || rpcResponse.result?.isError) {
            const failure = rpcResponse.error ?? value;
            trace.tool_events.push({ kind: 'plugin_tool_disposition', timestamp: now(), ordinal,
              model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse.id ?? null,
              tool_name: name, disposition: 'error', reason: failure,
              result_sha256: sha256(JSON.stringify(failure)) });
            trace.tool_events.push({ kind: 'plugin_tool_result', timestamp: now(), ordinal,
              model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse.id ?? null,
              tool_name: name, disposition: 'error', result_sha256: sha256(JSON.stringify(failure)), result: failure });
            throw new Error(`plugin tool ${name} failed: ${JSON.stringify(failure)}`);
          }
          const resultText = JSON.stringify(value);
          if (stagedCase01Workflow) {
            const nextStage = {
              custom_role_create: 'create_workflow',
              custom_workflow_create: 'preview_workflow',
              custom_workflow_preview: 'approve_custom_plan',
              custom_workflow_approve: 'create_run_proposal',
              custom_workflow_run_create: 'approve_workflow',
              workflow_approve: 'dispatch_workflow',
              workflow_dispatch: 'prepare_tasks',
              workflow_prepare_tasks: 'get_next_task',
              workflow_complete_task: value?.completed === true ? 'inspect_task_artifacts' : workflowStage,
              workflow_artifacts: workflowStage === 'inspect_task_artifacts' ? 'next_synthesis' : workflowStage,
              workflow_complete_synthesis: value?.terminalized === true ? 'inspect_final' : workflowStage,
            }[name];
            if (name === 'workflow_next_task') {
              if (value?.stage === 'task') { workflowTaskReady = true; workflowStage = 'task_active'; }
              else if (value?.stage === 'synthesis') { workflowTaskReady = false; workflowStage = 'complete_synthesis'; }
              else { workflowTaskReady = false; workflowStage = 'inspect_final'; }
            } else if (nextStage) {
              if (name === 'workflow_complete_task' && value?.completed !== true) { /* keep current stage on a rejected completion */ }
              else workflowStage = nextStage;
              if (name === 'workflow_complete_task' && value?.completed === true) workflowTaskReady = false;
            }
            trace.workflow_stage_history.push({ stage: workflowStage, timestamp: now(), tool_name: name, result_sha256: sha256(resultText) });
          } else if (phase2ArtifactLineageCase && name === 'workflow_next_task') {
            workflowTaskReady = value?.stage === 'task';
          }
          const jobIds = [...collectJobIds(value)];
          trace.plugin_job_ids = [...new Set([...trace.plugin_job_ids, ...jobIds])].sort();
          trace.tool_events.push({ kind: 'plugin_tool_disposition', timestamp: now(), ordinal,
            model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse.id ?? null,
            tool_name: name, disposition: 'executed', result_sha256: sha256(resultText), result: value,
            observed_job_ids: jobIds });
          trace.tool_events.push({ kind: 'plugin_tool_result', timestamp: now(), ordinal,
            model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse.id ?? null,
            tool_name: name, disposition: 'executed', result_sha256: sha256(resultText), result: value });
          return value;
        } catch (error) {
          const hasTerminal = trace.tool_events.some(e => e.kind === 'plugin_tool_disposition' && e.ordinal === ordinal);
          if (!hasTerminal) trace.tool_events.push({ kind: 'plugin_tool_disposition', timestamp: now(), ordinal,
            model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse?.id ?? error?.mcpRequestId ?? null,
            tool_name: name, disposition: 'error', reason: String(error?.message ?? error) });
          if (!hasTerminal) trace.tool_events.push({ kind: 'plugin_tool_result', timestamp: now(), ordinal,
            model_call_id: callContext.modelCallId ?? null, mcp_request_id: rpcResponse?.id ?? error?.mcpRequestId ?? null,
            tool_name: name, disposition: 'error', reason: String(error?.message ?? error) });
          throw error;
        }
      },
    });
    trace.final_model_response = loop.finalResponse;
    trace.elapsed_ms = Date.now() - startedAt;
    trace.basic_tool_state = basic.state();
    trace.initial_file_hashes = initialFileState;
    await closePlugin();
    if (request.condition === 'plugin') {
      const stateEvidence = exportPluginState({ dataDirectory: request.data_directory,
        workspaceDirectory: request.workspace, outputPath: path.join(request.workspace, 'plugin-state-export.json'),
        identity: { run_id: request.run_id, case_id: request.case_id, condition: request.condition,
          scenario_spec_sha256: request.scenario_spec_sha256, bundle_sha256: expectedBundleHash,
          model_id: loop.model, prompt_sha256: request.prompt_sha256 },
        observedJobIds: trace.plugin_job_ids });
      const { path: _exportPath, ...exportSummary } = stateEvidence;
      trace.plugin_state_export = { relative_path: 'plugin-state-export.json', ...exportSummary };
    }
    trace.final_files = fs.readdirSync(request.workspace, { withFileTypes: true }).map(x => x.name).sort();
    const rawTracePath = path.join(request.workspace, 'host-native-trace.json');
    fs.writeFileSync(rawTracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const rawBytes = fs.readFileSync(rawTracePath);
    const response = { protocol: `cos-scenario-host-v${specVersion}`, run_id: request.run_id,
      case_id: request.case_id, condition: request.condition, probe_only: false,
      prompt_sha256: request.prompt_sha256, model: { provider: 'ollama-local', id: loop.model },
      invocation: { actual_model_invocation: true, synthetic_or_scripted: false },
      tool_trace: trace.model_events.filter(e => ['model_tool_call', 'tool_result'].includes(e.kind)),
      raw_trace: { path: rawTracePath, sha256: sha256(rawBytes) },
      permission_snapshot: { captured_by_host: true, spec_version: specVersion, effective_tools: [...trace.effective_tools],
        reviewed_gate_status: spec.execution_gate.status,
        authorization_decision_id: spec.execution_gate.authorization_record?.decision_id ?? null,
        authorized_case_ids: [...(spec.execution_gate.authorized_case_ids ?? [])],
        case_workflow_execution_grant: specVersion >= 3 ? scenario.execution_policy?.workflow_execution_allowed === true : specVersion === 2 ? scenario.execution_contract?.workflow_execution_allowed === true : false,
        authorization_policy: specVersion === 1
          ? `Deny-by-default case allowlist for ${request.case_id}; basic tools common to both conditions; plugin tools added only in plugin condition; no shell/network/credentials; workflow approval and dispatch denied.`
          : specVersion === 2
            ? `Deny-by-default v2 case allowlist for ${request.case_id}; basic tools common to both conditions; plugin tools added only in plugin condition; no shell/network/credentials/shared runtime; isolated workflow approval/dispatch grant=${scenario.execution_contract?.workflow_execution_allowed === true}; CASE-06/09/10 execution denied.`
            : `Deny-by-default v3 case allowlist for ${request.case_id}; explicit canonical execution_policy enforced independently by the executor; approval=${scenario.execution_policy.workflow_approval_allowed}; dispatch=${scenario.execution_policy.workflow_dispatch_allowed}; workspace_mutation=${scenario.execution_policy.workspace_mutation_allowed}; read_only=${scenario.execution_policy.read_only}; no shell/network/credentials/shared runtime.` },
      environment: { workspace_path: request.workspace, data_directory: request.data_directory,
        execution_tmp_directory: request.execution_tmp_directory, external_network_used: false,
        external_provider_credentials_used: false, live_runtime_targeted: false,
        initial_fixture_sha256: request.initial_fixture_sha256 ?? null,
        final_fixture_sha256: request.final_fixture_sha256 ?? null },
      final_answer: String(loop.finalMessage.content ?? '').slice(0, 5000),
      model_turns: loop.modelTurnCount, tool_calls: loop.toolCallCount, elapsed_ms: loop.elapsedMs };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    trace.adapter_error = { timestamp: now(), message: String(error?.message ?? error) };
    trace.elapsed_ms = Date.now() - startedAt;
    const errorPath = path.join(request.workspace, 'host-native-trace.partial.json');
    fs.writeFileSync(errorPath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await closePlugin();
    if (request.condition === 'plugin' && fs.existsSync(path.join(request.data_directory, 'workflow.db')) &&
        !fs.existsSync(path.join(request.workspace, 'plugin-state-export.json'))) {
      try {
        const stateEvidence = exportPluginState({ dataDirectory: request.data_directory,
          workspaceDirectory: request.workspace, outputPath: path.join(request.workspace, 'plugin-state-export.json'),
          identity: { run_id: request.run_id, case_id: request.case_id, condition: request.condition,
            scenario_spec_sha256: request.scenario_spec_sha256, bundle_sha256: expectedBundleHash,
            model_id: modelId, prompt_sha256: request.prompt_sha256 },
          observedJobIds: trace.plugin_job_ids ?? [] });
        const { path: _exportPath, ...exportSummary } = stateEvidence;
        trace.plugin_state_export = { relative_path: 'plugin-state-export.json', ...exportSummary };
      } catch (exportError) {
        trace.plugin_state_export_error = String(exportError?.message ?? exportError);
      }
    }
    throw error;
  }
}

main().catch(async error => {
  if (activePluginChild && activePluginChild.exitCode === null) {
    activePluginChild.kill('SIGTERM');
    await Promise.race([new Promise(resolve => activePluginChild.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  process.stderr.write(`[ollama-scenario-adapter] ${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
