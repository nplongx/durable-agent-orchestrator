#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Bytes = fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'));
const v1 = JSON.parse(v1Bytes.toString('utf8'));
const v2 = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v2.json'), 'utf8'));
assert.equal(v2.spec_id, 'cos-plugin-workflow-scenario-execution-v2');
assert.equal(v2.supersedes, v1.spec_id);
assert.equal(v2.status, 'pilot-authorized-but-not-executed');
assert.equal(v2.execution_gate.status, 'blocked');
assert.deepEqual(v2.execution_gate.authorized_case_ids, ['CASE-01']);
assert.ok(v2.execution_gate.authorization_record?.decision_id);
assert.equal(v2.execution_gate.authorization_record?.decision_id, '2e7e4097-7f0e-4f4a-a537-9d16b911e4ac');
assert.equal(v2.execution_gate.authorization_record?.authorization_source, 'explicit_user_message_in_chat');
assert.equal(v2.execution_gate.authorization_record?.scope, 'exactly one additional paired model-driven CASE-01 timeout-remediation pilot under spec v2');
assert.equal(v2.execution_gate.authorization_record?.consumed_by_run_id, undefined);
assert.equal(v2.execution_gate.previous_authorization_records[0]?.consumed_by_run_id, 'fb03040c-d1cd-4611-bbdd-693e3ed5e3f0');
assert.equal(v2.frozen_baseline.source_spec_sha256, createHash('sha256').update(v1Bytes).digest('hex'));
assert.equal(v2.frozen_baseline.user_prompts_preserved_byte_for_byte, true);
assert.equal(v2.cases.length, 10);
assert.deepEqual(v2.cases.map(c => c.case_id), v1.cases.map(c => c.case_id));
for (let i = 0; i < v1.cases.length; i++) {
  assert.equal(v2.cases[i].prompt, v1.cases[i].prompt, `${v1.cases[i].case_id}: frozen user prompt changed`);
  assert.equal(v2.cases[i].execution_contract.version, 1);
  assert.ok(v2.cases[i].execution_contract.mode);
}
assert.equal(v2.paired_conditions.same_system_context_bytes, true);
assert.equal(v2.model.max_model_turns_per_condition, 20);
assert.equal(v2.model.max_tool_calls_per_condition, 30);

const case6 = v2.cases.find(c => c.case_id === 'CASE-06');
assert.equal(case6.execution_contract.workflow_execution_allowed, false);
assert.ok(case6.plugin_tools.includes('workflow_create'), 'CASE-06 must be able to create a harmless proposal');
for (const name of ['workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task',
  'workflow_complete_task','workflow_complete_synthesis','workflow_e2e_run','task_execute_local','custom_role_create',
  'custom_workflow_create','custom_workflow_preview','custom_workflow_approve','custom_workflow_run_create','write_file','delete_file']) {
  assert.ok(case6.hard_denied_tools.includes(name), `CASE-06 must hard-deny ${name}`);
  assert.ok(!case6.plugin_tools.includes(name), `CASE-06 must not expose ${name}`);
}
for (const id of ['CASE-09','CASE-10']) {
  const c = v2.cases.find(x => x.case_id === id);
  assert.equal(c.execution_contract.workflow_execution_allowed, false, `${id} remains read-only`);
  assert.ok(!c.plugin_tools.includes('workflow_approve'));
  assert.ok(!c.plugin_tools.includes('workflow_dispatch'));
}
for (const c of v2.cases.filter(x => x.execution_contract.mode === 'artifact-lineage' || x.execution_contract.mode === 'trace-linked-artifact')) {
  for (const tool of ['custom_role_create','custom_workflow_create','custom_workflow_preview','custom_workflow_approve',
    'custom_workflow_run_create','workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task',
    'workflow_complete_task','workflow_complete_synthesis','workflow_artifacts']) {
    assert.ok(c.plugin_tools.includes(tool), `${c.case_id}: missing execution-backed tool ${tool}`);
  }
}
console.log('PASS: v2 preserves all ten frozen user prompts, preserves the prior consumed authorization, and keeps the new blocked run gate closed');
console.log('PASS: case-specific workflow tools and lineage contracts are declared');
console.log('PASS: CASE-06 remains hard-denied; CASE-09 and CASE-10 remain read-only');
console.log('PASS: this spec test itself does not execute a benchmark scenario');
