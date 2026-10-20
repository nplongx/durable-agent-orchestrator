const ERROR_CATEGORIES = Object.freeze([
  'transient_failure', 'unsupported_operation', 'incompatible_version', 'permission_denied',
  'invalid_state', 'stale_lease', 'unresolved_execution_outcome', 'policy_denial', 'validation_failure'
]);

export class WorkflowToolError extends Error {
  constructor(message, details = {}) {
    super(String(message || 'workflow operation failed'));
    this.name = 'WorkflowToolError';
    this.code = typeof details.code === 'string' && details.code ? details.code : 'WORKFLOW_OPERATION_FAILED';
    this.category = ERROR_CATEGORIES.includes(details.category) ? details.category : 'validation_failure';
    this.retryable = details.retryable === true;
    this.job_id = details.job_id ?? null;
    this.workflow_id = details.workflow_id ?? null;
    this.workflow_version = Number.isInteger(details.workflow_version) ? details.workflow_version : null;
    this.job_state = details.job_state ?? null;
    this.task_id = details.task_id ?? null;
    this.capability = details.capability ?? null;
    this.side_effects = Array.isArray(details.side_effects) ? details.side_effects : [];
    this.workspace_mutation_status = details.workspace_mutation_status || 'not_modified';
    this.evidence_missing = Array.isArray(details.evidence_missing) ? details.evidence_missing : [];
    this.next_actions = Array.isArray(details.next_actions) ? details.next_actions : [];
    this.details = details.details && typeof details.details === 'object' ? details.details : {};
  }

  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      job_id: this.job_id,
      workflow_id: this.workflow_id,
      workflow_version: this.workflow_version,
      job_state: this.job_state,
      task_id: this.task_id,
      capability: this.capability,
      side_effects: this.side_effects,
      workspace_mutation_status: this.workspace_mutation_status,
      evidence_missing: this.evidence_missing,
      next_actions: this.next_actions,
      details: this.details
    };
  }
}

export function isWorkflowToolError(error) {
  return error instanceof WorkflowToolError;
}
