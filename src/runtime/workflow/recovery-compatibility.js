const SUPPORTED_REWORK_WORKFLOW_ID = 'standard-engineering';
const MINIMUM_REWORK_VERSION = 2;

export function supportsReviewDrivenRecovery(plan) {
  return String(plan?.workflow_id || '').toLowerCase() === SUPPORTED_REWORK_WORKFLOW_ID &&
    Number.isSafeInteger(Number(plan?.workflow_version)) && Number(plan.workflow_version) >= MINIMUM_REWORK_VERSION;
}

export function classifyReviewRecovery({ plan = null, job = null } = {}) {
  const workflowId = plan?.workflow_id == null ? null : String(plan.workflow_id);
  const workflowVersion = Number.isSafeInteger(Number(plan?.workflow_version)) ? Number(plan.workflow_version) : null;
  const base = {
    supported: false,
    job_id: job?.job_id || null,
    workflow_id: workflowId,
    workflow_version: workflowVersion,
    job_state: job?.state || null,
    retryable: false,
    next_action: null
  };
  if (!plan) return {
    ...base,
    code: 'WORKFLOW_PLAN_MISSING',
    category: 'invalid_state',
    reason: 'No immutable execution plan is available to determine a supported recovery path.',
    next_action: { tool: 'workflow_get', reason: 'Inspect the proposal and workflow state; do not retry a missing-plan mutation.' }
  };
  if (!supportsReviewDrivenRecovery(plan)) return {
    ...base,
    code: 'WORKFLOW_REWORK_UNSUPPORTED',
    category: 'unsupported_operation',
    reason: `Review-driven rework requires workflow_id=${SUPPORTED_REWORK_WORKFLOW_ID} and workflow_version>=${MINIMUM_REWORK_VERSION}; the current immutable plan is ${workflowId || 'unknown'}@${workflowVersion ?? 'unknown'}.`,
    next_action: {
      tool: 'workflow_create',
      workflow: SUPPORTED_REWORK_WORKFLOW_ID,
      reason: 'The current immutable plan cannot be upgraded in place. Create a new standard-engineering proposal that carries forward unresolved work, inspect its preflight and immutable plan, then obtain explicit approval before dispatch.'
    }
  };
  if (String(job?.state || '').toUpperCase() !== 'EXECUTING' || job?.status !== 'active') return {
    ...base,
    code: 'WORKFLOW_NOT_EXECUTING',
    category: 'invalid_state',
    reason: 'Review-driven recovery requires an active EXECUTING workflow.',
    next_action: { tool: 'workflow_get', reason: 'Inspect durable status, approvals, task state and event history; do not retry recovery while the job is not executing.' }
  };
  return { ...base, supported: true, code: null, category: null, reason: null, next_action: null };
}
