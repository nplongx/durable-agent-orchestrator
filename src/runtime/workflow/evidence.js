import { parseStrictJson } from '../strict-json.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function plannedCommandForms(execution = {}) {
  const forms = [];
  if (typeof execution.command === 'string' && execution.command.trim()) forms.push(execution.command);
  if (typeof execution.executable === 'string' && execution.executable.trim() && Array.isArray(execution.args) &&
      execution.args.every(arg => typeof arg === 'string')) {
    forms.push([execution.executable, ...execution.args].map(shellQuote).join(' '));
  }
  return [...new Set(forms)];
}

export function canonicalExecutionEvidenceContent({ taskId, executionSessionId, attempt, command, exitCode, status, stdout = '', stderr = '', error = null }) {
  return [
    '[ACTUAL TOOL RESULT EVIDENCE]',
    '[ACTUAL EXECUTION EVIDENCE]',
    `task_id: ${taskId}`,
    `execution_session_id: ${executionSessionId}`,
    `attempt: ${attempt}`,
    `exact command: ${command}`,
    `exit status/code: ${exitCode == null ? 'N/A' : exitCode}`,
    `execution status: ${status}`,
    `stdout:\n${stdout || ''}`,
    `stderr:\n${stderr || ''}`,
    error ? `error: ${String(error)}` : ''
  ].filter(Boolean).join('\n');
}

export function executionEvidence(task, result = null, plannedExecution = null) {
  let metadata = {};
  try { metadata = parseStrictJson(task?.metadata_json || '{}'); } catch (_) {}
  const immutableCommands = plannedCommandForms(plannedExecution || {});
  return {
    taskId: task?.task_id ?? null,
    taskStatus: String(task?.status || '').toLowerCase(),
    exitCode: task?.execution_exit_code ?? null,
    exitStatus: String(task?.execution_status || '').toLowerCase(),
    executionStdout: task?.execution_stdout,
    executionStderr: task?.execution_stderr,
    trajectory: String(result?.content || '').trim(),
    resultOutcome: String(result?.outcome || '').toLowerCase(),
    expectedCommands: immutableCommands.length ? immutableCommands : typeof metadata.command === 'string' ? [metadata.command] : [],
    immutableCommands,
    metadataCommand: typeof metadata.command === 'string' ? metadata.command : null,
    plannedExecutor: plannedExecution?.executor ?? null,
    toolMetadata: {
      executor: metadata.executor ?? null,
      executionSessionId: task?.execution_session_id ?? null,
      attempt: task?.execution_attempt ?? null
    }
  };
}

export function validateEvidenceContract(task, result = null, plannedExecution = null) {
  const evidence = executionEvidence(task, result, plannedExecution);
  const errors = [];
  if (evidence.exitCode !== 0) errors.push('exitCode must be exact numeric 0');
  if (evidence.exitStatus !== 'completed') errors.push('exitStatus must be completed');
  if (evidence.taskStatus !== 'completed') errors.push('durable task status must be completed');
  if (evidence.resultOutcome !== 'success') errors.push('durable result outcome must be success');
  if (!evidence.taskId || typeof evidence.taskId !== 'string') errors.push('durable task identity is required');
  if (evidence.toolMetadata.executor !== 'ExecutionManager') errors.push('executor must be ExecutionManager');
  if (evidence.plannedExecutor != null && evidence.plannedExecutor !== evidence.toolMetadata.executor) {
    errors.push('durable task executor does not match the immutable execution plan');
  }
  if (typeof evidence.toolMetadata.executionSessionId !== 'string' || !evidence.toolMetadata.executionSessionId.trim()) {
    errors.push('durable execution session identity is required');
  }
  if (!Number.isSafeInteger(evidence.toolMetadata.attempt) || evidence.toolMetadata.attempt < 1) {
    errors.push('durable execution attempt must be a positive safe integer');
  }
  if (typeof evidence.executionStdout !== 'string' || typeof evidence.executionStderr !== 'string') {
    errors.push('durable execution stdout/stderr must be exact strings');
  }
  if (!evidence.expectedCommands.length || evidence.expectedCommands.some(command => typeof command !== 'string' || !command.trim())) {
    errors.push('immutable expected command is required');
  }
  if (evidence.immutableCommands.length && !evidence.immutableCommands.includes(evidence.metadataCommand)) {
    errors.push('durable task command does not match the immutable execution plan');
  }
  if (!evidence.trajectory) errors.push('trajectory is required');
  const lines = new Set(evidence.trajectory.split(/\r?\n/));
  for (const marker of ['[ACTUAL TOOL RESULT EVIDENCE]', '[ACTUAL EXECUTION EVIDENCE]']) {
    if (!lines.has(marker)) errors.push(`durable execution evidence marker missing: ${marker}`);
  }
  const requiredLines = [
    ['task_id', evidence.taskId],
    ['execution_session_id', evidence.toolMetadata.executionSessionId],
    ['attempt', evidence.toolMetadata.attempt],
    ['exit status/code', 0],
    ['execution status', 'completed']
  ];
  for (const [label, value] of requiredLines) {
    if (value !== null && value !== undefined && !lines.has(`${label}: ${value}`)) {
      errors.push(`durable execution evidence does not bind exact ${label}`);
    }
  }
  if (evidence.expectedCommands.length && !evidence.expectedCommands.some(command => lines.has(`exact command: ${command}`))) {
    errors.push('durable execution evidence command does not match the immutable expected command');
  }
  if (evidence.exitStatus === 'completed' && evidence.exitCode === 0) {
    const canonical = canonicalExecutionEvidenceContent({
      taskId: evidence.taskId,
      executionSessionId: evidence.toolMetadata.executionSessionId,
      attempt: evidence.toolMetadata.attempt,
      command: evidence.metadataCommand,
      exitCode: evidence.exitCode,
      status: evidence.exitStatus,
      stdout: evidence.executionStdout,
      stderr: evidence.executionStderr,
      error: null
    });
    if (result?.content !== canonical) errors.push('durable execution result bytes do not match canonical task/session/attempt/command/stdout/stderr evidence');
  }
  return { valid: errors.length === 0, errors, evidence };
}
