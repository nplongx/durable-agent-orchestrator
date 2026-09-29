import { WorkflowPhase } from '../phases.js';

export const EngineeringTaskId = Object.freeze({
  ARCHITECT: 'engineering-architect',
  ENGINEER: 'engineering-engineer',
  QA: 'engineering-qa',
  REVIEWER: 'engineering-reviewer',
  CTO_SYNTHESIS: 'engineering-cto-synthesis'
});

export const EngineeringWorkflow = Object.freeze({
  id: 'engineering',
  version: 1,
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
    EngineeringTaskId.ARCHITECT,
    EngineeringTaskId.ENGINEER,
    EngineeringTaskId.QA,
    EngineeringTaskId.REVIEWER
  ]),
  synthesisTask: EngineeringTaskId.CTO_SYNTHESIS
});

export function isEngineeringWorkflow(job) {
  return EngineeringWorkflow.titlePattern.test(String(job?.title || ''));
}
