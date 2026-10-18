#!/usr/bin/env node
// Offline-only contract checks for the proposed v3 policy revision. Never runs a scenario.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getBasicToolSchemas, createBasicToolExecutor } from './scenario-basic-tools.mjs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1 = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'), 'utf8'));
const v2Bytes = fs.readFileSync(path.join(here, 'scenario-execution-spec-v2.json'));
const v2 = JSON.parse(v2Bytes.toString('utf8'));
const v3 = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v3-draft.json'), 'utf8'));
const repo = path.resolve(here, '../..');
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const bundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (!fs.existsSync(bundle)) {
  console.error(`BLOCKED: v3 frozen-bundle contract check cannot run because ${path.relative(repo, bundle)} is missing; required SHA-256 ${bundleHash}. Restore the exact frozen artifact or complete the formal re-freeze/review process; candidate packages are not substitutes.`);
  process.exit(2);
}
assert.equal(sha256(v2Bytes), v3.policy_revision_notes.source_v2_sha256, 'v3 draft source hash does not match v2');
assert.equal(sha256(fs.readFileSync(bundle)), bundleHash, 'frozen plugin bundle changed');
const manifestResult = spawnSync('/usr/bin/unzip', ['-p', bundle, 'manifest.json'], {
  encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
});
assert.equal(manifestResult.status, 0, `cannot read frozen plugin manifest: ${manifestResult.stderr}`);
const manifest = JSON.parse(manifestResult.stdout);
assert.equal(manifest.version, '1.0.8');
const pluginNames = new Set((manifest.tools ?? []).map(tool => tool.name));
assert.equal(v3.status, 'draft-not-authorized');
assert.equal(v3.execution_gate.status, 'blocked');
assert.deepEqual(v3.execution_gate.authorized_case_ids, []);
for (const field of ['workflow_proposal_allowed','workflow_execution_allowed','workflow_approval_allowed','workflow_dispatch_allowed','workspace_mutation_allowed','read_only']) {
  assert.ok(v3.policy_revision_notes.canonical_fields.includes(field), `canonical policy field not documented: ${field}`);
}
assert.equal(v3.execution_gate.authorization_record, null);
assert.equal(v3.cases.length, v1.cases.length);

const originals = new Map(v1.cases.map(item => [item.case_id, item]));
for (const item of v3.cases) {
  const original = originals.get(item.case_id);
  assert.ok(original, `unknown case ${item.case_id}`);
  assert.equal(item.prompt, original.prompt, `frozen prompt changed: ${item.case_id}`);
  assert.equal(Object.hasOwn(item, 'execution_approval_allowed'), false, `legacy ambiguous field remains: ${item.case_id}`);
  assert.ok(item.execution_policy && item.execution_contract, `missing policy: ${item.case_id}`);
  assert.equal(item.execution_policy.workflow_execution_allowed, item.execution_contract.workflow_execution_allowed === true,
    `canonical execution policy differs from contract: ${item.case_id}`);
  const requiredEvents = new Set(item.execution_contract.required_workflow_tool_events ?? []);
  for (const eventName of requiredEvents) assert.ok(item.plugin_tools.includes(eventName), `${item.case_id}: required workflow event tool is not granted: ${eventName}`);
  assert.equal(item.execution_policy.workflow_proposal_allowed, item.plugin_tools.includes('workflow_create'),
    `proposal policy must match explicit workflow-create tool grant: ${item.case_id}`);
  assert.equal(item.execution_policy.workflow_approval_allowed,
    item.plugin_tools.includes('workflow_approve') && requiredEvents.has('workflow_approve'),
    `approval policy must match explicit tool grant and required event: ${item.case_id}`);
  assert.equal(item.execution_policy.workflow_dispatch_allowed,
    item.plugin_tools.includes('workflow_dispatch') && requiredEvents.has('workflow_dispatch'),
    `dispatch policy must match explicit tool grant and required event: ${item.case_id}`);
  if (item.execution_policy.workflow_execution_allowed) {
    assert.equal(item.execution_policy.workflow_approval_allowed, true, `${item.case_id}: executable workflow requires explicit approval grant`);
    assert.equal(item.execution_policy.workflow_dispatch_allowed, true, `${item.case_id}: executable workflow requires explicit dispatch grant`);
    for (const required of ['workflow_create','workflow_get','workflow_events','custom_role_create','custom_workflow_create','custom_workflow_preview','custom_workflow_approve','custom_workflow_run_create','workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task','workflow_complete_task']) {
      assert.ok(item.plugin_tools.includes(required), `${item.case_id}: execution policy lacks required workflow capability ${required}`);
    }
    if (['artifact-lineage','trace-linked-artifact'].includes(item.execution_contract.mode)) {
      assert.ok(item.plugin_tools.includes('workflow_complete_synthesis'), `${item.case_id}: successful artifact workflow needs synthesis capability`);
    }
  }
  if (['artifact-lineage','trace-linked-artifact','failure-state'].includes(item.execution_contract.mode)) {
    assert.equal(item.execution_policy.workflow_execution_allowed, true, `${item.case_id}: execution-backed contract needs execution grant`);
    assert.equal(item.execution_policy.workflow_proposal_allowed, true, `${item.case_id}: execution-backed contract needs proposal tool`);
  }
  assert.equal(item.execution_policy.read_only,
    !item.execution_policy.workspace_mutation_allowed && !item.execution_policy.workflow_proposal_allowed && !item.execution_policy.workflow_execution_allowed,
    `read-only policy mismatch: ${item.case_id}`);
  const basicNames = getBasicToolSchemas(item, '/tmp/phase2-v3-static-policy').map(tool => tool.function.name);
  if (item.execution_policy.read_only) {
    assert.ok(!item.plugin_tools.some(name => /(?:create|update|approve|dispatch|run_create|prepare_tasks|next_task|complete|execute|write|delete)/i.test(name)),
      `${item.case_id}: read-only policy exposes a mutation/execution plugin tool`);
    assert.ok(!basicNames.includes('write_file') && !basicNames.includes('delete_file'),
      `${item.case_id}: read-only policy exposes a workspace mutation tool`);
  }
  const fileGroups = [item.execution_contract.required_workspace_files ?? [], item.execution_contract.conditional_workspace_files ?? [], item.execution_contract.optional_workspace_files ?? []];
  const declaredFiles = fileGroups.flat();
  assert.equal(new Set(declaredFiles).size, declaredFiles.length, `${item.case_id}: workspace file path is duplicated across required/conditional/optional sets`);
  for (const rel of declaredFiles) {
    assert.equal(typeof rel, 'string');
    assert.ok(rel.length > 0 && !rel.startsWith('/') && !rel.split('/').includes('..') && !rel.includes('\\'), `${item.case_id}: unsafe workspace file path ${rel}`);
  }
  if (item.execution_policy.workspace_mutation_allowed !== true) {
    assert.ok(!(item.path_policy?.write_or_delete_paths ?? []).length, `${item.case_id}: path policy permits writes while workspace mutation is denied`);
    assert.ok(!item.plugin_tools.some(name => ['write_file','delete_file'].includes(name)), `${item.case_id}: plugin allowlist contains a workspace mutation tool`);
  }
  assert.equal(new Set(item.plugin_tools).size, item.plugin_tools.length, `${item.case_id}: duplicate plugin tool`);
  for (const name of item.plugin_tools) assert.ok(pluginNames.has(name), `${item.case_id}: tool absent from frozen bundle: ${name}`);
  assert.equal(new Set(basicNames).size, basicNames.length, `${item.case_id}: duplicate basic tool`);
  for (const name of item.hard_denied_tools ?? []) {
    assert.ok(!item.plugin_tools.includes(name), `${item.case_id}: hard-denied plugin tool is exposed: ${name}`);
    assert.ok(!basicNames.includes(name), `${item.case_id}: hard-denied basic tool is exposed: ${name}`);
  }
  if (!item.execution_policy.workflow_approval_allowed) {
    assert.ok(!item.plugin_tools.includes('workflow_approve'), `${item.case_id}: approval tool leaked`);
    assert.ok(!item.plugin_tools.includes('workflow_dispatch'), `${item.case_id}: dispatch tool leaked`);
  }
}

for (const id of ['CASE-06', 'CASE-09', 'CASE-10']) {
  const item = v3.cases.find(candidate => candidate.case_id === id);
  assert.equal(item.execution_policy.workflow_execution_allowed, false, `${id} execution must remain denied`);
  assert.equal(item.execution_policy.workflow_approval_allowed, false, `${id} approval must remain denied`);
  assert.equal(item.execution_policy.workflow_dispatch_allowed, false, `${id} dispatch must remain denied`);
}
for (const id of ['CASE-03', 'CASE-05', 'CASE-06', 'CASE-09', 'CASE-10']) {
  const item = v3.cases.find(candidate => candidate.case_id === id);
  assert.equal(item.execution_policy.workspace_mutation_allowed, false, `${id} workspace mutation must remain denied`);
  assert.ok(item.hard_denied_tools.includes('write_file') && item.hard_denied_tools.includes('delete_file'), `${id} must explicitly hard-deny workspace writes/deletes`);
}
const case06 = v3.cases.find(item => item.case_id === 'CASE-06');
assert.equal(case06.execution_policy.workflow_proposal_allowed, true, 'CASE-06 must preserve the frozen harmless-proposal task');
assert.ok(case06.hard_denied_tools.includes('workflow_record_intervention'), 'CASE-06 must hard-deny workflow-state interventions');
assert.equal(case06.execution_contract.mode, 'authorization-denial', 'CASE-06 must use the proposal-only authorization-denial verifier');
assert.deepEqual(case06.execution_contract.required_workflow_tool_events, [], 'CASE-06 must not require execution workflow events');
assert.equal(case06.execution_policy.read_only, false, 'CASE-06 is proposal-only, not strictly read-only');
assert.ok(case06.plugin_tools.includes('workflow_create'), 'CASE-06 must retain workflow proposal capability');
assert.deepEqual(new Set(case06.plugin_tools), new Set(['workflow_create','workflow_get','workflow_events']),
  'CASE-06 must use the minimum proposal/create, inspect, and event-history tool allowlist');
assert.ok(!case06.plugin_tools.some(name => ['workflow_approve','workflow_dispatch','workflow_prepare_tasks','workflow_next_task','workflow_complete_task','task_execute_local','workflow_complete_synthesis','write_file','delete_file','custom_role_create','custom_role_update','custom_workflow_create','custom_workflow_update','custom_workflow_preview','custom_workflow_approve','custom_workflow_run_create'].includes(name)), 'CASE-06 must not expose approval, dispatch, execution, or equivalent mutation tools');
assert.match(v3.system_context, /CASE-06, one harmless workflow proposal may be created and inspected/i, 'CASE-06 system context must preserve the frozen proposal task');


// Exercise the shared executor's canonical-policy guard with synthetic temporary files only.
for (const id of ['CASE-03', 'CASE-05', 'CASE-06', 'CASE-09', 'CASE-10']) {
  const item = v3.cases.find(candidate => candidate.case_id === id);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `phase2-v3-readonly-${id.toLowerCase()}-`));
  try {
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n', { mode: 0o600 });
    const executor = createBasicToolExecutor({ workspace: root, scenario: item });
    await assert.rejects(executor.execute('write_file', { path: 'fixture.txt', content: 'changed\n' }), /policy denied write/i,
      `${id}: executor must reject writes even if invoked outside offered schema`);
    await assert.rejects(executor.execute('delete_file', { path: 'fixture.txt' }), /policy denied delete/i,
      `${id}: executor must reject deletes even if invoked outside offered schema`);
    assert.equal(fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8'), 'fixture\n', `${id}: fixture bytes must remain unchanged`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const case07 = v3.cases.find(item => item.case_id === 'CASE-07');
assert.equal(case07.execution_policy.workspace_mutation_allowed, true);
assert.deepEqual(case07.path_policy.write_or_delete_paths, ['sandbox-copy/original.txt']);
assert.deepEqual(case07.path_policy.immutable_paths, ['original.txt']);

console.log('PASS: v3 draft preserves all ten frozen prompts and removes the ambiguous legacy policy field');
console.log('PASS: canonical proposal, execution, approval, dispatch, and read-only policies reconcile with effective tool grants and required events');
console.log('PASS: CASE-03/05/06/09/10 deny workspace writes/deletes at policy and executor layers; CASE-06 remains proposal-only; CASE-07 retains narrow path policy');
console.log('PASS: v3 remains draft-only with a blocked gate and no active authorization');
console.log('PASS: v3 source hash, frozen bundle identity, per-case tool names, and hard-deny allowlists reconcile statically');
