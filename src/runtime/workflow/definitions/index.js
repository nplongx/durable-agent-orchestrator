import { EngineeringWorkflow, isEngineeringWorkflow } from './engineering.js';
import { ProductionWorkflow, isProductionWorkflow } from './production.js';

export function getWorkflowDefinition(job) {
  if (isProductionWorkflow(job)) return ProductionWorkflow;
  if (isEngineeringWorkflow(job)) return EngineeringWorkflow;
  return null;
}

export function isSupportedWorkflow(job) {
  return Boolean(getWorkflowDefinition(job));
}

export { EngineeringWorkflow, ProductionWorkflow, isEngineeringWorkflow, isProductionWorkflow };
