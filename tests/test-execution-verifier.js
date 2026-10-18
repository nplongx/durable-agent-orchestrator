import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MAX_RAW_EVIDENCE_BYTES, verifyExecutionEvidence } from '../src/runtime/execution-verifier.js';
import { MAX_STRICT_JSON_BYTES } from '../src/runtime/strict-json.js';

const result = {
  schema_version: 1,
  job_id: 'job-p4', task_id: 'task-p4', lease_id: 'lease-p4', attempt: 1,
  status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'a'.repeat(40),
  exit_code: 0, provider_run_id: '123', evidence_artifact: 'p3-worker-123',
  evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
  started_at: '2026-09-29T00:00:00.000Z', finished_at: '2026-09-29T00:00:01.000Z', error: null
};
const evidence = {
  'task-payload.json': { schema_version: 1, job_id: 'job-p4', task_id: 'task-p4', lease_id: 'lease-p4', attempt: 1,
    required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'] },
  'execution.json': { task_id: 'task-p4', exit_code: 0, timed_out: false },
  'stdout.txt': 'P4_OK\n', 'stderr.txt': '', 'git-status.txt': ''
};

const good = verifyExecutionEvidence({ result, evidence });
assert.equal(good.valid, true);
assert.equal(good.errors.length, 0);
assert.equal(good.evidence_hash.length, 64);
const protoEvidenceA = { ...evidence, ...JSON.parse('{"__proto__":{"marker":"a"}}') };
const protoEvidenceB = { ...evidence, ...JSON.parse('{"__proto__":{"marker":"b"}}') };
const protoHashA = verifyExecutionEvidence({ result, evidence: protoEvidenceA });
const protoHashB = verifyExecutionEvidence({ result, evidence: protoEvidenceB });
assert.equal(protoHashA.valid, true);
assert.equal(protoHashB.valid, true);
assert.notEqual(protoHashA.evidence_hash, protoHashB.evidence_hash,
  'evidence hash must bind own __proto__ keys instead of dropping them while constructing the canonical hash input');
const customPrototypeEvidence = { ...evidence, required_evidence: [...(evidence.required_evidence || [])] };
Object.setPrototypeOf(customPrototypeEvidence.required_evidence, Object.assign(Object.create(Array.prototype), {
  map() { throw new Error('untrusted inherited array method executed'); }
}));
assert.throws(() => verifyExecutionEvidence({ result, evidence: customPrototypeEvidence }), /non-canonical prototype/,
  'canonical evidence hashing must reject prototype-controlled arrays before downstream validation');

const cyclicEvidence = { ...evidence };
cyclicEvidence.self = cyclicEvidence;
assert.throws(() => verifyExecutionEvidence({ result, evidence: cyclicEvidence }), /cyclic reference/,
  'cyclic in-memory evidence must fail with a bounded validation error rather than overflowing the JavaScript stack');
let deeplyNestedEvidence = { leaf: true };
for (let depth = 0; depth < 260; depth++) deeplyNestedEvidence = { nested: deeplyNestedEvidence };
assert.throws(() => verifyExecutionEvidence({ result, evidence: { ...evidence, attacker_nested: deeplyNestedEvidence } }), /maximum JSON nesting depth/,
  'deep in-memory evidence must be rejected before recursive canonicalization can overflow the stack');
assert.throws(() => verifyExecutionEvidence({ result, evidence: { ...evidence, attacker_large: 'x'.repeat(MAX_STRICT_JSON_BYTES + 1) } }), /canonical JSON limit/,
  'oversized in-memory evidence must be rejected before the verifier allocates its full canonical representation');
assert.throws(() => verifyExecutionEvidence({ result, evidence: { ...evidence, attacker_escaped: '\u0000'.repeat(Math.floor(MAX_STRICT_JSON_BYTES / 5) + 1) } }), /canonical JSON limit/,
  'JSON-escaped control strings must be size-checked before allocating their expanded serialized representation');
let proxyTrapCalls = 0;
const proxyEvidence = new Proxy({}, {
  getPrototypeOf() { proxyTrapCalls++; throw new Error('proxy trap must not execute'); },
  ownKeys() { proxyTrapCalls++; throw new Error('proxy trap must not execute'); }
});
assert.throws(() => verifyExecutionEvidence({ result, evidence: { ...evidence, attacker_proxy: proxyEvidence } }), /contains a Proxy object/,
  'proxy-backed evidence must be rejected before reflective traps can execute');
assert.equal(proxyTrapCalls, 0, 'proxy traps must never execute during canonicalization');
const sharedEvidenceValue = { marker: 'shared-but-acyclic' };
assert.equal(verifyExecutionEvidence({ result, evidence: { ...evidence, first: sharedEvidenceValue, second: sharedEvidenceValue } }).valid, true,
  'repeated acyclic references should canonicalize as ordinary JSON values instead of being misclassified as cycles');

const rawStdout = Buffer.from('P4_OK\n');
const rawStderr = Buffer.from('');
const rawGitStatus = Buffer.from('');
const executionWithStreamDigests = {
  ...evidence['execution.json'], output_commit: result.output_commit, stdout_bytes: rawStdout.length, stderr_bytes: rawStderr.length,
  git_status_bytes: rawGitStatus.length,
  stdout_sha256: crypto.createHash('sha256').update(rawStdout).digest('hex'),
  stderr_sha256: crypto.createHash('sha256').update(rawStderr).digest('hex'),
  git_status_sha256: crypto.createHash('sha256').update(rawGitStatus).digest('hex')
};
const rawEvidenceBytes = {
  'result.json': Buffer.from(JSON.stringify(result)),
  'task-payload.json': Buffer.from(JSON.stringify(evidence['task-payload.json'])),
  'execution.json': Buffer.from(JSON.stringify(executionWithStreamDigests)),
  'stdout.txt': rawStdout, 'stderr.txt': rawStderr, 'git-status.txt': rawGitStatus
};
const rawVerified = verifyExecutionEvidence({ result, evidence, evidenceBytes: rawEvidenceBytes, requireRawEvidenceBytes: true, trustedInputCommit: result.input_commit });
assert.equal(rawVerified.valid, true, `valid exact stdout/stderr byte metadata should pass: ${rawVerified.errors.join('; ')}`);
// Shared-memory byte views can change while synchronous verification is in
// progress. Force a mutation after stdout's snapshot is taken but before its
// stream digest check; all invariants must use the same snapshot, not reread
// the caller-owned mutable view.
if (typeof SharedArrayBuffer === 'function') {
  const sharedStdout = new Uint8Array(new SharedArrayBuffer(rawStdout.length));
  sharedStdout.set(rawStdout);
  const racingRawEvidence = { ...rawEvidenceBytes, 'stdout.txt': sharedStdout };
  const NativeTextDecoder = globalThis.TextDecoder;
  let decodeCount = 0;
  globalThis.TextDecoder = class extends NativeTextDecoder {
    decode(...args) {
      decodeCount++;
      if (decodeCount === 6) sharedStdout.set(Buffer.from('P4_NO\n'));
      return super.decode(...args);
    }
  };
  try {
    const snapshotVerified = verifyExecutionEvidence({ result, evidence, evidenceBytes: racingRawEvidence, requireRawEvidenceBytes: true, trustedInputCommit: result.input_commit });
    assert.equal(snapshotVerified.valid, true,
      `stream digest and decoded evidence must bind the same immutable snapshot: ${snapshotVerified.errors.join('; ')}`);
  } finally {
    globalThis.TextDecoder = NativeTextDecoder;
  }
}
let rawEvidenceProxyTrapCalls = 0;
const rawEvidenceProxy = new Proxy(rawEvidenceBytes, {
  getPrototypeOf() { rawEvidenceProxyTrapCalls++; throw new Error('raw evidence proxy trap must not execute'); },
  ownKeys() { rawEvidenceProxyTrapCalls++; throw new Error('raw evidence proxy trap must not execute'); }
});
assert.throws(() => verifyExecutionEvidence({ result, evidence, evidenceBytes: rawEvidenceProxy, requireRawEvidenceBytes: true }),
  /raw evidence bytes cannot be a Proxy object/,
  'raw evidence containers must be rejected before reflection can invoke proxy traps');
assert.equal(rawEvidenceProxyTrapCalls, 0, 'raw evidence container proxy traps must never execute');
const rawBufferProxy = new Proxy(Buffer.from('x'), {});
assert.throws(() => verifyExecutionEvidence({ result, evidence, evidenceBytes: { ...rawEvidenceBytes, 'stdout.txt': rawBufferProxy }, requireRawEvidenceBytes: true }),
  /stdout\.txt cannot be a Proxy object/,
  'proxy-wrapped byte buffers must be rejected before byte inspection/copying');
const oversizedRawEvidence = { ...rawEvidenceBytes, 'extra.bin': Buffer.alloc(MAX_RAW_EVIDENCE_BYTES + 1) };
assert.throws(() => verifyExecutionEvidence({ result, evidence, evidenceBytes: oversizedRawEvidence, requireRawEvidenceBytes: true }),
  /aggregate limit/,
  'aggregate raw evidence size must be checked before any per-entry copy or decode');
const tooManyRawEvidenceFiles = { ...rawEvidenceBytes };
for (let index = 0; index < 1020; index++) tooManyRawEvidenceFiles[`extra-${index}.txt`] = Buffer.alloc(0);
assert.throws(() => verifyExecutionEvidence({ result, evidence, evidenceBytes: tooManyRawEvidenceFiles, requireRawEvidenceBytes: true }),
  /file limit/,
  'raw evidence entry count must be bounded before sorting and processing all names');
let rawByteAccessorInvocations = 0;
const accessorRawEvidenceBytes = { ...rawEvidenceBytes };
Object.defineProperty(accessorRawEvidenceBytes, 'stdout.txt', {
  enumerable: true,
  get() { rawByteAccessorInvocations++; return rawEvidenceBytes['stdout.txt']; }
});
assert.throws(() => verifyExecutionEvidence({ result, evidence, evidenceBytes: accessorRawEvidenceBytes, requireRawEvidenceBytes: true }),
  /raw evidence bytes stdout\.txt is not an enumerable data property/,
  'raw evidence byte maps must reject accessors before reading any untrusted entry');
assert.equal(rawByteAccessorInvocations, 0, 'raw evidence accessors must never execute during evidence verification');
const substitutedStdout = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: { ...rawEvidenceBytes, 'stdout.txt': Buffer.from('P4_NO\n') },
  requireRawEvidenceBytes: true
});
assert.equal(substitutedStdout.valid, false, 'same-length stdout substitution must not pass a stale execution.json digest');
assert.match(substitutedStdout.errors.join('; '), /execution stdout_sha256 mismatch/);
const substitutedStderr = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: { ...rawEvidenceBytes, 'stderr.txt': Buffer.from('x') },
  requireRawEvidenceBytes: true
});
assert.equal(substitutedStderr.valid, false, 'stderr substitution must not pass stale byte count/digest metadata');
assert.match(substitutedStderr.errors.join('; '), /execution stderr_bytes mismatch|execution stderr_sha256 mismatch/);
for (const stream of ['stdout', 'stderr']) {
  const { [`${stream}.txt`]: omitted, ...withoutStream } = rawEvidenceBytes;
  const omittedStream = verifyExecutionEvidence({
    result, evidence,
    evidenceBytes: withoutStream,
    requireRawEvidenceBytes: true
  });
  assert.equal(omittedStream.valid, false, `missing raw ${stream}.txt bytes must not bypass the execution.json digest contract`);
  assert.match(omittedStream.errors.join('; '), new RegExp(`execution raw ${stream}\\.txt bytes are required`));
}
const missingStreamDigest = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: { ...rawEvidenceBytes, 'execution.json': Buffer.from(JSON.stringify({ ...executionWithStreamDigests, stdout_sha256: undefined })) },
  requireRawEvidenceBytes: true
});
assert.equal(missingStreamDigest.valid, false, 'provider evidence must include the exact stdout digest');
assert.match(missingStreamDigest.errors.join('; '), /execution stdout_sha256 must be a lower-case SHA-256/);

const rawResult = Buffer.from(JSON.stringify(result));
const duplicateDecodedJobId = Buffer.from(rawResult.toString('utf8').replace(
  '"job_id":"job-p4"', '"job_id":"attacker-job","job\\u005fid":"job-p4"'));
const duplicateDecodedKeys = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: {
    'result.json': duplicateDecodedJobId,
    'task-payload.json': Buffer.from(JSON.stringify(evidence['task-payload.json'])),
    'execution.json': Buffer.from(JSON.stringify(evidence['execution.json'])),
    'stdout.txt': Buffer.from(evidence['stdout.txt']),
    'stderr.txt': Buffer.from(evidence['stderr.txt']),
    'git-status.txt': Buffer.from(evidence['git-status.txt'])
  },
  requireRawEvidenceBytes: true
});
assert.equal(duplicateDecodedKeys.valid, false, 'raw evidence must reject duplicate JSON keys after escape decoding');
assert.match(duplicateDecodedKeys.errors.join('; '), /duplicate decoded object key "job_id"/);

const invalidUtf8Evidence = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: {
    'result.json': rawResult,
    'task-payload.json': Buffer.from([0xc3, 0x28]),
    'execution.json': Buffer.from(JSON.stringify(evidence['execution.json'])),
    'stdout.txt': Buffer.from(evidence['stdout.txt']),
    'stderr.txt': Buffer.from(evidence['stderr.txt']),
    'git-status.txt': Buffer.from(evidence['git-status.txt'])
  },
  requireRawEvidenceBytes: true
});
assert.equal(invalidUtf8Evidence.valid, false, 'raw evidence with invalid UTF-8 must fail closed');
assert.match(invalidUtf8Evidence.errors.join('; '), /cannot be decoded as its declared UTF-8\/JSON content: task-payload\.json/);

const tampered = verifyExecutionEvidence({ result, evidence: { ...evidence, 'execution.json': { ...evidence['execution.json'], exit_code: 7 } } });
assert.equal(tampered.valid, false);
assert.match(tampered.errors.join('; '), /exit_code mismatch/);

const omittedRequiredEvidence = verifyExecutionEvidence({
  result: { ...result, evidence_refs: result.evidence_refs.filter(ref => ref !== 'execution.json') },
  evidence
});
assert.equal(omittedRequiredEvidence.valid, false,
  'an execution result must not omit an evidence member explicitly required by its task payload');
assert.match(omittedRequiredEvidence.errors.join('; '), /required evidence ref is absent from execution result evidence_refs: execution\.json/);

const wrongLease = verifyExecutionEvidence({ result, evidence: { ...evidence, 'task-payload.json': { ...evidence['task-payload.json'], lease_id: 'other' } } });
assert.equal(wrongLease.valid, false);
assert.match(wrongLease.errors.join('; '), /lease_id/);

let accessorInvocations = 0;
const accessorResult = { ...result };
Object.defineProperty(accessorResult, 'job_id', {
  enumerable: true,
  get() { accessorInvocations++; return 'job-p4'; }
});
assert.throws(() => verifyExecutionEvidence({ result: accessorResult, evidence }), /not an enumerable data property/);
assert.equal(accessorInvocations, 0, 'canonical evidence binding must inspect descriptors without invoking getters');

const sparseRefs = [...result.evidence_refs];
delete sparseRefs[1];
assert.throws(() => verifyExecutionEvidence({ result: { ...result, evidence_refs: sparseRefs }, evidence }), /sparse or non-data array entry/,
  'sparse in-memory identity arrays must not canonicalize to valid evidence');

assert.throws(() => verifyExecutionEvidence({
  result,
  evidence: { ...evidence, 'execution.json': { ...evidence['execution.json'], numeric_identity: -0 } }
}), /non-canonical number/, 'negative zero in in-memory evidence must fail closed');

for (const hostileRef of ['C:/outside/result.json', 'c:outside/result.json']) {
  const crossPlatformPath = verifyExecutionEvidence({
    result: { ...result, evidence_refs: [...result.evidence_refs, hostileRef] },
    evidence: { ...evidence, [hostileRef]: { attacker_controlled: true } }
  });
  assert.equal(crossPlatformPath.valid, false,
    `Windows drive-absolute/drive-relative evidence refs must be rejected on every host: ${hostileRef}`);
  assert.match(crossPlatformPath.errors.join('; '), /unsafe evidence ref/);
}

const hostileRawPath = verifyExecutionEvidence({
  result, evidence,
  evidenceBytes: {
    'result.json': rawResult,
    'task-payload.json': Buffer.from(JSON.stringify(evidence['task-payload.json'])),
    'execution.json': Buffer.from(JSON.stringify(evidence['execution.json'])),
    'stdout.txt': Buffer.from(evidence['stdout.txt']),
    'stderr.txt': Buffer.from(evidence['stderr.txt']),
    'git-status.txt': Buffer.from(evidence['git-status.txt']),
    'C:/outside.json': Buffer.from('{"outside":true}')
  },
  requireRawEvidenceBytes: true
});
assert.equal(hostileRawPath.valid, false, 'raw archive evidence with a Windows drive path must fail closed');
assert.match(hostileRawPath.errors.join('; '), /unsafe raw evidence path/);

const accessorEvidence = { ...evidence };
Object.defineProperty(accessorEvidence, 'task-payload.json', {
  enumerable: true,
  get() { accessorInvocations++; return evidence['task-payload.json']; }
});
assert.throws(() => verifyExecutionEvidence({ result, evidence: accessorEvidence }), /not an enumerable data property/);
assert.equal(accessorInvocations, 0, 'evidence accessors must not run during verification');
console.log('execution-verifier P4 PASS');
