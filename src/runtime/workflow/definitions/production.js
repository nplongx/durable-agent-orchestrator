import { PRODUCTION_PHASES } from '../phases.js';
import { ProductionTaskId } from '../catalog/production.js';

export const ProductionWorkflow = Object.freeze({
  id: 'production',
  version: 1,
  titlePattern: /production e2e/i,
  phases: PRODUCTION_PHASES,
  requiredChildren: Object.freeze([
    ProductionTaskId.ARCHITECT_CHECK,
    ProductionTaskId.QA_CHECK
  ]),
  synthesisTask: ProductionTaskId.CTO_SYNTHESIS
});

export function isProductionWorkflow(job) {
  return ProductionWorkflow.titlePattern.test(String(job?.title || ''));
}
