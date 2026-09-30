import { WorkflowPhase } from '../phases.js';

export const StandardEngineeringTaskId = Object.freeze({
  PRODUCT_OWNER: 'standard-product-owner',
  RESEARCHER: 'standard-researcher',
  ARCHITECT: 'standard-architect',
  ENGINEER: 'standard-engineer',
  SECURITY: 'standard-security',
  QA: 'standard-qa',
  PLATFORM: 'standard-platform',
  WRITER: 'standard-writer',
  REVIEWER: 'standard-reviewer',
  CTO_SYNTHESIS: 'standard-cto-synthesis'
});

export const StandardEngineeringWorkflow = Object.freeze({
  id: 'standard-engineering',
  version: 1,
  titlePattern: /engineering standard|software delivery|software development/i,
  phases: Object.freeze([
    WorkflowPhase.PROPOSED, WorkflowPhase.APPROVED, WorkflowPhase.SPAWN_CTO,
    WorkflowPhase.ASSIGN_CHILDREN, WorkflowPhase.RUN_CHILDREN, WorkflowPhase.WAIT,
    WorkflowPhase.VALIDATE_EVIDENCE, WorkflowPhase.SYNTHESIZE, WorkflowPhase.TERMINALIZE,
    WorkflowPhase.PROJECT, WorkflowPhase.COMPLETED, WorkflowPhase.FAILED
  ]),
  requiredChildren: Object.freeze([
    StandardEngineeringTaskId.PRODUCT_OWNER,
    StandardEngineeringTaskId.RESEARCHER,
    StandardEngineeringTaskId.ARCHITECT,
    StandardEngineeringTaskId.ENGINEER,
    StandardEngineeringTaskId.SECURITY,
    StandardEngineeringTaskId.QA,
    StandardEngineeringTaskId.PLATFORM,
    StandardEngineeringTaskId.WRITER,
    StandardEngineeringTaskId.REVIEWER
  ]),
  synthesisTask: StandardEngineeringTaskId.CTO_SYNTHESIS
});

export function isStandardEngineeringWorkflow(job) {
  return StandardEngineeringWorkflow.titlePattern.test(String(job?.title || ''));
}
