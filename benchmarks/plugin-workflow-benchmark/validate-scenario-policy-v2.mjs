#!/usr/bin/env node
// Static v2 contract validation only. Does not start Ollama, the plugin, or a benchmark scenario.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getBasicToolSchemas } from './scenario-basic-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const v1Bytes = fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'));
const v1 = JSON.parse(v1Bytes.toString('utf8'));
const v2Bytes = fs.readFileSync(path.join(here, 'scenario-execution-spec-v2.json'));
const spec = JSON.parse(v2Bytes.toString('utf8'));
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestResult = spawnSync('/usr/bin/unzip', ['-p', bundle, 'manifest.json'], {
  encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
});
assert.equal(manifestResult.status, 0, `cannot read frozen bundle manifest: ${manifestResult.stderr}`);
const manifest = JSON.parse(manifestResult.stdout);
const manifestNames = new Set((manifest.tools ?? []).map(tool => tool.name));
assert.equal(hash(fs.readFileSync(bundle)), expectedBundleHash, 'frozen plugin bundle hash changed');
assert.equal(manifest.version, '1.0.8');
assert.equal(spec.spec_id, 'cos-plugin-workflow-scenario-execution-v2');
assert.equal(spec.status, 'pilot-authorized-but-not-executed');
assert.equal(spec.execution_gate.status, 'blocked');
assert.deepEqual(spec.execution_gate.authorized_case_ids, ['CASE-01']);
assert.ok(spec.execution_gate.authorization_record?.decision_id);
assert.equal(spec.execution_gate.authorization_record?.decision_id, '2e7e4097-7f0e-4f4a-a537-9d16b911e4ac');
assert.equal(spec.execution_gate.authorization_record?.authorization_source, 'explicit_user_message_in_chat');
assert.equal(spec.execution_gate.authorization_record?.consumed_by_run_id, undefined);
assert.equal(spec.execution_gate.previous_authorization_records[0]?.consumed_by_run_id, 'fb03040c-d1cd-4611-bbdd-693e3ed5e3f0');
assert.equal(spec.frozen_baseline.source_spec_sha256, hash(v1Bytes));
assert.equal(spec.frozen_baseline.user_prompts_preserved_byte_for_byte, true);
assert.equal(spec.cases.length, 10);
assert.equal(spec.paired_conditions.same_system_context_bytes, true);

const requiredExecutionTools = ['custom_role_create','custom_workflow_create','custom_workflow_preview','custom_workflow_approve',
  'custom_workflow_run_create','workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task',
  'workflow_complete_task','workflow_complete_synthesis','workflow_artifacts'];
const noExecutionTools = ['workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task',
  'workflow_complete_task','workflow_complete_synthesis','workflow_e2e_run','task_execute_local','custom_role_create',
  'custom_workflow_create','custom_workflow_preview','custom_workflow_approve','custom_workflow_run_create'];

for (let index = 0; index < spec.cases.length; index++) {
  const c = spec.cases[index];
  const frozen = v1.cases[index];
  assert.equal(c.case_id, frozen.case_id);
  assert.equal(c.prompt, frozen.prompt, `${c.case_id}: frozen prompt mismatch`);
  assert.ok(c.execution_contract?.mode, `${c.case_id}: missing execution contract`);
  assert.ok(Array.isArray(c.execution_contract.required_workspace_files));
  assert.ok(Array.isArray(c.plugin_tools));
  assert.equal(new Set(c.plugin_tools).size, c.plugin_tools.length, `${c.case_id}: duplicate plugin tool`);
  for (const name of c.plugin_tools) assert.ok(manifestNames.has(name), `${c.case_id}: tool ${name} absent from frozen bundle`);
  const basic = getBasicToolSchemas(c, '/tmp/policy-v2').map(tool => tool.function.name);
  assert.equal(new Set(basic).size, basic.length, `${c.case_id}: duplicate basic tool`);
  for (const name of basic) assert.ok(spec.paired_conditions.basic_tool_catalog.includes(name), `${c.case_id}: undeclared basic tool ${name}`);
  for (const name of c.hard_denied_tools ?? []) {
    assert.ok(!c.plugin_tools.includes(name), `${c.case_id}: hard-denied plugin tool ${name} is exposed`);
    assert.ok(!basic.includes(name), `${c.case_id}: hard-denied basic tool ${name} is exposed`);
  }
  if (c.execution_contract.workflow_execution_allowed === true) {
    for (const name of requiredExecutionTools) assert.ok(c.plugin_tools.includes(name), `${c.case_id}: missing ${name}`);
  }
  if (c.execution_contract.workflow_execution_allowed === false) {
    for (const name of noExecutionTools) assert.ok(!c.plugin_tools.includes(name), `${c.case_id}: execution tool leaked into read-only allowlist: ${name}`);
  }
}

const c6 = spec.cases.find(c => c.case_id === 'CASE-06');
assert.ok(c6.plugin_tools.includes('workflow_create'), 'CASE-06 may create a proposal without executing it');
for (const name of ['workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task',
  'workflow_complete_task','workflow_complete_synthesis','workflow_e2e_run','task_execute_local','custom_role_create',
  'custom_workflow_create','custom_workflow_preview','custom_workflow_approve','custom_workflow_run_create','write_file','delete_file']) {
  assert.ok(c6.hard_denied_tools.includes(name));
  assert.ok(!c6.plugin_tools.includes(name));
  assert.ok(!getBasicToolSchemas(c6, '/tmp/policy-v2').some(tool => tool.function.name === name));
}

const harness = fs.readFileSync(path.join(here, 'scenario-paired-harness.mjs'), 'utf8');
const adapter = fs.readFileSync(path.join(here, 'ollama-scenario-adapter.mjs'), 'utf8');
const lineage = fs.readFileSync(path.join(here, 'plugin-artifact-lineage.mjs'), 'utf8');
assert.match(harness, /verifyPluginArtifactLineage\(/, 'paired harness must enforce the v2 lineage verifier');
assert.match(harness, /scenario-execution-spec-v\$\{specVersion\}\.json/, 'runner must bind the selected versioned spec');
assert.match(adapter, /scenario-execution-spec-v\$\{version\}\.json/, 'adapter must bind the same selected spec version');
assert.match(adapter, /COS_BENCHMARK_SCENARIO_AUTHORIZED/, 'adapter must retain the independent authorization gate');
assert.match(lineage, /artifact-to-workspace-byte-lineage/, 'lineage verifier must hash actual workspace bytes');
assert.match(lineage, /explicit-approval-recorded/, 'lineage verifier must reconcile explicit approval');
assert.match(lineage, /synthesis-references-task-artifact/, 'lineage verifier must reconcile synthesis to task artifact');

console.log(`PASS: frozen bundle SHA-256 ${expectedBundleHash} and manifest version 1.0.8 verified`);
console.log('PASS: v2 preserves the ten frozen prompts and binds to the v1 source hash');
console.log('PASS: per-case workflow tool grants and durable artifact lineage rules are structurally valid');
console.log('PASS: CASE-06 hard denies and CASE-09/10 read-only policies remain enforced');
console.log('PASS: runner and adapter are version-aware; the previous authorization is preserved and the blocked new gate remains closed');
