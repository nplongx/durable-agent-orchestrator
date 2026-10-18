#!/usr/bin/env node
// Gated paired scenario runner. Without --authorize-scenario-execution it does
// not create workspaces, contact Ollama, launch the plugin, or issue prompts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createScenarioWorkspace } from './scenario-basic-tools.mjs';
import { verifyScenario } from './scenario-verifiers.mjs';
import { verifyPluginStateExport } from './plugin-state-export.mjs';
import { verifyExecutorTrace } from './trace-integrity.mjs';
import { verifyPluginArtifactLineage } from './plugin-artifact-lineage.mjs';
import { PHASE2_AUTHORIZATION_ID, draftSpecPath, authorizedSpecPath, validatePhase2Authorization, consumePhase2Authorization } from './phase2-execution-authorization.mjs';
import { PHASE2_V31_AUTHORIZATION_ID, draftV31SpecPath, authorizedV31SpecPath, validatePhase2V31Authorization, consumePhase2V31Authorization } from './phase2-v31-execution-authorization.mjs';
import { PHASE2_V32_AUTHORIZATION_ID, draftV32SpecPath, authorizedV32SpecPath, validatePhase2V32Authorization, consumePhase2V32Authorization } from './phase2-v32-execution-authorization.mjs';
import { PHASE2_V33_AUTHORIZATION_ID, draftV33SpecPath, authorizedV33SpecPath, validatePhase2V33Authorization, consumePhase2V33Authorization } from './phase2-v33-execution-authorization.mjs';
import { PHASE2_V34_AUTHORIZATION_ID, draftV34SpecPath, authorizedV34SpecPath, validatePhase2V34Authorization, consumePhase2V34Authorization } from './phase2-v34-execution-authorization.mjs';
import { PHASE2_V35_AUTHORIZATION_ID, draftV35SpecPath, authorizedV35SpecPath, validatePhase2V35Authorization, consumePhase2V35Authorization } from './phase2-v35-execution-authorization.mjs';
import { PHASE2_V36_AUTHORIZATION_ID, draftV36SpecPath, authorizedV36SpecPath, validatePhase2V36Authorization, consumePhase2V36Authorization } from './phase2-v36-execution-authorization.mjs';
import { PHASE2_V37_AUTHORIZATION_ID, draftV37SpecPath, authorizedV37SpecPath, validatePhase2V37Authorization, consumePhase2V37Authorization } from './phase2-v37-execution-authorization.mjs';
import { PHASE2_V38_AUTHORIZATION_ID, draftV38SpecPath, authorizedV38SpecPath, validatePhase2V38Authorization, consumePhase2V38Authorization } from './phase2-v38-execution-authorization.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let specPath;
let specBytes;
let spec;
let specHash;
let specVersion = 1;
const adapterPath = path.join(here, 'ollama-scenario-adapter.mjs');
const frozenBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function argsOf(argv) {
  const out = { caseId: null, output: null, authorized: false, specVersion: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') out.caseId = argv[++i];
    else if (argv[i] === '--output') out.output = argv[++i];
    else if (argv[i] === '--spec-version') out.specVersion = Number(argv[++i]);
    else if (argv[i] === '--authorize-scenario-execution') out.authorized = true;
    else if (argv[i] === '--help') out.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function invokeAdapter({ condition, scenario, runId, root, specCase, promptHash, initialHashes, timeoutMs }) {
  const workspace = path.join(root, 'workspace');
  const dataDirectory = path.join(root, 'data');
  const executionTmpDirectory = path.join(root, 'execution-tmp');
  for (const dir of [workspace, dataDirectory, executionTmpDirectory]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const adapterRequest = {
    protocol: `cos-scenario-host-v${specVersion}`, spec_version: specVersion, run_id: runId, case_id: scenario.case_id,
    condition, probe_only: false, scenario_execution_authorized: true,
    authorization_record_id: specVersion === 3 ? PHASE2_AUTHORIZATION_ID : specVersion === 4 ? PHASE2_V31_AUTHORIZATION_ID : specVersion === 5 ? PHASE2_V32_AUTHORIZATION_ID : specVersion === 6 ? PHASE2_V33_AUTHORIZATION_ID : specVersion === 7 ? PHASE2_V34_AUTHORIZATION_ID : specVersion === 8 ? PHASE2_V35_AUTHORIZATION_ID : specVersion === 9 ? PHASE2_V36_AUTHORIZATION_ID : specVersion === 10 ? PHASE2_V37_AUTHORIZATION_ID : specVersion === 11 ? PHASE2_V38_AUTHORIZATION_ID : null,
    scenario_spec_sha256: specHash, prompt: scenario.prompt, prompt_sha256: promptHash,
    tools_profile: condition === 'plugin' ? 'basic-plus-case-plugin-allowlist' : 'basic-tools-only',
    scenario: specCase, workspace, data_directory: dataDirectory,
    execution_tmp_directory: executionTmpDirectory,
    initial_file_hashes: Object.entries(initialHashes),
    requirements: { no_workflow_approval_or_dispatch: specVersion === 1 || (specVersion >= 3
        ? !(scenario.execution_policy?.workflow_approval_allowed === true && scenario.execution_policy?.workflow_dispatch_allowed === true)
        : scenario.execution_contract?.workflow_execution_allowed !== true), no_external_network: true,
      no_external_provider_credentials: true, no_live_runtime: true },
  };
  const child = spawn(process.execPath, [adapterPath], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC',
      COS_BENCHMARK_RUN_ID: runId, COS_BENCHMARK_CASE_ID: scenario.case_id,
      COS_BENCHMARK_CONDITION: condition, COS_BENCHMARK_SPEC_SHA256: specHash, COS_BENCHMARK_SPEC_VERSION: String(specVersion),
      COS_BENCHMARK_SCENARIO_AUTHORIZED: '1', ...(specVersion === 3 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_AUTHORIZATION_ID } : specVersion === 4 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V31_AUTHORIZATION_ID } : specVersion === 5 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V32_AUTHORIZATION_ID } : specVersion === 6 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V33_AUTHORIZATION_ID } : specVersion === 7 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V34_AUTHORIZATION_ID } : specVersion === 8 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V35_AUTHORIZATION_ID } : specVersion === 9 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V36_AUTHORIZATION_ID } : specVersion === 10 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V37_AUTHORIZATION_ID } : specVersion === 11 ? { COS_BENCHMARK_AUTHORIZATION_ID: PHASE2_V38_AUTHORIZATION_ID } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  // Leave cleanup time after the tool loop's own hard condition budget so a timeout can persist its partial trace.
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  child.stdin.end(`${JSON.stringify(adapterRequest)}\n`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  const partialPath = path.join(workspace, 'host-native-trace.partial.json');
  const completePath = path.join(workspace, 'host-native-trace.json');
  const readTrace = () => {
    for (const candidate of [partialPath, completePath]) {
      if (!fs.existsSync(candidate)) continue;
      try { return { trace: JSON.parse(fs.readFileSync(candidate, 'utf8')), path: candidate }; }
      catch { return { trace: null, path: candidate }; }
    }
    return { trace: null, path: null };
  };
  if (timedOut || code !== 0) {
    const saved = readTrace();
    return { error: timedOut ? `adapter timed out after ${timeoutMs}ms` : `adapter exited ${code}: ${stderr.slice(-3000)}`,
      partialTrace: saved.trace, partialPath: saved.path,
      workspace, dataDirectory, executionTmpDirectory, stderr };
  }
  try {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, `${condition} adapter must emit one JSON line`);
    const response = JSON.parse(lines[0]);
    assert.equal(response.protocol, `cos-scenario-host-v${specVersion}`);
    assert.equal(response.run_id, runId);
    assert.equal(response.case_id, scenario.case_id);
    assert.equal(response.condition, condition);
    assert.equal(response.prompt_sha256, promptHash);
    assert.equal(response.model?.id, spec.model.id);
    assert.equal(response.environment?.live_runtime_targeted, false);
    assert.equal(response.environment?.external_network_used, false);
    assert.equal(response.environment?.external_provider_credentials_used, false);
    const tracePath = path.resolve(response.raw_trace.path);
    assert.ok(tracePath.startsWith(`${fs.realpathSync(workspace)}${path.sep}`), 'raw trace must remain inside isolated workspace');
    assert.equal(sha256(fs.readFileSync(tracePath)), response.raw_trace.sha256);
    return { response, workspace, dataDirectory, executionTmpDirectory, stderr };
  } catch (error) {
    const saved = readTrace();
    return { error: `adapter response validation failed: ${String(error?.message ?? error)}`,
      partialTrace: saved.trace, partialPath: saved.path,
      workspace, dataDirectory, executionTmpDirectory, stderr };
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scenario-paired-harness.mjs --case CASE-01..CASE-10 --output /absolute/evidence/path [--spec-version 1|2|3|4|5|6|7|8|9|10|11 (4=v3.1, 5=v3.2, 6=v3.3, 7=v3.4, 8=v3.5, 9=v3.6, 10=v3.7, 11=v3.8)] [--authorize-scenario-execution]');
    console.log('Without --authorize-scenario-execution the runner writes a blocked gate record and issues no scenario prompt.');
    return;
  }
  assert.ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(args.specVersion), '--spec-version must be 1 through 11 (4=v3.1, 5=v3.2, 6=v3.3, 7=v3.4, 8=v3.5, 9=v3.6, 10=v3.7, 11=v3.8)');
  specVersion = args.specVersion;
  const useAuthorizedV3 = specVersion === 3 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_AUTHORIZATION_ID;
  const useAuthorizedV31 = specVersion === 4 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V31_AUTHORIZATION_ID;
  const useAuthorizedV32 = specVersion === 5 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V32_AUTHORIZATION_ID;
  const useAuthorizedV33 = specVersion === 6 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V33_AUTHORIZATION_ID;
  const useAuthorizedV34 = specVersion === 7 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V34_AUTHORIZATION_ID;
  const useAuthorizedV35 = specVersion === 8 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V35_AUTHORIZATION_ID;
  const useAuthorizedV36 = specVersion === 9 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V36_AUTHORIZATION_ID;
  const useAuthorizedV37 = specVersion === 10 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V37_AUTHORIZATION_ID;
  const useAuthorizedV38 = specVersion === 11 && args.authorized && process.env.COS_BENCHMARK_AUTHORIZED === 'yes'
    && process.env.COS_BENCHMARK_AUTHORIZATION_ID === PHASE2_V38_AUTHORIZATION_ID;
  specPath = specVersion === 3 ? (useAuthorizedV3 ? authorizedSpecPath : draftSpecPath)
    : specVersion === 4 ? (useAuthorizedV31 ? authorizedV31SpecPath : draftV31SpecPath)
    : specVersion === 5 ? (useAuthorizedV32 ? authorizedV32SpecPath : draftV32SpecPath)
    : specVersion === 6 ? (useAuthorizedV33 ? authorizedV33SpecPath : draftV33SpecPath)
    : specVersion === 7 ? (useAuthorizedV34 ? authorizedV34SpecPath : draftV34SpecPath)
    : specVersion === 8 ? (useAuthorizedV35 ? authorizedV35SpecPath : draftV35SpecPath)
    : specVersion === 9 ? (useAuthorizedV36 ? authorizedV36SpecPath : draftV36SpecPath)
    : specVersion === 10 ? (useAuthorizedV37 ? authorizedV37SpecPath : draftV37SpecPath)
    : specVersion === 11 ? (useAuthorizedV38 ? authorizedV38SpecPath : draftV38SpecPath)
    : path.join(here, `scenario-execution-spec-v${specVersion}.json`);
  specBytes = fs.readFileSync(specPath);
  spec = JSON.parse(specBytes.toString('utf8'));
  specHash = createHash('sha256').update(specBytes).digest('hex');
  assert.ok(args.caseId && /^CASE-(0[1-9]|10)$/.test(args.caseId), '--case must be CASE-01 through CASE-10');
  assert.ok(args.output, '--output is required');
  const scenario = spec.cases.find(c => c.case_id === args.caseId);
  assert.ok(scenario, `unknown case ${args.caseId}`);
  const output = path.resolve(args.output);
  if (!args.authorized) {
    writeJson(output, { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, case_id: args.caseId,
      status: 'blocked', benchmark_scenarios_executed: false, scenario_prompt_issued: false,
      reason: 'Explicit --authorize-scenario-execution gate was not supplied; no workspace was created and no prompt was issued.',
      scenario_spec_sha256: specHash, captured_at: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'blocked', benchmark_scenarios_executed: false, evidence: output }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (process.env.COS_BENCHMARK_AUTHORIZED !== 'yes') throw new Error('authorization gate: set COS_BENCHMARK_AUTHORIZED=yes in addition to --authorize-scenario-execution after the gate review is accepted');
  if (spec.status !== 'authorized-for-one-scenario' || spec.execution_gate?.status !== 'authorized') {
    throw new Error('scenario spec gate is blocked; a reviewed, versioned authorization record is required before any workspace or model invocation');
  }
  if (!spec.execution_gate?.authorized_case_ids?.includes(args.caseId)) throw new Error(`case ${args.caseId} is not authorized by the reviewed gate record`);
  if (!spec.execution_gate?.authorization_record?.decision_id) throw new Error('reviewed authorization decision ID is missing');
  if (fs.existsSync(output)) throw new Error(`evidence output already exists; refusing overwrite: ${output}`);
  if (fs.existsSync(`${output}.evidence`)) throw new Error(`evidence directory already exists; refusing overwrite: ${output}.evidence`);

  let authorization = null;
  if (specVersion === 3) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_AUTHORIZATION_ID) throw new Error('v3 requires the exact one-case authorization ID');
    authorization = validatePhase2Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3 output must match the authorized candidate path');
  } else if (specVersion === 4) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V31_AUTHORIZATION_ID) throw new Error('remediated v3.1 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V31Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.1 output must match the authorized candidate path');
  } else if (specVersion === 5) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V32_AUTHORIZATION_ID) throw new Error('remediated v3.2 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V32Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.2 output must match the authorized candidate path');
  } else if (specVersion === 6) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V33_AUTHORIZATION_ID) throw new Error('remediated v3.3 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V33Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.3 output must match the authorized candidate path');
  } else if (specVersion === 7) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V34_AUTHORIZATION_ID) throw new Error('remediated v3.4 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V34Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.4 output must match the authorized candidate path');
  } else if (specVersion === 8) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V35_AUTHORIZATION_ID) throw new Error('remediated v3.5 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V35Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.5 output must match the authorized candidate path');
  } else if (specVersion === 9) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V36_AUTHORIZATION_ID) throw new Error('remediated v3.6 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V36Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.6 output must match the authorized candidate path');
  }
  else if (specVersion === 10) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V37_AUTHORIZATION_ID) throw new Error('remediated v3.7 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V37Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.7 output must match the authorized candidate path');
  }
  else if (specVersion === 11) {
    if (process.env.COS_BENCHMARK_AUTHORIZATION_ID !== PHASE2_V38_AUTHORIZATION_ID) throw new Error('remediated v3.8 requires the exact fresh one-case authorization ID');
    authorization = validatePhase2V38Authorization({ specPath, specBytes, caseId: args.caseId, outputPath: output });
    assert.equal(path.resolve(output), path.resolve(here, '../..', authorization.record.output_path), 'v3.8 output must match the authorized candidate path');
  }
  const runId = randomUUID();
  if (specVersion === 3) consumePhase2Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 4) consumePhase2V31Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 5) consumePhase2V32Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 6) consumePhase2V33Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 7) consumePhase2V34Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 8) consumePhase2V35Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 9) consumePhase2V36Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 10) consumePhase2V37Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  else if (specVersion === 11) consumePhase2V38Authorization({ record: authorization.record, consumptionPath: authorization.consumptionPath, runId, outputPath: output });
  const promptHash = sha256(Buffer.from(scenario.prompt, 'utf8'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cos-scenario-${args.caseId.toLowerCase()}-`));
  const evidenceRoot = `${output}.evidence`;
  const conditionResults = {};
  let finalEvidence;
  let scenarioPromptIssued = false;
  try {
    for (const condition of ['plugin', 'control']) {
      const root = path.join(tempRoot, condition);
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const initial = createScenarioWorkspace(workspace, scenario);
      const invoked = await invokeAdapter({ condition, scenario, runId, root, specCase: scenario,
        promptHash, initialHashes: initial.initialHashes, timeoutMs: spec.model.max_elapsed_seconds_per_condition * 1000 + 15_000 });
      const trace = invoked.response
        ? JSON.parse(fs.readFileSync(invoked.response.raw_trace.path, 'utf8'))
        : (invoked.partialTrace ?? { model_events: [], tool_events: [], adapter_error: invoked.error });
      // Count a prompt only from the persisted raw trace, not from the adapter's summary claim.
      scenarioPromptIssued ||= (trace.model_events ?? []).some(event => ['model_request', 'model_response', 'model_tool_call'].includes(event.kind));
      let pluginStateEvidence = { status: 'not-applicable', workspace_artifact_causality_proven: false };
      let pluginArtifactLineage = { status: 'not-applicable', causal_link_proven: false, checks: [] };
      if (condition === 'plugin') {
        const exportInfo = trace.plugin_state_export;
        if (invoked.response) {
          pluginStateEvidence = verifyPluginStateExport({ workspaceDirectory: workspace, exportInfo,
            expectedIdentity: { run_id: runId, case_id: scenario.case_id, condition: 'plugin',
              scenario_spec_sha256: specHash, bundle_sha256: frozenBundleHash,
              model_id: spec.model.id, prompt_sha256: promptHash } });
        } else {
          pluginStateEvidence = { status: 'missing-or-partial', sha256: exportInfo?.sha256 ?? null,
            workspace_artifact_causality_proven: false };
        }
        if (specVersion >= 2) {
          let exportDocument = null;
          try { exportDocument = JSON.parse(fs.readFileSync(path.join(workspace, 'plugin-state-export.json'), 'utf8')); } catch { /* missing export fails the independent lineage checks */ }
          pluginArtifactLineage = verifyPluginArtifactLineage({ workspace, exportDocument, trace,
            contract: scenario.execution_contract });
        }
      }
      const traceIntegrity = verifyExecutorTrace(trace);
      let verification = verifyScenario({ scenario, workspace, trace,
        initialHashes: initial.initialHashes, finalAnswer: invoked.response?.final_answer ?? '' });
      if (traceIntegrity.status !== 'verified') verification = { ...verification,
        status: 'fail-or-unverified',
        checks: [...verification.checks, { name: 'executor-trace-integrity', passed: false,
          detail: JSON.stringify({ status: traceIntegrity.status, failed_checks: traceIntegrity.failed_checks }) }],
        total_checks: verification.total_checks + 1,
        failed_checks: [...verification.failed_checks, 'executor-trace-integrity'] };
      if (condition === 'plugin' && specVersion >= 2 && pluginArtifactLineage.status !== 'verified') verification = { ...verification,
        status: 'fail-or-unverified',
        checks: [...verification.checks, { name: 'plugin-artifact-lineage', passed: false,
          detail: JSON.stringify({ status: pluginArtifactLineage.status, failed_checks: pluginArtifactLineage.failed_checks }) }],
        total_checks: verification.total_checks + 1,
        failed_checks: [...verification.failed_checks, 'plugin-artifact-lineage'] };
      const persistentRoot = path.join(evidenceRoot, runId, condition);
      fs.mkdirSync(persistentRoot, { recursive: true, mode: 0o700 });
      const workspaceCopy = path.join(persistentRoot, 'workspace');
      fs.cpSync(workspace, workspaceCopy, { recursive: true, errorOnExist: true, dereference: false });
      const dataCopy = path.join(persistentRoot, 'data');
      fs.cpSync(invoked.dataDirectory, dataCopy, { recursive: true, errorOnExist: true, dereference: false });
      const executionTmpCopy = path.join(persistentRoot, 'execution-tmp');
      fs.cpSync(invoked.executionTmpDirectory, executionTmpCopy, { recursive: true, errorOnExist: true, dereference: false });
      const traceSourceName = invoked.response ? 'host-native-trace.json'
        : path.basename(invoked.partialPath ?? 'host-native-trace.partial.json');
      const traceSource = path.join(workspaceCopy, traceSourceName);
      let durableTrace = null;
      if (fs.existsSync(traceSource)) durableTrace = { path: traceSource, sha256: sha256(fs.readFileSync(traceSource)) };
      conditionResults[condition] = { response: invoked.response ? { ...invoked.response,
        raw_trace: durableTrace,
        environment: { ...invoked.response.environment, workspace_path: workspaceCopy, data_directory: dataCopy,
          execution_tmp_directory: executionTmpCopy } } : null,
        error: invoked.error ?? null, partial_trace: durableTrace, trace_integrity: traceIntegrity,
        plugin_state_evidence: pluginStateEvidence, plugin_artifact_lineage: pluginArtifactLineage,
        verification, evidence_directory: persistentRoot };
    }
    const failed = Object.values(conditionResults).some(c => c.verification.status !== 'verified-by-independent-checks' || c.verification.hard_fail);
    const pluginBenefitCausal = specVersion >= 2
      ? conditionResults.plugin?.plugin_artifact_lineage?.causal_link_proven === true
      : conditionResults.plugin?.plugin_state_evidence?.workspace_artifact_causality_proven === true;
    finalEvidence = { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, run_id: runId, captured_at: new Date().toISOString(),
      case_id: scenario.case_id, scenario_spec_sha256: specHash, prompt_sha256: promptHash,
      status: !scenarioPromptIssued ? 'blocked-or-incomplete'
        : failed ? 'scenario-run-recorded-with-failures-or-unverified-criteria'
        : pluginBenefitCausal ? 'scenario-run-recorded-verifiers-pass'
          : 'scenario-run-recorded-verifiers-pass-plugin-benefit-not-measurable',
      benchmark_scenarios_executed: scenarioPromptIssued, scenario_prompt_issued: scenarioPromptIssued, score: null,
      plugin_orchestration_benefit: { status: pluginBenefitCausal ? 'causally-linked' : 'not-measurable',
        reason: pluginBenefitCausal ? null : specVersion >= 2
          ? 'No independently verified plugin task/artifact lineage connects durable plugin state to the scored workspace bytes or trace evidence.'
          : 'Current plugin SQLite export is not linked to the synthetic workspace artifacts that the independent verifiers score.' },
      note: 'No rubric score is assigned automatically. Review raw traces, independent checks, hard-fail events, and answer fidelity before scoring. A verifier pass alone does not prove plugin orchestration benefit.',
      conditions: conditionResults };
  } catch (error) {
    finalEvidence = { protocol: `cos-scenario-paired-v${specVersion}`, spec_version: specVersion, run_id: runId, captured_at: new Date().toISOString(),
      case_id: scenario.case_id, scenario_spec_sha256: specHash, prompt_sha256: promptHash,
      status: 'blocked-or-incomplete', benchmark_scenarios_executed: scenarioPromptIssued, scenario_prompt_issued: scenarioPromptIssued,
      conditions_observed: Object.keys(conditionResults), failure: String(error?.message ?? error),
      conditions: conditionResults, evidence_directory: evidenceRoot,
      note: 'A failed/partial run must not be scored as pass; inspect any partial traces before retrying.' };
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeJson(output, finalEvidence);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: finalEvidence.status, benchmark_scenarios_executed: finalEvidence.benchmark_scenarios_executed,
    case_id: scenario.case_id, evidence: output, trace_directory: evidenceRoot }, null, 2));
}

main().catch(error => { process.stderr.write(`${error?.stack ?? String(error)}\n`); process.exitCode = 1; });
