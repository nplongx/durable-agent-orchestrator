import crypto from 'node:crypto';
import { getWorkflowDefinition } from './definitions/index.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { engineeringTaskSpec, engineeringTaskSpecs } from './catalog/engineering.js';
import { standardEngineeringTaskSpec, standardEngineeringTaskSpecs } from './catalog/standard-engineering.js';
import { hybridEngineeringTaskSpecs } from './catalog/hybrid-engineering.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';
import { normalizeSuccessContract } from './success-contract.js';
import { composePolicySuccessContract, resolveValidationProfileSnapshot, materializeValidationProfileTasks } from './policy-contract.js';
import { BUILTIN_ROLE_PROFILE_OVERLAY_ROLES, createRoleProfileOverlay } from './role-profiles.js';
import { normalizeWorkspaceWriteContract, workspaceWriteScopeForRole } from './workspace-write-contract.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function defaultBatchExecutionPolicy(children, { requiresWorkspaceValidation = false } = {}) {
  const deterministic = children.filter(task => task.execution?.deterministic === true && task.execution?.executor === 'ExecutionManager');
  const validationIds = children.filter(task => task.execution?.batch_validation_task === true).map(task => task.id);
  if (requiresWorkspaceValidation && validationIds.length === 0) throw new Error('code-writing plans require exact deterministic batch validation task contracts');
  if (deterministic.length) return {
    schema_version: 1, mode: 'required', scope: 'deterministic-local', route: 'batch-required', grouping: 'ready-compatible',
    evidence: 'durable-batch-and-execution-ledger', workspace_fingerprint_required: validationIds.length > 0,
    validation_task_ids: validationIds, exemption_reason: null
  };
  return {
    schema_version: 1, mode: 'exempt', scope: 'deterministic-local', route: 'not-applicable', grouping: 'not-applicable',
    evidence: 'not-applicable', workspace_fingerprint_required: false, validation_task_ids: [],
    exemption_reason: 'This immutable plan has no deterministic local execution tasks and does not authorize workspace.write.'
  };
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = null, policyPacks = [], roleProfiles = [], requiredOperations = [], workspaceWriteScopes = [], workflowVersion = null, batchExecutionPolicy = undefined, validationProfileSelector = null } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
  // null is reserved for existing schema-v1 plans so runtime revalidation never rewrites their hashes.
  const preserveLegacyPlan = batchExecutionPolicy === null;
  if (!Array.isArray(policyPacks)) throw new Error('policyPacks must be an array');
  if (!Array.isArray(roleProfiles)) throw new Error('roleProfiles must be an array');
  const pinnedSuccessContract = normalizeSuccessContract(successContract || {}, job.title || job.job_id);
  if (customWorkflow) {
    if (validationProfileSelector != null) throw new Error('validation profiles are supported only for built-in standard-engineering v3+ plans');
    if ((requiredOperations || []).length || (workspaceWriteScopes || []).length) {
      throw new Error('custom workflows do not support workspace.write; use a supported built-in standard-engineering v3 plan with explicit role scopes');
    }
    if (roleProfiles.length) throw new Error('built-in role profile overlays cannot be combined with a custom workflow');
    const { workflow, tasks, plan: approvedPreview } = customWorkflow;
    if (!workflow?.workflow_id || !Number.isInteger(workflow.version) || !Array.isArray(tasks) || tasks.length !== workflow.tasks.length) {
      throw new Error('approved custom workflow execution spec is incomplete');
    }
    const children = tasks.map((task, index) => ({
      id: task.id,
      role: `custom-task-${index + 1}`,
      capability: task.role.allowed_capabilities[0] || null,
      dependencies: [...task.depends_on],
      execution: {
        deterministic: false,
        custom_role_id: task.role_id,
        custom_role_version: task.role_version,
        custom_role_name: task.role.name,
        custom_role_description: task.role.description,
        custom_role_system_prompt: task.role.system_prompt,
        custom_role_skills: task.role.skills || [],
        custom_role_capabilities: task.role.allowed_capabilities,
        custom_role_permissions: task.role.permissions,
        custom_role_allowed_tools: task.role.allowed_tools,
        input_contract: task.input_contract,
        output_artifact_type: task.output_artifact_type
      }
    }));
    const policyComposition = policyPacks.length ? composePolicySuccessContract(pinnedSuccessContract, policyPacks, {
      workflowId: `custom-${workflow.workflow_id}`,
      children
    }) : null;
    const pinnedBatchExecutionPolicy = preserveLegacyPlan ? null :
      (batchExecutionPolicy === undefined ? defaultBatchExecutionPolicy(children) : batchExecutionPolicy);
    const plan = {
      schema_version: preserveLegacyPlan ? 1 : 2,
      ...(preserveLegacyPlan ? {} : { batch_execution_policy: pinnedBatchExecutionPolicy }),
      custom_workflow: true,
      custom_workflow_plan_id: customWorkflow.plan_id,
      custom_workflow_plan_hash: customWorkflow.plan_hash,
      custom_workflow_approved_at: customWorkflow.approved_at,
      workflow_id: `custom-${workflow.workflow_id}`,
      workflow_version: workflow.version,
      job_id: job.job_id,
      success_contract: policyComposition?.success_contract || pinnedSuccessContract,
      ...(policyComposition ? { base_success_contract: policyComposition.base_success_contract, policy_packs: policyComposition.policy_packs } : {}),
      phases: ['PROPOSED', 'APPROVED', 'SPAWN_CTO', 'ASSIGN_CHILDREN', 'RUN_CHILDREN', 'SYNTHESIZE', 'TERMINALIZE', 'COMPLETED', 'FAILED'],
      required_children: children.map(item => item.role),
      children,
      synthesis: {
        id: `custom-${workflow.workflow_id}-synthesis`,
        role: 'cto',
        capability: 'synthesis.approve',
        dependencies: children.map(item => item.id),
        execution: { deterministic: false, custom_workflow_synthesis: true, output_artifact_type: 'cto-decision' }
      }
    };
    validateExecutionPlan(plan);
    const planJson = canonicalJson(plan);
    return Object.freeze({ ...plan, plan_hash: hash(planJson) });
  }
  const latestDefinition = getWorkflowDefinition(job);
  if (!latestDefinition) throw new Error('unsupported workflow for execution plan: ' + (job.title || job.job_id));
  const supportedLegacyVersion = latestDefinition.id === 'standard-engineering' && latestDefinition.version === 3 && workflowVersion === 2;
  if (workflowVersion != null && (!Number.isSafeInteger(workflowVersion) || workflowVersion < 1 || workflowVersion > latestDefinition.version ||
      (workflowVersion !== latestDefinition.version && !supportedLegacyVersion))) {
    throw new Error(`unsupported pinned workflow version ${workflowVersion} for ${latestDefinition.id}@${latestDefinition.version}`);
  }
  // Revalidation must compile against the version pinned by an existing plan,
  // not silently upgrade it to today's definition. Current historical versions
  // share the same task graph; version-specific contracts are gated below.
  const definition = workflowVersion == null || workflowVersion === latestDefinition.version
    ? latestDefinition : Object.freeze({ ...latestDefinition, version: workflowVersion });
  validateWorkflowDefinition(definition);
  const isProduction = definition.id === 'production';
  const isStandardEngineering = definition.id === 'standard-engineering';
  const isHybridEngineering = definition.id === 'hybrid-engineering';
  const workspaceWriteContract = normalizeWorkspaceWriteContract({
    workflowId: definition.id,
    workflowVersion: definition.version,
    workspace,
    requiredOperations,
    scopes: workspaceWriteScopes,
    customWorkflow: false
  });
  const validationProfileSnapshot = validationProfileSelector == null ? null : resolveValidationProfileSnapshot(validationProfileSelector);
  if (validationProfileSnapshot && (!isStandardEngineering || definition.version < 3 || !workspaceWriteContract)) {
    throw new Error('validation profiles require an explicit workspace.write contract on standard-engineering v3+');
  }
  if (validationProfileSnapshot && preserveLegacyPlan) {
    throw new Error('validation profiles cannot be added to a legacy schema-v1 immutable plan');
  }
  const validationProfileTasks = validationProfileSnapshot
    ? materializeValidationProfileTasks(validationProfileSnapshot, workspace)
    : null;
  if (roleProfiles.length && !isStandardEngineering && !isHybridEngineering) {
    throw new Error('role profile overlays are currently supported only for standard-engineering and hybrid-engineering workflows');
  }
  const profilesByRole = new Map();
  for (const binding of roleProfiles) {
    if (!binding || !BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.includes(binding.role) || !binding.profile) {
      throw new Error('roleProfiles contains an unsupported built-in role or missing profile snapshot');
    }
    if (profilesByRole.has(binding.role)) throw new Error(`duplicate role profile overlay for built-in role: ${binding.role}`);
    profilesByRole.set(binding.role, binding);
  }
  const baseChildren = isProduction
    ? productionChildTaskSpecs(workspace).map(spec => ({ id: spec.id, role: spec.role, execution: spec.execution, capability: null, dependencies: [] }))
    : isHybridEngineering ? hybridEngineeringTaskSpecs(workspace)
      : isStandardEngineering ? standardEngineeringTaskSpecs(workspace, {
        includeBatchValidation: Boolean(workspaceWriteContract && !preserveLegacyPlan && !validationProfileSnapshot),
        validationTasks: validationProfileTasks
      }) : engineeringTaskSpecs(workspace);
  const children = baseChildren.map(spec => {
    const binding = profilesByRole.get(spec.role);
    let execution = spec.execution;
    if (workspaceWriteContract) {
      const roleScope = workspaceWriteScopeForRole(workspaceWriteContract, spec.role);
      if (roleScope) {
        execution = {
          ...execution,
          execution_mode: 'host-conversation-scoped-workspace-write',
          workspace_write_contract: {
            version: workspaceWriteContract.version,
            operation: 'workspace.write',
            mode: workspaceWriteContract.mode,
            role: spec.role,
            paths: roleScope.paths,
            max_file_bytes: workspaceWriteContract.max_file_bytes,
            precondition: workspaceWriteContract.precondition,
            recovery: workspaceWriteContract.recovery
          }
        };
      }
    }
    if (!binding) return execution === spec.execution ? spec : { ...spec, execution };
    if (execution?.deterministic) throw new Error(`role profile overlay cannot bind deterministic task: ${spec.id}`);
    const overlay = createRoleProfileOverlay(spec.role, binding.profile, binding.profile_hash);
    return { ...spec, execution: { ...execution, role_profile_overlay: overlay } };
  });
  for (const role of profilesByRole.keys()) {
    if (!children.some(child => child.role === role)) throw new Error(`built-in role profile binding does not map to a task in this workflow: ${role}`);
  }
  const synthesis = isProduction
    ? productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace })
    : isHybridEngineering
      ? { ...standardEngineeringTaskSpec(definition.synthesisTask, { workspace }), dependencies: children.map(item => item.id) }
      : isStandardEngineering ? standardEngineeringTaskSpec(definition.synthesisTask, { workspace }) : engineeringTaskSpec(definition.synthesisTask, { workspace });
  const pinnedBatchExecutionPolicy = preserveLegacyPlan ? null :
    (batchExecutionPolicy === undefined
      ? defaultBatchExecutionPolicy(children, { requiresWorkspaceValidation: Boolean(workspaceWriteContract) })
      : batchExecutionPolicy);
  const policyComposition = policyPacks.length ? composePolicySuccessContract(pinnedSuccessContract, policyPacks, {
    workflowId: definition.id,
    children
  }) : null;
  const plan = {
    schema_version: preserveLegacyPlan ? 1 : 2,
    ...(preserveLegacyPlan ? {} : { batch_execution_policy: pinnedBatchExecutionPolicy }),
    workflow_id: definition.id,
    workflow_version: definition.version,
    job_id: job.job_id,
    success_contract: policyComposition?.success_contract || pinnedSuccessContract,
    ...(validationProfileSnapshot ? { validation_profile: validationProfileSnapshot } : {}),
    ...(policyComposition ? { base_success_contract: policyComposition.base_success_contract, policy_packs: policyComposition.policy_packs } : {}),
    phases: [...definition.phases],
    required_children: children.map(item => item.id),
    children,
    ...(workspaceWriteContract ? {
      required_operations: [...workspaceWriteContract.required_operations],
      workspace_write_scopes: workspaceWriteContract.scopes,
      workspace_write_contract_version: workspaceWriteContract.version
    } : {}),
    synthesis: {
      id: synthesis.id,
      role: synthesis.role,
      capability: synthesis.capability || null,
      dependencies: synthesis.dependencies || [],
      execution: synthesis.execution
    }
  };
  validateExecutionPlan(plan);
  const planJson = canonicalJson(plan);
  return Object.freeze({ ...plan, plan_hash: hash(planJson) });
}
