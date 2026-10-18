import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseOpenClawAgentReceipt, buildDurableWireEnvelope, classifyTransportError } from '../session-transport.js';

const receipt = parseOpenClawAgentReceipt(JSON.stringify({ runId: 'run-1', sessionKey: 'agent:architect:subagent:x', result: 'done' }));
assert.strictEqual(receipt.status, 'OK');
assert.strictEqual(receipt.runId, 'run-1');
assert.strictEqual(receipt.sessionKey, 'agent:architect:subagent:x');
assert.strictEqual(receipt.result, 'done');
assert.strictEqual(parseOpenClawAgentReceipt('reply').status, 'ERROR', 'the --json transport must not treat plain text as a success receipt');
assert.match(parseOpenClawAgentReceipt('reply').error, /non-JSON receipt.*ambiguous/);
assert.strictEqual(parseOpenClawAgentReceipt('').status, 'EMPTY');
assert.strictEqual(parseOpenClawAgentReceipt('{}').status, 'ERROR', 'empty JSON objects are not delivery receipts');
assert.strictEqual(parseOpenClawAgentReceipt('{"error":"agent rejected request"}').status, 'ERROR');
assert.strictEqual(parseOpenClawAgentReceipt('{"error":"","errorMessage":"rejected","runId":"run-hidden-error"}').status, 'ERROR',
  'a blank preferred error alias must not hide a populated alternate error field');
assert.strictEqual(parseOpenClawAgentReceipt('{"error":false,"runId":"run-malformed-error"}').status, 'ERROR',
  'non-string error metadata must not be coerced into a success receipt');
assert.strictEqual(parseOpenClawAgentReceipt('{"error":null,"failure":"remote rejected","runId":"run-alternate-error"}').status, 'ERROR',
  'a null error alias must not mask a populated failure alias');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"failed","message":"tool failure"}').status, 'ERROR');
assert.strictEqual(parseOpenClawAgentReceipt('{"ok":false,"message":"denied"}').status, 'ERROR');
assert.strictEqual(parseOpenClawAgentReceipt('{"ok":false,"ok":true,"runId":"run-3"}').status, 'ERROR', 'duplicate JSON keys cannot override a remote failure receipt');
assert.match(parseOpenClawAgentReceipt('{"ok":false,"ok":true,"runId":"run-3"}').error, /duplicate decoded keys.*ambiguous/);
assert.strictEqual(parseOpenClawAgentReceipt(Buffer.from([0x7b,0x22,0x6f,0x6b,0x22,0x3a,0x74,0x72,0x75,0x65,0x2c,0x22,0x72,0x75,0x6e,0x49,0x64,0x22,0x3a,0x22,0xff,0x22,0x7d])).status, 'ERROR', 'invalid UTF-8 bytes cannot become a success receipt after replacement decoding');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed"}').status, 'ERROR', 'status alone is not a correlated delivery receipt');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","runId":"run-2"}').status, 'OK');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"failed-ish","runId":"run-unknown-status"}').status, 'ERROR',
  'a correlated run ID must not turn an unknown explicit status into a successful delivery receipt');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":{"value":"completed"},"runId":"run-object-status"}').status, 'ERROR',
  'status values must be primitive strings when supplied');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":null,"state":"completed","runId":"run-null-status"}').status, 'ERROR',
  'an explicit null status must not be hidden by a valid state alias');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","state":"failed","runId":"run-conflicting-status"}').status, 'ERROR',
  'conflicting status/state metadata must not be resolved by field precedence');
assert.strictEqual(parseOpenClawAgentReceipt('{"ok":"true","runId":"run-string-ok"}').status, 'ERROR',
  'an explicitly supplied ok field must be boolean, not truthy/coercible');
assert.strictEqual(parseOpenClawAgentReceipt('{"runId":"run-a","id":"run-b"}').status, 'ERROR',
  'conflicting run identity aliases must not be resolved by field precedence');
assert.strictEqual(parseOpenClawAgentReceipt('{"runId":"run-a","run_id":"run-a","id":"run-a","sessionKey":"agent:a","session_key":"agent:b"}').status, 'ERROR',
  'conflicting session identity aliases must not be resolved by field precedence');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","state":"COMPLETED","runId":"run-alias-same","run_id":"run-alias-same"}').status, 'OK',
  'equivalent compatibility aliases remain supported when identity is unambiguous');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"   ","runId":"run-blank-status"}').status, 'ERROR',
  'blank explicit status must not be accepted as a success receipt');
assert.strictEqual(parseOpenClawAgentReceipt('{"sessionKey":"agent:architect:subagent:x"}').status, 'ERROR',
  'a matching session key alone is not proof that this delivery invocation was accepted');
assert.strictEqual(parseOpenClawAgentReceipt('{"result":"accepted"}').status, 'ERROR',
  'a result field without a correlated run ID is not a durable delivery receipt');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","runId":"run-nested-failed","sessionKey":"agent:architect:subagent:x","result":{"status":"failed","error":"nested execution rejected"}}').status, 'ERROR',
  'a top-level success receipt must not hide a nested failed execution result');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","runId":"run-nested-unknown","sessionKey":"agent:architect:subagent:x","result":{"status":"pending-ish"}}').status, 'ERROR',
  'unknown nested execution states must not be interpreted as success');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","runId":"run-nested-conflict","sessionKey":"agent:architect:subagent:x","result":[{"status":"completed","state":"failed"}]}').status, 'ERROR',
  'array-wrapped conflicting nested status aliases must not be hidden by a successful envelope');
assert.strictEqual(parseOpenClawAgentReceipt('{"status":"completed","runId":"run-nested-error","sessionKey":"agent:architect:subagent:x","response":{"error":"remote execution failed"}}').status, 'ERROR',
  'nested remote errors must keep delivery outcome ambiguous');
for (const value of ['{}', '[]', 'true', 'false', '0', '17', '""', '"   "']) {
  const invalid = parseOpenClawAgentReceipt(`{"runId":${value}}`);
  assert.strictEqual(invalid.status, 'ERROR', `runId must be a non-empty opaque string, got ${value}`);
  assert.match(invalid.error, /valid string runId.*ambiguous/);
}
assert.strictEqual(parseOpenClawAgentReceipt('{"runId":"run-4","sessionKey":{}}').status, 'ERROR',
  'a supplied sessionKey must also have a valid opaque string type');

const envelopeSession = { job_id: 'job-payload-boundary', task_id: 'task-payload-boundary', role: 'architect' };
const envelopeMessage = {
  message_id: 'message-payload-boundary', message_type: 'legacy', sender_role: 'cto', recipient_role: 'architect',
  payload_json: '{"approved":false,"\\u0061dmin":true,"admin":false}', protocol: 'legacy',
  protocol_version: 0, attempt: 1, created_at: '2026-10-15T00:00:00.000Z'
};
assert.throws(() => buildDurableWireEnvelope(envelopeSession, envelopeMessage), /duplicate decoded object key/,
  'a corrupt duplicate-key durable payload must be rejected before external delivery');
const validLegacyMessage = { ...envelopeMessage, payload_json: '{"approved":false}' };
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...validLegacyMessage, protocol: 'cos-ap', protocol_version: 2 }), /unsupported or malformed durable session protocol version/,
  'an unsupported persisted COS-AP version must not be silently downgraded to legacy wire format');
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...validLegacyMessage, protocol: 'cos-ap', protocol_version: '1' }), /unsupported or malformed durable session protocol version/,
  'protocol versions must be exact stored integers, not coercible strings');
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...validLegacyMessage, protocol: 'cos-ap', protocol_version: 1, attempt: '1' }), /attempt must be a positive safe integer/,
  'persisted COS-AP attempt identity must not be coerced from a string');
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...validLegacyMessage, protocol: 'cos-ap', protocol_version: 1, attempt: Number.MAX_SAFE_INTEGER + 1 }), /attempt must be a positive safe integer/,
  'persisted COS-AP attempts outside the safe integer range must be rejected before transport');
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...validLegacyMessage, protocol: 'cos-ap-v2', protocol_version: 2 }), /unsupported or malformed durable session protocol/,
  'unknown persisted protocols must not be silently downgraded to legacy wire format');
assert.throws(() => buildDurableWireEnvelope(envelopeSession, { ...envelopeMessage, payload_json: '{"attempt":9007199254740993}' }), /safe integer/,
  'unsafe integer tokens in a durable payload must not be rounded during wire construction');
assert.strictEqual(classifyTransportError(new Error('429 rate limit')), 'RATE_LIMIT');
assert.strictEqual(classifyTransportError(new Error('session not found')), 'SESSION_NOT_FOUND');
assert.strictEqual(classifyTransportError(new Error('command timed out')), 'TIMEOUT');

// A missing local executable is a known pre-send failure, unlike a timeout
// after a CLI process may have sent a message. Exercise the actual spawn path
// in a subprocess so OPENCLAW_BIN is bound before the transport module loads.
const missingOpenClaw = path.join(os.tmpdir(), `missing-openclaw-${process.pid}-${Date.now()}`);
const spawnFailure = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { deliverSessionMessage } from './session-transport.js';
  const session = { job_id: 'job-spawn-failure', task_id: 'task-spawn-failure', role: 'architect', openclaw_session_key: 'session-spawn-failure' };
  const message = { message_id: 'message-spawn-failure', message_type: 'legacy', sender_role: 'cto', recipient_role: 'architect',
    payload_json: '{"note":"pre-send failure fixture"}', protocol: 'legacy', protocol_version: 0, attempt: 1, created_at: '2026-10-16T00:00:00.000Z' };
  try { await deliverSessionMessage(session, message); console.log('UNEXPECTED_SUCCESS'); process.exitCode = 3; }
  catch (error) { console.log(JSON.stringify({ code: error.code, deliveryOutcome: error.deliveryOutcome,
    externalSideEffectCommitted: error.externalSideEffectCommitted, transportCode: error.transportCode })); }
`], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
  env: { ...process.env, OPENCLAW_BIN: missingOpenClaw } });
assert.equal(spawnFailure.status, 0, `spawn-failure fixture should report the classified error: ${spawnFailure.stderr}`);
const spawnFailureEvidence = JSON.parse(spawnFailure.stdout.trim());
assert.equal(spawnFailureEvidence.code, 'ENOENT');
assert.equal(spawnFailureEvidence.deliveryOutcome, 'not_sent');
assert.equal(spawnFailureEvidence.externalSideEffectCommitted, false);
assert.equal(spawnFailureEvidence.transportCode, 'ENOENT');
console.log('test-session-transport: PASS');
