export const WorkflowPhase = Object.freeze({
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  SPAWN_CTO: 'SPAWN_CTO',
  ASSIGN_CHILDREN: 'ASSIGN_CHILDREN',
  RUN_CHILDREN: 'RUN_CHILDREN',
  WAIT: 'WAIT',
  VALIDATE_EVIDENCE: 'VALIDATE_EVIDENCE',
  SYNTHESIZE: 'SYNTHESIZE',
  TERMINALIZE: 'TERMINALIZE',
  PROJECT: 'PROJECT',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

export const PRODUCTION_PHASES = Object.freeze([
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
]);
