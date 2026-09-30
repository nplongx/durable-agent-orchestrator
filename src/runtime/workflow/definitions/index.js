import { EngineeringWorkflow, isEngineeringWorkflow } from './engineering.js';
import { ProductionWorkflow, isProductionWorkflow } from './production.js';
import { StandardEngineeringWorkflow, isStandardEngineeringWorkflow } from './standard-engineering.js';

export function getWorkflowDefinition(job) {
  if (isProductionWorkflow(job)) return ProductionWorkflow;
  if (isStandardEngineeringWorkflow(job)) return StandardEngineeringWorkflow;
  if (isEngineeringWorkflow(job)) return EngineeringWorkflow;
  return null;
}

export function isSupportedWorkflow(job) {
  return Boolean(getWorkflowDefinition(job));
}

export { EngineeringWorkflow, ProductionWorkflow, StandardEngineeringWorkflow, isEngineeringWorkflow, isProductionWorkflow, isStandardEngineeringWorkflow };
