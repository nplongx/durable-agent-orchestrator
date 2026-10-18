import crypto from 'node:crypto';
import { getWorkflowDefinition } from './definitions/index.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { engineeringTaskSpec, engineeringTaskSpecs } from './catalog/engineering.js';
import { standardEngineeringTaskSpec, standardEngineeringTaskSpecs } from './catalog/standard-engineering.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';
import { normalizeSuccessContract } from './success-contract.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = null } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
  const pinnedSuccessContract = normalizeSuccessContract(successContract || {}, job.title || job.job_id);
  if (customWorkflow) {
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
    const plan = {
      schema_version: 1,
      custom_workflow: true,
      custom_workflow_plan_id: customWorkflow.plan_id,
      custom_workflow_plan_hash: customWorkflow.plan_hash,
      custom_workflow_approved_at: customWorkflow.approved_at,
      workflow_id: `custom-${workflow.workflow_id}`,
      workflow_version: workflow.version,
      job_id: job.job_id,
      success_contract: pinnedSuccessContract,
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
  const children = isProduction
    ? productionChildTaskSpecs(workspace).map(spec => ({ id: spec.id, role: spec.role, execution: spec.execution, capability: null, dependencies: [] }))
    : isStandardEngineering ? standardEngineeringTaskSpecs(workspace) : engineeringTaskSpecs(workspace);
  const synthesis = isProduction
    ? productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace })
    : isStandardEngineering ? standardEngineeringTaskSpec(definition.synthesisTask, { workspace }) : engineeringTaskSpec(definition.synthesisTask, { workspace });
  const plan = {
    schema_version: 1,
    workflow_id: definition.id,
    workflow_version: definition.version,
    job_id: job.job_id,
    success_contract: pinnedSuccessContract,
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
