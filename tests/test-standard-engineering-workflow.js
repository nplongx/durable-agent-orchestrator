import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StandardEngineeringWorkflow, StandardEngineeringTaskId, isStandardEngineeringWorkflow } from '../src/runtime/workflow/definitions/standard-engineering.js';
import { standardEngineeringTaskSpecs, standardEngineeringTaskSpec, standardEngineeringValidationTaskSpecs } from '../src/runtime/workflow/catalog/standard-engineering.js';
import { validateStandardEngineeringWorkflow } from '../src/runtime/workflow/schema.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { resolveValidationProfileSnapshot, materializeValidationProfileTasks } from '../src/runtime/workflow/policy-contract.js';

assert.equal(isStandardEngineeringWorkflow({ title: 'Engineering Standard delivery' }), true);
assert.equal(validateStandardEngineeringWorkflow('/tmp'), true);
assert.equal(StandardEngineeringWorkflow.version, 3);
assert.deepEqual(standardEngineeringTaskSpecs('/tmp').map(x => x.role), [
  'product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'
]);
const specs = standardEngineeringTaskSpecs('/tmp');
const byRole = Object.fromEntries(specs.map(x => [x.role, x]));
assert.deepEqual(byRole.architect.dependencies, [StandardEngineeringTaskId.PRODUCT_OWNER, StandardEngineeringTaskId.RESEARCHER]);
assert.deepEqual(byRole.engineer.dependencies, [StandardEngineeringTaskId.ARCHITECT]);
assert.deepEqual(byRole.reviewer.dependencies, [StandardEngineeringTaskId.SECURITY, StandardEngineeringTaskId.QA, StandardEngineeringTaskId.PLATFORM, StandardEngineeringTaskId.WRITER]);
assert.equal(standardEngineeringTaskSpec(StandardEngineeringTaskId.CTO_SYNTHESIS, { workspace: '/tmp' }).dependencies[0], StandardEngineeringTaskId.REVIEWER);

const expectedValidationTasks = [
  ['standard-batch-test-execution-batch', 'tests/test-execution-batch.js'],
  ['standard-batch-test-execution-concurrency', 'tests/test-execution-batch-concurrency.js'],
  ['standard-batch-test-terminal-recovery', 'tests/test-execution-batch-terminal-recovery.js'],
  ['standard-batch-test-success-contract', 'tests/test-execution-success-contract.js'],
  ['standard-batch-test-phase5-recovery', 'tests/test-phase5-recovery.js'],
  ['standard-batch-test-agent-tool-guidance', 'tests/test-agent-tool-guidance.js'],
  ['standard-batch-test-process-boundary', 'tests/test-execution-control-process-boundary.js'],
  ['standard-batch-test-package-no-overwrite', 'tests/test-package-no-overwrite.js'],
  ['standard-batch-test-package-reproducibility', 'tests/test-package-reproducibility.js'],
  ['standard-batch-test-verified-result-atomicity', 'tests/test-verified-execution-result-atomicity.js'],
  ['standard-batch-test-standard-engineering-planner', 'tests/test-standard-engineering-workflow.js']
];
const expectedValidationIds = expectedValidationTasks.map(([id]) => id);
const validationTasks = standardEngineeringValidationTaskSpecs('/tmp');
assert.deepEqual(validationTasks.map(task => task.id), expectedValidationIds,
  'default validation plan must keep its six original IDs and pin the four missing tests plus planner regression');
assert.equal(new Set(validationTasks.map(task => task.id)).size, validationTasks.length, 'validation task IDs must be unique');
assert.equal(new Set(validationTasks.map(task => task.role)).size, validationTasks.length, 'validation task roles must be unique');
for (const [index, [id, relativePath]] of expectedValidationTasks.entries()) {
  const task = validationTasks[index];
  const testFileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  assert.equal(task.id, id);
  assert.equal(fs.statSync(new URL('./' + testFileName, import.meta.url)).isFile(), true,
    'validation test must exist as a file in the repository: ' + relativePath);
  assert.deepEqual(task.execution.args, ['--test', path.resolve('/tmp', relativePath)],
    'validation command arguments must be pinned for ' + relativePath);
  assert.equal(task.execution.command, ['node', '--test', path.resolve('/tmp', relativePath)].join(' '));
  assert.equal(task.execution.cwd, '/tmp');
  assert.equal(task.execution.timeout_ms, 300_000);
  assert.equal(task.execution.executor, 'ExecutionManager');
  assert.equal(task.execution.executable, 'node');
  assert.equal(task.execution.deterministic, true);
  assert.equal(task.execution.batch_validation_task, true);
  assert.equal(task.execution.output_artifact_type, 'qa-report');
  assert.deepEqual(task.dependencies, [StandardEngineeringTaskId.ENGINEER]);
}

const plan = compileWorkflowPlan({ job_id: 'standard-test', title: 'Software delivery: payments' }, { workspace: '/tmp' });
assert.equal(plan.workflow_id, 'standard-engineering');
assert.equal(plan.workflow_version, 3);
assert.equal(plan.children.length, 9);
assert.deepEqual(plan.required_children, StandardEngineeringWorkflow.requiredChildren);
assert.ok(plan.plan_hash);
const legacyV2 = compileWorkflowPlan({ job_id: 'standard-v2-test', title: 'Software delivery: legacy compatibility' }, { workspace: '/tmp', workflowVersion: 2 });
assert.equal(legacyV2.workflow_version, 2, 'revalidation must preserve a stored v2 plan version rather than upgrade it');
assert.equal(Object.hasOwn(legacyV2, 'required_operations'), false, 'legacy v2 plans must not gain workspace-write authority');
const scopedV3 = compileWorkflowPlan({ job_id: 'standard-v3-write-test', title: 'Software delivery: scoped write' }, {
  workspace: process.cwd(), requiredOperations: ['workspace.write'],
  workspaceWriteScopes: [{ role: 'writer', paths: [{ path: 'docs/workflow-lifecycle.md', kind: 'file' }] }]
});
assert.deepEqual(scopedV3.required_operations, ['workspace.write']);
assert.equal(scopedV3.children.find(item => item.role === 'writer').execution.execution_mode, 'host-conversation-scoped-workspace-write');
assert.equal(scopedV3.children.find(item => item.role === 'writer').execution.workspace_write_contract.paths[0].path, 'docs/workflow-lifecycle.md');
assert.deepEqual(scopedV3.batch_execution_policy.validation_task_ids, expectedValidationIds,
  'workspace-write plans must pin all eleven default deterministic validation tasks');
for (const role of ['security', 'qa', 'platform', 'writer']) {
  const specialist = scopedV3.children.find(item => item.role === role);
  assert.deepEqual(specialist.dependencies, [StandardEngineeringTaskId.ENGINEER, ...expectedValidationIds],
    role + ' must wait for the complete immutable deterministic validation batch');
}
for (const [id] of expectedValidationTasks) {
  assert.ok(scopedV3.children.some(item => item.id === id),
    'compiled workspace-write plan must include task ' + id);
}
assert.equal(Object.hasOwn(plan, 'validation_profile'), false, 'unselected plans must preserve their legacy serialization');

const coreProfile = resolveValidationProfileSnapshot({ profile_id: 'core-release-validation', profile_version: 1 });
assert.match(coreProfile.content_hash, /^[a-f0-9]{64}$/);
const coreProfileTasks = materializeValidationProfileTasks(coreProfile, '/tmp');
assert.equal(coreProfileTasks.length, 8);
assert.equal(coreProfileTasks.some(item => item.id === 'standard-plugin-e2e'), false);
assert.deepEqual(coreProfileTasks.find(item => item.id === 'standard-docs-check').dependencies,
  [StandardEngineeringTaskId.ENGINEER, 'standard-docs-generate-reference']);
assert.deepEqual(coreProfileTasks.find(item => item.id === 'standard-docs-generate-reference').execution.args,
  ['/tmp/scripts/generate-mcp-reference.mjs']);
assert.deepEqual(coreProfileTasks.find(item => item.id === 'standard-docs-check').execution.args,
  ['/tmp/scripts/check-docs.mjs']);

const profileScope = [{ role: 'engineer', paths: [{ path: 'server/index.js', kind: 'file' }] }];
const coreProfilePlan = compileWorkflowPlan({ job_id: 'standard-core-profile-test', title: 'Software delivery: core profile' }, {
  workspace: '/tmp',
  requiredOperations: ['workspace.write'],
  workspaceWriteScopes: profileScope,
  validationProfileSelector: { profile_id: 'core-release-validation', profile_version: 1 }
});
assert.equal(coreProfilePlan.schema_version, 2);
assert.equal(coreProfilePlan.validation_profile.content_hash, coreProfile.content_hash);
assert.equal(coreProfilePlan.children.length, 17);
assert.equal(coreProfilePlan.children.some(item => item.id === 'standard-plugin-e2e'), false);
assert.deepEqual(coreProfilePlan.batch_execution_policy.validation_task_ids,
  coreProfileTasks.map(item => item.id));
assert.equal(coreProfilePlan.batch_execution_policy.validation_task_ids.some(id => expectedValidationIds.includes(id)), false,
  'the immutable core-release-validation@1 profile must not inherit default task-list changes');


const workspaceSmokeProfile = resolveValidationProfileSnapshot({ profile_id: 'mcpb-workspace-smoke', profile_version: 1 });
assert.match(workspaceSmokeProfile.content_hash, /^[a-f0-9]{64}$/);
assert.equal(workspaceSmokeProfile.route, 'mcpb-workspace-smoke');
const workspaceSmokeTasks = materializeValidationProfileTasks(workspaceSmokeProfile, '/tmp');
const expectedWorkspaceSmoke = [
  ['standard-mcpb-workspace-smoke-execution-batch', 'tests/test-execution-batch.js'],
  ['standard-mcpb-workspace-smoke-execution-concurrency', 'tests/test-execution-batch-concurrency.js'],
  ['standard-mcpb-workspace-smoke-terminal-recovery', 'tests/test-execution-batch-terminal-recovery.js'],
  ['standard-mcpb-workspace-smoke-success-contract', 'tests/test-execution-success-contract.js'],
  ['standard-mcpb-workspace-smoke-phase5-recovery', 'tests/test-phase5-recovery.js'],
  ['standard-mcpb-workspace-smoke-agent-tool-guidance', 'tests/test-agent-tool-guidance.js']
];
assert.deepEqual(workspaceSmokeTasks.map(item => item.id), expectedWorkspaceSmoke.map(([id]) => id));
assert.equal(new Set(workspaceSmokeTasks.map(item => item.id)).size, workspaceSmokeTasks.length);
for (const [index, [id, testPath]] of expectedWorkspaceSmoke.entries()) {
  const task = workspaceSmokeTasks[index];
  assert.deepEqual(task.execution.args, ['--test', path.resolve('/tmp', testPath)]);
  assert.equal(task.execution.cwd, '/tmp');
  assert.equal(task.execution.timeout_ms, 300_000);
  assert.equal(task.execution.executor, 'ExecutionManager');
  assert.equal(task.execution.executable, 'node');
  assert.equal(task.execution.deterministic, true);
  assert.equal(task.execution.batch_validation_task, true);
  assert.equal(task.execution.output_artifact_type, 'qa-report');
  assert.deepEqual(task.dependencies, [StandardEngineeringTaskId.ENGINEER]);
  assert.equal(expectedValidationIds.includes(id), false, 'profile-specific task IDs must not alias default validation task IDs');
}
const workspaceSmokePlan = compileWorkflowPlan({ job_id: 'standard-workspace-smoke-profile-test', title: 'Software delivery: embedded MCPB smoke profile' }, {
  workspace: process.cwd(),
  requiredOperations: ['workspace.write'],
  workspaceWriteScopes: profileScope,
  validationProfileSelector: { profile_id: 'mcpb-workspace-smoke', profile_version: 1 }
});
assert.equal(workspaceSmokePlan.schema_version, 2);
assert.equal(workspaceSmokePlan.validation_profile.content_hash, workspaceSmokeProfile.content_hash);
assert.equal(workspaceSmokePlan.children.length, 15);
assert.deepEqual(workspaceSmokePlan.batch_execution_policy.validation_task_ids, expectedWorkspaceSmoke.map(([id]) => id));

const e2eProfile = resolveValidationProfileSnapshot({ profile_id: 'plugin-e2e', profile_version: 1 });
const e2eTasks = materializeValidationProfileTasks(e2eProfile, '/tmp');
assert.equal(e2eTasks.length, 1);
assert.deepEqual(e2eTasks[0].execution.args, ['/tmp/tests/test-runalith-plugin.js']);
assert.equal(coreProfile.task_contracts.some(item => item.task_id === e2eTasks[0].id), false);
const e2ePlan = compileWorkflowPlan({ job_id: 'standard-outer-e2e-profile-test', title: 'Software delivery: outer E2E profile' }, {
  workspace: '/tmp',
  requiredOperations: ['workspace.write'],
  workspaceWriteScopes: profileScope,
  validationProfileSelector: { profile_id: 'plugin-e2e', profile_version: 1 }
});
assert.equal(e2ePlan.children.filter(item => item.execution?.validation_profile_id != null).length, 1);
assert.equal(e2ePlan.children.find(item => item.id === 'standard-plugin-e2e').execution.local_only, true);
assert.throws(() => resolveValidationProfileSnapshot({ profile_id: 'core-release-validation', profile_version: 2 }), /unknown validation profile or version/);
assert.throws(() => resolveValidationProfileSnapshot({ profile_id: 'unlisted-profile', profile_version: 1 }), /unknown validation profile or version/);
console.log('STANDARD ENGINEERING WORKFLOW PASS');
