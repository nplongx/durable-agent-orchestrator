#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyExecutorTrace } from './trace-integrity.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const args = { path: 'config.json' };
const argsHash = sha256(JSON.stringify(args));
const schema = [{ type: 'function', function: { name: 'read_file', description: 'read file', parameters: { type: 'object', properties: {} } } }];
const requestEvent = (turn, offered = ['read_file']) => ({ kind: 'model_request', turn,
  offered_tools: offered, effective_allowed_tools: offered, tool_schema_sha256: sha256(JSON.stringify(schema)) });
const validTrace = () => ({
  protocol: 'cos-local-ollama-scenario-trace-v1',
  model_events: [
    requestEvent(1),
    { kind: 'model_response', turn: 1, response: { message: { tool_calls: [
      { id: 'call-1', function: { name: 'read_file', arguments: args } },
    ] } } },
    { kind: 'model_tool_call', turn: 1, native: true, tool_name: 'read_file', arguments: args,
      arguments_sha256: argsHash, call_index: 1, model_call_id: 'call-1' },
    { kind: 'tool_result', turn: 1, native: true, disposition: 'executed', tool_name: 'read_file',
      arguments_sha256: argsHash, result_sha256: 'result-hash', call_index: 1, model_call_id: 'call-1' },
    requestEvent(2),
    { kind: 'model_response', turn: 2, response: { message: { tool_calls: [] } } },
  ],
  tool_events: [{ kind: 'executor_tool_disposition', ordinal: 1, model_call_id: 'call-1',
    tool_name: 'read_file', disposition: 'executed', arguments_sha256: argsHash, result_sha256: 'result-hash' }],
});

const valid = verifyExecutorTrace(validTrace());
assert.equal(valid.status, 'verified', JSON.stringify(valid));

const missingDisposition = validTrace();
missingDisposition.tool_events = [];
assert.ok(verifyExecutorTrace(missingDisposition).failed_checks.includes('executor-terminal-reconciliation'));

const duplicateDisposition = validTrace();
duplicateDisposition.tool_events.push({ ...duplicateDisposition.tool_events[0] });
assert.ok(verifyExecutorTrace(duplicateDisposition).failed_checks.includes('unique-executor-terminal-records'));

const alteredArgs = validTrace();
alteredArgs.model_events.find(e => e.kind === 'model_response').response.message.tool_calls[0].function.arguments = { path: 'different.json' };
assert.ok(verifyExecutorTrace(alteredArgs).failed_checks.includes('native-call-attempt-reconciliation'));

const deniedTrace = {
  model_events: [
    requestEvent(1),
    { kind: 'model_response', turn: 1, response: { message: { tool_calls: [
      { id: 'call-denied', function: { name: 'workflow_dispatch', arguments: { job_id: 'synthetic' } } },
    ] } } },
    { kind: 'tool_policy_decision', turn: 1, native: true, disposition: 'denied', tool_name: 'workflow_dispatch',
      model_call_id: 'call-denied', call_index: 1, arguments_sha256: sha256(JSON.stringify({ job_id: 'synthetic' })), reason: 'not allowed' },
  ],
  tool_events: [{ kind: 'executor_tool_disposition', ordinal: 1, model_call_id: 'call-denied',
    tool_name: 'workflow_dispatch', disposition: 'denied', arguments_sha256: sha256(JSON.stringify({ job_id: 'synthetic' })) }],
};
assert.equal(verifyExecutorTrace(deniedTrace).status, 'verified', 'a recorded denial is valid trace evidence');

const contradictoryDisposition = validTrace();
contradictoryDisposition.model_events.find(e => e.kind === 'tool_result').disposition = 'error';
assert.ok(verifyExecutorTrace(contradictoryDisposition).failed_checks.includes('model-loop-terminal-reconciliation'),
  'model-loop result disposition must agree with executor terminal disposition');

const missingArgumentsHash = validTrace();
delete missingArgumentsHash.tool_events[0].arguments_sha256;
assert.ok(verifyExecutorTrace(missingArgumentsHash).failed_checks.includes('executor-terminal-reconciliation'),
  'executor terminal must retain the attempt argument hash');

const duplicateModelTerminal = validTrace();
const resultIndex = duplicateModelTerminal.model_events.findIndex(e => e.kind === 'tool_result');
duplicateModelTerminal.model_events.splice(resultIndex + 1, 0, { ...duplicateModelTerminal.model_events[resultIndex] });
assert.ok(verifyExecutorTrace(duplicateModelTerminal).failed_checks.includes('model-loop-terminal-reconciliation'),
  'duplicate model-loop terminal events must not reconcile');

const mismatchedPermissionSnapshot = validTrace();
mismatchedPermissionSnapshot.model_events.find(e => e.kind === 'model_request').effective_allowed_tools = ['read_file', 'workflow_dispatch'];
assert.ok(verifyExecutorTrace(mismatchedPermissionSnapshot).failed_checks.includes('per-turn-permission-snapshot'),
  'offered tools and effective allowlist must match exactly on every turn');

const missingSchemaDigest = validTrace();
delete missingSchemaDigest.model_events.find(e => e.kind === 'model_request').tool_schema_sha256;
assert.ok(verifyExecutorTrace(missingSchemaDigest).failed_checks.includes('per-turn-permission-snapshot'),
  'each request must retain a schema digest');

const pluginTrace = validTrace();
pluginTrace.tool_events.push({ kind: 'plugin_tool_attempt', ordinal: 1, model_call_id: 'call-1', tool_name: 'read_file' });
pluginTrace.tool_events.push({ kind: 'plugin_tool_disposition', ordinal: 1, model_call_id: 'call-1', tool_name: 'read_file', disposition: 'executed' });
assert.equal(verifyExecutorTrace(pluginTrace).status, 'verified');
pluginTrace.tool_events.pop();
assert.ok(verifyExecutorTrace(pluginTrace).failed_checks.includes('plugin-rpc-terminal-reconciliation'));

console.log('PASS: trace integrity detects missing/duplicate/orphan terminal events, altered arguments, and unmatched plugin RPC outcomes');
console.log('PASS: explicitly recorded denied tool attempts reconcile without execution');
