#!/usr/bin/env node
import assert from 'node:assert/strict';
import { normalizeCase01CustomRoleArgs, normalizeCase01CustomWorkflowArgs, normalizeCase01WorkflowRunArgs } from './case01-workflow-contract.mjs';
const rawRole = { role_id:'case01-role', name:'Case 01 Role', description:'role', system_prompt:'prompt',
  input_contract:['job.request','requirements'], output_artifact_type:'requirements',
  allowed_capabilities:['product.requirements','research.collect'], permissions:['workspace.read','artifact.create'] };
const roleBefore = structuredClone(rawRole);
const normalizedRole = normalizeCase01CustomRoleArgs(rawRole);
assert.deepEqual(rawRole, roleBefore, 'role normalizer must preserve model-originated arguments for trace audit');
assert.equal(normalizedRole.effectiveArgs.role_id,'case01-requirements');
assert.deepEqual(normalizedRole.effectiveArgs.allowed_capabilities,['product.requirements']);
assert.deepEqual(normalizedRole.effectiveArgs.input_contract,['job.request']);
assert.equal(normalizedRole.normalized,true);
assert.throws(() => normalizeCase01CustomRoleArgs({...rawRole, output_artifact_type:'implementation'}), /output_artifact_type must be requirements/);
assert.throws(() => normalizeCase01CustomRoleArgs({...rawRole, permissions:['workspace.read']}), /required minimum permissions/);
const raw = { workflow_id: 'case01-artifact-lineage', name: 'CASE-01 Artifact Lineage', input_contract: ['job.request'], tasks: [
  { id: 'create-validate', role_id: 'case01-requirements', role_version: 1 },
  { id: 'create-validate', role_id: 'case01-requirements', role_version: 1 },
] };
const before = structuredClone(raw);
const normalized = normalizeCase01CustomWorkflowArgs(raw);
assert.deepEqual(raw, before, 'normalizer must not mutate the model-originated trace arguments');
assert.equal(normalized.normalized, true);
assert.equal(normalized.normalization.task_count_before, 2);
assert.equal(normalized.normalization.task_count_after, 1);
assert.deepEqual(normalized.effectiveArgs.tasks, [{ id:'create-validate', role_id:'case01-requirements', role_version:1,
  input_contract:['job.request'], output_artifact_type:'requirements', depends_on:[] }]);
assert.deepEqual(normalizeCase01CustomWorkflowArgs({ ...raw, tasks: [raw.tasks[0]] }).effectiveArgs, normalized.effectiveArgs);
const corrected = normalizeCase01CustomWorkflowArgs({ ...raw, workflow_id:'case01-workflow', tasks:[{id:'create-config',role_id:'case01-role',role_version:1},{id:'create-result',role_id:'case01-role',role_version:1}] });
assert.equal(corrected.effectiveArgs.workflow_id,'case01-artifact-lineage');
assert.equal(corrected.effectiveArgs.tasks.length,1);
assert.equal(corrected.normalization.workflow_id_before,'case01-workflow');
assert.throws(() => normalizeCase01CustomWorkflowArgs({ ...raw, tasks: [] }), /provide the required create-validate task/);
assert.throws(() => normalizeCase01CustomWorkflowArgs({ ...raw, tasks: [{ id:'other', role_id:'case01-role', role_version:2 }] }), /version-1 custom role/);
const canonicalRun = { workspace: '/case/workspace', workflow_id: 'case01-artifact-lineage' };
const canonicalRunResult = normalizeCase01WorkflowRunArgs(canonicalRun);
assert.equal(canonicalRunResult.effectiveArgs.workspace, '/case/workspace');
assert.equal(canonicalRunResult.normalized, false);
const observedAlias = { workspace: 'case/workspace', workflow_id: 'case01-artifact-lineage' };
const observedAliasBefore = structuredClone(observedAlias);
const aliasResult = normalizeCase01WorkflowRunArgs(observedAlias);
assert.deepEqual(observedAlias, observedAliasBefore, 'workspace normalizer must preserve raw model arguments');
assert.equal(aliasResult.effectiveArgs.workspace, '/case/workspace');
assert.equal(aliasResult.normalized, true);
assert.deepEqual(aliasResult.normalization, { workspace_before: 'case/workspace', workspace_after: '/case/workspace', rule: 'exact-known-alias' });
for (const workspace of ['/home/example', '/tmp/workspace', '../case/workspace', '/case/workspace/..', '', 'case//workspace', './case/workspace']) {
  assert.throws(() => normalizeCase01WorkflowRunArgs({ workspace }), /sandbox policy/,
    `must reject unsafe/noncanonical workspace ${JSON.stringify(workspace)}`);
}
console.log('PASS: role and workflow proposals are deterministically canonicalized to the frozen minimum CASE-01 contract');
console.log('PASS: exact workspace accepted; only observed alias canonicalized; host, traversal, and arbitrary paths rejected');
console.log('PASS: raw model arguments remain unchanged for audit; effective arguments strip extra capabilities/tasks before plugin RPC');
console.log('PASS: invalid artifact type, missing minimum permissions, empty tasks, and non-v1 role references fail closed');
