import crypto from 'node:crypto';
import { getWorkflowDefinition } from './definitions/index.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { engineeringTaskSpec, engineeringTaskSpecs } from './catalog/engineering.js';
import { standardEngineeringTaskSpec, standardEngineeringTaskSpecs } from './catalog/standard-engineering.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
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
