import { EngineeringWorkflow, isEngineeringWorkflow } from './engineering.js';
import { ProductionWorkflow, isProductionWorkflow } from './production.js';
import { StandardEngineeringWorkflow, isStandardEngineeringWorkflow } from './standard-engineering.js';
import { HybridEngineeringWorkflow, isHybridEngineeringWorkflow } from './hybrid-engineering.js';

export function getWorkflowDefinition(job) {
  if (isProductionWorkflow(job)) return ProductionWorkflow;
  if (isHybridEngineeringWorkflow(job)) return HybridEngineeringWorkflow;
  if (isStandardEngineeringWorkflow(job)) return StandardEngineeringWorkflow;
  if (isEngineeringWorkflow(job)) return EngineeringWorkflow;
  return null;
}

export function isSupportedWorkflow(job) {
  return Boolean(getWorkflowDefinition(job));
}

export { EngineeringWorkflow, ProductionWorkflow, StandardEngineeringWorkflow, HybridEngineeringWorkflow, isEngineeringWorkflow, isProductionWorkflow, isStandardEngineeringWorkflow, isHybridEngineeringWorkflow };
