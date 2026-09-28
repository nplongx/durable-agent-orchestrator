import { ProductionWorkflow } from './definitions/production.js';
import { productionTaskSpec } from './catalog/production.js';

export function validateWorkflowDefinition(definition) {
  if (!definition?.id) throw new Error('workflow definition id is required');
  if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error(`invalid workflow version: ${definition.version}`);
  if (!Array.isArray(definition.phases) || definition.phases.length === 0) throw new Error(`workflow ${definition.id} requires phases`);
  if (!Array.isArray(definition.requiredChildren)) throw new Error(`workflow ${definition.id} requires requiredChildren`);
  if (new Set(definition.phases).size !== definition.phases.length) throw new Error(`workflow ${definition.id} contains duplicate phases`);
  if (new Set(definition.requiredChildren).size !== definition.requiredChildren.length) throw new Error(`workflow ${definition.id} contains duplicate child task IDs`);
  return definition;
}

export function validateProductionWorkflow(workspace = process.env.WORKFLOW_WORKSPACE) {
  validateWorkflowDefinition(ProductionWorkflow);
  for (const taskId of ProductionWorkflow.requiredChildren) productionTaskSpec(taskId, { workspace });
  productionTaskSpec(ProductionWorkflow.synthesisTask, { workspace });
  return true;
}
