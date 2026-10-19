import { WorkflowPhase } from '../phases.js';
import { StandardEngineeringTaskId as T } from './standard-engineering.js';
import { HybridEngineeringTaskId as H } from '../catalog/hybrid-engineering.js';

export const HybridEngineeringWorkflow = Object.freeze({
  id: 'hybrid-engineering',
  version: 2,
  // The template prefix is owned by workflow_create; the user-controlled
  // title suffix must not be part of workflow identity.
  titlePattern: /^hybrid batch execution:/i,
  phases: Object.freeze([
    WorkflowPhase.PROPOSED, WorkflowPhase.APPROVED, WorkflowPhase.SPAWN_CTO,
    WorkflowPhase.ASSIGN_CHILDREN, WorkflowPhase.RUN_CHILDREN, WorkflowPhase.WAIT,
    WorkflowPhase.VALIDATE_EVIDENCE, WorkflowPhase.SYNTHESIZE, WorkflowPhase.TERMINALIZE,
    WorkflowPhase.PROJECT, WorkflowPhase.COMPLETED, WorkflowPhase.FAILED
  ]),
  requiredChildren: Object.freeze([
    T.PRODUCT_OWNER, T.RESEARCHER, T.ARCHITECT, T.ENGINEER, T.SECURITY,
    T.QA, T.PLATFORM, T.WRITER, T.REVIEWER,
    H.SERVER_SYNTAX_CHECK, H.WORKFLOW_COMPILER_SYNTAX_CHECK
  ]),
  synthesisTask: T.CTO_SYNTHESIS
});

export function isHybridEngineeringWorkflow(job) {
  return HybridEngineeringWorkflow.titlePattern.test(String(job?.title || ''));
}
