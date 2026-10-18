// Deterministic CASE-01 request canonicalization. Raw model arguments are kept
// in the trace; only the frozen minimum contract is sent to the private plugin.
export function normalizeCase01CustomRoleArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('CASE-01 role contract: arguments must be an object.');
  if (args.output_artifact_type !== 'requirements') throw new Error('CASE-01 role contract: output_artifact_type must be requirements.');
  if (!Array.isArray(args.input_contract) || !args.input_contract.includes('job.request')) throw new Error('CASE-01 role contract: input_contract must include job.request.');
  if (!Array.isArray(args.permissions) || !['workspace.read', 'artifact.create'].every(value => args.permissions.includes(value))) {
    throw new Error('CASE-01 role contract: required minimum permissions are workspace.read and artifact.create.');
  }
  const effectiveArgs = {
    role_id: 'case01-requirements', name: 'CASE-01 Requirements',
    description: 'Collect and validate requirements for the CASE-01 configuration workflow.',
    system_prompt: 'Extract the request requirements, state verified facts and assumptions separately, and do not claim execution without evidence.',
    input_contract: ['job.request'], output_artifact_type: 'requirements',
    allowed_capabilities: ['product.requirements'], permissions: ['workspace.read', 'artifact.create'], allowed_tools: [],
  };
  return { effectiveArgs, normalized: JSON.stringify(args) !== JSON.stringify(effectiveArgs),
    normalization: { role_id_before: args.role_id ?? null, role_id_after: effectiveArgs.role_id,
      capabilities_before: args.allowed_capabilities ?? [], capabilities_after: effectiveArgs.allowed_capabilities,
      permissions_before: args.permissions, permissions_after: effectiveArgs.permissions } };
}

export function normalizeCase01CustomWorkflowArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('CASE-01 workflow contract: arguments must be an object.');
  if (!Array.isArray(args.tasks) || args.tasks.length < 1) throw new Error('CASE-01 workflow contract: provide the required create-validate task.');
  const selected = args.tasks[0];
  if (!selected || typeof selected !== 'object' || typeof selected.role_id !== 'string' || selected.role_version !== 1) {
    throw new Error('CASE-01 workflow contract: first task must reference a version-1 custom role.');
  }
  const task = { id: 'create-validate', role_id: 'case01-requirements', role_version: 1,
    input_contract: ['job.request'], output_artifact_type: 'requirements', depends_on: [] };
  const effectiveArgs = { ...args, workflow_id: 'case01-artifact-lineage', input_contract: ['job.request'], tasks: [task] };
  return { effectiveArgs, normalized: JSON.stringify(args) !== JSON.stringify(effectiveArgs),
    normalization: { workflow_id_before: args.workflow_id ?? null, workflow_id_after: effectiveArgs.workflow_id,
      task_count_before: args.tasks.length, task_count_after: 1,
      task_identity_before: { id: selected.id ?? null, role_id: selected.role_id, role_version: selected.role_version },
      canonical_task_fields: ['id','role_id','role_version','input_contract','output_artifact_type','depends_on'] } };
}


// Constrain run-proposal workspace to the existing private sandbox mount. The
// single observed relative spelling is canonicalized explicitly; no path
// resolution or general normalization is permitted.
export function normalizeCase01WorkflowRunArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('CASE-01 workflow run contract: arguments must be an object.');
  if (args.workspace === '/case/workspace') {
    return { effectiveArgs: args, normalized: false, normalization: { workspace_before: args.workspace, workspace_after: args.workspace } };
  }
  if (args.workspace === 'case/workspace') {
    const effectiveArgs = { ...args, workspace: '/case/workspace' };
    return { effectiveArgs, normalized: true, normalization: { workspace_before: args.workspace, workspace_after: effectiveArgs.workspace, rule: 'exact-known-alias' } };
  }
  throw new Error('CASE-01 sandbox policy: custom workflow proposal workspace must be exactly /case/workspace (or the exact known alias case/workspace); host paths and all other paths are forbidden.');
}
