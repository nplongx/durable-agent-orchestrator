#!/usr/bin/env node
// Contract tests only: this validates the frozen-scenario execution plan.
// It does not start Ollama, the plugin, or any benchmark scenario.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'), 'utf8'));
assert.equal(spec.spec_id, 'cos-plugin-workflow-scenario-execution-v1');
assert.equal(spec.status, 'prepared-not-authorized');
assert.equal(spec.execution_gate.status, 'blocked');
assert.deepEqual(spec.execution_gate.authorized_case_ids, []);
assert.equal(spec.execution_gate.authorization_record, null);
assert.equal(spec.protocol_revision, 'phase1-freeze-2026-10-10');
assert.equal(spec.model.provider, 'ollama-local');
assert.equal(spec.model.id, 'qwen3:4b-instruct');
assert.ok(spec.model.max_model_turns_per_condition > 0 && spec.model.max_model_turns_per_condition <= 20);
assert.ok(spec.model.max_tool_calls_per_condition > 0 && spec.model.max_tool_calls_per_condition <= 30);
assert.equal(spec.paired_conditions.identical_prompt_bytes, true);
assert.equal(spec.paired_conditions.fresh_workspace_and_sqlite_per_condition, true);
assert.equal(spec.paired_conditions.no_external_network_or_provider_credentials, true);
assert.equal(spec.paired_conditions.no_live_runtime_or_shared_service, true);
assert.ok(spec.paired_conditions.basic_tool_catalog.includes('read_file'));
assert.ok(spec.paired_conditions.basic_tool_catalog.includes('write_file'));
assert.match(spec.paired_conditions.condition_parity_rule, /exactly the same case-specific basic-tool schemas/);
assert.ok(spec.global_policy.deny_by_default);
assert.ok(spec.global_policy.deny_arbitrary_shell_and_subprocess);
assert.ok(spec.global_policy.deny_path_escape_from_condition_workspace);
assert.ok(spec.global_policy.independent_verifier_not_model_self_report);
assert.equal(spec.cases.length, 10);
assert.deepEqual(spec.cases.map(c => c.case_id), Array.from({ length: 10 }, (_, i) => `CASE-${String(i + 1).padStart(2, '0')}`));
for (const c of spec.cases) {
  assert.ok(c.name && c.prompt && c.verifier?.kind, `${c.case_id}: missing case definition`);
  assert.ok(Array.isArray(c.plugin_tools), `${c.case_id}: plugin tool allowlist missing`);
  assert.equal(c.execution_approval_allowed, false, `${c.case_id}: scenario execution must remain unapproved in this planning artifact`);
  assert.ok(Array.isArray(c.forbidden), `${c.case_id}: forbidden behavior list missing`);
}
const case6 = spec.cases.find(c => c.case_id === 'CASE-06');
for (const name of ['workflow_approve', 'workflow_dispatch', 'workflow_e2e_run', 'task_execute_local', 'write_file']) {
  assert.ok(case6.hard_denied_tools.includes(name), `CASE-06 must hard-deny ${name}`);
}
const case7 = spec.cases.find(c => c.case_id === 'CASE-07');
assert.ok(case7.path_policy.immutable_paths.includes('original.txt'));
assert.deepEqual(case7.path_policy.write_or_delete_paths, ['sandbox-copy/original.txt']);
const case4 = spec.cases.find(c => c.case_id === 'CASE-04');
assert.equal(case4.verifier.max_created_artifacts, 1);
assert.equal(case4.verifier.status_check_before_retry, true);
const case9 = spec.cases.find(c => c.case_id === 'CASE-09');
assert.ok(case9.verifier.missing_required.includes('security-review.json'));
const case10 = spec.cases.find(c => c.case_id === 'CASE-10');
assert.deepEqual(case10.verifier.required_statuses, ['passed', 'failed', 'unverified', 'blocked']);
console.log('PASS: ten frozen scenario execution cards are structurally complete and remain not authorized');
console.log('PASS: common basic-tool baseline, deny-by-default policy, CASE-06 hard denies, and CASE-07 path containment are declared');
console.log('PASS: no benchmark scenarios executed');
