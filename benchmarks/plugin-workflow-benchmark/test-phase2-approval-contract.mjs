import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CASE06_ACTIONS,
  canonicalRecordSha256,
  parseStrictJson,
  validateCandidateReviewRecord,
  validateCase06Disposition,
  validateFreshAuthorization,
  readVerifiedRepoFile,
  validateLegacyPhase2AuthorizationRecord,
  writeExclusiveVerifiedRepoFile,
} from './phase2-approval-contract.mjs';

assert.deepEqual(parseStrictJson('{"action":"approve","nested":{"value":1}}'), { action: 'approve', nested: { value: 1 } });
assert.throws(() => parseStrictJson('{"decision":"accept","decision":"accept"}', 'duplicate member fixture'), /duplicate decoded object key "decision"/,
  'strict authority JSON parsing must reject duplicate keys even when both values match');
assert.throws(() => parseStrictJson('{"decision":"accept","\\u0064ecision":"accept"}', 'escaped duplicate member fixture'), /duplicate decoded object key "decision"/,
  'strict authority JSON parsing must compare decoded member names, not their source spellings');
assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), 'invalid UTF-8 fixture'), /not valid UTF-8/,
  'authority JSON must reject invalid UTF-8 rather than replacing bytes silently');

const legacyAuthorizationFixture = {
  authorization_source: 'isolated unit-test fixture', authorized_at: '2026-10-13T12:00:00.000Z',
  authorized_execution_spec_path: 'benchmarks/plugin-workflow-benchmark/test-authorized-spec.json',
  authorized_execution_spec_sha256: 'a'.repeat(64), case_id: 'CASE-01', condition_order: ['plugin', 'control'],
  consumed_run_id: 'fixture-run-001', consumption_record_path: 'benchmarks/plugin-workflow-benchmark/test-consumption.json',
  consumption_status: 'fresh-not-yet-consumed', decision: 'authorized-for-one-paired-CASE-01-v3-pilot-only',
  decision_id: 'fixture-auth-001', frozen_bundle_sha256: 'b'.repeat(64), model_id: 'offline-fixture',
  output_path: 'benchmarks/plugin-workflow-benchmark/test-output.json', permitted_side_effects: ['private test workspace only'],
  protocol: 'cos-phase2-one-case-execution-authorization-v1', result_path: 'test-output.json', result_status: 'not-started',
  scope: { automatic_retry: false, bubblewrap_network_namespace_required: true, external_credentials: false,
    external_network: false, official_manifest_mutation: false, opshub: false, other_cases: false,
    private_database_per_condition: true, private_workspace_per_condition: true, shared_runtime: false,
    systemd_user_scope_required: true },
  source_spec_path: 'benchmarks/plugin-workflow-benchmark/test-source-spec.json', source_spec_sha256: 'c'.repeat(64),
  stop_conditions: ['stop on any evidence mismatch']
};
assert.equal(validateLegacyPhase2AuthorizationRecord(legacyAuthorizationFixture, {
  label: 'legacy fixture', optionalTopKeys: ['consumed_run_id','result_path','result_status'],
  requireBubblewrapNetworkNamespace: true, expectedDecisionId: 'fixture-auth-001'
}), legacyAuthorizationFixture);
assert.throws(() => validateLegacyPhase2AuthorizationRecord({ ...legacyAuthorizationFixture, unreviewed_extension: false }, {
  optionalTopKeys: ['consumed_run_id','result_path','result_status'], requireBubblewrapNetworkNamespace: true, expectedDecisionId: 'fixture-auth-001'
}), /unknown or missing top-level keys/,
  'legacy authorization record readers must reject added top-level keys even when set to false');
assert.throws(() => validateLegacyPhase2AuthorizationRecord({ ...legacyAuthorizationFixture, scope: {
  ...legacyAuthorizationFixture.scope, unreviewed_network_exception: false
} }, { optionalTopKeys: ['consumed_run_id','result_path','result_status'], requireBubblewrapNetworkNamespace: true, expectedDecisionId: 'fixture-auth-001' }),
/scope has unknown or missing keys/,
'legacy authorization record readers must reject unknown nested scope keys');
assert.throws(() => validateLegacyPhase2AuthorizationRecord({ ...legacyAuthorizationFixture, scope: {
  ...legacyAuthorizationFixture.scope, external_network: true
} }, { optionalTopKeys: ['consumed_run_id','result_path','result_status'], requireBubblewrapNetworkNamespace: true, expectedDecisionId: 'fixture-auth-001' }),
/prohibited scope external_network must be explicitly false/,
'legacy authorization scopes must not be extended by silently changing a prohibited boolean');
assert.throws(() => validateLegacyPhase2AuthorizationRecord({ ...legacyAuthorizationFixture, source_spec_sha256: 'A'.repeat(64) }, {
  optionalTopKeys: ['consumed_run_id','result_path','result_status'], requireBubblewrapNetworkNamespace: true, expectedDecisionId: 'fixture-auth-001'
}), /strict lower-case SHA-256/,
'authorization hash syntax must be exact lower-case SHA-256');

const authorityKeys = crypto.generateKeyPairSync('ed25519');
const trustedAuthorityPublicKey = authorityKeys.publicKey.export({ type: 'spki', format: 'pem' });
const signRecord = record => {
  const unsigned = { ...record };
  delete unsigned.authority_attestation;
  return {
    ...unsigned,
    authority_attestation: {
      algorithm: 'Ed25519', key_id: 'unit-test-trust-anchor',
      signature_base64: crypto.sign(null, Buffer.from(JSON.stringify(canonicalize(unsigned))), authorityKeys.privateKey).toString('base64'),
    },
  };
};
function canonicalize(value) {
  return Array.isArray(value) ? value.map(canonicalize) :
    (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value);
}

const identity = { git_head: 'a'.repeat(40), packaged_source_inventory_sha256: 'b'.repeat(64), working_tree_dirty: true };
const candidate = signRecord({
  status: 'approved', candidate_path: 'dist/candidate.mcpb', candidate_sha256: 'c'.repeat(64), source_tree_identity: identity,
  reviewer_id: 'reviewer-123', reviewer_identity_verification_reference: 'sso-audit-event-123',
  reviewer_role: 'independent-technical-reviewer', reviewer_authority_verification_reference: 'reviewer-registry-entry-9', independent_of_implementation: true,
  review_channel_reference: 'review-ticket-42', reviewed_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  findings: [{ finding_id: 'F-01', title: 'Documented non-blocking test gap', severity: 'medium', evidence: 'test gap documented', reproduction: 'Run the named unit test to observe missing branch coverage', recommendation: 'Add deterministic regression', disposition: 'accepted-residual-risk' }],
  residual_risks_accepted: true, residual_risk_rationale: 'bounded to local isolated pilot',
});
const candidateArgs = { record: candidate, candidatePath: candidate.candidate_path, candidateSha256: candidate.candidate_sha256, sourceTreeIdentity: identity, trustedAuthorityPublicKey };
assert.equal(validateCandidateReviewRecord(candidateArgs).valid, true);
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, unreviewed_policy_extension: true }) }).valid, false,
  'unknown signed candidate-review fields must be rejected rather than silently ignored');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, findings: [{ ...candidate.findings[0], unreviewed_extension: true }] }) }).valid, false,
  'unknown nested review-finding fields must be rejected rather than silently ignored');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, authority_attestation: { ...candidate.authority_attestation, unreviewed_extension: true } } }).valid, false,
  'unknown unsigned attestation-envelope fields must be rejected for candidate reviews');
const extendedIdentity = { ...identity, unreviewed_extension: false };
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, source_tree_identity: extendedIdentity }), sourceTreeIdentity: extendedIdentity }).valid, false,
  'unknown nested source-tree identity fields must be rejected even when both sides match');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, sourceTreeIdentity: { working_tree_dirty: true, packaged_source_inventory_sha256: 'b'.repeat(64), git_head: 'a'.repeat(40) } }).valid, true, 'source-tree object key order must not change identity semantics');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewed_at: candidate.reviewed_at.slice(0, 10) }) }).valid, false,
  'date-only signed review timestamps must block instead of relying on locale-dependent Date.parse behavior');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewed_at: '2026-02-30T12:00:00.000Z' }) }).valid, false,
  'impossible calendar values must block rather than normalize to a different signed timestamp');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, expires_at: candidate.expires_at.replace(/Z$/, '+00:00') }) }).valid, false,
  'offset timestamps must block unless the canonical UTC millisecond format is used');
  assert.equal(validateCandidateReviewRecord({ ...candidateArgs, trustedAuthorityPublicKey: '' }).valid, false, 'self-declared reviewer references without configured trust anchor must block');
  assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, authority_role: 'policy-spec-authority' }) }).valid, false,
    'a conflicting secondary authority role must not be ignored when the primary reviewer role matches');
  assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, authority_attestation: { ...candidate.authority_attestation, signature_base64: Buffer.alloc(64, 7).toString('base64') } } }).valid, false, 'forged signature must block');
  assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, authority_attestation: { ...candidate.authority_attestation, signature_base64: `!!${candidate.authority_attestation.signature_base64}` } } }).valid, false, 'non-canonical base64 signature encoding must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewed_at: new Date(Date.now() + 60_000).toISOString() }) }).valid, false, 'future issue timestamp must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() }) }).valid, false, 'otherwise-unexpired stale review must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, expires_at: candidate.reviewed_at }) }).valid, false, 'expiry at or before issue timestamp must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewer_role: 'policy-spec-authority' }) }).valid, false, 'wrong signed authority role must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, reviewer_id: 'spoofed-reviewer' } }).valid, false, 'changing reviewer identity without a valid trusted signature must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }).valid, false, 'changing signed expiry without resigning must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, candidateSha256: 'd'.repeat(64) }).valid, false, 'stale candidate hash must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: signRecord({ ...candidate, reviewed_at: new Date(Date.now() - 7_200_000).toISOString(), expires_at: new Date(Date.now() - 1_000).toISOString() }) }).valid, false, 'expired review must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, sourceTreeIdentity: { ...identity, git_head: 'e'.repeat(40) } }).valid, false, 'stale source identity must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, independent_of_implementation: false } }).valid, false, 'non-independent review must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, reviewer_identity_verification_reference: '' } }).valid, false, 'unverified reviewer identity must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, reviewer_authority_verification_reference: '' } }).valid, false, 'unverified reviewer authority must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, findings: [{ severity: 'blocking', evidence: 'must fix' }] } }).valid, false, 'blocking finding must block');
assert.equal(validateCandidateReviewRecord({ ...candidateArgs, record: { ...candidate, findings: [{ severity: 'medium', evidence: 'thin' }] } }).valid, false, 'finding without reproduction/recommendation/disposition must block');

const case06 = signRecord({
  decision: 'accept', source_spec_path: 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3-draft.json',
  source_spec_sha256: '1'.repeat(64), reviewer_id: 'policy-authority-1',
  reviewer_identity_verification_reference: 'sso-audit-event-456', reviewer_role: 'policy-spec-authority',
  authority_reference: 'governance-role-7', reviewer_authority_verification_reference: 'policy-rbac-snapshot-8',
  review_channel_reference: 'policy-ticket-8', decided_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  rationale: 'reviewed against v1 baseline', reviewed_actions: [...CASE06_ACTIONS],
  action_dispositions: Object.fromEntries(CASE06_ACTIONS.map(action => [action, { decision: 'accept', rationale: `Reviewed ${action}` }])),
  conditions: [], residual_risks: ['Proposal creation may still change local definitions'],
});
const case06Args = { record: case06, expectedSpecPath: case06.source_spec_path, expectedSpecSha256: case06.source_spec_sha256, trustedAuthorityPublicKey };
assert.equal(validateCase06Disposition(case06Args).valid, true);
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, unreviewed_policy_extension: true }) }).valid, false,
  'unknown signed CASE-06 disposition fields must be rejected rather than silently ignored');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, action_dispositions: {
  ...case06.action_dispositions, custom_workflow_approve: { ...case06.action_dispositions.custom_workflow_approve, unreviewed_extension: true },
} }) }).valid, false,
  'unknown nested CASE-06 action-disposition fields must be rejected rather than silently ignored');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, authority_attestation: { ...case06.authority_attestation, unreviewed_extension: true } } }).valid, false,
  'unknown unsigned attestation-envelope fields must be rejected for CASE-06 dispositions');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, decided_at: case06.decided_at.slice(0, 10) }) }).valid, false,
  'CASE-06 decision timestamp must use canonical UTC millisecond precision');
assert.equal(validateCase06Disposition({ ...case06Args, trustedAuthorityPublicKey: undefined }).valid, false, 'CASE-06 reference strings alone do not establish policy authority');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, authority_attestation: { ...case06.authority_attestation, signature_base64: Buffer.alloc(64, 9).toString('base64') } } }).valid, false, 'forged CASE-06 signature must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, decided_at: new Date(Date.now() + 60_000).toISOString() }) }).valid, false, 'future CASE-06 decision timestamp must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, decided_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() }) }).valid, false, 'otherwise-unexpired stale CASE-06 decision must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, expires_at: case06.decided_at }) }).valid, false, 'CASE-06 expiry at issue timestamp must block');
assert.equal(validateCase06Disposition({ ...case06Args, expectedSpecSha256: '2'.repeat(64) }).valid, false, 'stale draft hash must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: signRecord({ ...case06, expires_at: new Date(Date.now() - 1_000).toISOString() }) }).valid, false, 'expired CASE-06 disposition must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, action_dispositions: { ...case06.action_dispositions, custom_workflow_approve: { decision: 'reject', rationale: 'no' } } } }).valid, false, 'missing action-level acceptance must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, reviewer_role: 'implementer' } }).valid, false, 'implementer cannot satisfy policy authority field');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, reviewer_identity_verification_reference: '' } }).valid, false, 'unverified policy reviewer identity must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, reviewer_authority_verification_reference: '' } }).valid, false, 'unverified policy authority must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, action_dispositions: { ...case06.action_dispositions, unrelated_action: { decision: 'accept', rationale: 'extra' } } } }).valid, false, 'extra action disposition must block');
assert.equal(validateCase06Disposition({ ...case06Args, record: { ...case06, conditions: [''] } }).valid, false, 'empty condition must block');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-approval-contract-'));
try {
  fs.mkdirSync(path.join(temp, 'runs'));
  const exclusiveConsumptionRelative = 'runs/exclusive-consumption-fixture.json';
  const exclusiveConsumptionBytes = Buffer.from('{"one_shot":true}\n');
  const exclusiveConsumption = writeExclusiveVerifiedRepoFile(temp, exclusiveConsumptionRelative, exclusiveConsumptionBytes, 'exclusive consumption fixture');
  assert.equal(exclusiveConsumption.bytes.toString('utf8'), exclusiveConsumptionBytes.toString('utf8'));
  assert.equal(fs.statSync(exclusiveConsumption.path).mode & 0o777, 0o600, 'one-shot consumption records are created private by default');
  assert.throws(() => writeExclusiveVerifiedRepoFile(temp, exclusiveConsumptionRelative, Buffer.from('{"one_shot":false}\n'), 'exclusive consumption fixture'),
    /already exists|EEXIST/,
    'exclusive consumption creation must refuse replay rather than overwrite an existing token');
  assert.equal(fs.readFileSync(exclusiveConsumption.path, 'utf8'), exclusiveConsumptionBytes.toString('utf8'));
  const danglingLink = path.join(temp, 'runs', 'dangling-consumption.json');
  fs.symlinkSync(path.join(temp, 'runs', 'missing-target.json'), danglingLink);
  assert.throws(() => writeExclusiveVerifiedRepoFile(temp, 'runs/dangling-consumption.json', Buffer.from('{}\n'), 'dangling consumption fixture'),
    /symlink or non-regular file/,
    'one-shot destination verification must reject dangling symlinks, not treat them as absent');
  fs.unlinkSync(danglingLink);
  const authorizedSpecFixture = Buffer.from('authorized execution spec fixture\n', 'utf8');
  const authorizedSpecFixtureSha256 = crypto.createHash('sha256').update(authorizedSpecFixture).digest('hex');
  const auth = signRecord({
    protocol: 'cos-phase2-one-case-execution-authorization-v1', decision_id: 'fresh-unique-99',
    decision: 'authorized-for-one-paired-CASE-01-v3.8-pilot-only', case_id: 'CASE-01',
    source_spec_sha256: '3'.repeat(64), authorized_execution_spec_sha256: authorizedSpecFixtureSha256, frozen_bundle_sha256: '4'.repeat(64),
    authorized_execution_spec_path: 'authorized-spec.json', source_tree_identity: identity,
    authority_id: 'auth-authority-7', authority_role: 'execution-authorization-authority', authority_identity_verification_reference: 'sso-audit-7',
    authority_reference: 'phase2-authorization-role', decision_channel_reference: 'auth-ticket-99', decided_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    stop_conditions: ['Stop on any hash mismatch', 'Stop on missing task/artifact lineage'],
    limits: { max_attempts: 1, max_duration_seconds: 300, max_memory_mb: 768, max_cpu_percent: 100 },
    consumption_status: 'fresh-not-yet-consumed', output_path: 'runs/new-pilot.json',
    scope: { external_network: false, external_credentials: false, shared_runtime: false, opshub: false, other_cases: false, automatic_retry: false },
  });
  fs.writeFileSync(path.join(temp, auth.authorized_execution_spec_path), authorizedSpecFixture);
  assert.equal(readVerifiedRepoFile(temp, auth.authorized_execution_spec_path, 'test authorized spec').sha256, authorizedSpecFixtureSha256,
    'authority file helper must hash the exact bytes read from the verified descriptor');
  const pathSwapRoot = path.join(temp, 'authority-path-swap');
  fs.mkdirSync(pathSwapRoot);
  const pathSwapTarget = path.join(pathSwapRoot, 'authority.json');
  const pathSwapBackup = path.join(pathSwapRoot, 'authority.original.json');
  fs.writeFileSync(pathSwapTarget, '{"authority":"bytes-read-from-original-inode"}\n', { flag: 'wx' });
  const originalReadFileSync = fs.readFileSync;
  let pathSwapInjected = false;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    const bytes = originalReadFileSync.call(fs, file, ...args);
    if (!pathSwapInjected && typeof file === 'number') {
      pathSwapInjected = true;
      fs.renameSync(pathSwapTarget, pathSwapBackup);
      fs.writeFileSync(pathSwapTarget, '{"authority":"replacement-inode"}\n', { flag: 'wx' });
    }
    return bytes;
  };
  try {
    assert.throws(() => readVerifiedRepoFile(pathSwapRoot, 'authority.json', 'path-replacement fixture'), /changed while its verified bytes were being read/,
      'authority byte verification must reject a canonical pathname whose inode is replaced while the descriptor is being read');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(pathSwapInjected, true, 'deterministic path replacement injection must actually execute');
  assert.equal(fs.readFileSync(pathSwapTarget, 'utf8'), '{"authority":"replacement-inode"}\n');
  const spec = { status: 'authorized-for-one-scenario', execution_gate: { status: 'open', authorized_case_ids: ['CASE-01'], authorization_record: {
    decision_id: auth.decision_id, source_spec_sha256: auth.source_spec_sha256,
    authorized_execution_spec_sha256: auth.authorized_execution_spec_sha256, frozen_bundle_sha256: auth.frozen_bundle_sha256,
    authorization_record_sha256: canonicalRecordSha256(auth),
  } } };
  const authArgs = { spec, record: auth, consumption: null, repoRoot: temp, currentSpecSha256: auth.source_spec_sha256,
    currentAuthorizedSpecSha256: auth.authorized_execution_spec_sha256, frozenSha256: auth.frozen_bundle_sha256,
    expectedSourceTreeIdentity: identity, priorDecisionIds: [], trustedAuthorityPublicKey };
  assert.equal(validateFreshAuthorization(authArgs).valid, true);
  const quotedDecision = `"decision":${JSON.stringify(auth.decision)}`;
  const duplicateSignedAuthorizationJson = JSON.stringify(auth).replace(quotedDecision,
    `${quotedDecision},"decision":${JSON.stringify(auth.decision)}`);
  assert.notEqual(duplicateSignedAuthorizationJson, JSON.stringify(auth));
  assert.deepEqual(JSON.parse(duplicateSignedAuthorizationJson), auth,
    'legacy JSON.parse demonstrates how duplicate keys disappear while the signed semantic object stays unchanged');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: JSON.parse(duplicateSignedAuthorizationJson) }).valid, true,
    'object-only validation cannot recover duplicate raw syntax; file consumers must use parseStrictJson before validation');
  assert.throws(() => parseStrictJson(duplicateSignedAuthorizationJson, 'signed authorization duplicate-key fixture'), /duplicate decoded object key "decision"/,
    'strict file decoding must reject duplicate-key authority bytes before semantic signature verification');
  const authorizedSpecPath = path.join(temp, auth.authorized_execution_spec_path);
  const authorizedSpecOriginalBytes = fs.readFileSync(authorizedSpecPath);
  try {
    fs.writeFileSync(authorizedSpecPath, 'substituted authorized execution spec\n');
    assert.equal(validateFreshAuthorization(authArgs).valid, false,
      'authorization must hash the actual opened spec bytes rather than trust a caller-supplied matching digest');
  } finally { fs.writeFileSync(authorizedSpecPath, authorizedSpecOriginalBytes); }
  assert.equal(validateFreshAuthorization(authArgs).valid, true, 'restoring exact authorized spec bytes must restore validation');
  const outsideAuthorizedSpec = path.join(temp, 'outside-authorized-spec.json');
  const outsideAuthorizedBytes = Buffer.from('outside spec must never be accepted\n', 'utf8');
  fs.writeFileSync(outsideAuthorizedSpec, outsideAuthorizedBytes);
  const outsideAuthorizedHash = crypto.createHash('sha256').update(outsideAuthorizedBytes).digest('hex');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, authorized_execution_spec_path: '../outside-authorized-spec.json', authorized_execution_spec_sha256: outsideAuthorizedHash }), currentAuthorizedSpecSha256: outsideAuthorizedHash }).valid, false,
    'authorized execution spec traversal must fail closed even when its hash matches the target bytes');
  const symlinkAuthorizedSpec = path.join(temp, 'authorized-spec-symlink.json');
  fs.symlinkSync(outsideAuthorizedSpec, symlinkAuthorizedSpec, 'file');
  const symlinkRecord = signRecord({ ...auth, authorized_execution_spec_path: 'authorized-spec-symlink.json', authorized_execution_spec_sha256: outsideAuthorizedHash });
  const symlinkSpec = { ...spec, execution_gate: { ...spec.execution_gate, authorization_record: {
    ...spec.execution_gate.authorization_record, authorization_record_sha256: canonicalRecordSha256(symlinkRecord),
  } } };
  assert.equal(validateFreshAuthorization({ ...authArgs, record: symlinkRecord, spec: symlinkSpec, currentAuthorizedSpecSha256: outsideAuthorizedHash }).valid, false,
    'authorized execution spec symlink must fail closed even when the target bytes hash correctly');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, decided_at: auth.decided_at.replace(/Z$/, '+00:00') }) }).valid, false,
    'signed authorization timestamps must use canonical UTC millisecond precision');
  assert.equal(validateFreshAuthorization({ ...authArgs, spec: { ...spec, execution_gate: { ...spec.execution_gate, authorization_record: { ...spec.execution_gate.authorization_record, authorization_record_sha256: '0'.repeat(64) } } } }).valid, false, 'gate must bind the exact signed authorization record, not only selected fields');
  assert.equal(validateFreshAuthorization({ ...authArgs, priorDecisionIds: [auth.decision_id] }).valid, false, 'reused authorization ID must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, trustedAuthorityPublicKey: '' }).valid, false, 'authorization must fail closed without a trust anchor');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, authority_attestation: { ...auth.authority_attestation, signature_base64: Buffer.alloc(64, 3).toString('base64') } } }).valid, false, 'forged authorization signature must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, authority_role: 'policy-spec-authority' }) }).valid, false, 'wrong authorization authority role must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, reviewer_role: 'independent-technical-reviewer' }) }).valid, false,
    'conflicting secondary reviewer role must block even when authority_role is correct');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, decided_at: new Date(Date.now() + 60_000).toISOString() }) }).valid, false, 'future authorization issue timestamp must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, decided_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString() }) }).valid, false, 'otherwise-unexpired stale authorization must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, expires_at: auth.decided_at }) }).valid, false, 'authorization expiry at issue timestamp must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, scope: { ...auth.scope, other_cases: true } }) }).valid, false, 'expanded authorization scope must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, scope: { ...auth.scope, unreviewed_capability: false } }) }).valid, false,
    'unknown signed scope keys must block rather than silently extend the authorization contract');
  const bindRecord = record => ({ ...authArgs, record, spec: { ...spec, execution_gate: { ...spec.execution_gate, authorization_record: { ...spec.execution_gate.authorization_record, authorization_record_sha256: canonicalRecordSha256(record) } } } });
  assert.equal(validateFreshAuthorization(bindRecord(signRecord({ ...auth, unreviewed_capability: false }))).valid, false,
    'unknown top-level authorization keys must be rejected even when signed and gate-bound');
  assert.equal(validateFreshAuthorization(bindRecord({ ...auth, authority_attestation: { ...auth.authority_attestation, unreviewed_claim: true } })).valid, false,
    'unknown unsigned authority-attestation envelope keys must be rejected even when the record hash is rebound');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, source_tree_identity: extendedIdentity }), expectedSourceTreeIdentity: extendedIdentity }).valid, false,
    'unknown nested source-tree identity fields must be rejected for authorization even when both sides match');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, expires_at: new Date(Date.now() - 1_000).toISOString() }) }).valid, false, 'expired one-shot authorization must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, consumption: { status: 'consumed' } }).valid, false, 'consumed one-shot must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, source_spec_sha256: '5'.repeat(64) } }).valid, false, 'stale spec hash must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }).valid, false, 'changing signed authorization expiry without resigning must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, frozen_bundle_sha256: '6'.repeat(64) } }).valid, false, 'wrong frozen hash must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, currentAuthorizedSpecSha256: '7'.repeat(64) }).valid, false, 'stale authorized execution spec hash must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, stop_conditions: [] } }).valid, false, 'missing stop conditions must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, authority_identity_verification_reference: '' } }).valid, false, 'unverified authorization authority must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, output_path: '../escape.json' } }).valid, false, 'path traversal must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, output_path: 'runs//nested.json' } }).valid, false, 'empty path segments must block');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, output_path: 'runs\\backslash-escape.json' }) }).valid, false, 'backslash path separators must block on POSIX');
  assert.equal(validateFreshAuthorization({ ...authArgs, record: signRecord({ ...auth, output_path: 'nested/runs/escape.json' }) }).valid, false, 'output path must be rooted directly under runs/');
  const repoRootAlias = path.join(temp, 'repo-root-alias');
  fs.symlinkSync(temp, repoRootAlias, 'dir');
  assert.equal(validateFreshAuthorization({ ...authArgs, repoRoot: repoRootAlias }).valid, false, 'symlinked repository root must block even if output parent itself appears non-symlink');
  fs.mkdirSync(path.join(temp, 'outside'));
  fs.renameSync(path.join(temp, 'runs'), path.join(temp, 'runs-real'));
  fs.symlinkSync(path.join(temp, 'outside'), path.join(temp, 'runs'));
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, output_path: 'runs/symlink-escape.json' } }).valid, false, 'symlinked output parent must block');
  fs.unlinkSync(path.join(temp, 'runs'));
  fs.renameSync(path.join(temp, 'runs-real'), path.join(temp, 'runs'));
  fs.writeFileSync(path.join(temp, 'runs/new-pilot.json'), '{}');
  assert.equal(validateFreshAuthorization(authArgs).valid, false, 'pre-existing output must block');
  fs.unlinkSync(path.join(temp, 'runs/new-pilot.json'));
  fs.symlinkSync(path.join(temp, 'does-not-exist.json'), path.join(temp, 'runs/dangling-output.json'));
  assert.equal(validateFreshAuthorization({ ...authArgs, record: { ...auth, output_path: 'runs/dangling-output.json' } }).valid, false, 'pre-existing dangling symlink output must block');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('PASS: approval contract rejects stale hashes, wrong reviewer roles, incomplete CASE-06 actions, reused/consumed one-shots, unsafe paths and pre-existing outputs');
