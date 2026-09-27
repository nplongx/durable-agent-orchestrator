import assert from 'node:assert';
import { parseOpenClawAgentReceipt, classifyTransportError } from './session-transport.js';

const receipt = parseOpenClawAgentReceipt(JSON.stringify({ runId: 'run-1', sessionKey: 'agent:architect:subagent:x', result: 'done' }));
assert.strictEqual(receipt.status, 'OK');
assert.strictEqual(receipt.runId, 'run-1');
assert.strictEqual(receipt.sessionKey, 'agent:architect:subagent:x');
assert.strictEqual(receipt.result, 'done');
assert.strictEqual(parseOpenClawAgentReceipt('reply').status, 'NON_JSON');
assert.strictEqual(classifyTransportError(new Error('429 rate limit')), 'RATE_LIMIT');
assert.strictEqual(classifyTransportError(new Error('session not found')), 'SESSION_NOT_FOUND');
assert.strictEqual(classifyTransportError(new Error('command timed out')), 'TIMEOUT');
console.log('test-session-transport: PASS');
