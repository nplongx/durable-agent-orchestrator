import assert from 'node:assert/strict';
import { GitHubActionsProvider } from '../src/runtime/github-actions-provider.js';
import { MAX_STRICT_JSON_BYTES, parseStrictJson } from '../src/runtime/strict-json.js';

// GitHub IDs are consumed as durable string identities. JSON numbers outside
// JavaScript's safe-integer range can round to a different ID before the
// provider's run-identity check sees them.
const provider = new GitHubActionsProvider({
  token: 'local-test-token',
  owner: 'example',
  repo: 'repo',
  workflow: 'p2-provider-smoke.yml',
  ref: 'main',
  fetchImpl: async () => new Response(
    '{"id":9007199254740993,"status":"completed","conclusion":"success","run_attempt":1}',
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
});

await assert.rejects(
  () => provider.getStatus('9007199254740992'),
  /status response identity mismatch/,
  'a JSON response carrying the adjacent, unsafe integer ID must not alias the requested run'
);

for (const source of [
  '9007199254740992',
  '9007199254740993',
  '1e20',
  '-9007199254740993',
  '1.0e20',
  '1.00000000000000000001',
  '0.99999999999999999999',
  '1e-400',
  '-1e-400',
  '9007199254740991.00000000000000001',
  '-0',
  '-0.0',
  '-0e20'
]) {
  assert.throws(() => parseStrictJson(source), /safe integer range|not exactly represented|negative zero/,
    `strict JSON must reject integer-valued number ${source} when rounded or outside the safe range`);
}

assert.equal(parseStrictJson('{"id":9007199254740991}').id, Number.MAX_SAFE_INTEGER);
assert.equal(parseStrictJson('{"ratio":1.25}').ratio, 1.25);
assert.equal(parseStrictJson('{"id":1.000e0}').id, 1);
assert.equal(parseStrictJson('{"id":1000e-3}').id, 1);
assert.deepEqual(parseStrictJson('{"nested":{"safe":true},"items":[1,2,3]}'), { nested: { safe: true }, items: [1, 2, 3] });

assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d])), /not valid UTF-8/);
assert.throws(() => parseStrictJson('{"id":1,"\\u0069d":2}'), /duplicate decoded object key/,
  'escaped object member names must compare after JSON string decoding');
assert.throws(() => parseStrictJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), /invalid at byte\/character offset/,
  'byte and string inputs must agree about a leading BOM');
assert.throws(() => parseStrictJson('"\\ud800"'), /invalid at byte\/character offset/,
  'unpaired escaped UTF-16 surrogates must not enter identity-bearing strings');
assert.equal(parseStrictJson('"\\ud83d\\ude00"'), '😀', 'valid surrogate pairs remain supported');
assert.throws(() => parseStrictJson(`${'['.repeat(258)}null${']'.repeat(258)}`), /maximum nesting depth/);
const manyNodes = `[${Array(1_000_001).fill('null').join(',')}]`;
assert.throws(() => parseStrictJson(manyNodes), /maximum JSON node count/,
  'a bounded byte stream containing too many JSON value nodes must be rejected');
assert.throws(() => parseStrictJson(Buffer.alloc(MAX_STRICT_JSON_BYTES + 1, 0x20)), /byte limit/,
  'oversized byte input must be rejected before parsing');
assert.throws(() => parseStrictJson(' '.repeat(MAX_STRICT_JSON_BYTES + 1)), /byte limit/,
  'oversized string input must be rejected before parsing');

for (const [token, requestedId] of [
  ['1.00000000000000000001', '1'],
  ['0.99999999999999999999', '1'],
  ['1e-400', '0'],
  ['-0', '0']
]) {
  const roundedProvider = new GitHubActionsProvider({
    token: 'local-test-token', owner: 'example', repo: 'repo', workflow: 'p2-provider-smoke.yml',
    fetchImpl: async () => new Response(
      `{"id":${token},"status":"completed","conclusion":"success","run_attempt":1}`,
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });
  await assert.rejects(() => roundedProvider.getStatus(requestedId), /status response identity mismatch/,
    `provider must reject JSON ID token ${token} rather than alias requested ID ${requestedId}`);
}
console.log('test-strict-json-safe-integer: PASS');
