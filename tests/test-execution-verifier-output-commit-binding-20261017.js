import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyExecutionEvidence } from '../src/runtime/execution-verifier.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const trustedInputCommit = 'a'.repeat(40); // immutable dispatch fixture, independent of result/evidence objects
const outputCommit = trustedInputCommit;
const result = {
  schema_version: 1,
  job_id: 'job-output-commit', task_id: 'task-output-commit', lease_id: 'lease-output-commit', attempt: 1,
  status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: outputCommit, exit_code: 0,
  provider_run_id: '123', evidence_artifact: 'p3-worker-123',
  evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
  started_at: '2026-10-17T00:00:00.000Z', finished_at: '2026-10-17T00:00:01.000Z', error: null,
};
const payload = {
  schema_version: 1, job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
  attempt: result.attempt, required_evidence: [...result.evidence_refs],
};
const stdout = Buffer.from('verified worker output\n');
const stderr = Buffer.from('');
const gitStatusBytes = Buffer.from('\n');
const execution = {
  task_id: result.task_id, exit_code: 0, timed_out: false, output_commit: outputCommit,
  stdout_bytes: stdout.length, stderr_bytes: stderr.length, git_status_bytes: gitStatusBytes.length,
  stdout_sha256: sha(stdout), stderr_sha256: sha(stderr),
  git_status_sha256: sha(gitStatusBytes),
};
const raw = {
  'result.json': Buffer.from(JSON.stringify(result)),
  'task-payload.json': Buffer.from(JSON.stringify(payload)),
  'execution.json': Buffer.from(JSON.stringify(execution)),
  'stdout.txt': stdout, 'stderr.txt': stderr, 'git-status.txt': gitStatusBytes,
};
const evidence = {
  'task-payload.json': payload, 'execution.json': execution,
  'stdout.txt': stdout.toString(), 'stderr.txt': stderr.toString(), 'git-status.txt': gitStatusBytes.toString(),
};

const valid = verifyExecutionEvidence({ result, evidence, evidenceBytes: raw, requireRawEvidenceBytes: true, trustedInputCommit });
assert.equal(valid.valid, true, `matching worker-observed output commit should pass: ${valid.errors.join('; ')}`);
assert.equal(valid.output_commit_provenance, 'worker_reported_and_execution_json_bound_not_independently_attested');
const missingAnchor = verifyExecutionEvidence({ result, evidence, evidenceBytes: raw, requireRawEvidenceBytes: true });
assert.equal(missingAnchor.valid, false, 'raw successful evidence must not be accepted without an independently supplied trusted input-commit anchor');
assert.match(missingAnchor.errors.join('; '), /trusted input commit anchor is required/);

// git-status.txt is part of the worker evidence contract. Replacing it alone
// currently escapes verification because the verifier validates stdout/stderr
// hashes but does not bind the exact Git-state bytes to execution.json.
const substitutedGitStatus = Buffer.from(' M src/critical-worker.js\n');
const gitStatusSubstitution = verifyExecutionEvidence({
  result,
  evidence: { ...evidence, 'git-status.txt': substitutedGitStatus.toString('utf8') },
  evidenceBytes: { ...raw, 'git-status.txt': substitutedGitStatus },
  requireRawEvidenceBytes: true,
  trustedInputCommit,
});
assert.equal(gitStatusSubstitution.valid, false,
  'mutating git-status.txt without updating execution metadata must be rejected');
assert.match(gitStatusSubstitution.errors.join('; '), /execution git-status_sha256 mismatch/);

// Mutate result.json and the decoded result together so the existing raw
// envelope equality check still passes. The independent execution.json record
// must catch the substituted output commit before it reaches provider ledger.
const substitutedResult = { ...result, output_commit: 'c'.repeat(40) };
const substituted = verifyExecutionEvidence({
  result: substitutedResult,
  evidence,
  evidenceBytes: { ...raw, 'result.json': Buffer.from(JSON.stringify(substitutedResult)) },
  requireRawEvidenceBytes: true,
  trustedInputCommit,
});
assert.equal(substituted.valid, false, 'result output_commit substitution must not pass with unchanged execution evidence');
assert.match(substituted.errors.join('; '), /execution output_commit mismatch/);

const missing = verifyExecutionEvidence({
  result,
  evidence,
  evidenceBytes: { ...raw, 'execution.json': Buffer.from(JSON.stringify({ ...execution, output_commit: undefined })) },
  requireRawEvidenceBytes: true,
  trustedInputCommit,
});
assert.equal(missing.valid, false, 'successful raw provider evidence must contain an independently recorded output commit');
assert.match(missing.errors.join('; '), /execution output_commit must be a Git commit SHA/);

// Post-execution HEAD may legitimately differ from the dispatch input commit
// when an authorized task creates a commit. The verifier should accept coherent
// raw evidence but must not mislabel it as independently attested.
const distinctOutputCommit = 'b'.repeat(40);
const distinctResult = { ...result, output_commit: distinctOutputCommit };
const distinctExecution = { ...execution, output_commit: distinctOutputCommit };
const distinctBytes = {
  ...raw,
  'result.json': Buffer.from(JSON.stringify(distinctResult)),
  'execution.json': Buffer.from(JSON.stringify(distinctExecution)),
};
const distinctEvidence = { ...evidence, 'execution.json': distinctExecution };
const distinctOutput = verifyExecutionEvidence({
  result: distinctResult, evidence: distinctEvidence, evidenceBytes: distinctBytes,
  requireRawEvidenceBytes: true, trustedInputCommit,
});
assert.equal(distinctOutput.valid, true,
  `a valid post-execution commit distinct from the dispatch anchor must not be rejected: ${distinctOutput.errors.join('; ')}`);
assert.equal(distinctOutput.output_commit_provenance, 'worker_reported_and_execution_json_bound_not_independently_attested');

// The result and execution record are both written by the same worker process.
// If both are coherently replaced, no external post-run attestation exists to
// prove the claimed output commit; this is a known provenance limitation, not
// something this verifier is allowed to call independent verification.
const coordinatedOutputCommit = 'd'.repeat(40);
const coordinatedResult = { ...result, output_commit: coordinatedOutputCommit };
const coordinatedExecution = { ...execution, output_commit: coordinatedOutputCommit };
const coordinatedEvidence = { ...evidence, 'execution.json': coordinatedExecution };
const coordinatedRaw = {
  ...raw,
  'result.json': Buffer.from(JSON.stringify(coordinatedResult)),
  'execution.json': Buffer.from(JSON.stringify(coordinatedExecution)),
};
const coordinatedSubstitution = verifyExecutionEvidence({
  result: coordinatedResult,
  evidence: coordinatedEvidence,
  evidenceBytes: coordinatedRaw,
  requireRawEvidenceBytes: true,
  trustedInputCommit,
});
assert.equal(coordinatedSubstitution.valid, true,
  `coordinated worker claim remains internally coherent absent an independent output attestation: ${coordinatedSubstitution.errors.join('; ')}`);
assert.equal(coordinatedSubstitution.output_commit_provenance, 'worker_reported_and_execution_json_bound_not_independently_attested');

const coordinatedIdentitySubstitution = { ...coordinatedResult, input_commit: 'e'.repeat(40) };
const coordinatedIdentity = verifyExecutionEvidence({
  result: coordinatedIdentitySubstitution,
  evidence: coordinatedEvidence,
  evidenceBytes: {
    ...coordinatedRaw,
    'result.json': Buffer.from(JSON.stringify(coordinatedIdentitySubstitution)),
  },
  requireRawEvidenceBytes: true,
  trustedInputCommit,
});
assert.equal(coordinatedIdentity.valid, false, 'substituting result input/output identity must not replace the durable dispatch commit anchor');
assert.match(coordinatedIdentity.errors.join('; '), /result input_commit does not match trusted input commit anchor/);

console.log('EXECUTION RESULT OUTPUT-COMMIT EVIDENCE BINDING / SUBSTITUTION REJECTION PASS');
