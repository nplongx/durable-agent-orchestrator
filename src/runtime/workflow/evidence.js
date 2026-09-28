export function executionEvidence(task, result = null) {
  let metadata = {};
  try { metadata = JSON.parse(task?.metadata_json || '{}'); } catch (_) {}
  return {
    exitCode: task?.execution_exit_code ?? null,
    exitStatus: String(task?.execution_status || '').toLowerCase(),
    trajectory: String(result?.content || '').trim(),
    toolMetadata: {
      executor: metadata.executor || null,
      executionSessionId: task?.execution_session_id || null,
      attempt: Number(task?.execution_attempt || 0)
    }
  };
}

export function validateEvidenceContract(task, result = null) {
  const evidence = executionEvidence(task, result);
  const errors = [];
  if (Number(evidence.exitCode) !== 0) errors.push('exitCode must be 0');
  if (evidence.exitStatus !== 'completed') errors.push('exitStatus must be completed');
  if (!evidence.trajectory) errors.push('trajectory is required');
  if (evidence.toolMetadata.executor !== 'ExecutionManager' && evidence.toolMetadata.executor !== null) {
    errors.push('executor must be ExecutionManager');
  }
  return { valid: errors.length === 0, errors, evidence };
}
