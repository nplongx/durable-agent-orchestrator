import crypto from 'node:crypto';
import { getWorkflowDefinition } from './definitions/index.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { engineeringTaskSpec, engineeringTaskSpecs } from './catalog/engineering.js';
import { standardEngineeringTaskSpec, standardEngineeringTaskSpecs } from './catalog/standard-engineering.js';
import { hybridEngineeringTaskSpecs } from './catalog/hybrid-engineering.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';
import { normalizeSuccessContract } from './success-contract.js';
import { composePolicySuccessContract } from './policy-contract.js';
import { BUILTIN_ROLE_PROFILE_OVERLAY_ROLES, createRoleProfileOverlay } from './role-profiles.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = null, policyPacks = [], roleProfiles = [] } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
  if (!Array.isArray(policyPacks)) throw new Error('policyPacks must be an array');
  if (!Array.isArray(roleProfiles)) throw new Error('roleProfiles must be an array');
  const pinnedSuccessContract = normalizeSuccessContract(successContract || {}, job.title || job.job_id);
  if (customWorkflow) {
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
    const plan = {
      schema_version: 1,
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
  const definition = getWorkflowDefinition(job);
  if (!definition) throw new Error('unsupported workflow for execution plan: ' + (job.title || job.job_id));
  validateWorkflowDefinition(definition);
  const isProduction = definition.id === 'production';
  const isStandardEngineering = definition.id === 'standard-engineering';
  const isHybridEngineering = definition.id === 'hybrid-engineering';
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
      : isStandardEngineering ? standardEngineeringTaskSpecs(workspace) : engineeringTaskSpecs(workspace);
  const children = baseChildren.map(spec => {
    const binding = profilesByRole.get(spec.role);
    if (!binding) return spec;
    if (spec.execution?.deterministic) throw new Error(`role profile overlay cannot bind deterministic task: ${spec.id}`);
    const overlay = createRoleProfileOverlay(spec.role, binding.profile, binding.profile_hash);
    return { ...spec, execution: { ...spec.execution, role_profile_overlay: overlay } };
  });
  for (const role of profilesByRole.keys()) {
    if (!children.some(child => child.role === role)) throw new Error(`built-in role profile binding does not map to a task in this workflow: ${role}`);
  }
  const synthesis = isProduction
    ? productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace })
    : isHybridEngineering
      ? { ...standardEngineeringTaskSpec(definition.synthesisTask, { workspace }), dependencies: children.map(item => item.id) }
      : isStandardEngineering ? standardEngineeringTaskSpec(definition.synthesisTask, { workspace }) : engineeringTaskSpec(definition.synthesisTask, { workspace });
  const policyComposition = policyPacks.length ? composePolicySuccessContract(pinnedSuccessContract, policyPacks, {
    workflowId: definition.id,
    children
  }) : null;
  const plan = {
    schema_version: 1,
    workflow_id: definition.id,
    workflow_version: definition.version,
    job_id: job.job_id,
    success_contract: policyComposition?.success_contract || pinnedSuccessContract,
    ...(policyComposition ? { base_success_contract: policyComposition.base_success_contract, policy_packs: policyComposition.policy_packs } : {}),
    phases: [...definition.phases],
    required_children: [...definition.requiredChildren],
    children,
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
