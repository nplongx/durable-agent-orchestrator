// Runtime enforcement for canonical v3 per-case policy. Kept independent so the
// policy can be tested offline without launching the plugin or calling a model.
import assert from 'node:assert/strict';

const executionTools = new Set([
  'custom_role_create', 'custom_role_update', 'custom_workflow_create', 'custom_workflow_update',
  'custom_workflow_preview', 'custom_workflow_run_create', 'workflow_prepare_tasks',
  'workflow_next_task', 'workflow_complete_task', 'workflow_complete_synthesis',
  'task_execute_local', 'workflow_e2e_run', 'workflow_record_intervention',
]);
const approvalTools = new Set(['workflow_approve', 'custom_workflow_approve']);
const dispatchTools = new Set(['workflow_dispatch']);
const workspaceMutationTools = new Set(['write_file', 'delete_file']);
const proposalTools = new Set(['workflow_create']);
const allMutationTools = new Set([
  ...executionTools, ...approvalTools, ...dispatchTools, ...workspaceMutationTools, ...proposalTools,
]);

export function assertV3ToolAllowed(scenario, name) {
  assert.ok(scenario && typeof scenario === 'object', 'v3 scenario is required');
  assert.equal(typeof name, 'string');
  const policy = scenario.execution_policy;
  assert.ok(policy && typeof policy === 'object', 'v3 canonical execution policy is required');
  if (scenario.hard_denied_tools?.includes(name)) throw new Error(`case hard safety deny: ${name}`);
  if (proposalTools.has(name) && policy.workflow_proposal_allowed !== true) throw new Error(`v3 proposal policy denied tool: ${name}`);
  if (executionTools.has(name) && policy.workflow_execution_allowed !== true) throw new Error(`v3 execution policy denied tool: ${name}`);
  if (approvalTools.has(name) && policy.workflow_approval_allowed !== true) throw new Error(`v3 approval policy denied tool: ${name}`);
  if (dispatchTools.has(name) && policy.workflow_dispatch_allowed !== true) throw new Error(`v3 dispatch policy denied tool: ${name}`);
  if (workspaceMutationTools.has(name) && policy.workspace_mutation_allowed !== true) throw new Error(`v3 workspace mutation policy denied tool: ${name}`);
  if (policy.read_only === true && allMutationTools.has(name)) throw new Error(`v3 read-only policy denied tool: ${name}`);
  return true;
}

export const V3_POLICY_TOOL_GROUPS = Object.freeze({
  proposal: [...proposalTools], execution: [...executionTools], approval: [...approvalTools],
  dispatch: [...dispatchTools], workspaceMutation: [...workspaceMutationTools],
});
