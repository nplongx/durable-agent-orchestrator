import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function verifyExecutorTrace(trace) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  const modelEvents = trace?.model_events;
  const toolEvents = trace?.tool_events;
  if (!Array.isArray(modelEvents) || !Array.isArray(toolEvents)) {
    add('trace-shape', false, 'model_events and tool_events must both be arrays');
    return { status: 'invalid-evidence', checks, failed_checks: checks.map(c => c.name), attempt_count: 0, disposition_count: 0 };
  }
  const responses = modelEvents.filter(e => e.kind === 'model_response');
  add('model-response-present', responses.length > 0, `model_response count=${responses.length}`);

  const requests = modelEvents.filter(e => e.kind === 'model_request');
  const permissionSnapshotsValid = requests.length > 0 && requests.every(request => {
    const offered = request.offered_tools;
    const effective = request.effective_allowed_tools;
    return Array.isArray(offered) && Array.isArray(effective) &&
      offered.every(name => typeof name === 'string') && effective.every(name => typeof name === 'string') &&
      offered.length === effective.length && [...offered].sort().every((name, index) => name === [...effective].sort()[index]) &&
      new Set(offered).size === offered.length && /^[a-f0-9]{64}$/.test(request.tool_schema_sha256 ?? '');
  });
  add('per-turn-permission-snapshot', permissionSnapshotsValid,
    'Every model request must persist matching offered/effective tool names and a SHA-256 digest of the exact offered schema JSON.');

  const attempts = modelEvents.filter(e => ['model_tool_call', 'tool_policy_decision'].includes(e.kind));
  let responseCallsMatch = true;
  for (const response of responses) {
    const calls = response.response?.message?.tool_calls ?? [];
    const observed = attempts.filter(e => e.turn === response.turn);
    if (calls.length !== observed.length) responseCallsMatch = false;
    for (let index = 0; index < Math.min(calls.length, observed.length); index++) {
      const rawCall = calls[index];
      const observedCall = observed[index];
      const rawName = rawCall?.function?.name ?? null;
      if ((observedCall.tool_name ?? null) !== rawName) responseCallsMatch = false;
      if ((rawCall?.id ?? null) !== (observedCall.model_call_id ?? null)) responseCallsMatch = false;
      const rawArgsHash = sha256(JSON.stringify(rawCall?.function?.arguments ?? {}));
      if (typeof observedCall.arguments_sha256 !== 'string' || observedCall.arguments_sha256 !== rawArgsHash) responseCallsMatch = false;
    }
  }
  add('native-call-attempt-reconciliation', responseCallsMatch,
    'Each model response tool call must have exactly one matching model-call or policy-denial event with matching name/ID/arguments.');

  const ordinals = attempts.map(e => e.call_index);
  const ordinalValid = ordinals.every(Number.isInteger) &&
    new Set(ordinals).size === ordinals.length && ordinals.every((v, i) => v === i + 1);
  add('attempt-ordinal-sequence', ordinalValid, JSON.stringify(ordinals));

  const dispositions = toolEvents.filter(e => e.kind === 'executor_tool_disposition');
  const dispositionOrdinals = dispositions.map(e => e.ordinal);
  const dispositionOrdinalsUnique = dispositionOrdinals.every(Number.isInteger) &&
    new Set(dispositionOrdinals).size === dispositionOrdinals.length;
  add('unique-executor-terminal-records', dispositionOrdinalsUnique, JSON.stringify(dispositionOrdinals));
  let dispositionsMatch = dispositions.length === attempts.length && dispositionOrdinals.length === attempts.length;
  for (const attempt of attempts) {
    const matching = dispositions.filter(e => e.ordinal === attempt.call_index);
    if (matching.length !== 1) { dispositionsMatch = false; continue; }
    const terminal = matching[0];
    if (terminal.tool_name !== attempt.tool_name) dispositionsMatch = false;
    if ((attempt.model_call_id ?? null) !== (terminal.model_call_id ?? null)) dispositionsMatch = false;
    if (typeof attempt.arguments_sha256 !== 'string' || attempt.arguments_sha256 !== terminal.arguments_sha256) dispositionsMatch = false;
    const expected = attempt.kind === 'tool_policy_decision' ? 'denied' : null;
    if (expected && terminal.disposition !== expected) dispositionsMatch = false;
    if (attempt.kind === 'model_tool_call' && !['executed', 'error'].includes(terminal.disposition)) dispositionsMatch = false;
  }
  for (const terminal of dispositions) if (!attempts.some(a => a.call_index === terminal.ordinal)) dispositionsMatch = false;
  add('executor-terminal-reconciliation', dispositionsMatch,
    'Every attempted native tool call has exactly one matching executed/error/denied executor disposition; no orphan terminal records.');

  const results = modelEvents.filter(e => e.kind === 'tool_result');
  const errors = modelEvents.filter(e => e.kind === 'tool_execution_error');
  const denied = modelEvents.filter(e => e.kind === 'tool_policy_decision');
  let modelTerminalMatch = results.length + errors.length + denied.length === attempts.length;
  const modelTerminalKeys = [...results, ...errors].map(e => `${e.call_index}:${e.kind}`);
  if (new Set(modelTerminalKeys).size !== modelTerminalKeys.length) modelTerminalMatch = false;
  for (const result of results) {
    const attempt = attempts.find(a => a.call_index === result.call_index);
    const executorTerminal = dispositions.find(e => e.ordinal === result.call_index);
    if (!attempt || attempt.kind !== 'model_tool_call' || attempt.tool_name !== result.tool_name ||
        (attempt.model_call_id ?? null) !== (result.model_call_id ?? null) ||
        typeof attempt.arguments_sha256 !== 'string' || result.arguments_sha256 !== attempt.arguments_sha256 ||
        result.disposition !== 'executed' || executorTerminal?.disposition !== 'executed' ||
        (result.result_sha256 && executorTerminal?.result_sha256 !== result.result_sha256)) modelTerminalMatch = false;
  }
  for (const error of errors) {
    const attempt = attempts.find(a => a.call_index === error.call_index);
    const executorTerminal = dispositions.find(e => e.ordinal === error.call_index);
    if (!attempt || attempt.kind !== 'model_tool_call' || attempt.tool_name !== error.tool_name ||
        (attempt.model_call_id ?? null) !== (error.model_call_id ?? null) ||
        typeof attempt.arguments_sha256 !== 'string' || error.arguments_sha256 !== attempt.arguments_sha256 ||
        error.disposition !== 'error' || executorTerminal?.disposition !== 'error') modelTerminalMatch = false;
  }
  for (const denial of denied) {
    const terminal = dispositions.find(e => e.ordinal === denial.call_index);
    if (denial.disposition !== 'denied' || terminal?.disposition !== 'denied') modelTerminalMatch = false;
  }
  add('model-loop-terminal-reconciliation', modelTerminalMatch,
    `attempts=${attempts.length}; results=${results.length}; errors=${errors.length}; denied=${denied.length}`);

  const pluginAttempts = toolEvents.filter(e => e.kind === 'plugin_tool_attempt');
  const pluginTerminals = toolEvents.filter(e => e.kind === 'plugin_tool_disposition');
  let pluginMatch = pluginTerminals.length === pluginAttempts.length;
  for (const attempt of pluginAttempts) {
    const matches = pluginTerminals.filter(e => e.ordinal === attempt.ordinal);
    if (matches.length !== 1 || matches[0]?.tool_name !== attempt.tool_name ||
        (attempt.model_call_id && matches[0]?.model_call_id && attempt.model_call_id !== matches[0].model_call_id) ||
        !['executed', 'error', 'denied'].includes(matches[0]?.disposition)) pluginMatch = false;
  }
  for (const terminal of pluginTerminals) if (!pluginAttempts.some(a => a.ordinal === terminal.ordinal)) pluginMatch = false;
  add('plugin-rpc-terminal-reconciliation', pluginMatch,
    `plugin attempts=${pluginAttempts.length}; plugin terminal records=${pluginTerminals.length}`);

  const failed = checks.filter(c => !c.passed);
  return { status: failed.length ? 'invalid-evidence' : 'verified', checks,
    failed_checks: failed.map(c => c.name), attempt_count: attempts.length,
    disposition_count: dispositions.length, plugin_rpc_attempt_count: pluginAttempts.length };
}
