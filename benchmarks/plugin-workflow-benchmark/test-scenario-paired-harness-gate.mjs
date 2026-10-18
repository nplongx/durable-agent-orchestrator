#!/usr/bin/env node
// Verify that the scenario runner's default path is fail-closed and never issues a model prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, 'scenario-paired-harness.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-scenario-gate-test-'));
try {
  const blockedPath = path.join(root, 'blocked.json');
  const blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--output', blockedPath], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(blocked.status, 2, blocked.stderr);
  const record = JSON.parse(fs.readFileSync(blockedPath, 'utf8'));
  assert.equal(record.status, 'blocked');
  assert.equal(record.benchmark_scenarios_executed, false);
  assert.equal(record.scenario_prompt_issued, false);
  assert.match(record.reason, /no workspace was created and no prompt was issued/i);
  assert.equal(fs.existsSync(`${blockedPath}.evidence`), false);

  const secondPath = path.join(root, 'should-not-run.json');
  const missingSecondGate = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--output', secondPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(missingSecondGate.status, 1);
  assert.match(missingSecondGate.stderr, /COS_BENCHMARK_AUTHORIZED=yes/);
  assert.equal(fs.existsSync(secondPath), false);
  assert.equal(fs.existsSync(`${secondPath}.evidence`), false);

  const v3Path = path.join(root, 'v3-draft-must-remain-blocked.json');
  const v3Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '3', '--output', v3Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v3Blocked.status, 2, v3Blocked.stderr);
  const v3Record = JSON.parse(fs.readFileSync(v3Path, 'utf8'));
  assert.equal(v3Record.protocol, 'cos-scenario-paired-v3');
  assert.equal(v3Record.spec_version, 3);
  assert.equal(v3Record.status, 'blocked');
  assert.equal(v3Record.benchmark_scenarios_executed, false);
  assert.equal(v3Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v3Path}.evidence`), false);

  // Invoke the adapter directly with a synthetic request to prove its independent v3 gate
  // rejects the draft before creating any workspace or launching the plugin/model.
  const v3SpecPath = path.join(here, 'scenario-execution-spec-v3-draft.json');
  const v3SpecBytes = fs.readFileSync(v3SpecPath);
  const v3Spec = JSON.parse(v3SpecBytes.toString('utf8'));
  const v3Case = v3Spec.cases.find(item => item.case_id === 'CASE-01');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const adapterWorkspace = path.join(root, 'adapter-must-not-create-workspace');
  const adapterData = path.join(root, 'adapter-must-not-create-data');
  const adapterTmp = path.join(root, 'adapter-must-not-create-tmp');
  const adapterRequest = { protocol: 'cos-scenario-host-v3', spec_version: 3, run_id: 'offline-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v3SpecBytes),
    prompt: v3Case.prompt, prompt_sha256: hash(Buffer.from(v3Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v3Case, workspace: adapterWorkspace, data_directory: adapterData, execution_tmp_directory: adapterTmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const adapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(adapterRequest)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '3',
      COS_BENCHMARK_SPEC_SHA256: hash(v3SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(adapterBlocked.status, 1);
  assert.match(adapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [adapterWorkspace, adapterData, adapterTmp]) assert.equal(fs.existsSync(target), false, `adapter gate must reject before creating ${target}`);

  const v3BypassPath = path.join(root, 'v3-draft-authorization-must-not-run.json');
  const v3Bypass = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '3', '--output', v3BypassPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v3Bypass.status, 1);
  assert.match(v3Bypass.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v3BypassPath), false);
  assert.equal(fs.existsSync(`${v3BypassPath}.evidence`), false);

  // Remediated v3.1 is an independent draft route (version 4 in the host protocol) and remains blocked by default.
  const v31Path = path.join(root, 'v31-draft-must-remain-blocked.json');
  const v31Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '4', '--output', v31Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v31Blocked.status, 2, v31Blocked.stderr);
  const v31Record = JSON.parse(fs.readFileSync(v31Path, 'utf8'));
  assert.equal(v31Record.protocol, 'cos-scenario-paired-v4');
  assert.equal(v31Record.status, 'blocked');
  assert.equal(v31Record.benchmark_scenarios_executed, false);
  assert.equal(v31Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v31Path}.evidence`), false);

  const v31BypassPath = path.join(root, 'v31-draft-authorization-must-not-run.json');
  const v31Bypass = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '4', '--output', v31BypassPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v31Bypass.status, 1);
  assert.match(v31Bypass.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v31BypassPath), false);
  assert.equal(fs.existsSync(`${v31BypassPath}.evidence`), false);

  // Direct adapter invocation with the v3.1 draft must fail before workspace creation or model/plugin startup.
  const v31SpecPath = path.join(here, 'scenario-execution-spec-v3.1-draft.json');
  const v31SpecBytes = fs.readFileSync(v31SpecPath);
  const v31Spec = JSON.parse(v31SpecBytes.toString('utf8'));
  const v31Case = v31Spec.cases.find(item => item.case_id === 'CASE-01');
  const v31Workspace = path.join(root, 'v31-adapter-must-not-create-workspace');
  const v31Data = path.join(root, 'v31-adapter-must-not-create-data');
  const v31Tmp = path.join(root, 'v31-adapter-must-not-create-tmp');
  const v31Request = { protocol: 'cos-scenario-host-v4', spec_version: 4, run_id: 'offline-v31-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v31SpecBytes),
    prompt: v31Case.prompt, prompt_sha256: hash(Buffer.from(v31Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v31Case, workspace: v31Workspace, data_directory: v31Data, execution_tmp_directory: v31Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v31AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v31Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '4',
      COS_BENCHMARK_SPEC_SHA256: hash(v31SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v31-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v31AdapterBlocked.status, 1);
  assert.match(v31AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v31Workspace, v31Data, v31Tmp]) assert.equal(fs.existsSync(target), false, `v3.1 adapter gate must reject before creating ${target}`);

  const v32Path = path.join(root, 'v32-draft-must-remain-blocked.json');
  const v32Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '5', '--output', v32Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v32Blocked.status, 2, v32Blocked.stderr);
  const v32Record = JSON.parse(fs.readFileSync(v32Path, 'utf8'));
  assert.equal(v32Record.protocol, 'cos-scenario-paired-v5');
  assert.equal(v32Record.status, 'blocked');
  assert.equal(v32Record.benchmark_scenarios_executed, false);
  assert.equal(v32Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v32Path}.evidence`), false);

  const v32BypassPath = path.join(root, 'v32-draft-authorization-must-not-run.json');
  const v32Bypass = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '5', '--output', v32BypassPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v32Bypass.status, 1);
  assert.match(v32Bypass.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v32BypassPath), false);
  assert.equal(fs.existsSync(`${v32BypassPath}.evidence`), false);

  const v33Path = path.join(root, 'v33-draft-must-remain-blocked.json');
  const v33Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '6', '--output', v33Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v33Blocked.status, 2, v33Blocked.stderr);
  const v33Record = JSON.parse(fs.readFileSync(v33Path, 'utf8'));
  assert.equal(v33Record.protocol, 'cos-scenario-paired-v6');
  assert.equal(v33Record.status, 'blocked');
  assert.equal(v33Record.benchmark_scenarios_executed, false);
  assert.equal(v33Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v33Path}.evidence`), false);

  const v33BypassPath = path.join(root, 'v33-draft-authorization-must-not-run.json');
  const v33Bypass = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '6', '--output', v33BypassPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v33Bypass.status, 1);
  assert.match(v33Bypass.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v33BypassPath), false);
  assert.equal(fs.existsSync(`${v33BypassPath}.evidence`), false);

  const v33SpecPath = path.join(here, 'scenario-execution-spec-v3.3-draft.json');
  const v33SpecBytes = fs.readFileSync(v33SpecPath);
  const v33Spec = JSON.parse(v33SpecBytes.toString('utf8'));
  const v33Case = v33Spec.cases.find(item => item.case_id === 'CASE-01');
  const v33Workspace = path.join(root, 'v33-adapter-must-not-create-workspace');
  const v33Data = path.join(root, 'v33-adapter-must-not-create-data');
  const v33Tmp = path.join(root, 'v33-adapter-must-not-create-tmp');
  const v33Request = { protocol: 'cos-scenario-host-v6', spec_version: 6, run_id: 'offline-v33-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v33SpecBytes),
    prompt: v33Case.prompt, prompt_sha256: hash(Buffer.from(v33Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v33Case, workspace: v33Workspace, data_directory: v33Data, execution_tmp_directory: v33Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v33AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v33Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '6',
      COS_BENCHMARK_SPEC_SHA256: hash(v33SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v33-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v33AdapterBlocked.status, 1);
  assert.match(v33AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v33Workspace, v33Data, v33Tmp]) assert.equal(fs.existsSync(target), false, `v3.3 adapter gate must reject before creating ${target}`);

  const v34Path = path.join(root, 'v34-draft-must-remain-blocked.json');
  const v34Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '7', '--output', v34Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v34Blocked.status, 2, v34Blocked.stderr);
  const v34Record = JSON.parse(fs.readFileSync(v34Path, 'utf8'));
  assert.equal(v34Record.protocol, 'cos-scenario-paired-v7');
  assert.equal(v34Record.status, 'blocked');
  assert.equal(v34Record.benchmark_scenarios_executed, false);
  assert.equal(v34Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v34Path}.evidence`), false);
  const v34SpecPath = path.join(here, 'scenario-execution-spec-v3.4-draft.json');
  const v34SpecBytes = fs.readFileSync(v34SpecPath);
  const v34Spec = JSON.parse(v34SpecBytes.toString('utf8'));
  const v34Case = v34Spec.cases.find(item => item.case_id === 'CASE-01');
  const v34Workspace = path.join(root, 'v34-adapter-must-not-create-workspace');
  const v34Data = path.join(root, 'v34-adapter-must-not-create-data');
  const v34Tmp = path.join(root, 'v34-adapter-must-not-create-tmp');
  const v34Request = { protocol: 'cos-scenario-host-v7', spec_version: 7, run_id: 'offline-v34-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v34SpecBytes),
    prompt: v34Case.prompt, prompt_sha256: hash(Buffer.from(v34Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v34Case, workspace: v34Workspace, data_directory: v34Data, execution_tmp_directory: v34Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v34AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v34Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '7',
      COS_BENCHMARK_SPEC_SHA256: hash(v34SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v34-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v34AdapterBlocked.status, 1);
  assert.match(v34AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v34Workspace, v34Data, v34Tmp]) assert.equal(fs.existsSync(target), false, `v3.4 adapter gate must reject before creating ${target}`);

  const v35Path = path.join(root, 'v35-draft-must-remain-blocked.json');
  const v35Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '8', '--output', v35Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v35Blocked.status, 2, v35Blocked.stderr);
  const v35Record = JSON.parse(fs.readFileSync(v35Path, 'utf8'));
  assert.equal(v35Record.protocol, 'cos-scenario-paired-v8');
  assert.equal(v35Record.status, 'blocked');
  assert.equal(v35Record.benchmark_scenarios_executed, false);
  assert.equal(v35Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v35Path}.evidence`), false);
  const v35SpecPath = path.join(here, 'scenario-execution-spec-v3.5-draft.json');
  const v35SpecBytes = fs.readFileSync(v35SpecPath);
  const v35Spec = JSON.parse(v35SpecBytes.toString('utf8'));
  const v35Case = v35Spec.cases.find(item => item.case_id === 'CASE-01');
  const v35Workspace = path.join(root, 'v35-adapter-must-not-create-workspace');
  const v35Data = path.join(root, 'v35-adapter-must-not-create-data');
  const v35Tmp = path.join(root, 'v35-adapter-must-not-create-tmp');
  const v35Request = { protocol: 'cos-scenario-host-v8', spec_version: 8, run_id: 'offline-v35-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v35SpecBytes),
    prompt: v35Case.prompt, prompt_sha256: hash(Buffer.from(v35Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v35Case, workspace: v35Workspace, data_directory: v35Data, execution_tmp_directory: v35Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v35AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v35Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '8',
      COS_BENCHMARK_SPEC_SHA256: hash(v35SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v35-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v35AdapterBlocked.status, 1);
  assert.match(v35AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v35Workspace, v35Data, v35Tmp]) assert.equal(fs.existsSync(target), false, `v3.5 adapter gate must reject before creating ${target}`);

  const v36Path = path.join(root, 'v36-draft-must-remain-blocked.json');
  const v36Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '9', '--output', v36Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v36Blocked.status, 2, v36Blocked.stderr);
  const v36Record = JSON.parse(fs.readFileSync(v36Path, 'utf8'));
  assert.equal(v36Record.protocol, 'cos-scenario-paired-v9');
  assert.equal(v36Record.status, 'blocked');
  assert.equal(v36Record.benchmark_scenarios_executed, false);
  assert.equal(v36Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v36Path}.evidence`), false);
  const v36SpecPath = path.join(here, 'scenario-execution-spec-v3.6-draft.json');
  const v36SpecBytes = fs.readFileSync(v36SpecPath);
  const v36Spec = JSON.parse(v36SpecBytes.toString('utf8'));
  const v36Case = v36Spec.cases.find(item => item.case_id === 'CASE-01');
  const v36Workspace = path.join(root, 'v36-adapter-must-not-create-workspace');
  const v36Data = path.join(root, 'v36-adapter-must-not-create-data');
  const v36Tmp = path.join(root, 'v36-adapter-must-not-create-tmp');
  const v36Request = { protocol: 'cos-scenario-host-v9', spec_version: 9, run_id: 'offline-v36-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v36SpecBytes),
    prompt: v36Case.prompt, prompt_sha256: hash(Buffer.from(v36Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v36Case, workspace: v36Workspace, data_directory: v36Data, execution_tmp_directory: v36Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v36AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v36Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '9',
      COS_BENCHMARK_SPEC_SHA256: hash(v36SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v36-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v36AdapterBlocked.status, 1);
  assert.match(v36AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v36Workspace, v36Data, v36Tmp]) assert.equal(fs.existsSync(target), false, `v3.6 adapter gate must reject before creating ${target}`);

  const v37Path = path.join(root, 'v37-draft-must-remain-blocked.json');
  const v37Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '10', '--output', v37Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v37Blocked.status, 2, v37Blocked.stderr);
  const v37Record = JSON.parse(fs.readFileSync(v37Path, 'utf8'));
  assert.equal(v37Record.protocol, 'cos-scenario-paired-v10');
  assert.equal(v37Record.status, 'blocked');
  assert.equal(v37Record.benchmark_scenarios_executed, false);
  assert.equal(v37Record.scenario_prompt_issued, false);
  assert.equal(fs.existsSync(`${v37Path}.evidence`), false);
  const v37SpecPath = path.join(here, 'scenario-execution-spec-v3.7-draft.json');
  const v37SpecBytes = fs.readFileSync(v37SpecPath);
  const v37Spec = JSON.parse(v37SpecBytes.toString('utf8'));
  const v37Case = v37Spec.cases.find(item => item.case_id === 'CASE-01');
  const v37Workspace = path.join(root, 'v37-adapter-must-not-create-workspace');
  const v37Data = path.join(root, 'v37-adapter-must-not-create-data');
  const v37Tmp = path.join(root, 'v37-adapter-must-not-create-tmp');
  const v37Request = { protocol: 'cos-scenario-host-v10', spec_version: 10, run_id: 'offline-v37-gate-test', case_id: 'CASE-01',
    condition: 'plugin', probe_only: false, scenario_execution_authorized: true, scenario_spec_sha256: hash(v37SpecBytes),
    prompt: v37Case.prompt, prompt_sha256: hash(Buffer.from(v37Case.prompt)), tools_profile: 'basic-plus-case-plugin-allowlist',
    scenario: v37Case, workspace: v37Workspace, data_directory: v37Data, execution_tmp_directory: v37Tmp,
    initial_file_hashes: [], requirements: { no_workflow_approval_or_dispatch: false, no_external_network: true, no_external_provider_credentials: true, no_live_runtime: true } };
  const v37AdapterBlocked = spawnSync(process.execPath, [path.join(here, 'ollama-scenario-adapter.mjs')], {
    cwd: root, input: `${JSON.stringify(v37Request)}\n`, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_SPEC_VERSION: '10',
      COS_BENCHMARK_SPEC_SHA256: hash(v37SpecBytes), COS_BENCHMARK_RUN_ID: 'offline-v37-gate-test', COS_BENCHMARK_CASE_ID: 'CASE-01',
      COS_BENCHMARK_CONDITION: 'plugin', COS_BENCHMARK_SCENARIO_AUTHORIZED: '1' },
  });
  assert.equal(v37AdapterBlocked.status, 1);
  assert.match(v37AdapterBlocked.stderr, /scenario spec is not approved for execution/i);
  for (const target of [v37Workspace, v37Data, v37Tmp]) assert.equal(fs.existsSync(target), false, `v3.7 adapter gate must reject before creating ${target}`);

  const v2Path = path.join(root, 'v2-spec-gate-should-not-run.json');
  const v2Blocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '2', '--output', v2Path], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  assert.equal(v2Blocked.status, 2, v2Blocked.stderr);
  const v2Record = JSON.parse(fs.readFileSync(v2Path, 'utf8'));
  assert.equal(v2Record.protocol, 'cos-scenario-paired-v2');
  assert.equal(v2Record.spec_version, 2);
  assert.equal(v2Record.status, 'blocked');
  assert.equal(v2Record.benchmark_scenarios_executed, false);
  assert.equal(fs.existsSync(`${v2Path}.evidence`), false);

  const v2BypassPath = path.join(root, 'v2-unauthorized-case-must-not-run.json');
  const v2Bypass = spawnSync(process.execPath, [harness, '--case', 'CASE-02', '--spec-version', '2', '--output', v2BypassPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v2Bypass.status, 1);
  assert.match(v2Bypass.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v2BypassPath), false);
  assert.equal(fs.existsSync(`${v2BypassPath}.evidence`), false);

  const v2ConsumedPath = path.join(root, 'v2-consumed-case-must-not-rerun.json');
  const v2Consumed = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--spec-version', '2', '--output', v2ConsumedPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(v2Consumed.status, 1);
  assert.match(v2Consumed.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(v2ConsumedPath), false);
  assert.equal(fs.existsSync(`${v2ConsumedPath}.evidence`), false);

  const thirdPath = path.join(root, 'spec-gate-should-not-run.json');
  const specGateBlocked = spawnSync(process.execPath, [harness, '--case', 'CASE-01', '--output', thirdPath, '--authorize-scenario-execution'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', COS_BENCHMARK_AUTHORIZED: 'yes' },
  });
  assert.equal(specGateBlocked.status, 1);
  assert.match(specGateBlocked.stderr, /scenario spec gate is blocked/i);
  assert.equal(fs.existsSync(thirdPath), false);
  assert.equal(fs.existsSync(`${thirdPath}.evidence`), false);
  console.log('PASS: default runner path is blocked before workspace/model creation');
  console.log('PASS: CLI flag alone is insufficient; second explicit authorization gate is required');
  console.log('PASS: CLI flag plus environment token still cannot bypass the reviewed spec gate');
  console.log('PASS: v3, v3.1, v3.2, v3.3, v3.4, v3.5, v3.6 and v3.7 drafts can only emit blocked records; authorization flags cannot open their gates');
  console.log('PASS: v3.1, v3.3, v3.4, v3.5, v3.6 and v3.7 direct adapter invocations reject before workspace/data/temp directories, plugin startup, or model inference');
  console.log('PASS: direct adapter invocation rejects the v3 draft before workspace/data/temp directories, plugin startup, or model inference');
  console.log('PASS: v2 protocol selection also remains blocked before workspace/model creation');
  console.log('PASS: consumed v2 authorization blocks any further scenario even with CLI and environment flags');
  console.log('PASS: consumed CASE-01 authorization cannot be reused for a second model invocation');
  console.log('PASS: gate tests themselves do not execute benchmark scenarios');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
