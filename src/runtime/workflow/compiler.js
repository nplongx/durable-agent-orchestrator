import crypto from 'node:crypto';
import { isProductionWorkflow, ProductionWorkflow } from './definitions/production.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
  if (!isProductionWorkflow(job)) throw new Error('unsupported workflow for execution plan: ' + (job.title || job.job_id));
  validateWorkflowDefinition(ProductionWorkflow);
  const children = productionChildTaskSpecs(workspace).map(spec => ({ id: spec.id, role: spec.role, execution: spec.execution }));
  const synthesis = productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace });
  const plan = {
    schema_version: 1,
    workflow_id: ProductionWorkflow.id,
    workflow_version: ProductionWorkflow.version,
    job_id: job.job_id,
    phases: [...ProductionWorkflow.phases],
    required_children: [...ProductionWorkflow.requiredChildren],
    children,
    synthesis: { id: synthesis.id, role: synthesis.role, execution: synthesis.execution }
  };
  validateExecutionPlan(plan);
  const planJson = canonicalJson(plan);
  return Object.freeze({ ...plan, plan_hash: hash(planJson) });
}
