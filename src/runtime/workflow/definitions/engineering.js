import { WorkflowPhase } from '../phases.js';

export const EngineeringTaskId = Object.freeze({
  PRODUCT_OWNER: 'engineering-product-owner',
  RESEARCHER: 'engineering-researcher',
  ARCHITECT: 'engineering-architect',
  ENGINEER: 'engineering-engineer',
  SECURITY: 'engineering-security',
  QA: 'engineering-qa',
  PLATFORM: 'engineering-platform',
  WRITER: 'engineering-writer',
  REVIEWER: 'engineering-reviewer',
  CTO_SYNTHESIS: 'engineering-cto-synthesis'
});

export const EngineeringWorkflow = Object.freeze({
  id: 'engineering',
  version: 2,
  titlePattern: /engineering m4/i,
  phases: Object.freeze([
    WorkflowPhase.PROPOSED,
    WorkflowPhase.APPROVED,
    WorkflowPhase.SPAWN_CTO,
    WorkflowPhase.ASSIGN_CHILDREN,
    WorkflowPhase.RUN_CHILDREN,
    WorkflowPhase.WAIT,
    WorkflowPhase.VALIDATE_EVIDENCE,
    WorkflowPhase.SYNTHESIZE,
    WorkflowPhase.TERMINALIZE,
    WorkflowPhase.PROJECT,
    WorkflowPhase.COMPLETED,
    WorkflowPhase.FAILED
  ]),
  requiredChildren: Object.freeze([
    EngineeringTaskId.PRODUCT_OWNER,
    EngineeringTaskId.RESEARCHER,
    EngineeringTaskId.ARCHITECT,
    EngineeringTaskId.ENGINEER,
    EngineeringTaskId.SECURITY,
    EngineeringTaskId.QA,
    EngineeringTaskId.PLATFORM,
    EngineeringTaskId.WRITER,
    EngineeringTaskId.REVIEWER
  ]),
  synthesisTask: EngineeringTaskId.CTO_SYNTHESIS
});

export function isEngineeringWorkflow(job) {
  return EngineeringWorkflow.titlePattern.test(String(job?.title || ''));
}
